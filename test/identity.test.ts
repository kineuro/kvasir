// SPDX-License-Identifier: AGPL-3.0-only
// C2: identity against the suite's own vectors, minted keys, admission
// control and the ledger (Wave 4c §8.4, §8.7, §8.8).

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { SCHEMA } from "../src/store.js";

const vectors = join(import.meta.dirname, "vectors");
const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

function serveJson(doc: unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(doc));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server }),
    ),
  );
}

/** A backend that holds every stream open until `open()` is called, then answers one token. */
function gate(): { url: Promise<string>; open: () => void; seen: () => number; server: Promise<Server> } {
  let release: () => void = () => {};
  const opened = new Promise<void>((r) => {
    release = r;
  });
  let seen = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) {
      // drain
    }
    seen += 1;
    await opened;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const url = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
    ),
  );
  return { url, open: () => release(), seen: () => seen, server: url.then(() => server) };
}

async function kvasir(
  auth: unknown,
  backendUrl: string,
  over: Record<string, unknown> = {},
): Promise<{ k: Kvasir; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-"));
  const config = parse(
    JSON.stringify({
      bind: "127.0.0.1:0",
      origin: "http://kvasir.test",
      auth,
      store: join(dir, "kvasir.sqlite"),
      pepperFile: join(dir, "kvasir.pepper"),
      admission: { queue: 8, waitCapSeconds: 60, gate: false },
      backends: [
        {
          id: "card",
          kind: "openai-completions",
          baseUrl: `${backendUrl}/v1`,
          key: "runtime-key",
          locality: "local",
          concurrency: 8,
          warmup: false,
          models: [
            {
              id: "m",
              name: "M",
              reasoning: false,
              input: ["text"],
              contextWindow: 4096,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
        {
          id: "vendor",
          kind: "openai-completions",
          baseUrl: `${backendUrl}/v1`,
          key: "vendor-key",
          locality: "remote",
          concurrency: 4,
          warmup: false,
          models: [
            {
              id: "remote-m",
              name: "R",
              reasoning: false,
              input: ["text"],
              contextWindow: 4096,
              maxTokens: 256,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      ],
      ...over,
    }),
  );
  const k = build(config);
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

describe("identity", () => {
  it("passes the suite's trust list vectors, the same file the engine runs", async () => {
    const t = JSON.parse(readFileSync(join(vectors, "trust-list.json"), "utf8"));
    const jwks1 = await serveJson(JSON.parse(readFileSync(join(vectors, t.trust[0].jwks), "utf8")));
    closers.push(() => jwks1.server.close());
    const auth = {
      mode: "oidc",
      trust: [
        { issuer: t.trust[0].issuer, audience: t.trust[0].audience, jwks: `${jwks1.url}/jwks` },
        { issuer: t.trust[1].issuer, audience: t.trust[1].audience, jwks: join(vectors, t.trust[1].jwks) },
      ],
      groupsClaim: t.groups_claim,
      roles: t.roles,
    };
    const g = gate();
    g.open();
    const { url } = await kvasir(auth, await g.url);
    closers.push(async () => (await g.server).close());
    const keys: Record<string, CryptoKey> = {};
    for (const [kid, pem] of Object.entries(t.keys as Record<string, string>)) {
      keys[kid] = await importPKCS8(readFileSync(join(vectors, pem), "utf8"), "RS256");
    }
    for (const c of t.cases) {
      const now = Math.floor(Date.now() / 1000);
      const expired = c.expired === true;
      const token = await new SignJWT({ ...c.claims })
        .setProtectedHeader({ alg: "RS256", kid: c.key })
        .setIssuedAt(expired ? now - 1200 : now)
        .setExpirationTime(expired ? now - 600 : now + 600)
        .sign(keys[c.key]);
      const r = await fetch(`${url}/v1/config`, { headers: { authorization: `Bearer ${token}` } });
      if (c.expect.admitted) {
        expect(r.status, c.name).toBe(200);
        const ledger = await (
          await fetch(`${url}/v1/ledger`, { headers: { authorization: `Bearer ${token}` } })
        ).json();
        expect(Array.isArray(ledger.rows), c.name).toBe(true);
      } else {
        expect(r.status, c.name).toBe(c.expect.status ?? 401);
      }
    }
  });

  it("refuses a stream with no principal, and a token whose groups map to no role", async () => {
    const g = gate();
    g.open();
    const { url } = await kvasir(
      {
        mode: "token",
        tokens: { "a-token-of-a-nobody": "cy@lab:", "an-operator-token-x": "ops@lab:operator" },
      },
      await g.url,
    );
    closers.push(async () => (await g.server).close());
    const body = JSON.stringify({
      model: "m",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    });
    const none = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(none.status).toBe(401);
    const nobody = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer a-token-of-a-nobody" },
      body,
    });
    expect(nobody.status).toBe(403);
    const ops = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer an-operator-token-x" },
      body,
    });
    expect(ops.status).toBe(200);
    await ops.text();
  });
});

describe("minted keys", () => {
  it("are shown once, verified in constant time, revoked by a deleted row, and reach only local backends without a purpose", async () => {
    const g = gate();
    g.open();
    const { k, url } = await kvasir(
      {
        mode: "token",
        tokens: { "an-admin-token-xxxx": "anna@lab:admin", "a-reader-token-xxxx": "bo@lab:reader" },
      },
      await g.url,
    );
    closers.push(async () => (await g.server).close());
    const admin = { authorization: "Bearer an-admin-token-xxxx", "content-type": "application/json" };
    const refused = await fetch(`${url}/v1/keys`, {
      method: "POST",
      headers: { authorization: "Bearer a-reader-token-xxxx", "content-type": "application/json" },
      body: JSON.stringify({ principal: "script" }),
    });
    expect(refused.status).toBe(403);
    const minted = await (
      await fetch(`${url}/v1/keys`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ principal: "the-script", purposes: [], max_class: "catalog" }),
      })
    ).json();
    expect(minted.key.startsWith("kvs_")).toBe(true);
    expect(minted.shown).toBe("once");
    // the stored form is a keyed hash, never the key
    const rows = k.store.db.prepare("SELECT hash FROM key").all() as { hash: string }[];
    expect(rows[0].hash).not.toContain(minted.key.split(".")[1]);
    expect(rows[0].hash).toHaveLength(64);
    // the key streams locally
    const body = (model: string) =>
      JSON.stringify({ model, context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] } });
    const local = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.key}`, "content-type": "application/json" },
      body: body("m"),
    });
    expect(local.status).toBe(200);
    await local.text();
    // and never remotely without a purpose
    const remote = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.key}`, "content-type": "application/json" },
      body: body("remote-m"),
    });
    expect(remote.status).toBe(403);
    const why = await remote.json();
    expect(why.error.layer).toBe("policy");
    // a wrong secret with the right id
    const wrong = `${minted.key.slice(0, -4)}AAAA`;
    const bad = await fetch(`${url}/v1/config`, { headers: { authorization: `Bearer ${wrong}` } });
    expect(bad.status).toBe(401);
    // revoked: gone
    const gone = await fetch(`${url}/v1/keys/${minted.id}`, { method: "DELETE", headers: admin });
    expect(gone.status).toBe(204);
    expect(k.store.db.prepare("SELECT COUNT(*) AS n FROM key").get()).toMatchObject({ n: 0 });
    const after = await fetch(`${url}/v1/config`, { headers: { authorization: `Bearer ${minted.key}` } });
    expect(after.status).toBe(401);
  });
});

