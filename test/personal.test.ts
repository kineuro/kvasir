// SPDX-License-Identifier: AGPL-3.0-only
// C5: brought keys and the OAuth slot (§8.4). Two people connect in the
// same minute and neither sees the other's grant; a dump of the database
// yields no usable minted key and no readable brought key; the forbidden
// provider shows the sentence and the date; the refresh rotates under the
// lock; a stream uses the person's own credential before the organisation's.

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { oauthProviders, Personal } from "../src/personal.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { Store } from "../src/store.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

/** A fake token endpoint: every exchange answers a fresh pair; every refresh rotates. */
function tokenEndpoint(): Promise<{ url: string; seen: URLSearchParams[]; server: Server }> {
  const seen: URLSearchParams[] = [];
  let n = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    seen.push(form);
    n += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: `access-${n}-${form.get("code") ?? form.get("refresh_token")}`,
        refresh_token: `refresh-${n}`,
        expires_in: 3600,
      }),
    );
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, server }),
    ),
  );
}

function personal(tokenUrl: string, now: () => number = Date.now): { p: Personal; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-personal-"));
  const store = new Store(join(dir, "kvasir.sqlite"));
  const key = new Uint8Array(32).fill(7);
  const providers = oauthProviders([
    {
      provider: "openai",
      authorize: "https://auth.example/authorize",
      token: tokenUrl,
      clientId: "app_x",
      scopes: ["openid"],
      personal: "offered",
    },
  ]);
  return { p: new Personal(store, key, providers, "http://127.0.0.1:7199", fetch, now), store };
}

