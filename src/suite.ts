// SPDX-License-Identifier: AGPL-3.0-only
// The admission suite (Wave 4c §8.6): a local model is not in the catalog
// until it has passed, recorded with a date, the runtime version and the
// build, and re-run on every runtime upgrade. Five checks, all mechanical:
// tool calls over our own schemas, the chat template, enforced schemas with
// the negative control, overflow, stream integrity. No model judges another
// model's admission. And, for C4, Kvasir's own overhead against the direct
// path, measured in this process.

import type { AssistantMessage, AssistantMessageEvent, Context, Tool } from "@earendil-works/pi-ai";
import type { Backend } from "./backends.js";
import type { ModelEntry } from "./config.js";
import { type CallFixture, FIXTURES, TOOLS, type ToolFixture } from "./fixtures/suite.js";

export type CheckName = "tool_calls" | "chat_template" | "enforced_schema" | "overflow" | "stream_integrity";

export interface Check {
  name: CheckName;
  /** true passed, false failed, null not applicable to this shape. */
  passed: boolean | null;
  detail: string;
  measured: Record<string, unknown>;
}

export interface Runtime {
  name: string;
  version: string;
  build: string;
}

export interface Overhead {
  streams: number;
  rounds: number;
  /** Each round's wall clock for the streams, by path. */
  rounds_ms?: { round: number; how: "direct" | "via"; ms: number }[];
  prompt_tokens: number;
  direct: { p50: number; p95: number; n: number };
  via: { p50: number; p95: number; n: number };
  /** via minus direct, in ms. */
  overhead: { p50: number; p95: number };
  within: boolean;
}

export interface AdmissionRecord {
  id?: number;
  backend: string;
  model: string;
  runtime: Runtime;
  at: number;
  passed: boolean;
  checks: Check[];
  /** The catalog flag of check 4. */
  overflow: "error" | "truncated" | "accepted" | "unknown";
  overhead: Overhead | null;
  kvasir: string;
}

/** The thresholds of §8.10 that the suite applies. */
export const THRESHOLDS = {
  tool_validity: 0.95,
  overhead_p50_ms: 50,
  overhead_p95_ms: 200,
};

/** The whole answer of one stream: the message, or the error, and the first token's time. */
export async function collect(events: AsyncIterable<AssistantMessageEvent>): Promise<{
  message: AssistantMessage | null;
  error: string | null;
  reason: string | null;
  ttftMs: number | null;
}> {
  const started = Date.now();
  let ttftMs: number | null = null;
  for await (const ev of events) {
    if (
      ttftMs === null &&
      (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")
    ) {
      ttftMs = Date.now() - started;
    }
    if (ev.type === "done") return { message: ev.message, error: null, reason: ev.reason, ttftMs };
    if (ev.type === "error")
      return { message: ev.error, error: ev.error.errorMessage ?? "error", reason: ev.reason, ttftMs };
  }
  return { message: null, error: "the stream ended without done", reason: null, ttftMs };
}

function textOf(m: AssistantMessage | null): string {
  return (m?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
}

function callsOf(m: AssistantMessage | null): { name: string; arguments: Record<string, unknown> }[] {
  return (m?.content ?? []).flatMap((c) =>
    c.type === "toolCall"
      ? [{ name: c.name, arguments: (c.arguments ?? {}) as Record<string, unknown> }]
      : [],
  );
}

/** Whether the fixture's expected value is carried by the actual one: every named key and every listed element, extra keys allowed. */
export function matches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((e, i) => matches(e, actual[i]))
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
      matches(v, (actual as Record<string, unknown>)[k]),
    );
  }
  return expected === actual;
}

