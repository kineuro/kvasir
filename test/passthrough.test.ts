// SPDX-License-Identifier: AGPL-3.0-only
// Record 47, K1 and K2: modelgate's smoke test ported against a fake SGLang
// that speaks OpenAI and Anthropic, whole and streamed, with tool calls. The
// doors forward the client's request as it came, changing only the model's
// name and Anthropic's thinking default; a key imported from modelgate's keys
// file works, a revoked one is refused, and the old /v1/messages serves both
// pi-messages and Anthropic's messages for one release.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stream as piStream } from "@earendil-works/pi-ai/api/pi-messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { estimateInput } from "../src/passthrough.js";
import { build, type Kvasir, listen, listenPublic, piShaped } from "../src/server.js";
import { hold, serve } from "./fake.js";

const FLASH = "qwen3.8-flash-next";
const DENSE = "qwen38-27b";
const SGLANG_KEY = "the-sglang-key";

interface Seen {
  path: string;
  auth: string;
  apiKey: string;
  body: Record<string, unknown>;
}

function sse(res: ServerResponse, events: unknown[], named = false) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    if (named && typeof e === "object") res.write(`event: ${(e as { type: string }).type}\n`);
    res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
  }
  res.end();
}

function whole(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * A fake SGLang: OpenAI chat and completions, Anthropic messages and
 * count_tokens, and responses, whole and streamed, with a tool call when tools
 * are offered and an answer once the tool's result comes back. Like SGLang, it
 * sends a usage-only chunk only where stream_options asks for it.
 */
async function fakeSGLang(seen: Seen[], opts: { silentMs?: number } = {}) {
  return serve((req: IncomingMessage, res: ServerResponse, text: string) => {
    const body = text ? JSON.parse(text) : {};
    seen.push({
      path: req.url ?? "",
      auth: String(req.headers.authorization ?? ""),
      apiKey: String(req.headers["x-api-key"] ?? ""),
      body,
    });
    if (req.headers.authorization !== `Bearer ${SGLANG_KEY}`) return whole(res, 401, { error: "key" });
    const model = String(body.model);
    const usage = { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 };
    if (req.url === "/v1/chat/completions") {
      const messages = body.messages as { role: string; content: unknown }[];
      const last = messages.at(-1);
      const tools = Array.isArray(body.tools) && body.tools.length > 0;
      const call = tools && last?.role === "user";
      const message = call
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city": "Uppsala"}' },
              },
            ],
          }
        : {
            role: "assistant",
            content: last?.role === "tool" ? `It is ${String(last.content)} in Uppsala.` : "Hej!",
          };
      if (!body.stream)
        return whole(res, 200, {
          id: "c1",
          object: "chat.completion",
          created: 1,
          model,
          choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }],
          usage,
        });
      const chunk = (delta: unknown, finish: string | null = null) => ({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const events: unknown[] = [chunk({ role: "assistant", content: "" })];
      for (const n of ["1", " 2", " 3", " 4", " 5", " 6", " 7", " 8", " 9", " 10"])
        events.push(chunk({ content: n }));
      events.push(chunk({}, "stop"));
      if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage)
        events.push({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [], usage });
      events.push("[DONE]");
      if (opts.silentMs) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        setTimeout(() => {
          for (const e of events) res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
          res.end();
        }, opts.silentMs);
        return;
      }
      return sse(res, events);
    }
    if (req.url === "/v1/completions")
      return whole(res, 200, {
        id: "t1",
        object: "text_completion",
        model,
        choices: [{ index: 0, text: " Stockholm", finish_reason: "length" }],
        usage,
      });
    if (req.url === "/v1/messages/count_tokens") return whole(res, 200, { input_tokens: 42 });
    if (req.url === "/v1/messages") {
      const tools = Array.isArray(body.tools) && body.tools.length > 0;
      const content = tools
        ? [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Uppsala" } }]
        : [{ type: "text", text: "Stockholm" }];
      const msgUsage = { input_tokens: 15, output_tokens: 3, cache_read_input_tokens: 5 };
      if (!body.stream)
        return whole(res, 200, {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason: tools ? "tool_use" : "end_turn",
          usage: msgUsage,
        });
      return sse(
        res,
        [
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 15, output_tokens: 0, cache_read_input_tokens: 5 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Stock" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "holm" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ],
        true,
      );
    }
    if (req.url === "/v1/responses") {
      const r = {
        id: "resp_1",
        object: "response",
        status: "completed",
        model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hej" }] }],
        usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
      };
      if (!body.stream) return whole(res, 200, r);
      return sse(
        res,
        [
          { type: "response.created", response: { ...r, status: "in_progress", usage: null } },
          { type: "response.output_text.delta", delta: "Hej" },
          { type: "response.completed", response: r },
        ],
        true,
      );
    }
    whole(res, 404, { error: "no such path" });
  });
}

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

