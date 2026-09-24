// SPDX-License-Identifier: AGPL-3.0-only
// A model server as a backend (record 47, R3): a Kvasir serving a card, or any
// OpenAI-compatible server, set up by its address and key. Its models and
// their specs come from its `/v1/models`; the admin ticks which to use, and each
// ticked model is admitted one by one, as a model is today: one short request
// it must answer, then the admission suite where the server is local. One
// backend holds every model ticked on a server, so one key is sealed once
// (R4, under the backend's own id) and one queue stands in front of a card that
// holds one model at a time. A model that is cold on the server loads there when
// it is asked, which takes minutes, so its first request waits longer.

import type { BackendConfig, ModelEntry } from "./config.js";
import { described, HeldRefused, idFrom, RUNTIME_BACKEND, type TryKind, tryBackend } from "./held.js";
import { HUGGING_FACE } from "./local.js";
import { publicSpec, type ServedStatus, specOf } from "./served.js";
import type { AdmissionRecord } from "./suite.js";

/** One model a server offers, with its specs, as the desk shows it before an admin ticks it. */
export interface Offered {
  id: string;
  aliases: string[];
  status: ServedStatus;
  default: boolean;
  context_length: number | null;
  max_output_tokens: number | null;
  max_concurrent_requests: number | null;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  swap_in_seconds: number | null;
  /** Everything else the server said of the model. */
  spec: Record<string, unknown>;
  /** The backend here that holds the model already, or null. */
  held_by: string | null;
}

/** What a server's `/v1/models` says: its models, and its card's state where it serves one. */
export interface Offer {
  url: string;
  models: Offered[];
  server: Record<string, unknown> | null;
  note?: string;
}

/** How one ticked model fared. */
export interface Ticked {
  id: string;
  answered: boolean;
  /** Whether it passed admission; null where the server is remote, or it did not answer. */
  admitted: boolean | null;
  record: number | null;
  error: { kind: TryKind; message: string } | null;
}

/** What admitting a server's models needs of Kvasir. */
export interface ServerHost {
  config: import("./config.js").Config;
  backends: import("./backends.js").Backends;
  credentials: import("./credentials.js").Credentials;
  held: import("./held.js").Held;
  admissions: import("./admission-records.js").Admissions;
  admit: (backendId: string, modelId?: string) => Promise<AdmissionRecord[]>;
  policy: import("./policy.js").Policy;
}

const statusOf = (v: unknown): ServedStatus =>
  v === "loaded" || v === "cold" || v === "loading" ? v : "unknown";

/** The most of a server's `/v1/models` Kvasir reads, and the most models it takes from it. */
export const OFFER_BYTES = 1 << 20;
export const OFFER_MODELS = 256;

/** The prefix a key staged for adding a model server is sealed under, before it is sealed under the backend. */
export const STAGED = "server-staging:";

