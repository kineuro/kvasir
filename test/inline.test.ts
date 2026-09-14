// SPDX-License-Identifier: AGPL-3.0-only
// A backend's events with inline reasoning moved into thinking blocks: the
// blocks renumbered in order, the final message rebuilt, and a stream that
// already separates its reasoning passed through as it was.

import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { splitInline } from "../src/inline.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const message = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "card",
  model: "qwen",
  usage,
  stopReason: "stop",
  timestamp: 1,
});

/** pi's events for a text streamed in pieces, a tool call after it and, when given, separated thinking before it. */
function upstream(pieces: string[], thinking?: string): AssistantMessageEvent[] {
  const content: AssistantMessage["content"] = [];
  const events: AssistantMessageEvent[] = [{ type: "start", partial: message(content) }];
  if (thinking !== undefined) {
    const block = { type: "thinking" as const, thinking: "" };
    content.push(block);
    const i = content.length - 1;
    events.push({ type: "thinking_start", contentIndex: i, partial: message(content) });
    block.thinking = thinking;
    events.push({ type: "thinking_delta", contentIndex: i, delta: thinking, partial: message(content) });
    events.push({ type: "thinking_end", contentIndex: i, content: thinking, partial: message(content) });
  }
  const text = { type: "text" as const, text: "" };
  content.push(text);
  const t = content.length - 1;
  events.push({ type: "text_start", contentIndex: t, partial: message(content) });
  for (const piece of pieces) {
    text.text += piece;
    events.push({ type: "text_delta", contentIndex: t, delta: piece, partial: message(content) });
  }
  events.push({ type: "text_end", contentIndex: t, content: text.text, partial: message(content) });
  const call: ToolCall = { type: "toolCall", id: "c1", name: "nils_run", arguments: { document_id: 7 } };
  content.push(call);
  const c = content.length - 1;
  events.push({ type: "toolcall_start", contentIndex: c, partial: message(content) });
  events.push({ type: "toolcall_end", contentIndex: c, toolCall: call, partial: message(content) });
  events.push({ type: "done", reason: "toolUse", message: message(content) });
  return events;
}

async function run(events: AssistantMessageEvent[], mode: "markers" | "open" = "markers") {
  async function* source() {
    for (const e of events) yield e;
  }
  const out: AssistantMessageEvent[] = [];
  for await (const e of splitInline(source(), mode)) out.push(e);
  return out;
}

const shape = (events: AssistantMessageEvent[]) =>
  events.map((e) => {
    if (e.type === "start" || e.type === "done" || e.type === "error") return e.type;
    const at = `${e.type}:${e.contentIndex}`;
    if ("delta" in e) return `${at}:${e.delta}`;
    if ("content" in e) return `${at}=${e.content}`;
    return at;
  });

const final = (events: AssistantMessageEvent[]) =>
  (events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message.content;

describe("inline reasoning in a backend's events", () => {
  it("moves an opening think block into a thinking block and renumbers the blocks after it", async () => {
    const out = await run(upstream(["<thi", "nk>Plan</think>\n\nAns", "wer"]));
    expect(shape(out)).toEqual([
      "start",
      "thinking_start:0",
      "thinking_delta:0:Plan",
      "thinking_end:0=Plan",
      "text_start:1",
      "text_delta:1:Ans",
      "text_delta:1:wer",
      "text_end:1=Answer",
      "toolcall_start:2",
      "toolcall_end:2",
      "done",
    ]);
    expect(final(out)).toEqual([
      { type: "thinking", thinking: "Plan" },
      { type: "text", text: "Answer" },
      { type: "toolCall", id: "c1", name: "nils_run", arguments: { document_id: 7 } },
    ]);
  });

  it("passes a stream that already separates its reasoning through as it was", async () => {
    const out = await run(upstream(["Hello ", "world"], "thinking about it"));
    expect(shape(out)).toEqual([
      "start",
      "thinking_start:0",
      "thinking_delta:0:thinking about it",
      "thinking_end:0=thinking about it",
      "text_start:1",
      "text_delta:1:Hello ",
      "text_delta:1:world",
      "text_end:1=Hello world",
      "toolcall_start:2",
      "toolcall_end:2",
      "done",
    ]);
  });

  it("reads a text that begins inside thinking its prompt opened, when the backend says so", async () => {
    const out = await run(upstream(["Counting.\n</th", "ink>\n\n38."]), "open");
    expect(final(out).slice(0, 2)).toEqual([
      { type: "thinking", thinking: "Counting.\n" },
      { type: "text", text: "38." },
    ]);
  });
});
