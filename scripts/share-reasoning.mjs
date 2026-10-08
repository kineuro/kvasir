#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// The reasoning splitter is one module shared by three repositories: kvasir is
// its home (src/reasoning.ts), and nils-assistant and nils-desk carry copies.
// This stamps kvasir's file with the sha256 of its content (the stamp line left
// out) and copies it to each path given; with --check it changes nothing and
// fails where the stamp is stale or a copy differs.
//
//   node scripts/share-reasoning.mjs
//   node scripts/share-reasoning.mjs ../nils-assistant/src/host/reasoning.ts ../nils-desk/web/src/assistant/reasoning.ts
//   node scripts/share-reasoning.mjs --check ../nils-assistant/src/host/reasoning.ts ../nils-desk/web/src/assistant/reasoning.ts

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STAMP = /^\/\/ shared-sha256: [0-9a-f]{64}\n/mu;
const home = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "reasoning.ts");

/** The sha256 of a text without its stamp line. */
const digest = (text) => createHash("sha256").update(text.replace(STAMP, "")).digest("hex");

const args = process.argv.slice(2);
const check = args.includes("--check");
const targets = args.filter((a) => a !== "--check");

const text = readFileSync(home, "utf8");
if (!STAMP.test(text)) {
  console.error(`${home}: no "// shared-sha256: <hex>" line`);
  process.exit(1);
}
const stamped = text.replace(STAMP, `// shared-sha256: ${digest(text)}\n`);
let failed = false;
if (stamped !== text) {
  if (check) {
    console.error(`${home}: the stamp is stale; run node scripts/share-reasoning.mjs`);
    failed = true;
  } else {
    writeFileSync(home, stamped);
    console.log(`stamped ${home}`);
  }
}
for (const target of targets) {
  let copy = null;
  try {
    copy = readFileSync(target, "utf8");
  } catch {
    copy = null;
  }
  if (copy === stamped) {
    console.log(`same ${target}`);
    continue;
  }
  if (check) {
    console.error(`${target}: differs from kvasir's src/reasoning.ts`);
    failed = true;
  } else {
    writeFileSync(target, stamped);
    console.log(`copied ${target}`);
  }
}
process.exit(failed ? 1 : 0);
