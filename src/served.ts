// SPDX-License-Identifier: AGPL-3.0-only
// The models Kvasir serves, as a client lists them and a door reaches them
// (record 47). Each has its specs (context, longest answer, concurrency,
// reasoning, tools, vision, and whatever else its operator or its server said)
// and whether it is loaded now. The backends fill it: a card's models
// (src/card.ts) are backends of their own whose admission waits for the swap,
// a model server held as a backend (src/servers.ts) says which of its models
// is loaded, and a backend an admin added is up, so its models are loaded.
//
// The doors read it through `ServedCatalog`: `modelList` gives `GET
// /v1/models` in modelgate's shape, so a client that read modelgate's list
// reads Kvasir's unchanged, and `lease` gives a pass-through door a slot on
// the model's backend, through `admission.acquire`, which on a card waits for
// the model to be loaded first. The doors own every rule of a request (the
// key's scopes and swap flag, the thinking default, the context guard, the
// ledger); the catalog owns the list, the specs, the states and the wait.
//
// A model's card in the sense of `contracts/model/v1` is not listed here: a
// served SGLang model carries no digest of its weights for the card to name.

import { RefusedAdmission } from "./admission.js";
import type { Backend, Backends } from "./backends.js";
import type { ModelEntry } from "./config.js";

/** The doors a request passes through as the client sent it. */
export type Protocol = "chat-completions" | "completions" | "messages" | "responses";
export const PROTOCOLS: Protocol[] = ["chat-completions", "completions", "messages", "responses"];

/** Each pass-through door's path, and the protocol a backend must speak for it. */
export const DOORS: Record<string, Protocol> = {
  "/v1/chat/completions": "chat-completions",
  "/v1/completions": "completions",
  "/v1/messages": "messages",
  "/v1/messages/count_tokens": "messages",
  "/v1/responses": "responses",
};

/** How a protocol is written in a model's `apis` on `/v1/models`, as modelgate wrote it. */
const API_NAMES: Record<Protocol, string> = {
  "chat-completions": "openai /v1/chat/completions",
  completions: "openai /v1/completions",
  messages: "anthropic /v1/messages",
  responses: "openai /v1/responses",
};

/** Whether a model answers now: loaded; being loaded; cold, so asking it loads it; or not known, as for a provider. */
export type ServedStatus = "loaded" | "loading" | "cold" | "unknown";

/** A model's specs, read from a card member's `spec` or from one entry of a server's `/v1/models`. */
export interface ServedSpec {
  /** The most tokens of prompt and answer together. */
  contextLength: number | null;
  /** The longest answer. */
  maxOutputTokens: number | null;
  /** Requests the model's server runs at once. */
  concurrency: number | null;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  /** How long the server takes to load it, where it says. */
  swapInSeconds: number | null;
  /** Everything else the operator or the server said (architecture, quantization, licence, runtime, measured speeds), kept as it was given. */
  rest: Record<string, unknown>;
}

/** One model as a client lists it and a door reaches it. */
export interface ServedModel {
  /** The name a client asks for. */
  id: string;
  /** Other names that reach the same model. */
  aliases: string[];
  /** The name the backend serves it by; a pass-through request's `model` is rewritten to it. */
  upstream: string;
  /** The backend that serves it. */
  backend: string;
  /** The card it shares a device with, or null. */
  card: string | null;
  /** The model its card or server loads when nothing else is asked for. */
  default: boolean;
  status: ServedStatus;
  contextLength: number;
  maxOutputTokens: number;
  concurrency: number;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  /** The doors whose requests the backend answers natively. */
  protocols: Protocol[];
  /** An Anthropic request without `thinking`: sent on as disabled, or left to the model. */
  anthropicThinking: "disabled" | "as-sent";
  /** Whether it runs in the group's own systems: only such a model is reached through a pass-through door (D44). */
  local: boolean;
  /** Everything else, spread into the model's object as modelgate spreads its spec. */
  spec: Record<string, unknown>;
}

/** A card as `GET /v1/models` names it beside the list, in modelgate's `server` block. */
export interface ServedServer {
  state: string;
  loaded: string | null;
  last_swap_seconds: number | null;
  note: string;
}

