// SPDX-License-Identifier: AGPL-3.0-only
// The seal key (§8.4) was committed with the source until 1.0.0-alpha.1. A
// key file holding it gets a new key and every stored secret is sealed again;
// a key file an update removed is made anew with the secrets carried over; a
// start stopped halfway through the move finishes it; a private key is kept.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Credentials, openSeal } from "../src/credentials.js";
import { Personal } from "../src/personal.js";
import { Store } from "../src/store.js";

const PUBLISHED = Buffer.from("81e62eb8ff3699ffae4b175556b75f3f074d9d31dc4af2095d4411ae51d3d5df", "hex");

function place() {
  const dir = mkdtempSync(join(tmpdir(), "kvasir-seal-"));
  return { store: new Store(join(dir, "kvasir.sqlite")), path: join(dir, "kvasir.seal") };
}

/** Two secrets sealed under a key: the organisation's and one a person brought. */
function sealUnder(store: Store, key: Uint8Array) {
  new Credentials(store, key).put("minimax", "sk-organisation");
  new Personal(store, key, [], "http://kvasir.test").putKey("anna@lab", "openai", "sk-brought");
}

async function readable(store: Store, key: Uint8Array) {
  return {
    organisation: new Credentials(store, key).open("minimax"),
    brought: await new Personal(store, key, [], "http://kvasir.test").open("anna@lab", "openai"),
  };
}

const secrets = { organisation: "sk-organisation", brought: "sk-brought" };

describe("the seal key", () => {
  it("replaces the key published with the source and seals every stored secret again", async () => {
    const { store, path } = place();
    writeFileSync(path, PUBLISHED);
    sealUnder(store, PUBLISHED);
    const said: string[] = [];
    const key = openSeal(path, store, (line) => said.push(line));
    expect(Buffer.from(key).equals(PUBLISHED)).toBe(false);
    expect(readFileSync(path).equals(Buffer.from(key))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.new`)).toBe(false);
    expect(await readable(store, key)).toEqual(secrets);
    expect(() => new Credentials(store, PUBLISHED).open("minimax")).toThrow();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("2 stored secrets were sealed again");
    store.close();
  });

  it("makes a new key where an update removed the file, and carries the secrets over", async () => {
    const { store, path } = place();
    sealUnder(store, PUBLISHED);
    const key = openSeal(path, store);
    expect(existsSync(path)).toBe(true);
    expect(Buffer.from(key).equals(PUBLISHED)).toBe(false);
    expect(await readable(store, key)).toEqual(secrets);
    store.close();
  });

  it("finishes a move that a start stopped after the secrets moved", async () => {
    const { store, path } = place();
    const next = randomBytes(32);
    writeFileSync(path, PUBLISHED);
    writeFileSync(`${path}.new`, next);
    sealUnder(store, next);
    const key = openSeal(path, store);
    expect(Buffer.from(key).equals(next)).toBe(true);
    expect(readFileSync(path).equals(next)).toBe(true);
    expect(existsSync(`${path}.new`)).toBe(false);
    expect(await readable(store, key)).toEqual(secrets);
    store.close();
  });

  it("drops a new key whose move never happened, and makes the move again", async () => {
    const { store, path } = place();
    const abandoned = randomBytes(32);
    writeFileSync(path, PUBLISHED);
    writeFileSync(`${path}.new`, abandoned);
    sealUnder(store, PUBLISHED);
    const key = openSeal(path, store);
    expect(Buffer.from(key).equals(PUBLISHED)).toBe(false);
    expect(Buffer.from(key).equals(abandoned)).toBe(false);
    expect(await readable(store, key)).toEqual(secrets);
    store.close();
  });

  it("keeps a private key as it is and says nothing", async () => {
    const { store, path } = place();
    const own = randomBytes(32);
    writeFileSync(path, own);
    sealUnder(store, own);
    const said: string[] = [];
    const key = openSeal(path, store, (line) => said.push(line));
    expect(Buffer.from(key).equals(own)).toBe(true);
    expect(said).toEqual([]);
    expect(await readable(store, key)).toEqual(secrets);
    store.close();
  });
});
