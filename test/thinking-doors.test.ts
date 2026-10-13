// SPDX-License-Identifier: AGPL-3.0-only
// Thinking written as text (record 55, B6): after a swap to the 27B, its
// reasoning reached the client as the answer, in a `<thinking>` tag the splitter
// did not know, on pass-through doors the splitter did not run on. Here a card
// holds two models, the default answering plainly and the other writing its
// reasoning inline in `<thinking>`; a request for the second swaps the card, and
// every door that returns model text gives the reasoning apart from the answer,
// whole and streamed. The setting is the model's: on the same card, a model set
// to `off` keeps its text as it wrote it.

import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CardTimes, DockerDriver, type Exec } from "../src/card.js";
import { cardsOf } from "../src/card-config.js";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { apart, splitWhole, streamSplit } from "../src/split-doors.js";
import { serve } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

const THOUGHT = "The user greets in Swedish.";
const ANSWER = "Hej! Hur mår du?";
/** What the 27B wrote after the swap: its reasoning as text, in a tag its server did not separate. */
const INLINE = `<thinking>\n${THOUGHT}\n</thinking>\n\n${ANSWER}`;

/** A text in pieces of a few characters, as a model server streams it. */
function pieces(text: string, size = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sseOut(res: ServerResponse, events: unknown[], named: boolean) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    if (named && typeof e === "object") res.write(`event: ${(e as { type: string }).type}\n`);
    res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
  }
  res.end();
}