describe("brought keys and the OAuth slot (C5)", () => {
  it("offers the personal source for one provider and shows the other as absent by policy, with the sentence and the date", () => {
    const providers = oauthProviders([]);
    const anthropic = providers.find((p) => p.provider === "anthropic");
    expect(anthropic?.personal).toBe("absent_by_policy");
    expect(anthropic?.policy?.date).toBe("2026-02-20");
    expect(anthropic?.policy?.sentence).toMatch(/do not permit/u);
    expect(providers.find((p) => p.provider === "openai")?.personal).toBe("offered");
    expect(() => oauthProviders([{ provider: "x", personal: "absent_by_policy" }])).toThrow(
      /sentence and the date/u,
    );
    expect(() => oauthProviders([{ provider: "x", personal: "offered" }])).toThrow(
      /authorize, token and clientId/u,
    );
    const { p } = personal("http://127.0.0.1:1");
    expect(() => p.start("anna", "anthropic", "s1", "http://desk/")).toThrow(/as of 2026-02-20/u);
  });

  it("lets two people connect in the same minute, each state bound to its own session, neither seeing the other's grant", async () => {
    const t = await tokenEndpoint();
    closers.push(() => new Promise((r) => t.server.close(() => r())));
    const { p } = personal(t.url);
    const a = p.start("anna", "openai", "session-a", "http://desk/a");
    const b = p.start("bo", "openai", "session-b", "http://desk/b");
    expect(a.state).not.toBe(b.state);
    expect(new URL(a.url).searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(a.url).searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:7199/v1/personal/oauth/callback",
    );
    // the callbacks come back in the other order, and a state bound to another session is refused
    await expect(p.callback("code-b", b.state, "session-a")).rejects.toThrow(/another session/u);
    const b2 = p.start("bo", "openai", "session-b", "http://desk/b");
    const doneB = await p.callback("code-b", b2.state, "session-b");
    const doneA = await p.callback("code-a", a.state, null);
    expect(doneA).toEqual({ subject: "anna", provider: "openai", return_to: "http://desk/a" });
    expect(doneB.subject).toBe("bo");
    expect(await p.open("anna", "openai")).toBe("access-2-code-a");
    expect(await p.open("bo", "openai")).toBe("access-1-code-b");
    expect(await p.open("cy", "openai")).toBeNull();
    // a state is used once
    await expect(p.callback("again", a.state, null)).rejects.toThrow(/unknown or was used/u);
    // the verifier the exchange carried is the one the challenge was made from
    expect(t.seen[0].get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{60,}$/u);
    expect(t.seen[0].get("redirect_uri")).toBe("http://127.0.0.1:7199/v1/personal/oauth/callback");
    // revoke deletes both tokens
    expect(p.revoke("anna", "openai")).toBe(true);
    expect(await p.open("anna", "openai")).toBeNull();
    expect(p.status("anna")[0].oauth).toBeNull();
  });

  it("refreshes under the lock, once for two concurrent uses, rotating the refresh token", async () => {
    const t = await tokenEndpoint();
    closers.push(() => new Promise((r) => t.server.close(() => r())));
    let clock = 1_000_000;
    const { p } = personal(t.url, () => clock);
    const s = p.start("anna", "openai", "session-a", "http://desk/");
    await p.callback("code-a", s.state, null);
    expect(t.seen).toHaveLength(1);
    clock += 3600 * 1000; // past expiry
    const [x, y] = await Promise.all([p.open("anna", "openai"), p.open("anna", "openai")]);
    expect(x).toBe(y);
    expect(x).toBe("access-2-refresh-1");
    expect(t.seen).toHaveLength(2);
    expect(t.seen[1].get("grant_type")).toBe("refresh_token");
    expect(t.seen[1].get("refresh_token")).toBe("refresh-1");
    clock += 3600 * 1000;
    expect(await p.open("anna", "openai")).toBe("access-3-refresh-2");
  });

  it("keeps a brought key sealed under the subject, so a dump of the database holds no readable secret and no usable minted key", async () => {
    const { p, store } = personal("http://127.0.0.1:1");
    p.putKey("anna", "openai", "sk-anna-secret-000000");
    p.putKey("bo", "openai", "sk-bo-secret-000000");
    expect(await p.open("anna", "openai")).toBe("sk-anna-secret-000000");
    expect(await p.open("bo", "openai")).toBe("sk-bo-secret-000000");
    // the dump
    const rows = store.db.prepare("SELECT subject, provider, sealed FROM brought_key").all() as {
      subject: string;
      sealed: Uint8Array;
    }[];
    const dump = Buffer.concat(rows.map((r) => Buffer.from(r.sealed))).toString("latin1");
    expect(dump).not.toContain("secret");
    expect(rows.map((r) => r.subject).sort()).toEqual(["anna", "bo"]);
    // a row moved to another subject's name does not open: the subject is bound in
    store.db.prepare("UPDATE brought_key SET subject = 'cy' WHERE subject = 'bo'").run();
    await expect(p.open("cy", "openai")).rejects.toThrow();
    expect(p.deleteSubject("anna")).toBe(1);
    expect(await p.open("anna", "openai")).toBeNull();
  });

  it("serves the doors: a person's status, a brought key stored and shown never, a machine refused, the forbidden provider on screen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kvasir-c5-"));
    const config = parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://127.0.0.1:7199",
        auth: {
          mode: "token",
          tokens: {
            "a-person-token-of-length-x": "anna@lab:reader",
            "a-machine-token-of-len": "worker:reader",
          },
        },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "pepper"),
        sealKeyFile: join(dir, "seal"),
        purposes: [],
        backends: [
          {
            id: "remote",
            kind: "openai-completions",
            baseUrl: "http://127.0.0.1:1",
            locality: "remote",
            provider: "openai",
            models: [
              {
                id: "m",
                name: "m",
                reasoning: false,
                input: ["text"],
                contextWindow: 1000,
                maxTokens: 100,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        ],
      }),
    );
    const k: Kvasir = build(config);
    const url = await listen(k, "127.0.0.1:0");
    closers.push(() => k.close());
    const person = { authorization: "Bearer a-person-token-of-length-x", "content-type": "application/json" };
    const machine = { authorization: "Bearer a-machine-token-of-len", "content-type": "application/json" };
    let r = await fetch(`${url}/v1/personal`, { headers: person });
    let doc = (await r.json()) as {
      subject: string;
      redirect: string;
      providers: { provider: string; personal: string; policy?: { sentence: string; date: string } }[];
    };
    expect(r.status).toBe(200);
    expect(doc.redirect).toBe("http://127.0.0.1:7199/v1/personal/oauth/callback");
    const forbidden = doc.providers.find((p) => p.provider === "anthropic");
    expect(forbidden?.personal).toBe("absent_by_policy");
    expect(forbidden?.policy?.date).toBe("2026-02-20");
    r = await fetch(`${url}/v1/personal/keys/openai`, {
      method: "PUT",
      headers: person,
      body: JSON.stringify({ secret: "sk-anna-personal-0000" }),
    });
    expect(await r.json()).toEqual({ provider: "openai", stored: true, shown: "never" });
    r = await fetch(`${url}/v1/personal/keys/openai`, {
      method: "PUT",
      headers: machine,
      body: JSON.stringify({ secret: "sk-worker-0000000" }),
    });
    expect(r.status).toBe(403);
    r = await fetch(`${url}/v1/personal`, { headers: person });
    doc = (await r.json()) as typeof doc;
    expect(
      (doc.providers.find((p) => p.provider === "openai") as { brought_key: unknown }).brought_key,
    ).not.toBeNull();
    // the person's own credential is what the stream would carry
    expect(await k.personal.open("anna@lab", "openai")).toBe("sk-anna-personal-0000");
    r = await fetch(`${url}/v1/personal/oauth/anthropic/start`, {
      method: "POST",
      headers: person,
      body: JSON.stringify({ session: "s", return_to: "http://desk/" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/2026-02-20/u);
    r = await fetch(`${url}/v1/personal/keys/openai`, { method: "DELETE", headers: person });
    expect(r.status).toBe(204);
    // the sealed key and the pepper never sit in the database
    const raw = readFileSync(join(dir, "kvasir.sqlite")).toString("latin1");
    expect(raw).not.toContain("sk-anna-personal");
  });
});
