// SPDX-License-Identifier: AGPL-3.0-only
// The doors as the client sent them (record 47, K1, R2): OpenAI's chat and
// completions, Anthropic's messages and count_tokens, and OpenAI's responses,
// forwarded to a backend that speaks the same protocol natively (SGLang speaks
// all of them). Kvasir changes two things in a request and nothing else: the
// model's name, to the one its backend serves it by, and on Anthropic's
// messages the thinking default (a request without `thinking` goes on as
// thinking disabled, as Anthropic's own API behaves). Tools, images, stop
// sequences, response formats and every other field go as they came, and the
// answer comes back as the backend wrote it, event for event.
//
// Around that: the key's scopes, the context guard (a request whose input and
// longest answer cannot fit the model's context is refused before a backend
// or a card is touched), the wait for a slot or a swap, a comment on a stream
// that says nothing, and one ledger row in counts, never content.
//
// One more change, for the ledger alone: a streamed OpenAI request that did not
// set `stream_options` is sent with `include_usage`, and the usage-only event
// that asks for is taken out of the stream again, so the client reads what it
// would have read and the ledger still has the counts.
//
// A wait for a card's swap takes minutes. No client is left without headers
// that long: a stream gets its headers at the first second of waiting and
// `: queued` each second after; a whole answer gets its headers after
// `WHOLE_HEADERS_AFTER_MS` (status 200, JSON) and a newline each keep-alive
// interval, which a JSON parser skips, so neither Node's fetch, which gives up
// on headers after 300 seconds, nor a client's read timeout ends it. A whole
// answer that fails after its headers went says so in its body, in the door's
// own error shape.

import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Principal } from "./auth.js";
import { json, KEEP_ALIVE_MS, keepAlive } from "./doors.js";
import type { Ledger, Row } from "./ledger.js";
import {
  DOORS,
  type Lease,
  LeaseRefused,
  type Protocol,
  type ServedCatalog,
  type ServedModel,
} from "./served.js";

/**
 * The bytes of text one token stands for at most, in the guard's estimate. A
 * real tokenizer gives three to five bytes of prose or code a token, so this
 * estimate is below the true count: the guard refuses what surely cannot fit,
 * and the backend's own check answers for what is close.
 */
export const BYTES_PER_TOKEN = 6;

/** How long a whole (not streamed) answer waits without headers before Kvasir sends its own. */
export const WHOLE_HEADERS_AFTER_MS = 30_000;

/** Headers that belong to one hop, or to Kvasir, and are never forwarded. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "accept-encoding",
  "host",
  "authorization",
  "x-api-key",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "cookie",
]);

export interface PassContext {
  served: ServedCatalog;
  ledger: Ledger;
  who: Principal;
  keepAliveMs?: number;
  /** How long a whole answer waits without headers before Kvasir sends its own; WHOLE_HEADERS_AFTER_MS when absent. */
  wholeHeadersAfterMs?: number;
  /** The door that translates through pi-ai, for a chat request whose model no backend answers natively. */
  translate?: (text: string) => Promise<void>;
}

/** Whether a client key may ask for a model: every model where it lists none, else a model one of its names means. */
export function mayUse(who: Principal, model: ServedModel, served: ServedCatalog): boolean {
  const names = who.client?.models;
  if (!names) return true;
  return names.some((n) => served.find(n)?.id === model.id);
}

/** An error body in the door's own shape: Anthropic's on messages, OpenAI's elsewhere. */
function errorBody(protocol: Protocol, type: string, code: string, message: string): Record<string, unknown> {
  return protocol === "messages"
    ? { type: "error", error: { type, message } }
    : { error: { message, type, code } };
}

/** A refusal in the door's own shape: Anthropic's on messages, OpenAI's elsewhere. */
function refuse(
  res: ServerResponse,
  protocol: Protocol,
  status: number,
  type: string,
  code: string,
  message: string,
): void {
  json(res, status, errorBody(protocol, type, code, message));
}

/** A rough, low count of a request's input tokens: its text, never its images. */
export function estimateInput(body: Record<string, unknown>, protocol: Protocol): number {
  const fields =
    protocol === "chat-completions"
      ? ["messages", "tools"]
      : protocol === "completions"
        ? ["prompt"]
        : protocol === "messages"
          ? ["system", "messages", "tools"]
          : ["instructions", "input", "tools"];
  let bytes = 0;
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === "string") {
      // an image travels as base64 in `data` or as a data URL; it is not text
      if (key === "data" || v.startsWith("data:")) return;
      bytes += Buffer.byteLength(v, "utf8");
    } else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const f of fields) walk(body[f], f);
  return Math.floor(bytes / BYTES_PER_TOKEN);
}

