// SPDX-License-Identifier: AGPL-3.0-only
// The doors of §8.2: pi-messages (primary), the OpenAI-shaped secondary,
// the catalog, health.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { RefusedAdmission } from "./admission.js";
import type { Principal } from "./auth.js";
import type { Backends } from "./backends.js";
import type { Ledger, Row } from "./ledger.js";
import { type Grant, identifierShape, type Policy, Refused as PolicyRefused } from "./policy.js";

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export async function readBody(req: IncomingMessage, limit = 32 << 20): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("the body is over the door's limit");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** How long a stream may say nothing before Kvasir writes a comment on it. */
export const KEEP_ALIVE_MS = 15_000;

/**
 * A comment on a stream that has said nothing for `everyMs`. A model reading a
 * long prompt on the processor can be silent for minutes before its first
 * token, and a caller's HTTP client ends a response that says nothing for long
 * enough (Node's fetch after 300 seconds), so the turn failed as "terminated".
 * A comment is no event to any reader of a stream. `touch` marks a write;
 * `stop` ends it, as does the response closing.
 */
export function keepAlive(res: ServerResponse, everyMs: number): { touch: () => void; stop: () => void } {
  let last = Date.now();
  const timer = setInterval(
    () => {
      if (res.writableEnded || res.destroyed || Date.now() - last < everyMs) return;
      res.write(": ping\n\n");
      last = Date.now();
    },
    Math.max(20, Math.min(1_000, Math.floor(everyMs / 4))),
  );
  timer.unref();
  const stop = () => clearInterval(timer);
  res.on("close", stop);
  return {
    touch: () => {
      last = Date.now();
    },
    stop,
  };
}

function sse(
  res: ServerResponse,
  everyMs: number,
): { send: (event: unknown) => void; alive: ReturnType<typeof keepAlive> } {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const alive = keepAlive(res, everyMs);
  return {
    send: (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      alive.touch();
    },
    alive,
  };
}

/** The pi-messages event on the wire: the partial message stripped, the terminal events with usage. */
export function toPiMessagesEvent(ev: AssistantMessageEvent): Record<string, unknown> {
  switch (ev.type) {
    case "start":
      return { type: "start" };
    case "text_start":
    case "thinking_start":
      return { type: ev.type, contentIndex: ev.contentIndex };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: ev.type, contentIndex: ev.contentIndex, delta: ev.delta };
    case "text_end": {
      const block = ev.partial.content[ev.contentIndex] as { textSignature?: string } | undefined;
      return {
        type: "text_end",
        contentIndex: ev.contentIndex,
        content: ev.content,
        ...(block?.textSignature ? { contentSignature: block.textSignature } : {}),
      };
    }
    case "thinking_end": {
      const block = ev.partial.content[ev.contentIndex] as
        | { thinkingSignature?: string; redacted?: boolean }
        | undefined;
      return {
        type: "thinking_end",
        contentIndex: ev.contentIndex,
        content: ev.content,
        ...(block?.thinkingSignature ? { contentSignature: block.thinkingSignature } : {}),
        ...(block?.redacted ? { redacted: true } : {}),
      };
    }
    case "toolcall_start": {
      const block = ev.partial.content[ev.contentIndex] as { id?: string; name?: string } | undefined;
      return {
        type: "toolcall_start",
        contentIndex: ev.contentIndex,
        id: block?.id ?? "",
        toolName: block?.name ?? "",
      };
    }
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: ev.contentIndex, toolCall: ev.toolCall };
    case "done":
      return { type: "done", reason: ev.reason, usage: ev.message.usage, responseId: ev.message.responseId };
    case "error":
      return {
        type: "error",
        reason: ev.reason,
        usage: ev.error.usage,
        errorMessage: ev.error.errorMessage,
        responseId: ev.error.responseId,
      };
  }
}

type Found = NonNullable<ReturnType<Backends["find"]>>;

/**
 * Whose stream a call is: the subject its ledger row names, a person's, the
 * system's where nobody signs in, or the app's own (record 23); and whose
 * subscription it may use, or none where that person does not hold what a
 * subscription needs (record 25).
 */
export interface Whose {
  subject: string;
  subscriber: string | null;
}

/** Where a call may go (§8.3), or why it may not. */
type Decision =
  | { ok: true; found: Found; granted: Grant | null; purpose: string | null }
  | { ok: false; refused: PolicyRefused; purpose: string | null };

/**
 * The purpose of a call (§8.3), whichever door it came through: a grant
 * already taken, a registered purpose the caller names or its key allows,
 * or without either a local backend only. The text is read for an
 * identifier shape, which keeps the call local whatever the table says.
 */
