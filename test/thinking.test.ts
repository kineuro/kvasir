// SPDX-License-Identifier: AGPL-3.0-only
// A backend's thinking (2026-10-12): `on` asks every model that reasons to
// think before it answers and `off` turns it off, by the chat template's
// `enable_thinking`; with neither, nothing is sent and the server's default
// decides. A model server takes it with an add, with the longest answer each
// model ticked is held with, and a server held already takes both again
// without its models being asked. The admission suite still passes on a
// server that thinks first.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { described } from "../src/held.js";
import { build, type Kvasir, listen } from "../src/server.js";
import {
  ANSWER_TOKENS,
  answerOf,
  longestAnswer,
  type Offered,
  THINKING_ANSWER_TOKENS,
} from "../src/servers.js";
import { THINKING_BUDGET } from "../src/suite.js";
import { chunk, entry, fakeRuntime, hold, local, serve, sse } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const KEY = "the-server-key";

/** What one request to a fake server asked: its model, its longest answer, and what it told the chat template. */
interface Asked {
  model: string;
  max_tokens: unknown;
  chat_template_kwargs: unknown;
}

async function kvasir(gate = true): Promise<{ k: Kvasir; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-thinking-"));
  const k = build(
    parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: { mode: "token", tokens: { "an-admin-token": "anna@lab:kvasir:work" } },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate },
        purposes: [{ id: "assistant.title", app: "nils-assistant", content: "catalog", kind: "background" }],
      }),
    ),
  );
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

const admin = { authorization: "Bearer an-admin-token", "content-type": "application/json" };

/**
 * A runtime that keeps what each request asked and answers a word, thinking first unless the chat
 * template was told not to, as SGLang's Qwen does.
 */
async function wordRuntime() {
  const seen: Asked[] = [];
  const rt = await serve((_req, res, text) => {
    const q = JSON.parse(text || "{}");
    seen.push({ model: q.model, max_tokens: q.max_tokens, chat_template_kwargs: q.chat_template_kwargs });
    const thinks = q.chat_template_kwargs?.enable_thinking !== false;
    sse(res, [
      chunk({ role: "assistant", content: "" }),
      ...(thinks ? [chunk({ reasoning_content: "A word is asked for." })] : []),
      chunk({ content: "ready" }),
      chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
      "[DONE]",
    ]);
  });
  closers.push(() => rt.server.close());
  return { url: rt.url, seen };
}

/** One stream through a held backend's model, with what came back as thinking and as words. */
async function ask(k: Kvasir, backendId: string, modelId: string) {
  const b = k.backends.get(backendId);
  const e = b?.config.models.find((m) => m.id === modelId);
  if (!b || !e) throw new Error(`no ${backendId}/${modelId}`);
  let thinking = "";
  let text = "";
  for await (const ev of b.stream(
    e,
    { messages: [{ role: "user", content: "Say ready.", timestamp: 1 }] },
    {},
  )) {
    if (ev.type === "thinking_delta") thinking += ev.delta;
    if (ev.type === "text_delta") text += ev.delta;
  }
  return { thinking, text };
}

/**
 * The group's model server as a fake: two models that reason, with their specs; every request
 * answered by a runtime that passes the admission suite, thinking first unless told not to.
 */