/** A small validator over our own schemas: required present, no unknown key, top-level types right. */
export function wellFormed(args: Record<string, unknown>, schema: Record<string, unknown>): string | null {
  const props = (schema.properties ?? {}) as Record<string, { type?: string | string[] }>;
  const required = (schema.required ?? []) as string[];
  for (const r of required) if (!(r in args)) return `missing ${r}`;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) return `unknown argument ${k}`;
    const types = Array.isArray(p.type) ? p.type : p.type ? [p.type] : [];
    if (types.length === 0) continue;
    const ok = types.some((t) => {
      switch (t) {
        case "string":
          return typeof v === "string";
        case "integer":
          return Number.isInteger(v);
        case "number":
          return typeof v === "number";
        case "boolean":
          return typeof v === "boolean";
        case "object":
          return typeof v === "object" && v !== null && !Array.isArray(v);
        case "array":
          return Array.isArray(v);
        case "null":
          return v === null;
        default:
          return true;
      }
    });
    if (!ok) return `${k} is not ${types.join(" or ")}`;
  }
  return null;
}

function piTools(list: ToolFixture[], strict: boolean): Tool[] {
  return list.map(
    (t) =>
      ({
        name: t.name,
        description: t.description,
        parameters: t.parameters as never,
        ...(strict ? { constrainedSampling: { type: "json_schema", strict: "require" } } : {}),
      }) as Tool,
  );
}

const SYSTEM =
  "You are a tool-calling assistant for a research registry. Answer every request with exactly one tool call and no prose.";

function user(content: string): Context["messages"][number] {
  return { role: "user", content, timestamp: Date.now() };
}

/** Check 1: twenty fixtures produce well-formed calls against our own schemas. */
export async function toolCalls(
  backend: Backend,
  entry: ModelEntry,
  fixtures: CallFixture[] = FIXTURES,
): Promise<Check> {
  const tools = piTools(TOOLS, false);
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const results: { prompt: string; ok: boolean; why: string }[] = [];
  for (const f of fixtures) {
    const out = await collect(
      backend.stream(
        entry,
        { systemPrompt: SYSTEM, messages: [user(f.prompt)], tools },
        { temperature: 0, maxTokens: 512 },
      ),
    );
    const calls = callsOf(out.message);
    let why = "";
    let ok = false;
    if (out.error) why = `error: ${out.error}`;
    else if (calls.length !== 1) why = `${calls.length} calls`;
    else if (calls[0].name !== f.tool) why = `called ${calls[0].name}, expected ${f.tool}`;
    else {
      const bad = wellFormed(calls[0].arguments, byName.get(f.tool)?.parameters ?? {});
      if (bad) why = bad;
      else {
        const missing = Object.entries(f.args).find(([k, v]) => !matches(v, calls[0].arguments[k]));
        if (missing)
          why = `${missing[0]} is ${JSON.stringify(calls[0].arguments[missing[0]])}, expected ${JSON.stringify(missing[1])}`;
        else ok = true;
      }
    }
    results.push({ prompt: f.prompt, ok, why });
  }
  const valid = results.filter((r) => r.ok).length / Math.max(1, results.length);
  return {
    name: "tool_calls",
    passed: valid >= THRESHOLDS.tool_validity,
    detail: `${results.filter((r) => r.ok).length} of ${results.length} well formed (${valid.toFixed(2)}; the bar is ${THRESHOLDS.tool_validity})`,
    measured: { validity: valid, failures: results.filter((r) => !r.ok) },
  };
}

/** Check 2: a system message in the position our clients send it is accepted. */
export async function chatTemplate(backend: Backend, entry: ModelEntry): Promise<Check> {
  const out = await collect(
    backend.stream(
      entry,
      {
        systemPrompt: "You answer with one word and nothing else.",
        messages: [user("Answer with the single word: ready")],
      },
      { temperature: 0, maxTokens: 256 },
    ),
  );
  const text = textOf(out.message).trim();
  const passed = !out.error && text.length > 0;
  return {
    name: "chat_template",
    passed,
    detail: out.error ? `error: ${out.error}` : `answered ${JSON.stringify(text.slice(0, 40))}`,
    measured: { text: text.slice(0, 80), error: out.error },
  };
}

