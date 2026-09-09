// SPDX-License-Identifier: AGPL-3.0-only
// The one process: the router, identity, the keys, the ledger, the metrics.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Auth, holds, type Principal, Refused } from "./auth.js";
import { Backends } from "./backends.js";
import { type Config, pepper } from "./config.js";
import { chatCompletions, json, piMessages, readBody } from "./doors.js";
import { CLASSES, type ContentClass, Keys } from "./keys.js";
import { Ledger } from "./ledger.js";
import { Store } from "./store.js";

export const VERSION = "1.0.0-alpha.0";

export interface Kvasir {
  config: Config;
  backends: Backends;
  store: Store;
  keys: Keys;
  ledger: Ledger;
  auth: Auth;
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
      await route(req, res, path, url, who, { config, backends, keys, ledger });
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
  k: { config: Config; backends: Backends; keys: Keys; ledger: Ledger },
): Promise<void> {
  const { config, backends, keys, ledger } = k;
  if (path === "/v1/config" && req.method === "GET") {
    json(res, 200, { ...backends.catalog(config.origin), kvasir: { version: VERSION } });
  } else if (path === "/v1/models" && req.method === "GET") {
    const models = backends
      .catalog(config.origin)
      .models.map((m) => ({ id: m.id, object: "model", owned_by: m.backend }));
    json(res, 200, { object: "list", data: models });
  } else if (path === "/v1/messages" && req.method === "POST") {
    await piMessages(req, res, backends, who, ledger);
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
