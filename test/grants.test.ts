// SPDX-License-Identifier: AGPL-3.0-only
// Grants (record 25): the suite's grants vectors run through Kvasir's own
// identity; the doors of kvasir:work; what a backend and the ledger show to
// whom; a principal the desk already qualified, kept only by a trust entry
// that keeps subjects; and an install's mapping to the ladder's names, which
// keeps working.

import { mkdtempSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { Auth, type AuthConfig, EVERYTHING, Refused, SETS, type Trust } from "../src/auth.js";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { chunk, hold, serve, sse } from "./fake.js";

const vectors = join(import.meta.dirname, "vectors");
const suite = JSON.parse(readFileSync(join(vectors, "grants.json"), "utf8"));
const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const ISSUER = "https://desk.example.org/";
const AUDIENCE = "kvasir";

/** A token signed with the suite's test key, of the test issuer unless the claims name another. */
async function signed(claims: Record<string, unknown>): Promise<string> {
  const key = await importPKCS8(readFileSync(join(vectors, "signing-key.pem"), "utf8"), "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ISSUER, aud: AUDIENCE, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-2026" })
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(key);
}

/** Identity that trusts one issuer with the suite's test keys, its groups bound as the vectors bind them. */
function trusting(issuer: string, over: Partial<AuthConfig> = {}, entry: Partial<Trust> = {}): AuthConfig {
  return {
    mode: "oidc",
    trust: [{ issuer, audience: AUDIENCE, jwks: join(vectors, "jwks.json"), ...entry }],
    groupsClaim: suite.groups_claim,
    roles: suite.roles,
    ...over,
  };
}

/** A request as identity reads it: its bearer alone. */
const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;

/** What a caller resolves to, in the vectors' own words. */
async function resolved(auth: Auth, token: string): Promise<unknown> {
  try {
    const p = await auth.principal(request(token));
    return { grants: p.grants, detail: p.detail };
  } catch (e) {
    if (e instanceof Refused && e.status === 403) return { refused: true };
    throw e;
  }
}

describe("the grants vectors", () => {
  it("name the sets Kvasir holds, and everything off mode holds", async () => {
    for (const [name, set] of Object.entries(suite.sets))
      expect(SETS[name as keyof typeof SETS], name).toEqual(set);
    expect(EVERYTHING).toEqual(suite.everything);
    const off = await new Auth({ mode: "off" }, null).principal(request(""));
    expect({ grants: off.grants, detail: off.detail }).toEqual(suite.everything);
  });

  it("resolve a trusted token's grants, detail and groups", async () => {
    const auth = new Auth(trusting(ISSUER), null);
    for (const c of suite.claims) {
      expect(await resolved(auth, await signed({ sub: "anna", ...c.claims })), c.name).toEqual(c.expect);
    }
  });

  it("resolve a named token's role list", async () => {
    for (const c of suite.named) {
      const auth = new Auth({ mode: "token", tokens: { "a-named-token": `anna@lab:${c.roles}` } }, null);
      expect(await resolved(auth, "a-named-token"), c.name).toEqual(c.expect);
    }
    // a token written with no role list at all holds nothing either
    const bare = new Auth({ mode: "token", tokens: { "a-bare-token": "anna@lab" } }, null);
    expect(await resolved(bare, "a-bare-token")).toEqual({ refused: true });
  });

  it("name the principal a subject gives, as its trust entry keeps subjects or not", async () => {
    for (const c of suite.principals) {
      const auth = new Auth(trusting(c.iss, {}, { keepSubject: c.keep_subject }), null);
      const token = await signed({ iss: c.iss, sub: c.sub, grants: ["query:see"] });
      expect((await auth.principal(request(token))).subject, c.name).toBe(c.expect);
    }
  });
});

/** A local model server that answers every stream with a word. */
async function runtime() {
  const rt = await serve((req, res) => {
    if (req.url === "/get_server_info") {
      res.writeHead(404);
      res.end();
      return;
    }
    sse(res, [
      chunk({ role: "assistant", content: "ready" }),
      chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      "[DONE]",
    ]);
  });
  closers.push(() => rt.server.close());
  return rt;
}

async function kvasir(auth: unknown): Promise<{ k: Kvasir; url: string }> {
  const rt = await runtime();
  const dir = mkdtempSync(join(tmpdir(), "kvasir-grants-"));
  const k = build(
    parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth,
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: false },
        purposes: [{ id: "assistant.title", app: "nils-assistant", content: "catalog", kind: "background" }],
      }),
    ),
  );
  hold(k, [
    { id: "card", baseUrl: `${rt.url}/v1`, locality: "local", warmup: false, models: [{ id: "qwen" }] },
  ]);
  for (const b of k.backends.list) b.health.warming = false;
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