/** The counts an answer carries, read as it passes: usage, whether it was cut at the longest answer, when it began. */
class Meter {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  reasoning = 0;
  capped = false;
  failed = false;
  firstAt: number | null = null;
  constructor(
    private readonly protocol: Protocol,
    /** The usage-only event Kvasir asked for, taken out again. */
    private readonly strip: boolean,
  ) {}

  private openai(u: Record<string, unknown> | undefined): void {
    if (!u) return;
    const cached = Number((u.prompt_tokens_details as { cached_tokens?: unknown })?.cached_tokens ?? 0) || 0;
    this.input = Math.max(0, (Number(u.prompt_tokens) || 0) - cached);
    this.cacheRead = cached;
    this.output = Number(u.completion_tokens) || 0;
    this.reasoning =
      Number((u.completion_tokens_details as { reasoning_tokens?: unknown })?.reasoning_tokens ?? 0) || 0;
  }

  private anthropic(u: Record<string, unknown> | undefined): void {
    if (!u) return;
    if (u.input_tokens !== undefined) this.input = Number(u.input_tokens) || 0;
    if (u.output_tokens !== undefined) this.output = Number(u.output_tokens) || 0;
    if (u.cache_read_input_tokens !== undefined) this.cacheRead = Number(u.cache_read_input_tokens) || 0;
    if (u.cache_creation_input_tokens !== undefined)
      this.cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  }

  private responses(u: Record<string, unknown> | undefined): void {
    if (!u) return;
    const cached = Number((u.input_tokens_details as { cached_tokens?: unknown })?.cached_tokens ?? 0) || 0;
    this.input = Math.max(0, (Number(u.input_tokens) || 0) - cached);
    this.cacheRead = cached;
    this.output = Number(u.output_tokens) || 0;
    this.reasoning =
      Number((u.output_tokens_details as { reasoning_tokens?: unknown })?.reasoning_tokens ?? 0) || 0;
  }

  /** One event of a stream read; false where it is the usage event Kvasir asked for and the client did not. */
  frame(frame: string): boolean {
    const data = frame
      .split(/\r\n|\n|\r/u)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data || data === "[DONE]") return true;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(data);
    } catch {
      return true;
    }
    if (!e || typeof e !== "object") return true;
    if (e.error) this.failed = true;
    if (this.protocol === "chat-completions" || this.protocol === "completions") {
      const choices = Array.isArray(e.choices) ? (e.choices as Record<string, unknown>[]) : null;
      if (e.usage) this.openai(e.usage as Record<string, unknown>);
      const c = choices?.[0];
      if (c?.finish_reason === "length") this.capped = true;
      const d = (c?.delta ?? {}) as Record<string, unknown>;
      if (this.firstAt === null && (d.content || d.reasoning_content || d.tool_calls || c?.text))
        this.firstAt = Date.now();
      if (this.strip && choices && choices.length === 0 && e.usage) return false;
    } else if (this.protocol === "messages") {
      const type = String(e.type ?? "");
      if (type === "message_start")
        this.anthropic((e.message as { usage?: Record<string, unknown> } | undefined)?.usage);
      if (type === "message_delta") {
        this.anthropic(e.usage as Record<string, unknown> | undefined);
        if ((e.delta as { stop_reason?: unknown } | undefined)?.stop_reason === "max_tokens")
          this.capped = true;
      }
      if (type === "content_block_delta" && this.firstAt === null) this.firstAt = Date.now();
      if (type === "error") this.failed = true;
    } else {
      const type = String(e.type ?? "");
      if (type.endsWith(".delta") && this.firstAt === null) this.firstAt = Date.now();
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
        this.responses((e.response as { usage?: Record<string, unknown> } | undefined)?.usage);
        if (type === "response.incomplete") this.capped = true;
        if (type === "response.failed") this.failed = true;
      }
    }
    return true;
  }

  /** A whole answer read. */
  whole(e: Record<string, unknown>): void {
    if (this.protocol === "chat-completions" || this.protocol === "completions") {
      this.openai(e.usage as Record<string, unknown> | undefined);
      const c = (e.choices as Record<string, unknown>[] | undefined)?.[0];
      if (c?.finish_reason === "length") this.capped = true;
    } else if (this.protocol === "messages") {
      this.anthropic(e.usage as Record<string, unknown> | undefined);
      if (e.stop_reason === "max_tokens") this.capped = true;
    } else {
      this.responses(e.usage as Record<string, unknown> | undefined);
      if (e.status === "incomplete") this.capped = true;
    }
  }
}

