// SPDX-License-Identifier: AGPL-3.0-only
// Local models (record 23): Kvasir downloads a model from the Hugging Face Hub
// into a location an admin can change, one file at a time, each file resumed
// from what it already holds and checked against the sha256 the hub lists, and
// lists every model with its size, its state and the commands a model server
// runs it with. Kvasir runs no model: an admin starts their own model server on
// a download and adds that server as any other. Two Kvasirs on one database
// never download at once, because the one downloading holds a lease in the
// database and renews it while it downloads.

import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { Credentials } from "./credentials.js";
import type { Store } from "./store.js";

/** The credential the Hugging Face token is sealed under. */
export const HUGGING_FACE = "huggingface";
/** The Hugging Face Hub, where kvasir.json names no mirror. */
export const HUB = "https://huggingface.co";
/** The space a download leaves free beside itself. */
export const SPARE_BYTES = 2 ** 30;
/** The setting that names where new downloads go. */
const LOCATION = "local.location";

export const LOCAL_SCHEMA = [
  // the settings an admin changes while Kvasir runs, a row each, where no file needs editing
  `CREATE TABLE IF NOT EXISTS setting (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     set_by TEXT NOT NULL,
     set_at INTEGER NOT NULL
   )`,
  // a model to download, or downloaded: its files as the hub listed them, and the folder it keeps
  `CREATE TABLE IF NOT EXISTS local_model (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     repo TEXT NOT NULL,
     revision TEXT NOT NULL,
     commit_sha TEXT NOT NULL,
     include TEXT NOT NULL,
     path TEXT NOT NULL,
     files TEXT NOT NULL,
     state TEXT NOT NULL,
     bytes_total INTEGER NOT NULL,
     bytes_done INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     added_by TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  // a folder holds one model: the same repository and commit downloaded again into one location is refused
  "CREATE UNIQUE INDEX IF NOT EXISTS local_model_path ON local_model (path)",
  // who downloads now: one Kvasir at a time on the database, its lease renewed while it downloads
  `CREATE TABLE IF NOT EXISTS local_lease (
     name TEXT PRIMARY KEY,
     holder TEXT NOT NULL,
     lease_until INTEGER NOT NULL
   )`,
];

export type LocalState = "queued" | "downloading" | "paused" | "done" | "failed";

/** One file of a model as the hub lists it. */
export interface HubFile {
  path: string;
  size: number;
  /** The sha256 of a file the hub keeps in LFS; a small file kept in git has none. */
  sha256: string | null;
}

/** What a model would download: the commit its revision names now, and the files the patterns choose. */
export interface Lookup {
  repo: string;
  revision: string;
  commit: string;
  include: string[];
  files: HubFile[];
  bytes_total: number;
}

/** A command a model server runs a download with, in words: Kvasir never runs it. */
export interface Serve {
  runtime: string;
  command: string;
}

export interface LocalRow {
  id: number;
  repo: string;
  revision: string;
  commit: string;
  path: string;
  state: LocalState;
  files: number;
  bytes_total: number;
  bytes_done: number;
  error: string | null;
  added_by: string;
  added_at: number;
  finished_at: number | null;
  serve: Serve[];
}

/** What an admin asks for: a repository, and where they want them, a revision and the patterns of the files. */
export interface LookupInput {
  repo?: unknown;
  revision?: unknown;
  include?: unknown;
}

/** Why a door refused, with the status it answers, a code a page can act on, and any numbers behind the words. */
export class LocalRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A size in the unit a person reads it in. */
export function readable(bytes: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${n} bytes` : `${n.toFixed(1)} ${units[unit]}`;
}

const NAME = /^[A-Za-z0-9._-]{1,96}$/u;

/** A repository on the hub, owner/name, or a refusal in words. */
export function repoOf(input: unknown): { repo: string; owner: string; name: string } {
  const repo = typeof input === "string" ? input.trim() : "";
  const [owner = "", name = "", ...rest] = repo.split("/");
  if (rest.length > 0 || !NAME.test(owner) || !NAME.test(name))
    throw new LocalRefused(
      400,
      "bad_request",
      "repo: a model on the hub as owner/name, in letters, digits, dots, dashes and underscores",
    );
  // the hub names no repository with either, and a folder <owner>--<name> must name one repository only
  if (repo.includes("--") || repo.includes(".."))
    throw new LocalRefused(
      400,
      "bad_request",
      `repo: ${repo} holds -- or .., which no model on the hub does`,
    );
  return { repo, owner, name };
}

