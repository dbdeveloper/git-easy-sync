// "Ask again about these paths" (owner, 2026-10-02).
//
// A skipped path is invisible to every future drain: the local file
// matches its baseline (correctly — nothing was applied), and the
// remote change sits behind the base where no delta will name it. The
// note is how the next drain learns to ask directly.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { Vault as MockVault } from "../../mock-obsidian";
import {
  addRecheckPaths,
  readRecheckPaths,
  clearRecheckPaths,
  recheckMarkerPath,
  RECHECK_PATHS_MARKER,
} from "../../src/sync2/recheck-paths";
import type { DataAdapter } from "obsidian";

const PLUGIN_DIR = ".obsidian/plugins/git-easy-sync";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "recheck-"));
  const vault = new MockVault(root) as unknown as { adapter: DataAdapter };
  return {
    adapter: vault.adapter,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("the recheck note", () => {
  it("is a marker by the project's convention: dot-prefixed, no extension", () => {
    expect(RECHECK_PATHS_MARKER.startsWith(".")).toBe(true);
    expect(RECHECK_PATHS_MARKER.includes(".json")).toBe(false);
    expect(recheckMarkerPath(PLUGIN_DIR)).toBe(
      `${PLUGIN_DIR}/.runtime/${RECHECK_PATHS_MARKER}`,
    );
  });

  it("🔑 MERGES — two writers reach this file and neither may erase the other", async () => {
    // The drain's skip sites write it mid-run; the bootloader writes it
    // at the top of onload. A note that overwrote would silently drop
    // whichever request came first.
    const f = fixture();
    try {
      await addRecheckPaths(f.adapter, PLUGIN_DIR, ["a.md"]);
      await addRecheckPaths(f.adapter, PLUGIN_DIR, ["b.md"]);
      await addRecheckPaths(f.adapter, PLUGIN_DIR, ["a.md"]); // idempotent
      const r = await readRecheckPaths(f.adapter, PLUGIN_DIR, PLUGIN_DIR);
      expect(r.paths).toEqual(["a.md", "b.md"]);
      expect(r.torn).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("no note at all is the ordinary state, not an error", async () => {
    const f = fixture();
    try {
      const r = await readRecheckPaths(f.adapter, PLUGIN_DIR, PLUGIN_DIR);
      expect(r).toEqual({ paths: [], torn: false });
    } finally {
      f.cleanup();
    }
  });

  it("🔑 a TORN note falls back to our own files — it is never discarded", async () => {
    // Discarding is the fail-silent direction, which is the whole
    // thing this note exists to prevent. The fallback is bounded to
    // three paths and covers the case that motivated the mechanism.
    const f = fixture();
    try {
      await f.adapter.mkdir(`${PLUGIN_DIR}/.runtime`);
      await f.adapter.write(recheckMarkerPath(PLUGIN_DIR), "{ not json");
      const r = await readRecheckPaths(f.adapter, PLUGIN_DIR, PLUGIN_DIR);
      expect(r.torn).toBe(true);
      expect(r.paths).toEqual([
        `${PLUGIN_DIR}/main.js`,
        `${PLUGIN_DIR}/manifest.json`,
        `${PLUGIN_DIR}/styles.css`,
      ]);
    } finally {
      f.cleanup();
    }
  });

  it("clearing is idempotent — a note that was never there is not an error", async () => {
    const f = fixture();
    try {
      await clearRecheckPaths(f.adapter, PLUGIN_DIR);
      await addRecheckPaths(f.adapter, PLUGIN_DIR, ["a.md"]);
      await clearRecheckPaths(f.adapter, PLUGIN_DIR);
      expect(
        (await readRecheckPaths(f.adapter, PLUGIN_DIR, PLUGIN_DIR)).paths,
      ).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});
