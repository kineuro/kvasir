// SPDX-License-Identifier: AGPL-3.0-only
// The layout Kvasir reads from a GGUF header before a runtime loads the model
// (record 24): the context the model declares and the shape of its attention,
// found among keys of every type in any order, past a tokenizer's many strings,
// and unknown, never an error, for a file it cannot read as one.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ggufLayout, kvBytesPerToken } from "../src/gguf.js";
import { G, ggufBytes, type Pair, qwenLike } from "./gguf-file.js";

const dir = mkdtempSync(join(tmpdir(), "kvasir-gguf-"));
let written = 0;
const file = (bytes: Buffer): string => {
  written += 1;
  const path = join(dir, `model-${written}.gguf`);
  writeFileSync(path, bytes);
  return path;
};

// a tokenizer's worth of strings and token types: more than one window of the reader
const tokenizer: Pair[] = [
  ["tokenizer.ggml.model", G.STRING, "gpt2"],
  [
    "tokenizer.ggml.tokens",
    G.ARRAY,
    Array.from({ length: 80_000 }, (_, i) => `token-${i}-${"x".repeat(i % 17)}`),
    G.STRING,
  ],
  ["tokenizer.ggml.token_type", G.ARRAY, Array.from({ length: 80_000 }, (_, i) => i % 3), G.INT32],
  ["tokenizer.chat_template", G.STRING, "{% for m in messages %}{{ m.content }}{% endfor %}"],
];

const others: Pair[] = [
  ["general.file_type", G.UINT32, 15],
  ["qwen3.rope.freq_base", G.FLOAT32, 1_000_000],
  ["general.sampling.temp", G.FLOAT64, 0.7],
  ["tokenizer.ggml.add_bos_token", G.BOOL, 0],
  ["general.size", G.UINT64, 4_022_468_096],
  ["general.offset", G.INT64, -1],
  ["general.small", G.INT8, -3],
  ["general.short", G.UINT16, 7],
  ["general.signed_short", G.INT16, -7],
  ["general.nested", G.ARRAY, [[1, 2, 3], [4]], G.ARRAY],
];

describe("a GGUF file's layout", () => {
  it("is read from the metadata, past every other key, in whatever order the keys come", () => {
    // the architecture's keys come last, after the tokenizer
    const path = file(ggufBytes([...others, ...tokenizer, ...qwenLike(262_144)], { padding: 2 ** 16 }));
    const layout = ggufLayout(path);
    expect(layout).toEqual({
      architecture: "qwen3",
      contextLength: 262_144,
      blockCount: 36,
      kvHeads: 288,
      keyLength: 128,
      valueLength: 128,
    });
    // 288 heads of 128 for the key and 128 for the value, at 1.07 bytes a value
    expect(kvBytesPerToken(layout)).toBeCloseTo(78_888.96, 2);
  });

  it("adds up the key and value heads layer by layer, and takes a head's size from the embedding where the file gives none", () => {
    const hybrid = ggufLayout(
      file(
        ggufBytes([
          ["general.architecture", G.STRING, "hybrid"],
          ["hybrid.context_length", G.UINT64, 131_072],
          ["hybrid.block_count", G.UINT32, 4],
          ["hybrid.embedding_length", G.UINT32, 4_096],
          ["hybrid.attention.head_count", G.UINT32, 32],
          ["hybrid.attention.head_count_kv", G.ARRAY, [0, 8, 0, 8], G.INT32],
        ]),
      ),
    );
    expect(hybrid).toEqual({
      architecture: "hybrid",
      contextLength: 131_072,
      blockCount: 4,
      kvHeads: 16,
      keyLength: 128,
      valueLength: 128,
    });
    // a model that names no key and value heads keeps one for each query head, in every layer
    const plain = ggufLayout(
      file(
        ggufBytes([
          ["general.architecture", G.STRING, "plain"],
          ["plain.block_count", G.UINT32, 2],
          ["plain.embedding_length", G.UINT32, 1_024],
          ["plain.attention.head_count", G.UINT32, 16],
        ]),
      ),
    );
    expect(plain).toMatchObject({ contextLength: null, kvHeads: 32, keyLength: 64, valueLength: 64 });
    expect(kvBytesPerToken({ ...plain, kvHeads: null } as never)).toBeNull();
  });

  it("is unknown, never an error, where the file cannot be read as one", () => {
    const whole = ggufBytes([...tokenizer, ...qwenLike(32_768)]);
    expect(ggufLayout(join(dir, "nowhere.gguf"))).toBeNull();
    // zeros, as a download not yet written holds
    expect(ggufLayout(file(Buffer.alloc(4_096)))).toBeNull();
    expect(ggufLayout(file(ggufBytes(qwenLike(32_768), { magic: "GGML" })))).toBeNull();
    expect(ggufLayout(file(ggufBytes(qwenLike(32_768), { version: 1 })))).toBeNull();
    // cut inside the tokenizer
    expect(ggufLayout(file(whole.subarray(0, Math.floor(whole.length / 2))))).toBeNull();
    // no architecture named
    expect(ggufLayout(file(ggufBytes(qwenLike(32_768).slice(1))))).toBeNull();
    // a first key that claims more bytes than any file holds
    const lying = Buffer.from(whole);
    lying.writeBigUInt64LE(BigInt(2 ** 40), 24);
    expect(ggufLayout(file(lying))).toBeNull();
    expect(kvBytesPerToken(null)).toBeNull();
  });
});
