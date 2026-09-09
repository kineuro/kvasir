// SPDX-License-Identifier: AGPL-3.0-only
// The configuration: the door, the backends and their models (Wave 4c §8.5).

import { readFileSync } from "node:fs";

export type BackendKind = "openai-completions" | "anthropic-messages";

export interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface BackendConfig {
  id: string;
  /** A fixed list in code (§8.1): the adapters Kvasir has, never a URL a caller names. */
  kind: BackendKind;
  baseUrl: string;
  /** The runtime key: the one key the runtime knows, held here and never shown. */
  keyFile?: string;
  key?: string;
  locality: "local" | "remote";
  /** Streams admitted at once (§8.7); the queue and the wait cap arrive with C2. */
  concurrency: number;
  models: ModelEntry[];
  /** A warm-up prompt sent at start; the backend is warming until its first token (§8.5). */
  warmup?: boolean;
}

export interface Config {
  bind: string;
  origin: string;
  auth: { mode: "off" | "token"; tokens?: Record<string, string> };
  backends: BackendConfig[];
}

export function parse(text: string): Config {
  const raw = JSON.parse(text) as Partial<Config>;
  if (!raw.bind || !raw.origin) throw new Error("kvasir.json: bind and origin");
  if (!Array.isArray(raw.backends) || raw.backends.length === 0)
    throw new Error("kvasir.json: at least one backend");
  const kinds: BackendKind[] = ["openai-completions", "anthropic-messages"];
  const ids = new Set<string>();
  for (const b of raw.backends) {
    if (!kinds.includes(b.kind))
      throw new Error(`kvasir.json: backend ${b.id}: kind is one of ${kinds.join(", ")}`);
    if (!b.baseUrl?.startsWith("http")) throw new Error(`kvasir.json: backend ${b.id}: baseUrl`);
    if (b.locality !== "local" && b.locality !== "remote")
      throw new Error(`kvasir.json: backend ${b.id}: locality is local or remote`);
    b.concurrency = b.concurrency ?? 8;
    b.warmup = b.warmup ?? true;
    for (const m of b.models ?? []) {
      if (ids.has(m.id)) throw new Error(`kvasir.json: model ${m.id} is listed twice`);
      ids.add(m.id);
      if (typeof m.contextWindow !== "number" || typeof m.maxTokens !== "number") {
        throw new Error(`kvasir.json: model ${m.id}: contextWindow and maxTokens are measured numbers`);
      }
    }
  }
  return {
    bind: raw.bind,
    origin: raw.origin.replace(/\/+$/u, ""),
    auth: raw.auth ?? { mode: "off" },
    backends: raw.backends as BackendConfig[],
  };
}

export function read(path: string): Config {
  return parse(readFileSync(path, "utf8"));
}

/** The runtime key of a backend: the file, else the inline value, else none. */
export function keyOf(b: BackendConfig): string | undefined {
  if (b.keyFile) return readFileSync(b.keyFile, "utf8").trim();
  return b.key;
}
