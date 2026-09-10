// SPDX-License-Identifier: AGPL-3.0-only
// The model lifecycle (Wave 5 §9.5, §12): a candidate model is registered,
// from a fine-tune job or by hand; admitted by the suite; promoted by a
// rung-three proposal a person accepted, at which point the purposes route
// to it and the model it replaces is retired; retired. Every transition is
// a row, with who did it and when. A candidate cannot be promoted without
// an admission record that passed.

import type { Store } from "./store.js";
import type { AdmissionRecord } from "./suite.js";

export const LIFECYCLE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lifecycle (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     model TEXT NOT NULL,
     backend TEXT NOT NULL,
     source TEXT NOT NULL,
     state TEXT NOT NULL,
     registered_at INTEGER NOT NULL,
     registered_by TEXT NOT NULL,
     admitted_at INTEGER,
     admission TEXT,
     promoted_at INTEGER,
     promoted_by TEXT,
     proposal TEXT,
     retired_at INTEGER,
     retired_by TEXT,
     notes TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS lifecycle_model ON lifecycle (backend, model, state)",
  // one row per transition: the audit of the lifecycle
  `CREATE TABLE IF NOT EXISTS lifecycle_event (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     lifecycle_id INTEGER NOT NULL,
     at INTEGER NOT NULL,
     by TEXT NOT NULL,
     transition TEXT NOT NULL,
     detail TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS lifecycle_event_row ON lifecycle_event (lifecycle_id, at)",
];

export type State = "registered" | "admitted" | "promoted" | "retired";

export type Source =
  | { kind: "fine-tune"; job: number | string; recipe: Record<string, unknown> }
  | { kind: "manual" };

export interface Admission {
  suite: string;
  version: string;
  passed: boolean;
  failed: string[];
  /** The admission record's id in the admission table. */
  record: number | null;
  at: number;
}

export interface Proposal {
  id: number | string;
  principal: string;
}

export interface Candidate {
  id: number;
  model: string;
  backend: string;
  source: Source;
  state: State;
  registered_at: number;
  registered_by: string;
  admitted_at: number | null;
  admission: Admission | null;
  promoted_at: number | null;
  promoted_by: string | null;
  proposal: Proposal | null;
  retired_at: number | null;
  retired_by: string | null;
  notes: string | null;
}

export interface Event {
  id: number;
  lifecycle_id: number;
  at: number;
  by: string;
  transition: string;
  detail: Record<string, unknown> | null;
}

export class LifecycleRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Row {
  id: number;
  model: string;
  backend: string;
  source: string;
  state: State;
  registered_at: number;
  registered_by: string;
  admitted_at: number | null;
  admission: string | null;
  promoted_at: number | null;
  promoted_by: string | null;
  proposal: string | null;
  retired_at: number | null;
  retired_by: string | null;
  notes: string | null;
}

function candidateOf(r: Row): Candidate {
  return {
    id: r.id,
    model: r.model,
    backend: r.backend,
    source: JSON.parse(r.source),
    state: r.state,
    registered_at: r.registered_at,
    registered_by: r.registered_by,
    admitted_at: r.admitted_at,
    admission: r.admission ? JSON.parse(r.admission) : null,
    promoted_at: r.promoted_at,
    promoted_by: r.promoted_by,
    proposal: r.proposal ? JSON.parse(r.proposal) : null,
    retired_at: r.retired_at,
    retired_by: r.retired_by,
    notes: r.notes,
  };
}

/** A source as a caller sent it, or a refusal. */
export function parseSource(raw: unknown): Source {
  if (raw === undefined || raw === null) return { kind: "manual" };
  const s = raw as { kind?: unknown; job?: unknown; recipe?: unknown };
  if (s.kind === "manual") return { kind: "manual" };
  if (s.kind === "fine-tune") {
    if (typeof s.job !== "number" && typeof s.job !== "string")
      throw new LifecycleRefused(400, "a fine-tune source names its job");
    const recipe =
      s.recipe && typeof s.recipe === "object" && !Array.isArray(s.recipe)
        ? (s.recipe as Record<string, unknown>)
        : {};
    return { kind: "fine-tune", job: s.job, recipe };
  }
  throw new LifecycleRefused(400, "a source is {kind: fine-tune, job, recipe} or {kind: manual}");
}

export class Lifecycle {
  constructor(private readonly store: Store) {
    for (const s of LIFECYCLE_SCHEMA) store.db.exec(s);
  }

  list(): Candidate[] {
    return (this.store.db.prepare("SELECT * FROM lifecycle ORDER BY id DESC").all() as unknown as Row[]).map(
      candidateOf,
    );
  }

  get(id: number): Candidate | null {
    const r = this.store.db.prepare("SELECT * FROM lifecycle WHERE id = ?").get(id) as unknown as
      | Row
      | undefined;
    return r ? candidateOf(r) : null;
  }

  events(id: number): Event[] {
    return (
      this.store.db
        .prepare("SELECT * FROM lifecycle_event WHERE lifecycle_id = ? ORDER BY at, id")
        .all(id) as unknown as {
        id: number;
        lifecycle_id: number;
        at: number;
        by: string;
        transition: string;
        detail: string | null;
      }[]
    ).map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
  }

  /** The model the purposes route to on a backend: the one candidate in the promoted state, or none. */
  promoted(backend: string): string | null {
    const r = this.store.db
      .prepare(
        "SELECT model FROM lifecycle WHERE backend = ? AND state = 'promoted' ORDER BY promoted_at DESC LIMIT 1",
      )
      .get(backend) as { model: string } | undefined;
    return r?.model ?? null;
  }

  private event(
    id: number,
    by: string,
    transition: string,
    detail: Record<string, unknown> | null = null,
    at = Date.now(),
  ): void {
    this.store.db
      .prepare(
        "INSERT INTO lifecycle_event (lifecycle_id, at, by, transition, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, at, by, transition, detail ? JSON.stringify(detail) : null);
  }

  register(
    input: { model: string; backend: string; source: Source; notes?: string | null },
    by: string,
  ): Candidate {
    if (!input.model.trim()) throw new LifecycleRefused(400, "a candidate names its model");
    if (!input.backend.trim()) throw new LifecycleRefused(400, "a candidate names its backend");
    const open = this.store.db
      .prepare("SELECT id FROM lifecycle WHERE backend = ? AND model = ? AND state != 'retired'")
      .get(input.backend, input.model) as { id: number } | undefined;
    if (open)
      throw new LifecycleRefused(409, `${input.model} on ${input.backend} is already candidate ${open.id}`);
    const at = Date.now();
    const r = this.store.db
      .prepare(
        `INSERT INTO lifecycle (model, backend, source, state, registered_at, registered_by, notes)
         VALUES (?, ?, ?, 'registered', ?, ?, ?) RETURNING id`,
      )
      .get(input.model, input.backend, JSON.stringify(input.source), at, by, input.notes ?? null) as {
      id: number;
    };
    this.event(r.id, by, "registered", { source: input.source }, at);
    return this.get(r.id) as Candidate;
  }

  /** The suite's result on a candidate: a pass moves it to admitted; a failure records the failures and leaves it where it was. */
  recordAdmission(id: number, rec: AdmissionRecord, suite: string, version: string, by: string): Candidate {
    const c = this.get(id);
    if (!c) throw new LifecycleRefused(404, `no candidate ${id}`);
    if (c.state === "retired") throw new LifecycleRefused(409, `candidate ${id} is retired`);
    const admission: Admission = {
      suite,
      version,
      passed: rec.passed,
      failed: rec.checks.filter((ch) => ch.passed === false).map((ch) => ch.name),
      record: rec.id ?? null,
      at: rec.at,
    };
    const at = Date.now();
    if (rec.passed && c.state === "registered") {
      this.store.db
        .prepare("UPDATE lifecycle SET state = 'admitted', admitted_at = ?, admission = ? WHERE id = ?")
        .run(at, JSON.stringify(admission), id);
    } else {
      this.store.db
        .prepare("UPDATE lifecycle SET admission = ? WHERE id = ?")
        .run(JSON.stringify(admission), id);
    }
    this.event(
      id,
      by,
      rec.passed ? "admitted" : "admission_failed",
      { failed: admission.failed, record: admission.record },
      at,
    );
    return this.get(id) as Candidate;
  }

  /** Promotion needs an admission that passed; the candidate becomes the model the purposes route to, and the previous one on the backend is retired. */
  promote(
    id: number,
    by: string,
    proposal: Proposal | null,
  ): { candidate: Candidate; retired: Candidate | null } {
    const c = this.get(id);
    if (!c) throw new LifecycleRefused(404, `no candidate ${id}`);
    if (c.state === "retired")
      throw new LifecycleRefused(409, `candidate ${id} is retired and cannot be promoted`);
    if (c.state === "promoted") throw new LifecycleRefused(409, `candidate ${id} is already promoted`);
    if (!c.admission?.passed)
      throw new LifecycleRefused(
        409,
        `candidate ${id} (${c.model} on ${c.backend}) has no admission record that passed; run the suite first`,
      );
    const at = Date.now();
    const previous = this.store.db
      .prepare("SELECT * FROM lifecycle WHERE backend = ? AND state = 'promoted' AND id != ?")
      .get(c.backend, id) as unknown as Row | undefined;
    let retired: Candidate | null = null;
    if (previous) {
      this.store.db
        .prepare("UPDATE lifecycle SET state = 'retired', retired_at = ?, retired_by = ? WHERE id = ?")
        .run(at, by, previous.id);
      this.event(previous.id, by, "retired", { replaced_by: id }, at);
      retired = this.get(previous.id);
    }
    this.store.db
      .prepare(
        "UPDATE lifecycle SET state = 'promoted', promoted_at = ?, promoted_by = ?, proposal = ? WHERE id = ?",
      )
      .run(at, by, proposal ? JSON.stringify(proposal) : null, id);
    this.event(id, by, "promoted", { proposal, retired: previous?.id ?? null }, at);
    return { candidate: this.get(id) as Candidate, retired };
  }

  retire(id: number, by: string): Candidate {
    const c = this.get(id);
    if (!c) throw new LifecycleRefused(404, `no candidate ${id}`);
    if (c.state === "retired") throw new LifecycleRefused(409, `candidate ${id} is already retired`);
    const at = Date.now();
    this.store.db
      .prepare("UPDATE lifecycle SET state = 'retired', retired_at = ?, retired_by = ? WHERE id = ?")
      .run(at, by, id);
    this.event(id, by, "retired", null, at);
    return this.get(id) as Candidate;
  }
}
