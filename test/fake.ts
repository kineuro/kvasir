// SPDX-License-Identifier: AGPL-3.0-only
// Fake runtimes for the tests: an OpenAI-completions runtime that honours
// or ignores the schemas, and an Anthropic-shaped one that carries a
// thinking signature; shared by the admission and the lifecycle tests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FIXTURES } from "../src/fixtures/suite.js";

export async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function serve(
  handler: (req: IncomingMessage, res: ServerResponse, text: string) => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => handler(req, res, await body(req)));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}`, server });
    }),
  );
}

export function sse(res: ServerResponse, events: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
  res.end();
}

export const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
  id: "x",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

/**
 * A fake OpenAI-completions runtime that answers every fixture with its
 * call. `honours` decides the schema and the oversized prompt: honouring
 * means two operands whatever the prompt asks and a 400 on overflow;
 * ignoring means one operand as asked and a silent length stop.
 */
export async function fakeRuntime(honours: boolean) {
  return serve((req, res, text) => {
    if (req.url === "/get_server_info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ version: "0.5.9-test", model_path: "/models/fake", attention_backend: "fake" }),
      );
      return;
    }
    const q = JSON.parse(text);
    const last = String(q.messages.at(-1)?.content ?? "");
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (last.length > 40_000) {
      if (honours) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the prompt is longer than the context" } }));
      } else sse(res, [chunk({ role: "assistant", content: "" }), chunk({}, "length", usage), "[DONE]"]);
      return;
    }
    const tools = (q.tools ?? []) as { function: { name: string } }[];
    if (tools.some((t) => t.function.name === "where_clause")) {
      const clause = honours || !/one element/u.test(last) ? ["=", "base", "T1w"] : ["T1w"];
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "c1",
              type: "function",
              function: { name: "where_clause", arguments: JSON.stringify({ clause }) },
            },
          ],
        }),
        chunk({}, "tool_calls", usage),
        "[DONE]",
      ]);
      return;
    }
    if (tools.length > 0) {
      const f = FIXTURES.find((x) => x.prompt === last);
      const call = f
        ? { name: f.tool, arguments: JSON.stringify(f.args) }
        : { name: "nils_guide", arguments: "{}" };
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: call }] }),
        chunk({}, "tool_calls", usage),
        "[DONE]",
      ]);
      return;
    }
    sse(res, [
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "ready" }),
      chunk({}, "stop", usage),
      "[DONE]",
    ]);
  });
}

/** A fake Anthropic runtime: a signed thinking block, and a second turn accepted only when the signature comes back byte for byte. */
export async function fakeAnthropic(signature: string) {
  return serve((req, res, text) => {
    if (!text) {
      // the runtime probe: this fake has no server info
      res.writeHead(404);
      res.end();
      return;
    }
    const q = JSON.parse(text);
    const back = JSON.stringify(q.messages).includes(signature);
    if (q.messages.length > 1 && !back) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "the signature does not match" },
        }),
      );
      return;
    }
    const events: [string, unknown][] = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "m1",
            type: "message",
            role: "assistant",
            model: "claude",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "17 and 25" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "content_block_start",
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "42" } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [name, e] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
}

export function entry(id: string, reasoning = false) {
  return {
    id,
    name: id,
    reasoning,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export const local = (url: string, id = "card", models = [entry("qwen")]) => ({
  id,
  kind: "openai-completions",
  baseUrl: `${url}/v1`,
  key: "k",
  locality: "local",
  warmup: false,
  models,
});
