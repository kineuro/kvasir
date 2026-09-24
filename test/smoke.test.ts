// SPDX-License-Identifier: AGPL-3.0-only
// Record 47 integrated: modelgate's smoke sequence end to end against Kvasir
// serving a card of two fake SGLang servers behind a fake Docker that takes its
// time to start a model. The model list, a chat, a tool round trip, a stream,
// Anthropic's messages and count_tokens, then a swap behind one request, where
// the client has its headers long before the model is up, both on a stream
// (`: queued`) and on a whole answer (a newline a JSON parser skips), so
// neither a client nor Node's fetch, which gives up on headers after 300
// seconds, ends a swap of minutes. A key imported from modelgate works, a key
// made with --no-swap is refused a request that would swap, and a revoked key
// is refused.

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CardTimes, DockerDriver, type Exec } from "../src/card.js";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen, listenPublic } from "../src/server.js";
import { serve } from "./fake.js";

const FLASH = "qwen3.8-flash-next";
const DENSE = "qwen38-27b";
/** How long the fake Docker takes to bring the dense model up: longer than the first heartbeat and the whole answer's wait. */
const START_MS = 2_500;

interface Seen {
  model: string;
  path: string;
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

/** One SGLang server serving one model: OpenAI chat with tools, whole and streamed, and Anthropic messages and count_tokens. */
async function fakeSGLang(served: string, seen: Seen[]) {
  return serve((req: IncomingMessage, res: ServerResponse, text: string) => {
    const body = text ? JSON.parse(text) : {};
    seen.push({ model: served, path: req.url ?? "", body });
    if (body.model !== served) return whole(res, 404, { error: `no model ${body.model}` });
    // an answer refused as SGLang refuses one, whole and in JSON, whatever the request asked
    if (body.max_tokens === 13)
      return whole(res, 400, { error: { message: "bad max_tokens", type: "invalid_request_error" } });
    // headers of one hop, and of the server's own, beside one of the answer's
    if (body.messages?.[0]?.content === "Hop.") {
      res.setHeader("set-cookie", "sid=the-servers-own");
      res.setHeader("x-hop", "one hop only");
      res.setHeader("connection", "x-hop");
      res.setHeader("x-served-by", served);
    }
    const usage = { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 };
    if (req.url === "/v1/chat/completions") {
      const last = (body.messages as { role: string; content: unknown }[]).at(-1);
      const call = Array.isArray(body.tools) && body.tools.length > 0 && last?.role === "user";
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
            content:
              last?.role === "tool" ? `It is ${String(last.content)} in Uppsala.` : `Hej from ${served}`,
          };
      if (!body.stream)
        return whole(res, 200, {
          id: "c1",
          object: "chat.completion",
          model: served,
          choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }],
          usage,
        });
      const chunk = (delta: unknown, finish: string | null = null) => ({
        id: "c1",
        object: "chat.completion.chunk",
        model: served,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const events: unknown[] = [chunk({ role: "assistant", content: "" })];
      for (const n of ["1", " 2", " 3"]) events.push(chunk({ content: n }));
      events.push(chunk({}, "stop"));
      if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage)
        events.push({ id: "c1", object: "chat.completion.chunk", model: served, choices: [], usage });
      events.push("[DONE]");
      return sse(res, events);
    }
    if (req.url === "/v1/messages/count_tokens") return whole(res, 200, { input_tokens: 42 });
    if (req.url === "/v1/messages")
      return whole(res, 200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: served,
        content: [{ type: "text", text: "Stockholm" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 15, output_tokens: 3 },
      });
    whole(res, 404, { error: "no such path" });
  });
}

