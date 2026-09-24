// SPDX-License-Identifier: AGPL-3.0-only
// The backends: a fixed list of adapters, each a pi-ai api, the key taken
// from the credentials at use, and the health rule of §8.5: a backend is
// warming until it has produced a first token since Kvasir started. The list
// is the models Kvasir holds (src/held.ts), and it grows and shrinks as an
// admin adds and removes them.

import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import { Admission } from "./admission.js";
import type { BackendConfig, ModelEntry } from "./config.js";
import { splitInline } from "./inline.js";

export interface Health {
  /**
   * No first token since start, on a backend Kvasir warms. A backend it does not warm (`warmup: false`) is
   * never warming, and a card's model warms only while the card loads it at start (kineuro/kvasir#8).
   */
  warming: boolean;
  /** A card's model (record 47): loaded, being loaded, or cold, so asking it loads it. Absent elsewhere. */
  status?: "loaded" | "loading" | "cold";
  firstTokenAt: number | null;
  lastError: string | null;
  /** Streams running now, of the concurrency admitted. */
  running: number;
  concurrency: number;
}

/** The waits between warm-up tries (§8.5): five seconds, doubling to a minute, then a minute each. */
export const WARM_WAITS = [5_000, 10_000, 20_000, 40_000, 60_000];

export class Backend {
  readonly config: BackendConfig;
  /** The credential store's answer for this backend and the person streaming, at use, never kept (§8.4). */
  credential: ((subject?: string) => Promise<string | null> | string | null) | null = null;
  /** pi-ai's own model for an entry, where it knows the model better than an entry does: ChatGPT's carry their reasoning levels and flags. */
  native: ((entry: ModelEntry) => Model<"openai-codex-responses"> | undefined) | null = null;
  readonly health: Health;
  readonly admission: Admission;
  /** The models of this backend that passed the suite for the current runtime (§8.6); every model of a remote backend. */
  readonly admitted = new Set<string>();
  /** Kvasir is closing: a warm-up still being tried ends, and none starts. */
  private stopped = false;
  private readonly quiet = new AbortController();
  private wake: (() => void) | null = null;

  constructor(config: BackendConfig, queue = 8, waitCapMs = 60_000) {
    this.config = config;
    // the warm-up rule (§8.5) is a local runtime's; a remote provider is not warmed by us, and a backend
    // nobody asks to warm is not warming: it would hold the desk on its warming page for ever (#8)
    const warming = config.locality === "local" && config.warmup !== false;
    this.health = {
      warming,
      firstTokenAt: null,
      lastError: null,
      running: 0,
      concurrency: config.concurrency,
    };
    this.admission = new Admission(config.concurrency, queue, waitCapMs);
  }

