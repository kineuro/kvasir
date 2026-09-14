// SPDX-License-Identifier: AGPL-3.0-only
// The models Kvasir holds (record 23): each backend an admin added, kept in
// the one database in the order it was added, its key sealed with the other
// credentials, and none taken before every one of its models answered one
// short request. A Kvasir started on the database serves them, and one that
// is running while the command line adds, changes or removes a backend
// follows within seconds. The backend `llama-cpp` is Kvasir's own: the models
// it started on the runtime the install runs (record 24, src/runtime.ts).

import { type Backend, Backends } from "./backends.js";
import { BACKEND_KINDS, type BackendConfig, type BackendKind, type ModelEntry } from "./config.js";
import type { Credentials } from "./credentials.js";
import { CLASSES } from "./keys.js";
import { HUGGING_FACE } from "./local.js";
import type { Store } from "./store.js";

export const HELD_SCHEMA = `CREATE TABLE IF NOT EXISTS backend (
     id TEXT PRIMARY KEY,
     position INTEGER NOT NULL,
     config TEXT NOT NULL,
     added_by TEXT NOT NULL,
     added_at INTEGER NOT NULL
   )`;

/** The backend Kvasir holds the models it started on the runtime under (record 24); an added backend takes another name. */
export const RUNTIME_BACKEND = "llama-cpp";

/** Why a backend was not taken, with the status a door answers and what each model said. */
export class HeldRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly models: Tried["models"] = [],
  ) {
    super(message);
  }
}

/** How a model did not answer, in the few ways a person can act on. */
export type TryKind = "unreachable" | "key_refused" | "no_model" | "refused_for_now" | "other";

