// SPDX-License-Identifier: AGPL-3.0-only
// A person's own ChatGPT subscription (record 23): signed in with a device
// code, sealed under the person, refreshed before it expires, and signed out;
// the install's where nobody signs in; a purpose moved to ChatGPT going to the
// subscription of whoever streams, and to the default for someone with none;
// and an app's key streaming for the person its person token names. Signing
// in and choosing a model need assistant:use and kvasir:see, and a
// subscription answers a stream only while its person holds both (record 25).

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import type { Backend } from "../src/backends.js";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { Store } from "../src/store.js";
import { type SubscriptionAuth, Subscriptions, SYSTEM } from "../src/subscriptions.js";
import { chunk, hold, serve, sse } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const MODELS = [
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini", contextWindow: 272_000 },
  { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272_000 },
];

/** pi-ai's Codex sign-in as a test holds it: a device code shown at once, approved when the test says so. */
function fakeAuth(opts: { failBeforeCode?: boolean } = {}) {
  const approvals: (() => void)[] = [];
  let refreshes = 0;
  const auth = {
    name: "OpenAI (ChatGPT Plus/Pro)",
    async login(interaction: {
      signal?: AbortSignal;
      prompt: (p: unknown) => Promise<string>;
      notify: (e: unknown) => void;
    }) {
      if (opts.failBeforeCode) throw new Error("device code login is not enabled");
      const method = await interaction.prompt({
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      });
      if (method !== "device_code") throw new Error(`the sign-in chose ${method}`);
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      await new Promise<void>((resolve, reject) => {
        approvals.push(resolve);
        interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")));
      });
      return {
        type: "oauth",
        access: "access-1",
        refresh: "refresh-1",
        expires: Date.now() + 3_600_000,
        accountId: "a",
      };
    },
    async refresh() {
      refreshes += 1;
      return {
        type: "oauth",
        access: `access-${refreshes + 1}`,
        refresh: `refresh-${refreshes + 1}`,
        expires: Date.now() + 3_600_000,
        accountId: "a",
      };
    },
    async toAuth(credential: { access: string }) {
      return { apiKey: credential.access };
    },
  };
  return {
    auth: auth as unknown as SubscriptionAuth,
    approve: () => approvals.shift()?.(),
    refreshes: () => refreshes,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function store(): { db: Store; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "kvasir-subscription-")), "kvasir.sqlite");
  const db = new Store(path);
  closers.push(() => db.close());
  return { db, path };
}

