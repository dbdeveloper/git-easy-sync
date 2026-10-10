// The progress log (SYNC2-NEW-DRAIN §II.19, owner 2026-10-10): one line per
// path whose outcome a drain has already fixed — "the common base is now
// this remote version, and it is on disk". Replayed into the baselines
// before the next commit pass, so an interrupted run (cancel, network
// drop, battery) does not leave those files looking like local additions.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { Vault as MockVault } from "../../mock-obsidian";
import {
  appendProgress,
  replayProgress,
  progressFilePath,
} from "../../src/sync2/vault-step-progress";
import type { DataAdapter } from "obsidian";

const PLUGIN_DIR = ".obsidian/plugins/git-easy-sync";

type B = { baselineSha: string; mtime: number; size: number };

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "progress-"));
  const vault = new MockVault(root) as unknown as { adapter: DataAdapter };
  const map = new Map<string, B>();
  const baselines = {
    getMany: async (paths: string[]) => {
      const out = new Map<string, B>();
      for (const p of paths) {
        const b = map.get(p);
        if (b !== undefined) out.set(p, b);
      }
      return out;
    },
    setMany: async (entries: Array<{ path: string } & B>) => {
      for (const { path: p, ...b } of entries) map.set(p, b);
    },
    removeMany: async (paths: string[]) => {
      for (const p of paths) map.delete(p);
    },
  };
  return {
    adapter: vault.adapter,
    map,
    baselines,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("the Vault-step progress log", () => {
  it("is a DATA file in .runtime (not a marker): ordinary name, .jsonl", () => {
    expect(progressFilePath(PLUGIN_DIR)).toBe(
      `${PLUGIN_DIR}/.runtime/vault-step-progress.jsonl`,
    );
  });

  it("replay: each line becomes a baseline with mtime 0; a deletion removes the baseline; the file is gone afterwards", async () => {
    const f = fixture();
    try {
      f.map.set("gone.md", { baselineSha: "old", mtime: 9, size: 3 });
      await appendProgress(f.adapter, PLUGIN_DIR, [
        { path: "a.md", sha: "sa", size: 5 },
        { path: "gone.md", deleted: true },
      ]);
      await appendProgress(f.adapter, PLUGIN_DIR, [{ path: "b.md", sha: "sb", size: 7 }]);

      const n = await replayProgress(f.adapter, PLUGIN_DIR, f.baselines);
      expect(n).toBe(3);
      expect(f.map.get("a.md")).toEqual({ baselineSha: "sa", mtime: 0, size: 5 });
      expect(f.map.get("b.md")).toEqual({ baselineSha: "sb", mtime: 0, size: 7 });
      expect(f.map.has("gone.md")).toBe(false);
      expect(await f.adapter.exists(progressFilePath(PLUGIN_DIR))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("replay: the LAST line of a path wins (a path settled twice in one run)", async () => {
    const f = fixture();
    try {
      await appendProgress(f.adapter, PLUGIN_DIR, [
        { path: "a.md", sha: "pushed", size: 1 },
        { path: "a.md", sha: "pulled-later", size: 2 },
      ]);
      await replayProgress(f.adapter, PLUGIN_DIR, f.baselines);
      expect(f.map.get("a.md")?.baselineSha).toBe("pulled-later");
    } finally {
      f.cleanup();
    }
  });

  it("replay keeps a PROVEN stat of the same sha (keepProvenStats), never lends one to another sha", async () => {
    const f = fixture();
    try {
      f.map.set("same.md", { baselineSha: "s1", mtime: 77, size: 4 });
      f.map.set("other.md", { baselineSha: "older", mtime: 55, size: 6 });
      await appendProgress(f.adapter, PLUGIN_DIR, [
        { path: "same.md", sha: "s1", size: 0 },
        { path: "other.md", sha: "s2", size: 8 },
      ]);
      await replayProgress(f.adapter, PLUGIN_DIR, f.baselines);
      expect(f.map.get("same.md")).toEqual({ baselineSha: "s1", mtime: 77, size: 4 });
      expect(f.map.get("other.md")).toEqual({ baselineSha: "s2", mtime: 0, size: 8 });
    } finally {
      f.cleanup();
    }
  });

  it("a torn last line (no newline — a crash mid-append) is ignored, the complete lines still apply", async () => {
    const f = fixture();
    try {
      await appendProgress(f.adapter, PLUGIN_DIR, [{ path: "a.md", sha: "sa", size: 5 }]);
      await f.adapter.append(progressFilePath(PLUGIN_DIR), '{"path":"b.md","sha":"s');
      const n = await replayProgress(f.adapter, PLUGIN_DIR, f.baselines);
      expect(n).toBe(1);
      expect(f.map.has("a.md")).toBe(true);
      expect(f.map.has("b.md")).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("a double replay (crash between applying and deleting) changes nothing the second time", async () => {
    const f = fixture();
    try {
      await appendProgress(f.adapter, PLUGIN_DIR, [{ path: "a.md", sha: "sa", size: 5 }]);
      const raw = await f.adapter.read(progressFilePath(PLUGIN_DIR));
      await replayProgress(f.adapter, PLUGIN_DIR, f.baselines);
      const after1 = new Map(f.map);
      // the file "survived" the crash
      await f.adapter.write(progressFilePath(PLUGIN_DIR), raw);
      await replayProgress(f.adapter, PLUGIN_DIR, f.baselines);
      expect(f.map).toEqual(after1);
    } finally {
      f.cleanup();
    }
  });

  it("no file → nothing to do, nothing written", async () => {
    const f = fixture();
    try {
      expect(await replayProgress(f.adapter, PLUGIN_DIR, f.baselines)).toBe(0);
      expect(f.map.size).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});
