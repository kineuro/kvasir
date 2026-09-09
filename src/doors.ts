// SPDX-License-Identifier: AGPL-3.0-only
// The doors of §8.2: pi-messages (primary), the OpenAI-shaped secondary,
// the catalog, health.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import type { Backends } from "./backends.js";

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

function sse(res: ServerResponse): (event: unknown) => void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  return (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
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

/** `POST /v1/messages`: `{model, context, options}` in, the event stream out. */
export async function piMessages(
  req: IncomingMessage,
  res: ServerResponse,
  backends: Backends,
): Promise<void> {
  let body: { model?: string; context?: Context; options?: Record<string, unknown> };
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { error: { code: "bad_request", message: e instanceof Error ? e.message : "not JSON" } });
    return;
  }
  const found = typeof body.model === "string" ? backends.find(body.model) : undefined;
  if (!found) {
    json(res, 404, {
      error: { code: "no_such_model", message: `no model named ${body.model} in the catalog` },
    });
    return;
  }
  if (!body.context || !Array.isArray(body.context.messages)) {
    json(res, 400, { error: { code: "bad_request", message: "context: pi's context, with its messages" } });
    return;
  }
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const send = sse(res);
  const o = body.options ?? {};
  try {
    for await (const ev of found.backend.stream(found.entry, body.context, {
      temperature: typeof o.temperature === "number" ? o.temperature : undefined,
      maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : undefined,
      signal: controller.signal,
    })) {
      send(toPiMessagesEvent(ev));
    }
  } catch (e) {
    // a provider error body never leaves: a classified code and a fixed sentence (§8.7)
    send({ type: "error", reason: "error", usage: emptyUsage(), errorMessage: "the backend did not answer" });
    found.backend.health.lastError = e instanceof Error ? e.message : String(e);
  }
  res.end();
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

/** `POST /v1/chat/completions`: the OpenAI shape for a notebook or a script (§8.2). */
export async function chatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  backends: Backends,
): Promise<void> {
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
  const found = typeof body.model === "string" ? backends.find(body.model) : undefined;
  if (!found || !Array.isArray(body.messages)) {
    json(res, found ? 400 : 404, {
      error: { message: found ? "messages" : `no model named ${body.model}`, type: "invalid_request_error" },
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
        api: found.backend.config.kind,
        provider: found.backend.config.id,
        model: found.entry.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
    }
  }
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const events = found.backend.stream(found.entry, context, {
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    signal: controller.signal,
  });
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: found.entry.id, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    for await (const ev of events) {
      if (ev.type === "text_delta") chunk({ content: ev.delta });
      else if (ev.type === "thinking_delta") chunk({ reasoning_content: ev.delta });
      else if (ev.type === "done") chunk({}, ev.reason === "length" ? "length" : "stop");
      else if (ev.type === "error") chunk({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  let text = "";
  let reasoning = "";
  let finish = "stop";
  let usage = emptyUsage();
  for await (const ev of events) {
    if (ev.type === "text_delta") text += ev.delta;
    else if (ev.type === "thinking_delta") reasoning += ev.delta;
    else if (ev.type === "done") {
      finish = ev.reason === "length" ? "length" : "stop";
      usage = ev.message.usage;
    }
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
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.totalTokens },
  });
}
