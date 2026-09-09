// SPDX-License-Identifier: AGPL-3.0-only
// The organisation's commercial key (§8.4, C3): one per provider, encrypted
// at rest with XChaCha20-Poly1305 under a key held in a file outside the
// database, the provider and the row bound in as associated data, decrypted
// only in memory at use, never returned, never logged. Rotation re-encrypts;
// it never replaces the encryption key.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Store } from "./store.js";

export const CREDENTIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS credential (
     provider TEXT PRIMARY KEY,
     nonce BLOB NOT NULL,
     sealed BLOB NOT NULL,
     created_at INTEGER NOT NULL,
     rotated_at INTEGER
   )`;

/** The encryption key from its file, or a new one written there with mode 600. */
export function sealKey(path: string): Uint8Array {
  try {
    const k = new Uint8Array(readFileSync(path));
    if (k.length !== 32) throw new Error(`${path}: the seal key is thirty-two bytes`);
    return k;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const bytes = randomBytes(32);
    writeFileSync(path, bytes, { mode: 0o600 });
    return new Uint8Array(bytes);
  }
}

export class Credentials {
  constructor(
    private readonly store: Store,
    private readonly key: Uint8Array,
  ) {
    store.db.exec(CREDENTIAL_SCHEMA);
  }

  private aad(provider: string): Uint8Array {
    return new TextEncoder().encode(`kvasir:credential:${provider}`);
  }

  /** Store or rotate: the row is re-encrypted; the encryption key stays. */
  put(provider: string, secret: string): void {
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305(this.key, new Uint8Array(nonce), this.aad(provider)).encrypt(
      new TextEncoder().encode(secret),
    );
    const now = Date.now();
    this.store.db
      .prepare(
        `INSERT INTO credential (provider, nonce, sealed, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET nonce = excluded.nonce, sealed = excluded.sealed, rotated_at = excluded.created_at`,
      )
      .run(provider, nonce, Buffer.from(sealed), now);
  }

  /** Decrypted in memory at use; the caller drops it with the request. */
  open(provider: string): string | null {
    const row = this.store.db
      .prepare("SELECT nonce, sealed FROM credential WHERE provider = ?")
      .get(provider) as { nonce: Uint8Array; sealed: Uint8Array } | undefined;
    if (!row) return null;
    const plain = xchacha20poly1305(this.key, new Uint8Array(row.nonce), this.aad(provider)).decrypt(
      new Uint8Array(row.sealed),
    );
    return new TextDecoder().decode(plain);
  }

  has(provider: string): boolean {
    return this.store.db.prepare("SELECT 1 FROM credential WHERE provider = ?").get(provider) !== undefined;
  }

  delete(provider: string): boolean {
    return this.store.db.prepare("DELETE FROM credential WHERE provider = ?").run(provider).changes > 0;
  }

  providers(): { provider: string; createdAt: number; rotatedAt: number | null }[] {
    return (
      this.store.db
        .prepare("SELECT provider, created_at, rotated_at FROM credential ORDER BY provider")
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      provider: String(r.provider),
      createdAt: Number(r.created_at),
      rotatedAt: r.rotated_at == null ? null : Number(r.rotated_at),
    }));
  }
}
