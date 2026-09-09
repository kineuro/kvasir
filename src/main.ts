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
