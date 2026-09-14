// SPDX-License-Identifier: AGPL-3.0-only
// What a GGUF file says about its model before any runtime loads it (record 24):
// the context it declares and the shape of its attention, read from the header's
// metadata a window at a time, never from the tensors. Kvasir opens a started
// model with a context no larger than the model's own, and on a runtime that
// computes on the processor it reckons the memory a load needs before asking for
// it. A header it cannot read is unknown, never an error.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** What a model's metadata gives about its context and attention; a field it does not give is null. */
export interface GgufLayout {
  architecture: string;
  /** The context the model declares, in tokens. */
  contextLength: number | null;
  blockCount: number | null;
  /** The key and value heads of every layer added together: a per-layer list, as a hybrid model keeps, counts each layer's own. */
  kvHeads: number | null;
  keyLength: number | null;
  valueLength: number | null;
}

/** "GGUF" read as a little-endian number. */
const MAGIC = 0x46554747;
const WINDOW = 2 ** 20;
/** How far into a file its metadata may reach before the header counts as unreadable. */
const METADATA_LIMIT = 256 * 2 ** 20;
const STRING_LIMIT = 16 * 2 ** 20;
const DEPTH_LIMIT = 8;

const STRING = 8;
const ARRAY = 9;
/** The width of each fixed-size value type: uint8, int8, uint16, int16, uint32, int32, float32 and bool, then after string and array, uint64, int64 and float64. */
const WIDTH: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** The keys a layout is made of, after the name of the architecture. */
const WANTED = [
  "context_length",
  "block_count",
  "embedding_length",
  "attention.head_count",
  "attention.head_count_kv",
  "attention.key_length",
  "attention.value_length",
];

class Unreadable extends Error {}

/** A file read at positions, a window at a time, never past its size or the metadata's limit. */
class Cursor {
  private window = Buffer.alloc(0);
  private from = 0;
  private at = 0;

  constructor(
    private readonly fd: number,
    private readonly size: number,
  ) {}

  private within(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || this.at + n > this.size || this.at + n > METADATA_LIMIT)
      throw new Unreadable();
  }

  /** The offset in the window of the next `n` bytes, read in where the window does not hold them. */
  private take(n: number): number {
    this.within(n);
    if (this.at < this.from || this.at + n > this.from + this.window.length) {
      const length = Math.min(Math.max(n, WINDOW), this.size - this.at);
      const buffer = Buffer.alloc(length);
      const read = readSync(this.fd, buffer, 0, length, this.at);
      if (read < n) throw new Unreadable();
      this.window = buffer.subarray(0, read);
      this.from = this.at;
    }
    const offset = this.at - this.from;
    this.at += n;
    return offset;
  }

  skip(n: number): void {
    this.within(n);
    this.at += n;
  }

  // the window is taken before it is read from: `take` may read a new one in
  u32(): number {
    const offset = this.take(4);
    return this.window.readUInt32LE(offset);
  }

  u64(): number {
    const offset = this.take(8);
    const v = this.window.readBigUInt64LE(offset);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Unreadable();
    return Number(v);
  }

  string(): string {
    const n = this.u64();
    if (n > STRING_LIMIT) throw new Unreadable();
    const offset = this.take(n);
    return this.window.toString("utf8", offset, offset + n);
  }

  number(type: number): number {
    const offset = this.take(WIDTH[type]);
    const w = this.window;
    switch (type) {
      case 0:
      case 7:
        return w.readUInt8(offset);
      case 1:
        return w.readInt8(offset);
      case 2:
        return w.readUInt16LE(offset);
      case 3:
        return w.readInt16LE(offset);
      case 4:
        return w.readUInt32LE(offset);
      case 5:
        return w.readInt32LE(offset);
      case 6:
        return w.readFloatLE(offset);
      case 10:
        return Number(w.readBigUInt64LE(offset));
      case 11:
        return Number(w.readBigInt64LE(offset));
      default:
        return w.readDoubleLE(offset);
    }
  }
}