/** A branch, a tag or a forty-character commit; main where none is named. */
export function revisionOf(input: unknown): string {
  if (input === undefined || input === null || input === "") return "main";
  const revision = typeof input === "string" ? input.trim() : "";
  if (/^[0-9a-f]{40}$/u.test(revision)) return revision;
  const segment = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;
  if (
    revision.length <= 128 &&
    revision.split("/").every((s) => segment.test(s)) &&
    !revision.includes("..") &&
    !revision.endsWith(".") &&
    !revision.endsWith(".lock")
  )
    return revision;
  throw new LocalRefused(400, "bad_request", "revision: a branch, a tag or a forty-character commit");
}

/** The patterns that choose the files; none, and every file downloads. */
export function includeOf(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  const list = typeof input === "string" ? [input] : input;
  if (
    !Array.isArray(list) ||
    list.length > 64 ||
    list.some((p) => typeof p !== "string" || p.length === 0 || p.length > 256)
  )
    throw new LocalRefused(
      400,
      "bad_request",
      "include: glob patterns that choose the files, such as *.safetensors, at most sixty-four",
    );
  return list as string[];
}

/**
 * A glob pattern read the way the hub's own command line reads one: `*`
 * matches any characters, a slash among them, `?` matches one, `[...]` one of
 * a set and `[!...]` one outside it, and a pattern that ends in a slash matches
 * everything in that folder.
 */
export function globOf(pattern: string): RegExp {
  const p = pattern.endsWith("/") ? `${pattern}*` : pattern;
  let out = "";
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      let j = i + 1;
      if (p[j] === "!") j += 1;
      if (p[j] === "]") j += 1;
      while (j < p.length && p[j] !== "]") j += 1;
      if (j >= p.length) {
        out += "\\[";
        continue;
      }
      const set = p.slice(i + 1, j);
      const negated = set.startsWith("!");
      out += `[${negated ? "^" : ""}${(negated ? set.slice(1) : set).replace(/[\\\][^]/gu, "\\$&")}]`;
      i = j;
    } else out += c.replace(/[\\^$.+(){}|/[\]]/gu, "\\$&");
  }
  return new RegExp(`^${out}$`, "su");
}

/** Whether a path the hub lists stays inside the model's folder: never absolute, never climbing, never a backslash. */
export function safePath(path: string): boolean {
  return !(
    path === "" ||
    isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.includes("..") ||
    path.includes("\0") ||
    path.split("/").some((s) => s === "" || s === ".")
  );
}

/**
 * A GET to the hub, its redirects followed by hand so the token goes only to
 * the hub's own address and never to the storage a large file is sent from.
 */
export async function hubGet(
  endpoint: string,
  url: string,
  token: string | null,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const hub = new URL(endpoint).origin;
  let at = new URL(url);
  for (let hops = 0; hops <= 5; hops += 1) {
    const r = await fetch(at, {
      headers: { ...headers, ...(token && at.origin === hub ? { authorization: `Bearer ${token}` } : {}) },
      redirect: "manual",
      signal,
    });
    const location = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!location) return r;
    await r.body?.cancel();
    const next = new URL(location, at);
    if (next.protocol !== "https:" && (next.protocol !== "http:" || at.protocol === "https:"))
      throw new LocalRefused(
        502,
        "hub",
        `the hub sent the download on to ${next.protocol}, which Kvasir does not follow`,
      );
    at = next;
  }
  throw new LocalRefused(502, "hub", "the hub sent the download on more than five times");
}

/** The words for a hub that refused a repository: a gated or private model needs a token. */
function refusedWords(repo: string, token: string | null): LocalRefused {
  return new LocalRefused(
    422,
    "needs_token",
    token
      ? `the Hugging Face Hub refused the token for ${repo}: the token's account needs access to it, and a gated model needs its terms accepted on the hub`
      : `the Hugging Face Hub refused ${repo}: a gated or private model needs a Hugging Face token, which an admin sets for Kvasir`,
  );
}

