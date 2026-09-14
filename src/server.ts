// SPDX-License-Identifier: AGPL-3.0-only
// The one process: the router, identity, the keys, the ledger, the metrics.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { Admissions } from "./admission-records.js";
import { Auth, holds, type Principal, Refused } from "./auth.js";
import { type Backend, Backends } from "./backends.js";
import { chatgptAuth, chatgptBackend, chatgptModels } from "./chatgpt.js";
import { type Config, pepper } from "./config.js";
import { Credentials, openSeal } from "./credentials.js";
import { chatCompletions, json, piMessages, readBody } from "./doors.js";
import { described, Held, HeldRefused, tryBackend } from "./held.js";
import { CLASSES, type ContentClass, Keys } from "./keys.js";
import { Ledger } from "./ledger.js";
import { Lifecycle, LifecycleRefused, parseSource } from "./lifecycle.js";
import { Local, type LocalOptions, LocalRefused } from "./local.js";
import { type Need, Policy, Refused as PolicyRefused } from "./policy.js";
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
  ledger: Ledger;
  auth: Auth;
  credentials: Credentials;
  /** The models Kvasir holds: tried, added, served and removed (record 23). */
  held: Held;
  /** Each person's own ChatGPT subscription, or the install's where nobody signs in (record 23). */
  subscriptions: Subscriptions;
  /** Local models: downloaded by Kvasir into a location an admin can change, and served by the admin's own model server (record 23). */
  local: Local;
  policy: Policy;
  admissions: Admissions;
  /** The model lifecycle (Wave 5 §9.5): registered, admitted, promoted, retired. */
  lifecycle: Lifecycle;
  /** The suite over one model, recorded, and the admitted set refreshed (§8.6). */
  admit: (
    backendId: string,
    modelId?: string,
    opts?: { overhead?: boolean; log?: (line: string) => void },
  ) => Promise<import("./suite.js").AdmissionRecord[]>;
  server: Server;
  address: () => string;
  close: () => Promise<void>;
}

