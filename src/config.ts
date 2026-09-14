// SPDX-License-Identifier: AGPL-3.0-only
// The configuration: the door, identity, the one database and the files of
// its secrets, admission, and the purposes apps registered (Wave 4c §8.5).
// The models are not in it: Kvasir holds them in its database, where an admin
// adds each one once it answered (src/held.ts).

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { HUB } from "./local.js";

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

/**
 * The runtime Kvasir loads the models it downloaded on (record 24): llama.cpp's
 * server in router mode, which the deployment installs and keeps running.
 */
export interface RuntimeConfig {
  /** The runtime's address as Kvasir dials it. */
  url: string;
  /** The file of the key the runtime and Kvasir read, and nothing else. */
  keyFile: string;
  /** The presets file the runtime reads, which Kvasir writes. */
  presets: string;
  /** The runtime's log, where a model that did not load says why. */
  log: string;
  /** The llama.cpp build, such as b10964. */
  build: string;
  /** The archive of that build the install took, such as ubuntu-vulkan-x64. */
  variant: string;
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
  /**
   * Local models (record 23): the Hugging Face Hub they download from, or a mirror of it; the location is a
   * setting in the database. And the runtime a download is started on, where the install has one (record 24).
   */
  local: { endpoint: string; runtime: RuntimeConfig | null };
  /** Where Kvasir runs in a container (record 24): the name it reaches the machine's own loopback by. */
  hostAlias: string | null;
}

export function parse(text: string): Config {
  const raw = JSON.parse(text) as Omit<Partial<Config>, "local" | "hostAlias"> & {
    backends?: unknown;
    oauth?: unknown;
    local?: { endpoint?: unknown; runtime?: unknown };
    hostAlias?: unknown;
  };
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
    local: { endpoint: endpointOf(raw.local?.endpoint), runtime: runtimeOf(raw.local?.runtime) },
    hostAlias: hostAliasOf(raw.hostAlias),
  };
}

/** The hub local models download from: huggingface.co, or the mirror kvasir.json names. */
function endpointOf(value: unknown): string {
  if (value === undefined) return HUB;
  if (typeof value !== "string" || !/^https?:\/\/[^\s/]+/u.test(value))
    throw new Error(
      "kvasir.json: local.endpoint is the address of a Hugging Face Hub, starting with http:// or https://",
    );
  return value.replace(/\/+$/u, "");
}

/** The runtime kvasir.json names, or none: without one, Kvasir starts no model (record 24). */
function runtimeOf(value: unknown): RuntimeConfig | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "kvasir.json: local.runtime is the runtime Kvasir starts downloaded models on: url, keyFile, presets, log, build and variant",
    );
  const r = value as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url.trim().replace(/\/+$/u, "") : "";
  if (!/^https?:\/\/[^\s/]+$/u.test(url))
    throw new Error(
      "kvasir.json: local.runtime.url is the runtime's address as Kvasir dials it, such as http://127.0.0.1:7110",
    );
  const path = (key: "keyFile" | "presets" | "log"): string => {
    const p = r[key];
    if (typeof p !== "string" || !isAbsolute(p))
      throw new Error(`kvasir.json: local.runtime.${key} is an absolute path`);
    return p;
  };
  const word = (key: "build" | "variant"): string => {
    const w = r[key];
    if (w === undefined) return "";
    if (typeof w !== "string") throw new Error(`kvasir.json: local.runtime.${key} is a string`);
    return w;
  };
  return {
    url,
    keyFile: path("keyFile"),
    presets: path("presets"),
    log: path("log"),
    build: word("build"),
    variant: word("variant"),
  };
}

/** The name a Kvasir in a container reaches the machine's own loopback by, or none where it runs on the machine. */
function hostAliasOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/u.test(value)
  )
    throw new Error(
      "kvasir.json: hostAlias is the name a Kvasir in a container reaches the machine's own loopback by, such as host.containers.internal",
    );
  return value;
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