function decide(
  req: IncomingMessage,
  who: Principal,
  named: Found,
  model: string,
  text: string,
  policy: Policy,
  backends: Backends,
  /** Whose subscription the call may use, or none (record 25). */
  subscriber: string | null,
): Decision {
  let granted: Grant | null = null;
  let purpose: string | null = null;
  const grantHeader = String(req.headers["x-kvasir-grant"] ?? "");
  const purposeHeader = String(req.headers["x-kvasir-purpose"] ?? "");
  const bumped = identifierShape(text);
  try {
    if (grantHeader) {
      granted = policy.take(grantHeader) ?? null;
      if (!granted)
        throw new PolicyRefused(403, [
          { layer: "policy", fact: "the grant is unknown or expired", relaxation: "ask for a grant again" },
        ]);
      // a grant that went to a subscription goes to the default for a stream no subscription answers (record 25)
      const unanswered =
        backends.get(granted.backend)?.config.builtin === true &&
        !(subscriber !== null && policy.subscribed(subscriber));
      if ((bumped && granted.locality === "remote") || unanswered) {
        granted = policy.grant(
          granted.purpose,
          {},
          { bumped, keyClass: who.key?.maxClass, subject: subscriber },
        );
      }
    } else if (purposeHeader || (who.kind === "key" && (who.key?.purposes.length ?? 0) > 0)) {
      purpose = purposeHeader || (who.key?.purposes[0] ?? "");
      if (who.kind === "key" && !who.key?.purposes.includes(purpose)) {
        throw new PolicyRefused(403, [
          { layer: "policy", fact: `the key's purposes do not include ${purpose}` },
        ]);
      }
      granted = policy.grant(
        purpose,
        {},
        {
          pin: model,
          bumped,
          keyClass: who.key?.maxClass,
          subject: subscriber,
        },
      );
    } else if (named.backend.config.locality !== "local") {
      throw new PolicyRefused(403, [
        {
          layer: "policy",
          fact: "a purpose is required to reach a remote backend; without one a call runs local only",
          relaxation: "send x-kvasir-purpose, or a grant",
        },
      ]);
    }
  } catch (e) {
    if (e instanceof PolicyRefused) return { ok: false, refused: e, purpose };
    throw e;
  }
  // the grant decides the backend and the model; a caller that named another is moved
  let found = named;
  if (granted && (granted.model !== named.entry.id || granted.backend !== named.backend.config.id)) {
    found = backends.find(granted.model) ?? named;
  }
  return { ok: true, found, granted, purpose };
}

/** `POST /v1/messages`: `{model, context, options}` in, the event stream out, one ledger row. */
export async function piMessages(
  req: IncomingMessage,
  res: ServerResponse,
  backends: Backends,
  who: Principal,
  ledger: Ledger,
  policy: Policy,
  whose: Whose,
  opts: { keepAliveMs?: number } = {},
): Promise<void> {
  const { subject, subscriber } = whose;
  let body: { model?: string; context?: Context; options?: Record<string, unknown> };
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { error: { code: "bad_request", message: e instanceof Error ? e.message : "not JSON" } });
    return;
  }
  const named = typeof body.model === "string" ? backends.find(body.model) : undefined;
  if (!named) {
    json(res, 404, {
      error: { code: "no_such_model", message: `no model named ${body.model} in the catalog` },
    });
    return;
  }
  if (!body.context || !Array.isArray(body.context.messages)) {
    json(res, 400, { error: { code: "bad_request", message: "context: pi's context, with its messages" } });
    return;
  }
  const decision = decide(
    req,
    who,
    named,
    String(body.model),
    userText(body.context),
    policy,
    backends,
    subscriber,
  );
  if (!decision.ok) {
    const first = decision.refused.refusals[0];
    ledger.record(
      row(subject, named, {
        outcome: "refused",
        refusal: { layer: first.layer, fact: first.fact },
        purpose: decision.purpose,
      }),
    );
    json(res, decision.refused.status, {
      error: {
        code: "refused",
        layer: first.layer,
        message: first.fact,
        refusals: decision.refused.refusals,
      },
    });
    return;
  }
  const { found, granted, purpose } = decision;
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const started = Date.now();
  // the queue (§8.7): the headers go out now; a heartbeat keeps the socket while waiting, and a
  // comment keeps it while the model says nothing
  const { send, alive } = sse(res, opts.keepAliveMs ?? KEEP_ALIVE_MS);
  let release: (() => void) | null = null;
  try {
    release = await found.backend.admission.acquire(() => {
      res.write(": queued\n\n");
      alive.touch();
    }, controller.signal);
  } catch (e) {
    const refusal = e instanceof RefusedAdmission ? e.refusal : { layer: "health" as const, fact: "no slot" };
    send({
      type: "error",
      reason: "error",
      usage: emptyUsage(),
      errorMessage: `refused at the ${refusal.layer} layer: ${refusal.fact}`,
    });
    alive.stop();
    res.end();
    ledger.record(
      row(subject, found, {
        outcome: "refused",
        refusal,
        totalMs: Date.now() - started,
        purpose: granted?.purpose ?? purpose,
        grantId: granted?.grant ?? null,
      }),
    );
    return;
  }
  const o = body.options ?? {};
  let ttftMs: number | null = null;
  let outcome: Row["outcome"] = "completed";
  let usage: Partial<Row> | null = null;
  try {
    for await (const ev of found.backend.stream(found.entry, asBackendTurns(body.context, found), {
      temperature: typeof o.temperature === "number" ? o.temperature : undefined,
      maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : undefined,
      signal: controller.signal,
      subject: subscriber ?? undefined,
    })) {
      if (
        ttftMs === null &&
        (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")
      ) {
        ttftMs = Date.now() - started;
      }
      if (ev.type === "done") {
        usage = counts(ev.message.usage);
        if (ev.reason === "length") outcome = "capped";
      }
      if (ev.type === "error") {
        usage = counts(ev.error.usage);
        outcome = ev.reason === "aborted" ? "aborted" : "error";
      }
      send(toPiMessagesEvent(ev));
    }
  } catch (e) {
    // a provider error body never leaves: a classified code and a fixed sentence (§8.7)
    send({ type: "error", reason: "error", usage: emptyUsage(), errorMessage: "the backend did not answer" });
    found.backend.health.lastError = e instanceof Error ? e.message : String(e);
    outcome = controller.signal.aborted ? "aborted" : "error";
  } finally {
    release();
  }
  alive.stop();
  res.end();
  const totalMs = Date.now() - started;
  ledger.record(
    row(subject, found, {
      ...(usage ?? {}),
      outcome,
      ttftMs,
      totalMs,
      gpuSeconds: found.backend.config.locality === "local" ? totalMs / 1000 : 0,
      purpose: granted?.purpose ?? purpose,
      grantId: granted?.grant ?? null,
    }),
  );
}