/** A value read past, or, for a key a layout is made of, kept: a number, a string, or a short list of numbers. */
function value(c: Cursor, type: number, keep: boolean, depth = 0): number | string | number[] | undefined {
  if (depth > DEPTH_LIMIT) throw new Unreadable();
  if (type === STRING) {
    if (keep) return c.string();
    const n = c.u64();
    if (n > STRING_LIMIT) throw new Unreadable();
    c.skip(n);
    return undefined;
  }
  if (type === ARRAY) {
    const inner = c.u32();
    const count = c.u64();
    if (count > METADATA_LIMIT) throw new Unreadable();
    if (inner === STRING || inner === ARRAY) {
      for (let i = 0; i < count; i += 1) value(c, inner, false, depth + 1);
      return undefined;
    }
    const width = WIDTH[inner];
    if (width === undefined) throw new Unreadable();
    if (keep && count <= 65_536) {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) out.push(c.number(inner));
      return out;
    }
    c.skip(count * width);
    return undefined;
  }
  const width = WIDTH[type];
  if (width === undefined) throw new Unreadable();
  if (keep) return c.number(type);
  c.skip(width);
  return undefined;
}

/** A layout from the metadata kept, by the architecture the file names; null where it names none. */
export function layoutOf(kept: Map<string, number | string | number[]>): GgufLayout | null {
  const architecture = kept.get("general.architecture");
  if (typeof architecture !== "string" || architecture === "") return null;
  const raw = (name: string) => kept.get(`${architecture}.${name}`);
  const whole = (v: unknown): number | null =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
  const perLayer = (name: string): number | number[] | null => {
    const v = raw(name);
    if (Array.isArray(v)) return v.length > 0 && v.every((n) => Number.isSafeInteger(n) && n >= 0) ? v : null;
    return whole(v);
  };
  const blockCount = whole(raw("block_count"));
  const heads = perLayer("attention.head_count");
  // a model that names no key and value heads keeps one for each query head
  const kv = perLayer("attention.head_count_kv") ?? heads;
  const kvHeads = Array.isArray(kv)
    ? kv.reduce((sum, n) => sum + n, 0)
    : kv !== null && blockCount !== null
      ? kv * blockCount
      : null;
  const headCount = Array.isArray(heads) ? Math.max(...heads) : heads;
  const embedding = whole(raw("embedding_length"));
  const perHead = embedding !== null && headCount ? Math.floor(embedding / headCount) : null;
  return {
    architecture,
    contextLength: whole(raw("context_length")),
    blockCount,
    kvHeads,
    keyLength: whole(raw("attention.key_length")) ?? perHead,
    valueLength: whole(raw("attention.value_length")) ?? perHead,
  };
}

/** The layout a GGUF file's metadata gives; null where the file is not one or its header cannot be read. A split model's first part holds it. */
export function ggufLayout(path: string): GgufLayout | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const c = new Cursor(fd, fstatSync(fd).size);
    if (c.u32() !== MAGIC) return null;
    const version = c.u32();
    if (version !== 2 && version !== 3) return null;
    c.u64(); // the tensors, which are never read
    const pairs = c.u64();
    if (pairs > 1_000_000) return null;
    const kept = new Map<string, number | string | number[]>();
    for (let i = 0; i < pairs; i += 1) {
      const key = c.string();
      const type = c.u32();
      const keep = key === "general.architecture" || WANTED.some((w) => key.endsWith(`.${w}`));
      const v = value(c, type, keep);
      if (v !== undefined) kept.set(key, v);
    }
    return layoutOf(kept);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The bytes an 8-bit KV cache keeps for each token of context: q8_0 stores 32 values in 34 bytes, hence 1.07 a value. Null where the layout does not say. */
export function kvBytesPerToken(layout: GgufLayout | null): number | null {
  if (!layout || layout.kvHeads === null || layout.keyLength === null || layout.valueLength === null)
    return null;
  return layout.kvHeads * (layout.keyLength + layout.valueLength) * 1.07;
}
