// SPDX-License-Identifier: AGPL-3.0-only
// Models started on the runtime (record 24), against a fake llama.cpp server
// in router mode: a finished GGUF download started, its preset written, loaded,
// held on llama-cpp and answering through Kvasir; a load that fails, with its
// exit and its log; one model at a time; the runtime and Kvasir starting again;
// the doors' refusals; a started model not removed; no runtime, no change; the
// runtime in kvasir.json; the loopback name of a Kvasir in a container; a
// started model that admission refuses, shown and no purpose's default; the
// context a model opens with, and on the processor the memory its load needs; a
// load the runtime did not survive, never asked for again; and the command
// line's --context.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { throughHost } from "../src/held.js";
import type { LocalRow } from "../src/local.js";
import { presetsText, STOPPED_WHILE_LOADING } from "../src/runtime.js";
import { build, type Kvasir, listen, ready } from "../src/server.js";
import { chunk, serve, sse } from "./fake.js";
import { ggufBytes, qwenLike } from "./gguf-file.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  // each Kvasir closes before the runtime it looks at
  for (const c of closers.reverse()) await c();
});

const KEY = "the-runtime-key";
const TOKENS = { "an-admin-token": "anna@lab:kvasir:work", "a-reader-token": "bo@lab:kvasir:see" };
const admin = { authorization: "Bearer an-admin-token", "content-type": "application/json" };
const reader = { authorization: "Bearer a-reader-token", "content-type": "application/json" };

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface FakeModel {
  model: string;
  state: "unloaded" | "loading" | "loaded";
  failed: boolean;
  exit: number | null;
  port: number;
}

/**
 * A fake llama.cpp server in router mode, as build b10964 answers: the presets
 * read again when asked, one model loaded at a time after a moment, a model
 * whose file is not there or is named broken failed with its reason in the log
 * under its port, a chat answered only by a loaded model, and the key wanted
 * everywhere but /health. `restart` unloads every model, as a runtime started
 * again does; `answering(false)` has it answer nothing but errors.
 */
