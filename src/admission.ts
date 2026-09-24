// SPDX-License-Identifier: AGPL-3.0-only
// Concurrency per backend (§8.7): eight streams admitted, a queue behind
// them with a heartbeat, and a wait cap after which the request is refused
// at the health layer. Kvasir cannot stop a runaway agent loop; the
// station's budget does, and this makes the loop visible.

export interface Refusal {
  layer: "deployment" | "requirement" | "policy" | "quota" | "health";
  fact: string;
}

export class RefusedAdmission extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.fact);
  }
}

export class Admission {
  running = 0;
  /**
   * A wait before a slot, where the model must first be loaded (record 47): a card's model that is cold
   * waits here for the swap, up to the card's own queue timeout rather than the wait cap, with the same
   * heartbeat; what it returns is called when the stream ends.
   */
  ahead: ((heartbeat?: () => void, signal?: AbortSignal) => Promise<() => void>) | null = null;
  private readonly waiting: (() => void)[] = [];
  constructor(
    readonly concurrency: number,
    readonly queue: number,
    readonly waitCapMs: number,
  ) {}

  get queued(): number {
    return this.waiting.length;
  }

  /**
   * A slot, waited for while `heartbeat` is called every second; refused when the queue is full or the wait
   * cap passes. Where the model must first be loaded, that wait comes before, under its own limit.
   */
  async acquire(heartbeat?: () => void, signal?: AbortSignal): Promise<() => void> {
    if (!this.ahead) return this.slot(heartbeat, signal);
    const leave = await this.ahead(heartbeat, signal);
    try {
      const release = await this.slot(heartbeat, signal);
      return () => {
        release();
        leave();
      };
    } catch (e) {
      leave();
      throw e;
    }
  }

  private async slot(heartbeat?: () => void, signal?: AbortSignal): Promise<() => void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return () => this.release();
    }
    if (this.waiting.length >= this.queue) {
      throw new RefusedAdmission({
        layer: "health",
        fact: `the backend has ${this.running} streams running and ${this.waiting.length} waiting; the queue holds ${this.queue}`,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      let wake: () => void = () => {};
      const timer = setInterval(() => {
        if (signal?.aborted) {
          clear();
          reject(new RefusedAdmission({ layer: "health", fact: "the caller went away while waiting" }));
          return;
        }
        if (Date.now() - started >= this.waitCapMs) {
          clear();
          reject(
            new RefusedAdmission({
              layer: "health",
              fact: `waited ${Math.round(this.waitCapMs / 1000)} s for a slot and none came free`,
            }),
          );
          return;
        }
        heartbeat?.();
      }, 1000);
      const clear = () => {
        clearInterval(timer);
        const i = this.waiting.indexOf(wake);
        if (i >= 0) this.waiting.splice(i, 1);
      };
      wake = () => {
        clearInterval(timer);
        resolve();
      };
      this.waiting.push(wake);
    });
    this.running += 1;
    return () => this.release();
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}
