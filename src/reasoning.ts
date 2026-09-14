// SPDX-License-Identifier: AGPL-3.0-only
// Reasoning a model leaves in its text (the chat, slice 9). A runtime that does
// not separate a model's reasoning streams it inline, between markers that differ
// by family: <think>…</think> (Qwen, DeepSeek, GLM, Kimi K2, MiniMax M2, Phi-4,
// Nemotron, OLMo, ERNIE), Gemma 4's <|channel>thought … <channel|>, gpt-oss's
// harmony channels, Mistral's [THINK] … [/THINK], Cohere's <|START_THINKING|>
// … <|END_THINKING|>, Kimi K3's <|open|>think<|sep|> …, and the namespaced
// <seed:think>, <mm:think> and <think:name>. The splitter reads the text as it
// streams and hands back what was reasoning and what was the answer.
//
// It reads reasoning only from markers that open the output or, for a runtime
// whose chat template opens thinking in the prompt, from the start of the output
// to a closing marker. Once the answer has begun it never goes back into
// reasoning. It holds back the end of the text while that could still become a
// marker, and drops the stop tokens a runtime leaves at the end.
//
// Kept the same in kvasir (src/reasoning.ts), nils-assistant (src/host/reasoning.ts)
// and nils-desk (web/src/assistant/reasoning.ts).

export type Segment = { kind: "thinking" | "text"; text: string };

/** How a backend's text is read for reasoning: not at all, from markers that open it, or from its start, for a prompt that opened thinking. */
export type InlineReasoning = "off" | "markers" | "open";

type Pair = { open: string; close: string; unwrap: string[] };

const pair = (open: string, close: string, ...unwrap: string[]): Pair => ({ open, close, unwrap });

/** Reasoning markers by family, with the wrappers an answer may come in right after them. */
const PAIRS: Pair[] = [
  pair("<|channel>thought", "<channel|>"),
  pair("<|open|>think<|sep|>", "<|close|>think<|sep|>", "<|open|>response<|sep|>"),
  pair("<|START_THINKING|>", "<|END_THINKING|>", "<|START_RESPONSE|>", "<|START_TEXT|>"),
  pair("<seed:think>", "</seed:think>"),
  pair("<mm:think>", "</mm:think>"),
  pair("[THINK]", "[/THINK]"),
  pair("<think>", "</think>", "<answer>", "<response>"),
];

/** A think tag with a name, as <think:opensource>. */
const NAMED = /^<think:([A-Za-z0-9_-]{1,32})>/u;
const NAMED_BEGUN = /^<(?:t(?:h(?:i(?:n(?:k(?::[A-Za-z0-9_-]{0,32})?)?)?)?)?)?$/u;
const NAMED_CLOSE = /<\/think:[A-Za-z0-9_-]{1,32}>/u;
const NAMED_CLOSE_BEGUN = /<(?:\/(?:t(?:h(?:i(?:n(?:k(?::[A-Za-z0-9_-]{0,32})?)?)?)?)?)?)?$/u;

const WRAP_CLOSE: Record<string, string> = {
  "<answer>": "</answer>",
  "<response>": "</response>",
  "<|START_RESPONSE|>": "<|END_RESPONSE|>",
  "<|START_TEXT|>": "<|END_TEXT|>",
  "<|open|>response<|sep|>": "<|close|>response<|sep|>",
};

/** Stop tokens a runtime can leave at the end of an answer. */
const STOPS = [
  "<|return|>",
  "<|call|>",
  "<|end|>",
  "<turn|>",
  "<eos>",
  "<|im_end|>",
  "<｜end▁of▁sentence｜>",
  "<|END_OF_TURN_TOKEN|>",
  "<seed:eos>",
  "<|end_of_msg|>",
  "<|close|>message<|sep|>",
];

const HARMONY_HEADS = ["<|start|>", "<|channel|>"];
const HARMONY_BREAKS = ["<|end|>", "<|return|>", "<|call|>", "<|start|>", "<|channel|>"];

/** A closing marker that ends reasoning a prompt opened, when no marker opened the text. */
const LONE_CLOSE =
  /<\/think>|<\/seed:think>|<\/mm:think>|<\/think:[A-Za-z0-9_-]{1,32}>|\[\/THINK\]|<channel\|>|<\|END_THINKING\|>|<\|close\|>think<\|sep\|>/u;

