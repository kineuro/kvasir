// SPDX-License-Identifier: AGPL-3.0-only
// Brought keys and OAuth grants (§8.4, C5): a person's own provider key,
// encrypted like the organisation's with the person's subject bound in as
// associated data; an OAuth grant with access and refresh, the refresh
// rotated on every use and both deleted on revoke, the refresh serialised
// per person and provider through a lock, PKCE, a state bound to the
// session, and one fixed redirect on Kvasir's own origin. The personal
// subscription source is offered for the provider whose terms permit it and
// shown as absent by policy for the one whose terms forbid it, with the
// sentence and the date. The credential path is keyed on the immutable
// subject, never a username.

import { createHash, randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Store } from "./store.js";

export const PERSONAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS brought_key (
     subject TEXT NOT NULL,
     provider TEXT NOT NULL,
     nonce BLOB NOT NULL,
     sealed BLOB NOT NULL,
     created_at INTEGER NOT NULL,
     rotated_at INTEGER,
     PRIMARY KEY (subject, provider)
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_grant (
     subject TEXT NOT NULL,
     provider TEXT NOT NULL,
     nonce BLOB NOT NULL,
     sealed BLOB NOT NULL,
     expires_at INTEGER,
     created_at INTEGER NOT NULL,
     refreshed_at INTEGER,
     PRIMARY KEY (subject, provider)
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_state (
     state TEXT PRIMARY KEY,
     subject TEXT NOT NULL,
     provider TEXT NOT NULL,
     session TEXT NOT NULL,
     verifier TEXT NOT NULL,
     return_to TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

/** An OAuth provider Kvasir may hold a grant for: a public client with PKCE, no secret anywhere. */
export interface OAuthProvider {
  /** The provider name the backends and the credential store use. */
  provider: string;
  authorize: string;
  token: string;
  clientId: string;
  scopes: string[];
  /** Whether a person may bring their own subscription through this provider, or why not. */
  personal: "offered" | "absent_by_policy";
  policy?: { sentence: string; date: string };
}

/**
 * The two providers the wave names (§8.4): the personal source is offered for
 * the one whose terms permit it and absent by policy for the one whose terms
 * as of 20 February 2026 forbid it. An operator's configuration may replace
 * either row by name; the sentence and the date stay on screen for the
 * forbidden one.
 */
export const DEFAULT_OAUTH: OAuthProvider[] = [
  {
    provider: "openai",
    authorize: "https://auth.openai.com/oauth/authorize",
    token: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    scopes: ["openid", "profile", "email", "offline_access"],
    personal: "offered",
  },
  {
    provider: "anthropic",
    authorize: "https://claude.ai/oauth/authorize",
    token: "https://console.anthropic.com/v1/oauth/token",
    clientId: "",
    scopes: [],
    personal: "absent_by_policy",
    policy: {
      sentence:
        "Anthropic's consumer terms do not permit a Claude subscription to be used through a third-party tool such as this one; the organisation's key is the only source for this provider.",
      date: "2026-02-20",
    },
  },
];

export const STATE_TTL_MS = 10 * 60_000;
const EARLY_MS = 60_000;

export interface PersonalStatus {
  provider: string;
  personal: "offered" | "absent_by_policy";
  policy?: { sentence: string; date: string };
  brought_key: { created_at: number; rotated_at: number | null } | null;
  oauth: { created_at: number; refreshed_at: number | null; expires_at: number | null } | null;
}

/** A refresh in flight per (subject, provider): the lock of §8.4, in this process over the one database. */
class Locks {
  private readonly held = new Map<string, Promise<unknown>>();
  async run<T>(key: string, f: () => Promise<T>): Promise<T> {
    const before = this.held.get(key) ?? Promise.resolve();
    const mine = before.then(f, f);
    this.held.set(
      key,
      mine.catch(() => undefined),
    );
    try {
      return await mine;
    } finally {
      if (this.held.get(key) === mine) this.held.delete(key);
    }
  }
}

type Kind = "brought" | "oauth";

export class Personal {
  private readonly locks = new Locks();
  constructor(
    private readonly store: Store,
    private readonly key: Uint8Array,
    readonly providers: OAuthProvider[],
    private readonly origin: string,
    private readonly dial: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    for (const s of PERSONAL_SCHEMA) store.db.exec(s);
  }

  private aad(kind: Kind, subject: string, provider: string): Uint8Array {
    return new TextEncoder().encode(`kvasir:${kind}:${subject}:${provider}`);
  }

  private seal(
    kind: Kind,
    subject: string,
    provider: string,
    plain: string,
  ): { nonce: Buffer; sealed: Buffer } {
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305(
      this.key,
      new Uint8Array(nonce),
      this.aad(kind, subject, provider),
    ).encrypt(new TextEncoder().encode(plain));
    return { nonce, sealed: Buffer.from(sealed) };
  }

  private unseal(
    kind: Kind,
    subject: string,
    provider: string,
    nonce: Uint8Array,
    sealed: Uint8Array,
  ): string {
    return new TextDecoder().decode(
      xchacha20poly1305(this.key, new Uint8Array(nonce), this.aad(kind, subject, provider)).decrypt(
        new Uint8Array(sealed),
      ),
    );
  }

  providerOf(name: string): OAuthProvider | null {
    return this.providers.find((p) => p.provider === name) ?? null;
  }

  /** The fixed redirect: Kvasir's own origin, one path, whatever the provider. */
  redirect(): string {
    return `${this.origin.replace(/\/+$/u, "")}/v1/personal/oauth/callback`;
  }

  /** What a person sees on the settings page: per provider, what they hold and what is offered. */
  status(subject: string): PersonalStatus[] {
    return this.providers.map((p) => {
      const k = this.store.db
        .prepare("SELECT created_at, rotated_at FROM brought_key WHERE subject = ? AND provider = ?")
        .get(subject, p.provider) as { created_at: number; rotated_at: number | null } | undefined;
      const g = this.store.db
        .prepare(
          "SELECT created_at, refreshed_at, expires_at FROM oauth_grant WHERE subject = ? AND provider = ?",
        )
        .get(subject, p.provider) as
        | { created_at: number; refreshed_at: number | null; expires_at: number | null }
        | undefined;
      return {
        provider: p.provider,
        personal: p.personal,
        ...(p.policy ? { policy: p.policy } : {}),
        brought_key: k ?? null,
        oauth: g ?? null,
      };
    });
  }

  /** A brought key: stored or rotated under the subject's own associated data. */
  putKey(subject: string, provider: string, secret: string): void {
    if (!provider.trim()) throw new Error("provider");
    const { nonce, sealed } = this.seal("brought", subject, provider, secret);
    this.store.db
      .prepare(
        `INSERT INTO brought_key (subject, provider, nonce, sealed, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(subject, provider) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed, rotated_at = excluded.created_at`,
      )
      .run(subject, provider, nonce, sealed, this.now());
  }

  deleteKey(subject: string, provider: string): boolean {
    return (
      this.store.db
        .prepare("DELETE FROM brought_key WHERE subject = ? AND provider = ?")
        .run(subject, provider).changes > 0
    );
  }

  /** The credential a stream uses for this person and provider: the brought key, else a live OAuth access token, else null. */
  async open(subject: string, provider: string): Promise<string | null> {
    const k = this.store.db
      .prepare("SELECT nonce, sealed FROM brought_key WHERE subject = ? AND provider = ?")
      .get(subject, provider) as { nonce: Uint8Array; sealed: Uint8Array } | undefined;
    if (k) return this.unseal("brought", subject, provider, k.nonce, k.sealed);
    const g = this.grant(subject, provider);
    if (!g) return null;
    if (g.expires_at !== null && g.expires_at - EARLY_MS <= this.now())
      return (await this.refresh(subject, provider))?.access ?? null;
    return g.access;
  }

  private grant(
    subject: string,
    provider: string,
  ): { access: string; refresh: string | null; expires_at: number | null } | null {
    const row = this.store.db
      .prepare("SELECT nonce, sealed, expires_at FROM oauth_grant WHERE subject = ? AND provider = ?")
      .get(subject, provider) as
      | { nonce: Uint8Array; sealed: Uint8Array; expires_at: number | null }
      | undefined;
    if (!row) return null;
    const plain = JSON.parse(this.unseal("oauth", subject, provider, row.nonce, row.sealed)) as {
      access: string;
      refresh: string | null;
    };
    return { ...plain, expires_at: row.expires_at };
  }

  private storeGrant(
    subject: string,
    provider: string,
    access: string,
    refresh: string | null,
    expiresIn: number | null,
    refreshed: boolean,
  ): void {
    const { nonce, sealed } = this.seal("oauth", subject, provider, JSON.stringify({ access, refresh }));
    const now = this.now();
    const expires = expiresIn === null ? null : now + expiresIn * 1000;
    this.store.db
      .prepare(
        `INSERT INTO oauth_grant (subject, provider, nonce, sealed, expires_at, created_at, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject, provider) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed, expires_at = excluded.expires_at, refreshed_at = excluded.refreshed_at`,
      )
      .run(subject, provider, nonce, sealed, expires, now, refreshed ? now : null);
  }

  /** PKCE and a state bound to the subject and the session; the authorize URL to send the person to. */
  start(
    subject: string,
    provider: string,
    session: string,
    returnTo: string,
  ): { url: string; state: string } {
    const p = this.providerOf(provider);
    if (!p) throw new Error(`no OAuth provider named ${provider}`);
    if (p.personal !== "offered")
      throw new Error(
        `${provider}: ${p.policy?.sentence ?? "absent by policy"} (as of ${p.policy?.date ?? "the policy's date"})`,
      );
    if (!session.trim()) throw new Error("a state is bound to the session; the session is required");
    if (!/^https?:\/\//u.test(returnTo)) throw new Error("return_to is the desk page the person came from");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    this.store.db.prepare("DELETE FROM oauth_state WHERE created_at < ?").run(this.now() - STATE_TTL_MS);
    this.store.db
      .prepare(
        "INSERT INTO oauth_state (state, subject, provider, session, verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(state, subject, provider, session, verifier, returnTo, this.now());
    const u = new URL(p.authorize);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", p.clientId);
    u.searchParams.set("redirect_uri", this.redirect());
    u.searchParams.set("scope", p.scopes.join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return { url: u.toString(), state };
  }

  /** The callback: the state names the subject, the provider and the session it was bound to; the code is exchanged with the verifier. */
  async callback(
    code: string,
    state: string,
    session: string | null,
  ): Promise<{ subject: string; provider: string; return_to: string }> {
    const row = this.store.db
      .prepare(
        "SELECT subject, provider, session, verifier, return_to, created_at FROM oauth_state WHERE state = ?",
      )
      .get(state) as
      | {
          subject: string;
          provider: string;
          session: string;
          verifier: string;
          return_to: string;
          created_at: number;
        }
      | undefined;
    this.store.db.prepare("DELETE FROM oauth_state WHERE state = ?").run(state);
    if (!row) throw new Error("the state is unknown or was used already");
    if (row.created_at + STATE_TTL_MS < this.now()) throw new Error("the state expired");
    if (session !== null && session !== row.session)
      throw new Error("the state was bound to another session");
    const p = this.providerOf(row.provider);
    if (!p) throw new Error(`no OAuth provider named ${row.provider}`);
    const r = await this.dial(p.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirect(),
        client_id: p.clientId,
        code_verifier: row.verifier,
      }).toString(),
    });
    if (!r.ok) throw new Error(`${row.provider} refused the code: ${r.status}`);
    const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!t.access_token) throw new Error(`${row.provider} answered no access token`);
    this.storeGrant(
      row.subject,
      row.provider,
      t.access_token,
      t.refresh_token ?? null,
      typeof t.expires_in === "number" ? t.expires_in : null,
      false,
    );
    return { subject: row.subject, provider: row.provider, return_to: row.return_to };
  }

  /** The refresh, serialised per person and provider: the refresh token rotates on every use. */
  refresh(subject: string, provider: string): Promise<{ access: string } | null> {
    return this.locks.run(`${subject} ${provider}`, async () => {
      const g = this.grant(subject, provider);
      if (!g) return null;
      // another refresh under the lock may have renewed it already
      if (g.expires_at !== null && g.expires_at - EARLY_MS > this.now()) return { access: g.access };
      if (!g.refresh) return null;
      const p = this.providerOf(provider);
      if (!p) return null;
      const r = await this.dial(p.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: g.refresh,
          client_id: p.clientId,
        }).toString(),
      });
      if (!r.ok) return null;
      const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!t.access_token) return null;
      this.storeGrant(
        subject,
        provider,
        t.access_token,
        t.refresh_token ?? g.refresh,
        typeof t.expires_in === "number" ? t.expires_in : null,
        true,
      );
      return { access: t.access_token };
    });
  }

  /** Revoke: both tokens deleted; nothing of the grant remains. */
  revoke(subject: string, provider: string): boolean {
    return (
      this.store.db
        .prepare("DELETE FROM oauth_grant WHERE subject = ? AND provider = ?")
        .run(subject, provider).changes > 0
    );
  }

  /** Deletion on request (§10): everything of one subject. */
  deleteSubject(subject: string): number {
    const a = this.store.db.prepare("DELETE FROM brought_key WHERE subject = ?").run(subject).changes;
    const b = this.store.db.prepare("DELETE FROM oauth_grant WHERE subject = ?").run(subject).changes;
    const c = this.store.db.prepare("DELETE FROM oauth_state WHERE subject = ?").run(subject).changes;
    return Number(a) + Number(b) + Number(c);
  }
}

