// SPDX-License-Identifier: AGPL-3.0-only
// The runtime Kvasir loads the models it downloaded on (record 24): llama.cpp's
// server in router mode, a pinned build the deployment installs and keeps
// running with no model loaded. An admin starts a finished GGUF download; Kvasir
// writes its preset, has the runtime read the presets again and load it, and
// follows it to loaded or failed. Loaded, the model is held on the backend
// `llama-cpp` as a local model, warmed and admitted as any other; failed, its
// row keeps the exit and the last lines of that model's log. One model runs at
// a time, as the runtime's `--models-max 1`. What an admin started is kept in
// the database: a model that was serving is loaded again, once, when Kvasir or
// the runtime starts again, and a start from the command line is carried on by
// a Kvasir serving the database.
//
// A start is safe on memory. A model opens with the context it declares in its
// GGUF header up to 32,768 tokens, or with the context the start names. Where the
// runtime computes on the processor, the memory the load needs is reckoned
// first, and the context halved, or the start refused, where the machine has too
// little free. A load the runtime did not survive, as when the kernel stops it
// for lack of memory, is failed and never asked for again on its own.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { freemem } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Backends } from "./backends.js";
import type { BackendConfig, ModelEntry, RuntimeConfig } from "./config.js";
import type { Credentials } from "./credentials.js";
import { type GgufLayout, ggufLayout, kvBytesPerToken } from "./gguf.js";
import { type Held, idFrom, RUNTIME_BACKEND } from "./held.js";
import {
  ggufOf,
  type Local,
  LocalRefused,
  type LocalRow,
  type LocalState,
  messageOf,
  readable,
} from "./local.js";
import type { Store } from "./store.js";

export const RUN_SCHEMA = `CREATE TABLE IF NOT EXISTS local_run (
     model_id INTEGER PRIMARY KEY,
     served_as TEXT NOT NULL UNIQUE,
     file TEXT NOT NULL,
     mmproj TEXT,
     wanted INTEGER NOT NULL,
     state TEXT NOT NULL,
     error TEXT,
     log TEXT NOT NULL DEFAULT '[]',
     context INTEGER,
     slots INTEGER,
     reasoning INTEGER NOT NULL DEFAULT 0,
     started_by TEXT,
     started_at INTEGER,
     asked_at INTEGER,
     ctx_size INTEGER,
     needs INTEGER,
     note TEXT,
     served INTEGER NOT NULL DEFAULT 0
   )`;

/** The columns a run gained once starts were made safe on memory, added to a database kept from before. */
const RUN_COLUMNS: [string, string][] = [
  ["ctx_size", "INTEGER"],
  ["needs", "INTEGER"],
  ["note", "TEXT"],
  ["served", "INTEGER NOT NULL DEFAULT 0"],
];

/** The most context a started model opens with unless the start names more: what the stations are written against. */
export const CONTEXT_CAP = 32_768;
/** The least context a start may name. */
export const CONTEXT_LEAST = 4_096;
/** The least Kvasir shortens a context to where memory is short. */
export const CONTEXT_FLOOR = 8_192;
/** The memory kept free beyond what a load is reckoned to need. */
export const SPARE_MEMORY = 2 ** 30;
/** Why a load the runtime did not survive is failed and not asked for again. */
export const STOPPED_WHILE_LOADING =
  "the runtime stopped while loading this model, most likely for lack of memory";

export type RunState = "starting" | "serving" | "stopped" | "failed";

/** A local model's run on the runtime, as the Kvasir page reads it. */
export interface Run {
  state: RunState;
  /** The id the runtime and Kvasir's catalog know the model by. */
  model: string;
  error: string | null;
  /** What Kvasir chose for this start and why, such as a context shortened for the memory free. */
  note: string | null;
  /** The last lines of the runtime's log for a load that failed. */
  log: string[];
  /** The context and the slots the runtime settled on, once the model is loaded. */
  context: number | null;
  slots: number | null;
  started_by: string | null;
  started_at: number | null;
}

/** The runtime as `GET /v1/local` shows it. */
export interface RuntimeStatus {
  build: string;
  variant: string;
  reachable: boolean;
  /** The local model loaded now, by its id among the downloads; null where none is. */
  serving: number | null;
}

