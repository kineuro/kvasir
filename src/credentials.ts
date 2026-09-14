// SPDX-License-Identifier: AGPL-3.0-only
// The keys Kvasir holds for its backends (§8.4, C3): one per backend that was
// added with one, encrypted at rest with XChaCha20-Poly1305 under a key held
// in a file outside the database, the credential's name bound in as
// associated data, decrypted only in memory at use, never returned, never
// logged. Replacing a key seals the row again; the file's key stays.

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Store } from "./store.js";

/** The seal key from its file, or a new one written there with mode 600. */
export function openSeal(path: string): Uint8Array {
  try {
    const key = new Uint8Array(readFileSync(path));
    if (key.length !== 32) throw new Error(`${path}: the seal key is thirty-two bytes`);
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const key = new Uint8Array(randomBytes(32));
    const fd = openSync(path, "w", 0o600);
    try {
      writeSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return key;
  }
}

export const CREDENTIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS credential (
     provider TEXT PRIMARY KEY,
     nonce BLOB NOT NULL,
     sealed BLOB NOT NULL,
     created_at INTEGER NOT NULL,
     rotated_at INTEGER
   )`;

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

  /** Store or replace: the row is sealed again; the encryption key stays. */
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
}
