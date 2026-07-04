import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { TFile, Vault } from "../../mock-obsidian";
import { atomicWriteFile } from "../../src/sync2/atomic-write";

// Guards the modifyBinary size-gate (perf fix): the editor-friendly modifyBinary fast-path
// is used ONLY for files ≤ 256 KB. Larger files fall through to the rename strategy, because
// Obsidian's modifyBinary re-renders an open large MarkdownView synchronously and freezes for
// minutes (device: 1.1 MB history [←] = 112 s "File system operation timed out"). The mock
// Vault has no modifyBinary, so we inject one (a spy that writes via the adapter) + a
// getAbstractFileByPath that reports existing files as TFiles — reproducing the production
// condition the gate branches on. Either path must leave the target byte-correct.

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("atomicWriteFile — modifyBinary size-gate (perf)", () => {
  let root: string;
  let vault: Vault;
  let modifySpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = path.join(os.tmpdir(), `awsg-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(root, { recursive: true });
    vault = new Vault(root);
    // Inject the two Obsidian APIs the fast-path branches on. modifyBinary writes through
    // the adapter (so the file ends up correct when the fast path IS taken).
    modifySpy = vi.fn(async (f: { path: string }, bytes: ArrayBuffer) => {
      await vault.adapter.writeBinary(f.path, bytes);
    });
    const v = vault as unknown as {
      getAbstractFileByPath: (p: string) => unknown;
      modifyBinary: (f: unknown, b: ArrayBuffer) => Promise<void>;
    };
    v.getAbstractFileByPath = (p: string) => {
      if (!fs.existsSync(path.join(root, p))) return null;
      return new TFile(p);
    };
    v.modifyBinary = modifySpy as unknown as (f: unknown, b: ArrayBuffer) => Promise<void>;
  });
  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function read(p: string): Promise<string> {
    return new TextDecoder().decode(await vault.adapter.readBinary(p));
  }

  it("SMALL existing file (< 256 KB) → uses modifyBinary fast-path", async () => {
    const p = "note.md";
    await vault.adapter.writeBinary(p, enc("old"));
    const small = "x".repeat(1000);

    await atomicWriteFile(vault as unknown as import("obsidian").Vault, p, enc(small));

    expect(modifySpy).toHaveBeenCalledTimes(1);
    expect(await read(p)).toBe(small);
  });

  it("LARGE existing file (> 256 KB) → SKIPS modifyBinary, uses rename strategy", async () => {
    const p = "big.md";
    await vault.adapter.writeBinary(p, enc("old"));
    const large = "y".repeat(300_000); // > 262_144

    await atomicWriteFile(vault as unknown as import("obsidian").Vault, p, enc(large));

    expect(modifySpy).not.toHaveBeenCalled(); // the freeze-prone path was avoided
    expect(await read(p)).toBe(large); // …and the write still landed, byte-correct
  });

  it("LARGE NEW file (no TFile) → rename strategy (modifyBinary never eligible)", async () => {
    const p = "fresh-big.md";
    const large = "z".repeat(300_000);

    await atomicWriteFile(vault as unknown as import("obsidian").Vault, p, enc(large));

    expect(modifySpy).not.toHaveBeenCalled();
    expect(await read(p)).toBe(large);
  });
});
