// SPDX-License-Identifier: AGPL-3.0-only
// A GGUF header written the way llama.cpp's writer lays one out, for the tests:
// the magic, the version, the counts, then each key with its type and value.

/** GGUF's value types. */
export const G = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

/** One key of the metadata: its type, its value, and for an array the type of its items. */
export type Pair = [key: string, type: number, value: unknown, inner?: number];

function fixed(width: number, write: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(width);
  write(b);
  return b;
}

function encode(type: number, value: unknown, inner?: number): Buffer {
  switch (type) {
    case G.STRING: {
      const bytes = Buffer.from(String(value), "utf8");
      return Buffer.concat([fixed(8, (b) => b.writeBigUInt64LE(BigInt(bytes.length))), bytes]);
    }
    case G.ARRAY: {
      const items = value as unknown[];
      const of = inner ?? G.UINT8;
      const head = fixed(12, (b) => {
        b.writeUInt32LE(of, 0);
        b.writeBigUInt64LE(BigInt(items.length), 4);
      });
      return Buffer.concat([head, ...items.map((item) => encode(of, item))]);
    }
    case G.UINT8:
    case G.BOOL:
      return fixed(1, (b) => b.writeUInt8(Number(value)));
    case G.INT8:
      return fixed(1, (b) => b.writeInt8(Number(value)));
    case G.UINT16:
      return fixed(2, (b) => b.writeUInt16LE(Number(value)));
    case G.INT16:
      return fixed(2, (b) => b.writeInt16LE(Number(value)));
    case G.UINT32:
      return fixed(4, (b) => b.writeUInt32LE(Number(value)));
    case G.INT32:
      return fixed(4, (b) => b.writeInt32LE(Number(value)));
    case G.FLOAT32:
      return fixed(4, (b) => b.writeFloatLE(Number(value)));
    case G.UINT64:
      return fixed(8, (b) => b.writeBigUInt64LE(BigInt(value as number)));
    case G.INT64:
      return fixed(8, (b) => b.writeBigInt64LE(BigInt(value as number)));
    default:
      return fixed(8, (b) => b.writeDoubleLE(Number(value)));
  }
}

/** A GGUF file's bytes: the header with the metadata's keys in the order given, then `padding` bytes standing for the tensors. */
export function ggufBytes(
  pairs: Pair[],
  opts: { version?: number; magic?: string; padding?: number } = {},
): Buffer {
  const head = Buffer.alloc(24);
  head.write(opts.magic ?? "GGUF", 0, "latin1");
  head.writeUInt32LE(opts.version ?? 3, 4);
  head.writeBigUInt64LE(BigInt(0), 8);
  head.writeBigUInt64LE(BigInt(pairs.length), 16);
  const body = pairs.map(([key, type, value, inner]) =>
    Buffer.concat([encode(G.STRING, key), encode(G.UINT32, type), encode(type, value, inner)]),
  );
  return Buffer.concat([head, ...body, Buffer.alloc(opts.padding ?? 0, 0xff)]);
}

/** The metadata of a model shaped as Qwen3 4B: 36 layers, 8 key and value heads of 128 each, and the context given. */
export function qwenLike(context: number): Pair[] {
  return [
    ["general.architecture", G.STRING, "qwen3"],
    ["general.name", G.STRING, "Qwen3 4B Instruct"],
    ["qwen3.context_length", G.UINT32, context],
    ["qwen3.block_count", G.UINT32, 36],
    ["qwen3.embedding_length", G.UINT32, 2560],
    ["qwen3.attention.head_count", G.UINT32, 32],
    ["qwen3.attention.head_count_kv", G.UINT32, 8],
    ["qwen3.attention.key_length", G.UINT32, 128],
    ["qwen3.attention.value_length", G.UINT32, 128],
  ];
}
