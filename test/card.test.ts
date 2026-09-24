// SPDX-License-Identifier: AGPL-3.0-only
// The card of record 47 against a fake Docker, which records every call and
// takes its time to start a model: a swap from A to B and back behind one
// request each, a request that waits through a swap longer than the wait cap
// for a slot, the return to the default after idle, a failed start that falls
// back, the adoption of a model already running, only the loaded model warming
// (kineuro/kvasir#8), and the llama.cpp router behind the same interface.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Card, type CardTimes, DockerDriver, type Exec, LlamaRouterDriver } from "../src/card.js";
import { cardsOf } from "../src/card-config.js";
import { parse } from "../src/config.js";
import { LlamaRouter } from "../src/runtime.js";
import { modelList } from "../src/served.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { chunk, hold, serve, sse } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("waited too long");
    await sleep(10);
  }
}

/**
 * A fake Docker: containers by name, each started after `startMs` of its own (its health answers only then),
 * a container that `dies` exiting while it starts, and every call recorded as `docker <args>`.
 */
function fakeDocker(startMs: Record<string, number>, dies: string[] = [], running: string[] = []) {
  const calls: string[] = [];
  const up = new Map<string, number>();
  for (const name of running) up.set(name, 0);
  const exec: Exec = async (args) => {
    calls.push(args.join(" "));
    const name = args.at(-1) as string;
    if (args[0] === "inspect") {
      if (dies.includes(name) && up.has(name) && Date.now() >= (up.get(name) ?? 0)) up.delete(name);
      return { code: 0, out: up.has(name) ? "true" : "false" };
    }
    if (args[0] === "start") {
      if (!up.has(name)) up.set(name, Date.now() + (startMs[name] ?? 0));
      return { code: 0, out: name };
    }
    if (args[0] === "stop") {
      up.delete(name);
      return { code: 0, out: name };
    }
    return { code: 1, out: "unknown command" };
  };
  // the health of a container is asked at its upstream: the fake maps it back by the port's container
  const byUrl = new Map<string, string>();
  const probe = async (url: string) => {
    const name = byUrl.get(url.replace(/\/health$/u, ""));
    return name !== undefined && up.has(name) && Date.now() >= (up.get(name) ?? 0) && !dies.includes(name);
  };
  return {
    calls,
    driver: new DockerDriver(exec, probe),
    upstream: (url: string, name: string) => byUrl.set(url, name),
    /** Only the start and stop calls, the ones that change the card. */
    moves: () => calls.filter((c) => !c.startsWith("inspect")),
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

/** A model's own server: it answers every request with one word, and names itself. */
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

const spec = (context: number, concurrency: number) => ({
  context_length: context,
  max_output_tokens: 8_192,
  max_concurrent_requests: concurrency,
  capabilities: { tools: true, reasoning: true, vision: false },
  license: "Apache-2.0",
});

async function kvasirWithCard(
  times: Partial<CardTimes> = {},
  docker: { startMs?: Record<string, number>; dies?: string[]; running?: string[] } = {},
  admission = { queue: 8, waitCapSeconds: 60, gate: false },
): Promise<{ k: Kvasir; url: string; docker: ReturnType<typeof fakeDocker> }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-card-"));
  const a = await modelServer("from-a");
  const b = await modelServer("from-b");
  const d = fakeDocker(docker.startMs ?? { "sgl-a": 50, "sgl-b": 50 }, docker.dies, docker.running);
  d.upstream(a, "sgl-a");
  d.upstream(b, "sgl-b");
  const config = parse(
    JSON.stringify({
      bind: "127.0.0.1:0",
      origin: "http://kvasir.test",
      auth: { mode: "token", tokens: { "a-kvasir-token": "anna@lab:kvasir:work" } },
      store: join(dir, "kvasir.sqlite"),
      pepperFile: join(dir, "kvasir.pepper"),
      sealKeyFile: join(dir, "kvasir.seal"),
      admission,
      cards: [
        {
          id: "card0",
          driver: "docker",
          note: "one card, one model at a time",
          models: [
            {
              id: "model-a",
              aliases: ["a-fast"],
              container: "sgl-a",
              upstream: a,
              default: true,
              spec: spec(262_144, 4),
            },
            { id: "model-b", aliases: ["b-alias"], container: "sgl-b", upstream: b, spec: spec(131_072, 8) },
          ],
        },
      ],
    }),
  );
  const k = build(config, { cardDriver: () => d.driver, cardTimes: () => ({ ...fast, ...times }) });
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url, docker: d };
}