/** A slot on a backend for one request: where to send it, with what key, and the slot given back after. */
export interface Lease {
  /** What the door's own path (`/v1/...`) is appended to. */
  base: string;
  /** The backend's key, as that backend wants it, or none. */
  auth: { header: "authorization" | "x-api-key"; value: string } | null;
  /** The backend's id, for the ledger. */
  backend: string;
  /** The backend answered: a local backend's first answer ends its warming. */
  answered?: () => void;
  release: () => void;
}

export interface LeaseOptions {
  signal: AbortSignal;
  /** Called every second while the request waits for a slot or a swap. */
  heartbeat: () => void;
}

/** A request the catalog would not take: the status a door answers and why. */
export class LeaseRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where a door gets a slot for a model: its backend's admission, which on a card waits out the swap. */
export interface ServedSource {
  lease(model: ServedModel, opts: LeaseOptions): Promise<Lease>;
}

/** What the doors read: the models listed, a model by any of its names, the default, the card's state, and a slot. */
export interface ServedCatalog extends ServedSource {
  models(): ServedModel[];
  /** A model by its id, the name its backend serves it by, or one of its aliases. */
  find(name: string): ServedModel | undefined;
  /** The model a request that names none goes to: a card's or a server's default, or the first. */
  default(): ServedModel | undefined;
  /** The first card's state, for the `server` block; null where Kvasir serves no card. */
  server(): ServedServer | null;
}

const whole = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0
    ? v
    : typeof v === "string" && /^\d+$/u.test(v) && Number(v) > 0
      ? Number(v)
      : null;

/**
 * The specs of one model from what an operator or a server wrote: modelgate's
 * and Kvasir's own fields (`context_length`, `max_output_tokens`,
 * `max_concurrent_requests`, `capabilities`, `swap_in_seconds`), vLLM's and
 * SGLang's `max_model_len`, and llama.cpp's `meta.n_ctx_train`.
 */
export function specOf(raw: unknown): ServedSpec {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const caps = (o.capabilities && typeof o.capabilities === "object" ? o.capabilities : {}) as Record<
    string,
    unknown
  >;
  const meta = (o.meta && typeof o.meta === "object" ? o.meta : {}) as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  const taken = new Set([
    "id",
    "object",
    "created",
    "owned_by",
    "aliases",
    "default",
    "status",
    "context_length",
    "max_output_tokens",
    "max_concurrent_requests",
    "max_model_len",
    "meta",
    "backend",
    "card",
  ]);
  for (const [k, v] of Object.entries(o)) if (!taken.has(k)) rest[k] = v;
  return {
    contextLength: whole(o.context_length) ?? whole(o.max_model_len) ?? whole(meta.n_ctx_train),
    maxOutputTokens: whole(o.max_output_tokens),
    concurrency: whole(o.max_concurrent_requests),
    reasoning: caps.reasoning === true,
    tools: caps.tools === true,
    vision: caps.vision === true,
    swapInSeconds: whole(o.swap_in_seconds),
    rest,
  };
}

/**
 * A model in modelgate's shape: the id, its aliases, default and status, the two limits, then the rest of its
 * specs. `isDefault` is whether a request that names no model goes to it, as modelgate marks one model.
 */
export function modelObject(m: ServedModel, isDefault = m.default): Record<string, unknown> {
  return {
    id: m.id,
    object: "model",
    created: 0,
    owned_by: "kvasir",
    aliases: m.aliases,
    default: isDefault,
    status: m.status,
    context_length: m.contextLength,
    max_output_tokens: m.maxOutputTokens,
    max_concurrent_requests: m.concurrency,
    ...(m.protocols.length > 0 ? { apis: m.protocols.map((p) => API_NAMES[p]) } : {}),
    ...m.spec,
    capabilities: {
      ...((m.spec.capabilities as Record<string, unknown> | undefined) ?? {}),
      tools: m.tools,
      reasoning: m.reasoning,
      vision: m.vision,
    },
    backend: m.backend,
    ...(m.card ? { card: m.card } : {}),
  };
}

/**
 * `GET /v1/models` whole, in modelgate's shape: the list, and the card's state where Kvasir serves one.
 * `keep` narrows the list, as to the models a client key may use.
 */
export function modelList(c: ServedCatalog, keep?: (m: ServedModel) => boolean): Record<string, unknown> {
  const server = c.server();
  const models = keep ? c.models().filter(keep) : c.models();
  const fallback = c.default()?.id;
  return {
    object: "list",
    data: models.map((m) => modelObject(m, m.id === fallback)),
    ...(server ? { server } : {}),
  };
}

