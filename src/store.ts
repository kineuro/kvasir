// SPDX-License-Identifier: AGPL-3.0-only
// The one database: keys, the ledger, and later the credentials and the
// admission records. SQLite through Node's own binding; Postgres arrives with
// the group deployment.

import { DatabaseSync } from "node:sqlite";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS key (
     id TEXT PRIMARY KEY,
     hash TEXT NOT NULL,
     principal TEXT NOT NULL,
     purposes TEXT NOT NULL,
     max_class TEXT NOT NULL,
     expires_at INTEGER,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  // One row per stream (§8.7). No content column exists, and a test asserts it.
  `CREATE TABLE IF NOT EXISTS ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     subject TEXT NOT NULL,
     purpose TEXT,
     model TEXT,
     backend TEXT,
     grant_id TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     reasoning_tokens INTEGER NOT NULL DEFAULT 0,
     gpu_seconds REAL NOT NULL DEFAULT 0,
     money REAL NOT NULL DEFAULT 0,
     ttft_ms INTEGER,
     total_ms INTEGER,
     outcome TEXT NOT NULL,
     refusal_layer TEXT,
     refusal_fact TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS ledger_subject ON ledger (subject, at)",
  // The admission records (§8.6): suite results per model, runtime and
  // build, kept until the runtime changes.
  `CREATE TABLE IF NOT EXISTS admission (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     backend TEXT NOT NULL,
     model TEXT NOT NULL,
     runtime TEXT NOT NULL,
     runtime_version TEXT NOT NULL,
     runtime_build TEXT NOT NULL,
     at INTEGER NOT NULL,
     passed INTEGER NOT NULL,
     overflow TEXT NOT NULL,
     checks TEXT NOT NULL,
     overhead TEXT,
     kvasir TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS admission_model ON admission (backend, model, at)",
];

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // a second Kvasir on the database, such as the command line beside a server, waits its turn to write rather than failing
    this.db.exec("PRAGMA busy_timeout = 5000");
    for (const s of SCHEMA) this.db.exec(s);
    // record 47: the client key a ledger row was spent under, for the ledger per key
    if (!this.columns("ledger").includes("client_key"))
      this.db.exec("ALTER TABLE ledger ADD COLUMN client_key TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS ledger_client ON ledger (client_key, at)");
  }

  columns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
  }

  close(): void {
    this.db.close();
  }
}
