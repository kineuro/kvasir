// SPDX-License-Identifier: AGPL-3.0-only
// The model lifecycle (Wave 5 §9.5): a candidate registered from a
// fine-tune job keeps its recipe; the suite admits it through the same
// runner; a candidate cannot be promoted without an admission record that
// passed; a promotion retires the previous promoted model on the backend
// and the purposes route to the new one; every transition is a row.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/config.js";
import { build, type Kvasir, listen } from "../src/server.js";
import { entry, fakeRuntime, hold, local } from "./fake.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

async function kvasir(backends: unknown[]): Promise<{ k: Kvasir; url: string }> {
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
      admission: { queue: 8, waitCapSeconds: 60, gate: false },
      purposes: [{ id: "assistant.title", app: "assistant", content: "catalog", kind: "background" }],
    }),
  );
  const k = build(config);
  hold(k, backends);
  const url = await listen(k, "127.0.0.1:0");
  closers.push(() => k.close());
  return { k, url };
}

const admin = { authorization: "Bearer a-kvasir-token", "content-type": "application/json" };
const reader = { authorization: "Bearer a-reader-token", "content-type": "application/json" };

async function call(
  url: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const r = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

describe("the model lifecycle", () => {
  it("a candidate cannot be promoted without an admission record; with one that passed it is, and the previous is retired", async () => {
    const rt = await fakeRuntime(true);
    closers.push(() => rt.server.close());
    const { k, url } = await kvasir([local(rt.url, "card", [entry("qwen"), entry("qwen-tuned")])]);
    // the doors need kvasir:work; the listing is anyone's
    expect(
      (await call(url, "/v1/models/lifecycle", "POST", reader, { model: "qwen", backend: "card" })).status,
    ).toBe(403);
    const first = await call(url, "/v1/models/lifecycle", "POST", admin, {
      model: "qwen",
      backend: "card",
      source: { kind: "manual" },
    });
    expect(first.status).toBe(201);
    const a = (first.json.candidate as { id: number; state: string }).id;
    expect((first.json.candidate as { state: string }).state).toBe("registered");
    // no admission: refused with a sentence, and the state stands
    const early = await call(url, `/v1/models/lifecycle/${a}/promote`, "POST", admin, {});
    expect(early.status).toBe(409);
    expect((early.json.error as { message: string }).message).toMatch(/no admission record that passed/);
    // the suite through the same runner
    const admitted = await call(url, `/v1/models/lifecycle/${a}/admit`, "POST", admin, {});
    expect(admitted.status).toBe(200);
    expect(
      (admitted.json.candidate as { state: string; admission: { passed: boolean; record: number } }).state,
    ).toBe("admitted");
    expect(
      (admitted.json.candidate as { admission: { passed: boolean; record: number } }).admission.passed,
    ).toBe(true);
    expect((admitted.json.candidate as { admission: { record: number } }).admission.record).toBeGreaterThan(
      0,
    );
    // promoted by a proposal a person accepted: the purposes route to it
    const promoted = await call(url, `/v1/models/lifecycle/${a}/promote`, "POST", admin, {
      proposal: { id: 7, principal: "anna@lab" },
    });
    expect(promoted.status).toBe(200);
    expect((promoted.json.candidate as { state: string; proposal: { id: number } }).state).toBe("promoted");
    expect((promoted.json.candidate as { proposal: { id: number; principal: string } }).proposal).toEqual({
      id: 7,
      principal: "anna@lab",
    });
    expect(promoted.json.retired).toBeNull();
    expect(k.lifecycle.promoted("card")).toBe("qwen");
    // a second candidate, from a fine-tune job, keeps its recipe
    const second = await call(url, "/v1/models/lifecycle", "POST", admin, {
      model: "qwen-tuned",
      backend: "card",
      source: { kind: "fine-tune", job: 41, recipe: { base: "qwen", epochs: 2, set: "corrections-2026-09" } },
      notes: "the first teaching loop",
    });
    const b = (second.json.candidate as { id: number }).id;
    expect((second.json.candidate as { source: unknown }).source).toEqual({
      kind: "fine-tune",
      job: 41,
      recipe: { base: "qwen", epochs: 2, set: "corrections-2026-09" },
    });
    expect((await call(url, `/v1/models/lifecycle/${b}/promote`, "POST", admin, {})).status).toBe(409);
    await call(url, `/v1/models/lifecycle/${b}/admit`, "POST", admin, {});
    const again = await call(url, `/v1/models/lifecycle/${b}/promote`, "POST", admin, {
      proposal: { id: "p-9", principal: "anna@lab" },
    });
    expect(again.status).toBe(200);
    expect((again.json.retired as { id: number; state: string }).id).toBe(a);
    expect((again.json.retired as { state: string }).state).toBe("retired");
    expect(k.lifecycle.promoted("card")).toBe("qwen-tuned");
    // the purposes route to the promoted model
    const grant = await call(url, "/v1/grants", "POST", reader, { purpose: "assistant.title", need: {} });
    expect(grant.status).toBe(200);
    expect(grant.json.model).toBe("qwen-tuned");
    expect((grant.json.chose_because as string[]).some((s) => s.includes("promoted model"))).toBe(true);
    // the listing: every candidate with its state and records, the promoted per backend, the events on request
    const listed = await call(url, "/v1/models/lifecycle?events=1", "GET", reader);
    expect(listed.status).toBe(200);
    const rows = listed.json.candidates as {
      id: number;
      state: string;
      events: { transition: string; by: string }[];
    }[];
    expect(rows.map((c) => [c.id, c.state])).toEqual([
      [b, "promoted"],
      [a, "retired"],
    ]);
    expect(rows.find((c) => c.id === a)?.events.map((e) => e.transition)).toEqual([
      "registered",
      "admitted",
      "promoted",
      "retired",
    ]);
    expect(rows.find((c) => c.id === a)?.events.every((e) => e.by === "anna@lab")).toBe(true);
    expect(listed.json.promoted).toEqual([{ backend: "card", model: "qwen-tuned" }]);
    // retire the promoted one: nothing routes to a candidate any more
    expect((await call(url, `/v1/models/lifecycle/${b}/retire`, "POST", admin, {})).status).toBe(200);
    expect(k.lifecycle.promoted("card")).toBeNull();
    expect((await call(url, `/v1/models/lifecycle/${b}/retire`, "POST", admin, {})).status).toBe(409);
  }, 60_000);

  it("a failed suite records the failures and leaves the candidate registered", async () => {
    const rt = await fakeRuntime(false);
    closers.push(() => rt.server.close());
    const { url } = await kvasir([local(rt.url)]);
    const c = (await call(url, "/v1/models/lifecycle", "POST", admin, { model: "qwen", backend: "card" }))
      .json.candidate as { id: number };
    const admitted = await call(url, `/v1/models/lifecycle/${c.id}/admit`, "POST", admin, {});
    expect(admitted.status).toBe(200);
    const after = admitted.json.candidate as {
      state: string;
      admission: { passed: boolean; failed: string[] };
    };
    expect(after.state).toBe("registered");
    expect(after.admission.passed).toBe(false);
    expect(after.admission.failed.length).toBeGreaterThan(0);
    expect((await call(url, `/v1/models/lifecycle/${c.id}/promote`, "POST", admin, {})).status).toBe(409);
    // a model the backend does not serve cannot be admitted; the refusal names it
    expect(
      (await call(url, "/v1/models/lifecycle", "POST", admin, { model: "qwen", backend: "nowhere" })).status,
    ).toBe(404);
    const dup = await call(url, "/v1/models/lifecycle", "POST", admin, { model: "qwen", backend: "card" });
    expect(dup.status).toBe(409);
  }, 60_000);
});