async function router(dir: string, opts: { loadMs?: number } = {}) {
  const presets = join(dir, "runtime", "models.ini");
  const log = join(dir, "runtime", "runtime.log");
  const models = new Map<string, FakeModel>();
  const asked: string[] = [];
  let port = 40_000;
  let answering = true;
  const reload = () => {
    let text = "";
    try {
      text = readFileSync(presets, "utf8");
    } catch {
      // no presets yet
    }
    const named = new Map<string, string>();
    let section = "";
    for (const line of text.split("\n")) {
      const head = /^\[(.+)\]$/u.exec(line.trim());
      if (head) section = head[1];
      const pair = /^model = (.+)$/u.exec(line.trim());
      if (pair && section !== "*") named.set(section, pair[1]);
    }
    for (const [id, m] of [...models]) if (!named.has(id) && m.state === "unloaded") models.delete(id);
    for (const [id, model] of named) {
      const m = models.get(id);
      if (m) m.model = model;
      else models.set(id, { model, state: "unloaded", failed: false, exit: null, port: 0 });
    }
  };
  const rt = await serve((req, res, text) => {
    const url = new URL(req.url ?? "/", "http://router");
    if (url.pathname === "/health") {
      answer(res, 200, { status: "ok" });
      return;
    }
    if (!answering) {
      answer(res, 503, { error: { message: "the router is starting" } });
      return;
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      answer(res, 401, { error: { code: 401, message: "Invalid API Key", type: "authentication_error" } });
      return;
    }
    const named = String((JSON.parse(text || "{}") as { model?: unknown }).model ?? "");
    const busy = (message: string) =>
      answer(res, 400, { error: { code: 400, message, type: "invalid_request_error" } });
    if (req.method === "GET" && url.pathname === "/models") {
      if (url.searchParams.get("reload") === "1") {
        asked.push("reload");
        reload();
      }
      answer(res, 200, {
        data: [...models].map(([id, m]) => ({
          id,
          object: "model",
          owned_by: "llamacpp",
          status: {
            value: m.state,
            args: [
              "llama-server",
              "--api-key-file",
              "runtime.key",
              "--port",
              String(m.port),
              "--model",
              m.model,
            ],
            ...(m.failed ? { exit_code: m.exit, failed: true } : {}),
          },
        })),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/models/load") {
      const m = models.get(named);
      if (!m) {
        answer(res, 404, { error: { code: 404, message: "File Not Found", type: "not_found_error" } });
        return;
      }
      if (m.state !== "unloaded") {
        busy("model is already running");
        return;
      }
      asked.push(`load ${named}`);
      // --models-max 1: loading one unloads the others
      for (const other of models.values()) if (other !== m) other.state = "unloaded";
      port += 1;
      Object.assign(m, { state: "loading", failed: false, exit: null, port });
      setTimeout(() => {
        if (m.state !== "loading") return;
        if (!existsSync(m.model) || /broken/u.test(m.model)) {
          Object.assign(m, { state: "unloaded", failed: true, exit: 1 });
          appendFileSync(
            log,
            `[${m.port}] 0.00.122.588 E gguf_init_from_file: failed to open GGUF file '${m.model}'\n[${m.port}] 0.00.123.564 E srv  llama_server: exiting due to model loading error\n0.55.030.538 I srv           run: instance name=${named} exited with status 1\n`,
          );
        } else m.state = "loaded";
      }, opts.loadMs ?? 30);
      answer(res, 200, { success: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/models/unload") {
      const m = models.get(named);
      if (!m || m.state === "unloaded") {
        busy("model is not running");
        return;
      }
      asked.push(`unload ${named}`);
      m.state = "unloaded";
      answer(res, 200, { success: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/props") {
      const m = models.get(url.searchParams.get("model") ?? "");
      if (m?.state !== "loaded") {
        busy("model is not loaded");
        return;
      }
      answer(res, 200, {
        default_generation_settings: { n_ctx: 16_384 },
        total_slots: 4,
        chat_template: "{% for m in messages %}{{ m.content }}{% endfor %}",
        model_path: m.model,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (models.get(named)?.state !== "loaded") {
        busy("model is not loaded");
        return;
      }
      asked.push(`chat ${named}`);
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "ready" }),
        chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
        "[DONE]",
      ]);
      return;
    }
    answer(res, 404, { error: { message: `no ${req.method} ${url.pathname}` } });
  });
  closers.push(() => rt.server.close());
  return {
    url: rt.url,
    asked,
    models,
    presets,
    /** The runtime started again: every model unloaded, and its presets read afresh. */
    restart: () => {
      for (const m of models.values()) Object.assign(m, { state: "unloaded", failed: false, exit: null });
      reload();
    },
    answering: (yes: boolean) => {
      answering = yes;
    },
  };
}

const ROOMY = () => ({ bavail: 2 ** 40, bsize: 1 });

/** The kvasir.json of a Kvasir on `dir`, naming the runtime at `runtimeUrl` or none, with the runtime's key written beside it. */
function kvasirJson(
  dir: string,
  runtimeUrl: string | null,
  opts: { gate?: boolean; hostAlias?: string; purposes?: unknown[]; variant?: string } = {},
): Record<string, unknown> {
  mkdirSync(join(dir, "runtime"), { recursive: true });
  const keyFile = join(dir, "runtime", "runtime.key");
  if (!existsSync(keyFile))
    writeFileSync(keyFile, `# the key the runtime and Kvasir read\n${KEY}\n`, { mode: 0o600 });
  const runtime = runtimeUrl
    ? {
        url: runtimeUrl,
        keyFile,
        presets: join(dir, "runtime", "models.ini"),
        log: join(dir, "runtime", "runtime.log"),
        build: "b10964",
        variant: opts.variant ?? "ubuntu-vulkan-x64",
      }
    : undefined;
  return {
    bind: "127.0.0.1:0",
    origin: "http://kvasir.test",
    auth: { mode: "token", tokens: TOKENS },
    store: join(dir, "kvasir.sqlite"),
    pepperFile: join(dir, "kvasir.pepper"),
    sealKeyFile: join(dir, "kvasir.seal"),
    admission: { queue: 8, waitCapSeconds: 60, gate: opts.gate ?? false },
    purposes: opts.purposes ?? [],
    local: runtime ? { runtime } : {},
    ...(opts.hostAlias ? { hostAlias: opts.hostAlias } : {}),
  };
}

/** A Kvasir on `dir` serving, with the runtime at `runtimeUrl` in its kvasir.json, or none. */
async function kvasir(
  dir: string,
  runtimeUrl: string | null,
  opts: {
    gate?: boolean;
    hostAlias?: string;
    ready?: boolean;
    purposes?: unknown[];
    /** The runtime's build: a card's unless a test puts it on the processor. */
    variant?: string;
    freeMemory?: () => number;
  } = {},
) {
  const json = kvasirJson(dir, runtimeUrl, opts);
  const k: Kvasir = build(parse(JSON.stringify(json)), {
    local: { statfs: ROOMY, pollMs: 50 },
    runtime: {
      pollMs: 40,
      askAgainMs: 400,
      settleMs: 0,
      loadGraceMs: 150,
      ...(opts.freeMemory ? { freeMemory: opts.freeMemory } : {}),
    },
  });
  if (opts.ready) k.held.onAdded = (b) => void ready(k, b, () => {});
  const url = await listen(k, "127.0.0.1:0");
  k.runner?.follow();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await k.close();
  };
  closers.push(close);
  return { k, url, close };
}

/** A model downloaded as Kvasir lays one out: its files written, zeros of a size or the bytes given, null for one listed but not there, its row done. */
function downloaded(k: Kvasir, name: string, files: Record<string, number | Buffer | null>): number {
  const commit = createHash("sha1").update(name).digest("hex");
  const path = join(k.local.location(), `acme--${name}`, commit);
  const list = Object.entries(files).map(([file, content]) => {
    const bytes = typeof content === "number" ? Buffer.alloc(content) : content;
    if (bytes !== null) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), bytes);
    }
    return { path: file, size: bytes?.length ?? 1, sha256: null };
  });
  const total = list.reduce((sum, f) => sum + f.size, 0);
  return (
    k.store.db
      .prepare(
        `INSERT INTO local_model (repo, revision, commit_sha, include, path, files, state, bytes_total, bytes_done, added_by, added_at, finished_at)
         VALUES (?, 'main', ?, '[]', ?, ?, 'done', ?, ?, 'test', ?, ?) RETURNING id`,
      )
      .get(`acme/${name}`, commit, path, JSON.stringify(list), total, total, Date.now(), Date.now()) as {
      id: number;
    }
  ).id;
}