const CLAUSE_TOOL: ToolFixture = {
  name: "where_clause",
  description: "Add a where clause: an operator and at least two operands.",
  parameters: {
    type: "object",
    properties: {
      clause: {
        type: "array",
        description: "the operator, then the operands",
        items: { type: "string" },
        minItems: 2,
      },
    },
    required: ["clause"],
  },
};

/**
 * Check 3: a real schema with minItems is either enforced or refused, never
 * accepted and ignored. The negative control asks for a one-element clause,
 * which a backend honouring minItems: 2 cannot produce.
 */
export async function enforcedSchema(backend: Backend, entry: ModelEntry): Promise<Check> {
  const tools = piTools([CLAUSE_TOOL], true);
  // the call is forced, so a model cannot dodge the control by answering in prose
  const toolChoice = { type: "function", function: { name: CLAUSE_TOOL.name } };
  const positive = await collect(
    backend.stream(
      entry,
      {
        systemPrompt: SYSTEM,
        messages: [user('Call where_clause with the clause ["=", "base", "T1w"].')],
        tools,
      },
      { temperature: 0, maxTokens: 1024, toolChoice },
    ),
  );
  const pos = callsOf(positive.message)[0];
  const negative = await collect(
    backend.stream(
      entry,
      {
        systemPrompt: SYSTEM,
        messages: [
          user('Call where_clause with a clause holding exactly one element: ["T1w"]. One element, no more.'),
        ],
        tools,
      },
      { temperature: 0, maxTokens: 1024, toolChoice },
    ),
  );
  const neg = callsOf(negative.message)[0];
  const negClause = Array.isArray(neg?.arguments.clause) ? (neg?.arguments.clause as unknown[]) : null;
  const posClause = pos?.arguments.clause;
  const positiveOk = !positive.error && Array.isArray(posClause) && posClause.length >= 2;
  let verdict: "enforced" | "refused" | "ignored" | "inconclusive";
  if (!positiveOk) verdict = "inconclusive";
  else if (negative.error) verdict = "refused";
  else if (negClause && negClause.length === 1) verdict = "ignored";
  else if (negClause && negClause.length >= 2) verdict = "enforced";
  else verdict = "inconclusive";
  const passed = verdict === "enforced" || verdict === "refused";
  return {
    name: "enforced_schema",
    passed,
    detail: `minItems 2 is ${verdict}; the positive call ${positiveOk ? "carried two or more operands" : `did not (${positive.error ?? "no clause"})`}`,
    measured: {
      verdict,
      positive: pos?.arguments ?? null,
      negative: neg?.arguments ?? null,
      negative_error: negative.error,
      positive_error: positive.error,
      negative_text: textOf(negative.message).slice(0, 200),
      negative_reason: negative.reason,
    },
  };
}

/** Roughly n tokens of distinct words. */
export function filler(tokens: number, seed = 7): string {
  const words = [
    "registry",
    "session",
    "stack",
    "cohort",
    "axis",
    "release",
    "handle",
    "window",
    "scheme",
    "digest",
    "linkage",
    "review",
    "batch",
    "pack",
    "verdict",
    "evidence",
  ];
  const out: string[] = [];
  let x = seed;
  for (let i = 0; i < tokens; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(words[x % words.length]);
  }
  return out.join(" ");
}

/**
 * Check 4: a deliberately oversized prompt yields a matching error, a silent
 * truncation with a length stop and zero output, or a silent accept; the
 * answer is published as a catalog flag.
 */
export async function overflow(backend: Backend, entry: ModelEntry): Promise<Check> {
  const prompt = `Repeat the last word of this text.\n${filler(Math.round(entry.contextWindow * 1.25))}`;
  const out = await collect(
    backend.stream(entry, { messages: [user(prompt)] }, { temperature: 0, maxTokens: 32 }),
  );
  const text = textOf(out.message);
  let flag: AdmissionRecord["overflow"];
  if (out.error) flag = "error";
  else if (out.reason === "length" && text.trim().length === 0) flag = "truncated";
  else flag = "accepted";
  return {
    name: "overflow",
    // every answer is a pass: the flag is what is published
    passed: true,
    detail: `an oversized prompt is ${flag === "error" ? "refused with an error" : flag === "truncated" ? "silently truncated (length stop, no output)" : "silently accepted"}`,
    measured: { flag, error: out.error, reason: out.reason, output_chars: text.length },
  };
}

