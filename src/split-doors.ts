// SPDX-License-Identifier: AGPL-3.0-only
// Reasoning a model left inline, read apart on the pass-through doors (record 55,
// B6). A model server that does not separate a model's reasoning, or a model that
// writes it in a tag its server does not know (the 27B wrote `<thinking>` as text
// after a swap), hands the client its thinking as the answer. The doors that
// return a model's text read it through the same splitter as Kvasir's own door,
// and give the thinking where each protocol keeps it:
//
// - OpenAI's chat completions: `reasoning_content` beside `content`, on the
//   message and on each streamed delta, as SGLang's reasoning parser writes it;
// - Anthropic's messages: a `thinking` block before the text block, the blocks
//   after it renumbered, streamed as the block events Anthropic's API sends;
// - OpenAI's responses: a `reasoning` item with `reasoning_text` before the
//   message, the items after it renumbered, streamed with the reasoning events.
//
// OpenAI's legacy completions are left as they came: the client wrote the whole
// prompt, chat template and any opened thinking included, and the answer has no
// place for reasoning. An answer whose text opens with no marker passes as it was,
// byte for byte; a stream changes only the events that carried reasoning, and
// each event it does not change goes as the backend wrote it.
//
// How a model's text is read is the model's own setting (`inlineReasoning` on the
// card's model, else on its card or backend): `markers`, the default, `open` for a
// chat template that opens the thinking in the prompt, or `off`.

import { type InlineReasoning, ReasoningSplitter, type Segment } from "./reasoning.js";
import type { Protocol } from "./served.js";

export type SplitMode = Exclude<InlineReasoning, "off">;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a door's answers are read for reasoning: every door that returns a model's text, but legacy completions and the token count. */
export function splitsOn(path: string, protocol: Protocol): boolean {
  return protocol !== "completions" && path !== "/v1/messages/count_tokens";
}

/** A whole text read apart: what the splitter calls reasoning, and the answer. */
export function apart(text: string, mode: SplitMode): { thinking: string; text: string } {
  const splitter = new ReasoningSplitter(mode);
  const segments = [...splitter.push(text), ...splitter.end()];
  return { thinking: joined(segments, "thinking"), text: joined(segments, "text") };
}

function joined(segments: Segment[], kind: Segment["kind"]): string {
  return segments
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join("");
}

/** A reasoning field a chat message or delta already carries, as SGLang's parser or another server writes it. */
function reasoned(m: Obj): boolean {
  return (
    (typeof m.reasoning_content === "string" && m.reasoning_content !== "") ||
    (typeof m.reasoning === "string" && m.reasoning !== "")
  );
}

/** A thinking block or a reasoning item the backend already wrote: the prompt did not leave the output inside thinking. */
const THOUGHT = new Set(["thinking", "redacted_thinking", "reasoning"]);

/** A reasoning item's id, made from its message's so a stream and a whole answer agree. */
const reasoningId = (messageId: unknown, at: number) =>
  `rs_${typeof messageId === "string" && messageId ? messageId.replace(/^msg_/u, "") : String(at)}`;

/** A whole answer read apart, or null where nothing in it changes. */
export function splitWhole(protocol: Protocol, body: Obj, mode: SplitMode): Obj | null {
  if (protocol === "chat-completions") return chatWhole(body, mode);
  if (protocol === "messages") return messagesWhole(body, mode);
  if (protocol === "responses") return responsesWhole(body, mode);
  return null;
}

function chatWhole(body: Obj, mode: SplitMode): Obj | null {
  if (!Array.isArray(body.choices)) return null;
  let changed = false;
  const choices = body.choices.map((c) => {
    if (!isObj(c) || !isObj(c.message) || typeof c.message.content !== "string") return c;
    const message = c.message;
    const r = apart(message.content as string, mode === "open" && reasoned(message) ? "markers" : mode);
    if (r.thinking === "" && r.text === message.content) return c;
    changed = true;
    const prior = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    return {
      ...c,
      message: {
        ...message,
        content: r.text,
        ...(r.thinking ? { reasoning_content: prior + r.thinking.trim() } : {}),
      },
    };
  });
  return changed ? { ...body, choices } : null;
}