/** What one short request to each model found, and the models the server lists where it lists them. */
export interface Tried {
  listed: string[] | null;
  models: { id: string; answered: boolean; error: { kind: TryKind; message: string } | null }[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;

/** A backend's key is sealed under the backend's own id, so no backend takes the id the Hugging Face token is sealed under. */
function reserved(): HeldRefused {
  return new HeldRefused(
    409,
    `${HUGGING_FACE} is the name Kvasir seals the Hugging Face token under; a backend takes another name`,
  );
}

/** A name for a backend from its first model: lowercase, a dash for anything else. */
export function idFrom(model: string): string {
  return (
    model
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40)
      .replace(/-+$/u, "") || "model"
  );
}

/**
 * A loopback address as a Kvasir in a container dials it (record 24): by the
 * name that container reaches the machine's own loopback by, the way setup
 * writes a model server's address for it. Any other address is left as it is.
 */
export function throughHost(address: string, hostAlias: string | null): string {
  if (!hostAlias) return address;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return address;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return address;
  url.hostname = hostAlias;
  return url.toString().replace(/\/+$/u, "");
}

/**
 * An admin's description of a backend made whole: every field checked, defaults filled, the key apart.
 * A description for listing a server's models, before any is chosen, may name none. Where Kvasir runs in a
 * container, a server on the machine's loopback is dialled by the name the machine has there, and the note says so.
 */
export function described(
  input: unknown,
  opts: { modelsOptional?: boolean; hostAlias?: string | null } = {},
): { config: BackendConfig; key: string | null; named: boolean; note: string | null } {
  const o = (input ?? {}) as Record<string, unknown>;
  const bad = (message: string) => new HeldRefused(400, message);
  const kind = String(o.kind ?? "openai-completions") as BackendKind;
  if (!BACKEND_KINDS.includes(kind)) throw bad(`kind is one of ${BACKEND_KINDS.join(", ")}`);
  const given = String(o.baseUrl ?? o.base_url ?? "")
    .trim()
    .replace(/\/+$/u, "");
  if (!/^https?:\/\/\S+$/u.test(given))
    throw bad("baseUrl: the server's address, starting with http:// or https://");
  const baseUrl = throughHost(given, opts.hostAlias ?? null);
  const note =
    baseUrl === given
      ? null
      : `Kvasir runs in a container, where ${given} is the container's own address, so it reaches the server as ${baseUrl}`;
  const locality = o.locality;
  if (locality !== "local" && locality !== "remote")
    throw bad("locality: local, for a server in your own systems, or remote, for a provider");
  if ((!Array.isArray(o.models) || o.models.length === 0) && !opts.modelsOptional)
    throw bad("models: at least one model the server serves");
  const models: ModelEntry[] = [];
  for (const raw of Array.isArray(o.models) ? o.models : []) {
    const m = (typeof raw === "string" ? { id: raw } : (raw ?? {})) as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!id) throw bad("models: each model has the id the server knows it by");
    if (models.some((x) => x.id === id)) throw bad(`models: ${id} is named twice`);
    const whole = (v: unknown, fallback: number, what: string) => {
      if (v === undefined || v === null || v === "") return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw bad(`${id}: ${what} is a whole number of tokens`);
      return n;
    };
    const input = Array.isArray(m.input) ? m.input.filter((x) => x === "text" || x === "image") : ["text"];
    models.push({
      id,
      ...(typeof m.upstream === "string" && m.upstream.trim() ? { upstream: m.upstream.trim() } : {}),
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : id,
      reasoning: m.reasoning === true,
      input: (input.length > 0 ? input : ["text"]) as ModelEntry["input"],
      contextWindow: whole(m.contextWindow ?? m.context_window, 32_768, "contextWindow"),
      maxTokens: whole(m.maxTokens ?? m.max_tokens, 4_096, "maxTokens"),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  const named = typeof o.id === "string" && o.id.trim() !== "";
  const id = named ? String(o.id).trim() : models.length > 0 ? idFrom(models[0].id) : "listing";
  if (!ID.test(id)) throw bad("id: lowercase letters, digits and dashes, at most forty");
  const concurrency = o.concurrency === undefined ? 8 : Number(o.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256)
    throw bad("concurrency: the streams admitted at once, from 1 to 256");
  const config: BackendConfig = { id, kind, baseUrl, locality, concurrency, models };
  if (locality === "local") config.warmup = o.warmup !== false;
  if (o.inlineReasoning !== undefined) {
    if (!["off", "markers", "open"].includes(String(o.inlineReasoning)))
      throw bad("inlineReasoning: off, markers or open");
    config.inlineReasoning = o.inlineReasoning as BackendConfig["inlineReasoning"];
  }
  if (o.compat !== undefined) {
    if (typeof o.compat !== "object" || o.compat === null || Array.isArray(o.compat))
      throw bad("compat: pi-ai's compatibility flags, an object");
    config.compat = o.compat as Record<string, unknown>;
  }
  const temperature = (o.defaults as { temperature?: unknown } | undefined)?.temperature;
  if (temperature !== undefined) {
    const t = Number(temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw bad("defaults.temperature: from 0 to 2");
    config.defaults = { temperature: t };
  }
  if (o.classes !== undefined) {
    if (!CLASSES.includes(o.classes as never)) throw bad(`classes: one of ${CLASSES.join(", ")}`);
    config.classes = o.classes as BackendConfig["classes"];
  }
  const key = typeof o.key === "string" && o.key.trim() ? o.key.trim() : null;
  return { config, key, named, note };
}

/** How a failed request's words read: a key refused, no such model, nothing answering, or refused for now. */
export function kindOf(message: string): TryKind {
  if (
    /\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,24}key|incorrect api key|authentication/iu.test(message)
  )
    return "key_refused";
  if (/\b429\b|rate.?limit|quota|insufficient.{0,24}(balance|credit|funds)/iu.test(message))
    return "refused_for_now";
  if (
    /\b404\b|model.{0,48}(not (be )?found|does not exist|not exist|unknown|not available)|no such model|not a valid model/iu.test(
      message,
    )
  )
    return "no_model";
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|fetch failed|connection error|timed? ?out|no answer within|socket hang up/iu.test(
      message,
    )
  )
    return "unreachable";
  return "other";
}

/** The models an OpenAI-shaped server lists, where it lists them. */
async function listedBy(config: BackendConfig, key: string | null): Promise<string[] | null> {
  if (config.kind !== "openai-completions") return null;
  try {
    const r = await fetch(`${config.baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { data?: { id?: unknown }[] };
    return Array.isArray(body.data)
      ? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
      : null;
  } catch {
    return null;
  }
}

/**
 * One short request to a model through the adapter Kvasir will stream it with:
 * the first word, thought or finished answer is an answer.
 */
async function answers(
  config: BackendConfig,
  key: string | null,
  entry: ModelEntry,
  timeoutMs: number,
): Promise<{ answered: boolean; error: { kind: TryKind; message: string } | null }> {
  const probe = new Backends().make({ ...config, warmup: false, concurrency: 1 });
  probe.credential = () => key;
  const signal = AbortSignal.timeout(timeoutMs);
  let failure: string | null = null;
  try {
    for await (const ev of probe.stream(
      entry,
      { messages: [{ role: "user", content: "Say ready.", timestamp: Date.now() }] },
      { maxTokens: 16, signal },
    )) {
      if (
        ev.type === "text_delta" ||
        ev.type === "thinking_delta" ||
        ev.type === "toolcall_delta" ||
        ev.type === "done"
      )
        return { answered: true, error: null };
      if (ev.type === "error") failure = ev.error.errorMessage ?? "the server answered with an error";
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  if (signal.aborted) failure = `no answer within ${Math.round(timeoutMs / 1000)} seconds`;
  const message = (failure ?? "the server ended its answer without a word").slice(0, 300);
  return { answered: false, error: { kind: kindOf(message), message } };
}

/** Every model of a backend asked one short question, and what the server lists. Nothing is kept. */
export async function tryBackend(
  config: BackendConfig,
  key: string | null,
  opts: { timeoutMs?: number } = {},
): Promise<Tried> {
  const listed = await listedBy(config, key);
  const models: Tried["models"] = [];
  for (const entry of config.models) {
    models.push({ id: entry.id, ...(await answers(config, key, entry, opts.timeoutMs ?? 60_000)) });
  }
  return { listed, models };
}

export class Held {
  private version = -1;
  /** A backend just held, or held again with other models, for a serving Kvasir to warm and admit; nothing where no server runs. */
  onAdded: (backend: Backend) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly backends: Backends,
    private readonly credentials: Credentials,
    /** What else names a backend let go: the policy rows that mapped a purpose to it. */
    private readonly forget: (backendId: string) => void = () => {},
    /** Where Kvasir runs in a container: the name it reaches the machine's own loopback by (record 24). */
    private readonly hostAlias: string | null = null,
  ) {
    store.db.exec(HELD_SCHEMA);
  }

  /** The rows as they are stored, in the order they were added. */
  rows(): { config: BackendConfig; addedBy: string; addedAt: number }[] {
    return (
      this.store.db
        .prepare("SELECT config, added_by, added_at FROM backend ORDER BY position, added_at")
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      config: JSON.parse(String(r.config)) as BackendConfig,
      addedBy: String(r.added_by),
      addedAt: Number(r.added_at),
    }));
  }

  /** Who added a backend, and when. */
  addedOf(id: string): { added_by: string; added_at: number } | null {
    const r = this.store.db.prepare("SELECT added_by, added_at FROM backend WHERE id = ?").get(id) as
      | { added_by: string; added_at: number }
      | undefined;
    return r ? { added_by: r.added_by, added_at: r.added_at } : null;
  }

  private dataVersion(): number {
    return Number(
      (this.store.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
    );
  }

  /** A stored backend made ready to serve: its key from the credentials at use, never kept. */
  private made(config: BackendConfig): Backend {
    const backend = this.backends.make(config);
    const provider = config.provider ?? config.id;
    backend.credential = () => this.credentials.open(provider);
    return backend;
  }

  /** A stored backend served. */
  private serve(config: BackendConfig): Backend {
    const backend = this.made(config);
    this.backends.add(backend);
    return backend;
  }

  /**
   * The database and the served list made the same: a backend another process
   * added is served and handed to `onAdded`, one whose models it changed is
   * served again in its place and handed on too, and one it removed is let go.
   * Cheap when nothing changed, which SQLite's data version says.
   */
  sync(): { added: Backend[]; changed: Backend[]; removed: string[] } {
    const version = this.dataVersion();
    if (version === this.version) return { added: [], changed: [], removed: [] };
    this.version = version;
    const rows = this.rows();
    const added = rows.filter((r) => !this.backends.get(r.config.id)).map((r) => this.serve(r.config));
    const changed = rows
      .filter((r) => {
        const served = this.backends.get(r.config.id);
        return (
          served !== undefined &&
          !added.includes(served) &&
          JSON.stringify(served.config) !== JSON.stringify(r.config)
        );
      })
      .map((r) => {
        const backend = this.made(r.config);
        this.backends.swap(backend);
        return backend;
      });
    const kept = new Set(rows.map((r) => r.config.id));
    // Kvasir's own backends are never stored, so never let go for being absent from the rows
    const removed = this.backends.list
      .filter((b) => !b.config.builtin)
      .map((b) => b.config.id)
      .filter((id) => !kept.has(id));
    for (const id of removed) this.backends.remove(id);
    for (const b of [...added, ...changed]) this.onAdded(b);
    return { added, changed, removed };
  }

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Follow the database every `ms` while serving. */
  watch(ms = 2_000): void {
    this.timer ??= setInterval(() => {
      try {
        this.sync();
      } catch (e) {
        console.error("kvasir: the held models could not be read:", e instanceof Error ? e.message : e);
      }
    }, ms);
    this.timer.unref();
  }

  unwatch(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A backend stored and served as described, its models not asked: what `add` does once they answered. */
  put(config: BackendConfig, by: string, key: string | null = null): Backend {
    this.sync();
    if (config.id === HUGGING_FACE) throw reserved();
    if (this.backends.get(config.id))
      throw new HeldRefused(409, `a backend named ${config.id} is held already`);
    for (const m of config.models) {
      const served = this.backends.find(m.id);
      if (served) throw new HeldRefused(409, `${m.id} is served by ${served.backend.config.id} already`);
    }
    // a backend's key, given now or stored later from the desk, is sealed under the backend's own id
    const stored: BackendConfig = { ...config, provider: config.id };
    const position =
      Number(
        (this.store.db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM backend").get() as { p: number })
          .p,
      ) + 1;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare("INSERT INTO backend (id, position, config, added_by, added_at) VALUES (?, ?, ?, ?, ?)")
        .run(stored.id, position, JSON.stringify(stored), by, Date.now());
      if (key) this.credentials.put(stored.id, key);
      else this.credentials.delete(stored.id);
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return this.serve(stored);
  }

  /**
   * A held backend's models changed in place (record 24), as the runtime's
   * backend changes when a model starts or stops: stored, served again in its
   * place with its order kept, and handed to `onAdded`, which warms and admits
   * a serving Kvasir's; held anew where there is none. A model another backend
   * serves is refused, as `put` refuses it.
   */
  replace(config: BackendConfig, by: string, key: string | null = null): Backend {
    this.sync();
    if (config.id === HUGGING_FACE) throw reserved();
    if (!this.backends.get(config.id)) {
      const backend = this.put(config, by, key);
      this.onAdded(backend);
      return backend;
    }
    for (const m of config.models) {
      const served = this.backends.find(m.id);
      if (served && served.backend.config.id !== config.id)
        throw new HeldRefused(409, `${m.id} is served by ${served.backend.config.id} already`);
    }
    const stored: BackendConfig = { ...config, provider: config.id };
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare("UPDATE backend SET config = ? WHERE id = ?")
        .run(JSON.stringify(stored), stored.id);
      if (key) this.credentials.put(stored.id, key);
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    const backend = this.made(stored);
    this.backends.swap(backend);
    this.onAdded(backend);
    return backend;
  }

  /** A backend an admin described, held only once every one of its models answered. */
  async add(
    input: unknown,
    by: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ backend: Backend; tried: Tried; note: string | null }> {
    const { config, key, named, note } = described(input, { hostAlias: this.hostAlias });
    this.sync();
    if (!named) {
      const base = config.id;
      // a name nobody chose never lands on the one the Hugging Face token is sealed under, or on the runtime's
      for (
        let n = 2;
        this.backends.get(config.id) || config.id === HUGGING_FACE || config.id === RUNTIME_BACKEND;
        n += 1
      )
        config.id = `${base.slice(0, 36)}-${n}`;
    }
    if (config.id === HUGGING_FACE) throw reserved();
    if (config.id === RUNTIME_BACKEND)
      throw new HeldRefused(
        409,
        `${RUNTIME_BACKEND} is the backend Kvasir holds the models it starts under; an added backend takes another name`,
      );
    if (this.backends.get(config.id))
      throw new HeldRefused(409, `a backend named ${config.id} is held already`);
    for (const m of config.models) {
      const served = this.backends.find(m.id);
      if (served) throw new HeldRefused(409, `${m.id} is served by ${served.backend.config.id} already`);
    }
    const tried = await tryBackend(config, key, opts);
    const silent = tried.models.filter((m) => !m.answered);
    if (silent.length > 0) {
      throw new HeldRefused(
        422,
        silent.map((m) => `${m.id} did not answer: ${m.error?.message ?? "no answer"}`).join("; "),
        tried.models,
      );
    }
    const backend = this.put(config, by, key);
    this.onAdded(backend);
    return { backend, tried, note };
  }

  /** A backend let go: its row, its key and the policy rows naming it go; its streams already running finish. */
  remove(id: string): boolean {
    if (this.backends.get(id)?.config.builtin) return false;
    const had = this.store.db.prepare("DELETE FROM backend WHERE id = ?").run(id).changes > 0;
    const served = this.backends.remove(id);
    if (!had && !served) return false;
    this.credentials.delete(id);
    this.forget(id);
    return true;
  }
}