async function call(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = admin,
  // biome-ignore lint/suspicious/noExplicitAny: a door's answer, read as the test reads it
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`waited too long for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const runOf = (k: Kvasir, id: number) => k.local.get(id)?.run;
const temporary = () => mkdtempSync(join(tmpdir(), "kvasir-runtime-"));

describe("a model started on the runtime", () => {
  it("is loaded from its preset, held on llama-cpp, and answers through Kvasir", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url);
    const id = downloaded(k, "tiny", { "tiny-Q4_K_M.gguf": 1_000, "mmproj-tiny.gguf": 100, "README.md": 10 });
    await until(() => k.local.status().runtime?.reachable === true, "the first look at the runtime");
    const before = await call(url, "GET", "/v1/local");
    expect(before.body.runtime).toEqual({
      build: "b10964",
      variant: "ubuntu-vulkan-x64",
      reachable: true,
      serving: null,
    });
    // where a runtime starts it, a GGUF download lists no command to start one by hand
    expect(before.body.models[0]).toMatchObject({ id, state: "done", startable: true, run: null, serve: [] });

    const started = await call(url, "POST", `/v1/local/models/${id}/start`);
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({
      state: "starting",
      model: "tiny-q4-k-m",
      error: null,
      log: [],
      started_by: "anna@lab",
    });
    await until(() => runOf(k, id)?.state === "serving", "the model serving");
    const row = k.local.get(id) as LocalRow;
    expect(row.run).toMatchObject({
      state: "serving",
      model: "tiny-q4-k-m",
      context: 16_384,
      slots: 4,
      error: null,
    });
    // a file whose header says nothing opens with the most context a start gives
    expect(readFileSync(rt.presets, "utf8")).toBe(
      presetsText([
        {
          id: "tiny-q4-k-m",
          model: join(row.path, "tiny-Q4_K_M.gguf"),
          mmproj: join(row.path, "mmproj-tiny.gguf"),
          context: 32_768,
        },
      ]),
    );
    expect(readFileSync(rt.presets, "utf8")).toMatch(/^\[\*\]\ncache-type-k = q8_0\ncache-type-v = q8_0\n/u);
    await until(() => k.backends.get("llama-cpp") !== undefined, "the backend held");
    const held = k.backends.get("llama-cpp");
    expect(held?.config).toMatchObject({
      kind: "openai-completions",
      locality: "local",
      baseUrl: `${rt.url}/v1`,
      concurrency: 4,
      runtime: { name: "llama.cpp", version: "b10964", build: "ubuntu-vulkan-x64" },
    });
    expect(held?.config.models.map((m) => [m.id, m.contextWindow, m.input])).toEqual([
      ["tiny-q4-k-m", 16_384, ["text", "image"]],
    ]);
    expect((await call(url, "GET", "/v1/local")).body.runtime.serving).toBe(id);
    // the backend streams with the key the runtime reads, sealed in the database and never written plain
    const whole = await call(url, "POST", "/v1/chat/completions", {
      model: "tiny-q4-k-m",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(whole.status).toBe(200);
    expect(whole.body.choices[0].message.content).toBe("ready");
    expect(rt.asked).toContain("chat tiny-q4-k-m");
    expect(rt.asked.filter((a) => a.startsWith("load"))).toEqual(["load tiny-q4-k-m"]);
    expect(readFileSync(join(dir, "kvasir.sqlite")).includes(Buffer.from(KEY))).toBe(false);
  });

  it("that does not load keeps the exit and the runtime's lines for it, and nothing is held", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url);
    const id = downloaded(k, "broken", { "broken-Q4_K_M.gguf": 500 });
    expect((await call(url, "POST", `/v1/local/models/${id}/start`)).status).toBe(202);
    await until(() => runOf(k, id)?.state === "failed", "the failure");
    const run = runOf(k, id);
    expect(run?.error).toBe(
      "the runtime could not load broken-Q4_K_M.gguf: its process exited with status 1",
    );
    expect(run?.log.some((line) => line.includes("failed to open GGUF file"))).toBe(true);
    expect(run?.log.every((line) => line.startsWith("[4"))).toBe(true);
    expect(k.backends.get("llama-cpp")).toBeUndefined();
    // a failed model is not started again on its own, starts again when asked, and is removed at once
    await new Promise((r) => setTimeout(r, 500));
    expect(rt.asked.filter((a) => a.startsWith("load"))).toHaveLength(1);
    expect(k.local.get(id)?.startable).toBe(true);
    expect((await call(url, "DELETE", `/v1/local/models/${id}`)).status).toBe(204);
  });

  it("runs one at a time: starting another stops the one running, and a stop lets it go", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url);
    const a = downloaded(k, "alpha", { "alpha-Q4_K_M.gguf": 100 });
    const b = downloaded(k, "beta", { "beta-Q8_0.gguf": 100 });
    await call(url, "POST", `/v1/local/models/${a}/start`);
    await until(() => runOf(k, a)?.state === "serving", "alpha serving");
    const second = await call(url, "POST", `/v1/local/models/${b}/start`);
    expect(second.status).toBe(202);
    expect(runOf(k, a)?.state).toBe("stopped");
    await until(() => runOf(k, b)?.state === "serving", "beta serving");
    await until(() => k.backends.get("llama-cpp")?.config.models[0]?.id === "beta-q8-0", "beta held");
    expect(k.backends.get("llama-cpp")?.config.models.map((m) => m.id)).toEqual(["beta-q8-0"]);
    expect(rt.models.get("alpha-q4-k-m")?.state ?? "unloaded").toBe("unloaded");
    expect(readFileSync(rt.presets, "utf8")).not.toContain("alpha");

    const stopped = await call(url, "POST", `/v1/local/models/${b}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.run.state).toBe("stopped");
    await until(() => k.backends.get("llama-cpp") === undefined, "the backend let go");
    expect(rt.models.get("beta-q8-0")?.state ?? "unloaded").toBe("unloaded");
    expect(rt.asked).toContain("unload beta-q8-0");
    expect((await call(url, "GET", "/v1/local")).body.runtime.serving).toBeNull();
  });

  it("waits while the runtime does not answer, and is loaded again once the runtime started again", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url);
    const a = downloaded(k, "alpha", { "alpha-Q4_K_M.gguf": 100 });
    await call(url, "POST", `/v1/local/models/${a}/start`);
    await until(() => runOf(k, a)?.state === "serving", "alpha serving");
    rt.answering(false);
    await until(() => runOf(k, a)?.state === "starting", "the run waiting");
    expect(runOf(k, a)?.error).toContain("does not answer");
    expect(k.local.status().runtime?.reachable).toBe(false);
    rt.restart();
    rt.answering(true);
    await until(() => runOf(k, a)?.state === "serving", "alpha loaded again");
    await until(() => k.backends.get("llama-cpp") !== undefined, "alpha held again");
    expect(rt.asked.filter((x) => x === "load alpha-q4-k-m")).toHaveLength(2);
    expect(runOf(k, a)?.error).toBeNull();
  });

  it("is loaded again when Kvasir starts again on the same database", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const first = await kvasir(dir, rt.url);
    const a = downloaded(first.k, "alpha", { "alpha-Q4_K_M.gguf": 100 });
    await call(first.url, "POST", `/v1/local/models/${a}/start`);
    await until(() => runOf(first.k, a)?.state === "serving", "alpha serving");
    await first.close();
    rt.restart();
    const second = await kvasir(dir, rt.url);
    await until(
      () =>
        rt.models.get("alpha-q4-k-m")?.state === "loaded" &&
        runOf(second.k, a)?.state === "serving" &&
        second.k.backends.get("llama-cpp") !== undefined,
      "alpha started again",
    );
    expect(runOf(second.k, a)?.started_by).toBe("anna@lab");
  });

  it("is refused where it cannot start, needs kvasir:work, and is not removed while started", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url);
    const gguf = downloaded(k, "tiny", { "tiny-Q4_K_M.gguf": 100 });
    const weights = downloaded(k, "weights", { "config.json": 10, "model.safetensors": 100 });
    const missing = downloaded(k, "gone", { "gone-Q4_K_M.gguf": null });
    const queued = downloaded(k, "later", { "later-Q4_K_M.gguf": 100 });
    k.store.db.prepare("UPDATE local_model SET state = 'queued' WHERE id = ?").run(queued);
    const start = async (id: number, body?: unknown) => {
      const r = await call(url, "POST", `/v1/local/models/${id}/start`, body);
      return [r.status, r.body.error?.code];
    };
    expect(await start(queued)).toEqual([409, "not_downloaded"]);
    expect(await start(missing)).toEqual([409, "not_downloaded"]);
    expect(await start(weights)).toEqual([409, "not_gguf"]);
    expect(await start(gguf, { file: "model.safetensors" })).toEqual([409, "not_gguf"]);
    expect(await start(9_999)).toEqual([404, "no_such_model"]);
    // a download a runtime cannot start keeps the commands a model server starts it with
    expect(k.local.get(weights)).toMatchObject({ startable: false, run: null });
    expect(k.local.get(weights)?.serve.map((s) => s.runtime)).toEqual(["sglang", "vllm"]);
    rt.answering(false);
    expect(await start(gguf)).toEqual([409, "runtime_unreachable"]);
    rt.answering(true);
    for (const path of [`/v1/local/models/${gguf}/start`, `/v1/local/models/${gguf}/stop`]) {
      const r = await call(url, "POST", path, undefined, reader);
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe("no_grant");
    }

    expect((await call(url, "POST", `/v1/local/models/${gguf}/start`)).status).toBe(202);
    const refused = await call(url, "DELETE", `/v1/local/models/${gguf}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("stop it before removing it");
    expect(existsSync((k.local.get(gguf) as LocalRow).path)).toBe(true);
    // a stop of a model never started leaves it as it is
    const never = await call(url, "POST", `/v1/local/models/${weights}/stop`);
    expect([never.status, never.body.run]).toEqual([200, null]);
    expect((await call(url, "POST", `/v1/local/models/${gguf}/stop`)).body.run.state).toBe("stopped");
    expect((await call(url, "DELETE", `/v1/local/models/${gguf}`)).status).toBe(204);
    expect(k.store.db.prepare("SELECT COUNT(*) AS n FROM local_run").get()).toEqual({ n: 0 });
  });

  it("changes nothing where kvasir.json names no runtime", async () => {
    const dir = temporary();
    const { k, url } = await kvasir(dir, null);
    const id = downloaded(k, "tiny", { "tiny-Q4_K_M.gguf": 100 });
    const listed = await call(url, "GET", "/v1/local");
    expect(listed.body.runtime).toBeNull();
    expect(listed.body.models[0]).toMatchObject({ startable: false, run: null });
    expect(listed.body.models[0].serve.map((s: { runtime: string }) => s.runtime)).toEqual([
      "llama.cpp",
      "ollama",
    ]);
    const refused = await call(url, "POST", `/v1/local/models/${id}/start`);
    expect([refused.status, refused.body.error.code]).toEqual([409, "no_runtime"]);
    expect((await call(url, "POST", `/v1/local/models/${id}/stop`)).body.error.code).toBe("no_runtime");
    expect(k.runner).toBeNull();
    expect(k.store.columns("local_run")).toEqual([]);
    expect(existsSync(join(dir, "runtime", "models.ini"))).toBe(false);
    expect((await call(url, "DELETE", `/v1/local/models/${id}`)).status).toBe(204);
  });
});

describe("the runtime in kvasir.json", () => {
  it("is read whole or refused in words, and there is none unless it is named", () => {
    const base = { bind: "127.0.0.1:0", origin: "http://kvasir.test" };
    const bare = parse(JSON.stringify(base));
    expect(bare.local.runtime).toBeNull();
    expect(bare.hostAlias).toBeNull();
    const runtime = {
      url: "http://127.0.0.1:7110/",
      keyFile: "/home/person/nils/kvasir/runtime/runtime.key",
      presets: "/home/person/nils/kvasir/runtime/models.ini",
      log: "/home/person/nils/kvasir/runtime/runtime.log",
      build: "b10964",
      variant: "ubuntu-vulkan-x64",
    };
    const named = parse(
      JSON.stringify({ ...base, local: { runtime }, hostAlias: "host.containers.internal" }),
    );
    expect(named.local).toEqual({
      endpoint: "https://huggingface.co",
      runtime: { ...runtime, url: "http://127.0.0.1:7110" },
    });
    expect(named.hostAlias).toBe("host.containers.internal");
    const refused = (over: Record<string, unknown>) => () =>
      parse(JSON.stringify({ ...base, local: { runtime: { ...runtime, ...over } } }));
    expect(refused({ url: "127.0.0.1:7110" })).toThrow(/local\.runtime\.url/);
    expect(refused({ url: "http://127.0.0.1:7110/v1" })).toThrow(/local\.runtime\.url/);
    expect(refused({ keyFile: "runtime.key" })).toThrow(/local\.runtime\.keyFile is an absolute path/);
    expect(refused({ build: 10964 })).toThrow(/local\.runtime\.build is a string/);
    expect(() => parse(JSON.stringify({ ...base, local: { runtime: "llama.cpp" } }))).toThrow(
      /local\.runtime is/,
    );
    expect(() => parse(JSON.stringify({ ...base, hostAlias: "http://host.containers.internal" }))).toThrow(
      /hostAlias/,
    );
    expect(parse(JSON.stringify({ ...base, hostAlias: "169.254.1.2" })).hostAlias).toBe("169.254.1.2");
  });
});

describe("a Kvasir in a container", () => {
  it("reaches a model server on the machine's loopback by the name the machine has there, and says so", async () => {
    expect(throughHost("http://127.0.0.1:8080/v1", "host.containers.internal")).toBe(
      "http://host.containers.internal:8080/v1",
    );
    expect(throughHost("http://localhost:30000", "host.docker.internal")).toBe(
      "http://host.docker.internal:30000",
    );
    expect(throughHost("http://[::1]:8080/v1", "169.254.1.2")).toBe("http://169.254.1.2:8080/v1");
    expect(throughHost("http://10.0.0.5:8080/v1", "host.containers.internal")).toBe(
      "http://10.0.0.5:8080/v1",
    );
    expect(throughHost("http://127.0.0.1:8080/v1", null)).toBe("http://127.0.0.1:8080/v1");

    const model = await serve((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        answer(res, 200, { object: "list", data: [{ id: "m" }] });
        return;
      }
      sse(res, [chunk({ role: "assistant", content: "ready" }), chunk({}, "stop"), "[DONE]"]);
    });
    closers.push(() => model.server.close());
    // the test's machine is its own container: the name it has there is 127.0.0.1, so a server here answers by it
    const { k, url } = await kvasir(temporary(), null, { hostAlias: "127.0.0.1" });
    const port = new URL(model.url).port;
    const given = `http://localhost:${port}/v1`;
    const tried = await call(url, "POST", "/v1/backends/test", {
      baseUrl: given,
      locality: "local",
      models: ["m"],
    });
    expect(tried.body.note).toBe(
      `Kvasir runs in a container, where ${given} is the container's own address, so it reaches the server as http://127.0.0.1:${port}/v1`,
    );
    expect(tried.body.models[0].answered).toBe(true);
    const added = await call(url, "POST", "/v1/backends", {
      id: "here",
      baseUrl: given,
      locality: "local",
      models: ["m"],
    });
    expect(added.status).toBe(201);
    expect(added.body.note).toContain(`as http://127.0.0.1:${port}/v1`);
    expect(k.backends.get("here")?.config.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    // an address already by that name has nothing to say, and the runtime's own name is not an admin's to take
    const plain = await call(url, "POST", "/v1/backends/test", {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      locality: "local",
      models: ["m"],
    });
    expect(plain.body.note).toBeUndefined();
    const taken = await call(url, "POST", "/v1/backends", {
      id: "llama-cpp",
      baseUrl: given,
      locality: "local",
      models: ["other"],
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toContain(
      "llama-cpp is the backend Kvasir holds the models it starts under",
    );
  });
});