/** The providers from the configuration: the wave's two by default, an operator's rows replacing them by name. */
export function oauthProviders(raw: unknown): OAuthProvider[] {
  const rows = Array.isArray(raw) ? (raw as Partial<OAuthProvider>[]) : [];
  const byName = new Map(DEFAULT_OAUTH.map((d) => [d.provider, d]));
  for (const r of rows) {
    if (!r.provider || (r.personal !== "offered" && r.personal !== "absent_by_policy"))
      throw new Error(
        "kvasir.json: oauth: each row names its provider and whether the personal source is offered or absent_by_policy",
      );
    const merged: OAuthProvider = {
      ...(byName.get(r.provider) ?? { authorize: "", token: "", clientId: "", scopes: [] }),
      ...r,
      provider: r.provider,
      personal: r.personal,
      scopes: r.scopes ?? byName.get(r.provider)?.scopes ?? [],
    };
    if (merged.personal === "absent_by_policy" && !(merged.policy?.sentence && merged.policy.date))
      throw new Error(
        `kvasir.json: oauth: ${r.provider} is absent by policy and needs the sentence and the date`,
      );
    if (
      merged.personal === "offered" &&
      !(/^https?:\/\//u.test(merged.authorize) && /^https?:\/\//u.test(merged.token) && merged.clientId)
    )
      throw new Error(`kvasir.json: oauth: ${r.provider} is offered and needs authorize, token and clientId`);
    byName.set(r.provider, merged);
  }
  return [...byName.values()];
}
