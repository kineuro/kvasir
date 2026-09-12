// SPDX-License-Identifier: AGPL-3.0-only
// The one process: the router, identity, the keys, the ledger, the metrics.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Admissions } from "./admission-records.js";
import { Auth, holds, type Principal, Refused } from "./auth.js";
import { Backends } from "./backends.js";
import { type Config, pepper } from "./config.js";
import { Credentials, openSeal } from "./credentials.js";
import { chatCompletions, json, piMessages, readBody } from "./doors.js";
import { CLASSES, type ContentClass, Keys } from "./keys.js";
import { Ledger } from "./ledger.js";
import { Lifecycle, LifecycleRefused, parseSource } from "./lifecycle.js";
import { Personal } from "./personal.js";
import { type Need, Policy, Refused as PolicyRefused } from "./policy.js";
import { Store } from "./store.js";
import { measureOverhead, runSuite } from "./suite.js";

export const VERSION = "1.0.0-alpha.2";

export interface Kvasir {
  config: Config;
  backends: Backends;
  store: Store;
  keys: Keys;
  ledger: Ledger;
  auth: Auth;
  credentials: Credentials;
  personal: Personal;
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

export function build(config: Config): Kvasir {
  const backends = new Backends(config.backends, config.admission);
  const store = new Store(config.store);
  const keys = new Keys(store, pepper(config.pepperFile));
  const ledger = new Ledger(store);
  const auth = new Auth(config.auth, keys);
  const seal = openSeal(config.sealKeyFile, store, (line) => console.error(`kvasir: ${line}`));
  const credentials = new Credentials(store, seal);
  const personal = new Personal(store, seal, config.oauth, config.origin);
  for (const b of backends.list) {
    if (b.config.provider) {
      const provider = b.config.provider;
      // the person's own credential first (a brought key or a live grant), else the organisation's (§8.4)
      b.credential = async (subject) =>
        (subject ? await personal.open(subject, provider) : null) ?? credentials.open(provider);
    }
  }
  const policy = new Policy(store, config.purposes, backends);
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
    // the OAuth callback (C5) arrives from the provider through the person's browser with no bearer: the state is its identity
    if (path === "/v1/personal/oauth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state)
        return json(res, 400, { error: { code: "bad_request", message: "code and state" } });
      try {
        const done = await personal.callback(code, state, null);
        res.writeHead(303, {
          location: `${done.return_to}${done.return_to.includes("#") ? "" : "#settings"}`,
        });
        res.end();
      } catch (e) {
        json(res, 400, { error: { code: "oauth", message: e instanceof Error ? e.message : String(e) } });
      }
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
        personal,
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
    personal,
    policy,
    admissions,
    lifecycle,
    admit,
    server,
    address: () => {
      const a = server.address();
      return typeof a === "object" && a ? `http://${a.address}:${a.port}` : "";
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
      }),
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
    personal: Personal;
    policy: Policy;
    admissions: Admissions;
    lifecycle: Lifecycle;
    admit: Kvasir["admit"];
  },
): Promise<void> {
  const { config, backends, keys, ledger, credentials, personal, policy, admissions, lifecycle, admit } = k;
  if (path === "/v1/config" && req.method === "GET") {
    json(res, 200, { ...backends.catalog(config.origin), kvasir: { version: VERSION } });
  } else if (path === "/v1/models" && req.method === "GET") {
    const models = backends
      .catalog(config.origin)
      .models.map((m) => ({ id: m.id, object: "model", owned_by: m.backend }));
    json(res, 200, { object: "list", data: models });
  } else if (path === "/v1/messages" && req.method === "POST") {
    await piMessages(req, res, backends, who, ledger, policy);
  } else if (path === "/v1/chat/completions" && req.method === "POST") {
    await chatCompletions(req, res, backends, who, ledger, policy);
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
    json(res, 200, {
      backends: backends.list.map((b) => ({
        id: b.config.id,
        kind: b.config.kind,
        locality: b.config.locality,
        provider: b.config.provider ?? null,
        credential: b.config.provider ? credentials.has(b.config.provider) : null,
        models: b.config.models.map((m) => m.id),
        health: { ...b.health, queued: b.admission.queued },
      })),
    });
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
  } else if (path === "/v1/personal" && req.method === "GET") {
    // C5: what this person holds per provider, and whether a personal source is offered or absent by policy
    json(res, 200, {
      subject: who.subject,
      redirect: personal.redirect(),
      providers: personal.status(who.subject),
    });
  } else if (path.startsWith("/v1/personal/keys/") && (req.method === "PUT" || req.method === "DELETE")) {
    if (who.kind !== "person")
      return json(res, 403, {
        error: {
          code: "no_role",
          message: "a brought key is a person's; a machine or a minted key holds none",
        },
      });
    const provider = decodeURIComponent(path.slice("/v1/personal/keys/".length));
    if (req.method === "DELETE") {
      res.writeHead(personal.deleteKey(who.subject, provider) ? 204 : 404);
      res.end();
      return;
    }
    const body = JSON.parse(await readBody(req));
    if (typeof body.secret !== "string" || body.secret.length < 8)
      return json(res, 400, { error: { code: "bad_request", message: "secret: the provider's key" } });
    personal.putKey(who.subject, provider, body.secret);
    json(res, 200, { provider, stored: true, shown: "never" });
  } else if (path.startsWith("/v1/personal/oauth/") && path.endsWith("/start") && req.method === "POST") {
    if (who.kind !== "person")
      return json(res, 403, { error: { code: "no_role", message: "an OAuth grant is a person's" } });
    const provider = decodeURIComponent(path.slice("/v1/personal/oauth/".length, -"/start".length));
    const body = JSON.parse(await readBody(req));
    try {
      json(
        res,
        200,
        personal.start(who.subject, provider, String(body.session ?? ""), String(body.return_to ?? "")),
      );
    } catch (e) {
      json(res, 400, { error: { code: "oauth", message: e instanceof Error ? e.message : String(e) } });
    }
  } else if (path.startsWith("/v1/personal/oauth/") && req.method === "DELETE") {
    if (who.kind !== "person")
      return json(res, 403, { error: { code: "no_role", message: "an OAuth grant is a person's" } });
    const provider = decodeURIComponent(path.slice("/v1/personal/oauth/".length));
    res.writeHead(personal.revoke(who.subject, provider) ? 204 : 404);
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
      promoted: backends.list.map((b) => ({ backend: b.config.id, model: lifecycle.promoted(b.config.id) })),
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

export function listen(k: Kvasir, bind: string): Promise<string> {
  const [host, port] = bind.includes(":")
    ? [bind.slice(0, bind.lastIndexOf(":")), Number(bind.slice(bind.lastIndexOf(":") + 1))]
    : ["127.0.0.1", Number(bind)];
  return new Promise((resolve, reject) => {
    k.server.once("error", reject);
    k.server.listen(port, host, () => resolve(k.address()));
  });
}
