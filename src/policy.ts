// SPDX-License-Identifier: AGPL-3.0-only
// Purposes, content classes, locality, grants and refusals (§8.3, D44). A
// purpose is registered by an app in the configuration, never invented by a
// caller. The policy table maps each purpose to the backend it uses;
// defaults are local. An admin opens a `catalog` purpose to a remote backend
// by choosing one; opens a `rows` purpose only with a recorded
// acknowledgement that rows of the archive will leave the site; and can
// never open an `identifiers` purpose. A request whose user text matches an
// identifier shape is bumped to `identifiers` for that request and runs
// local whatever the table says, and the caller is told why.

import { randomBytes } from "node:crypto";
import type { Backend, Backends } from "./backends.js";
import type { ContentClass } from "./keys.js";
import type { Store } from "./store.js";

export type Kind = "foreground" | "background";
export const CLASS_RANK: Record<ContentClass, number> = { catalog: 0, rows: 1, identifiers: 2 };

export interface Purpose {
  id: string;
  app: string;
  content: ContentClass;
  kind: Kind;
  description?: string;
}

export const POLICY_SCHEMA = `CREATE TABLE IF NOT EXISTS policy (
     purpose TEXT PRIMARY KEY,
     backend TEXT NOT NULL,
     acknowledged_by TEXT,
     acknowledged_at INTEGER,
     acknowledgement TEXT,
     set_by TEXT NOT NULL,
     set_at INTEGER NOT NULL
   )`;

export interface PolicyRow {
  purpose: string;
  backend: string;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  acknowledgement: string | null;
  setBy: string;
  setAt: number;
}

export interface Refusal {
  layer: "deployment" | "requirement" | "policy" | "quota" | "health";
  fact: string;
  /** The one relaxation that would admit the candidate. */
  relaxation?: string;
}

export class Refused extends Error {
  constructor(
    readonly status: number,
    readonly refusals: Refusal[],
  ) {
    super(refusals.map((r) => `${r.layer}: ${r.fact}`).join("; "));
  }
}

/** Identifier shapes (§8.3): a personal number, a DICOM UID, a long digit run. Data, never a key. */
export const IDENTIFIER_SHAPES: { name: string; re: RegExp }[] = [
  { name: "a personal number", re: /\b(19|20)?\d{6}[-+ ]?\d{4}\b/u },
  { name: "a DICOM unique identifier", re: /\b\d+(\.\d+){4,}\b/u },
  { name: "a long run of digits", re: /\b\d{10,}\b/u },
];

export function identifierShape(text: string): string | null {
  for (const s of IDENTIFIER_SHAPES) if (s.re.test(text)) return s.name;
  return null;
}

export interface Need {
  tools?: "required" | "preferred" | "none";
  structured?: "strict" | "preferred" | "none";
  context_tokens?: number;
  max_output_tokens?: number;
  reasoning?: "off" | "low" | "medium" | "high";
}

export interface Grant {
  grant: string;
  purpose: string;
  content: ContentClass;
  model: string;
  backend: string;
  locality: "local" | "remote";
  limits: { context_tokens: number; max_output_tokens: number };
  capabilities: { tools: boolean; structured: "strict" | "preferred" | "none"; reasoning: string[] };
  budget: { remaining_tokens: number | null; resets: string | null };
  chose_because: string[];
  expires_at: number;
}