/** The files a download of a revision would bring, as the hub lists them now, and nothing kept. */
export async function lookupOnHub(
  endpoint: string,
  token: string | null,
  input: LookupInput,
): Promise<Lookup> {
  const { repo, owner, name } = repoOf(input.repo);
  const revision = revisionOf(input.revision);
  const include = includeOf(input.include);
  const url = `${endpoint}/api/models/${owner}/${name}/revision/${encodeURIComponent(revision)}?blobs=true`;
  let r: Response;
  try {
    r = await hubGet(endpoint, url, token, { accept: "application/json" }, AbortSignal.timeout(30_000));
  } catch (e) {
    if (e instanceof LocalRefused) throw e;
    throw new LocalRefused(502, "hub", `the Hugging Face Hub could not be reached: ${messageOf(e)}`);
  }
  if (r.status === 401 || r.status === 403) {
    await r.body?.cancel();
    throw refusedWords(repo, token);
  }
  if (r.status === 404) {
    await r.body?.cancel();
    throw new LocalRefused(422, "not_on_hub", `the Hugging Face Hub has no model ${repo} at ${revision}`);
  }
  if (!r.ok) {
    await r.body?.cancel();
    throw new LocalRefused(502, "hub", `the Hugging Face Hub answered ${r.status} for ${repo}`);
  }
  let body: { sha?: unknown; siblings?: unknown };
  try {
    body = (await r.json()) as typeof body;
  } catch {
    throw new LocalRefused(502, "hub", `the Hugging Face Hub's answer for ${repo} is not JSON`);
  }
  const commit = typeof body.sha === "string" ? body.sha : "";
  if (!/^[0-9a-f]{40}$/u.test(commit) || (/^[0-9a-f]{40}$/u.test(revision) && commit !== revision))
    throw new LocalRefused(
      502,
      "hub",
      `the Hugging Face Hub did not name the commit of ${repo} at ${revision}`,
    );
  if (!Array.isArray(body.siblings))
    throw new LocalRefused(502, "hub", `the Hugging Face Hub did not list the files of ${repo}`);
  const patterns = include.map(globOf);
  const files: HubFile[] = [];
  for (const raw of body.siblings) {
    const s = (raw ?? {}) as { rfilename?: unknown; size?: unknown; lfs?: { sha256?: unknown } | null };
    const path = typeof s.rfilename === "string" ? s.rfilename : "";
    if (patterns.length > 0 && !patterns.some((p) => p.test(path))) continue;
    // a path that could leave the model's folder is refused before anything is written
    if (!safePath(path))
      throw new LocalRefused(
        502,
        "hub",
        `the Hugging Face Hub lists a file Kvasir will not write, ${JSON.stringify(path)}: a path is never absolute, never holds .. and never a backslash`,
      );
    if (typeof s.size !== "number" || !Number.isSafeInteger(s.size) || s.size < 0)
      throw new LocalRefused(502, "hub", `the Hugging Face Hub did not say the size of ${path}`);
    const sha256 = s.lfs && typeof s.lfs === "object" ? s.lfs.sha256 : undefined;
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)))
      throw new LocalRefused(502, "hub", `the Hugging Face Hub's sha256 of ${path} is not one`);
    files.push({ path, size: s.size, sha256: typeof sha256 === "string" ? sha256 : null });
  }
  return {
    repo,
    revision,
    commit,
    include,
    files,
    bytes_total: files.reduce((sum, f) => sum + f.size, 0),
  };
}

