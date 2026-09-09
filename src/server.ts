// SPDX-License-Identifier: AGPL-3.0-only
// The one process: the router, identity, the keys, the ledger, the metrics.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Auth, holds, type Principal, Refused } from "./auth.js";
import { Backends } from "./backends.js";
import { type Config, pepper } from "./config.js";
import { Credentials, sealKey } from "./credentials.js";
import { chatCompletions, json, piMessages, readBody } from "./doors.js";
import { CLASSES, type ContentClass, Keys } from "./keys.js";
import { Ledger } from "./ledger.js";
import { type Need, Policy, Refused as PolicyRefused } from "./policy.js";
import { Store } from "./store.js";

export const VERSION = "1.0.0-alpha.0";

export interface Kvasir {
  config: Config;
  backends: Backends;
  store: Store;
  keys: Keys;
  ledger: Ledger;
  auth: Auth;
  credentials: Credentials;
  policy: Policy;
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
  const credentials = new Credentials(store, sealKey(config.sealKeyFile));
  for (const b of backends.list) {
    if (b.config.provider) {
      const provider = b.config.provider;
      b.credential = () => credentials.open(provider);
    }
  }
  const policy = new Policy(store, config.purposes, backends);
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
      await route(req, res, path, url, who, { config, backends, keys, ledger, credentials, policy });
    } catch (e) {
      if (!res.headersSent)
        json(res, 500, { error: { code: "internal", message: "Kvasir could not answer" } });
      else res.end();
      console.error("kvasir:", e instanceof Error ? e.message : e);
    }
  });
  return {
    config,
    backends,
    store,
    keys,
    ledger,
    auth,
    credentials,
    policy,
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
    policy: Policy;
  },
): Promise<void> {
  const { config, backends, keys, ledger, credentials, policy } = k;
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
    await chatCompletions(req, res, backends);
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
  } else if (path === "/v1/ledger" && req.method === "GET") {
    const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200) || 200);
    json(res, 200, { rows: ledger.rows(holds(who, "admin") ? null : who.subject, limit) });
  } else {
    json(res, 404, {
      error: { code: "no_such_door", message: `${req.method} ${path} is not a door Kvasir has` },
    });
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
