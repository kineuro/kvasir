// SPDX-License-Identifier: AGPL-3.0-only
// The organisation's commercial key (§8.4, C3): one per provider, encrypted
// at rest with XChaCha20-Poly1305 under a key held in a file outside the
// database, the provider and the row bound in as associated data, decrypted
// only in memory at use, never returned, never logged. Rotation re-encrypts;
// it never replaces the encryption key.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import type { Store } from "./store.js";

/**
 * The seal key committed with the source until 1.0.0-alpha.1. Anyone can read
 * it, so it is never a key to keep: a key file holding it is replaced, and a
 * row sealed under it is sealed again under the private key.
 */
const PUBLISHED = Uint8Array.from(
  Buffer.from("81e62eb8ff3699ffae4b175556b75f3f074d9d31dc4af2095d4411ae51d3d5df", "hex"),
);

/** A row of a sealed table, with what it was sealed under. */
interface SealedRow {
  rowid: number;
  subject?: string;
  provider: string;
  nonce: Uint8Array;
  sealed: Uint8Array;
}

/** Every table whose rows are sealed, and the associated data each row was sealed with. */
const SEALED_TABLES = [
  {
    table: "credential",
    columns: "rowid, provider, nonce, sealed",
    aad: (r: SealedRow) => `kvasir:credential:${r.provider}`,
  },
  {
    table: "brought_key",
    columns: "rowid, subject, provider, nonce, sealed",
    aad: (r: SealedRow) => `kvasir:brought:${r.subject}:${r.provider}`,
  },
  {
    table: "oauth_grant",
    columns: "rowid, subject, provider, nonce, sealed",
    aad: (r: SealedRow) => `kvasir:oauth:${r.subject}:${r.provider}`,
  },
];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function opens(key: Uint8Array, row: SealedRow, aad: string): Uint8Array | null {
  try {
    return xchacha20poly1305(key, new Uint8Array(row.nonce), new TextEncoder().encode(aad)).decrypt(
      new Uint8Array(row.sealed),
    );
  } catch {
    return null;
  }
}

function sealedRows(store: Store): { table: string; aad: string; row: SealedRow }[] {
  const out: { table: string; aad: string; row: SealedRow }[] = [];
  for (const t of SEALED_TABLES) {
    const present = store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(t.table);
    if (!present) continue;
    for (const row of store.db
      .prepare(`SELECT ${t.columns} FROM ${t.table}`)
      .all() as unknown as SealedRow[]) {
      out.push({ table: t.table, aad: t.aad(row), row });
    }
  }
  return out;
}

/** Every row that opens under `from`, sealed again under `to` in one transaction; answers how many moved. */
function reseal(store: Store, from: Uint8Array, to: Uint8Array): number {
  const rows = sealedRows(store);
  let moved = 0;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const { table, aad, row } of rows) {
      const plain = opens(from, row, aad);
      if (!plain) continue;
      const nonce = randomBytes(24);
      const sealed = xchacha20poly1305(to, new Uint8Array(nonce), new TextEncoder().encode(aad)).encrypt(
        plain,
      );
      store.db
        .prepare(`UPDATE ${table} SET nonce = ?, sealed = ? WHERE rowid = ?`)
        .run(nonce, Buffer.from(sealed), row.rowid);
      moved += 1;
    }
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
  return moved;
}

function writeKey(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The seal key for a store (§8.4), made private where it was not. A key file
 * holding the key published with the source gets a new key, and every row
 * sealed under the old one is sealed again; a key file an update removed is
 * made anew, and the rows the published key sealed carry over. The new key
 * is written beside the old before any row moves, so a start stopped halfway
 * finishes the move at the next.
 */
export function openSeal(path: string, store: Store, say: (line: string) => void = () => {}): Uint8Array {
  const pending = `${path}.new`;
  if (existsSync(pending)) {
    const next = new Uint8Array(readFileSync(pending));
    const moved =
      next.length === 32 && sealedRows(store).some(({ aad, row }) => opens(next, row, aad) !== null);
    if (moved) renameSync(pending, path);
    else rmSync(pending, { force: true });
  }
  let key: Uint8Array;
  try {
    key = new Uint8Array(readFileSync(path));
    if (key.length !== 32) throw new Error(`${path}: the seal key is thirty-two bytes`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    key = new Uint8Array(randomBytes(32));
    writeKey(path, key);
  }
  if (sameBytes(key, PUBLISHED)) {
    const fresh = new Uint8Array(randomBytes(32));
    writeKey(pending, fresh);
    const moved = reseal(store, PUBLISHED, fresh);
    renameSync(pending, path);
    say(
      `the seal key was the one published with the source; a new key is in ${path}, and ${moved} stored ${moved === 1 ? "secret was" : "secrets were"} sealed again`,
    );
    return fresh;
  }
  const moved = reseal(store, PUBLISHED, key);
  if (moved > 0) {
    say(
      `${moved} stored ${moved === 1 ? "secret was" : "secrets were"} sealed under the key published with the source, and ${moved === 1 ? "is" : "are"} now sealed under ${path}`,
    );
  }
  return key;
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
