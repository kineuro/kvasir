// SPDX-License-Identifier: AGPL-3.0-only
// The admission suite of §8.6 against fake runtimes: one that honours the
// schemas and refuses an oversized prompt, one that accepts and ignores;
// the catalog gate; the record naming the runtime and the build; the
// overhead of Kvasir's own door measured in process.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { measureOverhead, runSuite, wellFormed } from "../src/suite.js";
import { entry, fakeAnthropic, fakeRuntime, local } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

async function kvasir(backends: unknown[], gate = true): Promise<{ k: Kvasir; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-"));
  const config = parse(
    JSON.stringify({
      bind: "127.0.0.1:0",
      origin: "http://kvasir.test",
      auth: {
        mode: "token",
        tokens: { "a-kvasir-token": "anna@lab:admin", "a-reader-token": "bo@lab:reader" },
      },
      store: join(dir, "kvasir.sqlite"),
      pepperFile: join(dir, "kvasir.pepper"),
      sealKeyFile: join(dir, "kvasir.seal"),
      admission: { queue: 8, waitCapSeconds: 60, gate },
      backends,
    }),
  );
  const k = build(config);
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

describe("the admission suite", () => {
  it("admits a runtime that honours the schemas and refuses one that accepts and ignores", async () => {
    const good = await fakeRuntime(true);
    const bad = await fakeRuntime(false);
    closers.push(
      () => good.server.close(),
      () => bad.server.close(),
    );
    const { k } = await kvasir([
      local(good.url, "good", [entry("qwen-good")]),
      local(bad.url, "bad", [entry("qwen-bad")]),
    ]);
    const [g, b] = k.backends.list;
    const okRecord = await runSuite(g, g.config.models[0]);
    expect(okRecord.passed).toBe(true);
    expect(okRecord.runtime).toEqual({ name: "sglang", version: "0.5.9-test", build: "/models/fake fake" });
    const by = (r: typeof okRecord, n: string) => r.checks.find((c) => c.name === n)!;
    expect(by(okRecord, "tool_calls").measured.validity).toBe(1);
    expect(by(okRecord, "enforced_schema").measured.verdict).toBe("enforced");
    expect(okRecord.overflow).toBe("error");
    expect(by(okRecord, "stream_integrity").passed).toBeNull();
    const badRecord = await runSuite(b, b.config.models[0]);
    expect(badRecord.passed).toBe(false);
    expect(by(badRecord, "enforced_schema").passed).toBe(false);
    expect(by(badRecord, "enforced_schema").measured.verdict).toBe("ignored");
    expect(badRecord.overflow).toBe("truncated");
    expect(by(badRecord, "tool_calls").passed).toBe(true);
  }, 30_000);

  it("a local model is not in the catalog until admitted; the record names the runtime and the build; the door is an admin's", async () => {
    const rt = await fakeRuntime(true);
    closers.push(() => rt.server.close());
    const { k, url } = await kvasir([local(rt.url)]);
    const config = async () =>
      (await (
        await fetch(`${url}/v1/config`, { headers: { authorization: "Bearer a-reader-token" } })
      ).json()) as { models: { id: string; admitted: boolean | null }[] };
    expect((await config()).models).toEqual([]);
    const refused = await fetch(`${url}/v1/admission/run`, {
      method: "POST",
      headers: { authorization: "Bearer a-reader-token", "content-type": "application/json" },
      body: JSON.stringify({ backend: "card" }),
    });
    expect(refused.status).toBe(403);
    const ran = await fetch(`${url}/v1/admission/run`, {
      method: "POST",
      headers: { authorization: "Bearer a-kvasir-token", "content-type": "application/json" },
      body: JSON.stringify({ backend: "card" }),
    });
    expect(ran.status).toBe(200);
    const { records } = (await ran.json()) as {
      records: { passed: boolean; runtime: { name: string; version: string }; kvasir: string; id: number }[];
    };
    expect(records[0].passed).toBe(true);
    expect(records[0].runtime.name).toBe("sglang");
    expect(records[0].kvasir).toMatch(/^\d/);
    expect((await config()).models.map((m) => [m.id, m.admitted])).toEqual([["qwen", true]]);
    const listed = (await (
      await fetch(`${url}/v1/admission`, { headers: { authorization: "Bearer a-reader-token" } })
    ).json()) as { records: { id: number }[] };
    expect(listed.records[0].id).toBe(records[0].id);
    // a fresh process reads the record back, for the runtime the backend reports now
    k.backends.list[0].admitted.clear();
    await k.admissions.load(k.backends, async () => ({ name: "sglang", version: "0.5.9-test", build: "" }));
    expect(k.backends.list[0].admitted.has("qwen")).toBe(true);
    // the runtime moved: the record no longer admits (re-run on every upgrade)
    await k.admissions.load(k.backends, async () => ({ name: "sglang", version: "0.6.0", build: "" }));
    expect(k.backends.list[0].admitted.has("qwen")).toBe(false);
  }, 30_000);

  it("a thinking signature survives the round trip byte for byte, and a runtime that drops it fails", async () => {
    const sig = "c2lnbmF0dXJlLWJ5dGVz==";
    const rt = await fakeAnthropic(sig);
    closers.push(() => rt.server.close());
    const { k } = await kvasir([
      {
        id: "claude",
        kind: "anthropic-messages",
        baseUrl: rt.url,
        key: "k",
        locality: "local",
        warmup: false,
        models: [entry("sonnet", true)],
      },
    ]);
    const b = k.backends.list[0];
    const rec = await runSuite(b, b.config.models[0], { only: ["stream_integrity"] });
    const c = rec.checks[0];
    expect(c.passed).toBe(true);
    expect(c.measured.signature_bytes).toBe(sig.length);
  }, 30_000);

  it("measures Kvasir's own overhead through its door against the direct path, with the thresholds", async () => {
    const rt = await fakeRuntime(true);
    closers.push(() => rt.server.close());
    const { k } = await kvasir([local(rt.url)]);
    const b = k.backends.list[0];
    const via = (context: Parameters<typeof b.stream>[1], maxTokens: number) =>
      b.stream(b.config.models[0], context, { maxTokens });
    const o = await measureOverhead(b, b.config.models[0], via, { streams: 2, rounds: 1, promptTokens: 64 });
    expect(o.direct.n).toBe(2);
    expect(o.via.n).toBe(2);
    expect(typeof o.overhead.p50).toBe("number");
    // the CLI path: the suite with the overhead through the process's own door
    const [rec] = await k.admit("card", "qwen", { overhead: true });
    expect(rec.overhead?.streams).toBe(8);
    expect(rec.overhead?.via.n).toBe(32);
    expect(rec.overhead?.within).toBe(true);
  }, 60_000);

  it("the small validator over our own schemas", () => {
    const schema = {
      type: "object",
      properties: { handle: { type: "integer" }, page: { type: "integer" } },
      required: ["handle"],
    };
    expect(wellFormed({ handle: 7, page: 0 }, schema)).toBeNull();
    expect(wellFormed({ page: 0 }, schema)).toBe("missing handle");
    expect(wellFormed({ handle: "7" }, schema)).toBe("handle is not integer");
    expect(wellFormed({ handle: 7, extra: 1 }, schema)).toBe("unknown argument extra");
  });
});
