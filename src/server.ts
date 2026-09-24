// SPDX-License-Identifier: AGPL-3.0-only
// The one process: the router, identity, the keys, the ledger, the metrics.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { Admissions } from "./admission-records.js";
import { Auth, type Grant, holds, type Principal, Refused } from "./auth.js";
import { type Backend, Backends } from "./backends.js";
import { type CardDriver, Cards, type CardTimes } from "./card.js";
import type { CardConfig } from "./card-config.js";
import { chatgptAuth, chatgptBackend, chatgptModels } from "./chatgpt.js";
import { ClientRefused, Clients } from "./clients.js";
import { type Config, isPublic, pepper } from "./config.js";
import { Credentials, openSeal } from "./credentials.js";
import { chatCompletions, json, piMessages, readBody, type Whose } from "./doors.js";
import { described, Held, HeldRefused, tryBackend } from "./held.js";
import { CLASSES, type ContentClass, Keys } from "./keys.js";
import { Ledger } from "./ledger.js";
import { Lifecycle, LifecycleRefused, parseSource } from "./lifecycle.js";
import { Local, type LocalOptions, LocalRefused } from "./local.js";
import { mayUse, passThrough } from "./passthrough.js";
import { type Need, Policy, Refused as PolicyRefused } from "./policy.js";
import { Runner, type RunnerOptions } from "./runtime.js";
import { DOORS, modelList, modelObject, type ServedCatalog, servedCatalog } from "./served.js";
import { Servers } from "./servers.js";
import { Store } from "./store.js";
import { CHATGPT, type SubscriptionAuth, Subscriptions, SYSTEM } from "./subscriptions.js";
import { measureOverhead, probeRuntime, runSuite } from "./suite.js";

/** Kvasir's version, as its package names it. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;

export interface Kvasir {
  config: Config;
  backends: Backends;
  store: Store;
  keys: Keys;
  /** Client keys (record 47): the keys of the doors that pass a request through. */
  clients: Clients;
  ledger: Ledger;
  auth: Auth;
  credentials: Credentials;
  /** The models Kvasir holds: tried, added, served and removed (record 23). */
  held: Held;
  /** Each person's own ChatGPT subscription, or the install's where nobody signs in (record 23). */
  subscriptions: Subscriptions;
  /** Local models: downloaded by Kvasir into a location an admin can change (record 23), and started on the install's runtime where it runs one (record 24). */
  local: Local;
  /** The runtime a GGUF download starts on, where kvasir.json names one; null otherwise (record 24). */
  runner: Runner | null;
  policy: Policy;
  admissions: Admissions;
  /** The model lifecycle (Wave 5 §9.5): registered, admitted, promoted, retired. */
  lifecycle: Lifecycle;
  /** The cards kvasir.json names (record 47): models sharing one device, one loaded at a time; started by `kvasir` serving, never by the command line. */
  cards: Cards;
  /** Model servers held as backends (record 47): their offers, their ticked models admitted, their states followed. */
  servers: Servers;
  /** Every model a client may ask for, with its specs and whether it is loaded: what `GET /v1/models` lists (src/served.ts). */
  served: ServedCatalog;
  /** The suite over one model, recorded, and the admitted set refreshed (§8.6). */
  admit: (
    backendId: string,
    modelId?: string,
    opts?: { overhead?: boolean; log?: (line: string) => void },
  ) => Promise<import("./suite.js").AdmissionRecord[]>;
  server: Server;
  /** The listener of the public doors alone (record 47), bound where kvasir.json names `public.bind`. */
  publicServer: Server;
  address: () => string;
  close: () => Promise<void>;
}

