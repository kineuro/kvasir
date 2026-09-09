// SPDX-License-Identifier: AGPL-3.0-only
// The one process: the router, the auth of this slice, the catalog door.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Backends } from "./backends.js";
import type { Config } from "./config.js";
import { chatCompletions, json, piMessages } from "./doors.js";

export const VERSION = "1.0.0-alpha.0";

export interface Kvasir {
  config: Config;
  backends: Backends;
  server: Server;
  /** Where it listens once started. */
  address: () => string;
  close: () => Promise<void>;
}

/** The caller's principal under this slice's auth: `off`, or a static token map. Identity proper is C2. */
function principal(config: Config, req: IncomingMessage): string | null {
  if (config.auth.mode === "off") return "operator";
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return (token && config.auth.tokens?.[token]) || null;
}

export function build(config: Config): Kvasir {
  const backends = new Backends(config.backends);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://kvasir");
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    if (path === "/healthz" && req.method === "GET") {
      const warming = backends.list.some((b) => b.health.warming);
      json(res, 200, {
        ok: true,
        warming,
        backends: backends.list.map((b) => ({ id: b.config.id, ...b.health })),
      });
      return;
    }
    const who = principal(config, req);
    if (!who) {
      json(res, 401, { error: { code: "unauthenticated", message: "a bearer token this gateway knows" } });
      return;
    }
    try {
      if (path === "/v1/config" && req.method === "GET") {
        json(res, 200, { ...backends.catalog(config.origin), kvasir: { version: VERSION } });
      } else if (path === "/v1/models" && req.method === "GET") {
        const models = backends
          .catalog(config.origin)
          .models.map((m) => ({ id: m.id, object: "model", owned_by: m.backend }));
        json(res, 200, { object: "list", data: models });
      } else if (path === "/v1/messages" && req.method === "POST") {
        await piMessages(req, res, backends);
      } else if (path === "/v1/chat/completions" && req.method === "POST") {
        await chatCompletions(req, res, backends);
      } else {
        json(res, 404, {
          error: { code: "no_such_door", message: `${req.method} ${path} is not a door Kvasir has` },
        });
      }
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
    server,
    address: () => {
      const a = server.address();
      return typeof a === "object" && a ? `http://${a.address}:${a.port}` : "";
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
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