function earliest(
  text: string,
  markers: string[],
  named: boolean,
): { index: number; length: number; marker: string } | null {
  let best: { index: number; length: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0 && (best === null || index < best.index)) best = { index, length: marker.length, marker };
  }
  if (named) {
    const m = NAMED_CLOSE.exec(text);
    if (m && (best === null || m.index < best.index))
      best = { index: m.index, length: m[0].length, marker: m[0] };
  }
  return best;
}

/** How much of the end of a text could still grow into one of the markers. */
function unfinished(text: string, markers: string[], named: boolean): number {
  let keep = 0;
  for (const marker of markers) {
    for (let k = Math.min(marker.length - 1, text.length); k > keep; k--) {
      if (text.endsWith(marker.slice(0, k))) {
        keep = k;
        break;
      }
    }
  }
  if (named) {
    const m = NAMED_CLOSE_BEGUN.exec(text);
    if (m && m[0].length > keep) keep = m[0].length;
  }
  return keep;
}

/** How much of the end of an answer is, or could still become, stop tokens with the space around them. */
function trailing(text: string, tails: string[]): number {
  // a stop token still arriving, then the whole ones before it
  let end = text.length - unfinished(text, tails, false);
  for (;;) {
    const trimmed = text.slice(0, end).replace(/\s+$/u, "");
    const tail = tails.find((t) => trimmed.endsWith(t));
    if (!tail) break;
    end = trimmed.length - tail.length;
  }
  return text.length - end;
}

function withoutTails(text: string, tails: string[]): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/\s+$/u, "");
    const tail = tails.find((t) => trimmed.endsWith(t));
    if (!tail) return rest;
    rest = trimmed.slice(0, trimmed.length - tail.length);
  }
}

export class ReasoningSplitter {
  private phase: "start" | "opening" | "thinking" | "after" | "text" | "head" | "body";
  private buf = "";
  private expect: Pair[] = [];
  private named = false;
  private afterOpener = false;
  private unwrap: string[] = [];
  private tails: string[] = STOPS;
  private channel = "final";
  private out: Segment[] = [];

  constructor(mode: Exclude<InlineReasoning, "off"> = "markers") {
    if (mode === "open") {
      this.phase = "opening";
      this.expect = PAIRS;
      this.named = true;
    } else {
      this.phase = "start";
    }
  }

  /** What a piece of the stream settles. */
  push(delta: string): Segment[] {
    this.buf += delta;
    return this.run(false);
  }

  /** What the end of the stream settles. */
  end(): Segment[] {
    return this.run(true);
  }

  private emit(kind: Segment["kind"], text: string): void {
    if (text === "") return;
    const last = this.out[this.out.length - 1];
    if (last?.kind === kind) last.text += text;
    else this.out.push({ kind, text });
  }

  private opener(rest: string): { length: number; pairs: Pair[]; named: boolean } | "maybe" | null {
    const p = PAIRS.find((x) => rest.startsWith(x.open));
    if (p) return { length: p.open.length, pairs: [p], named: false };
    const n = NAMED.exec(rest);
    if (n) return { length: n[0].length, pairs: [], named: true };
    return PAIRS.some((x) => x.open.startsWith(rest)) || NAMED_BEGUN.test(rest) ? "maybe" : null;
  }