describe("admission of a started model", () => {
  it("runs as it does for any local model, and a model it refuses is shown and is no purpose's default", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url, {
      gate: true,
      ready: true,
      purposes: [{ id: "assistant.concierge", app: "nils-assistant", content: "rows", kind: "foreground" }],
    });
    const id = downloaded(k, "tiny", { "tiny-Q4_K_M.gguf": 100 });
    await call(url, "POST", `/v1/local/models/${id}/start`);
    await until(
      () => k.admissions.list().some((r) => r.backend === "llama-cpp"),
      "the admission of the started model",
      25_000,
    );
    const [record] = k.admissions.list().filter((r) => r.backend === "llama-cpp");
    // the fake runtime answers every prompt with a word and never a tool call, so the suite refuses it
    expect(record).toMatchObject({
      model: "tiny-q4-k-m",
      passed: false,
      runtime: { name: "llama.cpp", version: "b10964", build: "ubuntu-vulkan-x64" },
    });
    expect((await call(url, "GET", "/v1/config", undefined, reader)).body.models).toEqual([]);
    const backends = await call(url, "GET", "/v1/backends");
    const held = backends.body.backends.find((b: { id: string }) => b.id === "llama-cpp");
    expect(held.entries[0]).toMatchObject({ id: "tiny-q4-k-m", admitted: false });
    const grant = await call(url, "POST", "/v1/grants", { purpose: "assistant.concierge" });
    expect(grant.status).toBe(503);
    expect(grant.body.error.refusals[0].fact).toBe(
      "llama-cpp serves tiny-q4-k-m, which has not passed admission",
    );
    expect(runOf(k, id)?.state).toBe("serving");
  }, 30_000);
});

