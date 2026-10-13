// SPDX-License-Identifier: AGPL-3.0-only
// A card whose models sleep (record 55, B6; spec section 14): the model that
// leaves the card releases its GPU memory and keeps its weights in the host's
// memory, and wakes when it is asked for again. Against a fake SGLang behind a
// fake Docker, three server images: one whose memory saver works, one that
// crashes at the release (the sleep-and-wake fault: SGLang 0.5.20 and 0.5.21
// clear a hybrid model's state pools after the release has unmapped them, CUDA
// error 700, and the server exits), and one that wakes and then dies. On each,
// every request after a sleep and a wake is answered by the model it asked for.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CardTimes, type Exec, type Post, ReleasingDockerDriver, type SleepTimes } from "../src/card.js";
import { cardsOf } from "../src/card-config.js";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { chunk, serve, sse } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

/** What a server image does with a release and a resume. */
type Image = "saver-works" | "crashes-at-release" | "dies-after-waking";

/**
 * A fake Docker with SGLang servers in it: containers by name, each answering its health `startMs` after a
 * start, a release that sleeps the server (or, on the faulty image, ends it), a resume that wakes it, and
 * every call recorded. A health asked of a sleeping server is recorded as a fault of the driver's own.
 */
function fakeSglang(
  image: Image,
  startMs: Record<string, number>,
  running: string[] = [],
  sleeping: string[] = [],
) {
  const calls: string[] = [];
  const up = new Map<string, number>();
  const asleep = new Set<string>(sleeping);
  for (const name of running) up.set(name, 0);
  const byUrl = new Map<string, string>();
  const exec: Exec = async (args) => {
    const name = args.at(-1) as string;
    if (args[0] === "inspect") return { code: 0, out: up.has(name) ? "true" : "false" };
    calls.push(`docker ${args.join(" ")}`);
    if (args[0] === "start" && up.has(name)) return { code: 0, out: name };
    if (args[0] === "start" || args[0] === "restart") {
      up.set(name, Date.now() + (startMs[name] ?? 0));
      asleep.delete(name);
      return { code: 0, out: name };
    }
    if (args[0] === "stop") {
      up.delete(name);
      asleep.delete(name);
      return { code: 0, out: name };
    }
    return { code: 1, out: "unknown command" };
  };
  const probe = async (url: string) => {
    const name = byUrl.get(url.replace(/\/health$/u, "")) ?? "";
    if (asleep.has(name)) calls.push(`health asked of sleeping ${name}`);
    return up.has(name) && Date.now() >= (up.get(name) ?? 0) && !asleep.has(name);
  };
  const post: Post = async (url) => {
    const at = url.lastIndexOf("/");
    const name = byUrl.get(url.slice(0, at)) ?? "";
    const what = url.slice(at + 1);
    calls.push(`${what} ${name}`);
    if (!up.has(name)) return { status: 0, body: "fetch failed" };
    if (what === "release_memory_occupation") {
      if (image === "crashes-at-release") {
        // the scheduler writes to the state pools the release has just unmapped, and the server exits
        up.delete(name);
        return { status: 0, body: "socket hang up" };
      }
      asleep.add(name);
      return { status: 200, body: "" };
    }
    if (what === "resume_memory_occupation") {
      asleep.delete(name);
      // a server that wakes and dies on its first generation
      if (image === "dies-after-waking") up.delete(name);
      return { status: 200, body: "" };
    }
    return { status: 404, body: "" };
  };
  return {
    calls,
    exec,
    probe,
    post,
    upstream: (url: string, name: string) => byUrl.set(url, name),
    /** Every call that changes a container or its server. */
    moves: () => calls.filter((c) => !c.startsWith("health")),
  };
}

const fast: CardTimes = {
  minResidencyMs: 0,
  idleReturnMs: 60_000,
  drainTimeoutMs: 5_000,
  startTimeoutMs: 10_000,
  queueTimeoutMs: 20_000,
  pollMs: 20,
  idleCheckMs: 25,
};

const fastSleep: SleepTimes = { callMs: 1_000, settleMs: 40, wakeMs: 300, pollMs: 10 };