/** The headers `Connection` names, which belong to one hop as the fixed ones do (RFC 9110, 7.6.1). */
function hopNamed(headers: IncomingHttpHeaders): Set<string> {
  const named = headers.connection;
  const list = Array.isArray(named) ? named.join(",") : (named ?? "");
  return new Set(
    list
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The request's headers a backend receives: the client's, less one hop's and Kvasir's own, and the backend's key. */
function forwarded(headers: IncomingHttpHeaders, lease: Lease, length: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const named = hopNamed(headers);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP.has(k) || named.has(k) || k.startsWith("x-kvasir-")) continue;
    out[k] = v;
  }
  out["content-type"] = "application/json";
  out["content-length"] = length;
  if (lease.auth) out[lease.auth.header] = lease.auth.value;
  return out;
}

/** The answer's headers the client receives: the backend's, less one hop's and the cookies it would set. */
function answered(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const named = hopNamed(headers);
  for (const [k, v] of Object.entries(headers))
    if (v !== undefined && !HOP.has(k) && !named.has(k) && k !== "set-cookie") out[k] = v;
  return out;
}

function send(
  url: URL,
  headers: OutgoingHttpHeaders,
  body: string,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // no timeout: a whole answer's headers come when the answer is done, which can be minutes
    const r = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      headers,
      signal,
    });
    r.once("response", resolve);
    r.once("error", reject);
    r.end(body);
  });
}

