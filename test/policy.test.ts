// SPDX-License-Identifier: AGPL-3.0-only
// C3: grants, purposes and policy (§8.3), the organisation's key (§8.4) and
// the identifier-shape rule. A `rows` purpose cannot reach the remote
// backend until an admin acknowledges; an `identifiers` purpose never can; a
// request with an identifier shape runs local whatever the table says.

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { hold } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

/** A fake runtime that records the bearer it saw and answers one token. */
function runtime(): Promise<{ url: string; bearers: string[]; server: Server }> {
  const bearers: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const _ of req) {
      // drain
    }
    bearers.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    res.write(chunk({ role: "assistant", content: "ok" }));
    res.write(chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }));
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bearers, server }),
    ),
  );
}

async function kvasir(localUrl: string, remoteUrl: string): Promise<{ k: Kvasir; url: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-"));
  const model = (id: string) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 4096,
    maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const config = parse(
    JSON.stringify({
      bind: "127.0.0.1:0",
      origin: "http://kvasir.test",
      auth: {
        mode: "token",
        tokens: { "an-admin-token-xxxx": "anna@lab:admin", "a-reader-token-xxxx": "bo@lab:reader" },
      },
      store: join(dir, "kvasir.sqlite"),
      pepperFile: join(dir, "kvasir.pepper"),
      admission: { queue: 8, waitCapSeconds: 60, gate: false },
      sealKeyFile: join(dir, "kvasir.seal"),
      purposes: [
        { id: "assistant.ask-help", app: "nils-assistant", content: "rows", kind: "foreground" },
        { id: "assistant.title", app: "nils-assistant", content: "catalog", kind: "background" },
        { id: "assistant.linkage", app: "nils-assistant", content: "identifiers", kind: "foreground" },
      ],
    }),
  );
  const k = build(config);
  hold(k, [
    {
      id: "card",
      kind: "openai-completions",
      baseUrl: `${localUrl}/v1`,
      key: "runtime-key",
      locality: "local",
      concurrency: 8,
      warmup: false,
      models: [model("local-m")],
    },
    {
      id: "vendor",
      kind: "openai-completions",
      baseUrl: `${remoteUrl}/v1`,
      locality: "remote",
      concurrency: 4,
      models: [model("remote-m")],
    },
  ]);
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url, dir };
}

const admin = { authorization: "Bearer an-admin-token-xxxx", "content-type": "application/json" };
const reader = { authorization: "Bearer a-reader-token-xxxx", "content-type": "application/json" };
const ask = (text: string, model = "local-m") =>
  JSON.stringify({ model, context: { messages: [{ role: "user", content: text, timestamp: 1 }] } });