function wholeOut(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A model's own server, as SGLang without a reasoning parser: every door answers `text`, whole or streamed in pieces. */
async function modelServer(text: string) {
  const s = await serve((req: IncomingMessage, res: ServerResponse, raw: string) => {
    const body = raw ? JSON.parse(raw) : {};
    const model = String(body.model);
    if (req.url === "/v1/chat/completions") {
      const usage = { prompt_tokens: 9, completion_tokens: 20, total_tokens: 29 };
      if (!body.stream)
        return wholeOut(res, {
          id: "c1",
          object: "chat.completion",
          created: 1,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage,
        });
      const chunk = (delta: unknown, finish: string | null = null) => ({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      return sseOut(
        res,
        [
          chunk({ role: "assistant", content: "" }),
          ...pieces(text).map((p) => chunk({ content: p })),
          chunk({}, "stop"),
          "[DONE]",
        ],
        false,
      );
    }
    if (req.url === "/v1/messages") {
      const usage = { input_tokens: 9, output_tokens: 20 };
      if (!body.stream)
        return wholeOut(res, {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage,
        });
      return sseOut(
        res,
        [
          {
            type: "message_start",
            message: { id: "msg_1", type: "message", role: "assistant", model, content: [], usage },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ...pieces(text).map((p) => ({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: p },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: "noop", input: {} },
          },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
          { type: "message_stop" },
        ],
        true,
      );
    }
    if (req.url === "/v1/responses") {
      const message = {
        type: "message",
        id: "msg_9",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const r = {
        id: "resp_1",
        object: "response",
        status: "completed",
        model,
        output: [message],
        usage: { input_tokens: 9, output_tokens: 20, total_tokens: 29 },
      };
      if (!body.stream) return wholeOut(res, r);
      let seq = 0;
      const ev = (e: Record<string, unknown>) => ({ ...e, sequence_number: seq++ });
      const at = { item_id: "msg_9", output_index: 0, content_index: 0 };
      return sseOut(
        res,
        [
          ev({
            type: "response.created",
            response: { ...r, status: "in_progress", output: [], usage: null },
          }),
          ev({
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          }),
          ev({ type: "response.content_part.added", ...at, part: { type: "output_text", text: "" } }),
          ...pieces(text).map((p) => ev({ type: "response.output_text.delta", ...at, delta: p })),
          ev({ type: "response.output_text.done", ...at, text }),
          ev({ type: "response.content_part.done", ...at, part: { type: "output_text", text } }),
          ev({ type: "response.output_item.done", output_index: 0, item: message }),
          ev({ type: "response.completed", response: r }),
        ],
        true,
      );
    }
    res.writeHead(404).end();
  });
  closers.push(() => s.server.close());
  return s.url;
}

/** A fake Docker whose containers answer their health as soon as they are started. */
function fakeDocker() {
  const up = new Set<string>();
  const moves: string[] = [];
  const exec: Exec = async (args) => {
    const name = args.at(-1) as string;
    if (args[0] === "inspect") return { code: 0, out: up.has(name) ? "true" : "false" };
    moves.push(args.join(" "));
    if (args[0] === "start") up.add(name);
    if (args[0] === "stop") up.delete(name);
    return { code: 0, out: name };
  };
  const byUrl = new Map<string, string>();
  const probe = async (url: string) => up.has(byUrl.get(url.replace(/\/health$/u, "")) ?? "");
  return { driver: new DockerDriver(exec, probe), byUrl, moves };
}

const fast: CardTimes = {
  minResidencyMs: 0,
  idleReturnMs: 60_000,
  drainTimeoutMs: 5_000,
  startTimeoutMs: 10_000,
  queueTimeoutMs: 20_000,
  pollMs: 20,
  idleCheckMs: 25,
};

const spec = {
  context_length: 32_768,
  max_output_tokens: 4_096,
  max_concurrent_requests: 4,
  capabilities: { tools: true, reasoning: true, vision: false },
};

const TOKEN = "a-kvasir-token";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
}

/** A stream's events, each with its `event:` name where it had one. */
async function events(r: Response): Promise<{ name: string | null; data: Record<string, unknown> }[]> {
  const raw = await r.text();
  const out: { name: string | null; data: Record<string, unknown> }[] = [];
  for (const frame of raw.split("\n\n")) {
    const lines = frame.split("\n");
    const data = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const name =
      lines
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim() ?? null;
    out.push({ name, data: JSON.parse(data) });
  }
  return out;
}

describe("thinking written as text, after a swap, on every door", () => {
  let url = "";
  let k: Kvasir;
  const docker = fakeDocker();

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "kvasir-thinking-"));
    const flash = await modelServer(INLINE);
    const dense = await modelServer(INLINE);
    docker.byUrl.set(flash, "sgl-next");
    docker.byUrl.set(dense, "sgl-27b");
    const config = parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: { mode: "token", tokens: { [TOKEN]: "anna@lab:kvasir:work" } },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: false },
        cards: [
          {
            id: "card0",
            driver: "docker",
            // the default model's text is read as it was written: its setting, not the card's, decides
            models: [
              {
                id: "flash",
                container: "sgl-next",
                upstream: flash,
                default: true,
                spec,
                inlineReasoning: "off",
              },
              { id: "dense", container: "sgl-27b", upstream: dense, spec },
            ],
          },
        ],
      }),
    );
    k = build(config, { cardDriver: () => docker.driver, cardTimes: () => fast });
    url = await listen(k, "127.0.0.1:0");
    closers.push(() => k.close());
    await k.cards.start();
    expect(k.cards.list[0].loaded).toBe("flash");
  });

  it("swaps to the model that writes its thinking as text, and the chat door gives reasoning_content, whole", async () => {
    const r = await post(url, "/v1/chat/completions", {
      model: "dense",
      messages: [{ role: "user", content: "Hej" }],
    });
    expect(r.status).toBe(200);
    expect(k.cards.list[0].loaded).toBe("dense");
    expect(docker.moves).toEqual(["start sgl-next", "stop -t 30 sgl-next", "start sgl-27b"]);
    const d = await r.json();
    expect(d.choices[0].message).toEqual({ role: "assistant", content: ANSWER, reasoning_content: THOUGHT });
  });

  it("the chat door, streamed", async () => {
    const r = await post(url, "/v1/chat/completions", {
      model: "dense",
      stream: true,
      messages: [{ role: "user", content: "Hej" }],
    });
    const deltas = (await events(r)).map(
      (e) => (e.data.choices as { delta: Record<string, string> }[])[0]?.delta ?? {},
    );
    expect(
      deltas
        .map((d) => d.reasoning_content ?? "")
        .join("")
        .trim(),
    ).toBe(THOUGHT);
    expect(deltas.map((d) => d.content ?? "").join("")).toBe(ANSWER);
    expect(deltas.some((d) => (d.content ?? "").includes("<thinking>"))).toBe(false);
  });

  it("Anthropic's messages door gives a thinking block before the text, whole", async () => {
    const r = await post(url, "/v1/messages", {
      model: "dense",
      max_tokens: 200,
      messages: [{ role: "user", content: "Hej" }],
    });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.content).toEqual([
      { type: "thinking", thinking: THOUGHT, signature: "" },
      { type: "text", text: ANSWER },
    ]);
  });

  it("Anthropic's messages door, streamed: the blocks renumbered, the tool call after them", async () => {
    const r = await post(url, "/v1/messages", {
      model: "dense",
      max_tokens: 200,
      stream: true,
      messages: [{ role: "user", content: "Hej" }],
    });
    const es = await events(r);
    for (const e of es) expect(e.name).toBe(e.data.type);
    const starts = es
      .filter((e) => e.data.type === "content_block_start")
      .map((e) => [e.data.index, (e.data.content_block as { type: string }).type]);
    expect(starts).toEqual([
      [0, "thinking"],
      [1, "text"],
      [2, "tool_use"],
    ]);
    const stops = es.filter((e) => e.data.type === "content_block_stop").map((e) => e.data.index);
    expect(stops).toEqual([0, 1, 2]);
    const of = (t: string, key: string) =>
      es
        .filter((e) => e.data.type === "content_block_delta" && (e.data.delta as { type: string }).type === t)
        .map((e) => (e.data.delta as Record<string, string>)[key])
        .join("");
    expect(of("thinking_delta", "thinking").trim()).toBe(THOUGHT);
    expect(of("text_delta", "text")).toBe(ANSWER);
    const json = es.find((e) => (e.data.delta as { type?: string } | undefined)?.type === "input_json_delta");
    expect(json?.data.index).toBe(2);
  });

  it("OpenAI's responses door gives a reasoning item before the message, whole", async () => {
    const r = await post(url, "/v1/responses", { model: "dense", input: "Hej" });
    const d = await r.json();
    expect(d.output.map((i: { type: string }) => i.type)).toEqual(["reasoning", "message"]);
    expect(d.output[0].content).toEqual([{ type: "reasoning_text", text: THOUGHT }]);
    expect(d.output[1].content[0].text).toBe(ANSWER);
  });

  it("OpenAI's responses door, streamed: a reasoning item, the message after it, the sequence unbroken", async () => {
    const r = await post(url, "/v1/responses", { model: "dense", input: "Hej", stream: true });
    const es = await events(r);
    for (const e of es) expect(e.name).toBe(e.data.type);
    expect(es.map((e) => e.data.sequence_number)).toEqual(es.map((_, i) => i));
    const added = es
      .filter((e) => e.data.type === "response.output_item.added")
      .map((e) => [e.data.output_index, (e.data.item as { type: string }).type]);
    expect(added).toEqual([
      [0, "reasoning"],
      [1, "message"],
    ]);
    const reasoning = es
      .filter((e) => e.data.type === "response.reasoning_text.delta")
      .map((e) => e.data.delta)
      .join("");
    expect(reasoning.trim()).toBe(THOUGHT);
    const text = es.filter((e) => e.data.type === "response.output_text.delta");
    expect(text.map((e) => e.data.delta).join("")).toBe(ANSWER);
    expect(text.every((e) => e.data.output_index === 1)).toBe(true);
    const done = es.find((e) => e.data.type === "response.output_text.done");
    expect(done?.data.text).toBe(ANSWER);
    const completed = es.find((e) => e.data.type === "response.completed")?.data.response as {
      output: { type: string }[];
    };
    expect(completed.output.map((i) => i.type)).toEqual(["reasoning", "message"]);
  });

  it("Kvasir's own door (pi-messages) gives thinking events", async () => {
    const r = await post(url, "/v1/messages", {
      model: "dense",
      context: { messages: [{ role: "user", content: "Hej", timestamp: 1 }] },
    });
    const es = await events(r);
    const of = (t: string) =>
      es
        .filter((e) => e.data.type === t)
        .map((e) => e.data.delta)
        .join("");
    expect(of("thinking_delta").trim()).toBe(THOUGHT);
    expect(of("text_delta")).toBe(ANSWER);
  });

  it("swaps back, and the model set to off keeps its text as it wrote it, on every door", async () => {
    const chat = await (
      await post(url, "/v1/chat/completions", {
        model: "flash",
        messages: [{ role: "user", content: "Hej" }],
      })
    ).json();
    expect(k.cards.list[0].loaded).toBe("flash");
    expect(chat.choices[0].message).toEqual({ role: "assistant", content: INLINE });
    const msg = await (
      await post(url, "/v1/messages", {
        model: "flash",
        max_tokens: 200,
        messages: [{ role: "user", content: "Hej" }],
      })
    ).json();
    expect(msg.content).toEqual([{ type: "text", text: INLINE }]);
    const own = await events(
      await post(url, "/v1/messages", {
        model: "flash",
        context: { messages: [{ role: "user", content: "Hej", timestamp: 1 }] },
      }),
    );
    expect(own.some((e) => e.data.type === "thinking_delta")).toBe(false);
  });
});

