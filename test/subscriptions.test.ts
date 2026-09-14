// SPDX-License-Identifier: AGPL-3.0-only
// A person's own ChatGPT subscription (record 23): signed in with a device
// code, sealed under the person, refreshed before it expires, and signed out;
// the install's where nobody signs in; a purpose moved to ChatGPT going to the
// subscription of whoever streams, and to the default for someone with none;
// and an app's key streaming for the person its person token names.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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
    "anna-token": "anna@lab:admin",
    "bo-token": "bo@lab:reader",
    "app-token": "nils-assistant:reader",
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
