// SPDX-License-Identifier: AGPL-3.0-only
// Identity (§8.8): the engine's three modes with the same flags and the same
// trust list, verified against the shared vectors of contracts/suite/v1; and
// what a caller may open, as grants (record 25), verified against the grants
// vectors of contracts/suite/v2. A caller left with no grant is refused
// everywhere. A minted key is the fourth way in: its principal, its purposes
// and its class come from the row, never from the call.

import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { JWTPayload } from "jose";
import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { KeyRow, Keys } from "./keys.js";

/** Every grant: a page and how far a caller goes there, see or work, which includes see; the assistant has use. */
export const GRANTS = [
  "assistant-settings:see",
  "assistant-settings:work",
  "assistant:use",
  "audit:see",
  "data:see",
  "data:work",
  "database:see",
  "database:work",
  "identity:see",
  "identity:work",
  "install:see",
  "install:work",
  "kvasir:see",
  "kvasir:work",
  "pipelines:see",
  "pipelines:work",
  "places:see",
  "places:work",
  "query:see",
  "query:work",
  "release:see",
  "release:work",
  "review:see",
  "review:work",
] as const;
export type Grant = (typeof GRANTS)[number];

/** How much of a record a caller sees, lowest first. Kvasir reads no record: it carries detail as it was given. */
export const DETAILS = ["plain", "quasi", "sensitive"] as const;
export type Detail = (typeof DETAILS)[number];

export interface Access {
  /** Sorted, each once. */
  grants: Grant[];
  detail: Detail;
}

/** The names that stand for a set wherever one is still met: the ladder's four steps, and assist. */
export const SETS: Readonly<Record<"reader" | "reviewer" | "operator" | "admin" | "assist", Access>> = {
  reader: { grants: ["data:see", "query:see", "query:work"], detail: "plain" },
  reviewer: {
    grants: ["data:see", "pipelines:see", "query:see", "query:work", "review:see", "review:work"],
    detail: "quasi",
  },
  operator: {
    grants: [
      "assistant-settings:see",
      "data:see",
      "data:work",
      "install:see",
      "kvasir:see",
      "pipelines:see",
      "pipelines:work",
      "places:see",
      "places:work",
      "query:see",
      "query:work",
      "release:see",
      "release:work",
      "review:see",
      "review:work",
    ],
    detail: "sensitive",
  },
  admin: { grants: GRANTS.filter((g) => g !== "assistant:use"), detail: "sensitive" },
  assist: { grants: ["assistant:use"], detail: "plain" },
};

/** What off mode holds. */
export const EVERYTHING: Access = { grants: [...GRANTS], detail: "sensitive" };

const VOCABULARY: ReadonlySet<string> = new Set(GRANTS);

/** A grant as it is, with its see where it is work; nothing for a string outside the vocabulary. */
function grantOf(name: string): Grant[] {
  if (!VOCABULARY.has(name)) return [];
  const see = name.replace(/:work$/u, ":see");
  return see !== name && VOCABULARY.has(see) ? [name as Grant, see as Grant] : [name as Grant];
}

/** A token's `grants` and `detail` claims as they are: a string it does not know is dropped, an unknown detail reads as plain. */
export function claimed(grants: unknown, detail: unknown): Access {
  const list = Array.isArray(grants) ? grants.filter((g): g is string => typeof g === "string") : [];
  return {
    grants: list.flatMap(grantOf),
    detail: DETAILS.includes(detail as Detail) ? (detail as Detail) : "plain",
  };
}

/** What a name bound to a group, or written in a token's role list, gives: a set's name its set, a grant itself, anything else nothing. */
export function standsFor(name: string): Access {
  if (Object.hasOwn(SETS, name)) return SETS[name as keyof typeof SETS];
  return { grants: grantOf(name), detail: "plain" };
}

/** Everything the parts give together: every grant of each, and the highest detail. */
export function union(parts: Access[]): Access {
  const grants = new Set<Grant>();
  let rank = 0;
  for (const p of parts) {
    for (const g of p.grants) grants.add(g);
    rank = Math.max(rank, DETAILS.indexOf(p.detail));
  }
  return { grants: [...grants].sort(), detail: DETAILS[rank] };
}