/**
 * A context's earlier turns as this backend's own (the chat, slice 9). A client
 * records a turn under Kvasir's catalog id and its own provider, so pi would take
 * it for another model's turn and paste its thinking into the answer's text. A
 * turn this model wrote is handed back under the backend's identity, so its
 * thinking replays as thinking, signature and all; thinking another model wrote
 * is left out.
 */
export function asBackendTurns(context: Context, found: Found): Context {
  const model = found.backend.model(found.entry);
  const same = new Set([found.entry.id, model.id]);
  return {
    ...context,
    messages: context.messages.map((m) => {
      if (m.role !== "assistant") return m;
      if (same.has(m.model)) return { ...m, api: model.api, provider: model.provider, model: model.id };
      return { ...m, content: m.content.filter((c) => c.type !== "thinking") };
    }),
  };
}

/** The person's own words in a context: the last user message and the system prompt, for the identifier-shape rule. */
function userText(context: Context): string {
  const parts: string[] = [context.systemPrompt ?? ""];
  for (const m of context.messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else for (const c of m.content) if (c.type === "text") parts.push(c.text);
  }
  return parts.join("\n");
}

function counts(
  u:
    | { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } }
    | undefined,
): Partial<Row> {
  if (!u) return {};
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    money: u.cost?.total ?? 0,
  };
}

