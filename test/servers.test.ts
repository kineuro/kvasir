// SPDX-License-Identifier: AGPL-3.0-only
// A model server as a backend (record 47, K4) against a fake server whose
// /v1/models lists two models with their specs, one loaded and one cold, in
// modelgate's shape: its offer read with a key sealed once and named after,
// one model ticked and admitted with today's suite, a second added to the same
// backend, a station mapped to a backend and a model, one model let go, and a
// wrong key refused. The key is never shown back.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { modelList, modelObject, type ServedModel } from "../src/served.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { offeredBy } from "../src/servers.js";
import { fakeRuntime, serve } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const KEY = "the-server-key";

/** The group's model server as a fake: two models with specs, the 27B loaded, Flash-Next cold; it wants its key. */
async function modelServer() {
  // what answers the requests: a runtime that passes the admission suite
  const rt = await fakeRuntime(true);
  closers.push(() => rt.server.close());
  const asked: string[] = [];
  const s = await serve(async (req, res, text) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "missing or wrong API key", type: "authentication_error" } }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "qwen3.8-flash-next",
              object: "model",
              aliases: ["flash-next"],
              default: true,
              status: "cold",
              context_length: 262_144,
              max_output_tokens: 65_536,
              max_concurrent_requests: 4,
              capabilities: { tools: true, reasoning: true, vision: true },
              license: "Qwen Community License 1.0",
              swap_in_seconds: 1,
            },
            {
              id: "qwen38-27b",
              object: "model",
              aliases: ["qwen38-27b-fast"],
              default: false,
              status: "loaded",
              context_length: 262_144,
              max_output_tokens: 65_536,
              max_concurrent_requests: 8,
              capabilities: { tools: true, reasoning: true, vision: false },
              license: "Apache-2.0",
            },
          ],
          server: { state: "ready", loaded: "qwen38-27b", last_swap_seconds: 115, note: "one card" },
        }),
      );
      return;
    }
    if (req.method === "POST") asked.push(String(JSON.parse(text || "{}").model));
    const r = await fetch(`${rt.url}${req.url}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "POST" ? text : undefined,
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  closers.push(() => s.server.close());
  return { url: `${s.url}/v1`, asked };
}

async function kvasir(): Promise<{ k: Kvasir; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-servers-"));
  const k = build(
    parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: {
          mode: "token",
          tokens: { "an-admin-token": "anna@lab:kvasir:work", "a-reader-token": "bo@lab:kvasir:see" },
        },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: true },
        purposes: [{ id: "assistant.title", app: "nils-assistant", content: "catalog", kind: "background" }],
      }),
    ),
  );
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

const admin = { authorization: "Bearer an-admin-token", "content-type": "application/json" };
const reader = { authorization: "Bearer a-reader-token", "content-type": "application/json" };

describe("a model server as a backend", () => {
  it("lists a server's models with specs, and admits the one ticked on one backend", async () => {
    const server = await modelServer();
    const { k, url } = await kvasir();
    // the key goes to Kvasir once, sealed under a name of the desk's choosing, and is named after (R4)
    const sealed = await fetch(`${url}/v1/credentials/server-staging:adding-1`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ secret: KEY }),
    });
    expect(sealed.status).toBe(200);
    expect(JSON.stringify(await sealed.json())).not.toContain(KEY);
    const query = `url=${encodeURIComponent(server.url)}&key_ref=server-staging:adding-1`;
    // listing a server needs kvasir:work
    expect((await fetch(`${url}/v1/servers/models?${query}`, { headers: reader })).status).toBe(403);
    const offer = await (await fetch(`${url}/v1/servers/models?${query}`, { headers: admin })).json();
    expect(offer.url).toBe(server.url);
    expect(offer.server).toMatchObject({ loaded: "qwen38-27b" });
    expect(offer.models).toEqual([
      expect.objectContaining({
        id: "qwen3.8-flash-next",
        aliases: ["flash-next"],
        status: "cold",
        default: true,
        context_length: 262_144,
        max_output_tokens: 65_536,
        max_concurrent_requests: 4,
        reasoning: true,
        tools: true,
        vision: true,
        swap_in_seconds: 1,
        held_by: null,
      }),
      expect.objectContaining({
        id: "qwen38-27b",
        status: "loaded",
        vision: false,
        max_concurrent_requests: 8,
        held_by: null,
      }),
    ]);
    expect(JSON.stringify(offer)).not.toContain(KEY);
    // nothing was kept by listing, and nothing asked to answer
    expect(k.held.rows()).toEqual([]);
    expect(server.asked).toEqual([]);

    // the 27B ticked: asked one short question, held, and put through the admission suite
    const added = await fetch(`${url}/v1/servers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ url: server.url, key_ref: "server-staging:adding-1", models: ["qwen38-27b"] }),
    });
    expect(added.status).toBe(201);
    const done = await added.json();
    expect(done.backend).toEqual({ id: "127-0-0-1", models: ["qwen38-27b"] });
    expect(done.results).toEqual([
      expect.objectContaining({ id: "qwen38-27b", answered: true, admitted: true, error: null }),
    ]);
    // only the ticked model was asked; the cold one was never loaded on the server
    expect(new Set(server.asked)).toEqual(new Set(["qwen38-27b"]));
    // the key is sealed under the backend, once, and the staged name is gone
    expect(k.credentials.has("127-0-0-1")).toBe(true);
    expect(k.credentials.has("server-staging:adding-1")).toBe(false);
    const backends = await (await fetch(`${url}/v1/backends`, { headers: admin })).json();
    const held = backends.backends.find((b: { id: string }) => b.id === "127-0-0-1");
    expect(held).toMatchObject({
      server: true,
      locality: "local",
      credential: true,
      concurrency: 8,
      models: ["qwen38-27b"],
      health: { warming: false },
    });
    expect(held.entries[0]).toMatchObject({
      id: "qwen38-27b",
      context_window: 262_144,
      max_tokens: 65_536,
      admitted: true,
      aliases: ["qwen38-27b-fast"],
      status: "loaded",
    });
    // the list a client of this Kvasir reads carries the server's specs
    const listed = modelList(k.served);
    expect(listed.data).toEqual([
      expect.objectContaining({
        id: "qwen38-27b",
        aliases: ["qwen38-27b-fast"],
        status: "loaded",
        context_length: 262_144,
        max_concurrent_requests: 8,
        license: "Apache-2.0",
        backend: "127-0-0-1",
      }),
    ]);
    expect(JSON.stringify(k.held.rows())).not.toContain(KEY);
  });

  it("adds a second model to the same backend, maps a station to it, and lets it go again", async () => {
    const server = await modelServer();
    const { k, url } = await kvasir();
    const first = await k.servers.admit(
      { url: server.url, key: KEY, models: ["qwen38-27b"], id: "card0" },
      "test",
    );
    expect(first.backend).toEqual({ id: "card0", models: ["qwen38-27b"] });
    // the backend's own sealed key is the reference for the next tick; the cold model loads on the server
    const lines: string[] = [];
    const second = await k.servers.admit(
      { url: server.url, key_ref: "card0", models: ["flash-next"] },
      "test",
      (line) => lines.push(line),
    );
    expect(second.backend).toEqual({ id: "card0", models: ["qwen38-27b", "qwen3.8-flash-next"] });
    expect(second.results[0]).toMatchObject({ id: "qwen3.8-flash-next", answered: true, admitted: true });
    expect(lines.join("\n")).toMatch(/cold on the server/u);
    expect(k.credentials.has("card0")).toBe(true);
    // a station maps to a backend and a model
    const set = await fetch(`${url}/v1/purposes/assistant.title/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "card0", model: "flash-next" }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ backend: "card0", model: "qwen3.8-flash-next" });
    const g = k.policy.grant("assistant.title", {}, { pin: "qwen38-27b" });
    expect(g.model).toBe("qwen3.8-flash-next");
    expect(g.chose_because.join(" ")).toMatch(/policy table sends assistant.title to qwen3.8-flash-next/u);
    const table = await (await fetch(`${url}/v1/purposes`, { headers: admin })).json();
    expect(table.purposes[0]).toMatchObject({ backend: "card0", model: "qwen3.8-flash-next" });
    // a model not on the backend is refused
    const wrong = await fetch(`${url}/v1/purposes/assistant.title/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "card0", model: "gpt-4o" }),
    });
    expect(wrong.status).toBe(404);
    // one model let go: the backend keeps the other, and the station goes to it
    const gone = await fetch(`${url}/v1/backends/card0/models/qwen3.8-flash-next`, {
      method: "DELETE",
      headers: admin,
    });
    expect(gone.status).toBe(204);
    expect(k.backends.get("card0")?.config.models.map((m) => m.id)).toEqual(["qwen38-27b"]);
    expect(k.policy.row("assistant.title")).toMatchObject({ backend: "card0", model: null });
    expect(k.policy.grant("assistant.title", {}, {}).model).toBe("qwen38-27b");
    // the last model lets the backend go, with its key
    expect(
      (await fetch(`${url}/v1/backends/card0/models/qwen38-27b`, { method: "DELETE", headers: admin }))
        .status,
    ).toBe(204);
    expect(k.backends.get("card0")).toBeUndefined();
    expect(k.credentials.has("card0")).toBe(false);
  });

  it("refuses a wrong key, and a model the server does not offer", async () => {
    const server = await modelServer();
    const { url } = await kvasir();
    const wrong = await fetch(`${url}/v1/servers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ url: server.url, key: "not-the-key", models: ["qwen38-27b"] }),
    });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.message).toMatch(/the key was refused/u);
    const none = await fetch(`${url}/v1/servers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ url: server.url, key: KEY, models: ["gpt-4o"] }),
    });
    expect(none.status).toBe(404);
    const unsealed = await fetch(
      `${url}/v1/servers/models?url=${encodeURIComponent(server.url)}&key_ref=server-staging:nothing-sealed`,
      { headers: admin },
    );
    expect(unsealed.status).toBe(404);
  });
});