const GiB = 2 ** 30;

/** The section of a model in the runtime's presets. */
function sectionOf(presets: string, id: string): string {
  return (
    readFileSync(presets, "utf8")
      .split("\n\n")
      .find((s) => s.startsWith(`[${id}]`)) ?? ""
  );
}

describe("the context a started model opens with", () => {
  it("is the model's own up to 32,768 tokens, or what the start names, from 4,096 up to the model's own", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url);
    const long = downloaded(k, "long", {
      "long-Q4_K_M.gguf": ggufBytes(qwenLike(262_144), { padding: 1_024 }),
    });
    const short = downloaded(k, "short", {
      "short-Q4_K_M.gguf": ggufBytes(qwenLike(8_192), { padding: 1_024 }),
    });
    expect((await call(url, "POST", `/v1/local/models/${long}/start`)).status).toBe(202);
    expect(sectionOf(rt.presets, "long-q4-k-m")).toContain("\nctx-size = 32768");
    await until(() => runOf(k, long)?.state === "serving", "the long model serving");

    expect((await call(url, "POST", `/v1/local/models/${short}/start`)).status).toBe(202);
    expect(sectionOf(rt.presets, "short-q4-k-m")).toContain("\nctx-size = 8192");
    const named = await call(url, "POST", `/v1/local/models/${short}/start`, { context: 4_096 });
    expect([named.status, named.body.run.note]).toEqual([202, null]);
    expect(sectionOf(rt.presets, "short-q4-k-m")).toContain("\nctx-size = 4096");
    for (const context of [1_000, 16_384, 8_192.5, "big"]) {
      const refused = await call(url, "POST", `/v1/local/models/${short}/start`, { context });
      expect([refused.status, refused.body.error.code], String(context)).toEqual([400, "bad_request"]);
    }
    const above = await call(url, "POST", `/v1/local/models/${short}/start`, { context: 16_384 });
    expect(above.body.error.message).toBe(
      "context: a whole number of tokens from 4,096 up to the model's own, 8,192",
    );
    await until(() => runOf(k, short)?.state === "serving", "the short model serving");
    expect(runOf(k, short)?.context).toBe(16_384);
  });
});

