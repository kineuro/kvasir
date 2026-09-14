// SPDX-License-Identifier: AGPL-3.0-only
// The models Kvasir holds (record 23): tried without keeping anything, held
// only once every model answered, served at once, followed by a second
// Kvasir on the same database, and let go with their keys and the policy
// rows that named them.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { described, idFrom, kindOf } from "../src/held.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { chunk, serve, sse } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

/** A model server that lists `served` and answers each with a word; with `wants`, only for that key. */
async function runtime(served: string[], wants?: string) {
  const rt = await serve((req, res, text) => {
    if (wants && req.headers.authorization !== `Bearer ${wants}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: served.map((id) => ({ id })) }));
      return;
    }
    const q = JSON.parse(text || "{}") as { model?: string };
    if (!served.includes(q.model ?? "")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `The model ${q.model} does not exist` } }));
      return;
    }
    sse(res, [chunk({ role: "assistant", content: "ready" }), chunk({}, "stop"), "[DONE]"]);
  });
  closers.push(() => rt.server.close());
  return rt;
}

async function kvasir(
  dir = mkdtempSync(join(tmpdir(), "kvasir-held-")),
): Promise<{ k: Kvasir; url: string; dir: string }> {
  const k = build(
    parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: {
          mode: "token",
          tokens: { "an-admin-token": "anna@lab:admin", "a-reader-token": "bo@lab:reader" },
        },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: false },
        purposes: [{ id: "assistant.title", app: "nils-assistant", content: "catalog", kind: "background" }],
      }),
    ),
  );
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url, dir };
}

const admin = { authorization: "Bearer an-admin-token", "content-type": "application/json" };
const reader = { authorization: "Bearer a-reader-token", "content-type": "application/json" };
const post = (url: string, path: string, body: unknown, headers = admin) =>
  fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

describe("the models Kvasir holds", () => {
  it("start as none, and a kvasir.json that still names backends is refused", async () => {
    const { url } = await kvasir();
    const listed = await (await fetch(`${url}/v1/backends`, { headers: reader })).json();
    // Kvasir's own ChatGPT backend is there from the start; nothing an admin added is
    expect(listed.backends.filter((b: { builtin: boolean }) => !b.builtin)).toEqual([]);
    expect(() => parse(JSON.stringify({ bind: "x", origin: "http://x", backends: [] }))).toThrow(
      /held in Kvasir's database/,
    );
  });

  it("are tried without anything kept, and say why a model did not answer", async () => {
    const rt = await runtime(["qwen"], "sk-good");
    const { k, url } = await kvasir();
    const base = { baseUrl: `${rt.url}/v1`, locality: "local" };
    const tried = await (
      await post(url, "/v1/backends/test", { ...base, key: "sk-good", models: ["qwen", "gone"] })
    ).json();
    expect(tried.listed).toEqual(["qwen"]);
    expect(tried.models.map((m: { id: string; answered: boolean }) => [m.id, m.answered])).toEqual([
      ["qwen", true],
      ["gone", false],
    ]);
    expect(tried.models[1].error.kind).toBe("no_model");
    // with no model named, only what the server lists: what a person picks from
    const listing = await (await post(url, "/v1/backends/test", { ...base, key: "sk-good" })).json();
    expect(listing).toEqual({ listed: ["qwen"], models: [] });
    const wrong = await (
      await post(url, "/v1/backends/test", { ...base, key: "sk-bad", models: ["qwen"] })
    ).json();
    expect(wrong.models[0].error.kind).toBe("key_refused");
    expect(k.backends.list.filter((b) => !b.config.builtin)).toHaveLength(0);
    expect((await post(url, "/v1/backends/test", { ...base, models: ["qwen"] }, reader)).status).toBe(403);
  });

  it("are held only once every model answered, the key sealed, and served at once", async () => {
    const rt = await runtime(["qwen"], "sk-good");
    const { k, url, dir } = await kvasir();
    const base = { baseUrl: `${rt.url}/v1`, locality: "local", key: "sk-good" };
    const silent = await post(url, "/v1/backends", { ...base, models: ["qwen", "gone"] });
    expect(silent.status).toBe(422);
    const why = await silent.json();
    expect(why.error.models.find((m: { id: string }) => m.id === "gone").answered).toBe(false);
    expect(k.backends.list.filter((b) => !b.config.builtin)).toHaveLength(0);

    const added = await post(url, "/v1/backends", {
      ...base,
      id: "card",
      models: [{ id: "qwen", contextWindow: 65536, maxTokens: 8192 }],
    });
    expect(added.status).toBe(201);
    expect((await added.json()).backend).toEqual({ id: "card", locality: "local", models: ["qwen"] });
    const listed = await (await fetch(`${url}/v1/backends`, { headers: admin })).json();
    expect(listed.backends[0]).toMatchObject({
      id: "card",
      base_url: `${rt.url}/v1`,
      credential: true,
      added_by: "anna@lab",
      models: ["qwen"],
    });
    expect(listed.backends[0].entries[0]).toMatchObject({
      id: "qwen",
      context_window: 65536,
      max_tokens: 8192,
    });
    const asReader = await (await fetch(`${url}/v1/backends`, { headers: reader })).json();
    expect(asReader.backends[0].base_url).toBeUndefined();
    expect(readFileSync(join(dir, "kvasir.sqlite")).includes(Buffer.from("sk-good"))).toBe(false);
    expect((await post(url, "/v1/backends", { ...base, id: "card", models: ["qwen"] })).status).toBe(409);
    expect((await post(url, "/v1/backends", { ...base, models: ["qwen"] }, reader)).status).toBe(403);
  });

  it("are followed by a second Kvasir on the same database, and let go with their key and the policy rows naming them", async () => {
    const rt = await runtime(["qwen"]);
    const first = await kvasir();
    const second = await kvasir(first.dir);
    expect(
      (
        await post(first.url, "/v1/backends", {
          id: "card",
          baseUrl: `${rt.url}/v1`,
          locality: "local",
          models: ["qwen"],
        })
      ).status,
    ).toBe(201);
    expect(second.k.backends.list.filter((b) => !b.config.builtin)).toHaveLength(0);
    second.k.held.sync();
    expect(second.k.backends.list.filter((b) => !b.config.builtin).map((b) => b.config.id)).toEqual(["card"]);

    const mapped = await fetch(`${first.url}/v1/purposes/assistant.title/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "card" }),
    });
    expect(mapped.status).toBe(200);
    first.k.credentials.put("card", "a-key-stored-later");
    const gone = await fetch(`${first.url}/v1/backends/card`, { method: "DELETE", headers: admin });
    expect(gone.status).toBe(204);
    expect(first.k.policy.row("assistant.title")).toBeUndefined();
    expect(first.k.credentials.has("card")).toBe(false);
    second.k.held.sync();
    expect(second.k.backends.list.filter((b) => !b.config.builtin)).toHaveLength(0);
    expect((await fetch(`${first.url}/v1/backends/card`, { method: "DELETE", headers: admin })).status).toBe(
      404,
    );
  });

  it("are followed by a second Kvasir when another changed a backend's models, served again in its place (record 24)", async () => {
    const rt = await runtime(["qwen", "gemma", "phi"]);
    const first = await kvasir();
    const second = await kvasir(first.dir);
    const card = described({
      id: "card",
      baseUrl: `${rt.url}/v1`,
      locality: "local",
      models: ["qwen"],
    }).config;
    first.k.held.put(card, "test");
    first.k.held.put(
      described({ id: "other", baseUrl: `${rt.url}/v1`, locality: "local", models: ["phi"] }).config,
      "test",
    );
    second.k.held.sync();
    const handed: string[] = [];
    second.k.held.onAdded = (b) =>
      handed.push(`${b.config.id}:${b.config.models.map((m) => m.id).join(",")}`);
    const models = described({ baseUrl: `${rt.url}/v1`, locality: "local", models: ["gemma"] }).config.models;
    first.k.held.replace({ ...card, models }, "test");
    expect(first.k.backends.get("card")?.config.models.map((m) => m.id)).toEqual(["gemma"]);
    // a model another backend serves is not taken
    expect(() => first.k.held.replace({ ...card, models: [{ ...models[0], id: "phi" }] }, "test")).toThrow(
      /phi is served by other already/,
    );
    const { changed } = second.k.held.sync();
    expect(changed.map((b) => b.config.id)).toEqual(["card"]);
    expect(second.k.backends.get("card")?.config.models.map((m) => m.id)).toEqual(["gemma"]);
    expect(handed).toEqual(["card:gemma"]);
    expect(second.k.backends.list.filter((b) => !b.config.builtin).map((b) => b.config.id)).toEqual([
      "card",
      "other",
    ]);
    // nothing changed since, so nothing is handed on again
    expect(second.k.held.sync()).toEqual({ added: [], changed: [], removed: [] });
  });
});