/** One model as the runtime lists it. */
export interface RouterModel {
  id: string;
  state: "unloaded" | "loading" | "loaded";
  exitCode: number | null;
  failed: boolean;
  /** The port of the model's own process, from its arguments: the prefix of its lines in the runtime's log. */
  port: number | null;
}

interface StoredRun {
  model_id: number;
  served_as: string;
  file: string;
  mmproj: string | null;
  wanted: number;
  state: RunState;
  error: string | null;
  log: string;
  context: number | null;
  slots: number | null;
  reasoning: number;
  started_by: string | null;
  started_at: number | null;
  asked_at: number | null;
  /** The context the preset opens the model with. */
  ctx_size: number | null;
  /** The memory the load was reckoned to need, where the runtime computes on the processor. */
  needs: number | null;
  note: string | null;
  /** Whether the model has served since it was started: a model that has is loaded again, once, after the runtime lost it. */
  served: number;
}

/** A started model as the presets name it: its id, its file, its vision projector and the context it opens with. */
export interface Preset {
  id: string;
  model: string;
  mmproj: string | null;
  context: number;
}

/**
 * The presets file whole: the settings every model gets, then a section per
 * started model. An 8-bit KV cache, never 4-bit, which degrades tool calls; the
 * context Kvasir chose for the start; the model's own chat template.
 */
