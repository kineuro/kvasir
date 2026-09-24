// SPDX-License-Identifier: AGPL-3.0-only
// The card (record 47): a group of models that share one device and hold one
// at a time, ported from modelgate, the interim gateway of the group's model
// server. A request for the model that is not loaded makes the card stop
// admitting to the loaded one, let its running requests finish, stop it, start
// the one asked for and wait for its health: a cold swap of minutes on SGLang.
// A request for a cold model waits through it, beyond the 60 seconds a request
// waits for a slot, with the same heartbeat. After a while without use of
// another model the card loads its default again. A swap that fails falls back
// to the default. At start the card adopts whichever model is already running,
// so Kvasir and modelgate can replace each other without a swap.
//
// Two drivers behind one interface: Docker, which starts and stops SGLang
// containers by name and asks each one's /health, as modelgate does; and
// llama.cpp's router (record 24), which loads and unloads a preset. Only the
// loaded model warms: a cold one is not warming, so it never holds the desk on
// its warming page (kineuro/kvasir#8).

import { execFile } from "node:child_process";
import { RefusedAdmission } from "./admission.js";
import type { Backend, Backends } from "./backends.js";
import type { CardConfig, CardMemberConfig } from "./card-config.js";
import type { BackendConfig, ModelEntry } from "./config.js";
import { LlamaRouter } from "./runtime.js";
import { PROTOCOLS, type ServedServer, type ServedStatus, specOf } from "./served.js";

export type { CardConfig, CardMemberConfig } from "./card-config.js";

/** What starts, stops and asks after the models of a card. */
export interface CardDriver {
  readonly kind: string;
  /** Whether the model's process runs, healthy or not. */
  running(m: CardMemberConfig): Promise<boolean>;
  /** The model started; one already running is left as it is. */
  start(m: CardMemberConfig): Promise<void>;
  /** The model stopped; one not running is fine. */
  stop(m: CardMemberConfig): Promise<void>;
  /** Whether the model answers its health now. */
  healthy(m: CardMemberConfig): Promise<boolean>;
}

/** A command's exit status and what it wrote. */
export type Exec = (args: string[]) => Promise<{ code: number; out: string }>;