function messagesWhole(body: Obj, mode: SplitMode): Obj | null {
  if (!Array.isArray(body.content)) return null;
  const thought = body.content.some((b) => isObj(b) && THOUGHT.has(String(b.type)));
  let first = true;
  let changed = false;
  const content: unknown[] = [];
  for (const b of body.content) {
    if (!isObj(b) || b.type !== "text" || typeof b.text !== "string") {
      content.push(b);
      continue;
    }
    const r = apart(b.text, mode === "open" && first && !thought ? "open" : "markers");
    first = false;
    if (r.thinking === "" && r.text === b.text) {
      content.push(b);
      continue;
    }
    changed = true;
    if (r.thinking) content.push({ type: "thinking", thinking: r.thinking.trim(), signature: "" });
    if (r.text !== "" || !r.thinking) content.push({ ...b, text: r.text });
  }
  return changed ? { ...body, content } : null;
}

function responsesWhole(body: Obj, mode: SplitMode): Obj | null {
  if (!Array.isArray(body.output)) return null;
  const thought = body.output.some((i) => isObj(i) && THOUGHT.has(String(i.type)));
  let first = true;
  let changed = false;
  const output: unknown[] = [];
  body.output.forEach((item, at) => {
    if (!isObj(item) || item.type !== "message" || !Array.isArray(item.content)) {
      output.push(item);
      return;
    }
    let thinking = "";
    const content = item.content.map((p) => {
      if (!isObj(p) || p.type !== "output_text" || typeof p.text !== "string") return p;
      const r = apart(p.text, mode === "open" && first && !thought ? "open" : "markers");
      first = false;
      if (r.thinking === "" && r.text === p.text) return p;
      changed = true;
      thinking += r.thinking;
      return { ...p, text: r.text };
    });
    if (thinking) output.push(reasoningItem(reasoningId(item.id, at), thinking.trim(), "completed"));
    output.push(changed ? { ...item, content } : item);
  });
  if (!changed) return null;
  const out: Obj = { ...body, output };
  if (typeof body.output_text === "string") out.output_text = outputText(output);
  return out;
}

function reasoningItem(id: string, text: string, status: string): Obj {
  return { type: "reasoning", id, summary: [], content: [{ type: "reasoning_text", text }], status };
}

function outputText(output: unknown[]): string {
  let text = "";
  for (const i of output)
    if (isObj(i) && i.type === "message" && Array.isArray(i.content))
      for (const p of i.content) if (isObj(p) && p.type === "output_text") text += String(p.text ?? "");
  return text;
}

/**
 * A stream read apart, one SSE event at a time: `frame` takes an event as the
 * backend wrote it (without the blank line that ends it) and gives the events to
 * write in its place, or null to write it as it came; `end` gives what the end of
 * the stream still settles.
 */
export interface StreamSplit {
  frame(frame: string): string[] | null;
  end(): string[];
}

/** The `data:` of one SSE event, joined. */
function dataOf(frame: string): string {
  return frame
    .split(/\r\n|\n|\r/u)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /u, ""))
    .join("\n");
}

/** The stream splitter for a door's protocol. */
export function streamSplit(protocol: Protocol, mode: SplitMode): StreamSplit | null {
  const events =
    protocol === "chat-completions"
      ? new ChatStream(mode)
      : protocol === "messages"
        ? new MessagesStream(mode)
        : protocol === "responses"
          ? new ResponsesStream(mode)
          : null;
  if (!events) return null;
  const named = protocol !== "chat-completions";
  const write = (e: Obj) =>
    named
      ? `event: ${String(e.type ?? "message")}\ndata: ${JSON.stringify(e)}`
      : `data: ${JSON.stringify(e)}`;
  return {
    frame(frame) {
      const data = dataOf(frame);
      if (data === "[DONE]") {
        const rest = events.end().map(write);
        return rest.length > 0 ? [...rest, frame] : null;
      }
      let e: unknown;
      try {
        e = data ? JSON.parse(data) : null;
      } catch {
        return null;
      }
      if (!isObj(e)) return null;
      const before = JSON.stringify(e);
      const out = events.event(e);
      // an event nothing changed goes as the backend wrote it, byte for byte
      if (out.length === 1 && JSON.stringify(out[0]) === before) return null;
      return out.map(write);
    },
    end() {
      return events.end().map(write);
    },
  };
}

interface EventSplit {
  event(e: Obj): Obj[];
  end(): Obj[];
}

/** OpenAI's chat stream: each choice's `content` read apart into `reasoning_content` and `content`. */
class ChatStream implements EventSplit {
  private readonly choices = new Map<number, { splitter: ReasoningSplitter | null; reasoned: boolean }>();
  private template: Obj | null = null;

  constructor(private readonly mode: SplitMode) {}

  private state(index: number) {
    let s = this.choices.get(index);
    if (!s) {
      s = { splitter: null, reasoned: false };
      this.choices.set(index, s);
    }
    return s;
  }

