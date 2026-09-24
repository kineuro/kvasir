// SPDX-License-Identifier: AGPL-3.0-only
// The door of §8.2 against fake backends: a pi client streams through
// Kvasir with zero compatibility flags, a thinking signature round trips
// byte for byte, the first token after a start is reported as warming
// until it arrives, and the OpenAI-shaped door answers a script.

import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stream as piStream } from "@earendil-works/pi-ai/api/pi-messages";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { described } from "../src/held.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { hold } from "./fake.js";

function sse(res: ServerResponse, events: unknown[], eventNames?: string[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  events.forEach((e, i) => {
    if (eventNames) res.write(`event: ${eventNames[i]}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  res.end();
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function serve(
  handler: (req: IncomingMessage, res: ServerResponse, text: string) => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => handler(req, res, await body(req)));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}`, server });
    }),
  );
}

/** A fake OpenAI-completions runtime: reasoning, then text, then a tool call; it checks the runtime key. */
async function fakeOpenAI(seen: string[]) {
  return serve((req, res, text) => {
    seen.push(req.headers.authorization ?? "");
    const q = JSON.parse(text);
    if (req.url !== "/v1/chat/completions" || !q.stream) {
      res.writeHead(400);
      res.end();
      return;
    }
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
      id: "x",
      object: "chat.completion.chunk",
      created: 1,
      model: q.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    sse(
      res,
      [
        chunk({ role: "assistant", content: "" }),
        chunk({ reasoning_content: "thinking about it" }),
        chunk({ content: "Hello " }),
        chunk({ content: "world" }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "nils_run", arguments: '{"document_id":' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: " 7}" } }] }),
        chunk({}, "tool_calls", { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 }),
        "[DONE]",
      ].map((e) => e),
    );
  });
}

/** A fake Anthropic-messages backend: a thinking block with a signature, then text. */
async function fakeAnthropic(signature: string) {
  return serve((req, res) => {
    if (req.url !== "/v1/messages") {
      res.writeHead(400);
      res.end();
      return;
    }
    const events = [
      {
        type: "message_start",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me see" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Seen." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];
    sse(
      res,
      events,
      events.map((e) => e.type),
    );
  });
}

/**
 * A fake OpenAI-completions runtime that says nothing for `silentMs` after its
 * headers, as llama.cpp does on the processor while it reads a long prompt,
 * then answers.
 */
async function slowOpenAI(silentMs: number) {
  return serve((req, res, text) => {
    const q = JSON.parse(text);
    if (req.url !== "/v1/chat/completions" || !q.stream) {
      res.writeHead(400);
      res.end();
      return;
    }
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
      id: "x",
      object: "chat.completion.chunk",
      created: 1,
      model: q.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => {
      for (const e of [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "Read it." }),
        chunk({}, "stop", { prompt_tokens: 5571, completion_tokens: 3, total_tokens: 5574 }),
      ])
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, silentMs);
  });
}