describe("a person's own ChatGPT subscription", () => {
  it("is signed in with a device code, sealed, refreshed once before it expires, and signed out", async () => {
    const { db, path } = store();
    const fake = fakeAuth();
    let clock = Date.now();
    const s = new Subscriptions(
      db,
      new Uint8Array(randomBytes(32)),
      MODELS,
      () => fake.auth,
      () => clock,
    );
    expect(s.status("anna@lab", "person").state).toBe("signed_out");
    const waiting = await s.signIn("anna@lab");
    expect(waiting.userCode).toBe("ABCD-EFGH");
    expect(s.status("anna@lab", "person")).toMatchObject({
      state: "waiting",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.openai.com/codex/device",
    });
    fake.approve();
    await tick();
    expect(s.status("anna@lab", "person")).toMatchObject({
      state: "signed_in",
      model: "gpt-5.4-mini",
      user_code: null,
    });
    expect(await s.token("anna@lab")).toBe("access-1");
    expect(readFileSync(path).includes(Buffer.from("access-1"))).toBe(false);
    // a subscription is only its person's
    expect(s.has("bo@lab")).toBe(false);
    expect(await s.token("bo@lab")).toBeNull();
    s.choose("anna@lab", "gpt-5.5");
    expect(s.model("anna@lab")).toBe("gpt-5.5");
    expect(() => s.choose("anna@lab", "gpt-9")).toThrow(/no model named gpt-9/);
    // within five minutes of its expiry the token is refreshed, once for two streams
    clock = Date.now() + 3_600_000;
    expect(await Promise.all([s.token("anna@lab"), s.token("anna@lab")])).toEqual(["access-2", "access-2"]);
    expect(fake.refreshes()).toBe(1);
    expect(s.signOut("anna@lab")).toBe(true);
    expect(s.status("anna@lab", "person").state).toBe("signed_out");
    expect(await s.token("anna@lab")).toBeNull();
  });

  it("says a sign-in ChatGPT did not start, and forgets one its person abandoned", async () => {
    const { db } = store();
    const broken = new Subscriptions(
      db,
      new Uint8Array(randomBytes(32)),
      MODELS,
      () => fakeAuth({ failBeforeCode: true }).auth,
    );
    await expect(broken.signIn("anna@lab")).rejects.toThrow(/not enabled/);
    expect(broken.status("anna@lab", "person").state).toBe("signed_out");
    const fake = fakeAuth();
    const s = new Subscriptions(db, new Uint8Array(randomBytes(32)), MODELS, () => fake.auth);
    await s.signIn("bo@lab");
    expect(s.signOut("bo@lab")).toBe(true);
    await tick();
    expect(s.status("bo@lab", "person").state).toBe("signed_out");
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

async function kvasir(auth: unknown, fake: ReturnType<typeof fakeAuth>): Promise<{ k: Kvasir; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-subscription-"));
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
        purposes: [
          { id: "assistant.title", app: "nils-assistant", content: "catalog", kind: "background" },
          { id: "assistant.ask-help", app: "nils-assistant", content: "rows", kind: "foreground" },
        ],
      }),
    ),
    { subscriptionAuth: () => fake.auth },
  );
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

const tokens = {
  mode: "token",
  tokens: {
    "anna-token": "anna@lab:kvasir:work,assistant:use",
    "bo-token": "bo@lab:query:work",
    "app-token": "nils-assistant:kvasir:see",
  },
};
const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

describe("ChatGPT in the policy", () => {
  it("serves a purpose moved to it from the subscription of whoever streams, and the default to someone with none", async () => {
    const rt = await runtime();
    const fake = fakeAuth();
    const { k, url } = await kvasir(tokens, fake);
    hold(k, [
      { id: "card", baseUrl: `${rt.url}/v1`, locality: "local", warmup: false, models: [{ id: "qwen" }] },
    ]);
    for (const b of k.backends.list) b.health.warming = false;
    // Kvasir's own backend: listed, never let go
    const listed = await (await fetch(`${url}/v1/backends`, { headers: as("anna-token") })).json();
    expect(listed.backends.find((b: { id: string }) => b.id === "chatgpt")).toMatchObject({
      builtin: true,
      locality: "remote",
      kind: "openai-codex-responses",
    });
    expect(
      (await fetch(`${url}/v1/backends/chatgpt`, { method: "DELETE", headers: as("anna-token") })).status,
    ).toBe(404);
    k.held.sync();
    expect(k.backends.get("chatgpt")).toBeDefined();
    // it is never warmed: a stream reaches it only with the subscription of a person signed in
    const own = k.backends.get("chatgpt");
    expect(own?.config.warmup).toBe(false);
    await own?.warmup();
    expect(own?.health.lastError).toBeNull();
    // a person signs in; an app has no subscription of its own
    const post = (path: string, token: string) =>
      fetch(`${url}${path}`, { method: "POST", headers: as(token) });
    expect((await post("/v1/subscriptions/chatgpt/sign-in", "app-token")).status).toBe(403);
    const started = await (await post("/v1/subscriptions/chatgpt/sign-in", "anna-token")).json();
    expect(started).toMatchObject({ state: "waiting", user_code: "ABCD-EFGH" });
    fake.approve();
    await tick();
    const mine = await (await fetch(`${url}/v1/subscriptions`, { headers: as("anna-token") })).json();
    expect(mine.subscriptions[0]).toMatchObject({ for: "person", state: "signed_in", model: "gpt-5.4-mini" });
    const bos = await (await fetch(`${url}/v1/subscriptions`, { headers: as("bo-token") })).json();
    expect(bos.subscriptions[0].state).toBe("signed_out");
    // the titles move to ChatGPT; a purpose that reads rows needs the written reason first
    const move = (purpose: string) =>
      fetch(`${url}/v1/purposes/${purpose}/policy`, {
        method: "PUT",
        headers: as("anna-token"),
        body: JSON.stringify({ backend: "chatgpt" }),
      });
    expect((await move("assistant.title")).status).toBe(200);
    expect((await move("assistant.ask-help")).status).toBe(400);
    const grant = async (token: string, body: unknown) =>
      (
        await fetch(`${url}/v1/grants`, { method: "POST", headers: as(token), body: JSON.stringify(body) })
      ).json();
    // the table moves the call whatever model the caller named
    expect(await grant("anna-token", { purpose: "assistant.title", pin: "qwen" })).toMatchObject({
      backend: "chatgpt",
      model: "gpt-5.4-mini",
      locality: "remote",
    });
    // even a model Kvasir holds nowhere, which an app names where only a subscription serves the purpose
    const nowhere = await grant("anna-token", { purpose: "assistant.title", pin: "chatgpt" });
    expect(nowhere).toMatchObject({ backend: "chatgpt", model: "gpt-5.4-mini" });
    expect(nowhere.chose_because.join(" ")).toContain("Kvasir holds no model of that name");
    // with no row for the purpose, a model held nowhere is still refused
    const unmapped = await fetch(`${url}/v1/grants`, {
      method: "POST",
      headers: as("anna-token"),
      body: JSON.stringify({ purpose: "assistant.ask-help", pin: "chatgpt" }),
    });
    expect(unmapped.status).toBe(403);
    expect(JSON.stringify(await unmapped.json())).toContain("no model named chatgpt");
    const fallback = await grant("bo-token", { purpose: "assistant.title" });
    expect(fallback).toMatchObject({ backend: "card", model: "qwen" });
    expect(fallback.chose_because.join(" ")).toContain("no ChatGPT subscription is signed in");
  });

  it("streams for the person an app's key names, and refuses a person token that does not verify", async () => {
    const rt = await runtime();
    const { k, url } = await kvasir(tokens, fakeAuth());
    hold(k, [
      { id: "card", baseUrl: `${rt.url}/v1`, locality: "local", warmup: false, models: [{ id: "qwen" }] },
    ]);
    for (const b of k.backends.list) b.health.warming = false;
    const ask = JSON.stringify({
      model: "qwen",
      context: { messages: [{ role: "user", content: "a title", timestamp: 1 }] },
    });
    const call = (person: string) =>
      fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { ...as("app-token"), "x-kvasir-person": person },
        body: ask,
      });
    expect((await call("not-a-token")).status).toBe(401);
    const streamed = await call("bo-token");
    expect(streamed.status).toBe(200);
    await streamed.text();
    expect(k.ledger.rows(null, 10).map((r) => r.subject)).toContain("bo@lab");
  });

  it("is the install's where nobody signs in", async () => {
    const fake = fakeAuth();
    const { url } = await kvasir({ mode: "off" }, fake);
    const started = await (await fetch(`${url}/v1/subscriptions/chatgpt/sign-in`, { method: "POST" })).json();
    expect(started.state).toBe("waiting");
    fake.approve();
    await tick();
    const status = await (await fetch(`${url}/v1/subscriptions`)).json();
    expect(status.subscriptions[0]).toMatchObject({ for: SYSTEM, state: "signed_in" });
  });
});