  private static apply(delta: Obj, segments: Segment[], hadContent: boolean): void {
    const thinking = joined(segments, "thinking");
    const text = joined(segments, "text");
    if (thinking) {
      const prior = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
      delta.reasoning_content = prior + thinking;
    }
    if (hadContent || text) delta.content = (hadContent ? "" : String(delta.content ?? "")) + text;
  }

  event(e: Obj): Obj[] {
    if (!Array.isArray(e.choices)) return [e];
    this.template = e;
    const choices = e.choices.map((raw) => {
      if (!isObj(raw)) return raw;
      const c: Obj = { ...raw };
      const s = this.state(Number(c.index ?? 0));
      const delta: Obj = isObj(c.delta) ? { ...c.delta } : {};
      if (reasoned(delta)) s.reasoned = true;
      if (typeof delta.content === "string") {
        // only output that begins inside thinking its prompt opened is read from its start
        s.splitter ??= new ReasoningSplitter(this.mode === "open" && !s.reasoned ? "open" : "markers");
        ChatStream.apply(delta, s.splitter.push(delta.content), true);
        c.delta = delta;
      }
      if (c.finish_reason !== null && c.finish_reason !== undefined && s.splitter) {
        ChatStream.apply(delta, s.splitter.end(), false);
        s.splitter = null;
        c.delta = delta;
      }
      return c;
    });
    return [{ ...e, choices }];
  }

  end(): Obj[] {
    const out: Obj[] = [];
    for (const [index, s] of this.choices) {
      if (!s.splitter) continue;
      const delta: Obj = {};
      ChatStream.apply(delta, s.splitter.end(), false);
      s.splitter = null;
      if (Object.keys(delta).length === 0) continue;
      const t = this.template ?? {};
      out.push({
        id: t.id,
        object: t.object ?? "chat.completion.chunk",
        created: t.created,
        model: t.model,
        choices: [{ index, delta, finish_reason: null }],
      });
    }
    return out;
  }
}

/** Anthropic's messages stream: a text block read apart into a thinking block and a text block, the rest renumbered. */
class MessagesStream implements EventSplit {
  private next = 0;
  /** Upstream block index to the index the client reads it by, for the blocks that pass whole. */
  private readonly moved = new Map<number, number>();
  /** Upstream text blocks being read, each with its splitter and whether it gave the client anything. */
  private readonly texts = new Map<number, { splitter: ReasoningSplitter; wrote: boolean }>();
  private open: { index: number; kind: Segment["kind"] } | null = null;
  private thought = false;
  private first = true;

  constructor(private readonly mode: SplitMode) {}

  private close(): Obj[] {
    if (!this.open) return [];
    const index = this.open.index;
    this.open = null;
    return [{ type: "content_block_stop", index }];
  }

  private write(segments: Segment[]): Obj[] {
    const out: Obj[] = [];
    for (const s of segments) {
      if (this.open?.kind !== s.kind) {
        out.push(...this.close());
        const index = this.next++;
        this.open = { index, kind: s.kind };
        out.push({
          type: "content_block_start",
          index,
          content_block:
            s.kind === "thinking"
              ? { type: "thinking", thinking: "", signature: "" }
              : { type: "text", text: "" },
        });
      }
      out.push({
        type: "content_block_delta",
        index: this.open?.index,
        delta:
          s.kind === "thinking"
            ? { type: "thinking_delta", thinking: s.text }
            : { type: "text_delta", text: s.text },
      });
    }
    return out;
  }

  event(e: Obj): Obj[] {
    const type = String(e.type ?? "");
    const at = Number(e.index);
    if (type === "content_block_start" && isObj(e.content_block)) {
      const block = e.content_block;
      if (block.type === "text") {
        const splitter = new ReasoningSplitter(
          this.mode === "open" && this.first && !this.thought ? "open" : "markers",
        );
        this.first = false;
        this.texts.set(at, { splitter, wrote: false });
        return typeof block.text === "string" && block.text ? this.text(at, block.text) : [];
      }
      if (THOUGHT.has(String(block.type))) this.thought = true;
      const out = this.close();
      const index = this.next++;
      this.moved.set(at, index);
      return [...out, { ...e, index }];
    }
    if (type === "content_block_delta" && this.texts.has(at)) {
      const d = isObj(e.delta) ? e.delta : {};
      if (d.type === "text_delta" && typeof d.text === "string") return this.text(at, d.text);
      // anything else on a text block (a citation) goes with the text block the client reads
      return this.open?.kind === "text" ? [{ ...e, index: this.open.index }] : [];
    }
    if (type === "content_block_stop" && this.texts.has(at)) {
      const t = this.texts.get(at);
      this.texts.delete(at);
      const out = t ? this.write(t.splitter.end()) : [];
      if (t && !t.wrote && out.length === 0) {
        // a text block that said nothing stays one, as the backend wrote it
        const index = this.next++;
        return [
          ...this.close(),
          { type: "content_block_start", index, content_block: { type: "text", text: "" } },
          { type: "content_block_stop", index },
        ];
      }
      return [...out, ...this.close()];
    }
    if (type.startsWith("content_block_") && this.moved.has(at)) return [{ ...e, index: this.moved.get(at) }];
    return [e];
  }