describe("purposes and the policy table", () => {
  it("opens catalog freely, rows only with an acknowledgement, identifiers never; a shape runs local whatever the table says", async () => {
    const local = await runtime();
    const remote = await runtime();
    closers.push(
      () => local.server.close(),
      () => remote.server.close(),
    );
    const { k, url, dir } = await kvasir(local.url, remote.url);
    // warm both by hand: a grant refuses a warming backend at the health layer
    for (const b of k.backends.list) b.health.warming = false;
    // the organisation's key, stored sealed
    const put = await fetch(`${url}/v1/credentials/vendor`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ secret: "sk-minimax-test-secret-value" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).shown).toBe("never");
    const bytes = readFileSync(join(dir, "kvasir.sqlite"));
    expect(bytes.includes(Buffer.from("sk-minimax-test-secret-value"))).toBe(false);
    expect(k.credentials.open("vendor")).toBe("sk-minimax-test-secret-value");
    // the table, before anything is set: every purpose local by default
    const table = await (await fetch(`${url}/v1/purposes`, { headers: reader })).json();
    expect(table.purposes.map((p: { purpose: string; backend: string }) => [p.purpose, p.backend])).toEqual([
      ["assistant.ask-help", "card"],
      ["assistant.title", "card"],
      ["assistant.linkage", "card"],
    ]);
    // a reader does not set policy
    let r = await fetch(`${url}/v1/purposes/assistant.title/policy`, {
      method: "PUT",
      headers: reader,
      body: JSON.stringify({ backend: "vendor" }),
    });
    expect(r.status).toBe(403);
    // catalog opens to the remote backend by choosing it
    r = await fetch(`${url}/v1/purposes/assistant.title/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "vendor" }),
    });
    expect(r.status).toBe(200);
    // rows: refused without the acknowledgement, with the relaxation named
    r = await fetch(`${url}/v1/purposes/assistant.ask-help/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "vendor" }),
    });
    expect(r.status).toBe(400);
    let why = await r.json();
    expect(why.error.refusals[0].layer).toBe("policy");
    expect(why.error.refusals[0].relaxation).toContain("acknowledgement");
    // a rows purpose cannot reach the remote backend until then
    r = await fetch(`${url}/v1/grants`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ purpose: "assistant.ask-help", pin: "remote-m" }),
    });
    expect(r.status).toBe(403);
    why = await r.json();
    expect(why.error.refusals[0].fact).toContain("mapped to card");
    // with the acknowledgement, recorded under the admin's name
    r = await fetch(`${url}/v1/purposes/assistant.ask-help/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({
        backend: "vendor",
        acknowledgement: "I acknowledge that rows of the archive will leave the site through this backend.",
      }),
    });
    expect(r.status).toBe(200);
    const row = await r.json();
    expect(row.acknowledgedBy).toBe("anna@lab");
    // identifiers: never
    r = await fetch(`${url}/v1/purposes/assistant.linkage/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "vendor", acknowledgement: "whatever" }),
    });
    expect(r.status).toBe(403);
    // a grant for rows now names the remote backend, and says why
    r = await fetch(`${url}/v1/grants`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        purpose: "assistant.ask-help",
        need: { context_tokens: 2000, max_output_tokens: 100 },
      }),
    });
    expect(r.status).toBe(200);
    const g = await r.json();
    expect(g.backend).toBe("vendor");
    expect(g.locality).toBe("remote");
    expect(g.chose_because[0]).toContain("policy table maps");
    expect(g.limits).toEqual({ context_tokens: 4096, max_output_tokens: 256 });
    // a stream under that grant goes to the vendor with the sealed key, decrypted at use
    r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { ...admin, "x-kvasir-grant": g.grant },
      body: ask("count the sessions", "remote-m"),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(remote.bearers.at(-1)).toBe("Bearer sk-minimax-test-secret-value");
    // a request whose text matches an identifier shape runs local whatever the table says, and the ledger says why
    r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { ...admin, "x-kvasir-purpose": "assistant.ask-help" },
      body: ask("find the person born 19850412-1234", "remote-m"),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(local.bearers.length).toBeGreaterThan(0);
    const ledger = await (await fetch(`${url}/v1/ledger`, { headers: admin })).json();
    expect(ledger.rows[0]).toMatchObject({
      backend: "card",
      purpose: "assistant.ask-help",
      outcome: "completed",
    });
    // a grant asked for with such text is bumped and explains itself
    r = await fetch(`${url}/v1/grants`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ purpose: "assistant.ask-help", text: "study 1.2.840.113619.2.55.3.1234" }),
    });
    const bumped = await r.json();
    expect(bumped.content).toBe("identifiers");
    expect(bumped.backend).toBe("card");
    expect(bumped.chose_because[0]).toContain("DICOM unique identifier");
    // the requirement layer names the one relaxation
    r = await fetch(`${url}/v1/grants`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ purpose: "assistant.title", need: { context_tokens: 100000 } }),
    });
    expect(r.status).toBe(409);
    why = await r.json();
    expect(why.error.refusals[0].layer).toBe("requirement");
    expect(why.error.refusals[0].relaxation).toContain("at most 4096");
    // an unknown purpose is a 400: a purpose is an app's, never a caller's
    r = await fetch(`${url}/v1/grants`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ purpose: "caller.invented" }),
    });
    expect(r.status).toBe(400);
    // without a purpose a call reaches only a local backend
    r = await fetch(`${url}/v1/messages`, { method: "POST", headers: admin, body: ask("hello", "remote-m") });
    expect(r.status).toBe(403);
    // the backends door says which provider holds a credential
    const backends = await (await fetch(`${url}/v1/backends`, { headers: reader })).json();
    expect(backends.backends.find((b: { id: string }) => b.id === "vendor").credential).toBe(true);
    // rotation re-encrypts under the same seal key; the old ciphertext is gone
    const before = k.store.db.prepare("SELECT sealed FROM credential WHERE provider = 'vendor'").get() as {
      sealed: Uint8Array;
    };
    k.credentials.put("vendor", "sk-minimax-test-secret-value");
    const after = k.store.db.prepare("SELECT sealed FROM credential WHERE provider = 'vendor'").get() as {
      sealed: Uint8Array;
    };
    expect(Buffer.from(after.sealed).equals(Buffer.from(before.sealed))).toBe(false);
    expect(k.credentials.open("vendor")).toBe("sk-minimax-test-secret-value");
  });

  it("lets a minted key reach a remote backend only through a purpose in its allowlist and within its class", async () => {
    const local = await runtime();
    const remote = await runtime();
    closers.push(
      () => local.server.close(),
      () => remote.server.close(),
    );
    const { k, url } = await kvasir(local.url, remote.url);
    for (const b of k.backends.list) b.health.warming = false;
    await fetch(`${url}/v1/credentials/vendor`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ secret: "sk-minimax-test-secret-value" }),
    });
    await fetch(`${url}/v1/purposes/assistant.title/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "vendor" }),
    });
    const minted = await (
      await fetch(`${url}/v1/keys`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          principal: "the-script",
          purposes: ["assistant.title"],
          max_class: "catalog",
        }),
      })
    ).json();
    const key = { authorization: `Bearer ${minted.key}`, "content-type": "application/json" };
    // its purpose is applied without being named: the title purpose is remote
    let r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: key,
      body: ask("a title", "remote-m"),
    });
    expect(r.status).toBe(200);
    await r.text();
    // a purpose outside its allowlist
    r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { ...key, "x-kvasir-purpose": "assistant.ask-help" },
      body: ask("rows", "local-m"),
    });
    expect(r.status).toBe(403);
    // a class above its own, even locally
    const rows = await (
      await fetch(`${url}/v1/keys`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          principal: "the-script",
          purposes: ["assistant.ask-help"],
          max_class: "catalog",
        }),
      })
    ).json();
    r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${rows.key}`, "content-type": "application/json" },
      body: ask("rows", "local-m"),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain("class is catalog");
  });
});

