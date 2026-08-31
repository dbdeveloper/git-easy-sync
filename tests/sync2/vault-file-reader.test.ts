import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault, setMockPlatform } from "../../mock-obsidian";
import { makeVaultFileReader } from "../../src/sync2/vault-file-reader";
import {
  makeWorkerMergeBlobs,
  mergeBlobsWithMainThreadDiff3,
} from "../../src/sync2/diff3";
import { mergeText } from "../../src/sync2/three-way-merge";
import { calculateGitBlobSHA } from "../../src/utils";

// Phase 5.5 step 2b — the production VaultFileReader (drain's live
// vault surface) and the worker mirror of mergeBlobs. Paired over
// MOCK_PLATFORM so a Capacitor-only rename regression cannot slip
// through the write path (testing.md rule).

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
  "makeVaultFileReader ($platform)",
  ({ platform }) => {
    let dir: string;
    let vault: Vault;
    let captured: string[];
    let warnings: string[];

    const reader = (opts?: { explodingCapture?: boolean }) =>
      makeVaultFileReader({
        vault: vault as never,
        computeSha: calculateGitBlobSHA,
        trashHooks: {
          captureForDelete: async (p: string) => {
            if (opts?.explodingCapture) throw new Error("capture boom");
            captured.push(p);
          },
          confirmDeleted: async () => {},
          confirmResolved: async () => {},
          sweepOlderThan: async () => {},
        },
        logger: { warn: (m) => warnings.push(m) },
      });

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "vfr-test-"));
      vault = new Vault(dir);
      captured = [];
      warnings = [];
      setMockPlatform(platform);
    });

    afterEach(() => {
      setMockPlatform("desktop");
      rmSync(dir, { recursive: true, force: true });
    });

    it("stat: file → {size,mtime}; missing → null; a FOLDER → null (folders are not drain files)", async () => {
      await vault.adapter.write("note.md", "abc");
      await vault.adapter.mkdir("sub");
      const r = reader();
      const s = await r.stat("note.md");
      expect(s!.size).toBe(3);
      expect(s!.mtime).toBeGreaterThan(0);
      expect(await r.stat("gone.md")).toBeNull();
      expect(await r.stat("sub")).toBeNull();
    });

    it("read: bytes + injected sha; BINARY content survives byte-identical (readBinary, never the text path)", async () => {
      // Invalid UTF-8 — the text read path would corrupt this.
      const bytes = new Uint8Array([0xc0, 0xff, 0x00, 0x7f, 0xee]).buffer;
      await vault.adapter.writeBinary("bin.csv", bytes);
      const got = await reader().read("bin.csv");
      expect(got).not.toBeNull();
      expect(new Uint8Array(got!.blob)).toEqual(new Uint8Array(bytes));
      expect(got!.size).toBe(5);
      expect(got!.sha).toBe(await calculateGitBlobSHA(bytes));
      expect(await reader().read("gone.md")).toBeNull();
    });

    it("write: parent folders are created; existing file is OVERWRITTEN (the Capacitor rename trap)", async () => {
      const r = reader();
      await r.write("deep/nested/dir/a.md", enc("v1"));
      expect(dec(await vault.adapter.readBinary("deep/nested/dir/a.md"))).toBe(
        "v1",
      );
      // Overwrite — on mobile a naive write-then-rename would throw
      // "Destination file already exists".
      await r.write("deep/nested/dir/a.md", enc("v2"));
      expect(dec(await vault.adapter.readBinary("deep/nested/dir/a.md"))).toBe(
        "v2",
      );
    });

    it("write: pull-side canonicalize (toggle ON) strips BOM + CRLF; OFF writes verbatim; invalid UTF-8 passes UNTOUCHED", async () => {
      const withToggle = (on: boolean) =>
        makeVaultFileReader({
          vault: vault as never,
          autoCanonicalize: () => on,
          computeSha: calculateGitBlobSHA,
        });
      const crlfBom = new Uint8Array([
        0xef, 0xbb, 0xbf, // BOM
        ...new TextEncoder().encode("a\r\nb"),
      ]).buffer as ArrayBuffer;

      await withToggle(true).write("doc.md", crlfBom);
      expect(dec(await vault.adapter.readBinary("doc.md"))).toBe("a\nb\n");

      await withToggle(false).write("raw.md", crlfBom);
      const raw = new Uint8Array(await vault.adapter.readBinary("raw.md"));
      expect(raw[0]).toBe(0xef); // verbatim

      // Invalid UTF-8 under a TEXT extension: the round-trip proof
      // must keep the bytes byte-identical (no lossy decode).
      const cp1251 = new Uint8Array([0xc0, 0xc1, 0x0d, 0x0a]).buffer;
      await withToggle(true).write("data.csv", cp1251);
      expect(new Uint8Array(await vault.adapter.readBinary("data.csv"))).toEqual(
        new Uint8Array(cp1251),
      );

      // configDir paths are NOT canonicalized (shouldCanonicalize).
      await withToggle(true).write(".obsidian/app.json", crlfBom);
      const cfg = new Uint8Array(
        await vault.adapter.readBinary(".obsidian/app.json"),
      );
      expect(cfg[0]).toBe(0xef);
    });

    it("remove: trash capture fires BEFORE removal; already-gone is success; a FAILING capture never blocks the removal", async () => {
      await vault.adapter.write("del.md", "x");
      const r = reader();
      await r.remove("del.md");
      expect(captured).toEqual(["del.md"]);
      expect(await vault.adapter.exists("del.md")).toBe(false);

      await r.remove("del.md"); // already gone — no throw, no capture
      expect(captured).toEqual(["del.md"]);

      await vault.adapter.write("del2.md", "y");
      await reader({ explodingCapture: true }).remove("del2.md");
      expect(await vault.adapter.exists("del2.md")).toBe(false); // still removed
      expect(warnings.length).toBeGreaterThan(0); // ...but loudly
    });
  },
);

