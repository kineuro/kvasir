// SPDX-License-Identifier: AGPL-3.0-only
// `kvasir --config kvasir.json`: serve, warming every backend at start.

import { read } from "./config.js";
import { build, listen, VERSION } from "./server.js";
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
let config: ReturnType<typeof read>;
try {
  config = read(path ?? "kvasir.json");
} catch (e) {
  console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
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
      console.error("kvasir admission run --backend ID [--model ID] [--overhead] [--streams N] [--rounds N]");
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
  const by = flag("--by") ?? `${process.env.USER ?? "operator"}@cli`;
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
// the admitted sets from the records, against the runtime each backend reports now (§8.6)
await k.admissions.load(k.backends, (b) => probeRuntime(b));
const address = await listen(k, config.bind);
console.log(
  `kvasir ${VERSION} serving ${address} as ${config.origin}, ${config.backends.length} backend(s), warming`,
);
// long-lived and warmed, never on demand (§8.5)
await Promise.all(k.backends.list.map((b) => b.warmup()));
for (const b of k.backends.list) {
  const admitted =
    b.config.locality === "remote"
      ? ""
      : `, admitted: ${[...b.admitted].join(", ") || `none (kvasir admission run --backend ${b.config.id})`}`;
  console.log(
    `  ${b.config.id}: ${b.health.warming ? `still warming (${b.health.lastError ?? "no first token yet"})` : "warm"}${admitted}`,
  );
}
process.on("SIGINT", () => {
  k.close().then(() => process.exit(0));
});