function row(
  subject: string,
  found: { backend: { config: { id: string } }; entry: { id: string } },
  over: Partial<Row>,
): Row {
  return {
    subject,
    purpose: null,
    model: found.entry.id,
    backend: found.backend.config.id,
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
    ...over,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * `POST /v1/chat/completions`: the OpenAI shape for a notebook or a script
 * (§8.2). It goes the way the messages door goes: the purpose and the policy
 * decide where the call may run, it waits its turn in the backend's queue,
 * and it is one ledger row.
 */
export async function chatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  backends: Backends,
  who: Principal,
  ledger: Ledger,
  policy: Policy,
  whose: Whose,
  opts: { keepAliveMs?: number } = {},
): Promise<void> {
  const { subject, subscriber } = whose;
  let body: {
    model?: string;
    messages?: { role: string; content: unknown }[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
  };
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, {
      error: { message: e instanceof Error ? e.message : "not JSON", type: "invalid_request_error" },
    });
    return;
  }
  const named = typeof body.model === "string" ? backends.find(body.model) : undefined;
  if (!named || !Array.isArray(body.messages)) {
    json(res, named ? 400 : 404, {
      error: { message: named ? "messages" : `no model named ${body.model}`, type: "invalid_request_error" },
    });
    return;
  }
  const context: Context = { messages: [] };
  for (const m of body.messages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role === "system") context.systemPrompt = `${context.systemPrompt ?? ""}${text}`;
    else if (m.role === "user") context.messages.push({ role: "user", content: text, timestamp: Date.now() });
    else if (m.role === "assistant") {
      context.messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        api: named.backend.config.kind,
        provider: named.backend.config.id,
        model: named.entry.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
    }
  }
  const decision = decide(
    req,
    who,
    named,
    String(body.model),
    userText(context),
    policy,
    backends,
    subscriber,
  );
  if (!decision.ok) {
    const first = decision.refused.refusals[0];
    ledger.record(
      row(subject, named, {
        outcome: "refused",
        refusal: { layer: first.layer, fact: first.fact },
        purpose: decision.purpose,
      }),
    );
    json(res, decision.refused.status, {
      error: {
        message: first.fact,
        type: "refused",
        code: "refused",
        layer: first.layer,
        refusals: decision.refused.refusals,
      },
    });
    return;
  }
  const { found, granted, purpose } = decision;
  const ledgerRow = (over: Partial<Row>) =>
    ledger.record(
      row(subject, found, { purpose: granted?.purpose ?? purpose, grantId: granted?.grant ?? null, ...over }),
    );
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const started = Date.now();
  const stream = body.stream === true;
  // the queue (§8.7): a stream's headers go out now and a heartbeat keeps the socket while it waits,
  // and a comment keeps it while the model says nothing
  if (stream) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const alive = stream ? keepAlive(res, opts.keepAliveMs ?? KEEP_ALIVE_MS) : null;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: found.entry.id, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
    alive?.touch();
  };
  let release: (() => void) | null = null;
  try {
    release = await found.backend.admission.acquire(
      stream
        ? () => {
            res.write(": queued\n\n");
            alive?.touch();
          }
        : undefined,
      controller.signal,
    );
  } catch (e) {
    const refusal = e instanceof RefusedAdmission ? e.refusal : { layer: "health" as const, fact: "no slot" };
    const message = `refused at the ${refusal.layer} layer: ${refusal.fact}`;
    if (stream) {
      res.write(`data: ${JSON.stringify({ error: { message, type: "refused", code: "refused" } })}\n\n`);
      res.write("data: [DONE]\n\n");
      alive?.stop();
      res.end();
    } else {
      json(res, 503, { error: { message, type: "refused", code: "refused", layer: refusal.layer } });
    }
    ledgerRow({ outcome: "refused", refusal, totalMs: Date.now() - started });
    return;
  }
  let ttftMs: number | null = null;
  let outcome: Row["outcome"] = "completed";
  let counted: Partial<Row> | null = null;
  let text = "";
  let reasoning = "";
  let finish = "stop";
  let tokens = { input: 0, output: 0, total: 0 };
  try {
    if (stream) chunk({ role: "assistant", content: "" });
    for await (const ev of found.backend.stream(found.entry, context, {
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      signal: controller.signal,
      subject: subscriber ?? undefined,
    })) {
      if (
        ttftMs === null &&
        (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")
      ) {
        ttftMs = Date.now() - started;
      }
      if (ev.type === "text_delta") {
        text += ev.delta;
        if (stream) chunk({ content: ev.delta });
      } else if (ev.type === "thinking_delta") {
        reasoning += ev.delta;
        if (stream) chunk({ reasoning_content: ev.delta });
      } else if (ev.type === "done") {
        counted = counts(ev.message.usage);
        tokens = {
          input: ev.message.usage.input,
          output: ev.message.usage.output,
          total: ev.message.usage.totalTokens,
        };
        finish = ev.reason === "length" ? "length" : "stop";
        if (ev.reason === "length") outcome = "capped";
        if (stream) chunk({}, finish);
      } else if (ev.type === "error") {
        counted = counts(ev.error.usage);
        outcome = ev.reason === "aborted" ? "aborted" : "error";
        if (stream) chunk({}, "stop");
      }
    }
  } catch (e) {
    found.backend.health.lastError = e instanceof Error ? e.message : String(e);
    outcome = controller.signal.aborted ? "aborted" : "error";
  } finally {
    release();
  }
  const totalMs = Date.now() - started;
  ledgerRow({
    ...(counted ?? {}),
    outcome,
    ttftMs,
    totalMs,
    gpuSeconds: found.backend.config.locality === "local" ? totalMs / 1000 : 0,
  });
  if (stream) {
    res.write("data: [DONE]\n\n");
    alive?.stop();
    res.end();
    return;
  }
  if (outcome === "error") {
    // a provider error body never leaves: a fixed sentence (§8.7)
    json(res, 502, {
      error: { message: "the backend did not answer", type: "server_error", code: "backend" },
    });
    return;
  }
  json(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: found.entry.id,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.total },
  });
}
