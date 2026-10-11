// SPDX-License-Identifier: AGPL-3.0-only
// The admission suite of §8.6 against fake runtimes: one that honours the
// schemas and refuses an oversized prompt, one that accepts and ignores;
// the catalog gate; the record naming the runtime and the build; the
// overhead of Kvasir's own door measured in process; and what the tool
// calls check sends and how it names what failed.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { type CallFixture, GUIDE_READ } from "../src/fixtures/suite.js";
import { build, type Kvasir, listen } from "../src/server.js";
import {
  measureOverhead,
  overflow,
  runSuite,
  sameDocument,
  THINKING_BUDGET,
  toolCalls,
  wellFormed,
} from "../src/suite.js";
import { chunk, entry, fakeAnthropic, fakeRuntime, hold, local, serve, sse } from "./fake.js";

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
        tokens: { "a-kvasir-token": "anna@lab:kvasir:work", "a-reader-token": "bo@lab:kvasir:see" },
      },
      store: join(dir, "kvasir.sqlite"),
      pepperFile: join(dir, "kvasir.pepper"),
      sealKeyFile: join(dir, "kvasir.seal"),
      admission: { queue: 8, waitCapSeconds: 60, gate },
    }),
  );
  const k = build(config);
  hold(k, backends);
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

  it("a local model is not in the catalog until admitted; the record names the runtime and the build; the door needs kvasir:work", async () => {
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

  // the thresholds are measured on whatever machine runs the tests, so a busy one is given two more tries
  it("measures Kvasir's own overhead through its door against the direct path, with the thresholds", {
    retry: 2,
    timeout: 60_000,
  }, async () => {
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
  });

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

  it("compares a document's text by its value, not its spelling", () => {
    const doc = { sets: { scope: { grain: "cohort" } } };
    expect(sameDocument(doc, '{"sets": {"scope": {"grain": "cohort"}}}')).toBe(true);
    expect(sameDocument(doc, '{\n  "sets": {\n    "scope": { "grain": "cohort" }\n  }\n}')).toBe(true);
    expect(sameDocument(doc, '{"sets": {"scope": {"grain": "session"}}}')).toBe(false);
    // a key added is not the document asked for, nor is text that is not JSON
    expect(sameDocument(doc, '{"sets": {"scope": {"grain": "cohort", "where": []}}}')).toBe(false);
    expect(sameDocument(doc, "sets: {scope: {grain: cohort}}")).toBe(false);
    expect(sameDocument(doc, doc)).toBe(false);
  });

  /**
   * A runtime that answers each prompt as the test scripts it and keeps every
   * request: a call (name and arguments as text), or reasoning that runs out
   * of budget with no call.
   */
  async function scripted(answers: Record<string, { name: string; arguments: string } | "thinks">) {
    const seen: Record<string, unknown>[] = [];
    const rt = await serve((req, res, text) => {
      if (req.url === "/get_server_info") {
        res.writeHead(404);
        res.end();
        return;
      }
      const q = JSON.parse(text) as Record<string, unknown> & { messages: { content?: unknown }[] };
      seen.push(q);
      const answer = answers[String(q.messages.at(-1)?.content ?? "")] ?? "thinks";
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (answer === "thinks") {
        sse(res, [
          chunk({ role: "assistant", content: "" }),
          chunk({ reasoning_content: "The user wants a call. Let me weigh the tools one by one" }),
          chunk({}, "length", usage),
          "[DONE]",
        ]);
        return;
      }
      sse(res, [
        chunk({ role: "assistant", content: "" }),
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: answer }] }),
        chunk({}, "tool_calls", usage),
        "[DONE]",
      ]);
    });
    closers.push(() => rt.server.close());
    return { url: rt.url, seen };
  }

  it("asks the tool calls with the guide read and a thinking budget, and names what failed apart from form", async () => {
    const fixtures: CallFixture[] = [
      { prompt: "Read the guide before anything else.", tool: "nils_guide", args: {}, fresh: true },
      {
        prompt: "What does the catalog hold at the cohort level?",
        tool: "nils_catalog",
        args: { level: "cohort" },
      },
      {
        prompt: "Preview document 2, three rows only.",
        tool: "nils_preview",
        args: { document_id: 2, rows: 3 },
      },
      { prompt: "Read page 2 of handle 77.", tool: "nils_rows", args: { handle: 77, page: 2 } },
      {
        prompt: 'Draft a document from this JSON: {"sets": {"scope": {"grain": "cohort"}}}',
        tool: "nils_draft",
        args: { text: { sets: { scope: { grain: "cohort" } } } },
        documents: ["text"],
      },
      { prompt: "What is the state of job 31?", tool: "nils_job_status", args: { job: 31 } },
    ];
    const rt = await scripted({
      [fixtures[0].prompt]: { name: "nils_guide", arguments: "{}" },
      // well formed, but the guide again: the wrong tool
      [fixtures[1].prompt]: { name: "nils_guide", arguments: "{}" },
      // the right tool, well formed, another value
      [fixtures[2].prompt]: { name: "nils_preview", arguments: '{"document_id": 2, "rows": 4}' },
      // the handle missing: a form error
      [fixtures[3].prompt]: { name: "nils_rows", arguments: '{"page": 2}' },
      // the same document spelt another way
      [fixtures[4].prompt]: {
        name: "nils_draft",
        arguments: JSON.stringify({ text: '{\n  "sets": {\n    "scope": {"grain": "cohort"}\n  }\n}' }),
      },
      // fixtures[5] spends its budget thinking
    });
    const { k } = await kvasir([local(rt.url, "card", [{ ...entry("qwen", true), maxTokens: 65536 }])]);
    const b = k.backends.list[0];
    const check = await toolCalls(b, b.config.models[0], fixtures);
    expect(check.passed).toBe(false);
    expect(check.measured.validity).toBeCloseTo(2 / 6);
    expect(check.measured.well_formed).toBeCloseTo(4 / 6);
    expect(check.measured.by_kind).toEqual({ tool: 1, value: 1, form: 1, no_call: 1 });
    const failures = check.measured.failures as { prompt: string; kind: string; why: string }[];
    expect(failures.map((f) => [f.kind, f.why])).toEqual([
      ["tool", "called nils_guide, expected nils_catalog"],
      ["value", "rows is 4, expected 3"],
      ["form", "missing handle"],
      ["no_call", "0 calls (stop: length)"],
    ]);
    expect(check.detail).toBe(
      "2 of 6 right (0.33; the bar is 0.95); 4 well formed; failed: 1 tool, 1 value, 1 form, 1 no_call",
    );
    // every call has a budget a thinking model can spend first
    expect(rt.seen.map((q) => q.max_tokens)).toEqual(fixtures.map(() => THINKING_BUDGET));
    // a fresh fixture starts at its prompt; every other opens with the guide called and answered
    type Wire = {
      role: string;
      content?: unknown;
      tool_calls?: { id: string; function: { name: string } }[];
      tool_call_id?: string;
    };
    const fresh = rt.seen[0].messages as Wire[];
    expect(fresh.map((m) => m.role)).toEqual(["system", "user"]);
    const opened = rt.seen[1].messages as Wire[];
    expect(opened.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(opened[1].content).toBe(GUIDE_READ.prompt);
    expect(opened[2].tool_calls?.map((c) => c.function.name)).toEqual(["nils_guide"]);
    expect(opened[3].tool_call_id).toBe(opened[2].tool_calls?.[0].id);
    expect(opened[3].content).toBe(GUIDE_READ.answer);
    expect(opened[4].content).toBe(fixtures[1].prompt);
  }, 30_000);

  it("never asks more than the entry's own longest answer, and reasoning that fills an overflow's budget is output", async () => {
    const rt = await scripted({});
    const { k } = await kvasir([local(rt.url, "card", [{ ...entry("qwen", true), maxTokens: 1024 }])]);
    const b = k.backends.list[0];
    const fixture: CallFixture = {
      prompt: "What is the state of job 31?",
      tool: "nils_job_status",
      args: { job: 31 },
    };
    await toolCalls(b, b.config.models[0], [fixture]);
    expect(rt.seen.at(-1)?.max_tokens).toBe(1024);
    // the runtime accepted the oversized prompt and thought: accepted, not truncated
    const o = await overflow(b, { ...b.config.models[0], contextWindow: 64 });
    expect(o.measured.flag).toBe("accepted");
    expect(o.measured.thinking_chars).toBeGreaterThan(0);
  }, 30_000);
});