describe("the OpenAI-shaped door", () => {
  it("keeps the purpose, the policy, the queue and the ledger of the messages door", async () => {
    const local = await runtime();
    const remote = await runtime();
    closers.push(
      () => local.server.close(),
      () => remote.server.close(),
    );
    const { k, url } = await kvasir(local.url, remote.url);
    for (const b of k.backends.list) b.health.warming = false;
    await fetch(`${url}/v1/credentials/vendor`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ secret: "sk-minimax-test-secret-value" }),
    });
    const chat = (model: string, content: string, extra: Record<string, string> = {}) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { ...admin, ...extra },
        body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
      });
    // without a purpose a remote model is refused, and nothing reaches the vendor
    let r = await chat("remote-m", "count the sessions");
    expect(r.status).toBe(403);
    expect((await r.json()).error.layer).toBe("policy");
    expect(remote.bearers).toEqual([]);
    // a local model needs no purpose
    r = await chat("local-m", "count the sessions");
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe("ok");
    // once the table maps a catalogue purpose to the vendor, that purpose reaches it
    r = await fetch(`${url}/v1/purposes/assistant.title/policy`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ backend: "vendor" }),
    });
    expect(r.status).toBe(200);
    r = await chat("remote-m", "name this conversation", { "x-kvasir-purpose": "assistant.title" });
    expect(r.status).toBe(200);
    expect((await r.json()).model).toBe("remote-m");
    expect(remote.bearers).toEqual(["Bearer sk-minimax-test-secret-value"]);
    // an identifier shape keeps even that purpose local
    r = await chat("remote-m", "find the person born 19850412-1234", {
      "x-kvasir-purpose": "assistant.title",
    });
    expect(r.status).toBe(200);
    expect((await r.json()).model).toBe("local-m");
    expect(remote.bearers).toHaveLength(1);
    // every call is a ledger row, the refusal too
    const ledger = await (await fetch(`${url}/v1/ledger`, { headers: admin })).json();
    expect(ledger.rows.map((row: { outcome: string }) => row.outcome)).toEqual([
      "completed",
      "completed",
      "completed",
      "refused",
    ]);
  });
});