export function build(
  config: Config,
  options: {
    subscriptionAuth?: () => SubscriptionAuth;
    local?: LocalOptions;
    runtime?: RunnerOptions;
    /** How long a stream may say nothing before a comment keeps it; the doors' 15 seconds when absent. */
    keepAliveMs?: number;
    /** The driver of each card, for a test; Docker or the llama.cpp router, as kvasir.json says, otherwise. */
    cardDriver?: (c: CardConfig) => CardDriver;
    /** The times of each card, for a test; kvasir.json's otherwise. */
    cardTimes?: (c: CardConfig) => CardTimes;
  } = {},
): Kvasir {
  const store = new Store(config.store);
  const backends = new Backends(config.admission);
  const keys = new Keys(store, pepper(config.pepperFile));
  const clients = new Clients(store);
  const ledger = new Ledger(store);
  const auth = new Auth(config.auth, keys, clients);
  // a client key's ledger rows are kept for as many days as kvasir.json says (record 47, R8)
  ledger.prune(config.clients.ledgerDays);
  const pruning = setInterval(() => ledger.prune(config.clients.ledgerDays), 3_600_000);
  pruning.unref();
  const seal = openSeal(config.sealKeyFile);
  const credentials = new Credentials(store, seal);
  const policy = new Policy(store, config.purposes, backends);
  // the models this database holds, served from the start; a purpose mapped to one let go returns to its default
  const held = new Held(store, backends, credentials, (id) => policy.forget(id), config.hostAlias);
  held.sync();
  // local models download into `models` beside the database until an admin sets a location
  const local = new Local(
    store,
    credentials,
    config.local.endpoint,
    resolve(dirname(config.store), "models"),
    options.local,
  );
  // a GGUF download starts on the runtime kvasir.json names, where the install runs one (record 24)
  const runner = config.local.runtime
    ? new Runner(store, held, backends, credentials, local, config.local.runtime, options.runtime)
    : null;
  local.runner = runner;
  // the cards: each model served as a backend whose admission waits for the card to load it (record 47)
  const cards = new Cards(config.cards, backends, options.cardDriver, options.cardTimes);
  // ChatGPT through each person's own subscription: Kvasir's own backend, served beside the added ones (record 23)
  const subscriptions = new Subscriptions(
    store,
    seal,
    chatgptModels(),
    options.subscriptionAuth ?? chatgptAuth,
  );
  backends.add(chatgptBackend(backends, subscriptions));
  policy.subscribed = (subject) => subscriptions.has(subject);
  policy.subscriptionModel = (subject) => subscriptions.model(subject);
  const admissions = new Admissions(store);
  const lifecycle = new Lifecycle(store);
  // a promoted candidate is the model the purposes route to on its backend
  policy.promoted = (backendId) => lifecycle.promoted(backendId);
  const admit: Kvasir["admit"] = async (backendId, modelId, opts = {}) => {
    const backend = backends.list.find((b) => b.config.id === backendId);
    if (!backend) throw new Error(`no backend ${backendId}`);
    const entries = backend.config.models.filter((m) => !modelId || m.id === modelId);
    if (entries.length === 0) throw new Error(`no model ${modelId} on ${backendId}`);
    const out = [];
    for (const entry of entries) {
      // a card's model is loaded first, and kept on the card while the suite runs (record 47)
      const leave = backend.admission.ahead ? await backend.admission.ahead() : null;
      let rec: Awaited<ReturnType<typeof runSuite>>;
      try {
        rec = await runSuite(backend, entry, { log: opts.log });
      } finally {
        leave?.();
      }
      rec.kvasir = VERSION;
      if (opts.overhead) {
        // through this process's own door, the same client, the same prompt
        const origin = k.address();
        rec.overhead = await measureOverhead(
          backend,
          entry,
          (context, maxTokens) => viaDoor(origin, entry.id, context, maxTokens, config),
          { log: opts.log },
        );
        opts.log?.(
          `overhead p50 ${rec.overhead.overhead.p50} ms, p95 ${rec.overhead.overhead.p95} ms (${rec.overhead.within ? "within" : "OVER"} the thresholds)`,
        );
      }
      const stored = admissions.put(rec);
      if (rec.passed) backend.admitted.add(entry.id);
      else backend.admitted.delete(entry.id);
      out.push(stored);
    }
    return out;
  };
  // model servers held as backends, and what each said of its models (record 47)
  const servers = new Servers({ config, backends, credentials, held, admissions, admit, policy });
  // what `GET /v1/models` lists and the pass-through doors serve: every backend's models, a card's with its
  // status, a model server's with what it last said (record 47)
  const served = servedCatalog(backends, {
    card: (b) => cards.status(b),
    remote: (b, e) => servers.remote(b.config.id, e.id),
    server: () => cards.list[0]?.server() ?? null,
  });
  const handle = (surface: "all" | "public") => async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://kvasir");
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    const open = isPublic(config.public.doors, req.method ?? "", path);
    // the public listener answers the doors meant for the public route and no other (record 47, R6)
    if (surface === "public" && !open) {
      json(res, 404, {
        error: { code: "no_such_door", message: `${req.method} ${path} is not a door Kvasir has` },
      });
      return;
    }
    if (path === "/health" && req.method === "GET") {
      // modelgate's shape, for the probe on the model server (record 47): 200 while every card serves or swaps
      const h = cards.health();
      json(res, h.status, h.body);
      return;
    }
    if (path === "/healthz" && req.method === "GET") {
      json(res, 200, {
        ok: true,
        warming: backends.list.some((b) => b.health.warming),
        backends: backends.list.map((b) => ({ id: b.config.id, ...b.health, queued: b.admission.queued })),
      });
      return;
    }
    if (path === "/metrics" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(ledger.metrics());
      return;
    }
    let who: Principal;
    try {
      who = await auth.principal(req);
    } catch (e) {
      if (e instanceof Refused) {
        json(res, e.status, {
          error: {
            code: e.status === 401 ? "unauthenticated" : "no_grant",
            type: e.status === 401 ? "authentication_error" : "permission_error",
            message: e.message,
          },
        });
        return;
      }
      throw e;
    }
    // a client key opens the doors meant for clients, wherever it calls
    if (who.client && !open) {
      json(res, 403, {
        error: {
          code: "not_public",
          type: "permission_error",
          message: `a client key opens only the doors meant for clients: ${config.public.doors.join(", ")}`,
        },
      });
      return;
    }
    try {
      await route(req, res, path, url, who, {
        config,
        backends,
        keys,
        clients,
        ledger,
        credentials,
        held,
        subscriptions,
        local,
        auth,
        policy,
        admissions,
        lifecycle,
        admit,
        servers,
        served,
        keepAliveMs: options.keepAliveMs,
      });
    } catch (e) {
      if (!res.headersSent)
        json(res, 500, { error: { code: "internal", message: "Kvasir could not answer" } });
      else res.end();
      console.error("kvasir:", e instanceof Error ? e.message : e);
    }
  };
  const server = createServer(handle("all"));
  const publicServer = createServer(handle("public"));
  const k: Kvasir = {
    config,
    backends,
    store,
    keys,
    clients,
    ledger,
    auth,
    credentials,
    held,
    subscriptions,
    local,
    runner,
    policy,
    admissions,
    lifecycle,
    cards,
    servers,
    served,
    admit,
    server,
    publicServer,
    address: () => {
      const a = server.address();
      return typeof a === "object" && a ? `http://${a.address}:${a.port}` : "";
    },
    close: async () => {
      // a warm-up still being tried, and the following of the database, end with the server; a download
      // stops with what it has, to carry on when Kvasir starts again
      held.unwatch();
      clearInterval(pruning);
      servers.unwatch();
      cards.close();
      for (const b of backends.list) b.stop();
      await runner?.close();
      await local.stop();
      await new Promise<void>((done) => server.close(() => done()));
      if (publicServer.listening) await new Promise<void>((done) => publicServer.close(() => done()));
      store.close();
    },
  };
  return k;
}