describe("a start on a runtime that computes on the processor", () => {
  it("shortens the context where memory is short, and refuses the start where even 8,192 tokens do not fit", async () => {
    const dir = temporary();
    const rt = await router(dir);
    let free = 3 * GiB;
    const { k, url } = await kvasir(dir, rt.url, { variant: "ubuntu-x64", freeMemory: () => free });
    const id = downloaded(k, "cpu", { "cpu-Q4_K_M.gguf": ggufBytes(qwenLike(262_144), { padding: 4_096 }) });
    // 36 layers of 8 key and value heads of 128 keep about 2.4 GiB of cache for 32,768 tokens:
    // with the files and a gibibyte to spare that is more than 3 GiB, and 16,384 tokens fit
    const started = await call(url, "POST", `/v1/local/models/${id}/start`);
    expect(started.status).toBe(202);
    expect(started.body.run.note).toBe(
      "the context is 16,384 tokens, not 32,768: the model needs about 3.4 GiB of memory with 32,768, and this machine has 3.0 GiB free",
    );
    expect(sectionOf(rt.presets, "cpu-q4-k-m")).toContain("\nctx-size = 16384");
    await until(() => runOf(k, id)?.state === "serving", "the model serving");
    expect(runOf(k, id)?.note).toContain("16,384 tokens");

    await call(url, "POST", `/v1/local/models/${id}/stop`);
    free = 1.5 * GiB;
    const refused = await call(url, "POST", `/v1/local/models/${id}/start`);
    expect([refused.status, refused.body.error.code]).toEqual([409, "not_enough_memory"]);
    expect(refused.body.error.message).toBe(
      `model ${id} needs about 1.6 GiB of memory to load with 8,192 tokens of context (its files 4.4 KiB, its cache 616.3 MiB and 1.0 GiB to spare), and this machine has 1.5 GiB free: free some memory, or start a smaller model`,
    );
    expect(refused.body.error).toMatchObject({ context: 8_192, free_bytes: 1.5 * GiB });
    expect(runOf(k, id)?.state).toBe("stopped");

    // a header that says nothing leaves the files and the spare gibibyte to reckon with
    const blank = downloaded(k, "blank", { "blank-Q4_K_M.gguf": 2_048 });
    free = 0.5 * GiB;
    const unknown = await call(url, "POST", `/v1/local/models/${blank}/start`);
    expect([unknown.status, unknown.body.error.code]).toEqual([409, "not_enough_memory"]);
    expect(unknown.body.error.message).not.toContain("its cache");
    free = 2 * GiB;
    expect((await call(url, "POST", `/v1/local/models/${blank}/start`)).status).toBe(202);
  });

  it("is not reckoned on a runtime on a card, which fits the model itself, with the context no more than 32,768", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const { k, url } = await kvasir(dir, rt.url, { variant: "ubuntu-vulkan-x64", freeMemory: () => 1 });
    const id = downloaded(k, "card", { "card-Q4_K_M.gguf": ggufBytes(qwenLike(262_144)) });
    const started = await call(url, "POST", `/v1/local/models/${id}/start`);
    expect([started.status, started.body.run.note]).toEqual([202, null]);
    expect(sectionOf(rt.presets, "card-q4-k-m")).toContain("\nctx-size = 32768");
  });
});

