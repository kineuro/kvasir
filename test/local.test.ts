// SPDX-License-Identifier: AGPL-3.0-only
// Local models (record 23), against a fake Hugging Face Hub: looked up with
// the files the patterns choose; downloaded to done, each LFS file checked by
// its sha256; carried on from the part after Kvasir closes; failed on a sha256
// that does not match; paused, resumed and removed with their files; the
// location, the room a download needs and the token; the doors refused below
// admin; two Kvasirs on one database never downloading at once; and the
// commands a model server runs a download with.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { globOf, type LocalOptions, type LocalRow, safePath, serveCommands } from "../src/local.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { serve } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const commitOf = (name: string) => createHash("sha1").update(name).digest("hex");
/** Bytes that differ from file to file, so each file has its own sha256. */
function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + seed * 7) % 251;
  return b;
}
const size = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
};

interface FakeFile {
  path: string;
  body: Buffer;
  lfs?: boolean;
  /** A sha256 the hub lists that the bytes do not have. */
  listed?: string;
}
interface FakeRepo {
  repo: string;
  commit: string;
  files: FakeFile[];
  /** The token a gated repository wants. */
  wants?: string;
}

const SHARD1 = "model-00001-of-00002.safetensors";
const SHARD2 = "model-00002-of-00002.safetensors";
const TINY: FakeRepo = {
  repo: "acme/tiny-7b",
  commit: commitOf("tiny"),
  files: [
    { path: "config.json", body: Buffer.from(JSON.stringify({ architectures: ["TinyForCausalLM"] })) },
    { path: SHARD1, body: bytes(600_000, 1), lfs: true },
    { path: SHARD2, body: bytes(400_000, 2), lfs: true },
    { path: "README.md", body: Buffer.from("# tiny\n") },
  ],
};
const GGUF: FakeRepo = {
  repo: "acme/tiny-gguf",
  commit: commitOf("gguf"),
  files: [
    { path: "tiny-Q4_K_M.gguf", body: bytes(300_000, 3), lfs: true },
    { path: "tiny-Q8_0.gguf", body: bytes(500_000, 4), lfs: true },
    { path: "mmproj-tiny.gguf", body: bytes(1_000, 5), lfs: true },
  ],
};
const BROKEN: FakeRepo = {
  repo: "acme/broken",
  commit: commitOf("broken"),
  files: [
    { path: "model.safetensors", body: bytes(80_000, 7), lfs: true, listed: sha256(Buffer.from("other")) },
  ],
};
const UNSAFE: FakeRepo = {
  repo: "acme/unsafe",
  commit: commitOf("unsafe"),
  files: [
    { path: "model.safetensors", body: bytes(1_000, 8), lfs: true },
    { path: "../escape.bin", body: Buffer.from("out") },
  ],
};
const GATED: FakeRepo = {
  repo: "acme/gated",
  commit: commitOf("gated"),
  wants: "hf_the-right-token",
  files: [
    { path: "config.json", body: Buffer.from("{}") },
    { path: "model.safetensors", body: bytes(120_000, 9), lfs: true },
  ],
};

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface Seen {
  at: "hub" | "cdn";
  path: string;
  range: string | null;
  auth: string | null;
  /** The encoding a request for a file's bytes accepts. */
  encoding?: string;
}

/**
 * A fake Hugging Face Hub: the revision JSON with its blobs, and the files with
 * Range. A hold stops a file after so many bytes until the test lets it go, as
 * a slow download does. With `cdn`, a large file is sent on to a second server,
 * as the hub sends one to its storage. Every file request is recorded, and the
 * most sent at once.
 */