const ADMIN = "an-admin-token";

function model(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    ...extra,
  };
}

async function kvasir(
  url: string,
  over: Record<string, unknown> = {},
): Promise<{ k: Kvasir; url: string; dir: string; config: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-pass-"));
  const json = {
    bind: "127.0.0.1:0",
    origin: "http://kvasir.test",
    auth: { mode: "token", tokens: { [ADMIN]: "nima@lab:kvasir:work" } },
    store: join(dir, "kvasir.sqlite"),
    pepperFile: join(dir, "kvasir.pepper"),
    sealKeyFile: join(dir, "kvasir.seal"),
    admission: { queue: 8, waitCapSeconds: 60, gate: false },
    ...over,
  };
  const config = join(dir, "kvasir.json");
  writeFileSync(config, JSON.stringify(json));
  const k = build(parse(JSON.stringify(json)), { keepAliveMs: 100 });
  hold(k, [
    {
      id: "card",
      kind: "openai-completions",
      baseUrl: `${url}/v1`,
      key: SGLANG_KEY,
      locality: "local",
      concurrency: 4,
      warmup: false,
      passThrough: ["chat-completions", "completions", "messages", "responses"],
      models: [model(FLASH), model("dense", { upstream: DENSE, contextWindow: 32_768, maxTokens: 8_192 })],
    },
  ]);
  const address = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url: address, dir, config };
}

