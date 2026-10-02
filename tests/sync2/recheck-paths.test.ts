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
  dropRecheckPath,
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

  it("🔑 a TORN APPEND loses only its own line — everything recorded before survives", async () => {
    // The reason the format is lines and not a JSON array. A write
    // interrupted halfway through a JSON document destroys the whole
    // list; here it leaves a fragment with no trailing newline, and
    // only complete lines are read.
    const f = fixture();
    try {
      await addRecheckPaths(f.adapter, PLUGIN_DIR, ["a.md", "b.md"]);
      // ...and now a third append dies mid-path.
      await f.adapter.append(recheckMarkerPath(PLUGIN_DIR), "notes/parti");
      const r = await readRecheckPaths(f.adapter, PLUGIN_DIR, PLUGIN_DIR);
      expect(r.paths).toEqual(["a.md", "b.md"]);
      expect(r.torn).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("🔑 a note we cannot READ falls back to our own files — never to silence", async () => {
    // Silence is the one answer this mechanism may not give: it is
    // indistinguishable from "nothing was skipped", which is the state
    // the note exists to contradict.
    const f = fixture();
    try {
      await addRecheckPaths(f.adapter, PLUGIN_DIR, ["a.md"]);
      const adapter = {
        ...f.adapter,
        exists: f.adapter.exists.bind(f.adapter),
        read: async () => {
          throw new Error("unreadable");
        },
      } as unknown as DataAdapter;
      const r = await readRecheckPaths(adapter, PLUGIN_DIR, PLUGIN_DIR);
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

  it("the consumed-path rewrite goes through tmp → rename, never over the live file", async () => {
    // The ONE rewrite in this file. A half-replaced note would be the
    // only way to lose requests that were already safely recorded.
    const f = fixture();
    const renames: Array<[string, string]> = [];
    try {
      await addRecheckPaths(f.adapter, PLUGIN_DIR, ["a.md", "b.md"]);
      const realRename = f.adapter.rename.bind(f.adapter);
      const adapter = {
        ...f.adapter,
        exists: f.adapter.exists.bind(f.adapter),
        read: f.adapter.read.bind(f.adapter),
        write: f.adapter.write.bind(f.adapter),
        remove: f.adapter.remove.bind(f.adapter),
        rename: async (from: string, to: string) => {
          renames.push([from, to]);
          return realRename(from, to);
        },
      } as unknown as DataAdapter;
      await dropRecheckPath(adapter, PLUGIN_DIR, "a.md");
      expect(renames).toHaveLength(1);
      expect(renames[0][1]).toBe(recheckMarkerPath(PLUGIN_DIR));
      expect(
        (await readRecheckPaths(f.adapter, PLUGIN_DIR, PLUGIN_DIR)).paths,
      ).toEqual(["b.md"]);
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