/** `docker` itself, run with the arguments given and no shell. */
export function dockerExec(command = "docker"): Exec {
  return (args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 120_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout}${stderr}`.trim() });
      });
    });
}

/** Whether a server's /health answers 200 within five seconds. */
export async function healthAnswers(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await r.body?.cancel();
    return r.status === 200;
  } catch {
    return false;
  }
}

/** SGLang containers on one GPU, by name, as modelgate starts them on the model server. */
export class DockerDriver implements CardDriver {
  readonly kind = "docker";
  constructor(
    private readonly exec: Exec = dockerExec(),
    private readonly probe: (url: string) => Promise<boolean> = healthAnswers,
    /** How long `docker stop` lets a model finish before it is killed. */
    private readonly stopSeconds = 30,
  ) {}

  async running(m: CardMemberConfig): Promise<boolean> {
    const r = await this.exec(["inspect", "-f", "{{.State.Running}}", m.name]);
    return r.code === 0 && r.out.trim() === "true";
  }

  async start(m: CardMemberConfig): Promise<void> {
    const r = await this.exec(["start", m.name]);
    if (r.code !== 0) throw new Error(`docker start ${m.name}: ${r.out.slice(-300)}`);
  }

  async stop(m: CardMemberConfig): Promise<void> {
    const r = await this.exec(["stop", "-t", String(this.stopSeconds), m.name]);
    if (r.code !== 0) throw new Error(`docker stop ${m.name}: ${r.out.slice(-300)}`);
  }

  healthy(m: CardMemberConfig): Promise<boolean> {
    return this.probe(`${m.upstream}/health`);
  }
}

/** llama.cpp's server in router mode (record 24): a card's model is a preset it loads and unloads. */
export class LlamaRouterDriver implements CardDriver {
  readonly kind = "llama-router";
  constructor(readonly router: LlamaRouter) {}

  private async state(m: CardMemberConfig): Promise<string> {
    const listed = await this.router.models();
    return listed.find((x) => x.id === m.name)?.state ?? "unloaded";
  }

  async running(m: CardMemberConfig): Promise<boolean> {
    return (await this.state(m).catch(() => "unloaded")) !== "unloaded";
  }

  start(m: CardMemberConfig): Promise<void> {
    return this.router.load(m.name);
  }

  stop(m: CardMemberConfig): Promise<void> {
    return this.router.unload(m.name);
  }

  async healthy(m: CardMemberConfig): Promise<boolean> {
    return (await this.state(m).catch(() => "unloaded")) === "loaded";
  }
}

export type CardState = "starting" | "ready" | "draining" | "swapping" | "failed";

/** The card's times, in milliseconds. */
export interface CardTimes {
  minResidencyMs: number;
  idleReturnMs: number;
  drainTimeoutMs: number;
  startTimeoutMs: number;
  queueTimeoutMs: number;
  /** How often a model being started is asked for its health, and a watched card looked at. */
  pollMs: number;
  /** How often the card asks itself whether to go back to its default. */
  idleCheckMs: number;
}

export function timesOf(c: CardConfig): CardTimes {
  return {
    minResidencyMs: c.minResidencySeconds * 1000,
    idleReturnMs: c.idleReturnSeconds * 1000,
    drainTimeoutMs: c.drainTimeoutSeconds * 1000,
    startTimeoutMs: c.startTimeoutSeconds * 1000,
    queueTimeoutMs: c.queueTimeoutSeconds * 1000,
    pollMs: 3_000,
    idleCheckMs: 15_000,
  };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One card: its models, which is loaded, and the swap between them. */
export class Card {
  readonly id: string;
  readonly members: Map<string, CardMemberConfig>;
  readonly default: string;
  /** The model whose server is up, or none. */
  loaded: string | null = null;
  state: CardState = "starting";
  /** The model being brought up now, in a swap or at start. */
  target: string | null = null;
  /** Requests admitted to the loaded model and not finished. */
  inflight = 0;
  error: string | null = null;
  lastSwapMs: number | null = null;
  /** What happens, a line each. */
  say: (line: string) => void = () => {};
  /** A model loaded, at start or by a swap. */
  onLoaded: (id: string) => void = () => {};
  /** The state changed. */
  onChange: () => void = () => {};
  private readonly waiting = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private lastUsed = Date.now();
  private loadedAt = Date.now();
  private swapper: Promise<void> | null = null;
  private waiters = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private returning = false;
  private closed = false;

  constructor(
    readonly config: CardConfig,
    readonly driver: CardDriver,
    readonly times: CardTimes = timesOf(config),
  ) {
    this.id = config.id;
    this.members = new Map(config.models.map((m) => [m.id, m]));
    this.default = (config.models.find((m) => m.default) ?? config.models[0]).id;
    for (const id of this.members.keys()) this.waiting.set(id, 0);
  }

  /** A model's status as a client lists it. */
  status(id: string): "loaded" | "loading" | "cold" {
    if (this.loaded === id && (this.state === "ready" || this.state === "draining")) return "loaded";
    if (this.target === id) return "loading";
    return "cold";
  }

  /** The card as modelgate's `server` block and `/health` say it. */
  server(): ServedServer {
    return {
      state: this.state,
      loaded: this.loaded,
      last_swap_seconds: this.lastSwapMs === null ? null : Math.round(this.lastSwapMs / 1000),
      note: this.config.note,
    };
  }

  /** Whether the card serves, or is on its way to a model: what `/health` answers 200 for. */
  ok(): boolean {
    return this.state !== "failed" || this.loaded !== null;
  }

  private notify(): void {
    const woken = [...this.waiters];
    this.waiters.clear();
    for (const w of woken) w();
    this.onChange();
  }

  /** Until the state changes, or `ms` pass. */
  private changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      this.waiters.add(done);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** A model of this card by its id. */
  member(id: string): CardMemberConfig {
    const m = this.members.get(id);
    if (!m) throw new Error(`${this.id} has no model ${id}`);
    return m;
  }

  /** A model started and followed until it answers its health. */
  private async bringUp(id: string): Promise<void> {
    const m = this.member(id);
    const t0 = Date.now();
    await this.driver.start(m);
    const deadline = t0 + this.times.startTimeoutMs;
    while (Date.now() < deadline && !this.closed) {
      if (!(await this.driver.running(m))) throw new Error(`${m.name} exited while starting`);
      if (await this.driver.healthy(m)) {
        this.lastSwapMs = Date.now() - t0;
        this.say(`${this.id}: ${id} is up in ${Math.round(this.lastSwapMs / 1000)} s`);
        return;
      }
      await this.sleep(this.times.pollMs);
    }
    throw new Error(
      `${id} did not answer its health within ${Math.round(this.times.startTimeoutMs / 1000)} s`,
    );
  }

  private async takeDown(id: string): Promise<void> {
    await this.driver.stop(this.member(id)).catch((e) => this.say(`${this.id}: ${messageOf(e)}`));
  }

  /**
   * At start: the model already running is kept, the default first, and any other stopped; with none
   * running, the default is started. A card Kvasir only watches starts and stops nothing.
   */
  async adopt(): Promise<void> {
    const up: string[] = [];
    for (const [id, m] of this.members) if (await this.driver.running(m).catch(() => false)) up.push(id);
    if (!this.config.manage) {
      await this.look();
      this.timers.push(setInterval(() => void this.look(), this.times.pollMs));
      for (const t of this.timers) t.unref?.();
      return;
    }
    const keep = up.includes(this.default) ? this.default : (up[0] ?? this.default);
    for (const id of up) if (id !== keep) await this.takeDown(id);
    this.target = keep;
    this.notify();
    try {
      await this.bringUp(keep);
      this.loaded = keep;
      this.state = "ready";
      this.error = null;
    } catch (e) {
      this.state = "failed";
      this.error = messageOf(e);
      this.say(`${this.id}: at start: ${this.error}`);
    }
    this.target = null;
    this.loadedAt = this.lastUsed = Date.now();
    this.notify();
    if (this.loaded) this.onLoaded(this.loaded);
    this.kick();
  }

  /** A watched card (manage false): whichever model runs and answers is the loaded one. */
  private async look(): Promise<void> {
    let found: string | null = null;
    for (const [id, m] of this.members) {
      if ((await this.driver.running(m).catch(() => false)) && (await this.driver.healthy(m))) {
        found = id;
        break;
      }
    }
    const state: CardState = found ? "ready" : "swapping";
    if (found !== this.loaded || state !== this.state) {
      const was = this.loaded;
      this.loaded = found;
      this.state = state;
      if (found !== was) this.loadedAt = Date.now();
      this.notify();
      if (found && found !== was) this.onLoaded(found);
    }
  }

  /** The model to swap to, if any: the one with the most requests waiting. */
  private wanted(): string | null {
    let best: string | null = null;
    let most = 0;
    for (const [id, n] of this.waiting) {
      if (n > most && id !== this.loaded) {
        best = id;
        most = n;
      }
    }
    return best;
  }

  private kick(): void {
    if (!this.config.manage || this.swapper || this.closed) return;
    this.swapper = this.swapLoop().finally(() => {
      this.swapper = null;
    });
  }

  private async swapLoop(): Promise<void> {
    while (!this.closed) {
      const target = this.wanted();
      if (target === null || this.state === "starting") return;
      if (this.state === "ready" && this.loaded !== null) {
        // a model keeps the card a while when it is busy or has requests queued, so a swap is never undone
        // before it served anyone
        const left = this.times.minResidencyMs - (Date.now() - this.loadedAt);
        const busy = this.inflight > 0 || (this.waiting.get(this.loaded) ?? 0) > 0;
        if (busy && left > 0) {
          await this.changed(Math.min(1_000, left));
          continue;
        }
      }
      this.state = "draining";
      this.notify();
      const until = Date.now() + this.times.drainTimeoutMs;
      while (this.inflight > 0 && Date.now() < until && !this.closed)
        await this.changed(Math.min(1_000, until - Date.now()));
      if (this.inflight > 0)
        this.say(
          `${this.id}: drain timeout: stopping ${this.loaded} with ${this.inflight} request(s) running`,
        );
      const old = this.loaded;
      this.state = "swapping";
      this.loaded = null;
      this.target = target;
      this.notify();
      this.say(`${this.id}: swap ${old ?? "nothing"} -> ${target}`);
      if (old) await this.takeDown(old);
      let now: string | null = null;
      let err: string | null = null;
      try {
        await this.bringUp(target);
        now = target;
      } catch (e) {
        err = `${target}: ${messageOf(e)}`;
        this.say(`${this.id}: swap to ${target} failed: ${messageOf(e)}; back to ${this.default}`);
        await this.takeDown(target);
        if (target !== this.default) {
          this.target = this.default;
          this.notify();
          try {
            await this.bringUp(this.default);
            now = this.default;
          } catch (e2) {
            err = `${err}; ${this.default}: ${messageOf(e2)}`;
          }
        }
      }
      this.loaded = now;
      this.target = null;
      this.state = now ? "ready" : "failed";
      this.error = err;
      this.loadedAt = this.lastUsed = Date.now();
      if (now !== target) this.failures.set(target, (this.failures.get(target) ?? 0) + 1);
      this.notify();
      if (now) this.onLoaded(now);
      // the waiters of a model that did not start see it and give up before the next look, or it is tried again
      if (now !== target) await this.sleep(1);
    }
  }

  private refused(fact: string): RefusedAdmission {
    return new RefusedAdmission({ layer: "health", fact });
  }

  /**
   * Wait until the model is loaded and admit one request to it: through a swap where it is cold, up to the
   * card's queue timeout, `heartbeat` called every second meanwhile. What it returns ends the request.
   */
  async enter(id: string, heartbeat?: () => void, signal?: AbortSignal): Promise<() => void> {
    if (!this.members.has(id)) throw this.refused(`${this.id} has no model ${id}`);
    const deadline = Date.now() + this.times.queueTimeoutMs;
    const failed = this.failures.get(id) ?? 0;
    let beat = Date.now();
    this.waiting.set(id, (this.waiting.get(id) ?? 0) + 1);
    try {
      for (;;) {
        if (this.closed) throw this.refused("Kvasir is closing");
        if (signal?.aborted) throw this.refused("the caller went away while waiting");
        if (this.loaded === id && this.state === "ready") {
          // someone waits for another model: finish what runs and admit no more, unless this one still has
          // its time on the card
          const resident = Date.now() - this.loadedAt < this.times.minResidencyMs;
          if (this.wanted() === null || resident) {
            this.inflight += 1;
            this.lastUsed = Date.now();
            let left = false;
            return () => {
              if (left) return;
              left = true;
              this.inflight -= 1;
              this.lastUsed = Date.now();
              this.notify();
            };
          }
        }
        if ((this.failures.get(id) ?? 0) > failed)
          throw this.refused(`${id} failed to start: ${this.error ?? "no reason given"}`);
        if (!this.config.manage && this.loaded !== id)
          throw this.refused(
            `${id} is not loaded, and this Kvasir watches ${this.id} without swapping it; ${this.loaded ?? "no model"} is loaded`,
          );
        if (this.state === "failed" && this.loaded === null && !this.swapper) this.state = "ready";
        if (this.loaded !== id) this.kick();
        const left = deadline - Date.now();
        if (left <= 0)
          throw this.refused(`${id} was not loaded within ${Math.round(this.times.queueTimeoutMs / 1000)} s`);
        // wait until the next beat is due, not a whole second from the last wake: a wake just before a beat
        // (a drain ending, a swap starting) would push it to almost two seconds; the timer may also fire a
        // millisecond early by the wall clock, so a beat due within a few milliseconds counts as due
        const due = beat + 1_000;
        await this.changed(Math.min(left, due - Date.now()));
        if (Date.now() >= due - 5) {
          heartbeat?.();
          beat = Date.now();
        }
      }
    } finally {
      this.waiting.set(id, (this.waiting.get(id) ?? 1) - 1);
    }
  }

  /** Back to the default after the other model has been idle a while: a waiter of its own drives the swap. */
  async idleReturn(): Promise<void> {
    if (this.returning || !this.config.manage) return;
    const idle =
      this.loaded !== null &&
      this.loaded !== this.default &&
      this.state === "ready" &&
      this.inflight === 0 &&
      Date.now() - this.lastUsed > this.times.idleReturnMs &&
      [...this.waiting.values()].every((n) => n === 0);
    if (!idle) return;
    this.returning = true;
    this.say(
      `${this.id}: ${this.loaded} idle for ${Math.round(this.times.idleReturnMs / 1000)} s; back to ${this.default}`,
    );
    this.waiting.set(this.default, (this.waiting.get(this.default) ?? 0) + 1);
    try {
      this.kick();
      while (this.loaded !== this.default && this.state !== "failed" && !this.closed)
        await this.changed(1_000);
    } finally {
      this.waiting.set(this.default, (this.waiting.get(this.default) ?? 1) - 1);
      this.returning = false;
    }
  }

  /** Serving: the card adopts what runs, and asks itself now and then whether to go back to its default. */
  async start(): Promise<void> {
    this.closed = false;
    const t = setInterval(() => void this.idleReturn(), this.times.idleCheckMs);
    t.unref?.();
    this.timers.push(t);
    await this.adopt();
  }

  /** Kvasir closing: no swap starts, and every waiter is refused. */
  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.notify();
  }
}

/** A card member's catalog entry, from its specs. */
export function entryOf(m: CardMemberConfig): ModelEntry {
  const spec = specOf(m.spec);
  const context = spec.contextLength ?? 32_768;
  return {
    id: m.id,
    name: typeof m.spec.name === "string" ? m.spec.name : m.id,
    reasoning: spec.reasoning,
    input: spec.vision ? ["text", "image"] : ["text"],
    contextWindow: context,
    maxTokens: spec.maxOutputTokens ?? Math.min(context, 4_096),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(m.aliases.length > 0 ? { aliases: m.aliases } : {}),
    spec: m.spec,
  };
}

/**
 * The backend a card member is served as: local, not warmed by a prompt (the card asks its health), its
 * concurrency from its specs, and the pass-through doors its server speaks natively: all four on SGLang, and
 * on llama.cpp's server every one but OpenAI's responses.
 */
export function memberBackend(card: CardConfig, m: CardMemberConfig): BackendConfig {
  return {
    id: m.backend,
    kind: "openai-completions",
    baseUrl: `${m.upstream}/v1`,
    locality: "local",
    concurrency: Math.min(256, specOf(m.spec).concurrency ?? 8),
    models: [entryOf(m)],
    warmup: false,
    card: card.id,
    passThrough:
      card.driver.kind === "llama-router" ? PROTOCOLS.filter((p) => p !== "responses") : [...PROTOCOLS],
    anthropicThinking: card.anthropicThinking,
  };
}

/** The driver a card's configuration names. */
export function driverOf(c: CardConfig): CardDriver {
  if (c.driver.kind === "llama-router")
    return new LlamaRouterDriver(
      new LlamaRouter({
        url: c.driver.url,
        keyFile: c.driver.keyFile,
        presets: "",
        log: "",
        build: "",
        variant: "",
      }),
    );
  return new DockerDriver(dockerExec(c.driver.command));
}

/** Every card Kvasir serves, each member served as a backend whose admission waits for its model to be loaded. */
export class Cards {
  readonly list: Card[] = [];
  /** A member backend whose model was just loaded, for a serving Kvasir to admit where it has no record. */
  onLoaded: (backend: Backend) => void = () => {};

  constructor(
    configs: CardConfig[],
    private readonly backends: Backends,
    driver: (c: CardConfig) => CardDriver = driverOf,
    times?: (c: CardConfig) => CardTimes,
  ) {
    for (const c of configs) {
      const card = new Card(c, driver(c), times ? times(c) : timesOf(c));
      this.list.push(card);
      for (const m of c.models) {
        if (backends.get(m.backend))
          throw new Error(`kvasir.json: cards: ${m.backend} is the name of a backend Kvasir holds already`);
        const backend = backends.make(memberBackend(c, m));
        backend.admission.ahead = (heartbeat, signal) => card.enter(m.id, heartbeat, signal);
        backends.add(backend);
      }
      card.onChange = () => this.follow(card);
      card.onLoaded = (id) => {
        const b = this.backends.get(card.member(id).backend);
        if (b) this.onLoaded(b);
      };
      this.follow(card);
    }
  }

  /** The card a backend is a member of, and the member. */
  of(backend: Backend): { card: Card; member: CardMemberConfig } | null {
    const card = this.list.find((c) => c.id === backend.config.card);
    const member = card ? [...card.members.values()].find((m) => m.backend === backend.config.id) : undefined;
    return card && member ? { card, member } : null;
  }

  /** A member's status and whether it is its card's default, for the listing. */
  status(backend: Backend): { card: string; status: ServedStatus; default: boolean } | null {
    const on = this.of(backend);
    return on
      ? { card: on.card.id, status: on.card.status(on.member.id), default: on.card.default === on.member.id }
      : null;
  }

  /** The member backends' health made the card's: only the model the card loads at start warms, and each says loaded, loading or cold. */
  private follow(card: Card): void {
    for (const m of card.members.values()) {
      const b = this.backends.get(m.backend);
      if (!b) continue;
      b.health.status = card.status(m.id);
      b.health.warming = card.state === "starting" && card.target === m.id;
      if (card.state === "failed" && card.error) b.health.lastError = card.error;
    }
  }

  /**
   * `/health` in modelgate's shape: 200 while every card serves or swaps; the first card's state, and each
   * card's. Why a card failed (a start's own output) is said only with `details`, to a caller holding a grant.
   */
  health(details = false): { status: number; body: Record<string, unknown> } {
    const ok = this.list.every((c) => c.ok());
    const first = this.list[0];
    return {
      status: ok ? 200 : 503,
      body: {
        status: ok ? "ok" : (this.list.find((c) => !c.ok())?.state ?? "failed"),
        loaded: first?.loaded ?? null,
        state: first?.state ?? "ready",
        cards: this.list.map((c) => ({
          id: c.id,
          state: c.state,
          loaded: c.loaded,
          ...(details ? { error: c.error } : {}),
        })),
      },
    };
  }

  async start(say: (line: string) => void = () => {}): Promise<void> {
    for (const c of this.list) c.say = say;
    await Promise.all(this.list.map((c) => c.start()));
  }

  close(): void {
    for (const c of this.list) c.close();
  }
}