  private run(final: boolean): Segment[] {
    this.out = [];
    for (;;) {
      switch (this.phase) {
        case "start": {
          const rest = this.buf.replace(/^\s+/u, "");
          if (rest === "") {
            if (final) this.buf = "";
            return this.out;
          }
          if (HARMONY_HEADS.some((h) => rest.startsWith(h))) {
            this.buf = rest;
            this.phase = "head";
            break;
          }
          const found = this.opener(rest);
          if (found !== null && found !== "maybe") {
            this.buf = rest.slice(found.length);
            this.expect = found.pairs;
            this.named = found.named;
            this.afterOpener = true;
            this.phase = "thinking";
            break;
          }
          if (!final && (found === "maybe" || HARMONY_HEADS.some((h) => h.startsWith(rest)))) return this.out;
          this.phase = "text";
          break;
        }
        case "opening": {
          // the prompt opened the thinking; a model that writes the opener again has it dropped
          const rest = this.buf.replace(/^\s+/u, "");
          if (rest === "" && !final) return this.out;
          const found = this.opener(rest);
          if (found === "maybe" && !final) return this.out;
          if (found !== null && found !== "maybe") {
            this.buf = rest.slice(found.length);
            this.afterOpener = true;
          }
          this.phase = "thinking";
          break;
        }
        case "thinking": {
          if (this.afterOpener) {
            if (this.buf === "" && !final) return this.out;
            this.buf = this.buf.replace(/^\r?\n/u, "");
            this.afterOpener = false;
          }
          const closers = this.expect.map((p) => p.close);
          const hit = earliest(this.buf, closers, this.named);
          if (hit) {
            this.emit("thinking", this.buf.slice(0, hit.index));
            this.buf = this.buf.slice(hit.index + hit.length);
            this.unwrap = this.expect.find((p) => p.close === hit.marker)?.unwrap ?? [];
            this.phase = "after";
            break;
          }
          const keep = final ? 0 : unfinished(this.buf, closers, this.named);
          this.emit("thinking", this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return this.out;
        }
        case "after": {
          const rest = this.buf.replace(/^\s+/u, "");
          if (rest === "") {
            if (final) this.buf = "";
            return this.out;
          }
          const wrap = this.unwrap.find((w) => rest.startsWith(w));
          if (wrap) {
            // the answer's wrapper goes, and the space after it
            this.buf = rest.slice(wrap.length);
            this.tails = [...STOPS, WRAP_CLOSE[wrap] as string];
            this.unwrap = [];
            break;
          }
          if (!final && this.unwrap.some((w) => w.startsWith(rest))) return this.out;
          this.buf = rest;
          this.phase = "text";
          break;
        }
        case "text": {
          if (final) {
            this.emit("text", withoutTails(this.buf, this.tails));
            this.buf = "";
            return this.out;
          }
          const keep = trailing(this.buf, this.tails);
          this.emit("text", this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return this.out;
        }
        case "head": {
          const rest = this.buf.replace(/^\s+/u, "");
          if (rest === "") {
            if (final) this.buf = "";
            return this.out;
          }
          if (!HARMONY_HEADS.some((h) => rest.startsWith(h))) {
            if (!final && HARMONY_HEADS.some((h) => h.startsWith(rest))) return this.out;
            this.buf = rest;
            this.phase = "text";
            break;
          }
          const at = rest.indexOf("<|message|>");
          if (at < 0) {
            this.buf = final ? "" : rest;
            return this.out;
          }
          this.channel =
            /<\|channel\|>\s*([A-Za-z]+)/u.exec(rest.slice(0, at))?.[1]?.toLowerCase() ?? this.channel;
          this.buf = rest.slice(at + "<|message|>".length);
          this.phase = "body";
          break;
        }
        case "body": {
          // harmony: the final channel is the answer; analysis and commentary are not
          const kind = this.channel === "final" ? "text" : "thinking";
          const hit = earliest(this.buf, HARMONY_BREAKS, false);
          if (hit) {
            this.emit(kind, this.buf.slice(0, hit.index));
            const header = hit.marker === "<|start|>" || hit.marker === "<|channel|>";
            this.buf = this.buf.slice(hit.index + (header ? 0 : hit.length));
            this.phase = "head";
            break;
          }
          const keep = final ? 0 : unfinished(this.buf, HARMONY_BREAKS, false);
          this.emit(kind, this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return this.out;
        }
      }
    }
  }
}

/**
 * A whole text's reasoning and answer: what the splitter reads from markers that
 * open it, or, when none did, from a first closing marker outside code, which
 * means the prompt opened the thinking and the text began inside it.
 */
export function splitReasoning(text: string): { thinking: string; text: string } {
  const read = (mode: "markers" | "open") => {
    const splitter = new ReasoningSplitter(mode);
    const segments = [...splitter.push(text), ...splitter.end()];
    const of = (kind: Segment["kind"]) =>
      segments
        .filter((s) => s.kind === kind)
        .map((s) => s.text)
        .join("");
    return { thinking: of("thinking").trim(), text: of("text").replace(/\s+$/u, "") };
  };
  const markers = read("markers");
  if (markers.thinking) return markers;
  const close = LONE_CLOSE.exec(text);
  if (!close) return markers;
  const before = text.slice(0, close.index);
  // a closing marker quoted in code is the answer's own words
  if (/^ {0,3}(?:```|~~~)/mu.test(before) || (before.match(/`/gu)?.length ?? 0) % 2 === 1) return markers;
  return read("open");
}