/** The end of a stream as pi-ai's adapters give it. */
function done(model: string): AssistantMessageEvent {
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "a title" }],
      api: "openai-codex-responses",
      provider: "chatgpt",
      model,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as unknown as AssistantMessageEvent;
}

/** One person with a token for each way of holding what a subscription needs, someone with kvasir:work, and an app. */
const rule = {
  mode: "token",
  tokens: {
    "both-token": "cy@lab:assistant:use,kvasir:see",
    "use-token": "cy@lab:assistant:use",
    "see-token": "cy@lab:kvasir:see",
    "query-token": "cy@lab:query:work",
    "work-token": "anna@lab:kvasir:work",
    "app-token": "nils-assistant:kvasir:see",
  },
};

// biome-ignore lint/suspicious/noExplicitAny: a door's answer, read as the test reads it
async function send(url: string, method: string, path: string, token: string, body?: unknown): Promise<any> {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: as(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

describe("the subscription rule", () => {
  it("starts a sign-in and chooses a model only with assistant:use and kvasir:see, and its status and signing out need only the person", async () => {
    const fake = fakeAuth();
    const { url } = await kvasir(rule, fake);
    const refused = [403, "no_grant", ["assistant:use", "kvasir:see"]];
    for (const token of ["use-token", "see-token", "query-token", "work-token"]) {
      const signIn = await send(url, "POST", "/v1/subscriptions/chatgpt/sign-in", token);
      expect([signIn.status, signIn.body.error.code, signIn.body.error.needs], token).toEqual(refused);
      const choose = await send(url, "PUT", "/v1/subscriptions/chatgpt", token, { model: "gpt-5.4-mini" });
      expect([choose.status, choose.body.error.code, choose.body.error.needs], token).toEqual(refused);
    }
    const app = await send(url, "POST", "/v1/subscriptions/chatgpt/sign-in", "app-token");
    expect([app.status, app.body.error.code]).toEqual([403, "not_a_person"]);
    const started = await send(url, "POST", "/v1/subscriptions/chatgpt/sign-in", "both-token");
    expect(started.body).toMatchObject({ state: "waiting" });
    fake.approve();
    await tick();
    // the status is the person's, whatever they hold
    const status = await send(url, "GET", "/v1/subscriptions", "query-token");
    expect(status.body.subscriptions[0]).toMatchObject({ for: "person", state: "signed_in" });
    const other = status.body.subscriptions[0].models.map((m: { id: string }) => m.id).at(-1);
    const chosen = await send(url, "PUT", "/v1/subscriptions/chatgpt", "both-token", { model: other });
    expect(chosen.body).toMatchObject({ model: other });
    // and so is signing out
    expect((await send(url, "DELETE", "/v1/subscriptions/chatgpt", "query-token")).status).toBe(204);
    const after = await send(url, "GET", "/v1/subscriptions", "see-token");
    expect(after.body.subscriptions[0].state).toBe("signed_out");
  });

  it("answers a stream only while its person holds both, and otherwise streams as a signed-out person's", async () => {
    const rt = await runtime();
    const fake = fakeAuth();
    const { k, url } = await kvasir(rule, fake);
    hold(k, [
      { id: "card", baseUrl: `${rt.url}/v1`, locality: "local", warmup: false, models: [{ id: "qwen" }] },
    ]);
    for (const b of k.backends.list) b.health.warming = false;
    // ChatGPT is never reached from a test: its backend answers here, and keeps whose subscription each stream used
    const own = k.backends.get("chatgpt") as Backend;
    const used: (string | undefined)[] = [];
    own.stream = async function* (entry, _context, options) {
      used.push(options.subject);
      yield done(entry.id);
    };
    await send(url, "POST", "/v1/subscriptions/chatgpt/sign-in", "both-token");
    fake.approve();
    await tick();
    const moved = await send(url, "PUT", "/v1/purposes/assistant.title/policy", "work-token", {
      backend: "chatgpt",
    });
    expect(moved.status).toBe(200);
    const stream = async (token: string, over: Record<string, string> = {}) => {
      const r = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { ...as(token), "x-kvasir-purpose": "assistant.title", ...over },
        body: JSON.stringify({
          model: "qwen",
          context: { messages: [{ role: "user", content: "a title", timestamp: 1 }] },
        }),
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('"type":"done"');
      const [last] = k.ledger.rows(null, 1);
      return [last.subject, last.backend];
    };
    // the person's own stream, and an app's for them
    expect(await stream("both-token")).toEqual(["cy@lab", "chatgpt"]);
    expect(await stream("app-token", { "x-kvasir-person": "both-token" })).toEqual(["cy@lab", "chatgpt"]);
    // the same person without one of the two, or either, streams as a signed-out person, on the default
    expect(await stream("use-token")).toEqual(["cy@lab", "card"]);
    expect(await stream("see-token")).toEqual(["cy@lab", "card"]);
    expect(await stream("app-token", { "x-kvasir-person": "query-token" })).toEqual(["cy@lab", "card"]);
    expect(used).toEqual(["cy@lab", "cy@lab"]);
    // the grant door says the same
    const grant = async (token: string) =>
      (await send(url, "POST", "/v1/grants", token, { purpose: "assistant.title" })).body;
    expect(await grant("both-token")).toMatchObject({ backend: "chatgpt" });
    const signedOut = await grant("see-token");
    expect(signedOut).toMatchObject({ backend: "card", model: "qwen" });
    expect(signedOut.chose_because.join(" ")).toContain("no ChatGPT subscription is signed in");
    // and a grant taken while the person held both runs on the default for a stream no subscription answers
    const taken = await grant("both-token");
    expect(await stream("see-token", { "x-kvasir-grant": taken.grant })).toEqual(["cy@lab", "card"]);
    expect(await stream("both-token", { "x-kvasir-grant": taken.grant })).toEqual(["cy@lab", "chatgpt"]);
    expect(used).toEqual(["cy@lab", "cy@lab", "cy@lab"]);
  });
});
