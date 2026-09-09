// SPDX-License-Identifier: AGPL-3.0-only
// The backends: a fixed list of adapters, each a pi-ai api, the runtime key
// held here, and the health rule of §8.5: a backend is warming until it has
// produced a first token since Kvasir started.

import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import { type BackendConfig, keyOf, type ModelEntry } from "./config.js";

export interface Health {
  /** No first token since start. */
  warming: boolean;
  firstTokenAt: number | null;
  lastError: string | null;
  /** Streams running now, of the concurrency admitted. */
  running: number;
  concurrency: number;
}

export class Backend {
  readonly config: BackendConfig;
  private readonly key: string | undefined;
  readonly health: Health;

  constructor(config: BackendConfig) {
    this.config = config;
    this.key = keyOf(config);
    this.health = {
      warming: true,
      firstTokenAt: null,
      lastError: null,
      running: 0,
      concurrency: config.concurrency,
    };
  }

  /** The pi model of one entry, as the backend serves it. */
  model(entry: ModelEntry): Model<"openai-completions" | "anthropic-messages"> {
    return {
      id: entry.id,
      name: entry.name,
      api: this.config.kind,
      provider: this.config.id as Model<"openai-completions">["provider"],
      baseUrl: this.config.baseUrl,
      reasoning: entry.reasoning,
      input: entry.input,
      cost: entry.cost,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    } as Model<"openai-completions" | "anthropic-messages">;
  }

  /**
   * One stream through pi-ai's own adapter, the key attached here. The
   * first text or thinking delta ends warming; an error before it is kept
   * as the last error.
   */
  async *stream(
    entry: ModelEntry,
    context: Context,
    options: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
  ): AsyncGenerator<AssistantMessageEvent> {
    const model = this.model(entry);
    this.health.running += 1;
    try {
      const common = {
        apiKey: this.key ?? "none",
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        signal: options.signal,
      };
      // the adapters are a fixed list in code (§8.1): no URL a caller names
      const events =
        this.config.kind === "anthropic-messages"
          ? anthropicStream(model as Model<"anthropic-messages">, context, common)
          : openaiStream(model as Model<"openai-completions">, context, common);
      for await (const ev of events) {
        if (
          this.health.warming &&
          (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")
        ) {
          this.health.warming = false;
          this.health.firstTokenAt = Date.now();
        }
        if (ev.type === "error") this.health.lastError = ev.error.errorMessage ?? "error";
        yield ev;
      }
    } finally {
      this.health.running -= 1;
    }
  }

  /** The warm-up at start (§8.5): one short request whose first token ends warming. */
  async warmup(): Promise<void> {
    const entry = this.config.models[0];
    if (!entry || this.config.warmup === false) return;
    try {
      const events = this.stream(
        entry,
        { messages: [{ role: "user", content: "Say ready.", timestamp: Date.now() }] },
        { maxTokens: 8 },
      );
      for await (const _ of events) {
        // the first delta flips warming inside stream()
      }
    } catch (e) {
      this.health.lastError = e instanceof Error ? e.message : String(e);
    }
  }
}

export class Backends {
  readonly list: Backend[];
  constructor(configs: BackendConfig[]) {
    this.list = configs.map((c) => new Backend(c));
  }

  /** The backend and entry that serve a model id, or nothing. */
  find(modelId: string): { backend: Backend; entry: ModelEntry } | undefined {
    for (const backend of this.list) {
      const entry = backend.config.models.find((m) => m.id === modelId);
      if (entry) return { backend, entry };
    }
    return undefined;
  }

  /** The catalog of `GET /v1/config`, as pi's model store reads it. */
  catalog(origin: string) {
    return {
      baseUrl: `${origin}/v1`,
      models: this.list.flatMap((b) =>
        b.config.models.map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          backend: b.config.id,
          locality: b.config.locality,
        })),
      ),
      backends: this.list.map((b) => ({
        id: b.config.id,
        kind: b.config.kind,
        locality: b.config.locality,
        health: { ...b.health },
      })),
      health: { warming: this.list.some((b) => b.health.warming) },
    };
  }
}
