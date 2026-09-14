// SPDX-License-Identifier: AGPL-3.0-only
// A backend's stream with the reasoning its model left inline moved into
// thinking blocks (the chat, slice 9). Each text block is read through the
// splitter and may become a thinking block and a text block; every other block
// keeps its order and is renumbered, so a client that rebuilds the message from
// the events gets the thinking, then the answer, then any tool call, as the
// model wrote them. A stream that separates its reasoning passes as it was.

import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { type InlineReasoning, ReasoningSplitter, type Segment } from "./reasoning.js";

type Block = AssistantMessage["content"][number];

export async function* splitInline(
  events: AsyncIterable<AssistantMessageEvent>,
  mode: Exclude<InlineReasoning, "off">,
): AsyncGenerator<AssistantMessageEvent> {
  const blocks: Block[] = [];
  const renumbered = new Map<number, number>();
  let splitter: ReasoningSplitter | null = null;
  let open: { index: number; kind: Segment["kind"] } | null = null;
  let firstText = true;
  const view = (p: AssistantMessage): AssistantMessage => ({ ...p, content: [...blocks] });

  function* close(p: AssistantMessage): Generator<AssistantMessageEvent> {
    const was = open;
    if (!was) return;
    open = null;
    const block = blocks[was.index] as TextContent | ThinkingContent;
    if (block.type === "thinking")
      yield { type: "thinking_end", contentIndex: was.index, content: block.thinking, partial: view(p) };
    else yield { type: "text_end", contentIndex: was.index, content: block.text, partial: view(p) };
  }

  function* write(segments: Segment[], p: AssistantMessage): Generator<AssistantMessageEvent> {
    for (const s of segments) {
      let current = open;
      if (current?.kind !== s.kind) {
        yield* close(p);
        current = { index: blocks.length, kind: s.kind };
        blocks.push(s.kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
        open = current;
        yield {
          type: s.kind === "thinking" ? "thinking_start" : "text_start",
          contentIndex: current.index,
          partial: view(p),
        };
      }
      const block = blocks[current.index] as TextContent | ThinkingContent;
      if (block.type === "thinking") {
        block.thinking += s.text;
        yield { type: "thinking_delta", contentIndex: current.index, delta: s.text, partial: view(p) };
      } else {
        block.text += s.text;
        yield { type: "text_delta", contentIndex: current.index, delta: s.text, partial: view(p) };
      }
    }
  }

  for await (const ev of events) {
    switch (ev.type) {
      case "text_start":
        // only the first text of a response can begin inside thinking its prompt opened
        splitter = new ReasoningSplitter(mode === "open" && firstText ? "open" : "markers");
        firstText = false;
        break;
      case "text_delta":
        if (splitter) yield* write(splitter.push(ev.delta), ev.partial);
        break;
      case "text_end":
        if (splitter) yield* write(splitter.end(), ev.partial);
        splitter = null;
        yield* close(ev.partial);
        break;
      case "thinking_start":
      case "toolcall_start": {
        yield* close(ev.partial);
        const index = blocks.length;
        blocks.push(ev.partial.content[ev.contentIndex] as Block);
        renumbered.set(ev.contentIndex, index);
        yield { ...ev, contentIndex: index, partial: view(ev.partial) } as AssistantMessageEvent;
        break;
      }
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_delta":
      case "toolcall_end": {
        const index = renumbered.get(ev.contentIndex);
        if (index === undefined) break;
        blocks[index] =
          (ev.partial.content[ev.contentIndex] as Block | undefined) ?? (blocks[index] as Block);
        yield { ...ev, contentIndex: index, partial: view(ev.partial) } as AssistantMessageEvent;
        break;
      }
      case "done":
        yield* close(ev.message);
        yield { ...ev, message: { ...ev.message, content: [...blocks] } };
        break;
      case "error":
        yield* close(ev.error);
        yield { ...ev, error: { ...ev.error, content: [...blocks] } };
        break;
      default:
        yield ev;
    }
  }
}