/** One stream through this process's own pi-messages door, for the overhead measurement. */
async function* viaDoor(
  origin: string,
  model: string,
  context: import("@earendil-works/pi-ai").Context,
  maxTokens: number,
  config: Config,
): AsyncGenerator<import("@earendil-works/pi-ai").AssistantMessageEvent> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // the door is reached as this process's own operator: the first token of its token list, or nothing in off mode
  const first =
    config.auth.mode === "token"
      ? Object.keys((config.auth as { tokens?: Record<string, string> }).tokens ?? {})[0]
      : undefined;
  if (first) headers.authorization = `Bearer ${first}`;
  const r = await fetch(`${origin}/v1/pi/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, context, options: { maxTokens, temperature: 0 } }),
  });
  if (!r.ok || !r.body) {
    yield {
      type: "error",
      reason: "error",
      error: { errorMessage: `the door answered ${r.status}` },
    } as never;
    return;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf("\n\n");
    while (at >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (data) yield JSON.parse(data);
      at = buffer.indexOf("\n\n");
    }
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  who: Principal,
  k: {
    config: Config;
    backends: Backends;
    keys: Keys;
    clients: Clients;
    ledger: Ledger;
    credentials: Credentials;
    held: Held;
    subscriptions: Subscriptions;
    local: Local;
    auth: Auth;
    policy: Policy;
    admissions: Admissions;
    lifecycle: Lifecycle;
    admit: Kvasir["admit"];
    servers: Servers;
    served: ServedCatalog;
    keepAliveMs?: number;
  },
): Promise<void> {
  const {
    config,
    backends,
    keys,
    clients,
    served,
    ledger,
    credentials,
    held,
    subscriptions,
    local,
    auth,
    policy,
    admissions,
    lifecycle,
  } = k;
  const { admit, servers } = k;
  // the pass-through doors (record 47): the request as the client sent it, to a backend that speaks it
  const pass = (text: string, translate?: (text: string) => Promise<void>) =>
    passThrough(req, res, path, url.search, text, {
      served,
      ledger,
      who,
      keepAliveMs: k.keepAliveMs,
      translate,
    });
  if (path === "/v1/config" && req.method === "GET") {
    // pi's model store streams to `${baseUrl}/messages`: the pi-messages door (record 47)
    json(res, 200, {
      ...backends.catalog(config.origin),
      baseUrl: `${config.origin}/v1/pi`,
      kvasir: { version: VERSION },
    });
  } else if (path === "/v1/models" && req.method === "GET") {
    // modelgate's shape (record 47): each model with its aliases, whether it is the default and loaded, and
    // its specs; a client key sees the models it may use
    json(
      res,
      200,
      modelList(served, (m) => mayUse(who, m, served)),
    );
  } else if (path === "/v1/pi/messages" && req.method === "POST") {
    const whose = await streamSubject(req, res, who, auth, config);
    if (whose !== null)
      await piMessages(req, res, backends, who, ledger, policy, whose, { keepAliveMs: k.keepAliveMs });
  } else if (path === "/v1/messages" && req.method === "POST") {
    // for one release the old path serves both: a body with pi's `context` and no `messages` is
    // pi-messages, which has moved to /v1/pi/messages; anything else is Anthropic's (record 47, R2)
    const text = await readBody(req, PASS_LIMIT);
    if (piShaped(text)) {
      if (who.client) {
        json(res, 403, {
          error: {
            code: "not_public",
            type: "permission_error",
            message: "pi-messages is NILS's own door; a client key sends Anthropic's messages here",
          },
        });
        return;
      }
      res.setHeader("deprecation", "true");
      res.setHeader("link", '</v1/pi/messages>; rel="successor-version"');
      const whose = await streamSubject(req, res, who, auth, config);
      if (whose !== null)
        await piMessages(req, res, backends, who, ledger, policy, whose, {
          keepAliveMs: k.keepAliveMs,
          body: text,
        });
    } else await pass(text);
  } else if (path === "/v1/chat/completions" && req.method === "POST") {
    // a model no backend answers natively goes through pi-ai, as before record 47
    await pass(await readBody(req, PASS_LIMIT), async (text) => {
      const whose = await streamSubject(req, res, who, auth, config);
      if (whose !== null)
        await chatCompletions(req, res, backends, who, ledger, policy, whose, {
          keepAliveMs: k.keepAliveMs,
          body: text,
        });
    });
  } else if (Object.hasOwn(DOORS, path) && req.method === "POST") {
    await pass(await readBody(req, PASS_LIMIT));
  } else if (path === "/v1/clients" && req.method === "GET") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "the client keys need kvasir:work");
    const usage = clients.usage(config.clients.ledgerDays);
    json(res, 200, {
      clients: clients.list().map((c) => ({ ...clientOut(c), usage: usage.get(c.id) ?? null })),
      usage_days: config.clients.ledgerDays,
    });
  } else if (path === "/v1/clients" && req.method === "POST") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "a client key needs kvasir:work");
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      const made = clients.add(String(body.name ?? ""), {
        models: Array.isArray(body.models) ? body.models.filter((m: unknown) => typeof m === "string") : null,
        swap: body.swap !== false,
        by: who.subject,
      });
      json(res, 201, { ...clientOut(made), key: made.secret, shown: "once" });
    } catch (e) {
      if (!(e instanceof ClientRefused)) throw e;
      json(res, 400, { error: { code: "bad_request", message: e.message } });
    }
  } else if (path.startsWith("/v1/clients/") && req.method === "DELETE") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "revoking a client key needs kvasir:work");
    const id = decodeURIComponent(path.slice("/v1/clients/".length));
    if (clients.revoke(id)) {
      res.writeHead(204);
      res.end();
    } else
      json(res, 404, { error: { code: "no_such_key", message: `no client key ${id} that is not revoked` } });
  } else if (path === "/v1/keys" && req.method === "GET") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "the keys need kvasir:work");
    json(res, 200, { keys: keys.list() });
  } else if (path === "/v1/keys" && req.method === "POST") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "minting a key needs kvasir:work");
    const body = JSON.parse(await readBody(req));
    const purposes: string[] = Array.isArray(body.purposes)
      ? body.purposes.filter((p: unknown) => typeof p === "string")
      : [];
    const maxClass: ContentClass = CLASSES.includes(body.max_class) ? body.max_class : "catalog";
    if (typeof body.principal !== "string" || !body.principal) {
      return json(res, 400, { error: { code: "bad_request", message: "principal: whom the key acts as" } });
    }
    const expiresAt = typeof body.expires_at === "number" ? body.expires_at : null;
    const minted = keys.mint(body.principal, purposes, maxClass, expiresAt);
    json(res, 201, {
      id: minted.id,
      principal: minted.principal,
      purposes: minted.purposes,
      max_class: minted.maxClass,
      expires_at: minted.expiresAt,
      key: minted.secret,
      shown: "once",
    });
  } else if (path.startsWith("/v1/keys/") && req.method === "DELETE") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "revoking a key needs kvasir:work");
    const id = path.slice("/v1/keys/".length);
    if (keys.revoke(id)) {
      res.writeHead(204);
      res.end();
    } else json(res, 404, { error: { code: "no_such_key", message: `no key ${id}` } });
  } else if (path === "/v1/grants" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const purpose = typeof body.purpose === "string" ? body.purpose : "";
    const need: Need = typeof body.need === "object" && body.need ? body.need : {};
    const text = typeof body.text === "string" ? body.text : "";
    try {
      const bumped = text ? policy.identifierShapeOf(text) : null;
      const g = policy.grant(purpose, need, {
        pin: typeof body.pin === "string" ? body.pin : null,
        bumped,
        keyClass: who.key?.maxClass,
        subject: subscribing(who, config),
      });
      json(res, 200, g);
    } catch (e) {
      if (e instanceof PolicyRefused)
        return json(res, e.status, { error: { code: "refused", message: e.message, refusals: e.refusals } });
      throw e;
    }
  } else if (path === "/v1/purposes" && req.method === "GET") {
    json(res, 200, { purposes: policy.table() });
  } else if (path.startsWith("/v1/purposes/") && path.endsWith("/policy") && req.method === "PUT") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "the policy table needs kvasir:work");
    const id = path.slice("/v1/purposes/".length, -"/policy".length);
    const body = JSON.parse(await readBody(req));
    try {
      const row = policy.set(
        id,
        String(body.backend ?? ""),
        who.subject,
        typeof body.acknowledgement === "string" ? body.acknowledgement : null,
        // a station maps to a backend and a model (record 47)
        typeof body.model === "string" && body.model ? body.model : null,
      );
      json(res, 200, row);
    } catch (e) {
      if (e instanceof PolicyRefused)
        return json(res, e.status, { error: { code: "refused", message: e.message, refusals: e.refusals } });
      throw e;
    }
  } else if (path === "/v1/backends" && req.method === "GET") {
    held.sync();
    const work = holds(who, "kvasir:work");
    json(res, 200, {
      backends: backends.list.map((b) => ({
        id: b.config.id,
        kind: b.config.kind,
        locality: b.config.locality,
        // where a backend is, and who added it, is for kvasir:work to see
        ...(work ? { base_url: b.config.baseUrl, ...held.addedOf(b.config.id) } : {}),
        provider: b.config.provider ?? null,
        credential: b.config.provider ? credentials.has(b.config.provider) : null,
        models: b.config.models.map((m) => m.id),
        entries: b.config.models.map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          context_window: m.contextWindow,
          max_tokens: m.maxTokens,
          admitted: b.config.locality === "remote" ? null : b.admitted.has(m.id),
          // record 47: its other names, and loaded or cold on its card or its server
          aliases: m.aliases ?? [],
          status: k.served.find(m.id)?.status ?? null,
        })),
        builtin: b.config.builtin === true,
        server: b.config.server === true,
        card: b.config.card ?? null,
        concurrency: b.config.concurrency,
        health: { ...b.health, queued: b.admission.queued },
      })),
    });
  } else if (path === "/v1/backends/test" && req.method === "POST") {
    // record 23: each model asked one short question, and nothing kept; with none named, only what the server lists
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "trying a backend needs kvasir:work");
    try {
      const d = described(JSON.parse((await readBody(req)) || "{}"), {
        modelsOptional: true,
        hostAlias: config.hostAlias,
      });
      json(res, 200, { ...(await tryBackend(d.config, d.key)), ...(d.note ? { note: d.note } : {}) });
    } catch (e) {
      heldError(res, e);
    }
  } else if (path === "/v1/backends" && req.method === "POST") {
    // record 23: a backend is held only once every one of its models answered
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "adding a backend needs kvasir:work");
    try {
      const { backend, tried, note } = await held.add(JSON.parse((await readBody(req)) || "{}"), who.subject);
      json(res, 201, {
        backend: {
          id: backend.config.id,
          locality: backend.config.locality,
          models: backend.config.models.map((m) => m.id),
        },
        tried,
        ...(note ? { note } : {}),
      });
    } catch (e) {
      heldError(res, e);
    }
  } else if (path === "/v1/servers/models" && req.method === "GET") {
    // record 47: the models a model server offers, with their specs, given its address and a sealed key's name
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "listing a model server needs kvasir:work");
    try {
      json(
        res,
        200,
        await servers.offered({
          url: url.searchParams.get("url") ?? "",
          key_ref: url.searchParams.get("key_ref") ?? undefined,
        }),
      );
    } catch (e) {
      heldError(res, e);
    }
  } else if (path === "/v1/servers" && req.method === "POST") {
    // record 47: the ticked models of a model server admitted one by one on its one backend
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "adding a model server needs kvasir:work");
    try {
      const done = await servers.admit(JSON.parse((await readBody(req)) || "{}"), who.subject);
      json(res, done.backend ? 201 : 422, done);
    } catch (e) {
      heldError(res, e);
    }
  } else if (/^\/v1\/backends\/[^/]+\/models\/.+$/u.test(path) && req.method === "DELETE") {
    // record 47: one model of a backend let go; the last lets the backend go
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "removing a model needs kvasir:work");
    const [id, model] = path
      .slice("/v1/backends/".length)
      .split("/models/")
      .map((x) => decodeURIComponent(x));
    if (held.removeModel(id, model, who.subject, (b, m) => policy.forgetModel(b, m))) {
      res.writeHead(204);
      res.end();
    } else json(res, 404, { error: { code: "no_such_model", message: `${id} holds no model ${model}` } });
  } else if (path.startsWith("/v1/backends/") && req.method === "DELETE") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "removing a backend needs kvasir:work");
    const id = decodeURIComponent(path.slice("/v1/backends/".length));
    if (held.remove(id)) {
      res.writeHead(204);
      res.end();
    } else json(res, 404, { error: { code: "no_such_backend", message: `no backend ${id}` } });
  } else if (path.startsWith("/v1/credentials/") && (req.method === "PUT" || req.method === "DELETE")) {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "the credentials need kvasir:work");
    const provider = path.slice("/v1/credentials/".length);
    if (req.method === "DELETE") {
      res.writeHead(credentials.delete(provider) ? 204 : 404);
      res.end();
      return;
    }
    const body = JSON.parse(await readBody(req));
    if (typeof body.secret !== "string" || body.secret.length < 8)
      return json(res, 400, { error: { code: "bad_request", message: "secret: the provider's key" } });
    credentials.put(provider, body.secret);
    json(res, 200, { provider, stored: true, shown: "never" });
  } else if (path === "/v1/subscriptions" && req.method === "GET") {
    // record 23: a person's own subscription, or the install's where nobody signs in; its status is the person's
    const whose = subscriberOf(who, config);
    if (!whose) return notAPerson(res);
    json(res, 200, { subscriptions: [subscriptions.status(whose.subject, whose.for)] });
  } else if (path === `/v1/subscriptions/${CHATGPT}/sign-in` && req.method === "POST") {
    // record 25: starting a sign-in, and choosing the model, need assistant:use and kvasir:see
    const whose = subscriberOf(who, config);
    if (!whose) return notAPerson(res);
    if (!holds(who, ...SUBSCRIBES)) return noGrant(res, SUBSCRIBES, SUBSCRIBES_NEEDS);
    try {
      const waiting = await subscriptions.signIn(whose.subject);
      json(res, 200, {
        state: "waiting",
        user_code: waiting.userCode,
        verification_uri: waiting.verificationUri,
        expires_at: waiting.expiresAt,
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.error(`kvasir: ChatGPT did not start the sign-in for ${whose.subject}: ${why}`);
      json(res, 502, { error: { code: "sign_in", message: `ChatGPT did not start the sign-in: ${why}` } });
    }
  } else if (path === `/v1/subscriptions/${CHATGPT}` && req.method === "PUT") {
    const whose = subscriberOf(who, config);
    if (!whose) return notAPerson(res);
    if (!holds(who, ...SUBSCRIBES)) return noGrant(res, SUBSCRIBES, SUBSCRIBES_NEEDS);
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      subscriptions.choose(whose.subject, String(body.model ?? ""));
      json(res, 200, subscriptions.status(whose.subject, whose.for));
    } catch (e) {
      json(res, 400, { error: { code: "bad_request", message: e instanceof Error ? e.message : String(e) } });
    }
  } else if (path === `/v1/subscriptions/${CHATGPT}` && req.method === "DELETE") {
    // signing out needs only the person
    const whose = subscriberOf(who, config);
    if (!whose) return notAPerson(res);
    res.writeHead(subscriptions.signOut(whose.subject) ? 204 : 404);
    res.end();
  } else if (path === "/v1/admission" && req.method === "GET") {
    json(res, 200, {
      records: admissions.list(Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100)),
    });
  } else if (path === "/v1/admission/run" && req.method === "POST") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "admission needs kvasir:work");
    const body = JSON.parse(await readBody(req));
    try {
      const records = await admit(
        String(body.backend ?? ""),
        typeof body.model === "string" ? body.model : undefined,
        {
          overhead: body.overhead === true,
        },
      );
      json(res, 200, { records });
    } catch (e) {
      json(res, 400, { error: { code: "bad_request", message: e instanceof Error ? e.message : String(e) } });
    }
  } else if (path === "/v1/models/lifecycle" && req.method === "GET") {
    // Wave 5 §9.5: every candidate with its state and its records; the desk's Teaching page reads it
    const withEvents = url.searchParams.get("events") === "1";
    json(res, 200, {
      candidates: lifecycle.list().map((c) => (withEvents ? { ...c, events: lifecycle.events(c.id) } : c)),
      // Kvasir's own ChatGPT backend has no candidates of its own
      promoted: backends.list
        .filter((b) => !b.config.builtin)
        .map((b) => ({ backend: b.config.id, model: lifecycle.promoted(b.config.id) })),
    });
  } else if (path === "/v1/models/lifecycle" && req.method === "POST") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "the lifecycle needs kvasir:work");
    const body = JSON.parse(await readBody(req));
    try {
      const backend = String(body.backend ?? "");
      if (!backends.list.some((b) => b.config.id === backend))
        throw new LifecycleRefused(404, `no backend named ${backend}`);
      const c = lifecycle.register(
        {
          model: String(body.model ?? ""),
          backend,
          source: parseSource(body.source),
          notes: typeof body.notes === "string" ? body.notes : null,
        },
        who.subject,
      );
      json(res, 201, { candidate: c });
    } catch (e) {
      lifecycleError(res, e);
    }
  } else if (path.startsWith("/v1/models/lifecycle/") && req.method === "POST") {
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "the lifecycle needs kvasir:work");
    const [idText, verb] = path.slice("/v1/models/lifecycle/".length).split("/");
    const id = Number(idText);
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      if (!Number.isInteger(id)) throw new LifecycleRefused(404, `no candidate ${idText}`);
      const c = lifecycle.get(id);
      if (!c) throw new LifecycleRefused(404, `no candidate ${id}`);
      if (verb === "admit") {
        // the suite through the same runner as POST /v1/admission/run; a failure is recorded and the state stays
        const [rec] = await admit(c.backend, c.model, { overhead: body.overhead === true });
        json(res, 200, {
          candidate: lifecycle.recordAdmission(id, rec, "kvasir admission", VERSION, who.subject),
          record: rec,
        });
      } else if (verb === "promote") {
        const proposal =
          body.proposal && (typeof body.proposal.id === "number" || typeof body.proposal.id === "string")
            ? { id: body.proposal.id, principal: String(body.proposal.principal ?? who.subject) }
            : null;
        json(res, 200, lifecycle.promote(id, who.subject, proposal));
      } else if (verb === "retire") {
        json(res, 200, { candidate: lifecycle.retire(id, who.subject) });
      } else {
        json(res, 404, { error: { code: "no_such_door", message: `${verb} is not a lifecycle verb` } });
      }
    } catch (e) {
      lifecycleError(res, e);
    }
  } else if (path === "/v1/ledger" && req.method === "GET") {
    const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200) || 200);
    // every row for kvasir:work, and one's own rows for anyone else
    json(res, 200, { rows: ledger.rows(holds(who, "kvasir:work") ? null : who.subject, limit) });
  } else if (path === "/v1/local" || path.startsWith("/v1/local/")) {
    // record 23: local models downloaded by Kvasir; record 24: a GGUF download started on the install's runtime
    if (!holds(who, "kvasir:work")) return noGrant(res, WORK, "local models need kvasir:work");
    await localDoor(req, res, path, who, local);
  } else if (path.startsWith("/v1/models/") && req.method === "GET") {
    // one model as `/v1/models` lists it, by id, served name or alias
    const found = served.find(decodeURIComponent(path.slice("/v1/models/".length)));
    if (!found || !mayUse(who, found, served))
      json(res, 404, {
        error: { message: `no model ${path.slice("/v1/models/".length)}`, type: "invalid_request_error" },
      });
    else json(res, 200, modelObject(found, found.id === served.default()?.id));
  } else {
    json(res, 404, {
      error: { code: "no_such_door", message: `${req.method} ${path} is not a door Kvasir has` },
    });
  }
}

/** Whether a body on the old `/v1/messages` is pi-messages: pi's `context` and no Anthropic `messages`. */
export function piShaped(text: string): boolean {
  try {
    const b = JSON.parse(text);
    return (
      !!b &&
      typeof b === "object" &&
      typeof b.context === "object" &&
      b.context !== null &&
      !Array.isArray(b.messages)
    );
  } catch {
    return false;
  }
}

/** A client key as a door shows it: never its secret or its hash. */
function clientOut(c: import("./clients.js").ClientKey): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    models: c.models,
    swap: c.swap,
    origin: c.origin,
    created_at: c.createdAt,
    created_by: c.createdBy,
    revoked_at: c.revokedAt,
    last_used_at: c.lastUsedAt,
  };
}

function lifecycleError(res: ServerResponse, e: unknown): void {
  if (e instanceof LifecycleRefused)
    json(res, e.status, { error: { code: "lifecycle", message: e.message } });
  else
    json(res, 400, { error: { code: "bad_request", message: e instanceof Error ? e.message : String(e) } });
}

/**
 * The doors of local models (record 23): the listing, the location, a lookup
 * that keeps nothing, a download queued, paused, resumed and removed, and the
 * Hugging Face token set and cleared, never shown; and a GGUF download started
 * and stopped on the install's runtime (record 24). Every one needs kvasir:work.
 */
async function localDoor(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  who: Principal,
  local: Local,
): Promise<void> {
  const body = async (): Promise<Record<string, unknown>> => {
    const text = await readBody(req, 1 << 20);
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new LocalRefused(400, "bad_request", "the body is a JSON object");
    return parsed as Record<string, unknown>;
  };
  const model = /^\/v1\/local\/models\/(\d+)(\/pause|\/resume|\/start|\/stop)?$/u.exec(path);
  try {
    if (path === "/v1/local" && req.method === "GET") json(res, 200, local.status());
    else if (path === "/v1/local/location" && req.method === "PUT") {
      local.setLocation((await body()).path, who.subject);
      json(res, 200, local.status());
    } else if (path === "/v1/local/lookup" && req.method === "POST")
      json(res, 200, await local.lookup(await body()));
    else if (path === "/v1/local/models" && req.method === "POST")
      json(res, 202, await local.add(await body(), who.subject));
    else if (model && !model[2] && req.method === "DELETE") {
      if (await local.remove(Number(model[1]))) {
        res.writeHead(204);
        res.end();
      } else json(res, 404, { error: { code: "no_such_model", message: `no local model ${model[1]}` } });
    } else if (model?.[2] === "/pause" && req.method === "POST")
      json(res, 200, local.pause(Number(model[1])));
    else if (model?.[2] === "/resume" && req.method === "POST")
      json(res, 200, local.resume(Number(model[1])));
    else if (model && (model[2] === "/start" || model[2] === "/stop") && req.method === "POST") {
      const runner = local.runner;
      if (!runner)
        throw new LocalRefused(
          409,
          "no_runtime",
          "this install runs no runtime Kvasir starts models on: start a model server with one of the commands shown, then add it",
        );
      if (model[2] === "/start") {
        const asked = await body();
        json(res, 202, await runner.start(Number(model[1]), who.subject, asked.file, asked.context));
      } else json(res, 200, await runner.stop(Number(model[1])));
    } else if (path === "/v1/local/token" && req.method === "PUT") {
      local.setToken((await body()).token);
      json(res, 200, { token: true, shown: "never" });
    } else if (path === "/v1/local/token" && req.method === "DELETE") {
      res.writeHead(local.clearToken() ? 204 : 404);
      res.end();
    } else
      json(res, 404, {
        error: { code: "no_such_door", message: `${req.method} ${path} is not a door Kvasir has` },
      });
  } catch (e) {
    if (!(e instanceof LocalRefused)) throw e;
    json(res, e.status, { error: { code: e.code, message: e.message, ...e.detail } });
  }
}

/**
 * Whose stream this is (record 23): the install's where nobody signs in; a
 * person calling with their own token, theirs; an app's key calling for a
 * person, that person's, named in `x-kvasir-person` with their own token and
 * verified. A person token that does not verify is refused rather than
 * streamed as the app. The person's subscription answers the stream only
 * while they hold assistant:use and kvasir:see (record 25); otherwise the
 * stream goes as a signed-out person's does.
 */
async function streamSubject(
  req: IncomingMessage,
  res: ServerResponse,
  who: Principal,
  auth: Auth,
  config: Config,
): Promise<Whose | null> {
  if (config.auth.mode === "off") return { subject: SYSTEM, subscriber: SYSTEM };
  const token = String(req.headers["x-kvasir-person"] ?? "").trim();
  if (!token || who.kind === "person") return { subject: who.subject, subscriber: subscribing(who, config) };
  try {
    const person = await auth.person(token);
    return { subject: person.subject, subscriber: subscribing(person, config) };
  } catch (e) {
    json(res, 401, {
      error: {
        code: "unauthenticated",
        message: e instanceof Error ? e.message : "the person's token did not verify",
      },
    });
    return null;
  }
}

/** Whose subscription a caller manages: their own as a person, the install's where nobody signs in; an app or a key manages none. */
function subscriberOf(who: Principal, config: Config): { subject: string; for: "person" | "system" } | null {
  if (config.auth.mode === "off") return { subject: SYSTEM, for: "system" };
  return who.kind === "person" ? { subject: who.subject, for: "person" } : null;
}

/** The largest body a pass-through door reads, images and all: modelgate's 64 MiB. */
const PASS_LIMIT = 64 << 20;

/** The grant of the doors that change Kvasir. */
const WORK: Grant[] = ["kvasir:work"];
/** What a subscription of one's own needs to be signed in, chosen, and to answer a stream (record 25). */
const SUBSCRIBES: Grant[] = ["assistant:use", "kvasir:see"];
const SUBSCRIBES_NEEDS = "a subscription of your own needs assistant:use and kvasir:see";

/** Whose subscription a caller's stream may use: the install's where nobody signs in, and otherwise the caller's own while they hold what it needs. */
function subscribing(p: Principal, config: Config): string | null {
  if (config.auth.mode === "off") return SYSTEM;
  return holds(p, ...SUBSCRIBES) ? p.subject : null;
}

/** A door the caller's grants do not open: 403 no_grant, naming the grants it needs. */
function noGrant(res: ServerResponse, needs: Grant[], message: string): void {
  json(res, 403, { error: { code: "no_grant", message, needs } });
}

/** A subscription door called by an app or a key: a subscription is a person's. */
function notAPerson(res: ServerResponse): void {
  json(res, 403, { error: { code: "not_a_person", message: "a subscription is a person's" } });
}

function heldError(res: ServerResponse, e: unknown): void {
  if (e instanceof HeldRefused)
    json(res, e.status, { error: { code: "backend", message: e.message, models: e.models } });
  else
    json(res, 400, { error: { code: "bad_request", message: e instanceof Error ? e.message : String(e) } });
}

/**
 * A backend just held, made ready where Kvasir serves (§8.5, §8.6): its
 * admitted set read from the records for the runtime it reports now; then a
 * local one warmed until its first token and, where a model has no passing
 * record, run through admission. What happens is said on the log.
 */
export async function ready(
  k: Kvasir,
  backend: Backend,
  say: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  if (backend.config.locality === "remote") return;
  await k.admissions.loadOne(backend, (b) => probeRuntime(b));
  // a model server's models are admitted one by one as they are ticked, and never warmed: asking a cold one
  // would load it on the server (record 47)
  if (backend.config.server) return;
  // a card's model is warmed by its card, and admitted where the gate holds, once it is loaded
  const on = k.cards.of(backend);
  if (on && (!k.backends.gate || on.card.status(on.member.id) !== "loaded")) return;
  await backend.warmup();
  if (backend.health.warming) void backend.keepWarm(undefined, (line) => say(`  ${line}`));
  if (backend.config.models.every((m) => backend.admitted.has(m.id))) return;
  try {
    for (const r of await k.admit(backend.config.id)) {
      say(`  ${r.backend}/${r.model}: ${r.passed ? "admitted" : "refused by admission"}`);
    }
  } catch (e) {
    say(`  ${backend.config.id}: admission did not run: ${e instanceof Error ? e.message : e}`);
  }
}

export function listen(k: Kvasir, bind: string, server: Server = k.server): Promise<string> {
  const [host, port] = bind.includes(":")
    ? [bind.slice(0, bind.lastIndexOf(":")), Number(bind.slice(bind.lastIndexOf(":") + 1))]
    : ["127.0.0.1", Number(bind)];
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? `http://${a.address}:${a.port}` : "");
    });
  });
}

/** The public doors alone, on their own listener (record 47): the one the edge routes to. */
export function listenPublic(k: Kvasir, bind: string): Promise<string> {
  return listen(k, bind, k.publicServer);
}
