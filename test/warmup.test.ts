// SPDX-License-Identifier: AGPL-3.0-only
// The warm-up of §8.5, tried again: a runtime that did not answer at start is
// warm once it answers, and the tries end when Kvasir closes.

import type { Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { Backend } from "../src/backends.js";
import type { BackendConfig } from "../src/config.js";
import { chunk, local, serve, sse } from "./fake.js";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

/** A runtime that refuses its first `refusals` requests, as one still loading does, then answers each with a first token. */
async function waking(refusals: number) {
  let asked = 0;
  const rt = await serve((_req, res) => {
    asked += 1;
    if (asked <= refusals) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "the model is loading" } }));
      return;
    }
    sse(res, [chunk({ role: "assistant", content: "ready" }), chunk({}, "stop"), "[DONE]"]);
  });
  servers.push(rt.server);
  return { url: rt.url, asked: () => asked };
}

const warmed = (url: string) => ({ ...local(url), warmup: true, concurrency: 1 }) as unknown as BackendConfig;

describe("the warm-up", () => {
  it("is tried again until the runtime answers, and its first token ends warming", async () => {
    const rt = await waking(2);
    const b = new Backend(warmed(rt.url));
    await b.warmup();
    expect(b.health.warming).toBe(true);
    expect(b.health.lastError).not.toBeNull();
    const said: string[] = [];
    await b.keepWarm([5, 5], (line) => said.push(line));
    expect(b.health.warming).toBe(false);
    expect(b.health.firstTokenAt).not.toBeNull();
    expect(rt.asked()).toBe(3);
    expect(said).toEqual(["card: warm after 3 tries"]);
  });

  it("ends when Kvasir closes, and tries nothing more", async () => {
    const rt = await waking(Number.POSITIVE_INFINITY);
    const b = new Backend(warmed(rt.url));
    const trying = b.keepWarm([5]);
    await new Promise((r) => setTimeout(r, 60));
    b.stop();
    await trying;
    const asked = rt.asked();
    expect(asked).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(rt.asked()).toBe(asked);
    expect(b.health.warming).toBe(true);
  });

  it("leaves alone a backend Kvasir does not warm, which a request's first token warms instead", async () => {
    const b = new Backend({ ...local("http://127.0.0.1:9"), concurrency: 1 } as unknown as BackendConfig);
    await b.keepWarm([5]);
    expect(b.health.warming).toBe(true);
  });
});