/** A fake Docker: containers by name, each healthy `startMs` after it was started, every start and stop recorded. */
function fakeDocker(startMs: Record<string, number>, running: string[]) {
  const moves: string[] = [];
  const up = new Map<string, number>(running.map((n) => [n, 0]));
  const exec: Exec = async (args) => {
    const name = args.at(-1) as string;
    if (args[0] === "inspect") return { code: 0, out: up.has(name) ? "true" : "false" };
    // `docker start` on a running container changes nothing, and is not a move
    if (args[0] === "start" && !up.has(name)) {
      moves.push(`start ${name}`);
      up.set(name, Date.now() + (startMs[name] ?? 0));
    }
    if (args[0] === "stop" && up.delete(name)) moves.push(`stop ${name}`);
    return { code: 0, out: name };
  };
  const byUrl = new Map<string, string>();
  const probe = async (url: string) => {
    const name = byUrl.get(url.replace(/\/health$/u, ""));
    return name !== undefined && up.has(name) && Date.now() >= (up.get(name) ?? 0);
  };
  return {
    moves,
    driver: new DockerDriver(exec, probe),
    upstream: (u: string, n: string) => byUrl.set(u, n),
  };
}

const times: CardTimes = {
  minResidencyMs: 0,
  idleReturnMs: 600_000,
  drainTimeoutMs: 5_000,
  startTimeoutMs: 20_000,
  queueTimeoutMs: 30_000,
  pollMs: 50,
  idleCheckMs: 60_000,
};

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const post = (url: string, path: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** A POST whose response headers are timed apart from its body. */
function timed(
  url: string,
  path: string,
  key: string,
  body: unknown,
): Promise<{
  headersMs: number;
  status: number;
  headers: Record<string, unknown>;
  text: string;
  totalMs: number;
}> {
  const t0 = Date.now();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = request(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    });
    r.on("response", (res) => {
      const headersMs = Date.now() - t0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          headersMs,
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
          totalMs: Date.now() - t0,
        }),
      );
    });
    r.on("error", reject);
    r.end(payload);
  });
}

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

