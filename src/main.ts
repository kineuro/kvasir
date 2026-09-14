// SPDX-License-Identifier: AGPL-3.0-only
// `kvasir --config kvasir.json`: serve the models this database holds, each
// local one warmed until its first token. And the command line, on the same
// database with no server bound: the models, the keys, admission and the
// lifecycle.

import { readFileSync } from "node:fs";
import { read } from "./config.js";
import { described, HeldRefused, type Tried, tryBackend } from "./held.js";
import { build, listen, ready, VERSION } from "./server.js";
import { probeRuntime } from "./suite.js";

const args = process.argv.slice(2);
const at = args.indexOf("--config");
const path = at >= 0 ? args[at + 1] : "kvasir.json";
if (args.includes("--version")) {
  console.log(`kvasir ${VERSION}`);
  process.exit(0);
}
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
/** Every value a repeated flag was given, in order. */
const flags = (name: string): string[] =>
  args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const by = flag("--by") ?? `${process.env.USER ?? "operator"}@cli`;
let config: ReturnType<typeof read>;
try {
  config = read(path ?? "kvasir.json");
} catch (e) {
  console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}

/** What each model said to its one short question, a line each. */
function sayTried(tried: Tried): void {
  if (tried.listed) console.log(`the server lists ${tried.listed.join(", ") || "no model"}`);
  for (const m of tried.models) {
    console.log(
      `  ${m.id}: ${m.answered ? "answered" : `did not answer (${m.error?.kind}): ${m.error?.message}`}`,
    );
  }
}