export function build(
  config: Config,
  options: { subscriptionAuth?: () => SubscriptionAuth; local?: LocalOptions } = {},
): Kvasir {
  const store = new Store(config.store);
  const backends = new Backends(config.admission);
  const keys = new Keys(store, pepper(config.pepperFile));
  const ledger = new Ledger(store);
  const auth = new Auth(config.auth, keys);
  const seal = openSeal(config.sealKeyFile);
  const credentials = new Credentials(store, seal);
  const policy = new Policy(store, config.purposes, backends);
  // the models this database holds, served from the start; a purpose mapped to one let go returns to its default
  const held = new Held(store, backends, credentials, (id) => policy.forget(id));
  held.sync();
  // local models download into `models` beside the database until an admin sets a location
  const local = new Local(
    store,
    credentials,
    config.local.endpoint,
    resolve(dirname(config.store), "models"),
    options.local,
  );
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
      const rec = await runSuite(backend, entry, { log: opts.log });
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
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://kvasir");
    const path = url.pathname.replace(/\/+$/u, "") || "/";
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
          error: { code: e.status === 401 ? "unauthenticated" : "no_role", message: e.message },
        });
        return;
      }
      throw e;
    }
    try {
      await route(req, res, path, url, who, {
        config,
        backends,
        keys,
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
      });
    } catch (e) {
      if (!res.headersSent)
        json(res, 500, { error: { code: "internal", message: "Kvasir could not answer" } });
      else res.end();
      console.error("kvasir:", e instanceof Error ? e.message : e);
    }
  });
  const k: Kvasir = {
    config,
    backends,
    store,
    keys,
    ledger,
    auth,
    credentials,
    held,
    subscriptions,
    local,
    policy,
    admissions,
    lifecycle,
    admit,
    server,
    address: () => {
      const a = server.address();
      return typeof a === "object" && a ? `http://${a.address}:${a.port}` : "";
    },
    close: async () => {
      // a warm-up still being tried, and the following of the database, end with the server; a download
      // stops with what it has, to carry on when Kvasir starts again
      held.unwatch();
      for (const b of backends.list) b.stop();
      await local.stop();
      await new Promise<void>((done) => server.close(() => done()));
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
  const r = await fetch(`${origin}/v1/messages`, {
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
  },
): Promise<void> {
  const {
    config,
    backends,
    keys,
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
  const { admit } = k;
  if (path === "/v1/config" && req.method === "GET") {
    json(res, 200, { ...backends.catalog(config.origin), kvasir: { version: VERSION } });
  } else if (path === "/v1/models" && req.method === "GET") {
    const models = backends
      .catalog(config.origin)
      .models.map((m) => ({ id: m.id, object: "model", owned_by: m.backend }));
    json(res, 200, { object: "list", data: models });
  } else if (path === "/v1/messages" && req.method === "POST") {
    const subject = await streamSubject(req, res, who, auth, config);
    if (subject !== null) await piMessages(req, res, backends, who, ledger, policy, subject);
  } else if (path === "/v1/chat/completions" && req.method === "POST") {
    const subject = await streamSubject(req, res, who, auth, config);
    if (subject !== null) await chatCompletions(req, res, backends, who, ledger, policy, subject);
  } else if (path === "/v1/keys" && req.method === "GET") {
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "the keys are an admin's" } });
    json(res, 200, { keys: keys.list() });
  } else if (path === "/v1/keys" && req.method === "POST") {
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "minting is an admin's" } });
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
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "revoking is an admin's" } });
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
        subject: config.auth.mode === "off" ? SYSTEM : who.subject,
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
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "the policy table is an admin's" } });
    const id = path.slice("/v1/purposes/".length, -"/policy".length);
    const body = JSON.parse(await readBody(req));
    try {
      const row = policy.set(
        id,
        String(body.backend ?? ""),
        who.subject,
        typeof body.acknowledgement === "string" ? body.acknowledgement : null,
      );
      json(res, 200, row);
    } catch (e) {
      if (e instanceof PolicyRefused)
        return json(res, e.status, { error: { code: "refused", message: e.message, refusals: e.refusals } });
      throw e;
    }
  } else if (path === "/v1/backends" && req.method === "GET") {
    held.sync();
    const admin = holds(who, "admin");
    json(res, 200, {
      backends: backends.list.map((b) => ({
        id: b.config.id,
        kind: b.config.kind,
        locality: b.config.locality,
        // where a backend is, and who added it, is an admin's to see
        ...(admin ? { base_url: b.config.baseUrl, ...held.addedOf(b.config.id) } : {}),
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
        })),
        builtin: b.config.builtin === true,
        concurrency: b.config.concurrency,
        health: { ...b.health, queued: b.admission.queued },
      })),
    });
  } else if (path === "/v1/backends/test" && req.method === "POST") {
    // record 23: each model asked one short question, and nothing kept; with none named, only what the server lists
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "trying a backend is an admin's" } });
    try {
      const d = described(JSON.parse((await readBody(req)) || "{}"), { modelsOptional: true });
      json(res, 200, await tryBackend(d.config, d.key));
    } catch (e) {
      heldError(res, e);
    }
  } else if (path === "/v1/backends" && req.method === "POST") {
    // record 23: a backend is held only once every one of its models answered
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "adding a backend is an admin's" } });
    try {
      const { backend, tried } = await held.add(JSON.parse((await readBody(req)) || "{}"), who.subject);
      json(res, 201, {
        backend: {
          id: backend.config.id,
          locality: backend.config.locality,
          models: backend.config.models.map((m) => m.id),
        },
        tried,
      });
    } catch (e) {
      heldError(res, e);
    }
  } else if (path.startsWith("/v1/backends/") && req.method === "DELETE") {
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "removing a backend is an admin's" } });
    const id = decodeURIComponent(path.slice("/v1/backends/".length));
    if (held.remove(id)) {
      res.writeHead(204);
      res.end();
    } else json(res, 404, { error: { code: "no_such_backend", message: `no backend ${id}` } });
  } else if (path.startsWith("/v1/credentials/") && (req.method === "PUT" || req.method === "DELETE")) {
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "the credentials are an admin's" } });
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
    // record 23: a person's own subscription, or the install's where nobody signs in
    const whose = subscriberOf(who, config);
    if (!whose)
      return json(res, 403, { error: { code: "no_role", message: "a subscription is a person's" } });
    json(res, 200, { subscriptions: [subscriptions.status(whose.subject, whose.for)] });
  } else if (path === `/v1/subscriptions/${CHATGPT}/sign-in` && req.method === "POST") {
    const whose = subscriberOf(who, config);
    if (!whose)
      return json(res, 403, { error: { code: "no_role", message: "a subscription is a person's" } });
    try {
      const waiting = await subscriptions.signIn(whose.subject);
      json(res, 200, {
        state: "waiting",
        user_code: waiting.userCode,
        verification_uri: waiting.verificationUri,
        expires_at: waiting.expiresAt,
      });
    } catch (e) {
      json(res, 502, {
        error: {
          code: "sign_in",
          message: `ChatGPT did not start the sign-in: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
    }
  } else if (path === `/v1/subscriptions/${CHATGPT}` && req.method === "PUT") {
    const whose = subscriberOf(who, config);
    if (!whose)
      return json(res, 403, { error: { code: "no_role", message: "a subscription is a person's" } });
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      subscriptions.choose(whose.subject, String(body.model ?? ""));
      json(res, 200, subscriptions.status(whose.subject, whose.for));
    } catch (e) {
      json(res, 400, { error: { code: "bad_request", message: e instanceof Error ? e.message : String(e) } });
    }
  } else if (path === `/v1/subscriptions/${CHATGPT}` && req.method === "DELETE") {
    const whose = subscriberOf(who, config);
    if (!whose)
      return json(res, 403, { error: { code: "no_role", message: "a subscription is a person's" } });
    res.writeHead(subscriptions.signOut(whose.subject) ? 204 : 404);
    res.end();
  } else if (path === "/v1/admission" && req.method === "GET") {
    json(res, 200, {
      records: admissions.list(Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100)),
    });
  } else if (path === "/v1/admission/run" && req.method === "POST") {
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "admission is an admin's" } });
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
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "the lifecycle is an admin's" } });
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
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "the lifecycle is an admin's" } });
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
    json(res, 200, { rows: ledger.rows(holds(who, "admin") ? null : who.subject, limit) });
  } else if (path === "/v1/local" || path.startsWith("/v1/local/")) {
    // record 23: local models, downloaded by Kvasir and served by the admin's own model server
    if (!holds(who, "admin"))
      return json(res, 403, { error: { code: "no_role", message: "local models are an admin's" } });
    await localDoor(req, res, path, who, local);
  } else {
    json(res, 404, {
      error: { code: "no_such_door", message: `${req.method} ${path} is not a door Kvasir has` },
    });
  }
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
 * Hugging Face token set and cleared, never shown. Every one is an admin's.
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
  const model = /^\/v1\/local\/models\/(\d+)(\/pause|\/resume)?$/u.exec(path);
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
    else if (path === "/v1/local/token" && req.method === "PUT") {
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
 * streamed as the app.
 */
async function streamSubject(
  req: IncomingMessage,
  res: ServerResponse,
  who: Principal,
  auth: Auth,
  config: Config,
): Promise<string | null> {
  if (config.auth.mode === "off") return SYSTEM;
  const token = String(req.headers["x-kvasir-person"] ?? "").trim();
  if (!token || who.kind === "person") return who.subject;
  try {
    return (await auth.person(token)).subject;
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

export function listen(k: Kvasir, bind: string): Promise<string> {
  const [host, port] = bind.includes(":")
    ? [bind.slice(0, bind.lastIndexOf(":")), Number(bind.slice(bind.lastIndexOf(":") + 1))]
    : ["127.0.0.1", Number(bind)];
  return new Promise((resolve, reject) => {
    k.server.once("error", reject);
    k.server.listen(port, host, () => resolve(k.address()));
  });
}