async function collect(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** An error on a stream whose headers already went: an event in the door's own shape. */
function errorEvent(protocol: Protocol, type: string, message: string, body?: string): string {
  let payload: string;
  if (body) {
    try {
      JSON.parse(body);
      payload = body;
    } catch {
      payload = "";
    }
  } else payload = "";
  if (protocol === "messages")
    return `event: error\ndata: ${payload || JSON.stringify({ type: "error", error: { type, message } })}\n\n`;
  return `data: ${payload || JSON.stringify({ error: { message, type, code: type } })}\n\n`;
}

/** The end of an SSE event: a blank line, in any of the three line endings. */
const EVENT_END = /\r\n\r\n|\n\n|\r\r/u;

/**
 * A pass-through door: `path` is one of DOORS, `text` the client's body as it
 * came. The model is found among the served ones, by id, served name or alias.
 */
export async function passThrough(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  search: string,
  text: string,
  ctx: PassContext,
): Promise<void> {
  const protocol = DOORS[path];
  const counting = path === "/v1/messages/count_tokens";
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(res, protocol, 400, "invalid_request_error", "bad_request", "the body is not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return refuse(res, protocol, 400, "invalid_request_error", "bad_request", "the body is a JSON object");
  const asked = typeof body.model === "string" && body.model ? body.model : null;
  const found = asked ? ctx.served.find(asked) : ctx.served.default();
  // a chat request for a model no backend answers natively goes through pi-ai as it did before
  const native = found?.local === true && found.protocols.includes(protocol);
  if (!native && protocol === "chat-completions" && ctx.translate && !ctx.who.client)
    return ctx.translate(text);
  if (!found)
    return refuse(
      res,
      protocol,
      404,
      protocol === "messages" ? "not_found_error" : "invalid_request_error",
      "model_not_found",
      `no model ${asked ?? "is served"}; see GET /v1/models`,
    );
  const model = found;
  const who = ctx.who;
  const started = Date.now();
  const ledgerRow = (over: Partial<Row>) =>
    ctx.ledger.record({
      subject: who.subject,
      purpose: null,
      model: model.id,
      backend: null,
      grantId: null,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      gpuSeconds: 0,
      money: 0,
      ttftMs: null,
      totalMs: null,
      outcome: "completed",
      clientKey: who.client?.id ?? null,
      ...over,
    });
  const refused = (status: number, type: string, code: string, fact: string) => {
    if (!counting) ledgerRow({ outcome: "refused", refusal: { layer: "requirement", fact } });
    refuse(res, protocol, status, type, code, fact);
  };
  if (!mayUse(who, model, ctx.served))
    return refused(403, "permission_error", "model_not_allowed", `this key may not use model ${model.id}`);
  if (!model.local)
    return refused(
      403,
      "permission_error",
      "remote_model",
      `${model.id} runs outside the group's own systems; it is reached through the pi-messages door with a purpose`,
    );
  if (!native)
    return refused(
      400,
      "invalid_request_error",
      "not_on_this_door",
      `${model.id} is not served on ${path}; its backend speaks ${model.protocols.join(", ") || "none of the pass-through doors"}`,
    );
  // a key made with --no-swap is refused a request that would swap the card, rather than queued behind the
  // swap (record 47, K2); a model being loaded already, or loaded, costs no swap of its own
  if (model.status === "cold" && who.client && !who.client.swap)
    return refused(
      409,
      protocol === "messages" ? "invalid_request_error" : "conflict",
      "would_swap",
      `${model.id} is not loaded${model.card ? ` on ${model.card}` : ""}, and this key may not cause a swap to load it; ask for the loaded model (GET /v1/models says which), or use a key that may swap`,
    );
  // the two changes: the name the backend serves the model by, and Anthropic's thinking default
  body.model = model.upstream;
  if (path === "/v1/messages" && !("thinking" in body) && model.anthropicThinking === "disabled")
    body.thinking = { type: "disabled" };
  // the context guard, before any backend or card is touched
  if (!counting && model.contextLength) {
    const longest = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? 0) || 0;
    const input = estimateInput(body, protocol);
    if (longest > model.contextLength || input + longest > model.contextLength)
      return refused(
        400,
        "invalid_request_error",
        "context_length_exceeded",
        `the request asks for up to ${longest} output tokens beside at least ${input} input tokens, more than the ${model.contextLength} tokens of ${model.id}'s context`,
      );
  }
  const stream = body.stream === true;
  const strip =
    stream &&
    (protocol === "chat-completions" || protocol === "completions") &&
    (body.stream_options === undefined || body.stream_options === null);
  if (strip) body.stream_options = { include_usage: true };
  const out = JSON.stringify(body);

  const upstreamAbort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) upstreamAbort.abort();
  });
  // a stream that waits (a queue, a swap) gets its headers now and a comment each second, so no client
  // gives up on a response that says nothing; a whole answer gets its headers after a while and a newline
  // each keep-alive interval, which a JSON parser skips
  let committed = false;
  const kept: { alive: ReturnType<typeof keepAlive> | null } = { alive: null };
  const touch = () => kept.alive?.touch();
  const quiet = () => kept.alive?.stop();
  const keepAliveMs = ctx.keepAliveMs ?? KEEP_ALIVE_MS;
  const commit = (status = 200, headers: OutgoingHttpHeaders = {}) => {
    committed = true;
    res.writeHead(status, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...headers,
      "x-model": model.id,
    });
    kept.alive = keepAlive(res, keepAliveMs);
  };
  const commitWhole = () => {
    if (committed || res.writableEnded || res.destroyed) return;
    committed = true;
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-cache",
      "x-model": model.id,
    });
    res.write("\n");
    kept.alive = keepAlive(res, keepAliveMs, "\n");
  };
  const holding = stream ? null : setTimeout(commitWhole, ctx.wholeHeadersAfterMs ?? WHOLE_HEADERS_AFTER_MS);
  let lease: Lease;
  try {
    lease = await ctx.served.lease(model, {
      signal: upstreamAbort.signal,
      heartbeat: stream
        ? () => {
            if (!committed) commit();
            res.write(": queued\n\n");
            touch();
          }
        : () => {},
    });
  } catch (e) {
    const r =
      e instanceof LeaseRefused
        ? e
        : new LeaseRefused(503, "unavailable", e instanceof Error ? e.message : String(e));
    if (!counting)
      ledgerRow({
        outcome: upstreamAbort.signal.aborted ? "aborted" : "refused",
        refusal: { layer: "health", fact: r.message },
        totalMs: Date.now() - started,
      });
    if (holding) clearTimeout(holding);
    if (committed && !stream) {
      res.write(JSON.stringify(errorBody(protocol, "overloaded_error", r.code, r.message)));
      quiet();
      res.end();
    } else if (committed) {
      res.write(errorEvent(protocol, "overloaded_error", r.message));
      quiet();
      res.end();
    } else
      refuse(
        res,
        protocol,
        r.status,
        r.status === 503 ? "overloaded_error" : "invalid_request_error",
        r.code,
        r.message,
      );
    return;
  }
  const waited = Date.now() - started;
  const meter = new Meter(protocol, strip);
  let outcome: Row["outcome"] = "completed";
  // a backend that holds a stream's headers while it reads a long prompt: Kvasir's own go after the
  // same silence a comment would end, and the comments keep the client
  const early = stream
    ? setTimeout(() => {
        if (committed || res.writableEnded) return;
        commit();
        res.write(": ping\n\n");
        touch();
      }, ctx.keepAliveMs ?? KEEP_ALIVE_MS)
    : null;
  try {
    const url = new URL(`${lease.base.replace(/\/+$/u, "")}${path}${search}`);
    const up = await send(
      url,
      forwarded(req.headers, lease, Buffer.byteLength(out)),
      out,
      upstreamAbort.signal,
    );
    if (early) clearTimeout(early);
    if (holding) clearTimeout(holding);
    const status = up.statusCode ?? 502;
    if (status < 400) lease.answered?.();
    const sse = String(up.headers["content-type"] ?? "").includes("text/event-stream");
    const extra: OutgoingHttpHeaders =
      waited > 1000 ? { "x-model-load-wait": String(Math.round(waited / 1000)) } : {};
    if (sse) {
      if (!committed) commit(status, { ...answered(up.headers), ...extra });
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of up) {
        buffer += decoder.decode(chunk as Buffer, { stream: true });
        for (let m = EVENT_END.exec(buffer); m; m = EVENT_END.exec(buffer)) {
          const end = m.index + m[0].length;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end);
          if (meter.frame(frame.slice(0, m.index))) {
            res.write(frame);
            touch();
          }
        }
      }
      buffer += decoder.decode();
      if (buffer) res.write(buffer);
      if (status >= 400 || meter.failed) outcome = "error";
    } else {
      const whole = await collect(up);
      const answer = whole.toString("utf8");
      if (status < 400) {
        try {
          meter.whole(JSON.parse(answer));
        } catch {
          // an answer that is not JSON goes to the client as it is, uncounted
        }
      } else outcome = "error";
      if (committed && stream) {
        // a stream's headers went while it waited: a whole answer, which a backend gives when it refuses,
        // is an event, an error event where it refused
        if (status >= 400)
          res.write(errorEvent(protocol, "api_error", `the backend answered ${status}`, answer));
        else res.write(`data: ${answer}\n\n`);
      } else if (committed) {
        // the headers went while the request waited (200, JSON): the answer follows the newlines as it came,
        // and an error the backend answered is the body, in the door's own shape where it was not JSON
        let parsed = false;
        try {
          JSON.parse(answer);
          parsed = true;
        } catch {
          parsed = false;
        }
        res.write(
          parsed
            ? answer
            : JSON.stringify(errorBody(protocol, "api_error", "backend", `the backend answered ${status}`)),
        );
      } else {
        const headers = {
          ...answered(up.headers),
          ...extra,
          "x-model": model.id,
          "content-length": whole.length,
        };
        res.writeHead(status, headers);
        res.write(whole);
      }
    }
  } catch (e) {
    outcome = upstreamAbort.signal.aborted ? "aborted" : "error";
    if (outcome === "error") {
      const message = "the backend did not answer";
      console.error(`kvasir: ${model.id} on ${lease.backend}: ${e instanceof Error ? e.message : e}`);
      if (committed && !stream)
        res.write(JSON.stringify(errorBody(protocol, "api_error", "backend", message)));
      else if (committed) res.write(errorEvent(protocol, "api_error", message));
      else if (!res.headersSent) refuse(res, protocol, 502, "api_error", "backend", message);
    }
  } finally {
    if (early) clearTimeout(early);
    if (holding) clearTimeout(holding);
    lease.release();
    quiet();
    if (!res.writableEnded) res.end();
  }
  if (outcome === "completed" && meter.capped) outcome = "capped";
  if (counting) return;
  const totalMs = Date.now() - started;
  ledgerRow({
    backend: lease.backend,
    input: meter.input,
    output: meter.output,
    cacheRead: meter.cacheRead,
    cacheWrite: meter.cacheWrite,
    reasoning: meter.reasoning,
    ttftMs: meter.firstAt === null ? null : meter.firstAt - started,
    totalMs,
    gpuSeconds: totalMs / 1000,
    outcome,
  });
}
