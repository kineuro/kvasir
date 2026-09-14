// SPDX-License-Identifier: AGPL-3.0-only
// A person's own ChatGPT subscription (record 23). A subscription is only a
// person's: signed in with a device code, its credential sealed under that
// person's subject, used only for that person's streams, and signed out by
// them. Where nobody signs in (the off mode) the one signed in is the
// install's. The sign-in is pi-ai's own device-code flow for OpenAI Codex,
// which works from a server: the person is shown a code and a link, and
// approves at OpenAI.

import { randomBytes } from "node:crypto";
import type { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Store } from "./store.js";

/** The sign-in, the refresh and the request auth of OpenAI Codex, as pi-ai does them. */
export type SubscriptionAuth = NonNullable<ReturnType<typeof openaiCodexProvider>["auth"]["oauth"]>;
type Credential = Parameters<SubscriptionAuth["refresh"]>[0];

/** The subject a subscription is kept under where nobody signs in. */
export const SYSTEM = "system";
/** Kvasir's name for the subscription, and for its backend. */
export const CHATGPT = "chatgpt";
/** How long before its expiry a token is refreshed. */
const EARLY_MS = 5 * 60_000;

export const SUBSCRIPTION_SCHEMA = `CREATE TABLE IF NOT EXISTS subscription (
     subject TEXT NOT NULL,
     provider TEXT NOT NULL,
     nonce BLOB NOT NULL,
     sealed BLOB NOT NULL,
     model TEXT,
     created_at INTEGER NOT NULL,
     refreshed_at INTEGER,
     PRIMARY KEY (subject, provider)
   )`;

/** What a person is shown while a sign-in waits for them. */
export interface Waiting {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface SubscriptionStatus {
  provider: typeof CHATGPT;
  name: string;
  for: "person" | "system";
  state: "signed_out" | "waiting" | "signed_in" | "failed";
  user_code: string | null;
  verification_uri: string | null;
  expires_at: number | null;
  since: number | null;
  model: string | null;
  models: { id: string; name: string; context_window: number }[];
  error: string | null;
}

interface Pending {
  abort: AbortController;
  waiting: Waiting | null;
  error: string | null;
}

interface Row {
  nonce: Uint8Array;
  sealed: Uint8Array;
  model: string | null;
  created_at: number;
}

/** The shape of pi-ai's login interaction this sign-in answers: a device code, and nothing more. */
interface Interaction {
  signal: AbortSignal;
  prompt(p: { type: string; options?: readonly { id: string }[] }): Promise<string>;
  notify(ev: { type: string; userCode?: string; verificationUri?: string; expiresInSeconds?: number }): void;
}

export class Subscriptions {
  private readonly pending = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<string | null>>();

  constructor(
    private readonly store: Store,
    private readonly key: Uint8Array,
    /** The models ChatGPT serves a subscription, as pi-ai lists them. */
    readonly models: { id: string; name: string; contextWindow: number }[],
    private readonly auth: () => SubscriptionAuth,
    private readonly now: () => number = Date.now,
  ) {
    store.db.exec(SUBSCRIPTION_SCHEMA);
  }

  private aad(subject: string): Uint8Array {
    return new TextEncoder().encode(`kvasir:subscription:${subject}:${CHATGPT}`);
  }

  private seal(subject: string, credential: Credential): { nonce: Buffer; sealed: Buffer } {
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305(this.key, new Uint8Array(nonce), this.aad(subject)).encrypt(
      new TextEncoder().encode(JSON.stringify(credential)),
    );
    return { nonce, sealed: Buffer.from(sealed) };
  }

  private row(subject: string): Row | undefined {
    return this.store.db
      .prepare("SELECT nonce, sealed, model, created_at FROM subscription WHERE subject = ? AND provider = ?")
      .get(subject, CHATGPT) as Row | undefined;
  }

