// SPDX-License-Identifier: AGPL-3.0-only
// The seal key and the keys it seals (§8.4): the key made once, private and
// kept; a key sealed under it opens only under it.

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Credentials, openSeal } from "../src/credentials.js";
import { Store } from "../src/store.js";

describe("the seal key", () => {
  it("is made once, readable by this account only, and kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "kvasir-seal-"));
    const path = join(dir, "kvasir.seal");
    const key = openSeal(path);
    expect(key.length).toBe(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Buffer.from(openSeal(path)).equals(Buffer.from(key))).toBe(true);
  });

  it("opens what it sealed, and nothing sealed under another key", () => {
    const dir = mkdtempSync(join(tmpdir(), "kvasir-seal-"));
    const store = new Store(join(dir, "kvasir.sqlite"));
    const credentials = new Credentials(store, openSeal(join(dir, "kvasir.seal")));
    credentials.put("card", "the-runtime-key");
    expect(credentials.open("card")).toBe("the-runtime-key");
    expect(credentials.has("card")).toBe(true);
    expect(() => new Credentials(store, openSeal(join(dir, "other.seal"))).open("card")).toThrow();
    credentials.put("card", "a-new-key");
    expect(credentials.open("card")).toBe("a-new-key");
    expect(credentials.delete("card")).toBe(true);
    expect(credentials.open("card")).toBeNull();
    store.close();
  });
});
