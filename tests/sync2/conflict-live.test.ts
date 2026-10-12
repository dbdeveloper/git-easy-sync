// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import { isConflictInForce, copyMatchesBase } from "../../src/sync2/conflict-live";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { FileInfo, emptyFileInfo } from "../../src/sync2/diff3";
import { calculateGitBlobSHA } from "../../src/utils";
import ConflictStoreV2, { emptyConflictsState } from "../../src/sync2/conflict-store-v2";
import { processConflicts } from "../../src/sync2/process-conflicts";

// "Is this conflict still in force?" — the owner's rule (2026-10-11), READ
// ONLY: a tracked copy exists on disk AND differs from the base. A copy
// that is gone, or byte-equal to the base, no longer holds the conflict.
// Base deleted while a copy exists: still in force. Synthetic copies never
// hold a tracked conflict. The commit pass, the .gitignore gate and the
// drain's own reconcile ask THIS — so they can never disagree.

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const sha = (s: string) => calculateGitBlobSHA(enc(s));

describe("isConflictInForce", () => {
  let dir: string;
  let vault: Vault;
  const reads: string[] = [];
  const deps = () => {
    const adapter = vault.adapter;
    return {
      adapter: {
        stat: (p: string) => adapter.stat(p),
        readBinary: async (p: string) => {
          reads.push(p);
          return adapter.readBinary(p);
        },
      },
      computeSha: calculateGitBlobSHA,
    };
  };
  const put = (p: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  };
  const copy = async (content: string | null, timeLabel = 2000, label = "phone"): Promise<FileInfo> => {
    const p = buildSiblingFilePath("note.md", timeLabel, label);
    if (content !== null) put(p, content);
    return {
      ...emptyFileInfo(),
      path: "note.md",
      timeLabel,
      deviceLabel: label,
      sha: await sha("born as this\n"),
      size: "born as this\n".length,
      originSha: await sha("born as this\n"),
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "conflict-live-"));
    vault = new Vault(dir);
    reads.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a copy that differs from the base → in force", async () => {
    put("note.md", "ours\n");
    expect(await isConflictInForce(deps(), "note.md", [await copy("theirs\n")])).toBe(true);
  });

  it("🔑 the copy made byte-equal to the base → NOT in force", async () => {
    put("note.md", "ours\n");
    expect(await isConflictInForce(deps(), "note.md", [await copy("ours\n")])).toBe(false);
  });

  it("the copy gone from disk → NOT in force", async () => {
    put("note.md", "ours\n");
    expect(await isConflictInForce(deps(), "note.md", [await copy(null)])).toBe(false);
  });

  it("base deleted, copy present → in force (the conflict goes on)", async () => {
    expect(await isConflictInForce(deps(), "note.md", [await copy("theirs\n")])).toBe(true);
  });

  it("both files gone → NOT in force", async () => {
    expect(await isConflictInForce(deps(), "note.md", [await copy(null)])).toBe(false);
  });

  it("several copies: in force while ANY one still differs", async () => {
    put("note.md", "ours\n");
    const equal = await copy("ours\n", 2000);
    const differs = await copy("other\n", 5000, "laptop");
    expect(await isConflictInForce(deps(), "note.md", [equal, differs])).toBe(true);
    fs.rmSync(path.join(dir, buildSiblingFilePath("note.md", 5000, "laptop")));
    expect(await isConflictInForce(deps(), "note.md", [equal, differs])).toBe(false);
  });

  it("a copy of another size than the base is decided WITHOUT reading anything", async () => {
    put("note.md", "o\n");
    expect(await isConflictInForce(deps(), "note.md", [await copy("a much longer copy\n")])).toBe(true);
    expect(reads).toEqual([]);
  });

  it("a copy unchanged since measured (size+mtime match the record) is not read", async () => {
    put("note.md", "same size!\n");
    const c = await copy("SAME SIZE!\n");
    const st = fs.statSync(path.join(dir, buildSiblingFilePath("note.md", 2000, "phone")));
    c.sha = await sha("SAME SIZE!\n");
    c.size = st.size;
    c.mtime = st.mtimeMs;
    expect(await isConflictInForce(deps(), "note.md", [c])).toBe(true);
    expect(reads).not.toContain(buildSiblingFilePath("note.md", 2000, "phone"));
  });

  it("never writes the record (read-only): a stale cache stays as it was", async () => {
    put("note.md", "ours\n");
    const c = await copy("ours\n");
    const before = { ...c };
    await isConflictInForce(deps(), "note.md", [c]);
    expect(c).toEqual(before);
  });

  it("copyMatchesBase: 'gone' / true / false per copy", async () => {
    put("note.md", "ours\n");
    const base = await import("../../src/sync2/conflict-live").then((m) => m.baseFacts(deps(), "note.md"));
    expect(await copyMatchesBase(deps(), "note.md", await copy(null), base)).toBe("gone");
    expect(await copyMatchesBase(deps(), "note.md", await copy("ours\n", 3000), base)).toBe(true);
    expect(await copyMatchesBase(deps(), "note.md", await copy("theirs\n", 4000), base)).toBe(false);
  });

  // The drain must agree with every reader: the same fixture through the
  // drain's reconcile prunes exactly when the predicate says "not in force".
  it("🔑 agrees with the drain's reconcile on the same files", async () => {
    const store = new ConflictStoreV2({ vault: vault as never, selfPluginId: "git-easy-sync" });
    for (const [label, files] of [
      ["equal", { base: "ours\n", copy: "ours\n" }],
      ["differs", { base: "ours\n", copy: "theirs\n" }],
      ["gone", { base: "ours\n", copy: null }],
    ] as const) {
      put("note.md", files.base);
      const c = await copy(files.copy, label === "equal" ? 11000 : label === "differs" ? 12000 : 13000);
      const state = emptyConflictsState();
      state.entries.set("note.md", {
        conflictBase: { ...emptyFileInfo(), path: "note.md", sha: "cb" },
        siblings: [c],
      });
      const inForce = await isConflictInForce(deps(), "note.md", [c]);
      const after = await processConflicts(
        { vault: vault as never, store, computeSha: calculateGitBlobSHA },
        state,
      );
      expect(after.entries.has("note.md")).toBe(inForce);
      if (files.copy !== null) fs.rmSync(path.join(dir, buildSiblingFilePath("note.md", c.timeLabel!, "phone")), { force: true });
    }
  });
});