export function presetsText(presets: Preset[]): string {
  const lines = ["[*]", "cache-type-k = q8_0", "cache-type-v = q8_0"];
  for (const p of presets) {
    lines.push("", `[${p.id}]`, `model = ${p.model}`, `ctx-size = ${p.context}`);
    if (p.mmproj) lines.push(`mmproj = ${p.mmproj}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Whether a runtime computes on the processor, as the variant of its build's archive names it. */
export function onProcessor(variant: string): boolean {
  return !/vulkan|rocm|macos/iu.test(variant);
}

/** A number of tokens as a person reads it. */
function tokens(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The memory this machine has free for a load: MemAvailable where Linux says
 * it, and no more than the room any memory limit on Kvasir's own cgroup or one
 * above it leaves, as a container's does, counting its inactive file cache as
 * free; the free memory the system reports elsewhere.
 */
export function memoryAvailable(): number {
  let free = freemem();
  try {
    const m = /^MemAvailable:\s+(\d+) kB$/mu.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m) free = Number(m[1]) * 1024;
  } catch {
    // not Linux
  }
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    let path = line ? line.slice(3).trim() || "/" : null;
    while (path !== null) {
      const dir = join("/sys/fs/cgroup", path);
      try {
        const max = readFileSync(join(dir, "memory.max"), "utf8").trim();
        if (max !== "max") {
          const current = Number(readFileSync(join(dir, "memory.current"), "utf8").trim());
          const cache = /^inactive_file (\d+)$/mu.exec(readFileSync(join(dir, "memory.stat"), "utf8"));
          const room = Number(max) - current + (cache ? Number(cache[1]) : 0);
          if (Number.isFinite(room)) free = Math.min(free, Math.max(0, room));
        }
      } catch {
        // no limit at this level
      }
      path = path === "/" ? null : dirname(path);
    }
  } catch {
    // no unified cgroup hierarchy
  }
  return free;
}

/** The bytes of a started model's files on disk: every part of a split file, and the vision projector that goes with it. */
export function filesBytes(path: string, file: string, mmproj: string | null): number {
  const size = (f: string) => {
    try {
      return statSync(join(path, f)).size;
    } catch {
      return 0;
    }
  };
  let total = mmproj ? size(mmproj) : 0;
  const split = /^(.*-)\d{5}-of-(\d{5})\.gguf$/iu.exec(file);
  if (split) {
    for (let n = 1; n <= Number(split[2]); n += 1)
      total += size(`${split[1]}${String(n).padStart(5, "0")}-of-${split[2]}.gguf`);
  } else total += size(file);
  return total;
}

/** The words of a runtime's error answer, where it gave any. */
function errorOf(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? message : "";
}

/** llama.cpp's server in router mode, asked with the key only Kvasir and the runtime read. */
export class LlamaRouter {
  constructor(
    readonly config: RuntimeConfig,
    private readonly timeoutMs = 10_000,
  ) {}

  /** The key, from its file: the first line that is not a comment, read at each use. */
  key(): string {
    const line = readFileSync(this.config.keyFile, "utf8")
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("#"));
    if (!line) throw new Error(`${this.config.keyFile} holds no key`);
    return line;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const r = await fetch(`${this.config.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await r.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed };
  }

  /** The models the runtime knows from its presets, each with its state; with `reload`, the presets read again first. */
  async models(reload = false): Promise<RouterModel[]> {
    const { status, body } = await this.call("GET", reload ? "/models?reload=1" : "/models");
    if (status !== 200) {
      const words = errorOf(body);
      throw new Error(`it answered ${status} to /models${words ? `: ${words}` : ""}`);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new Error("its /models listed no data");
    return data.flatMap((raw): RouterModel[] => {
      const m = (raw ?? {}) as { id?: unknown; status?: unknown };
      if (typeof m.id !== "string") return [];
      const s = (m.status ?? {}) as {
        value?: unknown;
        exit_code?: unknown;
        failed?: unknown;
        args?: unknown;
      };
      const args = Array.isArray(s.args) ? s.args.map(String) : [];
      const at = args.indexOf("--port");
      const port = at >= 0 ? Number(args[at + 1]) : Number.NaN;
      return [
        {
          id: m.id,
          state: s.value === "loaded" || s.value === "loading" ? s.value : "unloaded",
          exitCode: typeof s.exit_code === "number" ? s.exit_code : null,
          failed: s.failed === true,
          port: Number.isInteger(port) && port > 0 ? port : null,
        },
      ];
    });
  }

  /** The runtime asked to load a model; one already loading or loaded is fine. */
  async load(id: string): Promise<void> {
    const { status, body } = await this.call("POST", "/models/load", { model: id });
    if (status === 200 || (status === 400 && /already running/iu.test(errorOf(body)))) return;
    throw new Error(
      `the runtime answered ${status} to loading ${id}${errorOf(body) ? `: ${errorOf(body)}` : ""}`,
    );
  }

  /** The runtime asked to unload a model; one not running is fine. */
  async unload(id: string): Promise<void> {
    const { status, body } = await this.call("POST", "/models/unload", { model: id });
    if (status === 200 || (status === 400 && /not running/iu.test(errorOf(body)))) return;
    throw new Error(
      `the runtime answered ${status} to unloading ${id}${errorOf(body) ? `: ${errorOf(body)}` : ""}`,
    );
  }

  /** What a loaded model settled on: its context, its slots, and whether its chat template thinks. */
  async props(id: string): Promise<{ context: number | null; slots: number | null; reasoning: boolean }> {
    const { status, body } = await this.call("GET", `/props?model=${encodeURIComponent(id)}`);
    if (status !== 200 || typeof body !== "object" || body === null)
      return { context: null, slots: null, reasoning: false };
    const p = body as {
      n_ctx?: unknown;
      default_generation_settings?: { n_ctx?: unknown };
      total_slots?: unknown;
      chat_template?: unknown;
    };
    const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
    return {
      context: whole(p.n_ctx) ?? whole(p.default_generation_settings?.n_ctx),
      slots: whole(p.total_slots),
      reasoning: typeof p.chat_template === "string" && /enable_thinking|<think>/u.test(p.chat_template),
    };
  }

  /** The last lines a model's own process wrote to the runtime's log, found by the port that prefixes them. */
  tail(port: number | null, lines = 20): string[] {
    if (port === null) return [];
    let text: string;
    try {
      const size = statSync(this.config.log).size;
      const from = Math.max(0, size - 256 * 1024);
      const fd = openSync(this.config.log, "r");
      try {
        const buffer = Buffer.alloc(size - from);
        readSync(fd, buffer, 0, buffer.length, from);
        text = buffer.toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }
    const prefix = `[${port}]`;
    return text
      .split(/\r?\n/u)
      .filter((l) => l.startsWith(prefix))
      .slice(-lines)
      .map((l) => l.slice(0, 400));
  }

  /** The presets file written whole where it differs, through a file beside it renamed over it, so the runtime never reads half. */
  writePresets(text: string): boolean {
    let now: string | null = null;
    try {
      now = readFileSync(this.config.presets, "utf8");
    } catch {
      // none yet
    }
    if (now === text) return false;
    const beside = `${this.config.presets}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(beside, text);
    try {
      renameSync(beside, this.config.presets);
    } catch (e) {
      rmSync(beside, { force: true });
      throw e;
    }
    return true;
  }
}

function runOf(r: StoredRun): Run {
  let log: string[] = [];
  try {
    const parsed = JSON.parse(r.log) as unknown;
    if (Array.isArray(parsed)) log = parsed.map(String);
  } catch {
    // none kept
  }
  return {
    state: r.state,
    model: r.served_as,
    error: r.error,
    note: r.note ?? null,
    log,
    context: r.context,
    slots: r.slots,
    started_by: r.started_by,
    started_at: r.started_at,
  };
}

/** Whether Kvasir asked the runtime to load a run's model and the load has not ended yet. */
function loading(r: StoredRun): boolean {
  return r.state === "starting" && r.asked_at !== null;
}

/** What a held runtime backend is, for telling whether it changed: never its key. */
function shapeOf(c: BackendConfig): unknown {
  return {
    baseUrl: c.baseUrl,
    concurrency: c.concurrency,
    runtime: c.runtime,
    models: c.models.map((m) => [m.id, m.name, m.reasoning, m.input, m.contextWindow, m.maxTokens]),
  };
}

export interface RunnerOptions {
  /** How often a serving Kvasir looks at the runtime. */
  pollMs?: number;
  /** How long a started model the runtime does not list, after reading its presets again, waits before its start fails. */
  askAgainMs?: number;
  /** How long after asking a failure the runtime lists counts as that load's. */
  settleMs?: number;
  /** How long a model Kvasir asked to load may stay listed unloaded, with no failure, before the load counts as one the runtime did not survive. */
  loadGraceMs?: number;
  /** The memory this machine has free for a load, in bytes; what Linux and any memory limit above Kvasir leave, unless a test says. */
  freeMemory?: () => number;
}

export class Runner {
  /** What happens to a run, a line each: the server's log, or the command line's. */
  say: (line: string) => void = () => {};
  readonly router: LlamaRouter;
  private readonly pollMs: number;
  private readonly askAgainMs: number;
  private readonly settleMs: number;
  private readonly loadGraceMs: number;
  private readonly freeMemory: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> = Promise.resolve();
  private busy = false;
  private closed = false;
  private seen: { reachable: boolean; models: RouterModel[] } = { reachable: false, models: [] };

  constructor(
    private readonly store: Store,
    private readonly held: Held,
    private readonly backends: Backends,
    private readonly credentials: Credentials,
    private readonly local: Local,
    readonly config: RuntimeConfig,
    opts: RunnerOptions = {},
  ) {
    store.db.exec(RUN_SCHEMA);
    const columns = new Set(store.columns("local_run"));
    for (const [name, type] of RUN_COLUMNS)
      if (!columns.has(name)) store.db.exec(`ALTER TABLE local_run ADD COLUMN ${name} ${type}`);
    this.router = new LlamaRouter(config);
    this.pollMs = opts.pollMs ?? 2_000;
    this.askAgainMs = opts.askAgainMs ?? 30_000;
    this.settleMs = opts.settleMs ?? 1_000;
    this.loadGraceMs = opts.loadGraceMs ?? 10_000;
    this.freeMemory = opts.freeMemory ?? memoryAvailable;
  }

  private runs(): StoredRun[] {
    return this.store.db.prepare("SELECT * FROM local_run ORDER BY model_id").all() as unknown as StoredRun[];
  }

  private stored(id: number): StoredRun | undefined {
    return this.store.db.prepare("SELECT * FROM local_run WHERE model_id = ?").get(id) as unknown as
      | StoredRun
      | undefined;
  }

  private set(id: number, fields: Partial<Omit<StoredRun, "model_id">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    this.store.db
      .prepare(`UPDATE local_run SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE model_id = ?`)
      .run(...(keys.map((k) => fields[k] ?? null) as (string | number | null)[]), id);
  }

  /** A run failed, kept with its reason and any lines of the runtime's log, and not asked for again until an admin starts it. */
  private fail(r: StoredRun, error: string, log: string[] = []): void {
    this.set(r.model_id, {
      wanted: 0,
      state: "failed",
      error,
      log: JSON.stringify(log),
      asked_at: null,
      served: 0,
    });
    this.say(`local model ${r.model_id}: failed: ${error}`);
  }

  /** The GGUF file a download starts with: the one named, or its first; null where it has none on disk. */
  private pick(path: string, files: string[], named?: string): string | null {
    const { models } = ggufOf(files);
    const choice =
      named === undefined
        ? models.find((f) => existsSync(join(path, f)))
        : models.includes(named) && existsSync(join(path, named))
          ? named
          : undefined;
    // the presets hold a path on one line
    return choice !== undefined && !/[\r\n]/u.test(join(path, choice)) ? choice : null;
  }

  /** Whether a download can start, and its run, for its row. */
  view(
    id: number,
    path: string,
    state: LocalState,
    files: string[],
  ): { startable: boolean; run: Run | null } {
    const r = this.stored(id);
    return { startable: state === "done" && this.pick(path, files) !== null, run: r ? runOf(r) : null };
  }

  /** The runtime as the last look at it found it. */
  status(): RuntimeStatus {
    const loaded = new Set(this.seen.models.filter((m) => m.state === "loaded").map((m) => m.id));
    const serving = this.runs().find((r) => r.wanted === 1 && loaded.has(r.served_as));
    return {
      build: this.config.build,
      variant: this.config.variant,
      reachable: this.seen.reachable,
      serving: serving?.model_id ?? null,
    };
  }

  /** Whether an admin started a model and has not stopped it: a started model is not removed. */
  started(id: number): boolean {
    return this.stored(id)?.wanted === 1;
  }

  /** A removed download's run let go. */
  forget(id: number): void {
    this.store.db.prepare("DELETE FROM local_run WHERE model_id = ?").run(id);
  }

  /** A model id from a file's name, which no other backend serves and no other download's run is known by. */
  private freeId(file: string, id: number): string {
    const base = idFrom(basename(file).replace(/(-\d{5}-of-\d{5})?\.gguf$/iu, ""));
    const taken = (candidate: string) => {
      const served = this.backends.find(candidate);
      return (
        (served !== undefined && served.backend.config.id !== RUNTIME_BACKEND) ||
        this.runs().some((r) => r.served_as === candidate && r.model_id !== id)
      );
    };
    let candidate = base;
    for (let n = 2; taken(candidate); n += 1) candidate = `${base.slice(0, 36)}-${n}`;
    return candidate;
  }

  /**
   * The context a start opens a model with, and where the runtime computes on
   * the processor the memory the load is reckoned to need: the model's files,
   * its 8-bit cache for that context and a gibibyte to spare. The context named,
   * else the model's own up to 32,768 tokens; where the machine has too little
   * free, halved down to 8,192 and said, and the start refused where even that
   * is too much. The memory of the model running now counts as free, since it
   * stops for this one.
   */
  private plan(
    id: number,
    path: string,
    file: string,
    mmproj: string | null,
    layout: GgufLayout | null,
    named: number | null,
  ): { context: number; needs: number | null; note: string | null } {
    const chosen = named ?? Math.min(CONTEXT_CAP, layout?.contextLength ?? CONTEXT_CAP);
    if (!onProcessor(this.config.variant)) return { context: chosen, needs: null, note: null };
    const files = filesBytes(path, file, mmproj);
    const perToken = kvBytesPerToken(layout);
    const needs = (context: number) => Math.ceil(files + (perToken ?? 0) * context + SPARE_MEMORY);
    const running = this.runs()
      .filter((r) => r.wanted === 1)
      .reduce((sum, r) => sum + (r.needs ?? 0), 0);
    const free = Math.max(0, this.freeMemory()) + running;
    let context = chosen;
    while (needs(context) > free && perToken !== null && perToken > 0 && context > CONTEXT_FLOOR)
      context = Math.max(CONTEXT_FLOOR, Math.floor(context / 2));
    if (needs(context) > free)
      throw new LocalRefused(
        409,
        "not_enough_memory",
        `model ${id} needs about ${readable(needs(context))} of memory to load with ${tokens(context)} tokens of context (its files ${readable(files)}${perToken ? `, its cache ${readable(Math.ceil(perToken * context))}` : ""} and ${readable(SPARE_MEMORY)} to spare), and this machine has ${readable(free)} free: free some memory, or start a smaller model`,
        { needs_bytes: needs(context), free_bytes: free, context },
      );
    const note =
      context === chosen
        ? null
        : `the context is ${tokens(context)} tokens, not ${tokens(chosen)}: the model needs about ${readable(needs(chosen))} of memory with ${tokens(chosen)}, and this machine has ${readable(free)} free`;
    return { context, needs: needs(context), note };
  }

  /**
   * A finished GGUF download started: refused where it cannot start, the
   * context chosen and, on the processor, the memory checked, the one running
   * stopped first, its run kept as wanted, and one look taken at once; the looks
   * that follow carry it to serving or failed.
   */
  async start(id: number, by: string, file?: unknown, context?: unknown): Promise<LocalRow> {
    const d = this.local.folder(id);
    if (!d) throw new LocalRefused(404, "no_such_model", `no local model ${id}`);
    if (d.state !== "done")
      throw new LocalRefused(
        409,
        "not_downloaded",
        `model ${id} is ${d.state === "failed" ? "a download that failed" : d.state}: a model starts once every file of it is downloaded`,
      );
    if (file !== undefined && typeof file !== "string")
      throw new LocalRefused(
        400,
        "bad_request",
        "file: the GGUF file of the download to start, as it lists it",
      );
    const named = context === undefined || context === null ? null : context;
    if (named !== null && !(typeof named === "number" && Number.isInteger(named)))
      throw new LocalRefused(
        400,
        "bad_request",
        `context: a whole number of tokens, from ${tokens(CONTEXT_LEAST)} up to the model's own`,
      );
    const { models, mmproj } = ggufOf(d.files);
    const chosen = this.pick(d.path, d.files, file);
    if (!chosen) {
      if (models.length === 0)
        throw new LocalRefused(
          409,
          "not_gguf",
          `model ${id} holds no GGUF file, which is what the runtime loads: a model server such as SGLang or vLLM serves it, with the commands shown`,
        );
      if (file !== undefined && !models.includes(file))
        throw new LocalRefused(
          409,
          "not_gguf",
          `${file} is not a GGUF file model ${id} starts with: it starts with ${models.join(", ")}`,
        );
      throw new LocalRefused(
        409,
        "not_downloaded",
        `${file ?? models[0]} is not in ${d.path}: download model ${id} again to start it`,
      );
    }
    const layout = ggufLayout(join(d.path, chosen));
    const own = layout?.contextLength ?? null;
    if (named !== null && (named < CONTEXT_LEAST || (own !== null && named > own)))
      throw new LocalRefused(
        400,
        "bad_request",
        `context: a whole number of tokens from ${tokens(CONTEXT_LEAST)} up to ${own === null ? "the model's own" : `the model's own, ${tokens(own)}`}`,
        { least: CONTEXT_LEAST, most: own },
      );
    try {
      await this.router.models();
    } catch (e) {
      throw new LocalRefused(
        409,
        "runtime_unreachable",
        `the runtime at ${this.config.url} does not answer (${messageOf(e)}); the install runs it as a service beside Kvasir`,
      );
    }
    const plan = this.plan(id, d.path, chosen, mmproj, layout, named as number | null);
    const at = this.stored(id);
    const servedAs = at && at.file === chosen ? at.served_as : this.freeId(chosen, id);
    // one model at a time: the one running is stopped first
    for (const other of this.runs()) {
      if (other.model_id !== id && other.wanted === 1) {
        this.set(other.model_id, { wanted: 0, state: "stopped", error: null, asked_at: null });
        this.say(`local model ${other.model_id}: stopped, since model ${id} starts`);
      }
    }
    const now = Date.now();
    const fields = {
      served_as: servedAs,
      file: chosen,
      mmproj,
      wanted: 1,
      state: "starting" as RunState,
      error: null,
      log: "[]",
      context: null,
      slots: null,
      reasoning: 0,
      started_by: by,
      started_at: now,
      asked_at: null,
      ctx_size: plan.context,
      needs: plan.needs,
      note: plan.note,
      served: 0,
    };
    if (at) this.set(id, fields);
    else
      this.store.db
        .prepare(
          `INSERT INTO local_run (model_id, served_as, file, mmproj, wanted, state, error, log, context, slots, reasoning, started_by, started_at, asked_at, ctx_size, needs, note, served)
           VALUES (?, ?, ?, ?, 1, 'starting', NULL, '[]', NULL, NULL, 0, ?, ?, NULL, ?, ?, ?, 0)`,
        )
        .run(id, servedAs, chosen, mmproj, by, now, plan.context, plan.needs, plan.note);
    this.say(
      `local model ${id}: starting ${chosen} as ${servedAs} with ${tokens(plan.context)} tokens of context${plan.note ? ` (${plan.note})` : ""}`,
    );
    await this.tick();
    return this.local.get(id) as LocalRow;
  }

  /** A started model stopped: unloaded, and let go from the backend. One never started, or stopped already, stays as it is. */
  async stop(id: number): Promise<LocalRow> {
    if (!this.local.folder(id)) throw new LocalRefused(404, "no_such_model", `no local model ${id}`);
    const r = this.stored(id);
    if (r && (r.wanted === 1 || r.state === "starting" || r.state === "serving")) {
      this.set(id, { wanted: 0, state: "stopped", error: null, asked_at: null });
      this.say(`local model ${id}: stopped`);
      await this.tick();
    }
    return this.local.get(id) as LocalRow;
  }

  /** One look at the runtime, after the one before: what an admin wants made so. It never throws; what went wrong is said and kept on the runs. */
  tick(): Promise<void> {
    if (this.closed) return this.ticking;
    this.ticking = this.ticking
      .then(() => this.step())
      .catch((e) => {
        this.say(`the runtime: ${messageOf(e)}`);
      });
    return this.ticking;
  }

  private async step(): Promise<void> {
    const wanted = this.runs().filter((r) => r.wanted === 1);
    const presets = wanted.flatMap((r): Preset[] => {
      const d = this.local.folder(r.model_id);
      return d
        ? [
            {
              id: r.served_as,
              model: join(d.path, r.file),
              mmproj: r.mmproj ? join(d.path, r.mmproj) : null,
              context: r.ctx_size ?? CONTEXT_CAP,
            },
          ]
        : [];
    });
    let wrote: boolean;
    try {
      wrote = this.router.writePresets(presetsText(presets));
    } catch (e) {
      const error = `Kvasir could not write the runtime's presets, ${this.config.presets}: ${messageOf(e)}`;
      for (const r of wanted) if (r.error !== error) this.set(r.model_id, { error });
      this.say(error);
      return;
    }
    let models: RouterModel[];
    try {
      models = await this.router.models(wrote);
      // a model the presets name that the runtime does not list yet: the presets read again
      if (wanted.some((r) => !models.some((m) => m.id === r.served_as)))
        models = await this.router.models(true);
    } catch (e) {
      this.seen = { reachable: false, models: [] };
      const error = `the runtime at ${this.config.url} does not answer: ${messageOf(e)}`;
      for (const r of wanted) {
        // a load the runtime did not survive is not asked for again
        if (loading(r)) this.fail(r, STOPPED_WHILE_LOADING);
        else if (r.state !== "starting" || r.error !== error)
          this.set(r.model_id, { state: "starting", error });
      }
      return;
    }
    this.seen = { reachable: true, models };
    const listed = new Map(models.map((m) => [m.id, m]));
    const names = new Set(wanted.map((r) => r.served_as));
    // what nobody wants now is unloaded: a model stopped here, or by another Kvasir on the database
    for (const m of models) {
      if (m.state !== "unloaded" && !names.has(m.id))
        await this.router
          .unload(m.id)
          .catch((e) => this.say(`the runtime did not unload ${m.id}: ${messageOf(e)}`));
    }
    const now = Date.now();
    const loaded: StoredRun[] = [];
    for (const r of wanted) {
      const m = listed.get(r.served_as);
      if (!m) {
        const error = `the runtime lists no ${r.served_as} after reading its presets again`;
        if (now - (r.asked_at ?? r.started_at ?? now) >= this.askAgainMs) this.fail(r, error);
        else if (r.state !== "starting" || r.error !== error)
          this.set(r.model_id, { state: "starting", error });
        continue;
      }
      if (m.state === "loaded") {
        if (r.state === "serving") {
          loaded.push(r);
          continue;
        }
        const p = await this.router
          .props(r.served_as)
          .catch(() => ({ context: null, slots: null, reasoning: false }));
        const settled = { context: p.context, slots: p.slots, reasoning: p.reasoning ? 1 : 0 };
        this.set(r.model_id, {
          state: "serving",
          error: null,
          log: "[]",
          asked_at: null,
          served: 1,
          ...settled,
        });
        this.say(
          `local model ${r.model_id}: serving as ${r.served_as}${p.context ? `, ${p.context} tokens of context in ${p.slots ?? "?"} slot(s)` : ""}`,
        );
        loaded.push({ ...r, state: "serving", asked_at: null, served: 1, ...settled });
        continue;
      }
      if (m.state === "loading") {
        // a load under way counts as asked for, whoever asked, so a runtime that dies under it is not asked again
        if (r.state !== "starting" || r.error !== null || r.asked_at === null)
          this.set(r.model_id, { state: "starting", error: null, asked_at: r.asked_at ?? now });
        continue;
      }
      // unloaded: failed after Kvasir asked, lost under a load, not asked yet, or unloaded since it served
      if (m.failed && r.asked_at !== null && now - r.asked_at >= this.settleMs) {
        this.fail(
          r,
          `the runtime could not load ${basename(r.file)}${m.exitCode === null ? "" : `: its process exited with status ${m.exitCode}`}`,
          this.router.tail(m.port),
        );
        continue;
      }
      if (loading(r)) {
        // asked for, and listed unloaded with no failure: the runtime started again under the load
        if (now - (r.asked_at ?? now) >= this.loadGraceMs) this.fail(r, STOPPED_WHILE_LOADING);
        continue;
      }
      // a model that served before the runtime lost it is loaded again, once, where the memory it needs is free
      if (r.served === 1 && r.needs !== null && onProcessor(this.config.variant)) {
        const free = Math.max(0, this.freeMemory());
        if (r.needs > free) {
          this.fail(
            r,
            `the runtime no longer had the model loaded, and loading it again needs about ${readable(r.needs)} of memory while this machine has ${readable(free)} free`,
          );
          continue;
        }
      }
      try {
        await this.router.load(r.served_as);
        this.set(r.model_id, {
          state: "starting",
          error: r.served === 1 ? "the runtime no longer had the model loaded, so it loads it again" : null,
          asked_at: now,
        });
      } catch (e) {
        this.fail(r, messageOf(e));
      }
    }
    this.hold(loaded);
  }

  /** The runtime's backend holding exactly the models loaded now: held again where that changed, let go where none is. */
  private hold(loaded: StoredRun[]): void {
    const current = this.backends.get(RUNTIME_BACKEND);
    if (loaded.length === 0) {
      if (current) {
        this.held.remove(RUNTIME_BACKEND);
        this.say(`${RUNTIME_BACKEND}: no model is loaded, so the backend is let go`);
      }
      return;
    }
    let key: string;
    try {
      key = this.router.key();
    } catch (e) {
      this.say(`${RUNTIME_BACKEND}: the runtime's key could not be read: ${messageOf(e)}`);
      return;
    }
    const models: ModelEntry[] = loaded.map((r) => {
      const context = r.context ?? r.ctx_size ?? CONTEXT_CAP;
      return {
        id: r.served_as,
        name: basename(r.file).replace(/\.gguf$/iu, ""),
        reasoning: r.reasoning === 1,
        input: r.mmproj ? ["text", "image"] : ["text"],
        contextWindow: context,
        maxTokens: Math.max(1_024, Math.min(16_384, Math.floor(context / 4))),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });
    const config: BackendConfig = {
      id: RUNTIME_BACKEND,
      kind: "openai-completions",
      baseUrl: `${this.config.url}/v1`,
      locality: "local",
      concurrency: Math.min(256, Math.max(1, ...loaded.map((r) => r.slots ?? 4))),
      models,
      warmup: true,
      runtime: { name: "llama.cpp", version: this.config.build || "unknown", build: this.config.variant },
    };
    if (current && JSON.stringify(shapeOf(current.config)) === JSON.stringify(shapeOf(config))) {
      if (this.credentials.open(RUNTIME_BACKEND) !== key) this.credentials.put(RUNTIME_BACKEND, key);
      return;
    }
    this.held.replace(config, "kvasir", key);
    this.say(`${RUNTIME_BACKEND}: holds ${models.map((m) => m.id).join(", ")}`);
  }

  /** Serving: the runtime looked at now and every `pollMs`, one look at a time. */
  follow(): void {
    this.closed = false;
    this.timer ??= setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick().finally(() => {
        this.busy = false;
      });
    }, this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  /** The runtime looked at once, changing nothing: for a listing from the command line. */
  async look(): Promise<void> {
    try {
      this.seen = { reachable: true, models: await this.router.models() };
    } catch {
      this.seen = { reachable: false, models: [] };
    }
  }

  /** Kvasir closing: no look starts, and the one under way finishes. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }
}