/** Check 5: a thinking block's signature survives the round trip byte-identical. */
export async function streamIntegrity(backend: Backend, entry: ModelEntry): Promise<Check> {
  if (!entry.reasoning)
    return {
      name: "stream_integrity",
      passed: null,
      detail: "the model does not reason; no signature to carry",
      measured: {},
    };
  const first = await collect(
    backend.stream(
      entry,
      { messages: [user("Think briefly, then answer: what is 17 + 25?")] },
      { temperature: 0, maxTokens: 512 },
    ),
  );
  if (first.error || !first.message)
    return {
      name: "stream_integrity",
      passed: false,
      detail: `the first turn failed: ${first.error}`,
      measured: {},
    };
  const thinking = first.message.content.find((c) => c.type === "thinking");
  let signature = thinking && thinking.type === "thinking" ? (thinking.thinkingSignature ?? "") : "";
  // pi's openai adapter marks which field the reasoning came from; that is a name, not a signature
  if (["reasoning_content", "reasoning", "reasoning_text"].includes(signature)) signature = "";
  if (!signature)
    return {
      name: "stream_integrity",
      passed: null,
      detail: "this shape carries no signature on its thinking",
      measured: { thinking: Boolean(thinking) },
    };
  // the assistant message back, byte for byte, then one more turn
  const second = await collect(
    backend.stream(
      entry,
      {
        messages: [
          user("Think briefly, then answer: what is 17 + 25?"),
          first.message,
          user("And add 1 to that."),
        ],
      },
      { temperature: 0, maxTokens: 512 },
    ),
  );
  const passed = !second.error;
  return {
    name: "stream_integrity",
    passed,
    detail: passed
      ? `a ${signature.length} byte signature went back and the turn was accepted`
      : `the turn with the signature was refused: ${second.error}`,
    measured: { signature_bytes: signature.length, error: second.error },
  };
}