describe("a load the runtime does not survive", () => {
  it("fails the run when the runtime stops answering under it, and is never asked for again", async () => {
    const dir = temporary();
    const rt = await router(dir, { loadMs: 2_000 });
    const { k, url } = await kvasir(dir, rt.url);
    const id = downloaded(k, "heavy", { "heavy-Q4_K_M.gguf": 100 });
    await call(url, "POST", `/v1/local/models/${id}/start`);
    await until(() => rt.asked.includes("load heavy-q4-k-m"), "the load asked for");
    rt.answering(false);
    await until(() => runOf(k, id)?.state === "failed", "the run failed");
    expect(runOf(k, id)?.error).toBe(STOPPED_WHILE_LOADING);
    // the service starts the runtime again, and nothing asks it for the model
    rt.restart();
    rt.answering(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(rt.asked.filter((a) => a === "load heavy-q4-k-m")).toHaveLength(1);
    expect(runOf(k, id)?.state).toBe("failed");
    expect(k.local.get(id)?.startable).toBe(true);
    expect(k.backends.get("llama-cpp")).toBeUndefined();
  });

  it("fails the run when the runtime answers again without the model it was loading", async () => {
    const dir = temporary();
    const rt = await router(dir, { loadMs: 2_000 });
    const { k, url } = await kvasir(dir, rt.url);
    const id = downloaded(k, "heavy", { "heavy-Q4_K_M.gguf": 100 });
    await call(url, "POST", `/v1/local/models/${id}/start`);
    await until(() => rt.asked.includes("load heavy-q4-k-m"), "the load asked for");
    // started again between two looks, so Kvasir never saw it silent
    rt.restart();
    await until(() => runOf(k, id)?.state === "failed", "the run failed");
    expect(runOf(k, id)?.error).toBe(STOPPED_WHILE_LOADING);
    await new Promise((r) => setTimeout(r, 400));
    expect(rt.asked.filter((a) => a === "load heavy-q4-k-m")).toHaveLength(1);
  });

  it("is a model that was serving loaded again once, and failed if the runtime dies under that load", async () => {
    const dir = temporary();
    const timing = { loadMs: 30 };
    const rt = await router(dir, timing);
    const { k, url } = await kvasir(dir, rt.url);
    const id = downloaded(k, "alpha", { "alpha-Q4_K_M.gguf": 100 });
    await call(url, "POST", `/v1/local/models/${id}/start`);
    await until(() => runOf(k, id)?.state === "serving", "alpha serving");
    timing.loadMs = 2_000;
    rt.answering(false);
    await until(() => runOf(k, id)?.state === "starting", "the run waiting for the runtime");
    rt.restart();
    rt.answering(true);
    await until(
      () => runOf(k, id)?.error === "the runtime no longer had the model loaded, so it loads it again",
      "the model loaded again",
    );
    expect(rt.asked.filter((a) => a === "load alpha-q4-k-m")).toHaveLength(2);
    rt.answering(false);
    await until(() => runOf(k, id)?.state === "failed", "the run failed");
    expect(runOf(k, id)?.error).toBe(STOPPED_WHILE_LOADING);
    rt.restart();
    rt.answering(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(rt.asked.filter((a) => a === "load alpha-q4-k-m")).toHaveLength(2);
    await until(() => k.backends.get("llama-cpp") === undefined, "the backend let go");
  });
});

describe("kvasir local start on the command line", () => {
  it("opens the model with the context --context names, and refuses one the model does not have", async () => {
    const dir = temporary();
    const rt = await router(dir);
    const json = kvasirJson(dir, rt.url);
    const config = join(dir, "kvasir.json");
    writeFileSync(config, JSON.stringify(json));
    // the download recorded on the database, as a Kvasir that served it would have left it
    const first = build(parse(JSON.stringify(json)), { local: { statfs: ROOMY } });
    const id = downloaded(first, "short", { "short-Q4_K_M.gguf": ggufBytes(qwenLike(8_192)) });
    await first.close();
    const cli = (...args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((done) => {
        execFile(
          join(process.cwd(), "node_modules", ".bin", "vite-node"),
          [join(process.cwd(), "src", "main.ts"), "local", "start", ...args, "--config", config],
          { timeout: 60_000 },
          (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err }),
        );
      });
    const refused = await cli("--id", String(id), "--context", "16384", "--wait", "5");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain(
      "context: a whole number of tokens from 4,096 up to the model's own, 8,192",
    );
    expect(existsSync(rt.presets) ? readFileSync(rt.presets, "utf8") : "").not.toContain("short-q4-k-m");
    const started = await cli("--id", String(id), "--context", "4096", "--wait", "20");
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("as short-q4-k-m with 4,096 tokens of context");
    expect(started.out).toContain(`model ${id} is loaded as short-q4-k-m`);
    expect(sectionOf(rt.presets, "short-q4-k-m")).toContain("\nctx-size = 4096");
  }, 90_000);
});
