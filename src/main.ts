// SPDX-License-Identifier: AGPL-3.0-only
// `kvasir --config kvasir.json`: serve, warming every backend at start.

import { read } from "./config.js";
import { build, listen, VERSION } from "./server.js";

const args = process.argv.slice(2);
const at = args.indexOf("--config");
const path = at >= 0 ? args[at + 1] : "kvasir.json";
if (args.includes("--version")) {
  console.log(`kvasir ${VERSION}`);
  process.exit(0);
}
let config: ReturnType<typeof read>;
try {
  config = read(path ?? "kvasir.json");
} catch (e) {
  console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
const k = build(config);
const address = await listen(k, config.bind);
console.log(
  `kvasir ${VERSION} serving ${address} as ${config.origin}, ${config.backends.length} backend(s), warming`,
);
// long-lived and warmed, never on demand (§8.5)
await Promise.all(k.backends.list.map((b) => b.warmup()));
for (const b of k.backends.list) {
  console.log(
    `  ${b.config.id}: ${b.health.warming ? `still warming (${b.health.lastError ?? "no first token yet"})` : "warm"}`,
  );
}
process.on("SIGINT", () => {
  k.close().then(() => process.exit(0));
});