describe("what a model server's key and list may reach", () => {
  it("opens only a staged key or the server's own, and lets go only a staged one", async () => {
    const server = await modelServer();
    const { k, url } = await kvasir();
    // another credential Kvasir holds, which no model server's address may be sent
    k.credentials.put("openai", KEY);
    const listing = await fetch(
      `${url}/v1/servers/models?url=${encodeURIComponent(server.url)}&key_ref=openai`,
      { headers: admin },
    );
    expect(listing.status).toBe(400);
    expect((await listing.json()).error.message).toMatch(/server-staging:/u);
    const adding = await fetch(`${url}/v1/servers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ url: server.url, key_ref: "openai", models: ["qwen38-27b"], id: "card0" }),
    });
    expect(adding.status).toBe(400);
    expect(k.credentials.has("openai")).toBe(true);
    expect(server.asked).toEqual([]);
    // a backend that is not a model server is not a key for one either
    await expect(k.servers.offered({ url: server.url, key_ref: "chatgpt" })).rejects.toThrow(
      /server-staging:/u,
    );
    // the server's own backend is: its key stays where it is sealed
    await k.servers.admit({ url: server.url, key: KEY, models: ["qwen38-27b"], id: "card0" }, "test");
    // but not for another address: the key of one server never goes to another
    const other = await modelServer();
    await expect(k.servers.offered({ url: other.url, key_ref: "card0" })).rejects.toThrow(/own backend/u);
    expect(other.asked).toEqual([]);
    await k.servers.admit({ url: server.url, key_ref: "card0", models: ["flash-next"] }, "test");
    expect(k.credentials.has("card0")).toBe(true);
    expect(k.credentials.has("openai")).toBe(true);
  });

  it("reads at most 1 MiB and 256 models of a server's list, and only what it can use of each", async () => {
    let body = "";
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    closers.push(() => s.server.close());
    const base = `${s.url}/v1`;
    body = JSON.stringify({ data: [{ id: "m", padding: "x".repeat(1_100_000) }] });
    await expect(offeredBy(base, null)).rejects.toThrow(/more than 1 MiB/u);
    body = JSON.stringify({ data: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}` })) });
    await expect(offeredBy(base, null)).rejects.toThrow(/more than 256 models/u);
    body = JSON.stringify({
      data: [
        { id: 7 },
        { id: "x".repeat(300) },
        {
          id: "good",
          aliases: ["g", 3, { a: 1 }],
          status: "sleeping",
          context_length: "lots",
          capabilities: "all of them",
          license: "Apache-2.0",
          evil: "<script>alert(1)</script>",
          measured: { tok_s: 27, deep: { deeper: true } },
        },
      ],
      server: { state: "ready", loaded: "good", secret: "the-servers-own" },
    });
    const offer = await offeredBy(base, null);
    expect(offer.models.map((m) => m.id)).toEqual(["good"]);
    expect(offer.models[0]).toMatchObject({
      aliases: ["g"],
      status: "unknown",
      context_length: null,
      tools: false,
      spec: { license: "Apache-2.0", measured: { tok_s: 27 } },
    });
    expect(offer.models[0].spec).not.toHaveProperty("evil");
    expect(offer.server).toEqual({ state: "ready", loaded: "good" });
  });

  it("lists only the spec fields it knows, whatever a model's spec holds", () => {
    const m: ServedModel = {
      id: "m",
      aliases: [],
      upstream: "m",
      backend: "b",
      card: null,
      default: true,
      status: "loaded",
      contextLength: 8192,
      maxOutputTokens: 1024,
      concurrency: 1,
      reasoning: false,
      tools: true,
      vision: false,
      protocols: [],
      anthropicThinking: "disabled",
      local: true,
      spec: {
        license: "MIT",
        evil: "<script>",
        runtime: { nested: "object" },
        apis: ["openai /v1/chat/completions"],
      },
    };
    const listed = modelObject(m);
    expect(listed).toMatchObject({ license: "MIT", apis: ["openai /v1/chat/completions"] });
    expect(listed).not.toHaveProperty("evil");
    expect(listed).not.toHaveProperty("runtime");
  });
});