describe("makeWorkerMergeBlobs — behavioural parity with the main-thread variant", () => {
  // The fake worker runs the SAME mergeText the fallback does — which
  // is exactly WorkerClient's below-threshold inline path.
  const workerMerge = makeWorkerMergeBlobs({
    mergeText: async (ours, base, theirs) => mergeText(ours, base, theirs),
  });

  const cases: Array<{ name: string; path: string; base: ArrayBuffer; ours: ArrayBuffer; theirs: ArrayBuffer }> = [
    {
      name: "clean two-sided merge",
      path: "a.md",
      base: enc("one\ntwo\nthree\n"),
      ours: enc("ONE\ntwo\nthree\n"),
      theirs: enc("one\ntwo\nTHREE\n"),
    },
    {
      name: "same-line conflict",
      path: "a.md",
      base: enc("one\n"),
      ours: enc("ours\n"),
      theirs: enc("theirs\n"),
    },
    {
      name: "binary extension → conflict without reading",
      path: "img.png",
      base: enc("x"),
      ours: enc("y"),
      theirs: enc("z"),
    },
    {
      name: "invalid UTF-8 under a text extension (cp1251 .csv class) → round-trip gate → conflict",
      path: "data.csv",
      base: new Uint8Array([0xc0, 0xc1]).buffer,
      ours: enc("a\n"),
      theirs: enc("b\n"),
    },
  ];

  it.each(cases)("$name", async ({ path: p, base, ours, theirs }) => {
    const main = await mergeBlobsWithMainThreadDiff3(p, base, ours, theirs);
    const worker = await workerMerge(p, base, ours, theirs);
    expect(worker.kind).toBe(main.kind);
    if (main.kind === "clean" && worker.kind === "clean") {
      expect(dec(worker.merged)).toBe(dec(main.merged));
    }
  });
});
