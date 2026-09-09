// SPDX-License-Identifier: AGPL-3.0-only
// Identity (§8.8): the engine's three modes with the same flags, the same
// ladder and the same trust list, verified against the shared vectors of
// contracts/suite/v1. A caller with no mapped role is refused everywhere.
// A minted key is the fourth way in: its principal, its purposes and its
// class come from the row, never from the call.

import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { JWTPayload } from "jose";
import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { KeyRow, Keys } from "./keys.js";

export const LADDER = ["reader", "reviewer", "operator", "admin"] as const;
export type Role = (typeof LADDER)[number];

export interface Trust {
  issuer: string;
  audience: string;
  jwks: string;
}

export interface AuthConfig {
  mode: "off" | "token" | "oidc";
  /** token mode: TOKEN -> "principal@node:role,role". */
  tokens?: Record<string, string>;
  trust?: Trust[];
  groupsClaim?: string;
  /** group -> role. */
  roles?: Record<string, Role>;
}

export interface Principal {
  subject: string;
  roles: Role[];
  kind: "person" | "machine" | "key";
  display?: string;
  key?: KeyRow;
}

export class Refused extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

/** The ladder: a role implies the ones below it. */
export function expand(roles: Role[]): Role[] {
  let top = -1;
  for (const r of roles) top = Math.max(top, LADDER.indexOf(r));
  return top < 0 ? [] : LADDER.slice(0, top + 1);
}

export function holds(p: Principal, role: Role): boolean {
  return p.roles.includes(role);
}

type Verifier = {
  trust: Trust;
  keys: ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;
};

export class Auth {
  private readonly verifiers: Verifier[] = [];
  constructor(
    readonly config: AuthConfig,
    private readonly keys: Keys | null,
  ) {
    for (const t of config.trust ?? []) {
      const keys = t.jwks.startsWith("http")
        ? createRemoteJWKSet(new URL(t.jwks), { cooldownDuration: 60_000 })
        : createLocalJWKSet(JSON.parse(readFileSync(t.jwks, "utf8")));
      this.verifiers.push({ trust: t, keys });
    }
    if (config.mode === "oidc" && this.verifiers.length === 0)
      throw new Error("--auth oidc needs a trust list");
    if (config.mode === "token" && !config.tokens) throw new Error("--auth token needs tokens");
  }

  /** The caller of a request, or a refusal that names why. */
  async principal(req: IncomingMessage): Promise<Principal> {
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    // a minted key, in any mode
    if (bearer.startsWith("kvs_")) {
      const row = this.keys?.verify(bearer);
      if (!row) throw new Refused(401, "this key is not one Kvasir minted, or it is spent");
      return { subject: row.principal, roles: ["reader"], kind: "key", key: row };
    }
    switch (this.config.mode) {
      case "off":
        return { subject: "operator", roles: [...LADDER], kind: "person" };
      case "token": {
        const named = bearer ? this.config.tokens?.[bearer] : undefined;
        if (!named) throw new Refused(401, "a bearer token this gateway knows");
        const [principal, list] = named.split(":");
        const roles = expand(
          (list ?? "").split(",").filter((r): r is Role => (LADDER as readonly string[]).includes(r)),
        );
        if (roles.length === 0)
          throw new Refused(
            403,
            `${principal} holds no role: an installer binds roles before a caller streams`,
          );
        return { subject: principal, roles, kind: principal.includes("@") ? "person" : "machine" };
      }
      case "oidc":
        return this.verify(bearer);
    }
  }

  private async verify(token: string): Promise<Principal> {
    if (!token) throw new Refused(401, "a bearer token of a trusted issuer");
    let header: ReturnType<typeof decodeProtectedHeader>;
    let claims: JWTPayload;
    try {
      header = decodeProtectedHeader(token);
      claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    } catch {
      throw new Refused(401, "the token is not a JWT");
    }
    const entry = this.verifiers.find(
      (v) => v.trust.issuer.replace(/\/+$/u, "") === String(claims.iss ?? "").replace(/\/+$/u, ""),
    );
    if (!entry) throw new Refused(401, "the token's issuer is not on the trust list");
    let payload: JWTPayload;
    try {
      const { payload: p } = await jwtVerify(token, entry.keys, {
        issuer: [entry.trust.issuer, entry.trust.issuer.replace(/\/+$/u, "")],
        audience: entry.trust.audience,
        algorithms: header.alg ? [header.alg] : undefined,
      });
      payload = p;
    } catch (e) {
      throw new Refused(
        401,
        `the token was refused: ${e instanceof Error ? e.message : "verification failed"}`,
      );
    }
    const host = new URL(entry.trust.issuer).host;
    const subject = `${payload.sub}@${host}`;
    const groups = (payload[this.config.groupsClaim ?? "groups"] as unknown) ?? [];
    const named: Role[] = Array.isArray(groups)
      ? groups
          .filter((g): g is string => typeof g === "string")
          .map((g) => this.config.roles?.[g])
          .filter((r): r is Role => r !== undefined)
      : [];
    const roles = expand(named);
    if (roles.length === 0)
      throw new Refused(403, `${subject} holds no role: an installer binds roles before a caller streams`);
    const display =
      typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : typeof payload.name === "string"
          ? payload.name
          : undefined;
    const act = payload.act as { sub?: string } | undefined;
    return { subject, roles, kind: act?.sub ? "machine" : "person", display };
  }
}
