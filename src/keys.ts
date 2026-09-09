// SPDX-License-Identifier: AGPL-3.0-only
// Minted keys (§8.4): thirty-two random bytes shown once, stored as a keyed
// BLAKE2b hash, compared in constant time, revoked by deleting a row. A key
// carries a principal, a purpose allowlist, a maximum content class and an
// expiry; a key with no purpose reaches only local backends.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import type { Store } from "./store.js";

export const PREFIX = "kvs_";
export type ContentClass = "catalog" | "rows" | "identifiers";
export const CLASSES: ContentClass[] = ["catalog", "rows", "identifiers"];

export interface KeyRow {
  id: string;
  principal: string;
  purposes: string[];
  maxClass: ContentClass;
  expiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface Minted extends KeyRow {
  /** Shown once. */
  secret: string;
}

function hash(secret: string, pepper: Uint8Array): string {
  return Buffer.from(blake2b(new TextEncoder().encode(secret), { key: pepper, dkLen: 32 })).toString("hex");
}

export class Keys {
  private readonly pepper: Uint8Array;
  constructor(
    private readonly store: Store,
    pepper: Uint8Array,
  ) {
    if (pepper.length < 16) throw new Error("the key pepper is at least sixteen bytes");
    this.pepper = pepper;
  }

  mint(principal: string, purposes: string[], maxClass: ContentClass, expiresAt: number | null): Minted {
    if (!CLASSES.includes(maxClass)) throw new Error(`the content class is one of ${CLASSES.join(", ")}`);
    const raw = randomBytes(32);
    const id = `k_${randomBytes(6).toString("hex")}`;
    const secret = `${PREFIX}${id}.${raw.toString("base64url")}`;
    const now = Date.now();
    this.store.db
      .prepare(
        "INSERT INTO key (id, hash, principal, purposes, max_class, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, hash(secret, this.pepper), principal, JSON.stringify(purposes), maxClass, expiresAt, now);
    return { id, principal, purposes, maxClass, expiresAt, createdAt: now, revokedAt: null, secret };
  }

  /** The row a presented key names, when the key is right, unexpired and not revoked. */
  verify(secret: string): KeyRow | null {
    if (!secret.startsWith(PREFIX)) return null;
    const id = secret.slice(PREFIX.length).split(".")[0];
    const row = this.store.db.prepare("SELECT * FROM key WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const want = Buffer.from(String(row.hash), "hex");
    const got = Buffer.from(hash(secret, this.pepper), "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && Number(row.expires_at) < Date.now()) return null;
    return {
      id: String(row.id),
      principal: String(row.principal),
      purposes: JSON.parse(String(row.purposes)),
      maxClass: row.max_class as ContentClass,
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      createdAt: Number(row.created_at),
      revokedAt: null,
    };
  }

  /** Revocation is a deleted row: a dump taken later yields nothing. */
  revoke(id: string): boolean {
    return this.store.db.prepare("DELETE FROM key WHERE id = ?").run(id).changes > 0;
  }

  list(): KeyRow[] {
    return (
      this.store.db.prepare("SELECT * FROM key ORDER BY created_at").all() as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      principal: String(row.principal),
      purposes: JSON.parse(String(row.purposes)),
      maxClass: row.max_class as ContentClass,
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      createdAt: Number(row.created_at),
      revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    }));
  }
}