/** One request through pi-messages, read whole: its text, and whether it waited with heartbeats. */
async function ask(
  url: string,
  model: string,
): Promise<{ status: number; text: string; queued: boolean; raw: string }> {
  const r = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer a-kvasir-token", "content-type": "application/json" },
    body: JSON.stringify({ model, context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] } }),
  });
  const raw = await r.text();
  const text = raw
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => JSON.parse(f.slice(5)))
    .filter((e) => e.type === "text_delta")
    .map((e) => e.delta)
    .join("");
  return { status: r.status, text, queued: raw.includes(": queued"), raw };
}

describe("the card", () => {
  it("swaps from A to B and back, behind one request each, and a request waits through a swap longer than the wait cap", async () => {
    // B takes 2.5 s to answer its health; a request waits at most 1 s for a slot
    const { k, url, docker } = await kvasirWithCard(
      {},
      { startMs: { "sgl-a": 50, "sgl-b": 2_500 } },
      { queue: 8, waitCapSeconds: 1, gate: false },
    );
    await k.cards.start();
    const card = k.cards.list[0];
    expect(card.loaded).toBe("model-a");
    expect(docker.moves()).toEqual(["start sgl-a"]);

    // one request for B, by its alias: A is stopped, B started, and the request waits for its health
    const t0 = Date.now();
    const toB = await ask(url, "b-alias");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_400);
    expect(toB.text).toBe("from-b");
    // the stream said it was waiting, a comment each second, so no client's fetch gives up on it
    expect(toB.queued).toBe(true);
    expect(card.loaded).toBe("model-b");
    expect(docker.moves()).toEqual(["start sgl-a", "stop -t 30 sgl-a", "start sgl-b"]);

    // one request for A: B is stopped and A started again
    const toA = await ask(url, "model-a");
    expect(toA.text).toBe("from-a");
    expect(card.loaded).toBe("model-a");
    expect(docker.moves()).toEqual([
      "start sgl-a",
      "stop -t 30 sgl-a",
      "start sgl-b",
      "stop -t 30 sgl-b",
      "start sgl-a",
    ]);
    expect(card.lastSwapMs).not.toBeNull();
  }, 20_000);

  it("returns to the default after the other model has been idle", async () => {
    const { k, url, docker } = await kvasirWithCard({ idleReturnMs: 150 });
    await k.cards.start();
    const card = k.cards.list[0];
    expect((await ask(url, "model-b")).text).toBe("from-b");
    expect(card.loaded).toBe("model-b");
    await until(() => card.loaded === "model-a" && card.state === "ready");
    expect(docker.moves()).toEqual([
      "start sgl-a",
      "stop -t 30 sgl-a",
      "start sgl-b",
      "stop -t 30 sgl-b",
      "start sgl-a",
    ]);
    // idle at the default, it stays
    await sleep(200);
    expect(docker.moves()).toHaveLength(5);
  });

  it("drains the loaded model's running request before it stops it", async () => {
    const { k, docker } = await kvasirWithCard();
    await k.cards.start();
    const card = k.cards.list[0];
    const a = k.backends.get("card0-model-a");
    const b = k.backends.get("card0-model-b");
    if (!a || !b) throw new Error("the card's backends");
    const leaveA = await a.admission.acquire();
    const toB = b.admission.acquire();
    await until(() => card.state === "draining");
    // A is still running a request: nothing is stopped
    expect(docker.moves()).toEqual(["start sgl-a"]);
    leaveA();
    const leaveB = await toB;
    expect(card.loaded).toBe("model-b");
    expect(docker.moves()).toEqual(["start sgl-a", "stop -t 30 sgl-a", "start sgl-b"]);
    leaveB();
  });

  it("beats every second while a request waits, even when the card wakes it just before a beat is due", async () => {
    const { k } = await kvasirWithCard({}, { startMs: { "sgl-a": 50, "sgl-b": 2_500 } });
    await k.cards.start();
    const card = k.cards.list[0];
    const leaveA = await card.enter("model-a");
    const t0 = Date.now();
    const beats: number[] = [];
    const toB = card.enter("model-b", () => beats.push(Date.now() - t0));
    // A's request ends most of a second into B's wait: the drain wakes B's waiter before its first beat was due
    await sleep(700);
    leaveA();
    const leaveB = await toB;
    leaveB();
    expect(card.loaded).toBe("model-b");
    // a beat each second from the start of the wait, not a second from the last wake
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0]).toBeLessThan(1_400);
    for (let i = 1; i < beats.length; i += 1) expect(beats[i] - beats[i - 1]).toBeLessThan(1_400);
  });

  it("falls back to the default when a model does not start, and tells its waiter", async () => {
    const { k, url, docker } = await kvasirWithCard({}, { dies: ["sgl-b"] });
    await k.cards.start();
    const card = k.cards.list[0];
    const r = await ask(url, "model-b");
    expect(r.raw).toMatch(/model-b failed to start: model-b: sgl-b exited while starting/u);
    await until(() => card.loaded === "model-a" && card.state === "ready");
    expect(docker.moves()).toEqual([
      "start sgl-a",
      "stop -t 30 sgl-a",
      "start sgl-b",
      "stop -t 30 sgl-b",
      "start sgl-a",
    ]);
    expect(card.error).toMatch(/sgl-b exited/u);
    // the default still answers
    expect((await ask(url, "model-a")).text).toBe("from-a");
  });

  it("adopts the model already running at start, and starts nothing", async () => {
    const { k, docker } = await kvasirWithCard({}, { running: ["sgl-b"] });
    await k.cards.start();
    expect(k.cards.list[0].loaded).toBe("model-b");
    expect(docker.moves()).toEqual(["start sgl-b"]);
    // `docker start` of a running container changes nothing; A was never started
    expect(docker.calls.filter((c) => c === "start sgl-a")).toHaveLength(0);
  });

  it("watches without swapping where Kvasir does not manage the card, as beside modelgate", async () => {
    const d = fakeDocker({}, [], ["sgl-b"]);
    d.upstream("http://127.0.0.1:1", "sgl-a");
    d.upstream("http://127.0.0.1:2", "sgl-b");
    const [config] = cardsOf(
      [
        {
          id: "card0",
          manage: false,
          models: [
            {
              id: "model-a",
              container: "sgl-a",
              upstream: "http://127.0.0.1:1",
              default: true,
              spec: spec(8192, 1),
            },
            { id: "model-b", container: "sgl-b", upstream: "http://127.0.0.1:2", spec: spec(8192, 1) },
          ],
        },
      ],
      null,
    );
    const card = new Card(config, d.driver, fast);
    await card.start();
    expect(card.loaded).toBe("model-b");
    await expect(card.enter("model-a")).rejects.toThrow(/watches card0 without swapping it/u);
    const leave = await card.enter("model-b");
    leave();
    card.close();
    expect(d.moves()).toEqual([]);
  });

  it("warms only the loaded model, so a cold one never holds the desk on its warming page (#8)", async () => {
    const { k, url } = await kvasirWithCard({}, { startMs: { "sgl-a": 300, "sgl-b": 50 } });
    const auth = { authorization: "Bearer a-kvasir-token" };
    const card = k.cards.list[0];
    const starting = k.cards.start();
    await until(() => card.target === "model-a");
    // while the card loads its default at start, that model is warming, and only it
    let health = await (await fetch(`${url}/healthz`)).json();
    expect(health.warming).toBe(true);
    const warming = health.backends
      .filter((b: { warming: boolean }) => b.warming)
      .map((b: { id: string }) => b.id);
    expect(warming).toEqual(["card0-model-a"]);
    await starting;
    health = await (await fetch(`${url}/healthz`)).json();
    expect(health.warming).toBe(false);
    const config = await (await fetch(`${url}/v1/config`, { headers: auth })).json();
    expect(config.health.warming).toBe(false);
    const byId = Object.fromEntries(
      config.backends.map((b: { id: string; health: { status: string } }) => [b.id, b.health.status]),
    );
    expect(byId).toMatchObject({ "card0-model-a": "loaded", "card0-model-b": "cold" });
    // /health in modelgate's shape, for the probe
    const h = await fetch(`${url}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ status: "ok", loaded: "model-a", state: "ready" });
    // the list a client reads: modelgate's shape, with the specs and which model is loaded
    const listed = modelList(k.served);
    expect(listed.server).toMatchObject({
      state: "ready",
      loaded: "model-a",
      note: "one card, one model at a time",
    });
    expect(listed.data).toEqual([
      expect.objectContaining({
        id: "model-a",
        aliases: ["a-fast"],
        default: true,
        status: "loaded",
        context_length: 262_144,
        max_output_tokens: 8_192,
        max_concurrent_requests: 4,
        license: "Apache-2.0",
        card: "card0",
      }),
      expect.objectContaining({ id: "model-b", default: false, status: "cold", context_length: 131_072 }),
    ]);
    expect(k.served.find("b-alias")?.id).toBe("model-b");
  });

  it("reproduces #8 on held backends: one never warmed no longer keeps the aggregate warming", async () => {
    const rt = await serve((_req, res) => {
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "ready" }),
        chunk({}, "stop"),
        "[DONE]",
      ]);
    });
    closers.push(() => rt.server.close());
    const { k, url } = await kvasirWithCard();
    const entry = (id: string) => ({ id, contextWindow: 8192, maxTokens: 1024 });
    // the issue's rig: two local backends over one runtime, the one the app uses warmed, the other not
    hold(k, [
      { id: "fast", baseUrl: `${rt.url}/v1`, locality: "local", warmup: true, models: [entry("m-fast")] },
      { id: "slow", baseUrl: `${rt.url}/v1`, locality: "local", warmup: false, models: [entry("m-slow")] },
    ]);
    await k.cards.start();
    expect((await (await fetch(`${url}/healthz`)).json()).warming).toBe(true);
    // the app's model answers its first request: warm; the other, never asked, is not warming
    expect((await ask(url, "m-fast")).text).toBe("ready");
    const health = await (await fetch(`${url}/healthz`)).json();
    expect(health.backends.find((b: { id: string }) => b.id === "slow").warming).toBe(false);
    expect(health.warming).toBe(false);
  });

  it("reads the example of a server's configuration, modelgate's models as they are", () => {
    const config = parse(readFileSync(new URL("../kvasir.card.example.json", import.meta.url), "utf8"));
    expect(config.cards).toHaveLength(1);
    const [card] = config.cards;
    expect(card.driver).toEqual({ kind: "docker", command: "docker" });
    expect(card.models.map((m) => [m.id, m.name, m.backend, m.default])).toEqual([
      ["qwen3.8-flash-next", "sgl-next", "card0-qwen3-8-flash-next", true],
      ["qwen38-27b", "sgl-27b", "card0-qwen38-27b", false],
    ]);
  });

  it("refuses a kvasir.json whose card is not whole", () => {
    const base = { bind: "127.0.0.1:0", origin: "http://kvasir.test" };
    const model = { id: "m", container: "c", upstream: "http://127.0.0.1:1", spec: { context_length: 8192 } };
    expect(() => parse(JSON.stringify({ ...base, cards: [{ id: "card0", models: [] }] }))).toThrow(/models/u);
    expect(() =>
      parse(
        JSON.stringify({ ...base, cards: [{ id: "card0", models: [model, { ...model, container: "d" }] }] }),
      ),
    ).toThrow(/m names two models/u);
    expect(() =>
      parse(JSON.stringify({ ...base, cards: [{ id: "card0", models: [{ ...model, spec: {} }] }] })),
    ).toThrow(/context_length/u);
    expect(() =>
      parse(
        JSON.stringify({
          ...base,
          local: {
            runtime: { url: "http://127.0.0.1:7110", keyFile: "/k", presets: "/p", log: "/l" },
          },
          cards: [
            {
              id: "card0",
              driver: "llama-router",
              router: { url: "http://127.0.0.1:7110", keyFile: "/k" },
              models: [model],
            },
          ],
        }),
      ),
    ).toThrow(/install's runtime/u);
  });
});

describe("the llama.cpp router as a card's driver", () => {
  it("loads one preset and unloads the other through the router, behind the same interface", async () => {
    const state: Record<string, string> = { "p-a": "unloaded", "p-b": "unloaded" };
    const asked: string[] = [];
    const router = await serve((req, res, text) => {
      if (req.headers.authorization !== "Bearer router-key") {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET" && req.url?.startsWith("/models")) {
        res.end(
          JSON.stringify({ data: Object.entries(state).map(([id, value]) => ({ id, status: { value } })) }),
        );
        return;
      }
      const { model } = JSON.parse(text) as { model: string };
      asked.push(`${req.url} ${model}`);
      state[model] = req.url === "/models/load" ? "loaded" : "unloaded";
      res.end("{}");
    });
    closers.push(() => router.server.close());
    const dir = mkdtempSync(join(tmpdir(), "kvasir-router-"));
    const keyFile = join(dir, "router.key");
    writeFileSync(keyFile, "router-key\n");
    const [config] = cardsOf(
      [
        {
          id: "laptop",
          driver: "llama-router",
          router: { url: router.url, keyFile },
          models: [
            { id: "model-a", preset: "p-a", default: true, spec: { context_length: 8192 } },
            { id: "model-b", preset: "p-b", spec: { context_length: 8192 } },
          ],
        },
      ],
      null,
    );
    const driver = new LlamaRouterDriver(
      new LlamaRouter({ url: router.url, keyFile, presets: "", log: "", build: "", variant: "" }),
    );
    const card = new Card(config, driver, fast);
    await card.start();
    expect(card.loaded).toBe("model-a");
    const leave = await card.enter("model-b");
    leave();
    expect(card.loaded).toBe("model-b");
    expect(asked).toEqual(["/models/load p-a", "/models/unload p-a", "/models/load p-b"]);
    expect(state).toEqual({ "p-a": "unloaded", "p-b": "loaded" });
    card.close();
  });
});