/** A local backend on a slow runtime, one model that does not reason. */
function slowBackend(url: string) {
  return {
    id: "slow",
    kind: "openai-completions",
    baseUrl: `${url}/v1`,
    locality: "local",
    concurrency: 8,
    warmup: false,
    models: [
      {
        id: "slow-model",
        name: "Slow",
        reasoning: false,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

async function kvasir(
  backends: unknown[],
  options: Parameters<typeof build>[1] = {},
): Promise<{ k: Kvasir; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-"));
  const config = parse(
    JSON.stringify({
      bind: "127.0.0.1:0",
      origin: "http://kvasir.test",
      auth: { mode: "token", tokens: { "a-kvasir-token": "anna@lab:kvasir:work" } },
      store: join(dir, "kvasir.sqlite"),
      pepperFile: join(dir, "kvasir.pepper"),
      admission: { queue: 8, waitCapSeconds: 60, gate: false },
    }),
  );
  const k = build(config, options);
  hold(k, backends);
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

function piModel(url: string, id: string): Model<"pi-messages"> {
  return {
    id,
    name: id,
    api: "pi-messages",
    provider: "kvasir" as never,
    baseUrl: `${url}/v1`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

describe("the door", () => {
  it("streams a pi client through with zero compatibility flags, the runtime key attached by Kvasir", async () => {
    const seen: string[] = [];
    const rt = await fakeOpenAI(seen);
    closers.push(() => rt.server.close());
    const { k, url } = await kvasir([
      {
        id: "card",
        kind: "openai-completions",
        baseUrl: `${rt.url}/v1`,
        key: "the-runtime-key",
        locality: "local",
        concurrency: 8,
        // a backend Kvasir warms is warming until its first token; one it does not warm never is (#8)
        warmup: true,
        models: [
          {
            id: "qwen38-27b",
            name: "Qwen",
            reasoning: true,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ]);
    // no first token since start: warming
    let health = await (await fetch(`${url}/healthz`)).json();
    expect(health.warming).toBe(true);
    const config = await (
      await fetch(`${url}/v1/config`, { headers: { authorization: "Bearer a-kvasir-token" } })
    ).json();
    expect(config.baseUrl).toBe("http://kvasir.test/v1/pi");
    expect(config.models[0].id).toBe("qwen38-27b");
    expect(config.health.warming).toBe(true);
    // a stream, as pi's own client sends it: the model, the context, the options, nothing else
    const events: string[] = [];
    let thinking = "";
    let text = "";
    let toolCall: unknown = null;
    for await (const ev of piStream(
      piModel(url, "qwen38-27b"),
      { systemPrompt: "Be brief.", messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      { apiKey: "a-kvasir-token" },
    )) {
      events.push(ev.type);
      if (ev.type === "thinking_delta") thinking += ev.delta;
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "toolcall_end") toolCall = ev.toolCall;
      if (ev.type === "done") expect(ev.reason).toBe("toolUse");
    }
    expect(events[0]).toBe("start");
    expect(events.at(-1)).toBe("done");
    expect(thinking).toBe("thinking about it");
    expect(text).toBe("Hello world");
    expect(toolCall).toMatchObject({ name: "nils_run", arguments: { document_id: 7 } });
    expect(seen[0]).toBe("Bearer the-runtime-key");
    // the first token arrived: warm
    health = await (await fetch(`${url}/healthz`)).json();
    expect(health.warming).toBe(false);
    expect(k.backends.list[0].health.firstTokenAt).not.toBeNull();
    // a caller with no token
    const r = await fetch(`${url}/v1/config`);
    expect(r.status).toBe(401);
    // a model the catalog does not have
    const r2 = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer a-kvasir-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "nope", context: { messages: [] } }),
    });
    expect(r2.status).toBe(404);
  });

  it("round trips a thinking signature byte for byte", async () => {
    const signature = "EqQBCgIYAhIM3sOgRvL9rz2ac8zoGgwMU2Fe//Hpr0rTvXwiMOaaLJfcgNPmHZ2mJ4SAv9K3ZXFtFvI=";
    const rt = await fakeAnthropic(signature);
    closers.push(() => rt.server.close());
    const { url } = await kvasir([
      {
        id: "vendor",
        kind: "anthropic-messages",
        baseUrl: rt.url,
        key: "vendor-key",
        locality: "local",
        concurrency: 4,
        warmup: false,
        models: [
          {
            id: "claude",
            name: "Claude",
            reasoning: true,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 8192,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
        ],
      },
    ]);
    let got: unknown = null;
    let text = "";
    for await (const ev of piStream(
      piModel(url, "claude"),
      { messages: [{ role: "user", content: "Look", timestamp: 1 }] },
      { apiKey: "a-kvasir-token" },
    )) {
      if (ev.type === "thinking_end") got = ev.partial.content[ev.contentIndex];
      if (ev.type === "text_delta") text += ev.delta;
    }
    expect(text).toBe("Seen.");
    expect(got).toMatchObject({ type: "thinking", thinking: "let me see", thinkingSignature: signature });
  });

  it("answers a script through the OpenAI-shaped door, streamed and whole", async () => {
    const seen: string[] = [];
    const rt = await fakeOpenAI(seen);
    closers.push(() => rt.server.close());
    const { url } = await kvasir([
      {
        id: "card",
        kind: "openai-completions",
        baseUrl: `${rt.url}/v1`,
        key: "k",
        locality: "local",
        concurrency: 8,
        warmup: false,
        models: [
          {
            id: "qwen38-27b",
            name: "Qwen",
            reasoning: true,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ]);
    const headers = { authorization: "Bearer a-kvasir-token", "content-type": "application/json" };
    const models = await (await fetch(`${url}/v1/models`, { headers })).json();
    expect(models.data[0].id).toBe("qwen38-27b");
    const whole = await (
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "qwen38-27b",
          messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Hi" },
          ],
        }),
      })
    ).json();
    expect(whole.choices[0].message.content).toBe("Hello world");
    expect(whole.choices[0].message.reasoning_content).toBe("thinking about it");
    const streamed = await (
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "qwen38-27b",
          stream: true,
          messages: [{ role: "user", content: "Hi" }],
        }),
      })
    ).text();
    expect(streamed).toContain('"content":"Hello "');
    expect(streamed.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("moves reasoning a model left inline into thinking, through both doors, unless the backend says off", async () => {
    const rt = await serve((_req, res, text) => {
      const q = JSON.parse(text);
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: q.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      });
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "<think>\n" }),
        chunk({ content: "Counting the sessions." }),
        chunk({ content: "</think>\n\nThere are " }),
        chunk({ content: "12." }),
        chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }),
        "[DONE]",
      ]);
    });
    closers.push(() => rt.server.close());
    const model = (id: string) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const backend = {
      kind: "openai-completions",
      baseUrl: `${rt.url}/v1`,
      key: "k",
      locality: "local",
      concurrency: 8,
      warmup: false,
    };
    const { url } = await kvasir([
      { ...backend, id: "card", models: [model("qwen")] },
      { ...backend, id: "plain", inlineReasoning: "off", models: [model("qwen-as-is")] },
    ]);
    const read = async (id: string) => {
      const blocks: string[] = [];
      let thinking = "";
      let text = "";
      for await (const ev of piStream(
        piModel(url, id),
        { messages: [{ role: "user", content: "How many?", timestamp: 1 }] },
        { apiKey: "a-kvasir-token" },
      )) {
        if (ev.type.endsWith("_start") || ev.type.endsWith("_end")) blocks.push(ev.type);
        if (ev.type === "thinking_delta") thinking += ev.delta;
        if (ev.type === "text_delta") text += ev.delta;
      }
      return { blocks, thinking, text };
    };
    expect(await read("qwen")).toEqual({
      blocks: ["thinking_start", "thinking_end", "text_start", "text_end"],
      thinking: "Counting the sessions.",
      text: "There are 12.",
    });
    const asIs = await read("qwen-as-is");
    expect(asIs.thinking).toBe("");
    expect(asIs.text).toBe("<think>\nCounting the sessions.</think>\n\nThere are 12.");
    const headers = { authorization: "Bearer a-kvasir-token", "content-type": "application/json" };
    const whole = await (
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "qwen", messages: [{ role: "user", content: "How many?" }] }),
      })
    ).json();
    expect(whole.choices[0].message).toEqual({
      role: "assistant",
      content: "There are 12.",
      reasoning_content: "Counting the sessions.",
    });
    expect(() => described({ ...backend, id: "a", inlineReasoning: "sometimes", models: ["m"] })).toThrow(
      /inlineReasoning: off, markers or open/,
    );
  });

  it("replays a turn's thinking as thinking to the model that wrote it, and leaves another model's out", async () => {
    const seen: { body?: unknown } = {};
    const rt = await serve((_req, res, text) => {
      seen.body = JSON.parse(text);
      const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      });
      sse(res, [
        chunk({ role: "assistant", content: "ok" }),
        chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
        "[DONE]",
      ]);
    });
    closers.push(() => rt.server.close());
    const { url } = await kvasir([
      {
        id: "card-fast",
        kind: "openai-completions",
        baseUrl: `${rt.url}/v1`,
        key: "k",
        locality: "local",
        concurrency: 8,
        warmup: false,
        models: [
          {
            id: "qwen-fast",
            upstream: "qwen",
            name: "Qwen",
            reasoning: true,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ]);
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    // a client keeps a turn under its own provider and Kvasir's catalog id
    const turn = (model: string, thinking: string, text: string) => ({
      role: "assistant" as const,
      api: "pi-messages" as never,
      provider: "kvasir-concierge" as never,
      model,
      content: [
        { type: "thinking" as const, thinking, thinkingSignature: "reasoning_content" },
        { type: "text" as const, text },
      ],
      usage,
      stopReason: "stop" as const,
      timestamp: 2,
    });
    for await (const _ of piStream(
      piModel(url, "qwen-fast"),
      {
        messages: [
          { role: "user", content: "How many?", timestamp: 1 },
          turn("qwen-fast", "earlier thought", "Earlier answer"),
          turn("claude", "another model's thought", "Claude said"),
          { role: "user", content: "Again", timestamp: 3 },
        ],
      },
      { apiKey: "a-kvasir-token" },
    )) {
      // the reply is not what this test reads
    }
    const sent = JSON.stringify(seen.body);
    expect(sent).toContain('"reasoning_content":"earlier thought"');
    expect(sent).not.toContain("another model's thought");
    const assistants = (seen.body as { messages: { role: string; content: unknown }[] }).messages.filter(
      (m) => m.role === "assistant",
    );
    expect(assistants.map((m) => m.content)).toEqual(["Earlier answer", "Claude said"]);
  });

  it("refuses a backend of a kind Kvasir has not got, and a configuration that still names backends", () => {
    expect(() =>
      described({ id: "a", kind: "gemini", baseUrl: "http://x", locality: "local", models: ["m"] }),
    ).toThrow(/kind is one of/);
    expect(() => parse(JSON.stringify({ bind: "x", origin: "http://x", backends: [] }))).toThrow(
      /held in Kvasir's database/,
    );
  });

  it("keeps a stream observable while the model says nothing, and a pi client reads it as before", async () => {
    const rt = await slowOpenAI(900);
    closers.push(() => rt.server.close());
    const { url } = await kvasir([slowBackend(rt.url)], { keepAliveMs: 100 });
    // on the wire: comments while the runtime is silent, then the events, and nothing after the last
    const r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer a-kvasir-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "slow-model",
        context: { messages: [{ role: "user", content: "Read this long prompt", timestamp: 1 }] },
      }),
    });
    const blocks = (await r.text()).split("\n\n").filter(Boolean);
    expect(blocks.filter((b) => b === ": ping").length).toBeGreaterThanOrEqual(3);
    expect(blocks.at(-1)).toMatch(/^data: \{"type":"done"/);
    // as the assistant streams: the same events, the comments unseen
    const events: string[] = [];
    let text = "";
    for await (const ev of piStream(
      piModel(url, "slow-model"),
      { messages: [{ role: "user", content: "Again", timestamp: 1 }] },
      { apiKey: "a-kvasir-token" },
    )) {
      events.push(ev.type);
      if (ev.type === "text_delta") text += ev.delta;
    }
    expect(events[0]).toBe("start");
    expect(events.at(-1)).toBe("done");
    expect(text).toBe("Read it.");
  });

  it("keeps the OpenAI-shaped stream the same way, and ends it with [DONE]", async () => {
    const rt = await slowOpenAI(600);
    closers.push(() => rt.server.close());
    const { url } = await kvasir([slowBackend(rt.url)], { keepAliveMs: 100 });
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer a-kvasir-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "slow-model",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const raw = await r.text();
    const blocks = raw.split("\n\n").filter(Boolean);
    expect(blocks.filter((b) => b === ": ping").length).toBeGreaterThanOrEqual(2);
    expect(blocks.at(-1)).toBe("data: [DONE]");
    expect(raw).toContain("Read it.");
  });

  it("writes no comment on a stream that keeps talking", async () => {
    const rt = await fakeOpenAI([]);
    closers.push(() => rt.server.close());
    const { url } = await kvasir([
      {
        id: "card",
        kind: "openai-completions",
        baseUrl: `${rt.url}/v1`,
        locality: "local",
        concurrency: 8,
        warmup: false,
        models: [
          {
            id: "qwen38-27b",
            name: "Qwen",
            reasoning: true,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ]);
    const r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer a-kvasir-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen38-27b",
        context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      }),
    });
    expect(await r.text()).not.toContain(": ping");
  });
});
