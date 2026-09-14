// SPDX-License-Identifier: AGPL-3.0-only
// The configuration: the door, identity, the one database and the files of
// its secrets, admission, and the purposes apps registered (Wave 4c §8.5).
// The models are not in it: Kvasir holds them in its database, where an admin
// adds each one once it answered (src/held.ts).

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export type BackendKind = "openai-completions" | "anthropic-messages" | "openai-codex-responses";

/**
 * The adapters an admin adds a backend with (§8.1): a fixed list in code, never a URL a caller
 * names. ChatGPT through a person's own subscription is Kvasir's own backend, never added.
 */
export const BACKEND_KINDS: BackendKind[] = ["openai-completions", "anthropic-messages"];

export interface ModelEntry {
  id: string;
  /** The name the provider knows the model by, when it differs from the catalog id (two shapes of one provider). */
  upstream?: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface BackendConfig {
  id: string;
  kind: BackendKind;
  baseUrl: string;
  locality: "local" | "remote";
  /** Streams admitted at once (§8.7); the queue behind them and its wait cap are the configuration's. */
  concurrency: number;
  models: ModelEntry[];
  /** A warm-up prompt sent at start and tried again until it answers; the backend is warming until its first token (§8.5). */
  warmup?: boolean;
  /** The credential the backend's key is sealed under (§8.4): the backend's own id, when it was added with a key. */
  provider?: string;
  /** The highest content class this backend may carry; every class when absent. */
  classes?: import("./keys.js").ContentClass;
  /** Defaults a stream takes when the caller sets none: a small local model wants a low temperature for tool use (Wave 4c, the local-model rule). */
  defaults?: { temperature?: number };
  /** The runtime as the operator records it, when the runtime does not say (§8.6). */
  runtime?: { name: string; version: string; build: string };
  /**
   * pi-ai's compatibility flags for this backend's API, set by the admin who
   * knows the runtime; a local OpenAI-shaped runtime (SGLang, vLLM) gets
   * `system` rather than `developer`, no `store`, and `max_tokens` unless told
   * otherwise. A client never sends any.
   */
  compat?: Record<string, unknown>;
  /**
   * How this backend's text is read for reasoning a model left inline (the chat,
   * slice 9): "markers", the default, reads it from markers that open the output;
   * "open" from the start of the output to a closing marker, for a chat template
   * that opens thinking in the prompt; "off" not at all.
   */
  inlineReasoning?: import("./reasoning.js").InlineReasoning;
  /** Kvasir's own backend, never added, stored or removed: ChatGPT through each person's own subscription (record 23). */
  builtin?: boolean;
}

export interface Config {
  bind: string;
  origin: string;
  auth: import("./auth.js").AuthConfig;
  /** The one database. */
  store: string;
  /** The pepper of the minted keys' hashes: a file of at least sixteen bytes, made at first start. */
  pepperFile: string;
  /** Per backend (§8.7): the queue behind the admitted streams and the wait cap; and the gate of §8.6, a local model listed only once admitted. */
  admission: { queue: number; waitCapSeconds: number; gate: boolean };
  /** The seal key of the stored credentials (§8.4): a file outside the database, made at first start. */
  sealKeyFile: string;
  /** The purposes apps registered (§8.3). */
  purposes: import("./policy.js").Purpose[];
}

export function parse(text: string): Config {
  const raw = JSON.parse(text) as Partial<Config> & { backends?: unknown; oauth?: unknown };
  if (!raw.bind || !raw.origin) throw new Error("kvasir.json: bind and origin");
  if (raw.backends !== undefined)
    throw new Error(
      "kvasir.json: the models are held in Kvasir's database, not in this file; add each with `kvasir models add` or from the desk",
    );
  if (raw.oauth !== undefined)
    throw new Error("kvasir.json: oauth is not a setting; a person signs in to their own subscription");
  return {
    bind: raw.bind,
    origin: raw.origin.replace(/\/+$/u, ""),
    auth: raw.auth ?? { mode: "off" },
    store: raw.store ?? "kvasir.sqlite",
    pepperFile: raw.pepperFile ?? "kvasir.pepper",
    admission: {
      queue: raw.admission?.queue ?? 8,
      waitCapSeconds: raw.admission?.waitCapSeconds ?? 60,
      gate: raw.admission?.gate ?? true,
    },
    sealKeyFile: raw.sealKeyFile ?? "kvasir.seal",
    purposes: purposes(raw.purposes ?? []),
  };
}

export function read(path: string): Config {
  return parse(readFileSync(path, "utf8"));
}

/** The pepper from its file, or a new one written there with mode 600. */
export function pepper(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const bytes = randomBytes(32);
    writeFileSync(path, bytes, { mode: 0o600 });
    return new Uint8Array(bytes);
  }
}

function purposes(list: unknown[]): import("./policy.js").Purpose[] {
  const out: import("./policy.js").Purpose[] = [];
  for (const raw of list) {
    const p = raw as Partial<import("./policy.js").Purpose>;
    if (!p.id || !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u.test(p.id))
      throw new Error(`kvasir.json: purposes: ${p.id} is not app.purpose`);
    if (!p.app) throw new Error(`kvasir.json: purpose ${p.id}: app`);
    if (!["catalog", "rows", "identifiers"].includes(p.content ?? ""))
      throw new Error(`kvasir.json: purpose ${p.id}: content is catalog, rows or identifiers`);
    if (!["foreground", "background"].includes(p.kind ?? ""))
      throw new Error(`kvasir.json: purpose ${p.id}: kind is foreground or background`);
    if (out.some((x) => x.id === p.id)) throw new Error(`kvasir.json: purpose ${p.id} is listed twice`);
    out.push({
      id: p.id,
      app: p.app,
      content: p.content as never,
      kind: p.kind as never,
      description: p.description,
    });
  }
  return out;
}