describe("modelgate's smoke sequence through a card", () => {
  const seen: Seen[] = [];
  let k: Kvasir;
  let url = "";
  let docker: ReturnType<typeof fakeDocker>;
  const NIMA = "a-key-nima-held-from-modelgate";
  let droid = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "kvasir-smoke-"));
    const flash = await fakeSGLang(FLASH, seen);
    const dense = await fakeSGLang(DENSE, seen);
    closers.push(
      () => flash.server.close(),
      () => dense.server.close(),
    );
    docker = fakeDocker({ "sgl-next": START_MS, "sgl-27b": START_MS }, ["sgl-next"]);
    docker.upstream(flash.url, "sgl-next");
    docker.upstream(dense.url, "sgl-27b");
    const spec = (concurrency: number) => ({
      context_length: 262_144,
      max_output_tokens: 65_536,
      max_concurrent_requests: concurrency,
      capabilities: { tools: true, reasoning: true, vision: true },
      license: "test",
    });
    const config = parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: { mode: "token", tokens: {} },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: false },
        cards: [
          {
            id: "card0",
            note: "one card, one model at a time",
            models: [
              {
                id: FLASH,
                aliases: ["flash-next"],
                container: "sgl-next",
                upstream: flash.url,
                default: true,
                spec: spec(4),
              },
              {
                id: DENSE,
                aliases: ["qwen38-27b-fast"],
                container: "sgl-27b",
                upstream: dense.url,
                spec: spec(8),
              },
            ],
          },
        ],
      }),
    );
    k = build(config, {
      keepAliveMs: 200,
      wholeHeadersAfterMs: 300,
      cardDriver: () => docker.driver,
      cardTimes: () => times,
    });
    closers.push(() => k.close());
    url = await listen(k, "127.0.0.1:0");
    await k.cards.start();
    // today's keys, imported from modelgate's file, and a key made with --no-swap
    const file = join(dir, "modelgate-keys");
    writeFileSync(file, `nima ${createHash("sha256").update(NIMA).digest("hex")}\n`);
    expect(k.clients.importModelgate(file, "test").added).toBe(1);
    droid = k.clients.add("droid", { swap: false, by: "test" }).secret;
  });

  it("refuses no key, and answers /health to anyone, on the public listener too", async () => {
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
    const h = await fetch(`${url}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: "ok", loaded: FLASH, state: "ready" });
    // /health is one of the public doors by default, for the edge's probe
    const outside = await listenPublic(k, "127.0.0.1:0");
    expect((await fetch(`${outside}/health`)).status).toBe(200);
    expect((await fetch(`${outside}/healthz`)).status).toBe(404);
  });

  it("lists the models in modelgate's shape, with specs, aliases, loaded and cold", async () => {
    const d = await (await fetch(`${url}/v1/models`, { headers: bearer(NIMA) })).json();
    expect(d.server).toMatchObject({ state: "ready", loaded: FLASH, note: "one card, one model at a time" });
    expect(
      d.data.map((m: { id: string; status: string; default: boolean }) => [m.id, m.status, m.default]),
    ).toEqual([
      [FLASH, "loaded", true],
      [DENSE, "cold", false],
    ]);
    expect(d.data[0]).toMatchObject({
      aliases: ["flash-next"],
      context_length: 262_144,
      max_output_tokens: 65_536,
      max_concurrent_requests: 4,
      capabilities: { tools: true, reasoning: true, vision: true },
      apis: expect.arrayContaining(["openai /v1/chat/completions", "anthropic /v1/messages"]),
      card: "card0",
      license: "test",
    });
    // no model card of contracts/model/v1: a served SGLang model has no weights digest to name
    expect(JSON.stringify(d)).not.toMatch(/digest/u);
    const one = await (await fetch(`${url}/v1/models/qwen38-27b-fast`, { headers: bearer(NIMA) })).json();
    expect(one).toMatchObject({ id: DENSE, status: "cold", default: false });
  });

  it("answers a chat, a tool round trip, a stream, Anthropic's messages and count_tokens on the loaded model", async () => {
    const chat = await post(url, "/v1/chat/completions", bearer(NIMA), {
      model: "flash-next",
      max_tokens: 40,
      messages: [{ role: "user", content: "Say hi in Swedish." }],
    });
    expect(chat.status).toBe(200);
    expect(chat.headers.get("x-model")).toBe(FLASH);
    expect((await chat.json()).choices[0].message.content).toBe(`Hej from ${FLASH}`);
    expect(seen.at(-1)?.body.model).toBe(FLASH);

    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ];
    const ask = [{ role: "user", content: "Weather in Uppsala?" }];
    const first = await (
      await post(url, "/v1/chat/completions", bearer(NIMA), { model: FLASH, tools, messages: ask })
    ).json();
    const call = first.choices[0].message.tool_calls[0];
    expect(call.function).toEqual({ name: "get_weather", arguments: '{"city": "Uppsala"}' });
    const second = await (
      await post(url, "/v1/chat/completions", bearer(NIMA), {
        model: FLASH,
        tools,
        messages: [
          ...ask,
          first.choices[0].message,
          { role: "tool", tool_call_id: call.id, content: "12 degrees" },
        ],
      })
    ).json();
    expect(second.choices[0].message.content).toBe("It is 12 degrees in Uppsala.");
    // the tool definitions went as the client sent them
    expect(seen.at(-1)?.body.tools).toEqual(tools);

    const stream = await post(url, "/v1/chat/completions", bearer(NIMA), {
      model: FLASH,
      stream: true,
      messages: [{ role: "user", content: "Count to three." }],
    });
    const raw = await stream.text();
    const data = raw.split("\n\n").filter((b) => b.startsWith("data:"));
    expect(data.at(-1)).toBe("data: [DONE]");
    // include_usage was asked of SGLang for the ledger, and its usage-only event kept from the client
    expect(seen.at(-1)?.body.stream_options).toEqual({ include_usage: true });
    expect(raw).not.toContain('"choices":[]');
    const row = k.ledger.rows(null, 1)[0];
    expect(row).toMatchObject({ model: FLASH, input_tokens: 20, output_tokens: 7, outcome: "completed" });

    const messages = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": NIMA, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: FLASH,
        max_tokens: 200,
        messages: [{ role: "user", content: "One word: capital of Sweden?" }],
      }),
    });
    expect(messages.status).toBe(200);
    expect((await messages.json()).content[0].text).toBe("Stockholm");
    expect(seen.at(-1)?.body.thinking).toEqual({ type: "disabled" });

    const counted = await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": NIMA },
      body: JSON.stringify({ model: FLASH, messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(await counted.json()).toEqual({ input_tokens: 42 });
    expect(docker.moves).toEqual([]);
  });

  it("refuses a no-swap key a request that would swap, with 409, and swaps nothing", async () => {
    const r = await post(url, "/v1/chat/completions", bearer(droid), {
      model: DENSE,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(r.status).toBe(409);
    const e = (await r.json()).error;
    expect(e.code).toBe("would_swap");
    expect(e.message).toMatch(/may not cause a swap/u);
    // the loaded model it may use
    const ok = await post(url, "/v1/chat/completions", bearer(droid), {
      model: FLASH,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(ok.status).toBe(200);
    expect(docker.moves).toEqual([]);
  });

  it("waits out a swap behind one stream, its headers and `: queued` long before the model is up", async () => {
    const r = await timed(url, "/v1/chat/completions", NIMA, {
      model: "qwen38-27b-fast",
      stream: true,
      messages: [{ role: "user", content: "Count." }],
    });
    expect(r.status).toBe(200);
    // the first `: queued` is due one second into the wait, so the headers come a second before the model
    // is up (a beat once slipped to the second second, and these bounds met at 2001 ms)
    expect(r.headersMs).toBeLessThan(START_MS - 500);
    expect(r.totalMs).toBeGreaterThanOrEqual(START_MS);
    expect(r.totalMs - r.headersMs).toBeGreaterThanOrEqual(500);
    expect(r.text.startsWith(": queued\n\n")).toBe(true);
    expect(r.text).toContain('"content":" 3"');
    expect(r.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(docker.moves).toEqual(["stop sgl-next", "start sgl-27b"]);
    expect(seen.at(-1)?.model).toBe(DENSE);
    const listed = await (await fetch(`${url}/v1/models`, { headers: bearer(NIMA) })).json();
    expect(listed.server.loaded).toBe(DENSE);
  });

  it("waits out a swap behind one whole answer, its headers early and its body still JSON", async () => {
    docker.moves.length = 0;
    // the default is up again after START_MS of its own
    const r = await timed(url, "/v1/chat/completions", NIMA, {
      model: FLASH,
      messages: [{ role: "user", content: "Say hi in Swedish." }],
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headersMs).toBeLessThan(1_000);
    expect(r.text.startsWith("\n")).toBe(true);
    expect(JSON.parse(r.text).choices[0].message.content).toBe(`Hej from ${FLASH}`);
    expect(docker.moves).toEqual(["stop sgl-27b", "start sgl-next"]);
  });

  it("passes a backend's refusal after early stream headers as an error event, not a bare body", async () => {
    // the dense model is cold again: the stream waits for the swap, then SGLang refuses it in JSON
    const r = await timed(url, "/v1/chat/completions", NIMA, {
      model: DENSE,
      stream: true,
      max_tokens: 13,
      messages: [{ role: "user", content: "Count." }],
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/event-stream");
    expect(r.headersMs).toBeLessThan(START_MS - 500);
    const events = r.text.split("\n\n").filter((b) => b.startsWith("data:"));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].slice(5)).error.message).toBe("bad max_tokens");
    expect(r.text).not.toMatch(/^\{/mu);
  });

  it("keeps the backend's cookie and the headers of one hop from the client", async () => {
    const r = await post(url, "/v1/chat/completions", bearer(NIMA), {
      model: DENSE,
      messages: [{ role: "user", content: "Hop." }],
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-served-by")).toBe(DENSE);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-hop")).toBeNull();
    await r.body?.cancel();
  });

  it("refuses a revoked key", async () => {
    const [nima] = k.clients.named("nima");
    expect(k.clients.revoke(nima.id)).toBe(true);
    const r = await fetch(`${url}/v1/models`, { headers: bearer(NIMA) });
    expect(r.status).toBe(401);
    const refused = await post(url, "/v1/chat/completions", bearer(NIMA), {
      model: FLASH,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(refused.status).toBe(401);
  });
});