async function hub(repos: FakeRepo[], opts: { cdn?: boolean } = {}) {
  const seen = { requests: [] as Seen[], running: 0, most: 0 };
  const holds = new Map<string, { at: number; reached: () => void; release: Promise<void> }>();
  const send = async (res: ServerResponse, f: FakeFile, range: string | null) => {
    const from = range ? Number(/^bytes=(\d+)-$/u.exec(range)?.[1] ?? 0) : 0;
    if (range && from >= f.body.length) {
      res.writeHead(416, { "content-range": `bytes */${f.body.length}` });
      res.end();
      return;
    }
    const piece = f.body.subarray(from);
    res.writeHead(range ? 206 : 200, {
      "content-length": piece.length,
      ...(range ? { "content-range": `bytes ${from}-${f.body.length - 1}/${f.body.length}` } : {}),
    });
    seen.running += 1;
    seen.most = Math.max(seen.most, seen.running);
    let open = true;
    const finished = () => {
      if (open) seen.running -= 1;
      open = false;
    };
    res.once("finish", finished);
    res.once("close", finished);
    const hold = holds.get(f.path);
    if (hold && from < hold.at) {
      holds.delete(f.path);
      res.write(piece.subarray(0, hold.at - from));
      hold.reached();
      await hold.release;
      if (!res.destroyed) res.end(piece.subarray(hold.at - from));
      return;
    }
    res.end(piece);
  };
  const find = (repo: string, commit: string, path: string) =>
    repos.find((r) => r.repo === repo && r.commit === commit)?.files.find((f) => f.path === path);
  const cdn = opts.cdn
    ? await serve((req, res) => {
        const m = /^\/blob\/([^/]+\/[^/]+)\/([0-9a-f]{40})\/(.+)$/u.exec(req.url ?? "");
        const f = m ? find(m[1], m[2], decodeURIComponent(m[3])) : undefined;
        if (!f) {
          answer(res, 404, {});
          return;
        }
        const range = req.headers.range ?? null;
        seen.requests.push({ at: "cdn", path: f.path, range, auth: req.headers.authorization ?? null });
        void send(res, f, range);
      })
    : null;
  const rt = await serve((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    const auth = req.headers.authorization ?? null;
    const api = /^\/api\/models\/([^/]+\/[^/]+)\/revision\/([^/]+)$/u.exec(url.pathname);
    if (api) {
      const r = repos.find((x) => x.repo === api[1]);
      if (!r) answer(res, 404, { error: "Repository not found" });
      else if (r.wants && auth !== `Bearer ${r.wants}`)
        answer(res, auth ? 403 : 401, { error: "Access to this model is restricted" });
      else if (decodeURIComponent(api[2]) !== "main" && decodeURIComponent(api[2]) !== r.commit)
        answer(res, 404, { error: "Revision not found" });
      else
        answer(res, 200, {
          id: r.repo,
          sha: r.commit,
          siblings: r.files.map((f) => ({
            rfilename: f.path,
            size: f.body.length,
            ...(f.lfs
              ? { lfs: { sha256: f.listed ?? sha256(f.body), size: f.body.length, pointerSize: 134 } }
              : {}),
          })),
        });
      return;
    }
    const m = /^\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/(.+)$/u.exec(url.pathname);
    const r = m ? repos.find((x) => x.repo === m[1] && x.commit === m[2]) : undefined;
    const f = m ? find(m[1], m[2], decodeURIComponent(m[3])) : undefined;
    if (!r || !f) {
      answer(res, 404, { error: "Entry not found" });
      return;
    }
    const range = req.headers.range ?? null;
    seen.requests.push({ at: "hub", path: f.path, range, auth, encoding: req.headers["accept-encoding"] });
    if (r.wants && auth !== `Bearer ${r.wants}`) answer(res, 401, {});
    else if (cdn && f.lfs) {
      res.writeHead(302, { location: `${cdn.url}/blob/${r.repo}/${r.commit}/${encodeURIComponent(f.path)}` });
      res.end();
    } else void send(res, f, range);
  });
  closers.push(() => rt.server.close());
  if (cdn) closers.push(() => cdn.server.close());
  return {
    url: rt.url,
    seen,
    /** The requests for one file, by the Range each asked for. */
    ranges: (path: string) =>
      seen.requests.filter((q) => q.path === path && q.at === "hub").map((q) => q.range),
    /** Hold the next request for a file after `at` bytes: `reached` once held, `release` to send the rest. */
    hold(path: string, at: number) {
      let reached = () => {};
      let release = () => {};
      const held = {
        reached: new Promise<void>((r) => {
          reached = r;
        }),
        release: () => release(),
      };
      holds.set(path, {
        at,
        reached: () => reached(),
        release: new Promise<void>((r) => {
          release = r;
        }),
      });
      return held;
    },
  };
}

