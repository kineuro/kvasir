// SPDX-License-Identifier: AGPL-3.0-only
// C1, the call cap at the door: a call that names no longest answer is held to
// its model's, one that names more is held to it, and kvasir.json's maxTokens
// holds a backend's models lower without changing the catalog; a client that
// goes away stops its call upstream, and the ledger row says so with the
// tokens given until then. Every door: pi-messages, the chat door through
// pi-ai, and the chat door passed through as it came.

import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { chunk, hold, serve } from "./fake.js";

const TOKEN = "a-kvasir-token";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

interface Upstream {
  url: string;
  /** The bodies the upstream received, in order. */
  seen: Record<string, unknown>[];
  /** How many streams the upstream saw end before their answer was done. */
  cut: number;
}

/**
 * A fake OpenAI-shaped model server that keeps what it received. A prompt of
 * "long" is answered at its longest answer (finish_reason length, as SGLang
 * says); "slow" streams one token every 20 ms until its client goes away.
 */
async function upstream(): Promise<Upstream> {
  const u: Upstream = { url: "", seen: [], cut: 0 };
  const s = await serve((_req: IncomingMessage, res: ServerResponse, text: string) => {
    const body = JSON.parse(text) as Record<string, unknown>;
    u.seen.push(body);
    const last = String((body.messages as { content: unknown }[]).at(-1)?.content ?? "");
    const limit = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (last === "slow") {
      let n = 0;
      const timer = setInterval(
        () => res.write(`data: ${JSON.stringify(chunk({ content: `t${n++} ` }))}\n\n`),
        20,
      );
      res.on("close", () => {
        clearInterval(timer);
        if (!res.writableEnded) u.cut += 1;
      });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
      return;
    }
    const capped = last === "long";
    const usage = {
      prompt_tokens: 9,
      completion_tokens: capped ? limit : 2,
      total_tokens: 9 + (capped ? limit : 2),
    };
    for (const e of [
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hej" }),
      chunk({}, capped ? "length" : "stop", usage),
    ])
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  closers.push(() => s.server.close());
  u.url = s.url;
  return u;
}

function backend(url: string, id: string, passThrough: boolean) {
  return {
    id,
    kind: "openai-completions",
    baseUrl: `${url}/v1`,
    locality: "local",
    concurrency: 4,
    warmup: false,
    ...(passThrough ? { passThrough: ["chat-completions"] } : {}),
    models: [
      {
        id: `${id}-model`,
        name: id,
        reasoning: false,
        input: ["text"],
        contextWindow: 262_144,
        maxTokens: 65_536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

async function kvasir(
  backends: unknown[],
  over: Record<string, unknown> = {},
): Promise<{ k: Kvasir; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-cap-"));
  const k = build(
    parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: { mode: "token", tokens: { [TOKEN]: "anna@lab:kvasir:work" } },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: false },
        ...over,
      }),
    ),
    { keepAliveMs: 100 },
  );
  hold(k, backends);
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

const post = (url: string, path: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal,
  });

const pi = (model: string, text: string, options: Record<string, unknown> = {}) => ({
  model,
  context: { messages: [{ role: "user", content: text, timestamp: Date.now() }] },
  options,
});

const chat = (model: string, text: string, extra: Record<string, unknown> = {}) => ({
  model,
  stream: true,
  messages: [{ role: "user", content: text }],
  ...extra,
});

async function until(what: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("waited too long");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The ledger's last row. */
const lastRow = (k: Kvasir) => k.ledger.rows(null, 1)[0] as Record<string, unknown>;

describe("a call's longest answer, held at the door (C1)", () => {
  it("is the model's where a pi-messages call names none, and never more than it", async () => {
    const up = await upstream();
    const { k, url } = await kvasir([backend(up.url, "translated", false)]);
    await (await post(url, "/v1/pi/messages", pi("translated-model", "Hi"))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(65_536);
    await (await post(url, "/v1/pi/messages", pi("translated-model", "Hi", { maxTokens: 500_000 }))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(65_536);
    await (await post(url, "/v1/pi/messages", pi("translated-model", "Hi", { maxTokens: 300 }))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(300);
    // the answer cut at it says so, as the server said it
    const cut = await (await post(url, "/v1/pi/messages", pi("translated-model", "long"))).text();
    expect(cut).toContain('"reason":"length"');
    expect(lastRow(k)).toMatchObject({ outcome: "capped", output_tokens: 65_536 });
  });

  it("is the model's where a chat call through pi-ai names none, and never more than it", async () => {
    const up = await upstream();
    const { k, url } = await kvasir([backend(up.url, "translated", false)]);
    await (await post(url, "/v1/chat/completions", chat("translated-model", "Hi"))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(65_536);
    await (
      await post(url, "/v1/chat/completions", chat("translated-model", "Hi", { max_tokens: 100_000 }))
    ).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(65_536);
    await (
      await post(url, "/v1/chat/completions", chat("translated-model", "Hi", { max_tokens: 40 }))
    ).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(40);
    const cut = await (await post(url, "/v1/chat/completions", chat("translated-model", "long"))).text();
    expect(cut).toContain('"finish_reason":"length"');
    expect(lastRow(k).outcome).toBe("capped");
  });

  it("is the model's where a passed-through chat call names none, and a call's own is held to it", async () => {
    const up = await upstream();
    const { k, url } = await kvasir([backend(up.url, "native", true)]);
    await (await post(url, "/v1/chat/completions", chat("native-model", "Hi"))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(65_536);
    await (
      await post(url, "/v1/chat/completions", chat("native-model", "Hi", { max_completion_tokens: 100_000 }))
    ).text();
    expect(up.seen.at(-1)?.max_completion_tokens).toBe(65_536);
    expect(up.seen.at(-1)?.max_tokens).toBeUndefined();
    await (await post(url, "/v1/chat/completions", chat("native-model", "Hi", { max_tokens: 40 }))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(40);
    const cut = await (await post(url, "/v1/chat/completions", chat("native-model", "long"))).text();
    expect(cut).toContain('"finish_reason":"length"');
    expect(lastRow(k).outcome).toBe("capped");
  });

  it("leaves a long prompt room in the context where the call names none", async () => {
    const up = await upstream();
    const { url } = await kvasir([backend(up.url, "native", true)]);
    // 1,200,000 bytes: at least 200,000 tokens of the 262,144, so the default is what is left
    const prompt = "word ".repeat(240_000);
    await (await post(url, "/v1/chat/completions", chat("native-model", prompt))).text();
    const sent = Number(up.seen.at(-1)?.max_tokens);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(262_144 - 200_000);
  });

  it("is held lower for a backend kvasir.json names, and the catalog keeps its own", async () => {
    const up = await upstream();
    const { k, url } = await kvasir([backend(up.url, "native", true), backend(up.url, "translated", false)], {
      maxTokens: { native: 16_384, translated: 1_000 },
    });
    await (await post(url, "/v1/chat/completions", chat("native-model", "Hi"))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(16_384);
    await (
      await post(url, "/v1/chat/completions", chat("native-model", "Hi", { max_tokens: 30_000 }))
    ).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(16_384);
    await (await post(url, "/v1/pi/messages", pi("translated-model", "Hi"))).text();
    expect(up.seen.at(-1)?.max_tokens).toBe(1_000);
    const list = await (
      await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json();
    expect(list.data.find((m: { id: string }) => m.id === "native-model").max_output_tokens).toBe(16_384);
    // the held entry is the catalog's, unchanged
    expect(k.backends.get("native")?.config.models[0].maxTokens).toBe(65_536);
  });

  it("is a whole number of tokens by backend id in kvasir.json, or the file is refused", () => {
    const base = { bind: "127.0.0.1:0", origin: "http://kvasir.test" };
    expect(parse(JSON.stringify(base)).maxTokens).toEqual({});
    expect(parse(JSON.stringify({ ...base, maxTokens: { card: 16_384 } })).maxTokens).toEqual({
      card: 16_384,
    });
    for (const bad of [16_384, [1], { card: 0 }, { card: 1.5 }, { card: "16384" }])
      expect(() => parse(JSON.stringify({ ...base, maxTokens: bad }))).toThrow(/maxTokens/u);
  });
});

/** A streamed call read until it has given a few tokens, then left; resolves once the client has gone. */
async function leave(url: string, path: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const r = await post(url, path, body, controller.signal);
  const reader = (r.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/t\d+ /gu) ?? []).length < 3) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the stream ended before the client left");
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => {});
}

describe("a client that goes away (C1)", () => {
  for (const [door, path, passThrough, body] of [
    ["pi-messages", "/v1/pi/messages", false, pi("translated-model", "slow")],
    ["the chat door through pi-ai", "/v1/chat/completions", false, chat("translated-model", "slow")],
    ["the chat door passed through", "/v1/chat/completions", true, chat("native-model", "slow")],
  ] as const) {
    it(`stops its call upstream, on ${door}, and the ledger says it went with the tokens so far`, async () => {
      const up = await upstream();
      const { k, url } = await kvasir([backend(up.url, passThrough ? "native" : "translated", passThrough)]);
      await leave(url, path, body);
      await until(() => up.cut === 1);
      await until(() => k.ledger.rows(null, 1).length === 1);
      const row = lastRow(k);
      expect(row.outcome).toBe("gone");
      expect(Number(row.output_tokens)).toBeGreaterThanOrEqual(3);
    });
  }
});
