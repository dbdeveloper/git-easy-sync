// Owner, 2026-10-11: Obsidian's arrayBufferToBase64 builds an array with one
// string PER BYTE, then joins it. Measured on the owner's Pixel 6 Pro:
// 100 MB → 1.7 s and a 100-million-element array; above 128 MiB V8 refuses
// the array ("RangeError: Invalid array length") — the 204 MB video crash.
// encodeBase64: the native Uint8Array.prototype.toBase64 where the engine
// has it (100 MB in 0.06 s on that phone), else btoa over 48 KB chunks
// (0.7 s, no ceiling). Both must equal the reference encoding byte for byte.

import { describe, expect, it, afterEach } from "vitest";
import { encodeBase64, encodeBase64Chunked, BASE64_CHUNK_BYTES } from "../src/utils";

const ref = (u: Uint8Array): string => Buffer.from(u).toString("base64");

function bytes(n: number, seed = 7): Uint8Array {
  const u = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    u[i] = x >>> 24;
  }
  return u;
}

const C = 3 * 16384;
const LENGTHS = [0, 1, 2, 3, 4, 5, C - 1, C, C + 1, C + 2, 3 * C + 2, 1024 * 1024 + 1];

describe("encodeBase64Chunked (the fallback)", () => {
  it("chunks are a multiple of 3 bytes — no padding inside the joined string", () => {
    expect(BASE64_CHUNK_BYTES % 3).toBe(0);
  });

  it.each(LENGTHS)("length %i equals the reference", (n) => {
    const u = bytes(n);
    expect(encodeBase64Chunked(u.buffer as ArrayBuffer)).toBe(ref(u));
  });

  it("a view into a larger buffer encodes only its own bytes", () => {
    const big = bytes(100);
    const view = big.subarray(10, 20);
    expect(encodeBase64Chunked(view)).toBe(ref(view));
  });
});

describe("encodeBase64 (native when present, else chunked)", () => {
  const proto = Uint8Array.prototype as unknown as { toBase64?: () => string };
  const had = Object.prototype.hasOwnProperty.call(proto, "toBase64");
  const original = proto.toBase64;
  afterEach(() => {
    if (had) proto.toBase64 = original;
    else delete proto.toBase64;
  });

  it("uses the engine's toBase64 when it exists", () => {
    let called = 0;
    proto.toBase64 = function (this: Uint8Array) {
      called++;
      return ref(this);
    };
    const u = bytes(1000);
    expect(encodeBase64(u.buffer as ArrayBuffer)).toBe(ref(u));
    expect(called).toBe(1);
  });

  it.each(LENGTHS)("without it, falls back to chunks — length %i equals the reference", (n) => {
    delete proto.toBase64;
    const u = bytes(n, 11);
    expect(encodeBase64(u.buffer as ArrayBuffer)).toBe(ref(u));
  });
});

// The output is identical, so no behaviour test can tell the two encoders
// apart — this one keeps Obsidian's per-byte encoder from creeping back into
// the plugin.
describe("no source file uses Obsidian's arrayBufferToBase64", () => {
  it("src/ never imports or calls it", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : [],
      );
    const offenders = walk(path.join(__dirname, "..", "src")).filter((f) =>
      fs.readFileSync(f, "utf8").split("\n").some((l) => !l.trim().startsWith("//") && /\barrayBufferToBase64\s*[(,}]/.test(l)),
    );
    expect(offenders).toEqual([]);
  });
});