/** A model's own server: it answers every request with one word. */
async function modelServer(word: string) {
  const s = await serve((_req, res) => {
    sse(res, [
      chunk({ role: "assistant", content: "" }),
      chunk({ content: word }),
      chunk({}, "stop"),
      "[DONE]",
    ]);
  });
  closers.push(() => s.server.close());
  return s.url;
}

const spec = { context_length: 131_072, max_output_tokens: 8_192, max_concurrent_requests: 4 };

async function kvasirWithSleepingCard(
  image: Image,
  start: { running?: string[]; sleeping?: string[]; startMs?: Record<string, number> } = {},
): Promise<{
  k: Kvasir;
  url: string;
  docker: ReturnType<typeof fakeSglang>;
  stateFile: string;
  lines: string[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-sleep-"));
  const a = await modelServer("from-a");
  const b = await modelServer("from-b");
  const docker = fakeSglang(
    image,
    start.startMs ?? { "sgl-a": 50, "sgl-b": 50 },
    start.running,
    start.sleeping,
  );
  docker.upstream(a, "sgl-a");
  docker.upstream(b, "sgl-b");
  const stateFile = join(dir, "kvasir-sleep-card0.json");
  if (start.sleeping) writeFileSync(stateFile, JSON.stringify({ sleeping: start.sleeping }));
  const config = parse(
    JSON.stringify({
      bind: "127.0.0.1:0",
      origin: "http://kvasir.test",
      auth: { mode: "token", tokens: { "a-kvasir-token": "anna@lab:kvasir:work" } },
      store: join(dir, "kvasir.sqlite"),
      pepperFile: join(dir, "kvasir.pepper"),
      sealKeyFile: join(dir, "kvasir.seal"),
      admission: { queue: 8, waitCapSeconds: 60, gate: false },
      cards: [
        {
          id: "card0",
          driver: "docker",
          sleep: "release",
          models: [
            { id: "model-a", container: "sgl-a", upstream: a, default: true, spec },
            { id: "model-b", container: "sgl-b", upstream: b, spec },
          ],
        },
      ],
    }),
  );
  const driver = new ReleasingDockerDriver(docker.exec, docker.probe, docker.post, stateFile, fastSleep);
  const k = build(config, { cardDriver: () => driver, cardTimes: () => fast });
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  const lines: string[] = [];
  await k.cards.start((line) => lines.push(line));
  return { k, url, docker, stateFile, lines };
}

/** One request through OpenAI's chat completions, a door passed through to the model's server: its status and its text. */
async function ask(url: string, model: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer a-kvasir-token", "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "Hi" }] }),
  });
  const text = (await r.text())
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "")
    .join("");
  return { status: r.status, text };
}

/** The containers the state file names asleep; none where it was never written. */
const sleepingIn = (stateFile: string) =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")).sleeping : [];