export class Policy {
  readonly purposes: Map<string, Purpose>;
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly store: Store,
    purposes: Purpose[],
    private readonly backends: Backends,
  ) {
    store.db.exec(POLICY_SCHEMA);
    this.purposes = new Map(purposes.map((p) => [p.id, p]));
  }

  rows(): PolicyRow[] {
    return (
      this.store.db.prepare("SELECT * FROM policy ORDER BY purpose").all() as Record<string, unknown>[]
    ).map((r) => ({
      purpose: String(r.purpose),
      backend: String(r.backend),
      acknowledgedBy: r.acknowledged_by == null ? null : String(r.acknowledged_by),
      acknowledgedAt: r.acknowledged_at == null ? null : Number(r.acknowledged_at),
      acknowledgement: r.acknowledgement == null ? null : String(r.acknowledgement),
      setBy: String(r.set_by),
      setAt: Number(r.set_at),
    }));
  }

  row(purpose: string): PolicyRow | undefined {
    return this.rows().find((r) => r.purpose === purpose);
  }

  /** The table as the desk's models page reads it: every purpose with its backend, default or set, and what opening it would need. */
  table() {
    const set = new Map(this.rows().map((r) => [r.purpose, r]));
    return [...this.purposes.values()].map((p) => {
      const r = set.get(p.id);
      const backend = r?.backend ?? this.defaultBackend(p)?.config.id ?? null;
      return {
        purpose: p.id,
        app: p.app,
        content: p.content,
        kind: p.kind,
        backend,
        locality: backend ? this.backends.list.find((b) => b.config.id === backend)?.config.locality : null,
        default: r === undefined,
        acknowledged: r?.acknowledgedBy
          ? { by: r.acknowledgedBy, at: r.acknowledgedAt, text: r.acknowledgement }
          : null,
        may_open_remote:
          p.content === "catalog"
            ? "yes"
            : p.content === "rows"
              ? "with an acknowledgement that rows of the archive will leave the site"
              : "never",
      };
    });
  }

  private defaultBackend(p: Purpose): Backend | undefined {
    return this.backends.list.find(
      (b) =>
        b.config.locality === "local" &&
        b.config.models.length > 0 &&
        (!b.config.classes || CLASS_RANK[b.config.classes] >= CLASS_RANK[p.content]),
    );
  }

  /**
   * An admin sets the backend of a purpose. A remote backend for a `rows`
   * purpose needs the acknowledgement sentence; an `identifiers` purpose
   * never goes remote.
   */
  set(purpose: string, backendId: string, by: string, acknowledgement: string | null): PolicyRow {
    const p = this.purposes.get(purpose);
    if (!p)
      throw new Refused(404, [{ layer: "deployment", fact: `no purpose named ${purpose} is registered` }]);
    const b = this.backends.list.find((x) => x.config.id === backendId);
    if (!b) throw new Refused(404, [{ layer: "deployment", fact: `no backend named ${backendId}` }]);
    if (b.config.locality === "remote") {
      if (p.content === "identifiers") {
        throw new Refused(403, [
          {
            layer: "policy",
            fact: `${purpose} carries identifiers, and an identifiers purpose can never open to a remote backend`,
          },
        ]);
      }
      if (p.content === "rows" && !acknowledgement?.trim()) {
        throw new Refused(400, [
          {
            layer: "policy",
            fact: `${purpose} carries rows of the archive; opening it to ${backendId} needs a recorded acknowledgement that rows will leave the site`,
            relaxation: "send acknowledgement: the sentence, under your name",
          },
        ]);
      }
    }
    const now = Date.now();
    const ack = b.config.locality === "remote" && p.content === "rows" ? acknowledgement : null;
    this.store.db
      .prepare(
        `INSERT INTO policy (purpose, backend, acknowledged_by, acknowledged_at, acknowledgement, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(purpose) DO UPDATE SET backend = excluded.backend, acknowledged_by = excluded.acknowledged_by, acknowledged_at = excluded.acknowledged_at, acknowledgement = excluded.acknowledgement, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(purpose, backendId, ack ? by : null, ack ? now : null, ack, by, now);
    return this.row(purpose) as PolicyRow;
  }

  /**
   * A grant (§8.3): the requirement in, the answer out, or a refusal that
   * names the layer that removed each candidate and the one relaxation that
   * would admit it. There is never a silent downgrade.
   */
  grant(
    purposeId: string,
    need: Need,
    opts: { pin?: string | null; bumped?: string | null; keyClass?: ContentClass },
  ): Grant {
    const p = this.purposes.get(purposeId);
    if (!p)
      throw new Refused(400, [
        {
          layer: "deployment",
          fact: `no purpose named ${purposeId} is registered; a purpose is an app's, never a caller's`,
        },
      ]);
    const content: ContentClass = opts.bumped ? "identifiers" : p.content;
    if (opts.keyClass && CLASS_RANK[opts.keyClass] < CLASS_RANK[content]) {
      throw new Refused(403, [
        { layer: "policy", fact: `the key's class is ${opts.keyClass}, and ${purposeId} carries ${content}` },
      ]);
    }
    const refusals: Refusal[] = [];
    // the backend the table names, or the local default; a bumped request runs local whatever the table says
    const row = this.row(purposeId);
    const chosen = opts.bumped
      ? this.defaultBackend(p)
      : row
        ? this.backends.list.find((b) => b.config.id === row.backend)
        : this.defaultBackend(p);
    const because: string[] = [];
    if (opts.bumped)
      because.push(
        `the request's text matches ${opts.bumped}, so it carries identifiers and runs local whatever the policy table says`,
      );
    else if (row) because.push(`the policy table maps ${purposeId} to ${row.backend}`);
    else because.push(`${purposeId} has no row in the policy table, and the default is local`);
    if (!chosen)
      throw new Refused(503, [
        {
          layer: "deployment",
          fact: "no local backend serves this content class",
          relaxation: "register a local backend",
        },
      ]);
    if (chosen.config.locality === "remote" && content === "identifiers") {
      throw new Refused(403, [
        { layer: "policy", fact: `${purposeId} carries identifiers and ${chosen.config.id} is remote` },
      ]);
    }
    // a pin: recorded, never above the policy; a bumped request runs local
    // and the pin, if it named a remote model, is set aside and said so
    let entry = chosen.config.models[0];
    if (opts.pin && opts.bumped && !chosen.config.models.some((m) => m.id === opts.pin)) {
      because.push(
        `the pinned model ${opts.pin} is not local, so the request runs on ${entry?.id ?? "the local model"} instead`,
      );
    } else if (opts.pin) {
      const pinned = chosen.config.models.find((m) => m.id === opts.pin);
      if (!pinned) {
        const elsewhere = this.backends.find(opts.pin);
        if (elsewhere) {
          refusals.push({
            layer: "policy",
            fact: `${opts.pin} is served by ${elsewhere.backend.config.id}, and ${purposeId} is mapped to ${chosen.config.id}`,
            relaxation: `an admin maps ${purposeId} to ${elsewhere.backend.config.id}`,
          });
        } else refusals.push({ layer: "deployment", fact: `no model named ${opts.pin}` });
        throw new Refused(403, refusals);
      }
      entry = pinned;
      because.push(`pinned to ${opts.pin} by the caller, recorded`);
    }
    if (!entry)
      throw new Refused(503, [{ layer: "deployment", fact: `${chosen.config.id} serves no model` }]);
    // the requirement against what the backend measured
    if (need.context_tokens && need.context_tokens > entry.contextWindow) {
      refusals.push({
        layer: "requirement",
        fact: `${entry.id} holds ${entry.contextWindow} context tokens, and ${need.context_tokens} were asked`,
        relaxation: `ask for at most ${entry.contextWindow} context tokens`,
      });
    }
    if (need.max_output_tokens && need.max_output_tokens > entry.maxTokens) {
      refusals.push({
        layer: "requirement",
        fact: `${entry.id} answers at most ${entry.maxTokens} tokens, and ${need.max_output_tokens} were asked`,
        relaxation: `ask for at most ${entry.maxTokens} output tokens`,
      });
    }
    if (need.reasoning && need.reasoning !== "off" && !entry.reasoning) {
      refusals.push({
        layer: "requirement",
        fact: `${entry.id} does not reason`,
        relaxation: "ask with reasoning off",
      });
    }
    if (chosen.health.warming) {
      refusals.push({
        layer: "health",
        fact: `${chosen.config.id} has produced no first token since start`,
        relaxation: "wait for the backend to warm",
      });
    }
    if (refusals.length > 0) throw new Refused(409, refusals);
    if (chosen.health.warming === false)
      because.push(
        `${chosen.config.id} is warm since ${new Date(chosen.health.firstTokenAt ?? 0).toISOString()}`,
      );
    const g: Grant = {
      grant: `g_${randomBytes(9).toString("base64url")}`,
      purpose: purposeId,
      content,
      model: entry.id,
      backend: chosen.config.id,
      locality: chosen.config.locality,
      limits: { context_tokens: entry.contextWindow, max_output_tokens: entry.maxTokens },
      capabilities: {
        tools: true,
        structured: "strict",
        reasoning: entry.reasoning ? ["off", "low", "medium", "high"] : ["off"],
      },
      budget: { remaining_tokens: null, resets: null },
      chose_because: because,
      expires_at: Date.now() + 15 * 60_000,
    };
    this.grants.set(g.grant, g);
    return g;
  }

  identifierShapeOf(text: string): string | null {
    return identifierShape(text);
  }

  /** A grant by id, unexpired. */
  take(id: string): Grant | undefined {
    const g = this.grants.get(id);
    if (!g) return undefined;
    if (g.expires_at < Date.now()) {
      this.grants.delete(id);
      return undefined;
    }
    return g;
  }
}
