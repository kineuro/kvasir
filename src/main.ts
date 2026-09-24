// SPDX-License-Identifier: AGPL-3.0-only
// `kvasir --config kvasir.json`: serve the models this database holds, each
// local one warmed until its first token. And the command line, on the same
// database with no server bound: the models, the keys (NILS's apps' and the
// clients'), admission and the lifecycle.

import { readFileSync } from "node:fs";
import { read } from "./config.js";
import { described, HeldRefused, RUNTIME_BACKEND, type Tried, tryBackend } from "./held.js";
import { readable } from "./local.js";
import { build, listen, listenPublic, ready, VERSION } from "./server.js";
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

// `kvasir models add --server URL --key-file F [--model ID]...` (record 47): a model server's models listed
// with their specs from its /v1/models, and the ones named admitted one by one on the server's one backend,
// its key sealed under the backend. Without --model the list is shown and nothing is kept.
if (args[0] === "models" && args[1] === "add" && flag("--server")) {
  const k = build(config);
  const keyFile = flag("--key-file");
  const input = {
    url: flag("--server"),
    key: keyFile ? readFileSync(keyFile, "utf8").trim() : undefined,
    id: flag("--id"),
    locality: flag("--locality") ?? "local",
    models: flags("--model"),
  };
  try {
    const offer = await k.servers.offered(input);
    if (offer.note) console.log(offer.note);
    const loaded = offer.server?.loaded;
    console.log(
      `${offer.url} offers ${offer.models.length} model(s)${loaded ? `; ${loaded} is loaded` : ""}`,
    );
    for (const m of offer.models) {
      const caps = [m.reasoning ? "reasoning" : "", m.tools ? "tools" : "", m.vision ? "vision" : ""]
        .filter(Boolean)
        .join(", ");
      console.log(
        `  ${m.id}${m.default ? " (default)" : ""}  ${m.status}  context ${m.context_length ?? "?"}  answer ${m.max_output_tokens ?? "?"}  ${m.max_concurrent_requests ?? "?"} at once${caps ? `  ${caps}` : ""}${m.aliases.length ? `  also ${m.aliases.join(", ")}` : ""}${m.held_by ? `  held by ${m.held_by}` : ""}`,
      );
    }
    if (input.models.length === 0) {
      console.log(
        `nothing is added: name the models to admit with --model ID, such as kvasir models add --server ${offer.url}${keyFile ? ` --key-file ${keyFile}` : ""} --model ${offer.models.find((m) => m.default)?.id ?? offer.models[0]?.id ?? "ID"}`,
      );
    } else {
      const done = await k.servers.admit(input, by, (line) => console.log(`  ${line}`));
      for (const r of done.results)
        console.log(
          `${r.id}: ${!r.answered ? `did not answer (${r.error?.kind}): ${r.error?.message}` : r.admitted === null ? "held" : r.admitted ? "admitted" : "held, refused by admission"}`,
        );
      if (done.backend)
        console.log(
          `${done.backend.id} holds ${done.backend.models.join(", ")}; a Kvasir serving this database follows within seconds`,
        );
      if (done.results.some((r) => !r.answered || r.admitted === false)) process.exitCode = 1;
    }
  } catch (e) {
    console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
  await k.close();
  process.exit(process.exitCode ?? 0);
}

// `kvasir models list | test | add | remove` (record 23): the models this
// database holds. A model is added only once it answered one short request;
// a Kvasir serving the database follows within seconds, warming and admitting
// what was added and letting go what was removed.
if (args[0] === "models" && ["list", "test", "add", "remove"].includes(args[1] ?? "")) {
  const usage =
    "kvasir models add --server URL [--key-file FILE] [--model ID]... [--id NAME] [--locality local|remote]\nkvasir models add|test --url URL --locality local|remote --model ID [--model ID] [--kind openai-completions|anthropic-messages] [--id NAME] [--key-file FILE] [--context N] [--max-tokens N] [--reasoning] [--upstream NAME] [--name TEXT] [--concurrency N] [--temperature T] [--inline-reasoning off|markers|open] [--compat JSON] [--pass-through chat-completions,completions,messages,responses] [--anthropic-thinking disabled|as-sent]";
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
        passThrough: flag("--pass-through"),
        anthropicThinking: flag("--anthropic-thinking"),
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
        const d = described(input, { modelsOptional: true, hostAlias: config.hostAlias });
        if (d.note) console.log(d.note);
        const tried = await tryBackend(d.config, d.key);
        sayTried(tried);
        if (tried.models.some((m) => !m.answered)) process.exitCode = 1;
      } else {
        const { backend, tried, note } = await k.held.add(input, by);
        if (note) console.log(note);
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

// `kvasir local list | location | lookup | download | pause | resume | remove | token | start | stop`
// (record 23): local models on the same database. A download, or a resume, is
// left to a Kvasir serving the database when one takes it within seconds, and
// is otherwise downloaded here until it is done. Stopped with Ctrl-C, it carries
// on when a Kvasir starts on the database, or with `kvasir local resume`.
// A start or a stop (record 24) is kept in the database as what an admin wants,
// carried out here at once on the install's runtime, and followed by a Kvasir
// serving the database, which warms and admits a model once it is loaded.
if (args[0] === "local") {
  const verb = args[1] ?? "";
  const usage =
    "kvasir local list | location [--set PATH] | lookup --repo OWNER/NAME [--revision V] [--include GLOB]... | download --repo OWNER/NAME [--revision V] [--include GLOB]... | pause|resume|remove --id N | start --id N [--file PATH] [--context TOKENS] [--wait SECONDS] | stop --id N | token --file FILE | token --clear";
  const known = [
    "list",
    "location",
    "lookup",
    "download",
    "pause",
    "resume",
    "remove",
    "token",
    "start",
    "stop",
  ];
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
      await k.runner?.look();
      const s = k.local.status();
      console.log(
        `new downloads go to ${s.location}${s.free_bytes === null ? "" : `, with ${readable(s.free_bytes)} free`}; ${s.token ? "a Hugging Face token is set" : "no Hugging Face token is set"}`,
      );
      if (s.runtime)
        console.log(
          `the runtime, llama.cpp ${s.runtime.build} ${s.runtime.variant}, ${s.runtime.reachable ? `answers${s.runtime.serving === null ? " with no model loaded" : `, serving model ${s.runtime.serving}`}` : "does not answer"}`,
        );
      for (const m of s.models) {
        console.log(
          `${m.id}  ${m.repo}@${m.revision}  ${m.commit.slice(0, 12)}  ${m.state}  ${readable(m.bytes_done)} of ${readable(m.bytes_total)} in ${m.files} file(s)  ${m.path}${m.error ? `  ${m.error}` : ""}`,
        );
        if (m.run)
          console.log(
            `    ${m.run.state} as ${m.run.model}${m.run.context ? `, ${m.run.context} tokens of context` : ""}${m.run.error ? `: ${m.run.error}` : ""}${m.run.note ? ` (${m.run.note})` : ""}`,
          );
        else if (m.startable) console.log(`    starts with kvasir local start --id ${m.id}`);
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
    } else if (verb === "start" || verb === "stop") {
      const runner = k.runner;
      if (!runner) {
        console.error(
          "kvasir: kvasir.json names no runtime (local.runtime), so Kvasir starts no model here: start a model server with one of the commands kvasir local list shows, then add it with kvasir models add",
        );
        process.exit(2);
      }
      runner.say = (line) => console.log(line);
      const id = idOf();
      if (verb === "stop") {
        const row = await runner.stop(id);
        console.log(`model ${id} is ${row.run?.state ?? "not started"}`);
      } else {
        const context = flag("--context");
        let row = await runner.start(
          id,
          by,
          flag("--file"),
          context === undefined ? undefined : Number(context),
        );
        const until = Date.now() + Number(flag("--wait") ?? 600) * 1000;
        while (row.run?.state === "starting" && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 2_000));
          await runner.tick();
          row = k.local.get(id) ?? row;
        }
        if (row.run?.state === "serving")
          console.log(
            `model ${id} is loaded as ${row.run.model}; a Kvasir serving this database warms and admits it, and the stations use it once it is admitted`,
          );
        else if (row.run?.state === "failed") {
          console.error(`kvasir: model ${id} did not start: ${row.run.error}`);
          for (const line of row.run.log) console.error(`  ${line}`);
          process.exitCode = 1;
        } else
          console.log(
            `model ${id} is ${row.run?.state ?? "starting"}${row.run?.error ? ` (${row.run.error})` : ""}; a Kvasir serving this database carries it on, and kvasir local list shows it`,
          );
      }
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

// `kvasir keys add | import | list | revoke`: the client keys of the doors that
// pass a request through (record 47), beside the minted keys of NILS's apps.
// `add` prints the new key once, on stdout, and nothing else there; `import`
// reads modelgate's keys file, one `name sha256hex` per line, so the keys
// people hold today keep working; `list` shows every key, never a secret or a
// hash, with each client key's use over the ledger's days; `revoke` takes a
// key's id, or a client key's name where one live key carries it.
if (args[0] === "keys" && ["add", "import", "list", "revoke"].includes(args[1] ?? "")) {
  const k = build(config);
  try {
    if (args[1] === "add") {
      const name = flag("--name");
      if (!name) {
        console.error("kvasir keys add --name NAME [--models ID,ID] [--no-swap]");
        process.exit(2);
      }
      const models = (flag("--models") ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      const made = k.clients.add(name, { models, swap: !args.includes("--no-swap"), by });
      console.error(
        `kvasir: made client key ${made.id} for ${made.name}, ${made.models ? `models ${made.models.join(", ")}` : "every model"}, ${made.swap ? "may load a cold model" : "never loads a cold model"}`,
      );
      console.log(made.secret);
    } else if (args[1] === "import") {
      const file = flag("--modelgate") ?? flag("--file");
      if (!file) {
        console.error("kvasir keys import --modelgate FILE");
        process.exit(2);
      }
      const r = k.clients.importModelgate(file, by);
      console.log(
        `imported ${r.added} key(s) from ${file}; ${r.present} already held, ${r.skipped} line(s) not a key`,
      );
    } else if (args[1] === "list") {
      for (const key of k.keys.list()) {
        console.log(
          `${key.id}  ${key.principal}  ${key.purposes.join(",") || "no purpose"}  ${key.maxClass}${key.expiresAt ? `  expires ${new Date(key.expiresAt).toISOString()}` : ""}`,
        );
      }
      const days = k.config.clients.ledgerDays;
      const usage = k.clients.usage(days);
      for (const c of k.clients.list()) {
        const u = usage.get(c.id);
        console.log(
          `${c.id}  ${c.name}  client (${c.origin})  ${c.models ? c.models.join(",") : "every model"}  ${c.swap ? "swap" : "no swap"}  made ${new Date(c.createdAt).toISOString()}${c.revokedAt ? `  REVOKED ${new Date(c.revokedAt).toISOString()}` : ""}  ${c.lastUsedAt ? `last used ${new Date(c.lastUsedAt).toISOString()}` : "never used"}  ${days} d: ${u?.streams ?? 0} stream(s), ${u?.input ?? 0} in, ${u?.output ?? 0} out`,
        );
      }
    } else {
      const id = flag("--id");
      const name = flag("--name");
      if (!id && !name) {
        console.error("kvasir keys revoke --id ID | --name NAME");
        process.exit(2);
      }
      if (id) {
        if (id.startsWith("c_") ? k.clients.revoke(id) : k.keys.revoke(id)) console.log(`revoked ${id}`);
        else {
          console.error(`kvasir: no key ${id} that is not revoked`);
          process.exitCode = 1;
        }
      } else {
        const live = k.clients.named(name as string);
        if (live.length !== 1) {
          console.error(
            live.length === 0
              ? `kvasir: no live client key is named ${name}`
              : `kvasir: ${live.length} live client keys are named ${name}: revoke one by --id (${live.map((c) => c.id).join(", ")})`,
          );
          process.exitCode = 1;
        } else {
          k.clients.revoke(live[0].id);
          console.log(`revoked ${live[0].id} (${name})`);
        }
      }
    }
  } catch (e) {
    console.error(`kvasir: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
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
// a card's model, once loaded, is admitted where it has no record and the gate holds (record 47)
k.cards.onLoaded = (backend) => void ready(k, backend);
// the admitted sets from the records, against the runtime each backend reports now (§8.6)
await k.admissions.load(k.backends, (b) => probeRuntime(b));
const address = await listen(k, config.bind);
// the doors meant for the public route on a listener of their own, where kvasir.json names one (record 47)
if (config.public.bind)
  console.log(`kvasir: the public doors on ${await listenPublic(k, config.public.bind)} as well`);
// the models an admin added; Kvasir's own ChatGPT is not one of them
const added = k.backends.list.filter((b) => !b.config.builtin);
const held = added.length;
console.log(
  `kvasir ${VERSION} serving ${address} as ${config.origin}, ${held === 0 ? "with no model yet: an admin adds one from the desk or with kvasir models add" : `${held} backend(s), warming`}`,
);
// long-lived and warmed, never on demand (§8.5): one try at start, then again until a first token
await Promise.all(k.backends.list.map((b) => b.warmup()));
for (const b of added) {
  const admitted =
    b.config.locality === "remote"
      ? ""
      : `, admitted: ${[...b.admitted].join(", ") || `none (kvasir admission run --backend ${b.config.id})`}`;
  const on = k.cards.of(b);
  // a backend Kvasir does not warm is cold until a request reaches it (#8); a card's model is its card's
  const state = on
    ? `on ${on.card.id}`
    : b.health.warming
      ? `still warming (${b.health.lastError ?? "no first token yet"}), trying again`
      : b.health.firstTokenAt || b.config.locality === "remote"
        ? "warm"
        : "not warmed";
  console.log(`  ${b.config.id}: ${state}${admitted}`);
  if (b.health.warming) void b.keepWarm(undefined, (line) => console.log(`  ${line}`));
}
k.held.watch();
// the cards adopt the model already running, or load their default, and swap on request (record 47)
for (const card of k.cards.list)
  console.log(
    `  ${card.id}: ${card.config.driver.kind}, ${[...card.members.keys()].join(", ")}; default ${card.default}${card.config.manage ? "" : "; watched, never started or stopped"}`,
  );
void k.cards.start((line) => console.log(`  ${line}`));
// what each model server held as a backend says of its models, loaded or cold, every 30 seconds
k.servers.watch();
// local model downloads left queued or downloading when Kvasir last closed carry on, one model at a time (record 23)
k.local.say = (line) => console.log(`  ${line}`);
const carrying = k.local.start();
if (carrying > 0) console.log(`  ${carrying} local model download(s) to carry on`);
// the models an admin started on the runtime are followed, and loaded again where the runtime lost them (record 24)
if (k.runner) {
  k.runner.say = (line) => console.log(`  ${line}`);
  console.log(
    `  the runtime: llama.cpp ${k.runner.config.build} ${k.runner.config.variant} at ${k.runner.config.url}`,
  );
  k.runner.follow();
  // a model held from before, loaded while no Kvasir served, is warmed and admitted as one started here is
  const own = k.backends.get(RUNTIME_BACKEND);
  if (own?.config.models.some((m) => !own.admitted.has(m.id))) void ready(k, own);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    k.close().then(() => process.exit(0));
  });
}