describe("a card whose models sleep", () => {
  it("swaps warm: the model that leaves releases its memory, wakes when asked for again, and no container stops", async () => {
    const { k, url, docker, stateFile } = await kvasirWithSleepingCard("saver-works");
    const card = k.cards.list[0];
    expect(card.loaded).toBe("model-a");

    expect(await ask(url, "model-b")).toEqual({ status: 200, text: "from-b" });
    expect(sleepingIn(stateFile)).toEqual(["sgl-a"]);
    expect(await ask(url, "model-a")).toEqual({ status: 200, text: "from-a" });
    expect(await ask(url, "model-b")).toEqual({ status: 200, text: "from-b" });
    expect(card.loaded).toBe("model-b");
    expect(docker.moves()).toEqual([
      "docker start sgl-a",
      "release_memory_occupation sgl-a",
      "docker start sgl-b",
      "release_memory_occupation sgl-b",
      "resume_memory_occupation sgl-a",
      "release_memory_occupation sgl-a",
      "resume_memory_occupation sgl-b",
    ]);
    // a sleeping server is never asked for its health, which is a generation on SGLang
    expect(docker.calls.filter((c) => c.startsWith("health asked of sleeping"))).toEqual([]);
    expect(sleepingIn(stateFile)).toEqual(["sgl-a"]);
  });

  it("reproduces the sleep-and-wake fault: a memory saver that crashes its server at the release costs a cold swap, never a failed request", async () => {
    const { k, url, docker, stateFile, lines } = await kvasirWithSleepingCard("crashes-at-release");
    const card = k.cards.list[0];
    expect(await ask(url, "model-b")).toEqual({ status: 200, text: "from-b" });
    expect(await ask(url, "model-a")).toEqual({ status: 200, text: "from-a" });
    expect(await ask(url, "model-b")).toEqual({ status: 200, text: "from-b" });
    expect(card.loaded).toBe("model-b");
    expect(card.state).toBe("ready");
    expect(docker.moves()).toEqual([
      "docker start sgl-a",
      "release_memory_occupation sgl-a",
      "docker stop -t 30 sgl-a",
      "docker start sgl-b",
      "release_memory_occupation sgl-b",
      "docker stop -t 30 sgl-b",
      "docker start sgl-a",
      "release_memory_occupation sgl-a",
      "docker stop -t 30 sgl-a",
      "docker start sgl-b",
    ]);
    // the server that exited is not called asleep, so the next request for it starts it cold
    expect(sleepingIn(stateFile)).toEqual([]);
    expect(lines.filter((l) => l.includes("its container is stopped instead"))).toHaveLength(3);
    expect(lines.some((l) => l.includes("the release answered nothing (socket hang up)"))).toBe(true);
  });

  it("starts a woken model again cold where it does not answer its health", async () => {
    const { k, url, docker, lines } = await kvasirWithSleepingCard("dies-after-waking");
    const card = k.cards.list[0];
    expect(await ask(url, "model-b")).toEqual({ status: 200, text: "from-b" });
    expect(await ask(url, "model-a")).toEqual({ status: 200, text: "from-a" });
    expect(card.loaded).toBe("model-a");
    expect(docker.moves()).toEqual([
      "docker start sgl-a",
      "release_memory_occupation sgl-a",
      "docker start sgl-b",
      "release_memory_occupation sgl-b",
      "resume_memory_occupation sgl-a",
      "docker restart -t 30 sgl-a",
    ]);
    expect(lines.some((l) => l.includes("sgl-a: it did not answer its health within 0 s of waking"))).toBe(
      true,
    );
  });

  it("knows after a start again which model sleeps: it keeps the awake one and never asks the sleeping one", async () => {
    const { k, url, docker } = await kvasirWithSleepingCard("saver-works", {
      running: ["sgl-a", "sgl-b"],
      sleeping: ["sgl-a"],
    });
    const card = k.cards.list[0];
    // the default sleeps and the other model is awake: the awake one is kept, with no swap at start
    expect(card.loaded).toBe("model-b");
    expect(docker.moves()).toEqual([]);
    expect(await ask(url, "model-a")).toEqual({ status: 200, text: "from-a" });
    expect(docker.moves()).toEqual(["release_memory_occupation sgl-b", "resume_memory_occupation sgl-a"]);
    expect(docker.calls.filter((c) => c.startsWith("health asked of sleeping"))).toEqual([]);
  });

  it("reads sleep from kvasir.json: stop by default, release for SGLang containers only", () => {
    const model = { id: "m", container: "c", upstream: "http://127.0.0.1:1", spec };
    const [stop] = cardsOf([{ id: "card0", models: [model] }], null);
    expect(stop.driver).toEqual({ kind: "docker", command: "docker", sleep: "stop" });
    const [release] = cardsOf([{ id: "card0", sleep: "release", models: [model] }], null);
    expect(release.driver).toEqual({ kind: "docker", command: "docker", sleep: "release" });
    expect(() => cardsOf([{ id: "card0", sleep: "suspend", models: [model] }], null)).toThrow(
      /sleep is stop or release/u,
    );
    expect(() =>
      cardsOf(
        [
          {
            id: "card0",
            driver: "llama-router",
            sleep: "release",
            router: { url: "http://127.0.0.1:2", keyFile: "/k" },
            models: [{ id: "m", spec }],
          },
        ],
        null,
      ),
    ).toThrow(/sleep: release is for SGLang containers/u);
  });
});