/** A server's answer read up to `limit` bytes, refused beyond. */
async function bounded(r: Response, limit: number, what: string): Promise<string> {
  const said = Number(r.headers.get("content-length") ?? "");
  if (Number.isFinite(said) && said > limit) {
    await r.body?.cancel();
    throw new HeldRefused(502, `${what} is more than 1 MiB`);
  }
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HeldRefused(502, `${what} is more than 1 MiB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const NAME_MAX = 256;
const nameOf = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= NAME_MAX ? v : null;

/** A server's models as its `/v1/models` lists them, with what it says of each. */
export async function offeredBy(
  baseUrl: string,
  key: string | null,
  timeoutMs = 10_000,
): Promise<Omit<Offer, "url">> {
  let r: Response;
  try {
    r = await fetch(`${baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HeldRefused(502, `${baseUrl}/models did not answer: ${e instanceof Error ? e.message : e}`);
  }
  if (!r.ok) await r.body?.cancel();
  if (!r.ok)
    throw new HeldRefused(
      r.status === 401 || r.status === 403 ? 401 : 502,
      `${baseUrl}/models answered ${r.status}${r.status === 401 || r.status === 403 ? ": the key was refused" : ""}`,
    );
  const text = await bounded(r, OFFER_BYTES, `${baseUrl}/models`);
  let body: { data?: unknown; server?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new HeldRefused(502, `${baseUrl}/models did not answer JSON`);
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.data))
    throw new HeldRefused(502, `${baseUrl}/models lists no data`);
  if (body.data.length > OFFER_MODELS)
    throw new HeldRefused(502, `${baseUrl}/models lists more than ${OFFER_MODELS} models`);
  const models = body.data.flatMap((raw): Offered[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const o = raw as Record<string, unknown>;
    const id = nameOf(o.id);
    if (!id) return [];
    const s = specOf(o);
    return [
      {
        id,
        aliases: Array.isArray(o.aliases)
          ? o.aliases
              .map(nameOf)
              .filter((a): a is string => a !== null && a !== id)
              .slice(0, 32)
          : [],
        status: statusOf(o.status),
        default: o.default === true,
        context_length: s.contextLength,
        max_output_tokens: s.maxOutputTokens,
        max_concurrent_requests: s.concurrency,
        reasoning: s.reasoning,
        tools: s.tools,
        vision: s.vision,
        swap_in_seconds: s.swapInSeconds,
        // only the spec fields Kvasir lists, never whatever else the server wrote
        spec: { ...publicSpec(s.rest), ...(s.concurrency ? { max_concurrent_requests: s.concurrency } : {}) },
        held_by: null,
      },
    ];
  });
  // the card's state as modelgate and Kvasir say it, and nothing else of the block
  const said =
    body.server && typeof body.server === "object" && !Array.isArray(body.server)
      ? (body.server as Record<string, unknown>)
      : null;
  const server = said
    ? Object.fromEntries(
        (
          [
            ["state", nameOf(said.state)],
            ["loaded", nameOf(said.loaded)],
            [
              "last_swap_seconds",
              typeof said.last_swap_seconds === "number" && Number.isFinite(said.last_swap_seconds)
                ? said.last_swap_seconds
                : null,
            ],
            ["note", typeof said.note === "string" ? said.note.slice(0, 500) : null],
          ] as const
        ).filter(([, v]) => v !== null),
      )
    : null;
  return { models, server };
}

/** An offered model as a catalog entry: its limits from the server, or the defaults an admin gets today where it gives none. */
export function entryFrom(o: Offered): ModelEntry {
  const context = o.context_length ?? 32_768;
  return {
    id: o.id,
    name: o.id,
    reasoning: o.reasoning,
    input: o.vision ? ["text", "image"] : ["text"],
    contextWindow: context,
    maxTokens: o.max_output_tokens ?? Math.min(context, 4_096),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(o.aliases.length > 0 ? { aliases: o.aliases } : {}),
    spec: {
      ...o.spec,
      capabilities: {
        ...((o.spec.capabilities as Record<string, unknown> | undefined) ?? {}),
        tools: o.tools,
        reasoning: o.reasoning,
        vision: o.vision,
      },
      ...(o.swap_in_seconds ? { swap_in_seconds: o.swap_in_seconds } : {}),
    },
  };
}

/** The streams a server backend admits at once: the most any of its models runs, as one is loaded at a time; eight where none says. */
function concurrencyOf(models: ModelEntry[]): number {
  const known = models.map((m) => specOf(m.spec ?? {}).concurrency ?? 0).filter((n) => n > 0);
  return known.length > 0 ? Math.min(256, Math.max(...known)) : 8;
}