  private open(subject: string): Credential | null {
    const r = this.row(subject);
    if (!r) return null;
    const plain = xchacha20poly1305(this.key, new Uint8Array(r.nonce), this.aad(subject)).decrypt(
      new Uint8Array(r.sealed),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as Credential;
  }

  private signedIn(subject: string, credential: Credential): void {
    const { nonce, sealed } = this.seal(subject, credential);
    const model = this.row(subject)?.model ?? this.defaultModel();
    this.store.db
      .prepare(
        `INSERT INTO subscription (subject, provider, nonce, sealed, model, created_at, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(subject, provider) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed, created_at = excluded.created_at, refreshed_at = NULL`,
      )
      .run(subject, CHATGPT, nonce, sealed, model, this.now());
  }

  private refreshed(subject: string, credential: Credential): void {
    const { nonce, sealed } = this.seal(subject, credential);
    this.store.db
      .prepare(
        "UPDATE subscription SET nonce = ?, sealed = ?, refreshed_at = ? WHERE subject = ? AND provider = ?",
      )
      .run(nonce, sealed, this.now(), subject, CHATGPT);
  }

  /** The model a new subscription's streams use until its person chooses another. */
  defaultModel(): string | null {
    return this.models.find((m) => m.id === "gpt-5.4-mini")?.id ?? this.models[0]?.id ?? null;
  }

  /** Whether this subject has a subscription signed in. */
  has(subject: string): boolean {
    return this.row(subject) !== undefined;
  }

  /** The model this subject's streams use, or null with no subscription signed in. */
  model(subject: string): string | null {
    const r = this.row(subject);
    if (!r) return null;
    return r.model && this.models.some((m) => m.id === r.model) ? r.model : this.defaultModel();
  }

  /** Every subscription signed in, without its credential. */
  list(): { subject: string; model: string | null; since: number; refreshedAt: number | null }[] {
    return (
      this.store.db
        .prepare(
          "SELECT subject, model, created_at, refreshed_at FROM subscription WHERE provider = ? ORDER BY subject",
        )
        .all(CHATGPT) as Record<string, unknown>[]
    ).map((r) => ({
      subject: String(r.subject),
      model: r.model == null ? null : String(r.model),
      since: Number(r.created_at),
      refreshedAt: r.refreshed_at == null ? null : Number(r.refreshed_at),
    }));
  }

  /**
   * A sign-in begun: it resolves once pi-ai shows the device code, and goes on
   * waiting until the person approves, the code expires or the sign-in is
   * abandoned. A sign-in already waiting for this subject is abandoned.
   */
  signIn(subject: string): Promise<Waiting> {
    this.pending.get(subject)?.abort.abort();
    const entry: Pending = { abort: new AbortController(), waiting: null, error: null };
    this.pending.set(subject, entry);
    return new Promise<Waiting>((resolve, reject) => {
      const interaction: Interaction = {
        signal: entry.abort.signal,
        prompt: async (p) => {
          if (p.type === "select" && p.options?.some((o) => o.id === "device_code")) return "device_code";
          throw new Error("the sign-in asked for more than a device code");
        },
        notify: (ev) => {
          if (ev.type !== "device_code" || !ev.userCode || !ev.verificationUri) return;
          entry.waiting = {
            userCode: ev.userCode,
            verificationUri: ev.verificationUri,
            expiresAt: this.now() + (ev.expiresInSeconds ?? 900) * 1000,
          };
          resolve(entry.waiting);
        },
      };
      this.auth()
        .login(interaction as never)
        .then(
          (credential) => {
            if (this.pending.get(subject) !== entry) return;
            this.signedIn(subject, credential);
            this.pending.delete(subject);
          },
          (e: unknown) => {
            entry.error = e instanceof Error ? e.message : String(e);
            if (entry.waiting) return;
            if (this.pending.get(subject) === entry) this.pending.delete(subject);
            reject(e);
          },
        );
    });
  }

  /** What a person sees of their subscription, or of the install's. */
  status(subject: string, forWhom: "person" | "system"): SubscriptionStatus {
    const r = this.row(subject);
    const p = this.pending.get(subject);
    const expired = p?.waiting !== null && p?.waiting !== undefined && p.waiting.expiresAt <= this.now();
    const state: SubscriptionStatus["state"] = p
      ? p.error || expired
        ? "failed"
        : "waiting"
      : r
        ? "signed_in"
        : "signed_out";
    const waiting = state === "waiting" ? (p?.waiting ?? null) : null;
    return {
      provider: CHATGPT,
      name: "ChatGPT",
      for: forWhom,
      state,
      user_code: waiting?.userCode ?? null,
      verification_uri: waiting?.verificationUri ?? null,
      expires_at: waiting?.expiresAt ?? null,
      since: r?.created_at ?? null,
      model: r ? this.model(subject) : null,
      models: this.models.map((m) => ({ id: m.id, name: m.name, context_window: m.contextWindow })),
      error: state === "failed" ? (p?.error ?? "the code expired before it was approved") : null,
    };
  }

  /** The model this subject's streams use, among those ChatGPT serves. */
  choose(subject: string, model: string): void {
    if (!this.models.some((m) => m.id === model)) throw new Error(`ChatGPT serves no model named ${model}`);
    const changed = this.store.db
      .prepare("UPDATE subscription SET model = ? WHERE subject = ? AND provider = ?")
      .run(model, subject, CHATGPT).changes;
    if (Number(changed) === 0) throw new Error("no ChatGPT subscription is signed in");
  }

  /** Signed out: the credential is gone, and a sign-in still waiting is abandoned. */
  signOut(subject: string): boolean {
    const p = this.pending.get(subject);
    p?.abort.abort();
    this.pending.delete(subject);
    const gone = Number(
      this.store.db
        .prepare("DELETE FROM subscription WHERE subject = ? AND provider = ?")
        .run(subject, CHATGPT).changes,
    );
    return gone > 0 || p !== undefined;
  }

  /**
   * The token a stream of this subject's uses: refreshed first when it is
   * about to expire, one refresh at a time for a subject. Null where nothing
   * is signed in or the refresh failed.
   */
  token(subject: string): Promise<string | null> {
    const running = this.refreshing.get(subject);
    if (running) return running;
    const credential = this.open(subject);
    if (!credential) return Promise.resolve(null);
    const expires = Number((credential as { expires?: unknown }).expires ?? 0);
    if (expires - EARLY_MS > this.now()) return this.bearer(credential);
    const refresh = this.auth()
      .refresh(credential)
      .then(
        (next) => {
          this.refreshed(subject, next);
          return this.bearer(next);
        },
        () => null,
      )
      .finally(() => this.refreshing.delete(subject));
    this.refreshing.set(subject, refresh);
    return refresh;
  }

  private async bearer(credential: Credential): Promise<string | null> {
    const auth = (await this.auth().toAuth(credential)) as { apiKey?: string };
    return auth.apiKey ?? null;
  }
}
