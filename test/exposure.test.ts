// SPDX-License-Identifier: AGPL-3.0-only
// What a client key and the public listener reach (record 47, R6): only the
// doors meant for clients. Every door is read from the router's own source,
// not listed by hand, and every line of the router that names a method must be
// read, so a door added later is checked too. A client key is refused (403) on
// every other door of the internal listener, and the public listener answers
// 404 on every other door. /health says the cards' state and loaded model to
// anyone, and a failed start's reason only to a caller with a grant.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type CardDriver, type CardTimes, DockerDriver } from "../src/card.js";
import { isPublic, PUBLIC_DOORS, parse } from "../src/config.js";
import { build, type Kvasir, listen, listenPublic } from "../src/server.js";
import { CHATGPT } from "../src/subscriptions.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

interface Door {
  method: string;
  path: string;
  line: number;
}

/** A path a regular expression of the router matches: each free segment stands for one of its own. */
function sampleOf(pattern: string): string {
  return pattern
    .replace(/\\\//gu, "/")
    .replace(/\[\^\/\]\+/gu, "x")
    .replace(/\(\\d\+\)/gu, "1")
    .replace(/\.\+/gu, "x");
}

/** Every door of src/server.ts, as the router's conditions name them, and the lines that named a method but no door. */
function doorsOfRouter(): { doors: Door[]; unread: number[] } {
  const source = readFileSync(join(process.cwd(), "src", "server.ts"), "utf8").replaceAll(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the router's own template text, replaced
    "${CHATGPT}",
    CHATGPT,
  );
  const lines = source.split("\n");
  const doors: Door[] = [];
  const read = new Set<number>();
  const METHODS = ["GET", "POST", "PUT", "DELETE"];
  const localModel = /\/\^(\\\/v1\\\/local\\\/models\\\/\(\\d\+\))/u.exec(source)?.[1];
  lines.forEach((text, i) => {
    const line = i + 1;
    const add = (method: string, path: string) => {
      doors.push({ method, path, line });
      read.add(line);
    };
    const methods = [...text.matchAll(/req\.method === "([A-Z]+)"/gu)].map((m) => m[1]);
    const tree = /path === ["`]([^"`]+)["`] && path\.startsWith/u.exec(text);
    const between = /path\.startsWith\("([^"]+)"\) && path\.endsWith\("([^"]+)"\)/u.exec(text);
    const under = /path\.startsWith\("([^"]+)"\)/u.exec(text);
    const exact = /path === ["`]([^"`]+)["`]/u.exec(text);
    const pattern = /\/\^(.+?)\$\/u\.test\(path\)/u.exec(text);
    if (tree) {
      // a tree of doors: every method at its root and below it
      for (const method of METHODS) {
        add(method, tree[1]);
        add(method, `${tree[1]}/x`);
      }
    } else if (between) {
      for (const method of methods) add(method, `${between[1]}x${between[2]}`);
    } else if (under) {
      for (const method of methods) add(method, `${under[1]}x`);
    } else if (exact) {
      for (const method of methods) add(method, exact[1]);
    } else if (pattern) {
      for (const method of methods) add(method, sampleOf(pattern[1]));
    } else if (/Object\.hasOwn\(DOORS, path\)/u.test(text)) {
      for (const p of ["/v1/chat/completions", "/v1/completions", "/v1/messages", "/v1/responses"])
        for (const method of methods) add(method, p);
    } else if (localModel && /\bmodel\b/u.test(text) && methods.length > 0) {
      const base = sampleOf(localModel);
      const suffixes = [...text.matchAll(/model\??\.?\[2\] === "(\/\w+)"/gu)].map((x) => x[1]);
      for (const method of methods)
        for (const x of suffixes.length > 0 ? suffixes : [""]) add(method, `${base}${x}`);
    }
  });
  const unread = lines
    // a method checked inside a door already read (`if (req.method === ...)`) is not a door of its own
    .map((text, i) =>
      /req\.method ===/u.test(text) && !/^\s*if \(req\.method ===/u.test(text) && !read.has(i + 1)
        ? i + 1
        : 0,
    )
    .filter((n) => n > 0);
  return { doors, unread };
}

/** The doors a request reaches before anyone is asked who they are. */
const BEFORE_AUTH = new Set(["GET /health", "GET /healthz", "GET /metrics"]);

async function kvasir(driver?: CardDriver): Promise<{ k: Kvasir; url: string; outside: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-exposure-"));
  const times: CardTimes = {
    minResidencyMs: 0,
    idleReturnMs: 600_000,
    drainTimeoutMs: 1_000,
    startTimeoutMs: 1_000,
    queueTimeoutMs: 2_000,
    pollMs: 20,
    idleCheckMs: 60_000,
  };
  const k = build(
    parse(
      JSON.stringify({
        bind: "127.0.0.1:0",
        origin: "http://kvasir.test",
        auth: { mode: "token", tokens: { "a-see-token": "bo@lab:kvasir:see" } },
        store: join(dir, "kvasir.sqlite"),
        pepperFile: join(dir, "kvasir.pepper"),
        sealKeyFile: join(dir, "kvasir.seal"),
        admission: { queue: 8, waitCapSeconds: 60, gate: false },
        ...(driver
          ? {
              cards: [
                {
                  id: "card0",
                  models: [
                    {
                      id: "m",
                      container: "sgl-m",
                      upstream: "http://127.0.0.1:9",
                      spec: { context_length: 8192 },
                    },
                  ],
                },
              ],
            }
          : {}),
      }),
    ),
    driver ? { cardDriver: () => driver, cardTimes: () => times } : {},
  );
  closers.push(() => k.close());
  const url = await listen(k, "127.0.0.1:0");
  const outside = await listenPublic(k, "127.0.0.1:0");
  return { k, url, outside };
}

describe("the doors a client key reaches", () => {
  it("reads every door of the router", () => {
    const { doors, unread } = doorsOfRouter();
    expect(unread, "lines of src/server.ts that name a method but no door this test reads").toEqual([]);
    const names = new Set(doors.map((d) => `${d.method} ${d.path}`));
    for (const known of [
      "GET /v1/models/lifecycle",
      "POST /v1/models/lifecycle/x",
      "DELETE /v1/backends/x/models/x",
      "PUT /v1/credentials/x",
      "POST /v1/local/models/1/pause",
      `POST /v1/subscriptions/${CHATGPT}/sign-in`,
      "GET /metrics",
    ])
      expect(names.has(known), known).toBe(true);
    expect(doors.length).toBeGreaterThan(50);
  });

  it("takes /v1/models/{id} as public, and never a door of its own under /v1/models", () => {
    const d = PUBLIC_DOORS;
    expect(isPublic(d, "GET", "/v1/models")).toBe(true);
    expect(isPublic(d, "GET", "/v1/models/qwen38-27b")).toBe(true);
    expect(isPublic(d, "GET", "/v1/models/Qwen/Qwen3.8-27B")).toBe(true);
    expect(isPublic(d, "GET", "/v1/models/lifecycle")).toBe(false);
    expect(isPublic(d, "GET", "/v1/models/lifecycle/3")).toBe(false);
    expect(isPublic(d, "POST", "/v1/models/lifecycle/3/admit")).toBe(false);
    expect(isPublic(d, "GET", "/v1/modelsx")).toBe(false);
    // a wildcard an operator writes never opens a door of Kvasir's own either
    expect(isPublic(["GET /v1/models/*"], "GET", "/v1/models/lifecycle")).toBe(false);
  });

  it("refuses a client key every door not meant for clients, and the public listener answers none of them", async () => {
    const { k, url, outside } = await kvasir();
    const key = k.clients.add("droid", { by: "test" }).secret;
    const { doors } = doorsOfRouter();
    const checked: string[] = [];
    for (const d of doors) {
      const name = `${d.method} ${d.path}`;
      if (isPublic(k.config.public.doors, d.method, d.path)) continue;
      const init = (base: string) =>
        fetch(`${base}${d.path}`, {
          method: d.method,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          ...(d.method === "GET" ? {} : { body: "{}" }),
        });
      const outer = await init(outside);
      expect(outer.status, `public ${name}`).toBe(404);
      await outer.body?.cancel();
      if (BEFORE_AUTH.has(name)) continue;
      const inner = await init(url);
      expect(inner.status, `internal ${name}`).toBe(403);
      await inner.body?.cancel();
      checked.push(name);
    }
    expect(checked).toContain("GET /v1/models/lifecycle");
    expect(checked).toContain("GET /v1/clients");
  });

  it("gives the lifecycle only to a caller with a grant", async () => {
    const { k, url } = await kvasir();
    const key = k.clients.add("droid", { by: "test" }).secret;
    const client = await fetch(`${url}/v1/models/lifecycle?events=1`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(client.status).toBe(403);
    const reader = await fetch(`${url}/v1/models/lifecycle`, {
      headers: { authorization: "Bearer a-see-token" },
    });
    expect(reader.status).toBe(200);
  });
});

describe("/health", () => {
  it("says state and loaded model to anyone, and why a start failed only to a grant holder", async () => {
    const stderr = "docker start sgl-m: the-stderr-tail";
    const driver = new DockerDriver(
      async (args) => (args[0] === "start" ? { code: 1, out: "the-stderr-tail" } : { code: 0, out: "false" }),
      async () => false,
    );
    const { k, url, outside } = await kvasir(driver);
    await k.cards.start();
    expect(k.cards.list[0].error).toContain(stderr);
    for (const [base, headers] of [
      [outside, {}],
      [outside, { authorization: "Bearer a-see-token" }],
      [url, {}],
    ] as const) {
      const r = await fetch(`${base}/health`, { headers });
      const text = await r.text();
      expect(r.status).toBe(503);
      expect(text).not.toContain("the-stderr-tail");
      expect(JSON.parse(text)).toMatchObject({ state: "failed", loaded: null });
    }
    const inside = await (
      await fetch(`${url}/health`, { headers: { authorization: "Bearer a-see-token" } })
    ).json();
    expect(inside.cards[0].error).toContain("the-stderr-tail");
  });
});
