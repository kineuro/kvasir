// SPDX-License-Identifier: AGPL-3.0-only
// `kvasir --config kvasir.json`: serve the models this database holds, each
// local one warmed until its first token. And the command line, on the same
// database with no server bound: the models, the keys, admission and the
// lifecycle.

import { readFileSync } from "node:fs";
import { read } from "./config.js";
import { described, HeldRefused, type Tried, tryBackend } from "./held.js";
import { readable } from "./local.js";
import { build, listen, ready, VERSION } from "./server.js";
import { SYSTEM } from "./subscriptions.js";
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
      // a test with no model lists what the server serves; an add names at least one
      if (!flag("--url") || (args[1] === "add" && models.length === 0)) {
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
        const d = described(input, { modelsOptional: true });
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

// `kvasir subscriptions list | sign-in | sign-out [--subject S]` (record 23): a
// ChatGPT subscription from the command line, the install's unless a subject
// is named, for the setup of an install where nobody signs in. The sign-in
// shows a code and a link, and waits until the person approves.
if (args[0] === "subscriptions" && ["list", "sign-in", "sign-out"].includes(args[1] ?? "")) {
  const k = build(config);
  const subject = flag("--subject") ?? SYSTEM;
  try {
    if (args[1] === "list") {
      for (const s of k.subscriptions.list()) {
        console.log(
          `${s.subject}  ChatGPT  ${s.model ?? "no model"}  since ${new Date(s.since).toISOString()}${s.refreshedAt ? `  refreshed ${new Date(s.refreshedAt).toISOString()}` : ""}`,
        );
      }
    } else if (args[1] === "sign-out") {
      if (k.subscriptions.signOut(subject)) console.log(`signed ${subject} out of ChatGPT`);
      else {
        console.error(`kvasir: no ChatGPT subscription is signed in for ${subject}`);
        process.exitCode = 1;
      }
    } else {
      const waiting = await k.subscriptions.signIn(subject);
      console.log(`Open ${waiting.verificationUri} and enter the code ${waiting.userCode}`);
      console.log(`The code works until ${new Date(waiting.expiresAt).toISOString()}.`);
      for (;;) {
        const s = k.subscriptions.status(subject, subject === SYSTEM ? "system" : "person");
        if (s.state === "signed_in") {
          console.log(`Signed in to ChatGPT; streams use ${s.model}.`);
          break;
        }
        if (s.state === "failed") {
          console.error(`kvasir: the sign-in did not finish: ${s.error}`);
          process.exitCode = 1;
          break;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  } catch (e) {
    console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
  await k.close();
  process.exit(process.exitCode ?? 0);
}

// `kvasir local list | location | lookup | download | pause | resume | remove | token`
// (record 23): local models on the same database. A download, or a resume, is
// left to a Kvasir serving the database when one takes it within seconds, and
// is otherwise downloaded here until it is done. Stopped with Ctrl-C, it carries
// on when a Kvasir starts on the database, or with `kvasir local resume`.
if (args[0] === "local") {
  const verb = args[1] ?? "";
  const usage =
    "kvasir local list | location [--set PATH] | lookup --repo OWNER/NAME [--revision V] [--include GLOB]... | download --repo OWNER/NAME [--revision V] [--include GLOB]... | pause|resume|remove --id N | token --file FILE | token --clear";
  const known = ["list", "location", "lookup", "download", "pause", "resume", "remove", "token"];
  if (
    !known.includes(verb) ||
    ((verb === "lookup" || verb === "download") && !flag("--repo")) ||
    (verb === "token" && !flag("--file") && !args.includes("--clear"))
  ) {
    console.error(usage);
    process.exit(2);
  }
  const idOf = (): number => {
    const id = Number(flag("--id"));
    if (!Number.isInteger(id) || id < 1) {
      console.error(`kvasir local ${verb} --id N`);
      process.exit(2);
    }
    return id;
  };
  const asked = { repo: flag("--repo"), revision: flag("--revision"), include: flags("--include") };
  const k = build(config);
  try {
    if (verb === "list") {
      const s = k.local.status();
      console.log(
        `new downloads go to ${s.location}${s.free_bytes === null ? "" : `, with ${readable(s.free_bytes)} free`}; ${s.token ? "a Hugging Face token is set" : "no Hugging Face token is set"}`,
      );
      for (const m of s.models) {
        console.log(
          `${m.id}  ${m.repo}@${m.revision}  ${m.commit.slice(0, 12)}  ${m.state}  ${readable(m.bytes_done)} of ${readable(m.bytes_total)} in ${m.files} file(s)  ${m.path}${m.error ? `  ${m.error}` : ""}`,
        );
        for (const c of m.serve) console.log(`    ${c.runtime}: ${c.command}`);
      }
    } else if (verb === "location") {
      const set = flag("--set");
      if (set === undefined) console.log(k.local.location());
      else
        console.log(
          `new downloads go to ${k.local.setLocation(set, by)}; the models downloaded before stay where they are`,
        );
    } else if (verb === "lookup") {
      const found = await k.local.lookup(asked);
      console.log(`${found.repo} at ${found.revision} is commit ${found.commit}`);
      for (const f of found.files)
        console.log(`  ${f.path}  ${readable(f.size)}${f.sha256 ? "" : "  (the hub lists no sha256)"}`);
      console.log(`${found.files.length} file(s), ${readable(found.bytes_total)}`);
    } else if (verb === "download" || verb === "resume") {
      const row = verb === "download" ? await k.local.add(asked, by) : k.local.resume(idOf());
      console.log(
        `model ${row.id}: ${row.repo} at ${row.commit.slice(0, 12)}, ${row.files} file(s) and ${readable(row.bytes_total)}, into ${row.path}`,
      );
      let stopping = false;
      process.once("SIGINT", () => {
        stopping = true;
        void k.local.stop();
      });
      const shown = setInterval(() => {
        const now = k.local.get(row.id);
        if (now?.state === "downloading")
          console.log(`model ${row.id}: ${readable(now.bytes_done)} of ${readable(now.bytes_total)}`);
      }, 10_000);
      const how = await k.local.follow(row.id, {
        here: () => console.log(`no Kvasir serving this database took model ${row.id}, so it downloads here`),
      });
      clearInterval(shown);
      const after = k.local.get(row.id);
      if (stopping) {
        console.log(
          `model ${row.id} stopped with what it has; it carries on when a Kvasir starts on this database, or with kvasir local resume --id ${row.id}`,
        );
        process.exitCode = 130;
      } else if (how === "waiting")
        console.log(`a Kvasir on this database is downloading another model; model ${row.id} waits its turn`);
      else if (after?.state === "downloading")
        console.log(
          `a Kvasir serving this database is downloading model ${row.id}; kvasir local list shows how far it is`,
        );
      else if (after?.state === "done") {
        console.log(`model ${row.id} is downloaded into ${after.path}`);
        for (const c of after.serve) console.log(`  ${c.runtime}: ${c.command}`);
      } else if (after?.state === "failed") {
        console.error(`kvasir: model ${row.id} failed: ${after.error}`);
        process.exitCode = 1;
      } else console.log(`model ${row.id} is ${after?.state ?? "removed"}`);
    } else if (verb === "pause") {
      const row = k.local.pause(idOf());
      console.log(`model ${row.id} is ${row.state}`);
    } else if (verb === "remove") {
      const id = idOf();
      if (await k.local.remove(id)) console.log(`removed model ${id} and its files`);
      else {
        console.error(`kvasir: no local model ${id}`);
        process.exitCode = 1;
      }
    } else if (args.includes("--clear")) {
      console.log(
        k.local.clearToken() ? "the Hugging Face token is cleared" : "no Hugging Face token was set",
      );
    } else {
      k.local.setToken(readFileSync(flag("--file") as string, "utf8"));
      console.log("the Hugging Face token is sealed; Kvasir never shows it");
    }
  } catch (e) {
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
// local model downloads left queued or downloading when Kvasir last closed carry on, one model at a time (record 23)
k.local.say = (line) => console.log(`  ${line}`);
const carrying = k.local.start();
if (carrying > 0) console.log(`  ${carrying} local model download(s) to carry on`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    k.close().then(() => process.exit(0));
  });
}