/** A path as a shell reads it: left bare when it holds only the plainest characters, and quoted otherwise. */
function shellWord(path: string): string {
  return /^[A-Za-z0-9._/+:@%=-]+$/u.test(path) ? path : `'${path.replace(/'/gu, `'\\''`)}'`;
}

/**
 * The commands a model server runs a download with, as words only. A GGUF
 * file is llama.cpp's and Ollama's, the first part of a split file standing
 * for all its parts and a vision projector left out; a folder with a
 * config.json and safetensors weights is SGLang's and vLLM's.
 */
export function serveCommands(dir: string, files: string[]): Serve[] {
  const out: Serve[] = [];
  for (const f of files) {
    if (!/\.gguf$/iu.test(f)) continue;
    const base = f.split("/").at(-1) ?? f;
    const part = /-(\d{5})-of-\d{5}\.gguf$/iu.exec(base);
    if (/^mmproj/iu.test(base) || (part && Number(part[1]) !== 1)) continue;
    const file = join(dir, f);
    out.push({ runtime: "llama.cpp", command: `llama-server -m ${shellWord(file)} --port 8080` });
    out.push({ runtime: "ollama", command: `FROM ${/[\s"]/u.test(file) ? JSON.stringify(file) : file}` });
  }
  if (files.includes("config.json") && files.some((f) => /\.safetensors$/iu.test(f))) {
    out.push({
      runtime: "sglang",
      command: `python -m sglang.launch_server --model-path ${shellWord(dir)} --port 30000`,
    });
    out.push({ runtime: "vllm", command: `vllm serve ${shellWord(dir)} --port 8000` });
  }
  return out;
}

/** A location an admin names: absolute, created where missing, and written to once; or a refusal in words. */
export function usable(input: unknown): string {
  const bad = (message: string) => new LocalRefused(400, "bad_location", message);
  if (typeof input !== "string" || input === "") throw bad("path: the folder local models download into");
  if (!isAbsolute(input))
    throw bad(`${input} is not an absolute path: a location starts at the root of the file system`);
  const at = resolve(input);
  if (existsSync(at) && !statSync(at).isDirectory()) throw bad(`${at} is a file, not a folder`);
  try {
    mkdirSync(at, { recursive: true });
  } catch (e) {
    throw bad(`${at} could not be created: ${messageOf(e)}`);
  }
  const probe = join(at, `.kvasir-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (e) {
    throw bad(`${at} is not writable by Kvasir: ${messageOf(e)}`);
  }
  return at;
}

function onDisk(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** The bytes a download still needs: none for a finished file, and what its part lacks for a file begun. */
export function stillToDownload(dir: string, files: HubFile[]): number {
  let still = 0;
  for (const f of files) {
    const target = join(dir, f.path);
    if (onDisk(target) === f.size) continue;
    const part = onDisk(`${target}.part`) ?? 0;
    still += part <= f.size ? f.size - part : f.size;
  }
  return still;
}

export interface LocalOptions {
  /** The free space of a file system, as `fs.statfsSync` answers it; the tests give their own. */
  statfs?: (path: string) => { bavail: number | bigint; bsize: number | bigint };
  /** How often a Kvasir serving the database looks for a download to take. */
  pollMs?: number;
  /** How long the lease holds unless it is renewed. */
  leaseMs?: number;
}

interface Stored {
  id: number;
  repo: string;
  revision: string;
  commit_sha: string;
  include: string;
  path: string;
  files: string;
  state: LocalState;
  bytes_total: number;
  bytes_done: number;
  error: string | null;
  added_by: string;
  added_at: number;
  finished_at: number | null;
}

/** Why a download stopped before it finished: paused, removed, Kvasir closing, or its lease gone to another Kvasir. */
type Stop = "paused" | "removed" | "closing" | "lost";

/** How a command line's download went: taken from the queue elsewhere, waiting behind another Kvasir's download, or downloaded here. */
export type Followed = "taken" | "waiting" | "here";

/** A model's folder with everything in it, and its repository's folder once empty: only a folder laid out as Kvasir lays one out. */
function deleteModel(s: Pick<Stored, "path" | "repo" | "commit_sha">): void {
  if (
    !isAbsolute(s.path) ||
    basename(s.path) !== s.commit_sha ||
    basename(dirname(s.path)) !== s.repo.replace("/", "--")
  )
    return;
  rmSync(s.path, { recursive: true, force: true });
  try {
    rmdirSync(dirname(s.path));
  } catch {
    // another commit of the same repository is still there
  }
}

export class Local {
  /** What happens to a download, a line each: the server's log, or the command line's. */
  say: (line: string) => void = () => {};
  /** This process, as the lease names it. */
  readonly holder = `${process.pid}-${randomBytes(4).toString("hex")}`;
  private readonly statfs: NonNullable<LocalOptions["statfs"]>;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<boolean> | null = null;
  private current: { id: number; control: AbortController; done: Promise<void> } | null = null;
  private closing = false;

  constructor(
    private readonly store: Store,
    private readonly credentials: Credentials,
    /** The hub's address: huggingface.co, or the mirror kvasir.json names. */
    private readonly endpoint: string,
    /** Where new downloads go until an admin sets a location. */
    private readonly defaultLocation: string,
    opts: LocalOptions = {},
  ) {
    for (const s of LOCAL_SCHEMA) store.db.exec(s);
    this.statfs = opts.statfs ?? ((path) => statfsSync(path));
    this.pollMs = opts.pollMs ?? 2_000;
    this.leaseMs = opts.leaseMs ?? 30_000;
  }

  /** Where new downloads go: the location an admin set, or `models` beside the database. */
  location(): string {
    const r = this.store.db.prepare("SELECT value FROM setting WHERE key = ?").get(LOCATION) as
      | { value: string }
      | undefined;
    return r?.value ?? this.defaultLocation;
  }

  /** A new location for new downloads; a model downloaded before stays where it is, and is listed with its own path. */
  setLocation(input: unknown, by: string): string {
    const at = usable(input);
    this.store.db
      .prepare(
        `INSERT INTO setting (key, value, set_by, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(LOCATION, at, by, Date.now());
    return at;
  }

  /** The bytes free on the file system a path is on, or will be on once created; null where that cannot be read. */
  freeBytes(path: string): number | null {
    let at = path;
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    try {
      const s = this.statfs(at);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  /** Whether a Hugging Face token is set; the token itself is never returned. */
  hasToken(): boolean {
    return this.credentials.has(HUGGING_FACE);
  }

  /** The token for gated and private models, sealed with the other credentials. */
  setToken(input: unknown): void {
    const token = typeof input === "string" ? input.trim() : "";
    if (token.length < 8 || token.length > 512 || /\s/u.test(token))
      throw new LocalRefused(400, "bad_request", "token: a Hugging Face access token");
    this.credentials.put(HUGGING_FACE, token);
  }

  clearToken(): boolean {
    return this.credentials.delete(HUGGING_FACE);
  }

  /** The files a download would bring, with their sizes and the total; nothing is kept. */
  lookup(input: LookupInput): Promise<Lookup> {
    return lookupOnHub(this.endpoint, this.credentials.open(HUGGING_FACE), input);
  }

  private stored(id: number): Stored | undefined {
    return this.store.db.prepare("SELECT * FROM local_model WHERE id = ?").get(id) as unknown as
      | Stored
      | undefined;
  }

  private need(id: number): Stored {
    const s = this.stored(id);
    if (!s) throw new LocalRefused(404, "no_such_model", `no local model ${id}`);
    return s;
  }

  private rowOf(s: Stored): LocalRow {
    const files = JSON.parse(s.files) as HubFile[];
    return {
      id: s.id,
      repo: s.repo,
      revision: s.revision,
      commit: s.commit_sha,
      path: s.path,
      state: s.state,
      files: files.length,
      bytes_total: s.bytes_total,
      bytes_done: s.bytes_done,
      error: s.error,
      added_by: s.added_by,
      added_at: s.added_at,
      finished_at: s.finished_at,
      // the commands are shown once every file of the model is there
      serve:
        s.state === "done"
          ? serveCommands(
              s.path,
              files.map((f) => f.path),
            )
          : [],
    };
  }

  get(id: number): LocalRow | null {
    const s = this.stored(id);
    return s ? this.rowOf(s) : null;
  }

  list(): LocalRow[] {
    return (this.store.db.prepare("SELECT * FROM local_model ORDER BY id").all() as unknown as Stored[]).map(
      (s) => this.rowOf(s),
    );
  }

  /** What the Kvasir page shows: where new downloads go and the room there, whether a token is set, and every model. */
  status(): { location: string; free_bytes: number | null; token: boolean; models: LocalRow[] } {
    const location = this.location();
    return { location, free_bytes: this.freeBytes(location), token: this.hasToken(), models: this.list() };
  }

  /** Refused where the free space is less than what is still to download and a gibibyte to spare. */
  private roomFor(dir: string, files: HubFile[]): void {
    const still = stillToDownload(dir, files);
    const free = this.freeBytes(dir);
    const needed = still + SPARE_BYTES;
    if (free !== null && free < needed)
      throw new LocalRefused(
        507,
        "no_space",
        `${dirname(dirname(dir))} has ${readable(free)} free, and this download needs ${readable(needed)}: ${readable(still)} still to download and 1 GiB to spare`,
        { free_bytes: free, needed_bytes: needed },
      );
  }

  /** A model looked up and queued; refused where it is held already, or where the location lacks the room for it. */
  async add(input: LookupInput, by: string): Promise<LocalRow> {
    const found = await this.lookup(input);
    if (found.files.length === 0)
      throw new LocalRefused(
        422,
        "nothing_to_download",
        found.include.length > 0
          ? `no file of ${found.repo} at ${found.revision} matches ${found.include.join(", ")}`
          : `the Hugging Face Hub lists no file in ${found.repo} at ${found.revision}`,
      );
    const location = usable(this.location());
    const path = join(location, found.repo.replace("/", "--"), found.commit);
    const conflict = (id: number | string) =>
      new LocalRefused(
        409,
        "conflict",
        `model ${id} holds ${found.repo} at ${found.commit.slice(0, 12)} in ${location} already: resume it, or remove it first`,
      );
    const held = this.store.db.prepare("SELECT id FROM local_model WHERE path = ?").get(path) as
      | { id: number }
      | undefined;
    if (held) throw conflict(held.id);
    this.roomFor(path, found.files);
    let id: number;
    try {
      id = (
        this.store.db
          .prepare(
            `INSERT INTO local_model (repo, revision, commit_sha, include, path, files, state, bytes_total, bytes_done, added_by, added_at)
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?) RETURNING id`,
          )
          .get(
            found.repo,
            found.revision,
            found.commit,
            JSON.stringify(found.include),
            path,
            JSON.stringify(found.files),
            found.bytes_total,
            by,
            Date.now(),
          ) as { id: number }
      ).id;
    } catch (e) {
      // another Kvasir on the database added the same model a moment before
      if (/UNIQUE/u.test(messageOf(e))) throw conflict("another");
      throw e;
    }
    this.kick();
    return this.get(id) as LocalRow;
  }

  /** A download paused with what it has; a pause from another Kvasir on the database is seen within a second. */
  pause(id: number): LocalRow {
    const s = this.need(id);
    if (s.state === "done" || s.state === "failed")
      throw new LocalRefused(
        409,
        "conflict",
        `model ${id} is ${s.state === "done" ? "downloaded" : "failed"}, and has no download to pause`,
      );
    this.store.db
      .prepare("UPDATE local_model SET state = 'paused' WHERE id = ? AND state IN ('queued', 'downloading')")
      .run(id);
    if (this.current?.id === id) this.current.control.abort("paused");
    return this.get(id) as LocalRow;
  }

  /** A paused or failed download queued again, to carry on from what it has. */
  resume(id: number): LocalRow {
    const s = this.need(id);
    if (s.state === "done") throw new LocalRefused(409, "conflict", `model ${id} is downloaded already`);
    this.store.db
      .prepare(
        "UPDATE local_model SET state = 'queued', error = NULL WHERE id = ? AND state IN ('paused', 'failed')",
      )
      .run(id);
    this.kick();
    return this.get(id) as LocalRow;
  }

  /** A model gone: its row deleted, its download stopped, then its files and its folder deleted. */
  async remove(id: number): Promise<boolean> {
    const s = this.stored(id);
    if (!s) return false;
    this.store.db.prepare("DELETE FROM local_model WHERE id = ?").run(id);
    const running = this.current;
    if (running?.id === id) {
      running.control.abort("removed");
      await running.done;
    }
    deleteModel(s);
    return true;
  }

  /** Serving: the models left queued or downloading carried on, and the database looked at for more. The number waiting is returned. */
  start(): number {
    this.closing = false;
    this.timer ??= setInterval(() => this.kick(), this.pollMs);
    this.timer.unref();
    const waiting = this.waiting();
    this.kick();
    return waiting;
  }

  /** Kvasir closing: the running download stops with what it has and is queued again, and the lease is let go. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current?.control.abort("closing");
    await this.running;
  }

  /**
   * A command line's download: left to a Kvasir serving the database when one
   * takes it within `waitMs`; left waiting its turn where another Kvasir
   * downloads now; and otherwise downloaded here, `here` said first.
   */
  async follow(id: number, opts: { waitMs?: number; here?: () => void } = {}): Promise<Followed> {
    const until = Date.now() + (opts.waitMs ?? 5_000);
    for (;;) {
      const s = this.stored(id);
      if (s?.state !== "queued") return "taken";
      if (this.closing) return "waiting";
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.takeLease()) return "waiting";
    opts.here?.();
    this.running = this.drain(id);
    const held = await this.running;
    this.running = null;
    return held ? "here" : "waiting";
  }

  private waiting(): number {
    return Number(
      (
        this.store.db
          .prepare("SELECT COUNT(*) AS n FROM local_model WHERE state IN ('queued', 'downloading')")
          .get() as { n: number }
      ).n,
    );
  }

  /** The queue taken where a serving Kvasir has something to download and no other Kvasir downloads now. */
  private kick(): void {
    if (!this.timer || this.running || this.closing) return;
    try {
      if (this.waiting() === 0) return;
    } catch (e) {
      console.error("kvasir: the local models could not be read:", messageOf(e));
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  /** The Kvasir downloading now, where one holds the lease. */
  leaseHolder(): string | null {
    const held = this.store.db
      .prepare("SELECT holder FROM local_lease WHERE name = 'queue' AND lease_until > ?")
      .get(Date.now()) as { holder: string } | undefined;
    return held?.holder ?? null;
  }

  private takeLease(): boolean {
    const now = Date.now();
    const held = this.leaseHolder();
    if (held !== null && held !== this.holder) return false;
    const taken = this.store.db
      .prepare(
        `INSERT INTO local_lease (name, holder, lease_until) VALUES ('queue', ?, ?)
         ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until
         WHERE local_lease.holder = excluded.holder OR local_lease.lease_until <= ?`,
      )
      .run(this.holder, now + this.leaseMs, now);
    return Number(taken.changes) > 0;
  }

  private renewLease(): boolean {
    const renewed = this.store.db
      .prepare("UPDATE local_lease SET lease_until = ? WHERE name = 'queue' AND holder = ?")
      .run(Date.now() + this.leaseMs, this.holder);
    return Number(renewed.changes) > 0;
  }

  private releaseLease(): void {
    this.store.db.prepare("DELETE FROM local_lease WHERE name = 'queue' AND holder = ?").run(this.holder);
  }

  private next(only?: number): Stored | undefined {
    const db = this.store.db;
    return (only === undefined
      ? db
          .prepare(
            "SELECT * FROM local_model WHERE state IN ('queued', 'downloading') ORDER BY state = 'queued', id LIMIT 1",
          )
          .get()
      : db
          .prepare("SELECT * FROM local_model WHERE id = ? AND state IN ('queued', 'downloading')")
          .get(only)) as unknown as Stored | undefined;
  }

  /** One model at a time while this Kvasir holds the lease, or only the one a command line came for; false where another holds it. */
  private async drain(only?: number): Promise<boolean> {
    try {
      if (!this.takeLease()) return false;
    } catch (e) {
      console.error("kvasir: the local models could not be read:", messageOf(e));
      return false;
    }
    try {
      for (;;) {
        if (this.closing) break;
        const next = this.next(only);
        if (!next) break;
        await this.download(next);
        if (only !== undefined) break;
      }
    } catch (e) {
      console.error("kvasir: a local model download stopped:", messageOf(e));
    } finally {
      try {
        this.releaseLease();
      } catch {
        // a lease not let go runs out on its own
      }
    }
    return true;
  }

  /** One model downloaded file by file into its folder; what stopped it is written to its row. */
  private async download(s: Stored): Promise<void> {
    const db = this.store.db;
    const claimed = db
      .prepare(
        "UPDATE local_model SET state = 'downloading', error = NULL WHERE id = ? AND state IN ('queued', 'downloading')",
      )
      .run(s.id);
    if (Number(claimed.changes) === 0) return;
    const control = new AbortController();
    let settle = () => {};
    const done = new Promise<void>((r) => {
      settle = r;
    });
    this.current = { id: s.id, control, done };
    const files = JSON.parse(s.files) as HubFile[];
    let bytes = s.bytes_done;
    let written = s.bytes_done;
    let at = "";
    // once a second: the progress written, the lease renewed, and a pause or a removal made elsewhere seen
    const ticker = setInterval(() => {
      try {
        const now = db.prepare("SELECT state FROM local_model WHERE id = ?").get(s.id) as
          | { state: LocalState }
          | undefined;
        if (!now) control.abort("removed");
        else if (now.state !== "downloading") control.abort("paused");
        else if (!this.renewLease()) control.abort("lost");
        else if (bytes !== written) {
          db.prepare("UPDATE local_model SET bytes_done = ? WHERE id = ?").run(bytes, s.id);
          written = bytes;
        }
      } catch (e) {
        console.error("kvasir: a local model's progress could not be written:", messageOf(e));
      }
    }, 1_000);
    ticker.unref();
    this.say(`local model ${s.id}: downloading ${s.repo} at ${s.commit_sha.slice(0, 12)} into ${s.path}`);
    try {
      this.roomFor(s.path, files);
      bytes = s.bytes_total - stillToDownload(s.path, files);
      mkdirSync(s.path, { recursive: true });
      for (const file of files) {
        control.signal.throwIfAborted();
        at = file.path;
        await this.file(s, file, control.signal, (n) => {
          bytes += n;
        });
      }
      db.prepare(
        "UPDATE local_model SET state = 'done', bytes_done = bytes_total, error = NULL, finished_at = ? WHERE id = ? AND state = 'downloading'",
      ).run(Date.now(), s.id);
      this.say(`local model ${s.id}: done, ${readable(s.bytes_total)} in ${s.path}`);
    } catch (e) {
      const why = control.signal.aborted ? (control.signal.reason as Stop) : null;
      if (why === "closing") {
        // Kvasir closing pauses the download where it is; the next Kvasir to start on the database carries it on
        db.prepare(
          "UPDATE local_model SET state = 'queued', bytes_done = ? WHERE id = ? AND state = 'downloading'",
        ).run(bytes, s.id);
        this.say(
          `local model ${s.id}: stopped with ${readable(bytes)} as Kvasir closes, to carry on when it starts`,
        );
      } else if (why === "paused") {
        db.prepare("UPDATE local_model SET bytes_done = ? WHERE id = ?").run(bytes, s.id);
        this.say(`local model ${s.id}: paused with ${readable(bytes)}`);
      } else if (why === "removed") {
        // removed, here or by another Kvasir that deleted the files already: whatever this one wrote since goes too
        deleteModel(s);
        this.say(`local model ${s.id}: removed`);
      } else if (why === "lost") {
        this.say(`local model ${s.id}: another Kvasir on the database took the download over`);
      } else {
        const error =
          e instanceof LocalRefused ? e.message : `the download of ${at || s.repo} stopped: ${messageOf(e)}`;
        db.prepare(
          "UPDATE local_model SET state = 'failed', error = ?, bytes_done = ? WHERE id = ? AND state = 'downloading'",
        ).run(error, bytes, s.id);
        this.say(`local model ${s.id}: failed: ${error}`);
      }
    } finally {
      clearInterval(ticker);
      this.current = null;
      settle();
    }
  }

  /** One file into its part, resumed from what the part holds, checked, and renamed once whole. */
  private async file(s: Stored, file: HubFile, signal: AbortSignal, add: (n: number) => void): Promise<void> {
    const target = resolve(s.path, file.path);
    if (!safePath(file.path) || !target.startsWith(`${s.path}${sep}`))
      throw new LocalRefused(502, "hub", `${file.path} would leave the model's folder`);
    if (onDisk(target) === file.size) return;
    const part = `${target}.part`;
    mkdirSync(dirname(target), { recursive: true });
    let have = onDisk(part) ?? 0;
    if (have > file.size) {
      rmSync(part, { force: true });
      have = 0;
    }
    let hash = file.sha256 ? createHash("sha256") : null;
    // a file resumed is hashed first from what its part already holds
    if (hash && have > 0) {
      for await (const chunk of createReadStream(part, { end: have - 1, signal }))
        hash.update(chunk as Buffer);
    }
    if (have < file.size) {
      const url = `${this.endpoint}/${s.repo}/resolve/${s.commit_sha}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
      const token = this.credentials.open(HUGGING_FACE);
      // the bytes as they are, never compressed on the way, so a range counts the file's own bytes
      const plain = { "accept-encoding": "identity" };
      let r = await hubGet(
        this.endpoint,
        url,
        token,
        have > 0 ? { ...plain, range: `bytes=${have}-` } : plain,
        signal,
      );
      if (r.status === 416 && have > 0) {
        // the hub will not send the rest of this part, so the file starts over
        await r.body?.cancel();
        rmSync(part, { force: true });
        add(-have);
        have = 0;
        hash = file.sha256 ? createHash("sha256") : null;
        r = await hubGet(this.endpoint, url, token, plain, signal);
      }
      if (r.status === 401 || r.status === 403) {
        await r.body?.cancel();
        throw refusedWords(s.repo, token);
      }
      if (!r.ok || !r.body) {
        await r.body?.cancel();
        throw new LocalRefused(502, "hub", `the Hugging Face Hub answered ${r.status} for ${file.path}`);
      }
      const start =
        r.status === 206
          ? Number(/^bytes (\d+)-/u.exec(r.headers.get("content-range") ?? "")?.[1] ?? Number.NaN)
          : 0;
      if (start !== have) {
        if (start !== 0) {
          await r.body.cancel();
          throw new LocalRefused(
            502,
            "hub",
            `the Hugging Face Hub sent ${file.path} from byte ${start}, where its part ends at byte ${have}`,
          );
        }
        // the hub sent the whole file rather than the rest of it, so the part starts over
        add(-have);
        have = 0;
        hash = file.sha256 ? createHash("sha256") : null;
      }
      let got = have;
      const counted = hash;
      await pipeline(
        Readable.fromWeb(r.body as unknown as WebStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _encoding, next) {
            if (got + chunk.length > file.size) {
              next(
                new LocalRefused(
                  502,
                  "hub",
                  `the Hugging Face Hub sent more of ${file.path} than the ${file.size} bytes it lists`,
                ),
              );
              return;
            }
            counted?.update(chunk);
            got += chunk.length;
            add(chunk.length);
            next(null, chunk);
          },
        }),
        createWriteStream(part, { flags: have > 0 ? "a" : "w" }),
        { signal },
      );
      if (got !== file.size)
        throw new LocalRefused(
          502,
          "hub",
          `the Hugging Face Hub sent ${got} bytes of ${file.path}, which it lists at ${file.size}`,
        );
    } else if (onDisk(part) === null) writeFileSync(part, "");
    if (hash) {
      const digest = hash.digest("hex");
      if (digest !== file.sha256) {
        rmSync(part, { force: true });
        throw new LocalRefused(
          502,
          "hub",
          `${file.path} does not match the sha256 the hub lists, ${file.sha256}: the download's is ${digest}, and its part is deleted`,
        );
      }
    }
    renameSync(part, target);
  }
}
