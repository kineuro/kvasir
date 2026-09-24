// SPDX-License-Identifier: AGPL-3.0-only
// Client keys (record 47, K2): the keys Kvasir hands to clients outside NILS,
// such as Droid, a script or another install's Kvasir, on the doors that pass
// a request through. Each has a name, the models it may ask for (every model
// when none is listed), whether it may cause a swap on a card, when it was
// made and revoked, and when it was last used. Only the sha256 of the secret
// is kept, as modelgate kept it, so modelgate's keys file imports as it is and
// the keys people hold today keep working. A revoked key keeps its row, so its
// ledger rows still name it and a caller presenting it is told it was revoked.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Store } from "./store.js";

/** The prefix of a client key Kvasir makes; an imported key keeps whatever shape it had. */
export const CLIENT_PREFIX = "kvc_";

export const CLIENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS client (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     hash TEXT NOT NULL UNIQUE,
     models TEXT,
     swap INTEGER NOT NULL DEFAULT 1,
     origin TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     revoked_at INTEGER,
     last_used_at INTEGER
   )`;

export interface ClientKey {
  id: string;
  name: string;
  /** The models the key may ask for, by id or alias; null for every model. */
  models: string[] | null;
  /** Whether a request with this key may load a model that is not loaded, swapping out the one that is. */
  swap: boolean;
  /** `minted` by Kvasir, or `modelgate` when imported from modelgate's keys file. */
  origin: "minted" | "modelgate";
  createdAt: number;
  createdBy: string;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface MadeClient extends ClientKey {
  /** Shown once. */
  secret: string;
}

/** What a client key's usage adds up to over a window, from the ledger's rows. */
export interface ClientUsage {
  streams: number;
  input: number;
  output: number;
  refused: number;
}

/** What an import of modelgate's keys file did, in counts. */
export interface Imported {
  added: number;
  present: number;
  skipped: number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
/** How often a key's last use is written, at most: a busy key is not a write per request. */
const LAST_USED_EVERY_MS = 60_000;

export function sha256(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export class ClientRefused extends Error {}

export class Clients {
  constructor(private readonly store: Store) {
    store.db.exec(CLIENTS_SCHEMA);
  }

  /** A new key for a client, its secret shown once and only its hash kept. */
  add(name: string, opts: { models?: string[] | null; swap?: boolean; by: string }): MadeClient {
    const secret = `${CLIENT_PREFIX}${randomBytes(32).toString("base64url")}`;
    const row = this.insert(name, sha256(secret), "minted", opts);
    return { ...row, secret };
  }

  /**
   * modelgate's keys file, one `name sha256hex` per line, read the way
   * modelgate read it: a line of two words that does not begin with `#`. A
   * hash already held is left as it is, so an import may run again.
   */
  importModelgate(path: string, by: string): Imported {
    const out: Imported = { added: 0, present: 0, skipped: 0 };
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const p = line.trim().split(/\s+/u);
      if (p.length !== 2 || line.startsWith("#")) {
        out.skipped += 1;
        continue;
      }
      const [name, hex] = [p[0], p[1].toLowerCase()];
      if (!SHA256.test(hex) || !NAME.test(name)) {
        out.skipped += 1;
        continue;
      }
      if (this.store.db.prepare("SELECT 1 FROM client WHERE hash = ?").get(hex)) {
        out.present += 1;
        continue;
      }
      this.insert(name, hex, "modelgate", { by });
      out.added += 1;
    }
    return out;
  }

  /**
   * The key a presented secret is, when Kvasir holds its hash: the row, or
   * "revoked" for a key that was. Null for a secret that is no client key.
   */
  verify(secret: string): ClientKey | "revoked" | null {
    if (!secret) return null;
    const got = sha256(secret);
    const row = this.store.db.prepare("SELECT * FROM client WHERE hash = ?").get(got) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const want = Buffer.from(String(row.hash), "hex");
    if (!timingSafeEqual(want, Buffer.from(got, "hex"))) return null;
    if (row.revoked_at != null) return "revoked";
    const key = rowOf(row);
    const now = Date.now();
    if (key.lastUsedAt === null || now - key.lastUsedAt > LAST_USED_EVERY_MS) {
      this.store.db.prepare("UPDATE client SET last_used_at = ? WHERE id = ?").run(now, key.id);
      key.lastUsedAt = now;
    }
    return key;
  }

  /** Revoked at once: the next request with the key is refused. The row stays for the ledger. */
  revoke(id: string): boolean {
    return (
      this.store.db
        .prepare("UPDATE client SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(Date.now(), id).changes > 0
    );
  }

  get(id: string): ClientKey | null {
    const row = this.store.db.prepare("SELECT * FROM client WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowOf(row) : null;
  }

  /** The keys not revoked that carry a name. */
  named(name: string): ClientKey[] {
    return (
      this.store.db
        .prepare("SELECT * FROM client WHERE name = ? AND revoked_at IS NULL ORDER BY created_at")
        .all(name) as Record<string, unknown>[]
    ).map(rowOf);
  }

  list(): ClientKey[] {
    return (
      this.store.db.prepare("SELECT * FROM client ORDER BY created_at").all() as Record<string, unknown>[]
    ).map(rowOf);
  }

  /** Each key's ledger over the last `days` days, in counts. */
  usage(days: number): Map<string, ClientUsage> {
    const since = Date.now() - days * 86_400_000;
    const rows = this.store.db
      .prepare(
        `SELECT client_key AS id, COUNT(*) AS streams, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(CASE WHEN outcome = 'refused' THEN 1 ELSE 0 END) AS refused
           FROM ledger WHERE client_key IS NOT NULL AND at >= ? GROUP BY client_key`,
      )
      .all(since) as Record<string, unknown>[];
    return new Map(
      rows.map((r) => [
        String(r.id),
        {
          streams: Number(r.streams),
          input: Number(r.input ?? 0),
          output: Number(r.output ?? 0),
          refused: Number(r.refused ?? 0),
        },
      ]),
    );
  }

  private insert(
    name: string,
    hash: string,
    origin: ClientKey["origin"],
    opts: { models?: string[] | null; swap?: boolean; by: string },
  ): ClientKey {
    if (!NAME.test(name))
      throw new ClientRefused(
        "a client key's name: letters, digits, dots, dashes, underscores and @, at most sixty-four",
      );
    const models = opts.models && opts.models.length > 0 ? opts.models : null;
    const row: ClientKey = {
      id: `c_${randomBytes(6).toString("hex")}`,
      name,
      models,
      swap: opts.swap !== false,
      origin,
      createdAt: Date.now(),
      createdBy: opts.by,
      revokedAt: null,
      lastUsedAt: null,
    };
    this.store.db
      .prepare(
        "INSERT INTO client (id, name, hash, models, swap, origin, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        name,
        hash,
        models ? JSON.stringify(models) : null,
        row.swap ? 1 : 0,
        origin,
        row.createdAt,
        row.createdBy,
      );
    return row;
  }
}

function rowOf(row: Record<string, unknown>): ClientKey {
  return {
    id: String(row.id),
    name: String(row.name),
    models: row.models == null ? null : (JSON.parse(String(row.models)) as string[]),
    swap: Number(row.swap) === 1,
    origin: row.origin === "modelgate" ? "modelgate" : "minted",
    createdAt: Number(row.created_at),
    createdBy: String(row.created_by),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  };
}
