// SPDX-License-Identifier: AGPL-3.0-only
// The ledger (§8.7): one row per stream, in counts, and the Prometheus
// counters and histograms with the same rule: no content, no display name.

import type { Store } from "./store.js";

export interface Row {
  subject: string;
  purpose: string | null;
  model: string | null;
  backend: string | null;
  grantId: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  gpuSeconds: number;
  money: number;
  ttftMs: number | null;
  totalMs: number | null;
  outcome: "completed" | "refused" | "error" | "aborted" | "capped";
  refusal?: { layer: string; fact: string };
  /** The client key the stream was spent under (record 47), where a client key called. */
  clientKey?: string | null;
}

const TTFT_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32];

export class Ledger {
  private readonly counters = new Map<string, number>();
  private readonly ttft: number[] = new Array(TTFT_BUCKETS.length + 1).fill(0);
  private ttftSum = 0;
  private ttftCount = 0;
  constructor(private readonly store: Store) {}

  record(r: Row): void {
    this.store.db
      .prepare(
        `INSERT INTO ledger (at, subject, purpose, model, backend, grant_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, gpu_seconds, money, ttft_ms, total_ms, outcome, refusal_layer, refusal_fact, client_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        r.subject,
        r.purpose,
        r.model,
        r.backend,
        r.grantId,
        r.input,
        r.output,
        r.cacheRead,
        r.cacheWrite,
        r.reasoning,
        r.gpuSeconds,
        r.money,
        r.ttftMs,
        r.totalMs,
        r.outcome,
        r.refusal?.layer ?? null,
        r.refusal?.fact ?? null,
        r.clientKey ?? null,
      );
    const key = `${r.backend ?? "none"}|${r.model ?? "none"}|${r.outcome}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    const tok = `tokens|${r.backend ?? "none"}|${r.model ?? "none"}`;
    this.counters.set(`${tok}|input`, (this.counters.get(`${tok}|input`) ?? 0) + r.input);
    this.counters.set(`${tok}|output`, (this.counters.get(`${tok}|output`) ?? 0) + r.output);
    if (r.ttftMs != null) {
      const s = r.ttftMs / 1000;
      let i = TTFT_BUCKETS.findIndex((b) => s <= b);
      if (i < 0) i = TTFT_BUCKETS.length;
      for (let j = i; j < this.ttft.length; j++) this.ttft[j] += 1;
      this.ttftSum += s;
      this.ttftCount += 1;
    }
  }

  /**
   * The rows of client keys older than `days` days let go (record 47, R8: the
   * ledger keeps 90 days of counts per key). The rows of NILS's own streams
   * are kept as before.
   */
  prune(days: number): number {
    return Number(
      this.store.db
        .prepare("DELETE FROM ledger WHERE client_key IS NOT NULL AND at < ?")
        .run(Date.now() - days * 86_400_000).changes,
    );
  }

  /** The rows a caller may read: an admin every row, anyone else their own. */
  rows(subject: string | null, limit = 200): Record<string, unknown>[] {
    const sql = subject
      ? "SELECT * FROM ledger WHERE subject = ? ORDER BY id DESC LIMIT ?"
      : "SELECT * FROM ledger ORDER BY id DESC LIMIT ?";
    const st = this.store.db.prepare(sql);
    return (subject ? st.all(subject, limit) : st.all(limit)) as Record<string, unknown>[];
  }

  /** Prometheus text; labels are backend, model and outcome, never a subject or a name. */
  metrics(): string {
    const lines: string[] = ["# TYPE kvasir_streams_total counter"];
    for (const [k, v] of this.counters) {
      const parts = k.split("|");
      if (parts[0] === "tokens") {
        continue;
      }
      lines.push(
        `kvasir_streams_total{backend="${parts[0]}",model="${parts[1]}",outcome="${parts[2]}"} ${v}`,
      );
    }
    lines.push("# TYPE kvasir_tokens_total counter");
    for (const [k, v] of this.counters) {
      const parts = k.split("|");
      if (parts[0] !== "tokens") continue;
      lines.push(
        `kvasir_tokens_total{backend="${parts[1]}",model="${parts[2]}",direction="${parts[3]}"} ${v}`,
      );
    }
    lines.push("# TYPE kvasir_ttft_seconds histogram");
    for (const [i, b] of TTFT_BUCKETS.entries()) {
      lines.push(`kvasir_ttft_seconds_bucket{le="${b}"} ${this.ttft[i]}`);
    }
    lines.push(`kvasir_ttft_seconds_bucket{le="+Inf"} ${this.ttft[TTFT_BUCKETS.length]}`);
    lines.push(`kvasir_ttft_seconds_sum ${this.ttftSum}`);
    lines.push(`kvasir_ttft_seconds_count ${this.ttftCount}`);
    return `${lines.join("\n")}\n`;
  }
}