/** A backend's pass-through doors: what its configuration says, or none. */
export function protocolsOf(backend: Backend): Protocol[] {
  return backend.config.passThrough ?? [];
}

/** Where a model's status and card come from: the card that holds its backend, or a model server's last listing. */
export interface StatusSource {
  /** The card a backend is a member of, its status for that model, and whether it is the card's default. */
  card(backend: Backend, entry: ModelEntry): { card: string; status: ServedStatus; default: boolean } | null;
  /** What a model server said of one of its models when Kvasir last read its list. */
  remote(backend: Backend, entry: ModelEntry): { status: ServedStatus; default: boolean } | null;
}

/** One entry of a backend as a client lists it. */
export function servedOf(backend: Backend, entry: ModelEntry, source?: StatusSource): ServedModel {
  const spec = specOf(entry.spec ?? {});
  const onCard = source?.card(backend, entry) ?? null;
  const remote = onCard ? null : (source?.remote(backend, entry) ?? null);
  const status: ServedStatus =
    onCard?.status ??
    remote?.status ??
    (backend.config.locality === "remote" ? "unknown" : backend.health.warming ? "loading" : "loaded");
  return {
    id: entry.id,
    aliases: entry.aliases ?? [],
    upstream: entry.upstream ?? entry.id,
    backend: backend.config.id,
    card: onCard?.card ?? null,
    default: onCard?.default ?? remote?.default ?? false,
    status,
    contextLength: entry.contextWindow,
    maxOutputTokens: entry.maxTokens,
    concurrency: spec.concurrency ?? backend.config.concurrency,
    reasoning: entry.reasoning,
    tools: entry.spec ? spec.tools : true,
    vision: entry.input.includes("image"),
    protocols: protocolsOf(backend),
    anthropicThinking: backend.config.anthropicThinking ?? "disabled",
    local: backend.config.locality === "local",
    spec: spec.rest,
  };
}

/**
 * A slot for one request on the backend that serves a model: `admission.acquire`, which on a card's model
 * waits first for the card to load it, through a swap, with the heartbeat every second meanwhile.
 */
export async function leaseOn(backend: Backend, opts: LeaseOptions): Promise<Lease> {
  let release: () => void;
  try {
    release = await backend.admission.acquire(opts.heartbeat, opts.signal);
  } catch (e) {
    if (e instanceof RefusedAdmission) throw new LeaseRefused(503, "overloaded", e.refusal.fact);
    throw e;
  }
  backend.health.running += 1;
  const key = (await backend.credential?.()) ?? null;
  const anthropic = backend.config.kind === "anthropic-messages";
  return {
    // an OpenAI-shaped base ends in /v1, which the door's own path carries; Anthropic's names none
    base: anthropic ? backend.config.baseUrl : backend.config.baseUrl.replace(/\/v1$/u, ""),
    auth: key
      ? anthropic
        ? { header: "x-api-key", value: key }
        : { header: "authorization", value: `Bearer ${key}` }
      : null,
    backend: backend.config.id,
    answered: () => {
      if (backend.health.warming) {
        backend.health.warming = false;
        backend.health.firstTokenAt = Date.now();
      }
    },
    release: () => {
      backend.health.running -= 1;
      release();
    },
  };
}

/** The catalog over the backends Kvasir lists: every model a client may ask for, with where its status comes from. */
export function servedCatalog(
  backends: Backends,
  source?: StatusSource & { server(): ServedServer | null },
): ServedCatalog {
  const models = () =>
    backends.list.flatMap((b) =>
      b.config.models.filter((m) => backends.listed(b, m)).map((m) => servedOf(b, m, source)),
    );
  return {
    models,
    find: (name) => {
      const all = models();
      return (
        all.find((m) => m.id === name) ??
        all.find((m) => m.upstream === name) ??
        all.find((m) => m.aliases.includes(name))
      );
    },
    default: () => {
      const all = models();
      // a card's default before a model server's, then the first model an admin added
      return all.find((m) => m.default && m.card) ?? all.find((m) => m.default) ?? all[0];
    },
    server: () => source?.server() ?? null,
    async lease(model, opts) {
      const backend = backends.get(model.backend);
      if (!backend?.config.models.some((e) => e.id === model.id))
        throw new LeaseRefused(404, "model_not_found", `no model ${model.id}`);
      return leaseOn(backend, opts);
    },
  };
}
