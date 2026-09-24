// SPDX-License-Identifier: AGPL-3.0-only
// The served models (record 47): what `GET /v1/models` lists, in modelgate's
// shape, and where a door that passes a request through sends it. This file is
// the seam between the doors (K1) and what serves the models. Two kinds of
// source fill it:
//
// - the held backends (below): each model an admin added, on a backend that
//   is up, admitted where the gate holds;
// - a card (K3): a group of models sharing one device, one loaded at a time.
//   It implements `ServedSource`, registers with `Served.register(source,
//   { first: true })`, says each model's status (loaded, cold, loading,
//   failed), and in `lease` waits for a swap when a request asks for a cold
//   model, calling `heartbeat` every second while it waits.
//
// The doors own the shape of `/v1/models` and every rule of a request (the
// key's scopes, the thinking default, the context guard, the ledger); a source
// owns its list of models, their specs and their state, and the wait for a slot.

import { RefusedAdmission } from "./admission.js";
import type { Backend, Backends } from "./backends.js";

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

export interface ServedModel {
  /** The name clients use, and the one `/v1/models` lists. */
  id: string;
  /** The name the backend serves it by; a request's `model` is rewritten to it. */
  upstream: string;
  /** Other names a request may use for it. */
  aliases: string[];
  /** The model a request that names none goes to. */
  default: boolean;
  /** `loaded` where a request is answered without a swap; `cold` where it would load the model first. */
  status: "loaded" | "cold" | "loading" | "failed";
  ownedBy: string;
  created: number;
  /** The model's context window in tokens, input and output together, where it is known. */
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** The doors whose requests the backend answers natively. */
  protocols: Protocol[];
  /** An Anthropic request without `thinking`: sent on as disabled, or left to the model. */
  anthropicThinking: "disabled" | "as-sent";
  /** Whether it runs in the group's own systems: only such a model is reached through a pass-through door (D44). */
  local: boolean;
  /** Everything else `/v1/models` shows as it is: capabilities, apis, architecture, measured speeds, licence. */
  spec: Record<string, unknown>;
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
  /** Whether this request may load a cold model, swapping out the loaded one (a client key's `swap`). */
  mayLoad: boolean;
}

/** A request the source would not take: the status a door answers and why. */
export class LeaseRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ServedSource {
  readonly id: string;
  models(): ServedModel[];
  lease(model: ServedModel, opts: LeaseOptions): Promise<Lease>;
  /** The source's own state, shown as `server` on `/v1/models` (a card: its state, the loaded model, the last swap). */
  server?(): Record<string, unknown> | null;
}

export interface Found {
  model: ServedModel;
  source: ServedSource;
}

/** Every source's models, a card's first; a model id is served by the first source that lists it. */
export class Served {
  private readonly sources: ServedSource[] = [];

  register(source: ServedSource, opts: { first?: boolean } = {}): void {
    const at = this.sources.findIndex((s) => s.id === source.id);
    if (at >= 0) this.sources.splice(at, 1);
    if (opts.first) this.sources.unshift(source);
    else this.sources.push(source);
  }

  list(): Found[] {
    const seen = new Set<string>();
    const out: Found[] = [];
    for (const source of this.sources) {
      for (const model of source.models()) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        out.push({ model, source });
      }
    }
    return out;
  }

  /** The model a name means: its id, then the name its backend serves it by, then an alias. */
  resolve(name: string): Found | undefined {
    const all = this.list();
    return (
      all.find((f) => f.model.id === name) ??
      all.find((f) => f.model.upstream === name) ??
      all.find((f) => f.model.aliases.includes(name))
    );
  }

  /** The model a request without one goes to: the one marked default, or the first. */
  default(): Found | undefined {
    const all = this.list();
    return all.find((f) => f.model.default) ?? all[0];
  }

  /** The first source's state that has one, for `server` on `/v1/models`. */
  server(): Record<string, unknown> | null {
    for (const s of this.sources) {
      const state = s.server?.();
      if (state) return state;
    }
    return null;
  }
}

/** One model as `/v1/models` shows it: modelgate's fields, the spec's after them. */
export function modelCard(f: Found, defaultId: string | undefined): Record<string, unknown> {
  const m = f.model;
  return {
    id: m.id,
    object: "model",
    created: m.created,
    owned_by: m.ownedBy,
    aliases: m.aliases,
    default: m.id === defaultId,
    status: m.status,
    context_length: m.contextLength,
    max_output_tokens: m.maxOutputTokens,
    ...m.spec,
  };
}

/** A backend's pass-through doors: what its configuration says, or none. */
export function protocolsOf(backend: Backend): Protocol[] {
  return backend.config.passThrough ?? [];
}

/**
 * The held backends as a source: each model the catalog lists, on the backend
 * an admin added. A held backend is up, so its models are loaded; the wait is
 * the backend's own queue (§8.7).
 */
export function heldSource(backends: Backends): ServedSource {
  const models = (): ServedModel[] =>
    backends.list.flatMap((b) =>
      b.config.models
        .filter((e) => backends.listed(b, e))
        .map((e) => {
          const protocols = protocolsOf(b);
          return {
            id: e.id,
            upstream: e.upstream ?? e.id,
            aliases: [],
            default: false,
            status: "loaded" as const,
            ownedBy: b.config.id,
            created: 0,
            contextLength: e.contextWindow,
            maxOutputTokens: e.maxTokens,
            protocols,
            anthropicThinking: b.config.anthropicThinking ?? "disabled",
            local: b.config.locality === "local",
            spec: {
              capabilities: {
                reasoning: e.reasoning,
                vision: e.input.includes("image"),
                streaming: true,
              },
              apis: protocols.map((p) => API_NAMES[p]),
            },
          };
        }),
    );
  return {
    id: "held",
    models,
    async lease(model, opts) {
      const backend = backends.list.find(
        (b) => b.config.id === model.ownedBy && b.config.models.some((e) => e.id === model.id),
      );
      if (!backend) throw new LeaseRefused(404, "model_not_found", `no model ${model.id}`);
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
    },
  };
}