  private text(at: number, delta: string): Obj[] {
    const t = this.texts.get(at);
    if (!t) return [];
    const out = this.write(t.splitter.push(delta));
    if (out.length > 0) t.wrote = true;
    return out;
  }

  end(): Obj[] {
    const out: Obj[] = [];
    for (const t of this.texts.values()) out.push(...this.write(t.splitter.end()));
    this.texts.clear();
    return [...out, ...this.close()];
  }
}

/** OpenAI's responses stream: a message's text read apart into a reasoning item before it, the items after it renumbered. */
class ResponsesStream implements EventSplit {
  /** Reasoning items put in so far: every upstream output index after them moves by this many. */
  private shift = 0;
  private readonly moved = new Map<number, number>();
  private readonly messages = new Map<string, Message>();
  private seq: number | null = null;
  private thought = false;
  private first = true;

  constructor(private readonly mode: SplitMode) {}

  private numbered(out: Obj[]): Obj[] {
    // a backend that numbers its events has every event numbered, the ones put in among them too
    for (const e of out) {
      if (this.seq === null && typeof e.sequence_number === "number") this.seq = e.sequence_number;
      if (this.seq !== null) e.sequence_number = this.seq++;
    }
    return out;
  }

  private index(upstream: unknown): number | undefined {
    if (typeof upstream !== "number") return undefined;
    return this.moved.get(upstream) ?? upstream + this.shift;
  }

  private message(e: Obj): Message {
    const key = typeof e.item_id === "string" ? e.item_id : "";
    let m = this.messages.get(key);
    if (!m) {
      m = {
        id: key,
        at: typeof e.output_index === "number" ? e.output_index : undefined,
        held: [],
        splitter: null,
        reasoning: null,
        released: false,
        texts: new Map(),
      };
      this.messages.set(key, m);
    }
    return m;
  }

  /** The reasoning item closed, and the message's held events let go, at the index after it. */
  private release(m: Message): Obj[] {
    const out: Obj[] = [];
    if (m.reasoning) out.push(...this.closeReasoning(m));
    if (!m.released) {
      m.released = true;
      if (m.at !== undefined) this.moved.set(m.at, m.at + this.shift);
      for (const h of m.held) out.push({ ...h, output_index: this.index(h.output_index) });
      m.held = [];
    }
    return out;
  }

  private closeReasoning(m: Message): Obj[] {
    const r = m.reasoning;
    if (!r) return [];
    m.reasoning = null;
    return [
      {
        type: "response.reasoning_text.done",
        item_id: r.id,
        output_index: r.index,
        content_index: 0,
        text: r.text,
      },
      {
        type: "response.content_part.done",
        item_id: r.id,
        output_index: r.index,
        content_index: 0,
        part: { type: "reasoning_text", text: r.text },
      },
      {
        type: "response.output_item.done",
        output_index: r.index,
        item: reasoningItem(r.id, r.text, "completed"),
      },
    ];
  }

  private write(m: Message, e: Obj, segments: Segment[]): Obj[] {
    const out: Obj[] = [];
    const content = typeof e.content_index === "number" ? e.content_index : 0;
    for (const s of segments) {
      if (s.kind === "thinking") {
        if (m.released) {
          // thinking after the answer began is the answer's own words
          out.push(...this.text(m, e, content, s.text));
          continue;
        }
        if (!m.reasoning) {
          const index = (m.at ?? 0) + this.shift;
          const id = reasoningId(m.id, index);
          m.reasoning = { id, index, text: "" };
          this.shift += 1;
          out.push(
            {
              type: "response.output_item.added",
              output_index: index,
              item: reasoningItem(id, "", "in_progress"),
            },
            {
              type: "response.content_part.added",
              item_id: id,
              output_index: index,
              content_index: 0,
              part: { type: "reasoning_text", text: "" },
            },
          );
        }
        const r = m.reasoning;
        const piece = r.text === "" ? s.text.replace(/^\s+/u, "") : s.text;
        if (piece === "") continue;
        r.text += piece;
        out.push({
          type: "response.reasoning_text.delta",
          item_id: r.id,
          output_index: r.index,
          content_index: 0,
          delta: piece,
        });
      } else out.push(...this.text(m, e, content, s.text));
    }
    return out;
  }

