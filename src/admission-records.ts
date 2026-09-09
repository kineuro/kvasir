// SPDX-License-Identifier: AGPL-3.0-only
// The admission records (§8.6) in the one database: written by the suite,
// read by the door and the command line, and the source of each local
// backend's admitted set at start.

import type { Backends } from "./backends.js";
import type { Store } from "./store.js";
import type { AdmissionRecord, Runtime } from "./suite.js";

interface Row {
  id: number;
  backend: string;
  model: string;
  runtime: string;
  runtime_version: string;
  runtime_build: string;
  at: number;
  passed: number;
  overflow: string;
  checks: string;
  overhead: string | null;
  kvasir: string;
}

function recordOf(r: Row): AdmissionRecord {
  return {
    id: r.id,
    backend: r.backend,
    model: r.model,
    runtime: { name: r.runtime, version: r.runtime_version, build: r.runtime_build },
    at: r.at,
    passed: r.passed === 1,
    checks: JSON.parse(r.checks),
    overflow: r.overflow as AdmissionRecord["overflow"],
    overhead: r.overhead ? JSON.parse(r.overhead) : null,
    kvasir: r.kvasir,
  };
}

export class Admissions {
  constructor(private readonly store: Store) {}

  put(rec: AdmissionRecord): AdmissionRecord {
    const r = this.store.db
      .prepare(
        `INSERT INTO admission (backend, model, runtime, runtime_version, runtime_build, at, passed, overflow, checks, overhead, kvasir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        rec.backend,
        rec.model,
        rec.runtime.name,
        rec.runtime.version,
        rec.runtime.build,
        rec.at,
        rec.passed ? 1 : 0,
        rec.overflow,
        JSON.stringify(rec.checks),
        rec.overhead ? JSON.stringify(rec.overhead) : null,
        rec.kvasir,
      ) as { id: number };
    return { ...rec, id: r.id };
  }

  list(limit = 100): AdmissionRecord[] {
    return (
      this.store.db
        .prepare("SELECT * FROM admission ORDER BY at DESC, id DESC LIMIT ?")
        .all(limit) as unknown as Row[]
    ).map(recordOf);
  }

  /** The newest record of a model on a backend, for a runtime when one is named. */
  latest(backend: string, model: string, runtime?: Runtime): AdmissionRecord | null {
    const rows = runtime
      ? (this.store.db
          .prepare(
            "SELECT * FROM admission WHERE backend = ? AND model = ? AND runtime = ? AND runtime_version = ? ORDER BY at DESC, id DESC LIMIT 1",
          )
          .all(backend, model, runtime.name, runtime.version) as unknown as Row[])
      : (this.store.db
          .prepare(
            "SELECT * FROM admission WHERE backend = ? AND model = ? ORDER BY at DESC, id DESC LIMIT 1",
          )
          .all(backend, model) as unknown as Row[]);
    return rows[0] ? recordOf(rows[0]) : null;
  }

  /**
   * The admitted sets at start: each local model whose newest record passed.
   * A record is for a runtime version; when the runtime is probed and it
   * moved, the record no longer admits (§8.6: re-run on every upgrade).
   */
  async load(
    backends: Backends,
    probe?: (backend: Backends["list"][number]) => Promise<Runtime>,
  ): Promise<void> {
    for (const b of backends.list) {
      if (b.config.locality === "remote") continue;
      const runtime = probe ? await probe(b).catch(() => undefined) : undefined;
      for (const m of b.config.models) {
        const rec = this.latest(
          b.config.id,
          m.id,
          runtime && runtime.name !== "unknown" ? runtime : undefined,
        );
        if (rec?.passed) b.admitted.add(m.id);
        else b.admitted.delete(m.id);
      }
    }
  }
}