/** Model servers held as backends: their offers read, their ticked models admitted, their states followed. */
export class Servers {
  /** What each server said of its models when Kvasir last read its list. */
  private readonly states = new Map<string, Map<string, { status: ServedStatus; default: boolean }>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly k: ServerHost) {}

  /** The address as Kvasir dials it, checked, and the note where a container changes it. */
  private address(url: unknown, locality: unknown = "local") {
    const d = described(
      { kind: "openai-completions", baseUrl: url, locality, models: [] },
      { modelsOptional: true, hostAlias: this.k.config.hostAlias },
    );
    return { baseUrl: d.config.baseUrl, locality: d.config.locality, note: d.note };
  }

  /**
   * The key a request names: given once, or a reference to one sealed already (R4); none for a server that
   * asks none. A reference names a key staged for this (`server-staging:<name>`) or the id of this server's
   * own backend (one held for the same address), never another credential, which would go to whatever address
   * the request names.
   */
  private keyOf(input: Record<string, unknown>, baseUrl: string): string | null {
    if (typeof input.key === "string" && input.key.trim()) return input.key.trim();
    const ref = typeof input.key_ref === "string" ? input.key_ref.trim() : "";
    if (!ref) return null;
    const own = this.k.backends.list.find(
      (b) => b.config.server === true && b.config.id === ref && b.config.baseUrl === baseUrl,
    );
    if (ref === HUGGING_FACE || (!ref.startsWith(STAGED) && !own))
      throw new HeldRefused(
        400,
        `key_ref names a key staged for a model server (${STAGED}<name>) or the id of this server's own backend; ${ref} is neither`,
      );
    const key = this.k.credentials.open(ref);
    if (key === null) throw new HeldRefused(404, `no key is sealed as ${ref}`);
    return key;
  }

  /** The models a server offers, with specs, and which of them a backend here holds already. Nothing is kept. */
  async offered(input: Record<string, unknown>): Promise<Offer> {
    const { baseUrl, note } = this.address(input.url ?? input.baseUrl);
    const offer = await offeredBy(baseUrl, this.keyOf(input, baseUrl));
    for (const m of offer.models) m.held_by = this.k.backends.find(m.id)?.backend.config.id ?? null;
    return { url: baseUrl, ...offer, ...(note ? { note } : {}) };
  }

  /** The held backend for a server: the one named, or the one at the same address; none yet otherwise. */
  private heldFor(id: string | null, baseUrl: string): BackendConfig | null {
    const named = id ? this.k.backends.get(id)?.config : undefined;
    if (named) {
      if (!named.server || named.baseUrl !== baseUrl)
        throw new HeldRefused(409, `${id} is held already, and it is not the model server at ${baseUrl}`);
      return named;
    }
    return this.k.backends.list.find((b) => b.config.server && b.config.baseUrl === baseUrl)?.config ?? null;
  }

  /** A name for a new server backend: the one asked for, or one from the server's host. */
  private freshId(asked: string | null, baseUrl: string): string {
    if (asked) return asked;
    const base = idFrom(new URL(baseUrl).hostname);
    let id = base;
    for (let n = 2; this.k.backends.get(id) || id === HUGGING_FACE || id === RUNTIME_BACKEND; n += 1)
      id = `${base.slice(0, 36)}-${n}`;
    return id;
  }

  /**
   * The ticked models of a server admitted one by one: each asked one short question, held on the server's
   * one backend once it answered, and put through the admission suite where the server is local. A cold
   * model loads on the server when asked, so its question waits as long as the server says a load takes.
   */
  async admit(
    input: Record<string, unknown>,
    by: string,
    log: (line: string) => void = () => {},
  ): Promise<{ backend: { id: string; models: string[] } | null; results: Ticked[]; note?: string }> {
    const { baseUrl, locality, note } = this.address(input.url ?? input.baseUrl, input.locality ?? "local");
    const key = this.keyOf(input, baseUrl);
    const asked = Array.isArray(input.models)
      ? input.models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
      : [];
    if (asked.length === 0)
      throw new HeldRefused(400, "models: at least one model the server offers, ticked");
    const offer = await offeredBy(baseUrl, key);
    const ticked = asked.map((name) => {
      const o = offer.models.find((m) => m.id === name || m.aliases.includes(name));
      if (!o) throw new HeldRefused(404, `${baseUrl} offers no model named ${name}`);
      return o;
    });
    const named = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
    let held = this.heldFor(named, baseUrl);
    const id = held?.id ?? this.freshId(named, baseUrl);
    const results: Ticked[] = [];
    for (const o of ticked) {
      if (held?.models.some((m) => m.id === o.id)) {
        results.push({
          id: o.id,
          answered: true,
          admitted: locality === "remote" ? null : (this.k.backends.get(id)?.admitted.has(o.id) ?? false),
          record: null,
          error: null,
        });
        log(`${o.id}: held already`);
        continue;
      }
      const elsewhere = this.k.backends.find(o.id);
      if (elsewhere) {
        results.push({
          id: o.id,
          answered: false,
          admitted: null,
          record: null,
          error: { kind: "other", message: `${o.id} is served by ${elsewhere.backend.config.id} already` },
        });
        continue;
      }
      const entry = entryFrom(o);
      const cold = o.status === "cold" || o.status === "loading";
      const timeoutMs =
        typeof input.timeout_seconds === "number" && input.timeout_seconds > 0
          ? input.timeout_seconds * 1000
          : cold
            ? Math.max(60, (o.swap_in_seconds ?? 300) * 2 + 60) * 1000
            : 60_000;
      if (cold) log(`${o.id} is cold on the server, so asking it loads it there, which takes minutes`);
      const models = [...(held?.models ?? []), entry];
      const config: BackendConfig = {
        id,
        kind: "openai-completions",
        baseUrl,
        locality,
        concurrency: concurrencyOf(models),
        models,
        warmup: false,
        server: true,
      };
      const tried = await tryBackend({ ...config, models: [entry] }, key, { timeoutMs });
      const answer = tried.models[0];
      if (!answer?.answered) {
        results.push({
          id: o.id,
          answered: false,
          admitted: null,
          record: null,
          error: answer?.error ?? null,
        });
        log(`${o.id} did not answer: ${answer?.error?.message ?? "no answer"}`);
        continue;
      }
      // held with the models before it; the key sealed under the backend's own id, once
      this.k.held.replace(config, by, held ? null : key);
      held = this.k.backends.get(id)?.config ?? config;
      const backend = this.k.backends.get(id);
      if (backend) await this.k.admissions.loadOne(backend);
      let admitted: boolean | null = null;
      let record: number | null = null;
      if (locality === "local") {
        log(`${o.id}: admission`);
        try {
          const [rec] = await this.k.admit(id, o.id);
          admitted = rec?.passed ?? false;
          record = rec?.id ?? null;
        } catch (e) {
          admitted = false;
          log(`${o.id}: admission did not run: ${e instanceof Error ? e.message : e}`);
        }
      }
      results.push({ id: o.id, answered: true, admitted, record, error: null });
      log(`${o.id}: ${admitted === null ? "held" : admitted ? "admitted" : "refused by admission"}`);
    }
    // a key staged under a name of its own for this add is sealed under the backend now, so the stage goes
    const ref = typeof input.key_ref === "string" ? input.key_ref.trim() : "";
    if (held && ref.startsWith(STAGED)) this.k.credentials.delete(ref);
    const states = new Map(offer.models.map((m) => [m.id, { status: m.status, default: m.default }]));
    if (held) this.states.set(id, states);
    return {
      backend: held ? { id, models: held.models.map((m) => m.id) } : null,
      results,
      ...(note ? { note } : {}),
    };
  }

  /** What a server said of one of its models when its list was last read. */
  remote(backendId: string, modelId: string): { status: ServedStatus; default: boolean } | null {
    return this.states.get(backendId)?.get(modelId) ?? null;
  }

  /** Every server backend's list read again: which model is loaded and which is cold. */
  async refresh(): Promise<void> {
    for (const b of this.k.backends.list.filter((x) => x.config.server)) {
      try {
        const offer = await offeredBy(
          b.config.baseUrl,
          this.k.credentials.open(b.config.provider ?? b.config.id),
        );
        this.states.set(
          b.config.id,
          new Map(offer.models.map((m) => [m.id, { status: m.status, default: m.default }])),
        );
      } catch {
        this.states.set(
          b.config.id,
          new Map(b.config.models.map((m) => [m.id, { status: "unknown" as const, default: false }])),
        );
      }
    }
  }

  /** Follow the servers' states every `ms` while serving. */
  watch(ms = 30_000): void {
    this.timer ??= setInterval(() => void this.refresh(), ms);
    this.timer.unref();
    void this.refresh();
  }

  unwatch(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