describe("the ledger and admission", () => {
  it("has no content column, counts every stream, and labels metrics with no subject", async () => {
    const g = gate();
    g.open();
    const { k, url } = await kvasir(
      { mode: "token", tokens: { "an-admin-token-xxxx": "anna@lab:admin" } },
      await g.url,
    );
    closers.push(async () => (await g.server).close());
    // the column names, never the SQL's own type words
    for (const sql of SCHEMA) {
      const names = [...sql.matchAll(/^\s{5}(\w+) /gmu)].map((m) => m[1]);
      for (const n of names) expect(n).not.toMatch(/content|prompt|message|body|text|name/);
    }
    const columns = k.store.columns("ledger");
    expect(columns).toEqual(
      expect.arrayContaining([
        "subject",
        "purpose",
        "model",
        "backend",
        "grant_id",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "reasoning_tokens",
        "gpu_seconds",
        "money",
        "ttft_ms",
        "total_ms",
        "outcome",
        "refusal_layer",
        "refusal_fact",
      ]),
    );
    for (const c of columns) expect(c).not.toMatch(/content|prompt|message|body|text|name/);
    const headers = { authorization: "Bearer an-admin-token-xxxx", "content-type": "application/json" };
    const r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "m",
        context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      }),
    });
    await r.text();
    const ledger = await (await fetch(`${url}/v1/ledger`, { headers })).json();
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      subject: "anna@lab",
      model: "m",
      backend: "card",
      outcome: "completed",
      input_tokens: 3,
      output_tokens: 1,
    });
    expect(ledger.rows[0].ttft_ms).toBeGreaterThanOrEqual(0);
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain('kvasir_streams_total{backend="card",model="m",outcome="completed"} 1');
    expect(metrics).toContain("kvasir_ttft_seconds_count 1");
    expect(metrics).not.toContain("anna");
  });

  it("admits eight, queues the ninth with a heartbeat, and refuses the seventeenth at the health layer", async () => {
    const g = gate();
    const { url } = await kvasir(
      { mode: "token", tokens: { "an-admin-token-xxxx": "anna@lab:admin" } },
      await g.url,
    );
    closers.push(async () => (await g.server).close());
    const headers = { authorization: "Bearer an-admin-token-xxxx", "content-type": "application/json" };
    const body = JSON.stringify({
      model: "m",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    });
    const started: Promise<Response>[] = [];
    for (let i = 0; i < 16; i++) {
      started.push(fetch(`${url}/v1/messages`, { method: "POST", headers, body }));
      await new Promise((r) => setTimeout(r, 20));
    }
    // eight reached the backend, eight wait behind them
    await new Promise((r) => setTimeout(r, 200));
    expect(g.seen()).toBe(8);
    const health = await (await fetch(`${url}/healthz`)).json();
    expect(health.backends[0].running).toBe(8);
    expect(health.backends[0].queued).toBe(8);
    // the seventeenth is refused at once, at the health layer, in the stream's own words
    const seventeenth = await fetch(`${url}/v1/messages`, { method: "POST", headers, body });
    const text = await seventeenth.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain("refused at the health layer");
    // the queue lets the others through once the backend answers
    g.open();
    const texts = await Promise.all(started.map(async (p) => (await p).text()));
    for (const t of texts) expect(t).toContain('"type":"done"');
    const ledger = await (await fetch(`${url}/v1/ledger?limit=100`, { headers })).json();
    const outcomes = (ledger.rows as { outcome: string }[]).map((r) => r.outcome).sort();
    expect(outcomes.filter((o) => o === "completed")).toHaveLength(16);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(1);
    expect(
      (ledger.rows as { refusal_layer: string | null }[]).find((r) => r.refusal_layer)?.refusal_layer,
    ).toBe("health");
  }, 20_000);
});