  private text(m: Message, e: Obj, content: number, text: string): Obj[] {
    const out = this.release(m);
    m.texts.set(content, (m.texts.get(content) ?? "") + text);
    out.push({ ...e, delta: text, output_index: this.index(e.output_index) });
    return out;
  }

  event(e: Obj): Obj[] {
    const type = String(e.type ?? "");
    if (isObj(e.response)) {
      const split = responsesWhole(e.response, this.mode);
      return this.numbered([split ? { ...e, response: split } : e]);
    }
    if (type === "response.output_item.added" && isObj(e.item)) {
      if (e.item.type === "message") {
        const m = this.message({ item_id: e.item.id, output_index: e.output_index });
        m.held.push(e);
        return [];
      }
      if (THOUGHT.has(String(e.item.type))) this.thought = true;
      if (typeof e.output_index === "number") this.moved.set(e.output_index, e.output_index + this.shift);
      return this.numbered([{ ...e, output_index: this.index(e.output_index) }]);
    }
    const m = typeof e.item_id === "string" ? this.messages.get(e.item_id) : undefined;
    if (type === "response.content_part.added" && m && !m.released) {
      m.held.push(e);
      return [];
    }
    if (type === "response.output_text.delta" && typeof e.delta === "string") {
      const msg = m ?? this.message(e);
      msg.splitter ??= new ReasoningSplitter(
        this.mode === "open" && this.first && !this.thought ? "open" : "markers",
      );
      this.first = false;
      return this.numbered(this.write(msg, e, msg.splitter.push(e.delta)));
    }
    if (type === "response.output_text.done") {
      const msg = m ?? this.messages.get("");
      if (!msg) return this.numbered([e]);
      const content = typeof e.content_index === "number" ? e.content_index : 0;
      const out = msg.splitter ? this.write(msg, e, msg.splitter.end()) : [];
      msg.splitter = null;
      out.push(...this.release(msg));
      out.push({ ...e, text: msg.texts.get(content) ?? "", output_index: this.index(e.output_index) });
      return this.numbered(out);
    }
    if (type === "response.content_part.done" && m && isObj(e.part) && e.part.type === "output_text") {
      const content = typeof e.content_index === "number" ? e.content_index : 0;
      return this.numbered([
        ...this.release(m),
        {
          ...e,
          part: { ...e.part, text: m.texts.get(content) ?? "" },
          output_index: this.index(e.output_index),
        },
      ]);
    }
    if (type === "response.output_item.done" && isObj(e.item) && e.item.type === "message") {
      const msg = this.messages.get(String(e.item.id ?? ""));
      if (msg && Array.isArray(e.item.content)) {
        const content = e.item.content.map((p, i) =>
          isObj(p) && p.type === "output_text" && msg.texts.has(i) ? { ...p, text: msg.texts.get(i) } : p,
        );
        return this.numbered([
          ...this.release(msg),
          { ...e, item: { ...e.item, content }, output_index: this.index(e.output_index) },
        ]);
      }
    }
    return this.numbered([
      typeof e.output_index === "number" ? { ...e, output_index: this.index(e.output_index) } : e,
    ]);
  }

  end(): Obj[] {
    const out: Obj[] = [];
    for (const m of this.messages.values()) {
      if (m.splitter) {
        out.push(...this.write(m, { type: "response.output_text.delta" }, m.splitter.end()));
        m.splitter = null;
      }
      if (m.reasoning) out.push(...this.closeReasoning(m));
    }
    return this.numbered(out);
  }
}

interface Message {
  id: string;
  /** Its upstream output index, where the backend gave one. */
  at: number | undefined;
  /** Its `output_item.added` and `content_part.added`, held until it is known whether reasoning comes first. */
  held: Obj[];
  splitter: ReasoningSplitter | null;
  /** The reasoning item open before it. */
  reasoning: { id: string; index: number; text: string } | null;
  released: boolean;
  /** The answer's text by content index, for the done events. */
  texts: Map<number, string>;
}