// biome-ignore lint/suspicious/noExplicitAny: a door's answer, read as the test reads it
async function call(url: string, method: string, path: string, token: string, body?: unknown): Promise<any> {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: as(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

/** One stream to the local model, read to its end. */
async function streamed(url: string, token: string): Promise<number> {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: as(token),
    body: JSON.stringify({
      model: "qwen",
      context: { messages: [{ role: "user", content: "a title", timestamp: 1 }] },
    }),
  });
  await r.text();
  return r.status;
}

const TOKENS = {
  "a-work-token": "anna@lab:kvasir:work",
  "a-see-token": "bo@lab:kvasir:see",
  "a-query-token": "cy@lab:query:work",
  "a-nobody-token": "dee@lab:",
  "an-unknown-token": "ed@lab:coffee:work,admins",
};

describe("kvasir:work", () => {
  it("opens every door that changes Kvasir, and neither kvasir:see nor another grant opens one", async () => {
    const { url } = await kvasir({ mode: "token", tokens: TOKENS });
    const server = { baseUrl: "http://127.0.0.1:9/v1", locality: "local", models: ["m"] };
    const doors: [string, string, unknown?][] = [
      ["GET", "/v1/keys"],
      ["POST", "/v1/keys", { principal: "a-script" }],
      ["DELETE", "/v1/keys/k_none"],
      ["PUT", "/v1/purposes/assistant.title/policy", { backend: "card" }],
      ["POST", "/v1/backends/test", server],
      ["POST", "/v1/backends", server],
      ["DELETE", "/v1/backends/card"],
      ["PUT", "/v1/credentials/card", { secret: "a-provider-secret" }],
      ["DELETE", "/v1/credentials/card"],
      ["POST", "/v1/admission/run", { backend: "card" }],
      ["POST", "/v1/models/lifecycle", { model: "qwen", backend: "card" }],
      ["POST", "/v1/models/lifecycle/1/retire"],
      ["GET", "/v1/local"],
      ["PUT", "/v1/local/location", { path: join(tmpdir(), "kvasir-grants-location") }],
      ["PUT", "/v1/local/token", { token: "hf_brought-by-someone" }],
    ];
    for (const token of ["a-see-token", "a-query-token"]) {
      for (const [method, path, body] of doors) {
        const r = await call(url, method, path, token, body);
        expect([r.status, r.body.error.code, r.body.error.needs], `${token} ${method} ${path}`).toEqual([
          403,
          "no_grant",
          ["kvasir:work"],
        ]);
      }
    }
    // a refusal changed nothing
    const held = await call(url, "GET", "/v1/backends", "a-work-token");
    expect(held.body.backends.map((b: { id: string }) => b.id)).toContain("card");
    // and the doors open for kvasir:work
    expect((await call(url, "GET", "/v1/keys", "a-work-token")).status).toBe(200);
    expect((await call(url, "DELETE", "/v1/keys/k_none", "a-work-token")).status).toBe(404);
    const policy = await call(url, "PUT", "/v1/purposes/assistant.title/policy", "a-work-token", {
      backend: "card",
    });
    expect(policy.status).toBe(200);
    expect((await call(url, "DELETE", "/v1/credentials/card", "a-work-token")).status).toBe(404);
    const candidate = await call(url, "POST", "/v1/models/lifecycle", "a-work-token", {
      model: "qwen",
      backend: "card",
    });
    expect(candidate.status).toBe(201);
    expect((await call(url, "GET", "/v1/local", "a-work-token")).status).toBe(200);
  });

  it("shows a backend's address and who added it, and every ledger row, only to kvasir:work; anyone with a grant reads the rest", async () => {
    const { url } = await kvasir({ mode: "token", tokens: TOKENS });
    expect(await streamed(url, "a-see-token")).toBe(200);
    expect(await streamed(url, "a-query-token")).toBe(200);
    const card = async (token: string) =>
      (await call(url, "GET", "/v1/backends", token)).body.backends.find(
        (b: { id: string }) => b.id === "card",
      );
    expect(await card("a-work-token")).toMatchObject({
      base_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u),
      added_by: "test",
    });
    for (const token of ["a-see-token", "a-query-token"]) {
      const seen = await card(token);
      expect([seen.base_url, seen.added_by, seen.models], token).toEqual([undefined, undefined, ["qwen"]]);
    }
    const subjects = async (token: string) =>
      (await call(url, "GET", "/v1/ledger", token)).body.rows
        .map((r: { subject: string }) => r.subject)
        .sort();
    expect(await subjects("a-work-token")).toEqual(["bo@lab", "cy@lab"]);
    expect(await subjects("a-see-token")).toEqual(["bo@lab"]);
    expect(await subjects("a-query-token")).toEqual(["cy@lab"]);
    for (const path of [
      "/v1/config",
      "/v1/models",
      "/v1/purposes",
      "/v1/backends",
      "/v1/admission",
      "/v1/models/lifecycle",
    ]) {
      expect((await call(url, "GET", path, "a-query-token")).status, path).toBe(200);
    }
  });

  it("refuses a caller left with no grant as no_grant, a caller with no token as unauthenticated, and lets a minted key in", async () => {
    const { url } = await kvasir({ mode: "token", tokens: TOKENS });
    for (const token of ["a-nobody-token", "an-unknown-token"]) {
      const r = await call(url, "GET", "/v1/config", token);
      expect([r.status, r.body.error.code], token).toEqual([403, "no_grant"]);
    }
    const none = await fetch(`${url}/v1/config`);
    expect([none.status, (await none.json()).error.code]).toEqual([401, "unauthenticated"]);
    // a minted key streams by its purposes and its class, and reads what anyone with a grant reads
    const minted = (await call(url, "POST", "/v1/keys", "a-work-token", { principal: "a-script" })).body;
    expect(await streamed(url, minted.key)).toBe(200);
    expect((await call(url, "GET", "/v1/config", minted.key)).status).toBe(200);
    const keys = await call(url, "GET", "/v1/keys", minted.key);
    expect([keys.status, keys.body.error.code]).toEqual([403, "no_grant"]);
  });
});

