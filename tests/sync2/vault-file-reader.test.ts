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
    selfPluginId: "git-easy-sync",
        vault: vault as never,
        computeSha: calculateGitBlobSHA,
        trashHooks: {
          captureForDelete: async (p: string) => {
            if (opts?.explodingCapture) throw new Error("capture boom");
            captured.push(p);
          },
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
    selfPluginId: "git-easy-sync",
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

    // Owner, 2026-10-05: a deletion that ARRIVES FROM THE SERVER must not
    // remove our own plugin. A remote clean-up of the repo deleted
    // main.js / manifest.json / styles.css locally and the running sync
    // plugin uninstalled itself ("manifest.json not readable"). Removing
    // the plugin is the user's conscious act, never a sync side effect.
    // The files stay; the next commit sends them back (owner's option a).
    it("🔑 remove: OUR plugin's files are kept — no removal, no trash capture, a warning", async () => {
      const dir = ".obsidian/plugins/git-easy-sync";
      for (const f of ["main.js", "manifest.json", "styles.css", ".gitignore"]) {
        await vault.adapter.write(`${dir}/${f}`, "x");
      }
      const r = reader();
      for (const f of ["main.js", "manifest.json", "styles.css", ".gitignore"]) {
        await r.remove(`${dir}/${f}`);
        expect(await vault.adapter.exists(`${dir}/${f}`), f).toBe(true);
      }
      expect(captured).toEqual([]);
      expect(warnings.some((w) => w.includes("own plugin"))).toBe(true);
    });

    // Owner, 2026-10-05: a .gitignore "cannot not exist" — its deletion
    // arriving from the server is suspicious, and in the field it was
    // what exposed formerly ignored files to the next commit. Only OUR
    // managed ones (owner, corrected the same day): the root, .obsidian/
    // and .obsidian/plugins/ — our own plugin's .gitignore is covered by
    // the own-folder guard. Another plugin's folder .gitignore belongs to
    // the user, like the folder itself (see the next test).
    it("🔑 remove: OUR managed .gitignore files are kept — no removal, a warning", async () => {
      const all = [
        ".gitignore",
        ".obsidian/.gitignore",
        ".obsidian/plugins/.gitignore",
        ".obsidian/plugins/git-easy-sync/.gitignore",
      ];
      for (const g of all) await vault.adapter.write(g, "*.log\n");
      const r = reader();
      for (const g of all) {
        await r.remove(g);
        expect(await vault.adapter.exists(g), g).toBe(true);
      }
      expect(captured).toEqual([]);
      expect(warnings.some((w) => w.includes(".gitignore"))).toBe(true);
    });

    it.fails("🔑 remove: ANOTHER plugin's .gitignore is the user's — a remote deletion IS applied", async () => {
      // Owner, 2026-10-05: the user may delete it on purpose; restoring
      // the old one on every device would undo that decision.
      const f = ".obsidian/plugins/templater/.gitignore";
      await vault.adapter.write(f, "*.log\n");
      await reader().remove(f);
      expect(await vault.adapter.exists(f)).toBe(false);
    });

    it("remove: a file merely NAMED like it (notes.gitignore.md, .gitignore.bak) is removed as before", async () => {
      for (const f of ["notes.gitignore.md", "Actual-projects/private/.gitignore.bak"]) {
        await vault.adapter.write(f, "x");
        await reader().remove(f);
        expect(await vault.adapter.exists(f), f).toBe(false);
      }
    });

    // Owner, 2026-10-05: Obsidian's own settings — every file DIRECTLY in
    // the config dir (app.json, appearance.json, hotkeys.json, …) — always
    // exist and are re-created by Obsidian, so a deletion arriving from the
    // server is an accident, not an intent: kept. Sub-folders (plugins/,
    // themes/, snippets/) are what the user installs and removes on
    // purpose — their deletions still propagate.
    it("🔑 remove: a file DIRECTLY in .obsidian/ is kept — no removal, a warning", async () => {
      const core = [".obsidian/app.json", ".obsidian/appearance.json", ".obsidian/hotkeys.json"];
      for (const f of core) await vault.adapter.write(f, "{}");
      const r = reader();
      for (const f of core) {
        await r.remove(f);
        expect(await vault.adapter.exists(f), f).toBe(true);
      }
      expect(captured).toEqual([]);
      expect(warnings.some((w) => w.includes("Obsidian settings file"))).toBe(true);
    });

    it("remove: files in .obsidian/ SUB-folders (themes, snippets, another plugin) are removed as before", async () => {
      for (const f of [
        ".obsidian/themes/Minimal/theme.css",
        ".obsidian/snippets/wide.css",
        ".obsidian/plugins/dataview/main.js",
      ]) {
        await vault.adapter.write(f, "x");
        await reader().remove(f);
        expect(await vault.adapter.exists(f), f).toBe(false);
      }
    });

    it("remove: ANOTHER plugin's files are removed as before (the guard is ours only)", async () => {
      await vault.adapter.write(".obsidian/plugins/templater/main.js", "x");
      await reader().remove(".obsidian/plugins/templater/main.js");
      expect(await vault.adapter.exists(".obsidian/plugins/templater/main.js")).toBe(false);
    });

    it("remove: a sibling folder that merely STARTS with our id is not ours", async () => {
      await vault.adapter.write(".obsidian/plugins/git-easy-sync-reload-probe/main.js", "x");
      await reader().remove(".obsidian/plugins/git-easy-sync-reload-probe/main.js");
      expect(
        await vault.adapter.exists(".obsidian/plugins/git-easy-sync-reload-probe/main.js"),
      ).toBe(false);
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

// ⚠️ WHAT THIS PINS CHANGED ON 2026-10-02, and the old name would lie.
// The two wirings used to be hand-written copies, and this was their
// parity check. They are now one body with the merge injected, so
// parity is structural and a divergence between them is no longer a
// thing that can happen.
//
// It is kept — retitled — because it still catches the move that would
// bring the divergence back: re-splitting the copies. And it is the
// only place the WORKER-shaped wiring (async, awaited) is driven
// end-to-end through both gates at all; the six files that use
// `mergeBlobsWithMainThreadDiff3` all drive the synchronous one.
describe("makeWorkerMergeBlobs — the async wiring clears both gates", () => {
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
