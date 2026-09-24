// SPDX-License-Identifier: AGPL-3.0-only
// The cards of kvasir.json (record 47): each a group of models that share one
// device, one loaded at a time, with the driver that starts and stops them.
// A card's `models` take modelgate's own entries as they are (id, aliases,
// container, upstream, default, spec), so its configuration moves over whole.

import { isAbsolute } from "node:path";
import { specOf } from "./served.js";

/** One model of a card. */
export interface CardMemberConfig {
  /** The name a client asks for, which the model's server knows it by (SGLang's --served-model-name). */
  id: string;
  aliases: string[];
  /** What the driver knows it by: the container's name (docker) or the preset's (llama-router). */
  name: string;
  /** The model's own server, without /v1: its /health is asked, and its /v1 serves it. */
  upstream: string;
  default: boolean;
  /** The backend Kvasir serves it as. */
  backend: string;
  /** The model's specs, as modelgate's `spec` (context_length, max_output_tokens, max_concurrent_requests, capabilities, and the rest). */
  spec: Record<string, unknown>;
}

export type CardDriverConfig =
  | { kind: "docker"; command: string }
  | { kind: "llama-router"; url: string; keyFile: string };

export interface CardConfig {
  id: string;
  driver: CardDriverConfig;
  /** Whether Kvasir starts and stops the models (the default), or only watches which one runs, as beside modelgate. */
  manage: boolean;
  /** How long a model keeps the card, while busy, before another may take it. */
  minResidencySeconds: number;
  /** How long the card waits without use of another model before it loads its default again. */
  idleReturnSeconds: number;
  /** How long a swap waits for the running requests to finish. */
  drainTimeoutSeconds: number;
  /** How long a model may take to answer its health after it is started. */
  startTimeoutSeconds: number;
  /** How long a request waits for its model to be loaded. */
  queueTimeoutSeconds: number;
  /** A sentence for clients, shown beside the list. */
  note: string;
  models: CardMemberConfig[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40)
      .replace(/-+$/u, "") || "model"
  );
}

/** The cards kvasir.json names, checked; none where it names none. */
export function cardsOf(value: unknown, runtime: { url: string } | null): CardConfig[] {
  if (value === undefined || value === null) return [];
  const bad = (m: string) => new Error(`kvasir.json: cards: ${m}`);
  if (!Array.isArray(value)) throw bad("a list of cards, each a group of models sharing one device");
  const cards: CardConfig[] = [];
  const names = new Set<string>();
  const backends = new Set<string>();
  for (const raw of value) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id : "";
    if (!ID.test(id)) throw bad(`${id || "a card"}: id is lowercase letters, digits and dashes`);
    if (cards.some((x) => x.id === id)) throw bad(`${id} is named twice`);
    const kind = c.driver ?? "docker";
    let driver: CardDriverConfig;
    if (kind === "docker") {
      driver = { kind: "docker", command: typeof c.docker === "string" && c.docker ? c.docker : "docker" };
    } else if (kind === "llama-router") {
      const r = (c.router ?? {}) as Record<string, unknown>;
      const url = typeof r.url === "string" ? r.url.trim().replace(/\/+$/u, "") : "";
      if (!/^https?:\/\/[^\s/]+$/u.test(url)) throw bad(`${id}: router.url is the router's address`);
      if (typeof r.keyFile !== "string" || !isAbsolute(r.keyFile))
        throw bad(`${id}: router.keyFile is an absolute path`);
      if (runtime && runtime.url === url)
        throw bad(
          `${id}: the router at ${url} is the install's runtime (local.runtime), which Kvasir already loads models on; a card takes a router of its own`,
        );
      driver = { kind: "llama-router", url, keyFile: r.keyFile };
    } else throw bad(`${id}: driver is docker or llama-router`);
    const seconds = (key: string, fallback: number) => {
      const v = c[key];
      if (v === undefined) return fallback;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad(`${id}: ${key} is seconds`);
      return v;
    };
    if (!Array.isArray(c.models) || c.models.length === 0) throw bad(`${id}: models, at least one`);
    const models: CardMemberConfig[] = [];
    for (const rm of c.models) {
      const m = (rm ?? {}) as Record<string, unknown>;
      const mid = typeof m.id === "string" ? m.id.trim() : "";
      if (!mid) throw bad(`${id}: each model has the id its server knows it by`);
      const aliases = Array.isArray(m.aliases)
        ? m.aliases.filter((a): a is string => typeof a === "string")
        : [];
      for (const n of [mid, ...aliases]) {
        if (names.has(n)) throw bad(`${n} names two models`);
        names.add(n);
      }
      const name =
        driver.kind === "docker"
          ? typeof m.container === "string"
            ? m.container
            : ""
          : typeof m.preset === "string"
            ? m.preset
            : mid;
      if (!name) throw bad(`${mid}: container, the name of its container`);
      const upstream =
        driver.kind === "llama-router"
          ? driver.url
          : typeof m.upstream === "string"
            ? m.upstream.trim().replace(/\/+$/u, "")
            : "";
      if (!/^https?:\/\/\S+$/u.test(upstream)) throw bad(`${mid}: upstream is its server's address`);
      const backend = typeof m.backend === "string" ? m.backend : slug(`${id}-${mid}`);
      if (!ID.test(backend)) throw bad(`${mid}: backend is lowercase letters, digits and dashes`);
      if (backends.has(backend)) throw bad(`${backend} is two backends`);
      backends.add(backend);
      const spec = m.spec && typeof m.spec === "object" && !Array.isArray(m.spec) ? m.spec : {};
      if (specOf(spec).contextLength === null) throw bad(`${mid}: spec.context_length, in tokens`);
      models.push({
        id: mid,
        aliases,
        name,
        upstream,
        default: m.default === true,
        backend,
        spec: spec as Record<string, unknown>,
      });
    }
    const defaults = models.filter((m) => m.default);
    if (defaults.length > 1) throw bad(`${id}: one default model, not ${defaults.length}`);
    if (defaults.length === 0) models[0].default = true;
    cards.push({
      id,
      driver,
      manage: c.manage !== false,
      minResidencySeconds: seconds("minResidencySeconds", 60),
      idleReturnSeconds: seconds("idleReturnSeconds", 600),
      drainTimeoutSeconds: seconds("drainTimeoutSeconds", 600),
      startTimeoutSeconds: seconds("startTimeoutSeconds", 1200),
      queueTimeoutSeconds: seconds("queueTimeoutSeconds", 1500),
      note: typeof c.note === "string" ? c.note : "",
      models,
    });
  }
  return cards;
}