// `kvasir models list | test | add | remove` (record 23): the models this
// database holds. A model is added only once it answered one short request;
// a Kvasir serving the database follows within seconds, warming and admitting
// what was added and letting go what was removed.
if (args[0] === "models" && ["list", "test", "add", "remove"].includes(args[1] ?? "")) {
  const usage =
    "kvasir models add|test --url URL --locality local|remote --model ID [--model ID] [--kind openai-completions|anthropic-messages] [--id NAME] [--key-file FILE] [--context N] [--max-tokens N] [--reasoning] [--upstream NAME] [--name TEXT] [--concurrency N] [--temperature T] [--inline-reasoning off|markers|open] [--compat JSON]";
  const k = build(config);
  try {
    if (args[1] === "list") {
      for (const row of k.held.rows()) {
        const c = row.config;
        console.log(
          `${c.id}  ${c.kind}  ${c.locality}  ${c.baseUrl}  ${c.models.map((m) => m.id).join(", ")}${k.credentials.has(c.id) ? "  with a key" : ""}  added by ${row.addedBy} at ${new Date(row.addedAt).toISOString()}`,
        );
      }
    } else if (args[1] === "remove") {
      const id = flag("--id");
      if (!id) {
        console.error("kvasir models remove --id NAME");
        process.exit(2);
      }
      if (k.held.remove(id)) console.log(`removed ${id}`);
      else {
        console.error(`kvasir: no backend ${id}`);
        process.exitCode = 1;
      }
    } else {
      const keyFile = flag("--key-file");
      const models = flags("--model");
      if (models.length === 0 || !flag("--url")) {
        console.error(usage);
        process.exit(2);
      }
      const input = {
        id: flag("--id"),
        kind: flag("--kind"),
        baseUrl: flag("--url"),
        locality: flag("--locality"),
        key: keyFile ? readFileSync(keyFile, "utf8").trim() : undefined,
        concurrency: flag("--concurrency"),
        inlineReasoning: flag("--inline-reasoning"),
        compat: flag("--compat") ? JSON.parse(flag("--compat") as string) : undefined,
        defaults: flag("--temperature") ? { temperature: flag("--temperature") } : undefined,
        models: models.map((id) => ({
          id,
          upstream: flag("--upstream"),
          name: flag("--name"),
          contextWindow: flag("--context"),
          maxTokens: flag("--max-tokens"),
          reasoning: args.includes("--reasoning"),
        })),
      };
      if (args[1] === "test") {
        const d = described(input);
        const tried = await tryBackend(d.config, d.key);
        sayTried(tried);
        if (tried.models.some((m) => !m.answered)) process.exitCode = 1;
      } else {
        const { backend, tried } = await k.held.add(input, by);
        sayTried(tried);
        console.log(
          `added ${backend.config.id}${backend.config.locality === "local" ? "; a Kvasir serving this database warms and admits it" : ""}`,
        );
      }
    }
  } catch (e) {
    if (e instanceof HeldRefused && e.models.length > 0) sayTried({ listed: null, models: e.models });
    console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
  await k.close();
  process.exit(process.exitCode ?? 0);
}

// `kvasir keys mint --principal P --purposes a,b [--class catalog|rows|identifiers]`:
// an app's machine key minted on the same database with no server bound, for a
// deployment whose only admins are people at an identity provider and which
// therefore has no admin bearer to mint through the door (Wave 5 W0). The
// secret is printed once, on stdout, and nothing else is.
if (args[0] === "keys" && args[1] === "mint") {
  const principal = flag("--principal");
  if (!principal) {
    console.error(
      "kvasir keys mint --principal NAME --purposes a,b [--class catalog|rows|identifiers] [--expires-days N]",
    );
    process.exit(2);
  }
  const k = build(config);
  try {
    const purposes = (flag("--purposes") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const days = flag("--expires-days");
    const minted = k.keys.mint(
      principal,
      purposes,
      (flag("--class") ?? "catalog") as never,
      days ? Date.now() + Number(days) * 86_400_000 : null,
    );
    console.error(
      `kvasir: minted ${minted.id} for ${principal} with ${purposes.length} purpose(s), class ${minted.maxClass}${minted.expiresAt ? `, expires ${new Date(minted.expiresAt).toISOString()}` : ""}`,
    );
    console.log(minted.secret);
    await k.close();
    process.exit(0);
  } catch (e) {
    console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
    await k.close();
    process.exit(1);
  }
}

// `kvasir keys list | revoke --id ID`: the minted keys, never their secrets.
if (args[0] === "keys" && (args[1] === "list" || args[1] === "revoke")) {
  const k = build(config);
  if (args[1] === "list") {
    for (const key of k.keys.list()) {
      console.log(
        `${key.id}  ${key.principal}  ${key.purposes.join(",") || "no purpose"}  ${key.maxClass}${key.expiresAt ? `  expires ${new Date(key.expiresAt).toISOString()}` : ""}`,
      );
    }
  } else {
    const id = flag("--id");
    if (!id) {
      console.error("kvasir keys revoke --id ID");
      process.exit(2);
    }
    if (k.keys.revoke(id)) console.log(`revoked ${id}`);
    else {
      console.error(`kvasir: no key ${id}`);
      process.exitCode = 1;
    }
  }
  await k.close();
  process.exit(process.exitCode ?? 0);
}

// `kvasir admission list|run` (§8.6): the suite from the command line, on
// the same database, with no server bound but the process's own door for
// the overhead measurement.
if (args[0] === "admission") {
  const k = build(config);
  if (args[1] === "list") {
    for (const r of k.admissions.list(Number(flag("--limit") ?? 50))) {
      const checks = r.checks
        .map((c) => `${c.name}=${c.passed === null ? "n/a" : c.passed ? "pass" : "FAIL"}`)
        .join(" ");
      console.log(
        `${r.id}  ${new Date(r.at).toISOString()}  ${r.backend}/${r.model}  ${r.runtime.name} ${r.runtime.version}  ${r.passed ? "ADMITTED" : "refused"}  overflow=${r.overflow}  ${checks}${r.overhead ? `  overhead p50 ${r.overhead.overhead.p50} ms p95 ${r.overhead.overhead.p95} ms` : ""}`,
      );
    }
    await k.close();
    process.exit(0);
  }
  if (args[1] === "run") {
    const backend = flag("--backend");
    if (!backend) {
      console.error("kvasir admission run --backend ID [--model ID] [--overhead] [--json]");
      process.exit(2);
    }
    if (args.includes("--overhead")) await listen(k, "127.0.0.1:0");
    try {
      const records = await k.admit(backend, flag("--model"), {
        overhead: args.includes("--overhead"),
        log: (line) => console.log(line),
      });
      for (const r of records) {
        console.log(
          `${r.backend}/${r.model}: ${r.passed ? "ADMITTED" : "refused"} (record ${r.id}, runtime ${r.runtime.name} ${r.runtime.version}, overflow ${r.overflow})`,
        );
      }
      if (args.includes("--json")) console.log(JSON.stringify(records, null, 2));
      await k.close();
      process.exit(records.every((r) => r.passed) ? 0 : 1);
    } catch (e) {
      console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
      await k.close();
      process.exit(2);
    }
  }
  console.error("kvasir admission list | run");
  process.exit(2);
}

// `kvasir models lifecycle list|register|admit|promote|retire` (Wave 5 §9.5):
// the lifecycle from the command line, on the same database, as the doors do.
if (args[0] === "models" && args[1] === "lifecycle") {
  const k = build(config);
  const verb = args[2];
  const idOf = () => {
    const id = Number(flag("--id"));
    if (!Number.isInteger(id)) {
      console.error(`kvasir models lifecycle ${verb} --id N`);
      process.exit(2);
    }
    return id;
  };
  try {
    if (verb === "list") {
      for (const c of k.lifecycle.list()) {
        const adm = c.admission
          ? c.admission.passed
            ? "admitted"
            : `failed ${c.admission.failed.join(",") || "?"}`
          : "no admission";
        console.log(
          `${c.id}  ${c.backend}/${c.model}  ${c.state}  ${c.source.kind}${c.source.kind === "fine-tune" ? ` job ${c.source.job}` : ""}  ${adm}${c.proposal ? `  proposal ${c.proposal.id} by ${c.proposal.principal}` : ""}`,
        );
      }
    } else if (verb === "register") {
      const model = flag("--model");
      const backend = flag("--backend");
      if (!model || !backend) {
        console.error(
          "kvasir models lifecycle register --model ID --backend ID [--job N --recipe JSON] [--notes TEXT]",
        );
        process.exit(2);
      }
      const job = flag("--job");
      const source = job
        ? {
            kind: "fine-tune" as const,
            job: /^\d+$/.test(job) ? Number(job) : job,
            recipe: JSON.parse(flag("--recipe") ?? "{}"),
          }
        : { kind: "manual" as const };
      const c = k.lifecycle.register({ model, backend, source, notes: flag("--notes") ?? null }, by);
      console.log(`registered candidate ${c.id}: ${c.backend}/${c.model}`);
    } else if (verb === "admit") {
      const id = idOf();
      const c = k.lifecycle.get(id);
      if (!c) throw new Error(`no candidate ${id}`);
      const [rec] = await k.admit(c.backend, c.model, { log: (line) => console.log(line) });
      const after = k.lifecycle.recordAdmission(id, rec, "kvasir admission", VERSION, by);
      console.log(
        `candidate ${id}: ${after.state}${rec.passed ? "" : ` (failed ${after.admission?.failed.join(", ")})`}`,
      );
      if (!rec.passed) process.exitCode = 1;
    } else if (verb === "promote") {
      const id = idOf();
      const proposal = flag("--proposal") ? { id: flag("--proposal") as string, principal: by } : null;
      const { candidate, retired } = k.lifecycle.promote(id, by, proposal);
      console.log(
        `candidate ${id} promoted: ${candidate.backend}/${candidate.model}${retired ? `; candidate ${retired.id} (${retired.model}) retired` : ""}`,
      );
    } else if (verb === "retire") {
      const id = idOf();
      const c = k.lifecycle.retire(id, by);
      console.log(`candidate ${id} retired: ${c.backend}/${c.model}`);
    } else {
      console.error("kvasir models lifecycle list | register | admit | promote | retire");
      process.exit(2);
    }
    await k.close();
    process.exit(process.exitCode ?? 0);
  } catch (e) {
    console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
    await k.close();
    process.exit(1);
  }
}

const k = build(config);
// a backend added while this serves, from the desk or the command line, is admitted and warmed here
k.held.onAdded = (backend) => void ready(k, backend);
// the admitted sets from the records, against the runtime each backend reports now (§8.6)
await k.admissions.load(k.backends, (b) => probeRuntime(b));
const address = await listen(k, config.bind);
const held = k.backends.list.length;
console.log(
  `kvasir ${VERSION} serving ${address} as ${config.origin}, ${held === 0 ? "with no model yet: an admin adds one from the desk or with kvasir models add" : `${held} backend(s), warming`}`,
);
// long-lived and warmed, never on demand (§8.5): one try at start, then again until a first token
await Promise.all(k.backends.list.map((b) => b.warmup()));
for (const b of k.backends.list) {
  const admitted =
    b.config.locality === "remote"
      ? ""
      : `, admitted: ${[...b.admitted].join(", ") || `none (kvasir admission run --backend ${b.config.id})`}`;
  const again = b.config.warmup === false ? "" : ", trying again";
  console.log(
    `  ${b.config.id}: ${b.health.warming ? `still warming (${b.health.lastError ?? "no first token yet"})${again}` : "warm"}${admitted}`,
  );
  if (b.health.warming) void b.keepWarm(undefined, (line) => console.log(`  ${line}`));
}
k.held.watch();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    k.close().then(() => process.exit(0));
  });
}