describe("the doors' splitter, apart from the doors", () => {
  it("leaves an answer with no markers as it came, whole and streamed", () => {
    const body = { choices: [{ index: 0, message: { role: "assistant", content: "Hej!" } }] };
    expect(splitWhole("chat-completions", body, "markers")).toBeNull();
    expect(splitWhole("messages", { content: [{ type: "text", text: "Hej" }] }, "markers")).toBeNull();
    const s = streamSplit("chat-completions", "markers");
    const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hej" }, finish_reason: null }] })}`;
    expect(s?.frame(frame)).toBeNull();
    expect(s?.frame("data: [DONE]")).toBeNull();
  });

  it("keeps reasoning a server already separated, and reads its text from markers only", () => {
    const body = {
      choices: [
        { index: 0, message: { role: "assistant", reasoning_content: "Weighing.", content: "Done." } },
      ],
    };
    expect(splitWhole("chat-completions", body, "open")).toBeNull();
  });

  it("reads a prompt that opened the thinking from the start of the text, on a model set to open", () => {
    expect(apart("Counting.\n</thinking>\n\n38.", "open")).toEqual({ thinking: "Counting.\n", text: "38." });
    const d = splitWhole("messages", { content: [{ type: "text", text: "Counting.</think>38." }] }, "open");
    expect(d?.content).toEqual([
      { type: "thinking", thinking: "Counting.", signature: "" },
      { type: "text", text: "38." },
    ]);
  });

  it("flushes what a stream still holds when it ends without a finish", () => {
    const s = streamSplit("chat-completions", "markers");
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}`;
    const out = [...(s?.frame(chunk("<thinking>a</thinking>b <|im")) ?? []), ...(s?.end() ?? [])].map((f) =>
      JSON.parse(f.slice(6)),
    );
    const deltas = out.map((e) => e.choices[0].delta);
    expect(deltas.map((d) => d.reasoning_content ?? "").join("")).toBe("a");
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("b <|im");
  });

  it("reads inlineReasoning per model and per card, and refuses a value it does not know", () => {
    const card = (models: unknown[], extra: Record<string, unknown> = {}) => [
      { id: "card0", models, ...extra },
    ];
    const m = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      container: `sgl-${id}`,
      upstream: "http://127.0.0.1:1",
      spec,
      ...extra,
    });
    const [c] = cardsOf(
      card([m("a", { inlineReasoning: "open" }), m("b")], { inlineReasoning: "off" }),
      null,
    );
    expect(c.inlineReasoning).toBe("off");
    expect(c.models.map((x) => x.inlineReasoning)).toEqual(["open", undefined]);
    expect(() => cardsOf(card([m("a", { inlineReasoning: "sometimes" })]), null)).toThrow(
      /inlineReasoning is off, markers or open/u,
    );
  });
});