  /** The compatibility flags of this backend: the operator's, over the local runtime defaults. */
  compat(): Record<string, unknown> | undefined {
    const local =
      this.config.kind === "openai-completions" && this.config.locality === "local"
        ? { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" }
        : {};
    const merged = { ...local, ...(this.config.compat ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /** The pi model of one entry, as the backend serves it. */
  model(entry: ModelEntry): Model<"openai-completions" | "anthropic-messages" | "openai-codex-responses"> {
    const native = this.native?.(entry);
    if (native) return native;
    const compat = this.compat();
    return {
      ...(compat ? { compat } : {}),
      id: entry.upstream ?? entry.id,
      name: entry.name,
      api: this.config.kind,
      provider: this.config.id as Model<"openai-completions">["provider"],
      baseUrl: this.config.baseUrl,
      reasoning: entry.reasoning,
      input: entry.input,
      cost: entry.cost,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    } as Model<"openai-completions" | "anthropic-messages" | "openai-codex-responses">;
  }

  /**
   * One stream through pi-ai's own adapter, the key attached here. The
   * first text or thinking delta ends warming; an error before it is kept
   * as the last error.
   */
  async *stream(
    entry: ModelEntry,
    context: Context,
    options: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      toolChoice?: unknown;
      /** The person streaming, whose own subscription a ChatGPT stream uses (record 23). */
      subject?: string;
    },
  ): AsyncGenerator<AssistantMessageEvent> {
    const model = this.model(entry);
    this.health.running += 1;
    try {
      const common = {
        apiKey: (await this.credential?.(options.subject)) ?? "none",
        temperature: options.temperature ?? this.config.defaults?.temperature,
        maxTokens: options.maxTokens,
        signal: options.signal,
        // the suite forces a call for the negative control (§8.6); a client never sets it
        ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice as never } : {}),
      };
      // the adapters are a fixed list in code (§8.1): no URL a caller names
      const events =
        this.config.kind === "anthropic-messages"
          ? anthropicStream(model as Model<"anthropic-messages">, context, common)
          : this.config.kind === "openai-codex-responses"
            ? codexStream(model as Model<"openai-codex-responses">, context, common)
            : openaiStream(model as Model<"openai-completions">, context, common);
      // reasoning a model left inline leaves as thinking, never as the answer (the chat, slice 9)
      const mode = this.config.inlineReasoning ?? "markers";
      for await (const ev of mode === "off" ? events : splitInline(events, mode)) {
        if (
          (this.health.warming || this.health.firstTokenAt === null) &&
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

  /** The warm-up (§8.5): one short request whose first token ends warming. */
  async warmup(): Promise<void> {
    const entry = this.config.models[0];
    if (!entry || this.config.warmup === false || this.stopped) return;
    try {
      const events = this.stream(
        entry,
        { messages: [{ role: "user", content: "Say ready.", timestamp: Date.now() }] },
        { maxTokens: 8, signal: this.quiet.signal },
      );
      for await (const _ of events) {
        // the first delta flips warming inside stream()
      }
    } catch (e) {
      this.health.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * The warm-up tried again until a first token (§8.5), each wait longer than
   * the one before and the last one repeated: a runtime that did not answer at
   * start, because the network was not up yet at boot or the model was still
   * loading, is warm once it answers. One failed try used to leave the backend
   * warming, and every request to it refused, until Kvasir was started again.
   */
  async keepWarm(waits: number[] = WARM_WAITS, say: (line: string) => void = () => {}): Promise<void> {
    if (this.config.warmup === false || !this.config.models[0]) return;
    for (let tries = 1; this.health.warming && !this.stopped; tries += 1) {
      const wait = waits[Math.min(tries - 1, waits.length - 1)] ?? 60_000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
      if (this.stopped || !this.health.warming) return;
      await this.warmup();
      if (!this.health.warming) say(`${this.config.id}: warm after ${tries + 1} tries`);
    }
  }

  /** Kvasir is closing: a warm-up being tried ends, and none starts. */
  stop(): void {
    this.stopped = true;
    this.quiet.abort();
    this.wake?.();
  }
}

export class Backends {
  /** Served, in the order they were added: the first local one is the default a purpose goes to. */
  readonly list: Backend[] = [];
  /** §8.6: a local model is not in the catalog until it has passed the suite. */
  readonly gate: boolean;
  private readonly queue: number;
  private readonly waitCapMs: number;
  constructor(admission?: { queue: number; waitCapSeconds: number; gate?: boolean }) {
    this.queue = admission?.queue ?? 8;
    this.waitCapMs = (admission?.waitCapSeconds ?? 60) * 1000;
    this.gate = admission?.gate ?? true;
  }

  /** A backend for a configuration, with the queue and the wait cap every backend here has. */
  make(config: BackendConfig): Backend {
    return new Backend(config, this.queue, this.waitCapMs);
  }

  /** A backend served: one an admin added goes before Kvasir's own, so the order an admin added them in stays first. */
  add(backend: Backend): void {
    const own = this.list.findIndex((b) => b.config.builtin);
    if (backend.config.builtin || own < 0) this.list.push(backend);
    else this.list.splice(own, 0, backend);
  }

  /** A backend let go: its warm-up ends, and the streams already running finish. */
  remove(id: string): Backend | undefined {
    const at = this.list.findIndex((b) => b.config.id === id);
    if (at < 0) return undefined;
    const [backend] = this.list.splice(at, 1);
    backend.stop();
    return backend;
  }

  /**
   * A backend served in the place of the one with its id, the order kept: a held backend whose models changed
   * (record 24). The one it replaces stops warming, and the streams already running on it finish.
   */
  swap(backend: Backend): void {
    const at = this.list.findIndex((b) => b.config.id === backend.config.id);
    if (at < 0) {
      this.add(backend);
      return;
    }
    const [replaced] = this.list.splice(at, 1, backend);
    replaced.stop();
  }

  get(id: string): Backend | undefined {
    return this.list.find((b) => b.config.id === id);
  }

  /**
   * Whether a model is listed: a remote one always, a local one once admitted, unless the gate is off.
   * Kvasir's own ChatGPT models never are: a stream reaches them only where the policy sends a purpose
   * to the subscription of the person streaming (record 23).
   */
  listed(backend: Backend, entry: ModelEntry): boolean {
    if (backend.config.builtin) return false;
    return !this.gate || backend.config.locality === "remote" || backend.admitted.has(entry.id);
  }

  /** The backend and entry that serve a model id, or one of its aliases (record 47), or nothing. */
  find(modelId: string): { backend: Backend; entry: ModelEntry } | undefined {
    for (const backend of this.list) {
      const entry = backend.config.models.find((m) => m.id === modelId);
      if (entry) return { backend, entry };
    }
    for (const backend of this.list) {
      const entry = backend.config.models.find((m) => m.aliases?.includes(modelId));
      if (entry) return { backend, entry };
    }
    return undefined;
  }

  /** The catalog of `GET /v1/config`, as pi's model store reads it. */
  catalog(origin: string) {
    return {
      baseUrl: `${origin}/v1`,
      models: this.list.flatMap((b) =>
        b.config.models
          .filter((m) => this.listed(b, m))
          .map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
            input: m.input,
            cost: m.cost,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            backend: b.config.id,
            locality: b.config.locality,
            admitted: b.config.locality === "remote" ? null : b.admitted.has(m.id),
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