/** modelgate's keys file, as its `mk` step wrote it: a comment, and `name sha256hex` per line. */
function modelgateKeys(dir: string, keys: Record<string, string>): string {
  const file = join(dir, "modelgate-keys");
  const lines = ["# modelgate keys: name sha256hex"];
  for (const [name, secret] of Object.entries(keys))
    lines.push(`${name} ${createHash("sha256").update(secret).digest("hex")}`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const post = (url: string, path: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("modelgate's smoke test against Kvasir", () => {
  const seen: Seen[] = [];
  let url = "";
  let k: Kvasir;
  const NIMA = "a-key-nima-held-from-modelgate";
  beforeAll(async () => {
    const sg = await fakeSGLang(seen);
    closers.push(() => sg.server.close());
    const made = await kvasir(sg.url);
    url = made.url;
    k = made.k;
    const r = k.clients.importModelgate(modelgateKeys(made.dir, { nima: NIMA }), "test");
    expect(r).toEqual({ added: 1, present: 0, skipped: 1 });
  });
  const last = () => seen.at(-1) as Seen;

  it("refuses a request with no key, and lists the models with their specs to one", async () => {
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
    const r = await fetch(`${url}/v1/models`, { headers: bearer(NIMA) });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.object).toBe("list");
    const flash = d.data.find((m: { id: string }) => m.id === FLASH);
    expect(flash).toMatchObject({
      object: "model",
      status: "loaded",
      default: true,
      context_length: 262_144,
      max_output_tokens: 65_536,
      aliases: [],
      apis: [
        "openai /v1/chat/completions",
        "openai /v1/completions",
        "anthropic /v1/messages",
        "openai /v1/responses",
      ],
    });
    expect(flash.capabilities).toMatchObject({ reasoning: true, vision: true });
    const one = await (await fetch(`${url}/v1/models/dense`, { headers: bearer(NIMA) })).json();
    expect(one).toMatchObject({ id: "dense", default: false, context_length: 32_768 });
  });

  it("passes a chat request through as it came, changing only the model's name", async () => {
    const asked = {
      model: "dense",
      max_tokens: 40,
      chat_template_kwargs: { enable_thinking: false },
      stop: ["\n\n"],
      response_format: { type: "text" },
      messages: [{ role: "user", content: "Say hi in Swedish." }],
    };
    const r = await post(url, "/v1/chat/completions", bearer(NIMA), asked);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-model")).toBe("dense");
    const d = await r.json();
    expect(d.choices[0].message.content).toBe("Hej!");
    expect(last().path).toBe("/v1/chat/completions");
    expect(last().auth).toBe(`Bearer ${SGLANG_KEY}`);
    expect(last().body).toEqual({ ...asked, model: DENSE });
  });

  it("carries a tool round trip both ways unchanged", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ];
    const first = await (
      await post(url, "/v1/chat/completions", bearer(NIMA), {
        model: FLASH,
        max_tokens: 300,
        tools,
        messages: [{ role: "user", content: "Weather in Uppsala?" }],
      })
    ).json();
    const call = first.choices[0].message.tool_calls[0];
    expect(call.function).toEqual({ name: "get_weather", arguments: '{"city": "Uppsala"}' });
    const second = {
      model: FLASH,
      max_tokens: 300,
      tools,
      messages: [
        { role: "user", content: "Weather in Uppsala?" },
        first.choices[0].message,
        { role: "tool", tool_call_id: call.id, content: "sunny" },
      ],
    };
    const answer = await (await post(url, "/v1/chat/completions", bearer(NIMA), second)).json();
    expect(answer.choices[0].message.content).toBe("It is sunny in Uppsala.");
    expect(last().body).toEqual(second);
  });

  it("streams chat event for event, with no usage event the client did not ask for, and counts it", async () => {
    const r = await post(url, "/v1/chat/completions", bearer(NIMA), {
      model: FLASH,
      stream: true,
      max_tokens: 60,
      messages: [{ role: "user", content: "Count to ten." }],
    });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const raw = await r.text();
    const data = raw.split("\n\n").filter((b) => b.startsWith("data:"));
    // the role, ten numbers, the finish and [DONE]: modelgate's smoke counted 13 such lines
    expect(data.length).toBe(13);
    expect(raw).not.toContain('"choices":[]');
    expect(data.at(-1)).toBe("data: [DONE]");
    // Kvasir asked for the usage for its ledger
    expect(last().body.stream_options).toEqual({ include_usage: true });
    const row = k.ledger.rows(null, 1)[0];
    expect(row).toMatchObject({
      subject: "client:nima",
      model: FLASH,
      backend: "card",
      input_tokens: 20,
      output_tokens: 7,
      outcome: "completed",
    });
    expect(row.client_key).toMatch(/^c_/u);
    // a client that asked for usage gets its usage event
    const asked = await (
      await post(url, "/v1/chat/completions", bearer(NIMA), {
        model: FLASH,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "Count to ten." }],
      })
    ).text();
    expect(asked).toContain('"choices":[]');
  });

  it("answers Anthropic's messages with x-api-key, thinking disabled unless asked for", async () => {
    const r = await post(
      url,
      "/v1/messages",
      { "x-api-key": NIMA, "anthropic-version": "2023-06-01" },
      {
        model: FLASH,
        max_tokens: 200,
        messages: [{ role: "user", content: "One word: capital of Sweden?" }],
      },
    );
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.content.filter((c: { type: string }) => c.type === "text")[0].text).toBe("Stockholm");
    expect(last().path).toBe("/v1/messages");
    expect(last().body.thinking).toEqual({ type: "disabled" });
    // the client's own anthropic-version reaches the backend; its key does not
    expect(last().apiKey).toBe("");
    const thinking = { type: "enabled", budget_tokens: 1024 };
    await post(
      url,
      "/v1/messages",
      { "x-api-key": NIMA },
      { model: FLASH, max_tokens: 2000, thinking, messages: [{ role: "user", content: "Think." }] },
    );
    expect(last().body.thinking).toEqual(thinking);
    // streamed: Anthropic's named events as they came, and the counts in the ledger
    const streamed = await (
      await post(
        url,
        "/v1/messages",
        { "x-api-key": NIMA },
        { model: FLASH, max_tokens: 200, stream: true, messages: [{ role: "user", content: "Capital?" }] },
      )
    ).text();
    expect(streamed).toContain("event: message_start\n");
    expect(streamed).toContain('"text":"holm"');
    expect(k.ledger.rows(null, 1)[0]).toMatchObject({
      input_tokens: 15,
      output_tokens: 3,
      cache_read_tokens: 5,
    });
    // a tool offered on Anthropic's shape comes back as tool_use
    const tool = await (
      await post(
        url,
        "/v1/messages",
        { "x-api-key": NIMA },
        {
          model: FLASH,
          max_tokens: 200,
          tools: [{ name: "get_weather", input_schema: { type: "object" } }],
          messages: [{ role: "user", content: "Weather?" }],
        },
      )
    ).json();
    expect(tool.content[0]).toMatchObject({ type: "tool_use", name: "get_weather" });
  });

  it("passes count_tokens, completions and responses", async () => {
    const counted = await post(
      url,
      "/v1/messages/count_tokens",
      { "x-api-key": NIMA },
      { model: FLASH, messages: [{ role: "user", content: "How many?" }] },
    );
    expect(await counted.json()).toEqual({ input_tokens: 42 });
    expect(last().body).not.toHaveProperty("thinking");
    const done = await (
      await post(url, "/v1/completions", bearer(NIMA), { model: FLASH, prompt: "Capital:", max_tokens: 3 })
    ).json();
    expect(done.choices[0].text).toBe(" Stockholm");
    expect(k.ledger.rows(null, 1)[0].outcome).toBe("capped");
    const resp = await (
      await post(url, "/v1/responses", bearer(NIMA), { model: FLASH, input: "Hej?", max_output_tokens: 20 })
    ).json();
    expect(resp.output[0].content[0].text).toBe("Hej");
    const streamed = await (
      await post(url, "/v1/responses", bearer(NIMA), { model: FLASH, input: "Hej?", stream: true })
    ).text();
    expect(streamed).toContain("event: response.completed");
    expect(k.ledger.rows(null, 1)[0]).toMatchObject({ input_tokens: 11, output_tokens: 2 });
  });

  it("refuses a request that cannot fit the model's context before the backend is asked", async () => {
    const before = seen.length;
    const over = await post(url, "/v1/chat/completions", bearer(NIMA), {
      model: "dense",
      max_tokens: 40_000,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(over.status).toBe(400);
    const e = await over.json();
    expect(e.error.code).toBe("context_length_exceeded");
    expect(e.error.message).toContain("32768");
    const long = await post(
      url,
      "/v1/messages",
      { "x-api-key": NIMA },
      { model: "dense", max_tokens: 8_000, messages: [{ role: "user", content: "word ".repeat(200_000) }] },
    );
    expect(long.status).toBe(400);
    expect((await long.json()).error.type).toBe("invalid_request_error");
    expect(seen.length).toBe(before);
    expect(k.ledger.rows(null, 1)[0].outcome).toBe("refused");
    // what fits goes on
    const fits = await post(url, "/v1/chat/completions", bearer(NIMA), {
      model: "dense",
      max_tokens: 8_000,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(fits.status).toBe(200);
    // an image is not text
    expect(
      estimateInput(
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(600_000)}` } },
              ],
            },
          ],
        },
        "chat-completions",
      ),
    ).toBeLessThan(10);
  });

  it("serves both shapes on the old /v1/messages, and pi-messages on /v1/pi/messages", async () => {
    // the NILS assistant's shape, through pi's own client with the catalog's base
    const catalog = await (await fetch(`${url}/v1/config`, { headers: bearer(ADMIN) })).json();
    expect(catalog.baseUrl).toBe("http://kvasir.test/v1/pi");
    const pi = async (base: string) => {
      let text = "";
      for await (const ev of piStream(
        piModel(base, FLASH),
        { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
        { apiKey: ADMIN },
      )) {
        if (ev.type === "text_delta") text += ev.delta;
        if (ev.type === "error") throw new Error(ev.error.errorMessage);
      }
      return text;
    };
    expect(await pi(`${url}/v1/pi`)).toBe("1 2 3 4 5 6 7 8 9 10");
    expect(last().path).toBe("/v1/chat/completions");
    // the old path: a pi body is pi-messages, and says where it moved
    const old = await post(url, "/v1/messages", bearer(ADMIN), {
      model: FLASH,
      context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
    });
    expect(old.headers.get("deprecation")).toBe("true");
    expect(old.headers.get("link")).toContain("/v1/pi/messages");
    expect(await old.text()).toContain('"type":"done"');
    expect(await pi(`${url}/v1`)).toBe("1 2 3 4 5 6 7 8 9 10");
    // and an Anthropic body is Anthropic's
    const anthropic = await post(url, "/v1/messages", bearer(ADMIN), {
      model: FLASH,
      max_tokens: 10,
      messages: [{ role: "user", content: "Capital?" }],
    });
    expect((await anthropic.json()).type).toBe("message");
    expect(last().path).toBe("/v1/messages");
    // the rule
    expect(piShaped(JSON.stringify({ model: "m", context: { messages: [] } }))).toBe(true);
    expect(piShaped(JSON.stringify({ model: "m", messages: [], max_tokens: 1 }))).toBe(false);
    expect(piShaped("not json")).toBe(false);
    // a client key keeps to Anthropic's shape there
    const client = await post(url, "/v1/messages", bearer(NIMA), {
      model: FLASH,
      context: { messages: [] },
    });
    expect(client.status).toBe(403);
  });

  it("keeps a client key to the doors meant for clients", async () => {
    for (const [method, path] of [
      ["GET", "/v1/config"],
      ["GET", "/v1/keys"],
      ["GET", "/v1/clients"],
      ["GET", "/v1/ledger"],
      ["POST", "/v1/pi/messages"],
    ]) {
      const r = await fetch(`${url}${path}`, { method, headers: bearer(NIMA) });
      expect([r.status, (await r.json()).error.code], path).toEqual([403, "not_public"]);
    }
  });
});

function piModel(base: string, id: string): Model<"pi-messages"> {
  return {
    id,
    name: id,
    api: "pi-messages",
    provider: "kvasir" as never,
    baseUrl: base,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 4096,
  };
}

describe("client keys", () => {
  it("adds, imports again without doubling, scopes, revokes at once, and adds up the ledger per key", async () => {
    const seen: Seen[] = [];
    const sg = await fakeSGLang(seen);
    closers.push(() => sg.server.close());
    const { k, url, dir } = await kvasir(sg.url);
    const file = modelgateKeys(dir, { nima: "old-nima", droid: "old-droid" });
    expect(k.clients.importModelgate(file, "test")).toEqual({ added: 2, present: 0, skipped: 1 });
    expect(k.clients.importModelgate(file, "test")).toEqual({ added: 0, present: 2, skipped: 1 });
    // a key through the door that changes Kvasir, shown once, scoped to one model and no swap
    const made = await (
      await post(url, "/v1/clients", bearer(ADMIN), { name: "script", models: ["dense"], swap: false })
    ).json();
    expect(made).toMatchObject({ name: "script", models: ["dense"], swap: false, shown: "once" });
    expect(made.key).toMatch(/^kvc_/u);
    const listed = await (await fetch(`${url}/v1/models`, { headers: bearer(made.key) })).json();
    expect(listed.data.map((m: { id: string }) => m.id)).toEqual(["dense"]);
    const other = await post(url, "/v1/chat/completions", bearer(made.key), {
      model: FLASH,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect([other.status, (await other.json()).error.code]).toEqual([403, "model_not_allowed"]);
    // served by its own name
    const own = await post(url, "/v1/chat/completions", bearer(made.key), {
      model: DENSE,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(own.status).toBe(200);
    // the door that makes keys is kvasir:work's
    expect((await post(url, "/v1/clients", bearer("old-nima"), { name: "x" })).status).toBe(403);
    // revoked: refused on the next request
    const before = await post(url, "/v1/chat/completions", bearer("old-droid"), {
      model: FLASH,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(before.status).toBe(200);
    const droid = k.clients.list().find((c) => c.name === "droid");
    expect(
      (await fetch(`${url}/v1/clients/${droid?.id}`, { method: "DELETE", headers: bearer(ADMIN) })).status,
    ).toBe(204);
    const after = await post(
      url,
      "/v1/chat/completions",
      { "x-api-key": "old-droid" },
      {
        model: FLASH,
        messages: [{ role: "user", content: "Hi" }],
      },
    );
    expect([after.status, (await after.json()).error.message]).toEqual([401, "this key was revoked"]);
    // the ledger per key, in counts
    const clients = (await (await fetch(`${url}/v1/clients`, { headers: bearer(ADMIN) })).json()).clients;
    const byName = Object.fromEntries(clients.map((c: { name: string }) => [c.name, c]));
    expect(byName.droid.revoked_at).not.toBeNull();
    expect(byName.droid.usage).toMatchObject({ streams: 1, input: 20, output: 7 });
    expect(byName.script.usage).toMatchObject({ streams: 2, refused: 1 });
    expect(byName.nima.usage).toBeNull();
    expect(JSON.stringify(clients)).not.toMatch(/old-|kvc_|[0-9a-f]{64}/u);
    // rows past the ledger's days are let go, NILS's own rows kept
    k.store.db.prepare("UPDATE ledger SET at = ?").run(Date.now() - 91 * 86_400_000);
    k.ledger.record({
      subject: "anna@lab",
      purpose: null,
      model: FLASH,
      backend: "card",
      grantId: null,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      gpuSeconds: 0,
      money: 0,
      ttftMs: null,
      totalMs: null,
      outcome: "completed",
    });
    k.store.db
      .prepare("UPDATE ledger SET at = ? WHERE subject = 'anna@lab'")
      .run(Date.now() - 91 * 86_400_000);
    expect(k.ledger.prune(90)).toBe(3);
    expect(k.ledger.rows(null, 10).map((r) => r.subject)).toEqual(["anna@lab"]);
  });

  it("works from the command line: import, add, list and revoke", async () => {
    const seen: Seen[] = [];
    const sg = await fakeSGLang(seen);
    closers.push(() => sg.server.close());
    const { url, dir, config } = await kvasir(sg.url);
    const cli = (...args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((done) => {
        execFile(
          join(process.cwd(), "node_modules", ".bin", "vite-node"),
          [join(process.cwd(), "src", "main.ts"), "keys", ...args, "--config", config],
          { timeout: 60_000, env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") } },
          (error, out, err) => done({ code: error ? Number(error.code ?? 1) : 0, out, err }),
        );
      });
    const file = modelgateKeys(dir, { nima: "the-old-key" });
    const imported = await cli("import", "--modelgate", file);
    expect(imported.code, imported.err).toBe(0);
    expect(imported.out).toContain("imported 1 key(s)");
    const added = await cli("add", "--name", "droid", "--models", FLASH, "--no-swap");
    expect(added.code, added.err).toBe(0);
    const secret = added.out.trim();
    expect(secret).toMatch(/^kvc_[A-Za-z0-9_-]{43}$/u);
    // the server on the same database takes both at once
    for (const key of ["the-old-key", secret]) {
      const r = await post(url, "/v1/chat/completions", bearer(key), {
        model: FLASH,
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(r.status, key.slice(0, 4)).toBe(200);
    }
    const list = await cli("list");
    expect(list.out).toContain("nima  client (modelgate)  every model  swap");
    expect(list.out).toContain(`droid  client (minted)  ${FLASH}  no swap`);
    expect(list.out).toMatch(/nima .* 90 d: 1 stream\(s\), 20 in, 7 out/u);
    expect(list.out).not.toContain(secret);
    const revoked = await cli("revoke", "--name", "nima");
    expect(revoked.code, revoked.err).toBe(0);
    const r = await fetch(`${url}/v1/models`, { headers: bearer("the-old-key") });
    expect(r.status).toBe(401);
  }, 90_000);
});

describe("the doors' surfaces", () => {
  it("keeps a silent stream open with comments, and answers only the public doors on the public listener", async () => {
    const seen: Seen[] = [];
    const sg = await fakeSGLang(seen, { silentMs: 700 });
    closers.push(() => sg.server.close());
    const { k, url } = await kvasir(sg.url);
    const raw = await (
      await post(url, "/v1/chat/completions", bearer(ADMIN), {
        model: FLASH,
        stream: true,
        messages: [{ role: "user", content: "Read this long prompt." }],
      })
    ).text();
    const blocks = raw.split("\n\n").filter(Boolean);
    expect(blocks.filter((b) => b === ": ping").length).toBeGreaterThanOrEqual(3);
    expect(blocks.at(-1)).toBe("data: [DONE]");
    const outside = await listenPublic(k, "127.0.0.1:0");
    expect((await fetch(`${outside}/v1/keys`, { headers: bearer(ADMIN) })).status).toBe(404);
    expect((await fetch(`${outside}/healthz`)).status).toBe(404);
    expect((await fetch(`${outside}/metrics`)).status).toBe(404);
    expect((await fetch(`${outside}/v1/models`, { headers: bearer(ADMIN) })).status).toBe(200);
    // the internal listener keeps every door
    expect((await fetch(`${url}/v1/keys`, { headers: bearer(ADMIN) })).status).toBe(200);
  });

  it("reads the public doors from kvasir.json", () => {
    const base = { bind: "127.0.0.1:1", origin: "http://x" };
    expect(parse(JSON.stringify(base)).public.doors).toContain("POST /v1/messages");
    expect(
      parse(JSON.stringify({ ...base, public: { bind: "0.0.0.0:30000", doors: ["GET /v1/models"] } })).public,
    ).toEqual({
      bind: "0.0.0.0:30000",
      doors: ["GET /v1/models"],
    });
    expect(() => parse(JSON.stringify({ ...base, public: { doors: ["/v1/models"] } }))).toThrow(
      /METHOD \/path/u,
    );
    expect(parse(JSON.stringify(base)).clients.ledgerDays).toBe(90);
  });
});