async function thinkingServer() {
  const rt = await fakeRuntime(true);
  closers.push(() => rt.server.close());
  const asked: Asked[] = [];
  const s = await serve(async (req, res, text) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "wrong API key", type: "authentication_error" } }));
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
              aliases: ["flash-next"],
              default: true,
              status: "loaded",
              context_length: 262_144,
              max_output_tokens: 65_536,
              max_concurrent_requests: 4,
              capabilities: { tools: true, reasoning: true },
            },
            {
              id: "qwen38-27b",
              status: "cold",
              context_length: 262_144,
              max_output_tokens: 65_536,
              max_concurrent_requests: 8,
              capabilities: { tools: true, reasoning: true },
              swap_in_seconds: 1,
            },
          ],
        }),
      );
      return;
    }
    const q = JSON.parse(text || "{}");
    asked.push({ model: q.model, max_tokens: q.max_tokens, chat_template_kwargs: q.chat_template_kwargs });
    const r = await fetch(`${rt.url}${req.url}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: text,
    });
    const type = r.headers.get("content-type") ?? "application/json";
    let out = Buffer.from(await r.arrayBuffer()).toString("utf8");
    // a model that thinks writes its reasoning before the answer, spent from the same budget
    if (type.startsWith("text/event-stream") && q.chat_template_kwargs?.enable_thinking !== false)
      out = `data: ${JSON.stringify(chunk({ reasoning_content: "Let me weigh what is asked." }))}\n\n${out}`;
    res.writeHead(r.status, { "content-type": type });
    res.end(out);
  });
  closers.push(() => s.server.close());
  return { url: `${s.url}/v1`, asked };
}

describe("a backend's thinking", () => {
  it("is asked of a model that reasons, turned off, or left to the server, by the chat template", async () => {
    const rt = await wordRuntime();
    const { k } = await kvasir(false);
    hold(k, [
      { ...local(rt.url, "asks", [entry("qwen", true)]), thinking: "on" },
      { ...local(rt.url, "stops", [entry("qwen-off", true), entry("plain")]), thinking: "off" },
      local(rt.url, "leaves", [entry("qwen-default", true)]),
      // an operator's own thinking flags give way to the backend's thinking; its other flags stay
      {
        ...local(rt.url, "flagged", [entry("qwen-flagged", true)]),
        thinking: "on",
        compat: {
          thinkingFormat: "qwen-chat-template",
          chatTemplateKwargs: { custom: 1 },
          supportsStore: true,
        },
      },
    ]);

    const on = await ask(k, "asks", "qwen");
    expect(rt.seen.at(-1)?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(on).toEqual({ thinking: "A word is asked for.", text: "ready" });

    const off = await ask(k, "stops", "qwen-off");
    expect(rt.seen.at(-1)?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(off).toEqual({ thinking: "", text: "ready" });

    // a model that does not reason is told nothing, whatever its backend says
    await ask(k, "stops", "plain");
    expect(rt.seen.at(-1)?.chat_template_kwargs).toBeUndefined();

    // nothing said: nothing is sent, and the server's own default thinks
    const left = await ask(k, "leaves", "qwen-default");
    expect(rt.seen.at(-1)?.chat_template_kwargs).toBeUndefined();
    expect(left.thinking).toBe("A word is asked for.");

    await ask(k, "flagged", "qwen-flagged");
    expect(rt.seen.at(-1)?.chat_template_kwargs).toEqual({ custom: 1, enable_thinking: true });
    expect(k.backends.get("flagged")?.compat()).toMatchObject({
      thinkingFormat: "chat-template",
      supportsStore: true,
      supportsDeveloperRole: false,
    });
  });

  it("is on or off on an OpenAI-shaped backend, and anything else is refused", () => {
    const base = {
      kind: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      locality: "local",
      models: ["m"],
    };
    expect(described({ ...base, thinking: "on" }).config.thinking).toBe("on");
    expect(described({ ...base, thinking: "off" }).config.thinking).toBe("off");
    expect(described(base).config.thinking).toBeUndefined();
    expect(() => described({ ...base, thinking: "maybe" })).toThrow(/thinking: on or off/u);
    expect(() => described({ ...base, kind: "anthropic-messages", thinking: "on" })).toThrow(
      /OpenAI's chat completions/u,
    );
  });
});

describe("a model server's thinking and longest answer", () => {
  const offered = (over: Partial<Offered> = {}): Offered => ({
    id: "m",
    aliases: [],
    status: "loaded",
    default: true,
    context_length: 262_144,
    max_output_tokens: 65_536,
    max_concurrent_requests: 4,
    reasoning: true,
    tools: true,
    vision: false,
    swap_in_seconds: null,
    spec: {},
    held_by: null,
    ...over,
  });

  it("is the answer asked for, never more than the server allows or the context holds", () => {
    expect(longestAnswer(offered(), { answer: 16_384 })).toBe(16_384);
    expect(longestAnswer(offered({ max_output_tokens: 8_192 }), { answer: 16_384 })).toBe(8_192);
    expect(
      longestAnswer(offered({ max_output_tokens: null, context_length: 12_000 }), { answer: 16_384 }),
    ).toBe(12_000);
    // none asked: the server's own, else 4,096, or 16,384 where the model is asked to think
    expect(longestAnswer(offered())).toBe(65_536);
    expect(longestAnswer(offered({ max_output_tokens: null }))).toBe(ANSWER_TOKENS);
    expect(longestAnswer(offered({ max_output_tokens: null }), { thinking: "on" })).toBe(
      THINKING_ANSWER_TOKENS,
    );
    expect(longestAnswer(offered({ max_output_tokens: null }), { thinking: "off" })).toBe(ANSWER_TOKENS);
    expect(longestAnswer(offered({ max_output_tokens: null, reasoning: false }), { thinking: "on" })).toBe(
      ANSWER_TOKENS,
    );
    expect(
      longestAnswer(offered({ max_output_tokens: null, context_length: 8_192 }), { thinking: "on" }),
    ).toBe(8_192);
    expect(answerOf(undefined)).toBeNull();
    expect(answerOf("16384")).toBe(16_384);
    for (const bad of [0, -1, 1.5, "lots", 1 << 21]) expect(() => answerOf(bad)).toThrow(/max_tokens/u);
  });

  it("are held with the backend, admission passes thinking first, and an add to a held server changes them alone", async () => {
    const server = await thinkingServer();
    const { k, url } = await kvasir();
    const lines: string[] = [];

    // the first add, as setup makes it: every model ticked, the stations' last, thinking on, 16,384 tokens
    const added = await fetch(`${url}/v1/servers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        url: server.url,
        key: KEY,
        id: "card0",
        models: ["qwen38-27b", "flash-next"],
        thinking: "on",
        max_tokens: 16_384,
      }),
    });
    expect(added.status).toBe(201);
    const done = await added.json();
    expect(done.backend).toEqual({
      id: "card0",
      models: ["qwen38-27b", "qwen3.8-flash-next"],
      thinking: "on",
    });
    // each passed the whole suite, thinking first on every question
    expect(done.results).toEqual([
      expect.objectContaining({ id: "qwen38-27b", answered: true, admitted: true }),
      expect.objectContaining({ id: "qwen3.8-flash-next", answered: true, admitted: true }),
    ]);
    expect(server.asked.length).toBeGreaterThan(40);
    expect(
      server.asked.every((a) => JSON.stringify(a.chat_template_kwargs) === '{"enable_thinking":true}'),
    ).toBe(true);
    // the suite gives a thinking model its thinking budget, and the longest asked is within the answer held
    const budgets = new Set(server.asked.map((a) => a.max_tokens));
    expect(budgets.has(THINKING_BUDGET)).toBe(true);
    expect([...budgets].every((n) => typeof n === "number" && n <= 16_384)).toBe(true);
    const listed = await (await fetch(`${url}/v1/backends`, { headers: admin })).json();
    const card = listed.backends.find((b: { id: string }) => b.id === "card0");
    expect(card.thinking).toBe("on");
    expect(card.entries.map((e: { id: string; max_tokens: number }) => [e.id, e.max_tokens])).toEqual([
      ["qwen38-27b", 16_384],
      ["qwen3.8-flash-next", 16_384],
    ]);
    const records = k.admissions.list().length;

    // an update: the stations' model alone, ticked again with thinking off and a shorter answer; the
    // backend is held again in place, the other model keeps its own answer, nothing is asked of the server,
    // and no model is put through admission again
    const before = server.asked.length;
    const again = await k.servers.admit(
      {
        url: server.url,
        key_ref: "card0",
        id: "card0",
        models: ["flash-next"],
        thinking: "off",
        max_tokens: 8_192,
      },
      "test",
      (line) => lines.push(line),
    );
    expect(again.backend).toEqual({
      id: "card0",
      models: ["qwen38-27b", "qwen3.8-flash-next"],
      thinking: "off",
    });
    expect(again.results).toEqual([
      { id: "qwen3.8-flash-next", answered: true, admitted: true, record: null, error: null },
    ]);
    expect(server.asked.length).toBe(before);
    expect(k.admissions.list().length).toBe(records);
    expect(k.backends.get("card0")?.config.thinking).toBe("off");
    expect(k.backends.get("card0")?.config.models.map((m) => [m.id, m.maxTokens])).toEqual([
      ["qwen38-27b", 16_384],
      ["qwen3.8-flash-next", 8_192],
    ]);
    expect(k.credentials.has("card0")).toBe(true);
    expect(lines).toEqual(
      expect.arrayContaining(["card0: thinking off", "qwen3.8-flash-next: answers up to 8192 tokens"]),
    );
    // the model held again thinks no more
    expect(k.backends.get("card0")?.compat()).toMatchObject({
      chatTemplateKwargs: { enable_thinking: false },
    });

    // an add that says nothing of either keeps what the backend has, and changes nothing
    lines.length = 0;
    await k.servers.admit({ url: server.url, key_ref: "card0", models: ["flash-next"] }, "test", (line) =>
      lines.push(line),
    );
    expect(k.backends.get("card0")?.config.thinking).toBe("off");
    expect(k.backends.get("card0")?.config.models.map((m) => m.maxTokens)).toEqual([16_384, 8_192]);
    expect(lines).toEqual(["qwen3.8-flash-next: held already"]);

    // and a value that is neither is refused before the server is reached
    const refused = await fetch(`${url}/v1/servers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ url: server.url, key_ref: "card0", models: ["flash-next"], thinking: "yes" }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toMatch(/thinking: on or off/u);
    expect(server.asked.length).toBe(before);
  }, 60_000);
});