describe("a principal the desk already qualified", () => {
  it("is kept as it is by the desk's entry, which keeps subjects, and qualified by any other entry", async () => {
    const provider = "https://id.example.org/";
    const desk = trusting(ISSUER, {}, { keepSubject: true });
    const { url } = await kvasir({
      ...desk,
      trust: [
        ...(desk.trust ?? []),
        { issuer: provider, audience: AUDIENCE, jwks: join(vectors, "jwks.json") },
      ],
    });
    const qualified = await signed({
      sub: "8c1f2a@id.example.org",
      grants: ["assistant:use"],
      detail: "quasi",
    });
    const plain = await signed({ sub: "anna", grants: ["query:work"] });
    // another issuer naming a principal the desk's entry would keep is its own principal, never that one
    const posing = await signed({ iss: provider, sub: "anna@desk.example.org", grants: ["query:work"] });
    for (const token of [qualified, plain, posing]) expect(await streamed(url, token)).toBe(200);
    const rows = async (token: string) =>
      (await call(url, "GET", "/v1/ledger", token)).body.rows.map((r: { subject: string }) => r.subject);
    expect(await rows(qualified)).toEqual(["8c1f2a@id.example.org"]);
    expect(await rows(plain)).toEqual(["anna@desk.example.org"]);
    expect(await rows(posing)).toEqual(["anna@desk.example.org@id.example.org"]);
    const mine = await call(url, "GET", "/v1/subscriptions", qualified);
    expect(mine.body.subscriptions[0]).toMatchObject({ for: "person", state: "signed_out" });
  });
});

describe("an install's mapping to the ladder's names", () => {
  it("keeps working: a group bound to admin opens kvasir:work, one bound to operator sees without changing, and a named admin token opens as before", async () => {
    const legacy = trusting(ISSUER, {
      groupsClaim: "roles",
      roles: {
        reader: "reader",
        reviewer: "reviewer",
        operator: "operator",
        admin: "admin",
        assist: "assist",
      },
      tokens: { "the-installers-token": "nils-setup:admin" },
    });
    const auth = new Auth(legacy, null);
    expect(await resolved(auth, await signed({ sub: "anna", roles: ["operator", "reader"] }))).toEqual(
      SETS.operator,
    );
    expect(await resolved(auth, await signed({ sub: "anna", roles: ["admin", "assist"] }))).toEqual(
      EVERYTHING,
    );
    const { url } = await kvasir(legacy);
    expect((await call(url, "GET", "/v1/keys", await signed({ sub: "anna", roles: ["admin"] }))).status).toBe(
      200,
    );
    expect((await call(url, "GET", "/v1/keys", "the-installers-token")).status).toBe(200);
    const operator = await signed({ sub: "bo", roles: ["operator"] });
    const refused = await call(url, "GET", "/v1/keys", operator);
    expect([refused.status, refused.body.error.code]).toEqual([403, "no_grant"]);
    const seen = (await call(url, "GET", "/v1/backends", operator)).body.backends.find(
      (b: { id: string }) => b.id === "card",
    );
    expect(seen.base_url).toBeUndefined();
    expect(
      (await call(url, "GET", "/v1/config", await signed({ sub: "cy", roles: ["reader"] }))).status,
    ).toBe(200);
    // a group bound to nothing holds nothing
    const visitor = await call(url, "GET", "/v1/config", await signed({ sub: "dee", roles: ["visitors"] }));
    expect([visitor.status, visitor.body.error.code]).toEqual([403, "no_grant"]);
  });
});