/** The principal a token's subject names: a subject that already holds @ as it is, any other qualified by its issuer's host. */
export function qualified(issuer: string, sub: string): string {
  return sub.includes("@") ? sub : `${sub}@${new URL(issuer).host}`;
}

export interface Trust {
  issuer: string;
  audience: string;
  jwks: string;
}

export interface AuthConfig {
  mode: "off" | "token" | "oidc";
  /**
   * TOKEN -> "principal@node:name,name": the callers of token mode, and beside a trust list the installer's own.
   * Each name is a grant, or a ladder step or assist, which stands for its set.
   */
  tokens?: Record<string, string>;
  trust?: Trust[];
  groupsClaim?: string;
  /** group -> a grant, or a ladder step or assist, which stands for its set. */
  roles?: Record<string, string>;
}

export interface Principal {
  subject: string;
  /** What the caller may open, sorted; a caller let in holds at least one. */
  grants: Grant[];
  detail: Detail;
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

/** Whether the caller holds every grant named. */
export function holds(p: Principal, ...grants: Grant[]): boolean {
  return grants.every((g) => p.grants.includes(g));
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
    // a minted key, in any mode: it acts by its purposes and its class, and holds the reader's set it always held
    if (bearer.startsWith("kvs_")) {
      const row = this.keys?.verify(bearer);
      if (!row) throw new Refused(401, "this key is not one Kvasir minted, or it is spent");
      return { subject: row.principal, ...SETS.reader, kind: "key", key: row };
    }
    // A token the installer wrote opens token mode, and beside a trust list
    // it stays the installer's own way in: what set the gateway up, such as
    // the command that mints the assistant's key, still reaches the doors of
    // kvasir:work once people sign in through an issuer.
    const named = bearer ? this.config.tokens?.[bearer] : undefined;
    switch (this.config.mode) {
      case "off":
        return { subject: "operator", ...EVERYTHING, kind: "person" };
      case "token":
        if (!named) throw new Refused(401, "a bearer token this gateway knows");
        return admitted(this.named(named));
      case "oidc":
        return admitted(named ? this.named(named) : await this.verify(bearer));
    }
  }

  /**
   * The person an app streams for (record 23): that person's own token, sent
   * beside the app's minted key and verified as the person's own call would be,
   * used only to find whose subscription a stream may use. A machine, a key, or
   * a token that does not verify is refused.
   */
  async person(token: string): Promise<Principal> {
    if (this.config.mode === "off") throw new Refused(401, "nobody signs in here");
    const named = this.config.tokens?.[token];
    const p = named ? this.named(named) : this.config.mode === "oidc" ? await this.verify(token) : undefined;
    if (p?.kind !== "person")
      throw new Refused(401, "the person's token is not one of a person this gateway trusts");
    return admitted(p);
  }

  /** The principal a configured token names, "principal@node:name,name"; a grant holds a colon of its own. */
  private named(entry: string): Principal {
    const at = entry.indexOf(":");
    const principal = at < 0 ? entry : entry.slice(0, at);
    const list = at < 0 ? "" : entry.slice(at + 1);
    const access = union(
      list
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .map(standsFor),
    );
    return { subject: principal, ...access, kind: principal.includes("@") ? "person" : "machine" };
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
    const subject = qualified(entry.trust.issuer, String(payload.sub));
    // the grants a token carries as they are, and what its groups are bound to beside them
    const groups = (payload[this.config.groupsClaim ?? "groups"] as unknown) ?? [];
    const bound = Array.isArray(groups)
      ? groups
          .filter((g): g is string => typeof g === "string" && Object.hasOwn(this.config.roles ?? {}, g))
          .map((g) => standsFor(String(this.config.roles?.[g])))
      : [];
    const access = union([claimed(payload.grants, payload.detail), ...bound]);
    const display =
      typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : typeof payload.name === "string"
          ? payload.name
          : undefined;
    const act = payload.act as { sub?: string } | undefined;
    return { subject, ...access, kind: act?.sub ? "machine" : "person", display };
  }
}

/** A caller let in: one holding at least one grant. */
function admitted(p: Principal): Principal {
  if (p.grants.length === 0)
    throw new Refused(403, `${p.subject} holds no grant: grants are given before a caller streams`);
  return p;
}