/** The runtime behind a backend: SGLang's server info when it answers, else what the configuration recorded, else unknown. */
export async function probeRuntime(backend: Backend, entry?: ModelEntry): Promise<Runtime> {
  const c = backend.config;
  if (c.runtime) return c.runtime;
  if (c.locality === "remote")
    return { name: c.provider ?? c.id, version: "remote", build: entry?.upstream ?? entry?.id ?? "" };
  const root = c.baseUrl.replace(/\/v1\/?$/u, "");
  for (const path of ["/get_server_info", "/version"]) {
    try {
      const r = await fetch(`${root}${path}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = (await r.json()) as Record<string, unknown>;
      const version = String(j.version ?? "");
      if (!version) continue;
      const build = [j.model_path, j.attention_backend, j.speculative_algorithm, j.grammar_backend]
        .filter(Boolean)
        .map(String)
        .join(" ");
      return { name: "sglang", version, build: build || String(j.served_model_name ?? "") };
    } catch {
      // the next path, or unknown
    }
  }
  return { name: "unknown", version: "unknown", build: "" };
}

export interface SuiteOptions {
  fixtures?: CallFixture[];
  /** Which checks to run; all when absent. */
  only?: CheckName[];
  log?: (line: string) => void;
}

/** The suite over one model of one backend. */
export async function runSuite(
  backend: Backend,
  entry: ModelEntry,
  opts: SuiteOptions = {},
): Promise<AdmissionRecord> {
  const log = opts.log ?? (() => undefined);
  const runtime = await probeRuntime(backend, entry);
  log(`runtime ${runtime.name} ${runtime.version} ${runtime.build}`.trim());
  const all: [CheckName, () => Promise<Check>][] = [
    ["tool_calls", () => toolCalls(backend, entry, opts.fixtures)],
    ["chat_template", () => chatTemplate(backend, entry)],
    ["enforced_schema", () => enforcedSchema(backend, entry)],
    ["overflow", () => overflow(backend, entry)],
    ["stream_integrity", () => streamIntegrity(backend, entry)],
  ];
  const checks: Check[] = [];
  for (const [name, run] of all) {
    if (opts.only && !opts.only.includes(name)) continue;
    log(`${name}...`);
    const c = await run();
    log(`  ${c.passed === null ? "n/a" : c.passed ? "pass" : "FAIL"}: ${c.detail}`);
    checks.push(c);
  }
  const overflowFlag =
    (checks.find((c) => c.name === "overflow")?.measured.flag as AdmissionRecord["overflow"] | undefined) ??
    "unknown";
  return {
    backend: backend.config.id,
    model: entry.id,
    runtime,
    at: Date.now(),
    passed: checks.every((c) => c.passed !== false),
    checks,
    overflow: overflowFlag,
    overhead: null,
    kvasir: "",
  };
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}

/**
 * Kvasir's own overhead: N concurrent streams straight at the backend and N
 * through Kvasir's door in this process, the same prompt and the same
 * client; the difference of the times to first token is the overhead.
 */
export async function measureOverhead(
  backend: Backend,
  entry: ModelEntry,
  via: (context: Context, maxTokens: number) => AsyncIterable<AssistantMessageEvent>,
  opts: { streams?: number; rounds?: number; promptTokens?: number; log?: (line: string) => void } = {},
): Promise<Overhead> {
  const streams = opts.streams ?? 8;
  const rounds = opts.rounds ?? 4;
  const promptTokens = opts.promptTokens ?? 4096;
  const log = opts.log ?? (() => undefined);
  const direct: number[] = [];
  const through: number[] = [];
  const roundsMs: { round: number; how: "direct" | "via"; ms: number }[] = [];
  const one = async (context: Context, how: "direct" | "via", record = true) => {
    const events =
      how === "direct" ? backend.stream(entry, context, { temperature: 0, maxTokens: 32 }) : via(context, 32);
    const out = await collect(events);
    if (record && out.ttftMs !== null) (how === "direct" ? direct : through).push(out.ttftMs);
  };
  // a distinct prefix per stream so the prompt cache does not decide the answer
  const contexts = Array.from({ length: streams }, (_, i) => ({
    messages: [user(`${filler(promptTokens, 100 + i)}\nAnswer with the single word: ready`)],
  }));
  // the first request of every run is discarded (§8.10), and every prefix
  // is warmed once so the prompt cache favours neither path; the order of
  // the two paths alternates by round for the same reason
  await Promise.all(contexts.map((c) => one(c, "direct", false)));
  for (let r = 0; r < rounds; r++) {
    const order: ("direct" | "via")[] = r % 2 === 0 ? ["direct", "via"] : ["via", "direct"];
    for (const how of order) {
      const t0 = Date.now();
      await Promise.all(contexts.map((c) => one(c, how)));
      roundsMs.push({ round: r + 1, how, ms: Date.now() - t0 });
      log(`round ${r + 1} ${how}: ${streams} streams in ${Date.now() - t0} ms`);
    }
  }
  const d = { p50: percentile(direct, 0.5), p95: percentile(direct, 0.95), n: direct.length };
  const v = { p50: percentile(through, 0.5), p95: percentile(through, 0.95), n: through.length };
  const overhead = { p50: v.p50 - d.p50, p95: v.p95 - d.p95 };
  return {
    streams,
    rounds,
    prompt_tokens: promptTokens,
    rounds_ms: roundsMs,
    direct: d,
    via: v,
    overhead,
    within: overhead.p50 <= THRESHOLDS.overhead_p50_ms && overhead.p95 <= THRESHOLDS.overhead_p95_ms,
  };
}