describe("an admin's description of a backend", () => {
  it("is made whole, or refused in words", () => {
    const { config, key, named } = described({
      baseUrl: "http://127.0.0.1:30000/v1/",
      locality: "local",
      models: ["Qwen/Qwen3.8-27B"],
    });
    expect(named).toBe(false);
    expect(key).toBeNull();
    expect(config).toMatchObject({
      id: "qwen-qwen3-8-27b",
      kind: "openai-completions",
      baseUrl: "http://127.0.0.1:30000/v1",
      concurrency: 8,
      warmup: true,
    });
    expect(config.models[0]).toMatchObject({ id: "Qwen/Qwen3.8-27B", contextWindow: 32768, maxTokens: 4096 });
    const whole = { baseUrl: "http://x", locality: "local", models: ["m"] };
    expect(() => described({ ...whole, baseUrl: "x" })).toThrow(/baseUrl/);
    expect(() => described({ ...whole, locality: undefined })).toThrow(/locality/);
    expect(() => described({ ...whole, models: [] })).toThrow(/at least one model/);
    expect(() => described({ ...whole, kind: "gemini" })).toThrow(/kind is one of/);
    expect(() => described({ ...whole, id: "Card One" })).toThrow(/lowercase/);
    expect(() => described({ ...whole, models: [{ id: "m", contextWindow: -1 }] })).toThrow(/whole number/);
    expect(idFrom("gpt-5.4-mini")).toBe("gpt-5-4-mini");
  });

  it("reads a failure's words as the few things a person can act on", () => {
    expect(kindOf("401 Incorrect API key provided")).toBe("key_refused");
    expect(kindOf("The model `x` does not exist")).toBe("no_model");
    expect(kindOf("429 You exceeded your current quota")).toBe("refused_for_now");
    expect(kindOf("Connection error.")).toBe("unreachable");
    expect(kindOf("fetch failed")).toBe("unreachable");
    expect(kindOf("something else")).toBe("other");
  });
});