const TOKENS = { "an-admin-token": "anna@lab:admin", "a-reader-token": "bo@lab:reader" };
/** Room enough on every file system, unless a test says otherwise. */
const ROOMY = () => ({ bavail: 2 ** 40, bsize: 1 });

async function kvasir(endpoint: string, opts: { dir?: string; local?: LocalOptions } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "kvasir-local-"));
  const k: Kvasir = build(
    parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: { mode: "token", tokens: TOKENS },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: false },
        purposes: [],
        local: { endpoint },
      }),
    ),
    { local: { statfs: ROOMY, pollMs: 50, ...opts.local } },
  );
  const url = await listen(k, "127.0.0.1:0");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await k.close();
  };
  closers.push(close);
  return { k, url, dir, close };
}

const admin = { authorization: "Bearer an-admin-token", "content-type": "application/json" };
const reader = { authorization: "Bearer a-reader-token", "content-type": "application/json" };

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

const stateOf = (k: Kvasir, id: number) => k.local.get(id)?.state;

describe("local models", () => {
  it("are looked up on the hub with the files the patterns choose, their sizes and the total, and nothing kept", async () => {
    const h = await hub([TINY, UNSAFE]);
    const { k, url } = await kvasir(h.url);
    const all = await call(url, "POST", "/v1/local/lookup", { repo: "acme/tiny-7b" });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      repo: "acme/tiny-7b",
      revision: "main",
      commit: TINY.commit,
      include: [],
    });
    expect(all.body.files.map((f: { path: string }) => f.path)).toEqual(TINY.files.map((f) => f.path));
    expect(all.body.files[0]).toEqual({ path: "config.json", size: TINY.files[0].body.length, sha256: null });
    expect(all.body.files[1].sha256).toBe(sha256(TINY.files[1].body));
    expect(all.body.bytes_total).toBe(TINY.files.reduce((n, f) => n + f.body.length, 0));
    const chosen = await call(url, "POST", "/v1/local/lookup", {
      repo: "acme/tiny-7b",
      revision: TINY.commit,
      include: ["*.safetensors", "config.json"],
    });
    expect(chosen.body.files.map((f: { path: string }) => f.path)).toEqual(["config.json", SHARD1, SHARD2]);
    expect(chosen.body.bytes_total).toBe(TINY.files[0].body.length + 1_000_000);
    expect(k.local.list()).toEqual([]);
    // the patterns are read as the hub's command line reads them
    expect(globOf("*.gguf").test("q4/tiny.gguf")).toBe(true);
    expect(globOf("tiny-Q?_*.gguf").test("tiny-Q4_K_M.gguf")).toBe(true);
    expect(globOf("[!m]*.gguf").test("mmproj.gguf")).toBe(false);
    expect(globOf("onnx/").test("onnx/model.onnx")).toBe(true);
    expect(globOf("model.(1).bin").test("model.(1).bin")).toBe(true);
    // what is not a repository or a revision is refused before the hub is asked
    for (const bad of [{ repo: "acme" }, { repo: "acme/../etc" }, { repo: "acme/a--b" }, { repo: "a b/c" }]) {
      expect((await call(url, "POST", "/v1/local/lookup", bad)).status).toBe(400);
    }
    const revision = await call(url, "POST", "/v1/local/lookup", {
      repo: "acme/tiny-7b",
      revision: "main; rm",
    });
    expect(revision.body.error.message).toMatch(/a branch, a tag or a forty-character commit/);
    const missing = await call(url, "POST", "/v1/local/lookup", { repo: "nobody/nothing" });
    expect(missing.body.error).toMatchObject({ code: "not_on_hub" });
    // a path that would leave the model's folder is refused, unless the patterns leave it out
    const unsafe = await call(url, "POST", "/v1/local/lookup", { repo: "acme/unsafe" });
    expect(unsafe.status).toBe(502);
    expect(unsafe.body.error.message).toContain("../escape.bin");
    const without = await call(url, "POST", "/v1/local/lookup", {
      repo: "acme/unsafe",
      include: "*.safetensors",
    });
    expect(without.status).toBe(200);
    for (const path of ["/etc/passwd", "a/../../b", "a\\b", "C:/x", "a//b", "./a", ""]) {
      expect(safePath(path), path).toBe(false);
    }
    expect(safePath("onnx/model.onnx")).toBe(true);
  });

  it("download to done one file at a time, each LFS file checked by its sha256", async () => {
    const h = await hub([TINY]);
    const { k, url } = await kvasir(h.url);
    k.local.start();
    const added = await call(url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: ["*.safetensors", "config.json"],
    });
    expect(added.status).toBe(202);
    expect(added.body).toMatchObject({
      repo: "acme/tiny-7b",
      revision: "main",
      commit: TINY.commit,
      path: join(k.local.location(), "acme--tiny-7b", TINY.commit),
      files: 3,
      bytes_total: TINY.files[0].body.length + 1_000_000,
      error: null,
      added_by: "anna@lab",
      finished_at: null,
      serve: [],
    });
    expect(["queued", "downloading"]).toContain(added.body.state);
    await until(() => stateOf(k, added.body.id) === "done", "the download");
    const row = k.local.get(added.body.id) as LocalRow;
    expect(row.bytes_done).toBe(row.bytes_total);
    expect(row.finished_at).not.toBeNull();
    for (const f of TINY.files.slice(0, 3))
      expect(readFileSync(join(row.path, f.path)).equals(f.body)).toBe(true);
    expect(existsSync(join(row.path, "README.md"))).toBe(false);
    expect(readdirSync(row.path).some((name) => name.endsWith(".part"))).toBe(false);
    expect(h.seen.most).toBe(1);
    // the bytes are asked for as they are, so a range counts the file's own bytes and never compressed ones
    expect(h.seen.requests.map((q) => q.encoding)).toEqual(["identity", "identity", "identity"]);
    expect(row.serve.map((s) => s.runtime)).toEqual(["sglang", "vllm"]);
    const listed = await call(url, "GET", "/v1/local");
    expect(listed.body).toMatchObject({ location: k.local.location(), free_bytes: 2 ** 40, token: false });
    expect(listed.body.models).toEqual([row]);
    // the same commit again into the same location is refused, and the hub is not asked for its files again
    const again = await call(url, "POST", "/v1/local/models", { repo: "acme/tiny-7b" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain(`model ${row.id}`);
  });

  it("carry on from the part when Kvasir closes mid-download and starts again", async () => {
    const h = await hub([TINY]);
    const first = await kvasir(h.url);
    first.k.local.start();
    const held = h.hold(SHARD1, 250_000);
    const added = await call(first.url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: "*.safetensors",
    });
    const part = join(added.body.path, `${SHARD1}.part`);
    await held.reached;
    await until(() => size(part) === 250_000, "the part");
    await first.close();
    held.release();
    // closing stopped it where it was: queued again for the next Kvasir, the part kept
    const second = await kvasir(h.url, { dir: first.dir });
    expect(stateOf(second.k, added.body.id)).toBe("queued");
    expect(size(part)).toBe(250_000);
    second.k.local.start();
    await until(() => stateOf(second.k, added.body.id) === "done", "the download carried on");
    expect(h.ranges(SHARD1)).toEqual([null, "bytes=250000-"]);
    expect(readFileSync(join(added.body.path, SHARD1)).equals(TINY.files[1].body)).toBe(true);
    expect(existsSync(part)).toBe(false);
  });

  it("fail a model whose file does not match the sha256 the hub lists, and delete its part", async () => {
    const h = await hub([BROKEN]);
    const { k, url } = await kvasir(h.url);
    k.local.start();
    const added = await call(url, "POST", "/v1/local/models", { repo: "acme/broken" });
    await until(() => stateOf(k, added.body.id) === "failed", "the failure");
    const row = k.local.get(added.body.id) as LocalRow;
    expect(row.error).toContain("model.safetensors does not match the sha256 the hub lists");
    expect(row.serve).toEqual([]);
    expect(existsSync(join(row.path, "model.safetensors.part"))).toBe(false);
    expect(existsSync(join(row.path, "model.safetensors"))).toBe(false);
  });

  it("pause with what they have, resume from it, and are removed with their files, a download stopped first", async () => {
    const h = await hub([TINY]);
    const { k, url } = await kvasir(h.url);
    k.local.start();
    const held = h.hold(SHARD2, 100_000);
    const added = await call(url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: "*.safetensors",
    });
    const id = added.body.id;
    const part = join(added.body.path, `${SHARD2}.part`);
    await held.reached;
    await until(() => size(part) === 100_000, "the part");
    const paused = await call(url, "POST", `/v1/local/models/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.state).toBe("paused");
    held.release();
    await until(() => k.local.leaseHolder() === null, "the download to stop");
    // nothing carries a paused model on
    await new Promise((r) => setTimeout(r, 150));
    expect(stateOf(k, id)).toBe("paused");
    expect(size(part)).toBe(100_000);
    expect(readFileSync(join(added.body.path, SHARD1)).equals(TINY.files[1].body)).toBe(true);
    const resumed = await call(url, "POST", `/v1/local/models/${id}/resume`);
    expect(["queued", "downloading"]).toContain(resumed.body.state);
    await until(() => stateOf(k, id) === "done", "the resumed download");
    expect(h.ranges(SHARD2)).toEqual([null, "bytes=100000-"]);
    expect(readFileSync(join(added.body.path, SHARD2)).equals(TINY.files[2].body)).toBe(true);
    expect((await call(url, "POST", `/v1/local/models/${id}/pause`)).status).toBe(409);
    expect((await call(url, "POST", `/v1/local/models/${id}/resume`)).status).toBe(409);
    expect((await call(url, "DELETE", `/v1/local/models/${id}`)).status).toBe(204);
    expect(existsSync(added.body.path)).toBe(false);
    expect(existsSync(dirname(added.body.path))).toBe(false);
    expect(k.local.get(id)).toBeNull();
    expect((await call(url, "DELETE", `/v1/local/models/${id}`)).status).toBe(404);
    expect((await call(url, "POST", `/v1/local/models/${id}/pause`)).body.error.code).toBe("no_such_model");
    // a model removed while it downloads has its download stopped before its folder goes
    const again = h.hold(SHARD1, 100_000);
    const second = await call(url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: "*.safetensors",
    });
    await again.reached;
    await until(() => size(join(second.body.path, `${SHARD1}.part`)) === 100_000, "the second part");
    expect((await call(url, "DELETE", `/v1/local/models/${second.body.id}`)).status).toBe(204);
    again.release();
    await until(() => k.local.leaseHolder() === null, "the removed download to stop");
    expect(existsSync(second.body.path)).toBe(false);
    expect(k.local.list()).toEqual([]);
  });

  it("go to a location an admin changes, beside the database at first, and a model downloaded before keeps its path", async () => {
    const h = await hub([TINY, GGUF]);
    const { k, url, dir } = await kvasir(h.url);
    k.local.start();
    expect((await call(url, "GET", "/v1/local")).body.location).toBe(join(dir, "models"));
    const first = await call(url, "POST", "/v1/local/models", {
      repo: "acme/tiny-gguf",
      include: "tiny-Q4_K_M.gguf",
    });
    expect(first.body.path).toBe(join(dir, "models", "acme--tiny-gguf", GGUF.commit));
    await until(() => stateOf(k, first.body.id) === "done", "the first download");
    const elsewhere = join(mkdtempSync(join(tmpdir(), "kvasir-location-")), "not", "there", "yet");
    const moved = await call(url, "PUT", "/v1/local/location", { path: `${elsewhere}/` });
    expect(moved.status).toBe(200);
    expect(moved.body.location).toBe(elsewhere);
    expect(statSync(elsewhere).isDirectory()).toBe(true);
    const second = await call(url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: "config.json",
    });
    expect(second.body.path).toBe(join(elsewhere, "acme--tiny-7b", TINY.commit));
    await until(() => stateOf(k, second.body.id) === "done", "the second download");
    const listed = (await call(url, "GET", "/v1/local")).body;
    expect(listed.location).toBe(elsewhere);
    expect(listed.models.map((m: LocalRow) => m.path)).toEqual([first.body.path, second.body.path]);
    expect(readFileSync(join(first.body.path, "tiny-Q4_K_M.gguf")).equals(GGUF.files[0].body)).toBe(true);
    expect(listed.models[0].serve.map((s: { runtime: string }) => s.runtime)).toEqual([
      "llama.cpp",
      "ollama",
    ]);
    // a relative path, a file, a path under a file and a folder Kvasir cannot write are refused in words
    const relative = await call(url, "PUT", "/v1/local/location", { path: "models" });
    expect(relative.status).toBe(400);
    expect(relative.body.error).toMatchObject({ code: "bad_location" });
    expect(relative.body.error.message).toContain("is not an absolute path");
    const file = join(dir, "a-file");
    writeFileSync(file, "");
    const onFile = await call(url, "PUT", "/v1/local/location", { path: file });
    expect(onFile.body.error.message).toContain("is a file, not a folder");
    const underFile = await call(url, "PUT", "/v1/local/location", { path: join(file, "models") });
    expect(underFile.body.error.message).toContain("could not be created");
    if (process.getuid?.() !== 0) {
      const locked = mkdtempSync(join(tmpdir(), "kvasir-locked-"));
      chmodSync(locked, 0o555);
      closers.push(() => chmodSync(locked, 0o755));
      const refused = await call(url, "PUT", "/v1/local/location", { path: locked });
      expect(refused.body.error.message).toContain("is not writable by Kvasir");
    }
    expect((await call(url, "PUT", "/v1/local/location", {})).status).toBe(400);
    expect(k.local.location()).toBe(elsewhere);
  });

  it("are refused where the location lacks their room and a gibibyte more, saying both numbers", async () => {
    const h = await hub([TINY]);
    let free = 256 * 2 ** 20;
    const { k, url } = await kvasir(h.url, { local: { statfs: () => ({ bavail: free, bsize: 1 }) } });
    const refused = await call(url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: "*.safetensors",
    });
    expect(refused.status).toBe(507);
    expect(refused.body.error).toMatchObject({
      code: "no_space",
      free_bytes: free,
      needed_bytes: 1_000_000 + 2 ** 30,
    });
    expect(refused.body.error.message).toContain(
      "has 256.0 MiB free, and this download needs 1.0 GiB: 976.6 KiB still to download and 1 GiB to spare",
    );
    expect(k.local.list()).toEqual([]);
    // the room is asked again when the download starts
    free = 2 ** 40;
    const added = await call(url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: "*.safetensors",
    });
    expect(added.status).toBe(202);
    free = 1_000;
    k.local.start();
    await until(() => stateOf(k, added.body.id) === "failed", "the refusal at the start");
    expect(k.local.get(added.body.id)?.error).toContain("has 1000 bytes free");
    expect(h.ranges(SHARD1)).toEqual([]);
  });

  it("reach a gated model with a Hugging Face token that is sealed, sent only to the hub, and never returned", async () => {
    const h = await hub([GATED], { cdn: true });
    const { k, url, dir } = await kvasir(h.url);
    k.local.start();
    const without = await call(url, "POST", "/v1/local/lookup", { repo: "acme/gated" });
    expect(without.status).toBe(422);
    expect(without.body.error.code).toBe("needs_token");
    expect(without.body.error.message).toContain("a gated or private model needs a Hugging Face token");
    expect((await call(url, "PUT", "/v1/local/token", { token: "hf_a-token-without-access" })).status).toBe(
      200,
    );
    const wrong = await call(url, "POST", "/v1/local/lookup", { repo: "acme/gated" });
    expect(wrong.body.error.message).toContain("refused the token for acme/gated");
    const token = GATED.wants as string;
    const set = await call(url, "PUT", "/v1/local/token", { token });
    expect(set.body).toEqual({ token: true, shown: "never" });
    const status = await call(url, "GET", "/v1/local");
    expect(status.body.token).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain("hf_");
    for (const name of ["kvasir.sqlite", "kvasir.sqlite-wal"]) {
      const at = join(dir, name);
      if (existsSync(at)) expect(readFileSync(at).includes(Buffer.from(token))).toBe(false);
    }
    const added = await call(url, "POST", "/v1/local/models", { repo: "acme/gated" });
    await until(() => stateOf(k, added.body.id) === "done", "the gated download");
    expect(readFileSync(join(added.body.path, "model.safetensors")).equals(GATED.files[1].body)).toBe(true);
    // the token went to the hub, and never to the storage the large file was sent on to
    const storage = h.seen.requests.filter((q) => q.at === "cdn");
    expect(storage.map((q) => q.path)).toEqual(["model.safetensors"]);
    expect(storage.every((q) => q.auth === null)).toBe(true);
    const fromHub = h.seen.requests.filter((q) => q.at === "hub");
    expect(fromHub.length).toBe(2);
    expect(fromHub.every((q) => q.auth === `Bearer ${token}`)).toBe(true);
    // no backend takes the name the token is sealed under
    const named = await call(url, "POST", "/v1/backends", {
      id: "huggingface",
      baseUrl: "http://127.0.0.1:9/v1",
      locality: "local",
      models: ["m"],
    });
    expect(named.status).toBe(409);
    expect(k.local.hasToken()).toBe(true);
    expect((await call(url, "PUT", "/v1/local/token", { token: "short" })).status).toBe(400);
    expect((await call(url, "DELETE", "/v1/local/token")).status).toBe(204);
    expect((await call(url, "GET", "/v1/local")).body.token).toBe(false);
    expect((await call(url, "DELETE", "/v1/local/token")).status).toBe(404);
  });

  it("are an admin's: every door refuses a reader", async () => {
    const h = await hub([TINY]);
    const { k, url } = await kvasir(h.url);
    const doors: [string, string, unknown?][] = [
      ["GET", "/v1/local"],
      ["PUT", "/v1/local/location", { path: join(tmpdir(), "kvasir-a-reader-location") }],
      ["POST", "/v1/local/lookup", { repo: "acme/tiny-7b" }],
      ["POST", "/v1/local/models", { repo: "acme/tiny-7b" }],
      ["POST", "/v1/local/models/1/pause"],
      ["POST", "/v1/local/models/1/resume"],
      ["DELETE", "/v1/local/models/1"],
      ["PUT", "/v1/local/token", { token: "hf_a-reader-brought-this" }],
      ["DELETE", "/v1/local/token"],
    ];
    for (const [method, path, body] of doors) {
      const r = await call(url, method, path, body, reader);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error.code).toBe("no_role");
    }
    expect(k.local.hasToken()).toBe(false);
    expect(k.local.list()).toEqual([]);
    expect(h.seen.requests).toEqual([]);
    expect((await call(url, "POST", "/v1/local/nothing")).body.error.code).toBe("no_such_door");
  });

  it("are downloaded by one Kvasir at a time on a database, and a command line's download is left to a serving one", async () => {
    const small = (name: string, seed: number): FakeRepo => ({
      repo: `acme/${name}`,
      commit: commitOf(name),
      files: [{ path: `${name}.gguf`, body: bytes(50_000, seed), lfs: true }],
    });
    const [one, two, three] = [small("one", 11), small("two", 12), small("three", 13)];
    const h = await hub([TINY, GGUF, one, two, three]);
    const a = await kvasir(h.url);
    const b = await kvasir(h.url, { dir: a.dir });
    a.k.local.start();
    b.k.local.start();
    const held = h.hold(SHARD1, 100_000);
    const added = await call(b.url, "POST", "/v1/local/models", {
      repo: "acme/tiny-7b",
      include: "*.safetensors",
    });
    await held.reached;
    expect([a.k.local.holder, b.k.local.holder]).toContain(a.k.local.leaseHolder());
    // both look for work many times over while one holds the file, and neither asks for it again
    await new Promise((r) => setTimeout(r, 300));
    expect(h.ranges(SHARD1)).toEqual([null]);
    held.release();
    await until(() => stateOf(a.k, added.body.id) === "done", "the download");
    expect(h.ranges(SHARD1)).toEqual([null]);
    expect(h.ranges(SHARD2)).toEqual([null]);
    expect(h.seen.most).toBe(1);

    // the command line, on the same database and serving nothing: a serving Kvasir takes its download
    const cli = await kvasir(h.url, { dir: a.dir });
    const taken = await cli.k.local.add({ repo: "acme/one" }, "anna@cli");
    expect(await cli.k.local.follow(taken.id, { waitMs: 3_000 })).toBe("taken");
    await until(() => stateOf(cli.k, taken.id) === "done", "the download a server took");

    // while a Kvasir downloads another model, the command line's waits its turn in the queue
    const busy = h.hold("tiny-Q8_0.gguf", 100_000);
    const other = await call(a.url, "POST", "/v1/local/models", {
      repo: "acme/tiny-gguf",
      include: "tiny-Q8_0.gguf",
    });
    await busy.reached;
    const behind = await cli.k.local.add({ repo: "acme/two" }, "anna@cli");
    expect(await cli.k.local.follow(behind.id, { waitMs: 200 })).toBe("waiting");
    expect(stateOf(cli.k, behind.id)).toBe("queued");
    busy.release();
    await until(
      () => stateOf(cli.k, other.body.id) === "done" && stateOf(cli.k, behind.id) === "done",
      "the queue",
    );

    // with no Kvasir serving, the command line downloads it itself and says so
    await a.close();
    await b.close();
    let said = false;
    const alone = await cli.k.local.add({ repo: "acme/three" }, "anna@cli");
    const how = await cli.k.local.follow(alone.id, {
      waitMs: 200,
      here: () => {
        said = true;
      },
    });
    expect(how).toBe("here");
    expect(said).toBe(true);
    expect(stateOf(cli.k, alone.id)).toBe("done");
    expect(h.seen.most).toBe(1);
  }, 20_000);
});

describe("the commands a model server runs a download with", () => {
  it("are llama.cpp's and Ollama's for a GGUF file, and SGLang's and vLLM's for safetensors with a config.json", () => {
    const dir = "/models/acme--tiny-gguf/abc";
    expect(
      serveCommands(dir, [
        "tiny-Q4_K_M.gguf",
        "mmproj-tiny.gguf",
        "big/big-00002-of-00003.gguf",
        "big/big-00001-of-00003.gguf",
      ]),
    ).toEqual([
      { runtime: "llama.cpp", command: `llama-server -m ${dir}/tiny-Q4_K_M.gguf --port 8080` },
      { runtime: "ollama", command: `FROM ${dir}/tiny-Q4_K_M.gguf` },
      { runtime: "llama.cpp", command: `llama-server -m ${dir}/big/big-00001-of-00003.gguf --port 8080` },
      { runtime: "ollama", command: `FROM ${dir}/big/big-00001-of-00003.gguf` },
    ]);
    const weights = "/models/acme--tiny-7b/abc";
    expect(serveCommands(weights, ["config.json", SHARD1, SHARD2, "README.md"])).toEqual([
      { runtime: "sglang", command: `python -m sglang.launch_server --model-path ${weights} --port 30000` },
      { runtime: "vllm", command: `vllm serve ${weights} --port 8000` },
    ]);
    // a config.json without weights is served by nothing, and a path a shell would split is quoted
    expect(serveCommands(weights, ["config.json", "tokenizer.json"])).toEqual([]);
    expect(serveCommands("/models/with space/x", ["it's.gguf"])).toEqual([
      { runtime: "llama.cpp", command: `llama-server -m '/models/with space/x/it'\\''s.gguf' --port 8080` },
      { runtime: "ollama", command: `FROM "/models/with space/x/it's.gguf"` },
    ]);
  });
});
