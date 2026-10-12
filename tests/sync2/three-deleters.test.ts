// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import ConflictStoreV2, { emptyConflictsState } from "../../src/sync2/conflict-store-v2";
import { processConflicts } from "../../src/sync2/process-conflicts";
import SiblingTx from "../../src/sync2/sibling-tx";
import {
  buildSiblingFilePath,
  readSiblingFileFromVault,
} from "../../src/sync2/conflict-siblings";
import { removeIfPresent } from "../../src/sync2/cross-platform";
import { emptyFileInfo, type FileInfo } from "../../src/sync2/diff3";
import { calculateGitBlobSHA } from "../../src/utils";
import { startSession } from "../../src/diff2/autosave-store";
import { commit7Step } from "../../src/diff2/exit-commit";

// Three places remove conflict copies (owner, 2026-10-12): the drain, [←] in
// the diff editor, and the synthetic-copy cleanup (plugin start, panel open).
// They run independently, so each must survive the others getting to a file
// first: a step that checked a file and then acts on it finds it gone. That
// is "the goal is reached", never a failure (owner: "just run on as if
// nothing happened").
//
// Obsidian's adapter.remove throws on a missing file and readBinary throws on
// one; the test double is lenient about remove, so `strict()` makes it real,
// and `vanishBefore(op, path)` lets "the other deleter" remove the file right
// before this one touches it.

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const sha = (s: string) => calculateGitBlobSHA(enc(s));
const BASE = "note.md";

describe("three deleters of conflict copies never break each other", () => {
  let root: string;
  let vault: MockVault;
  type A = Record<string, (...a: unknown[]) => Promise<unknown>>;
  let adapter: A;

  beforeEach(() => {
    root = path.join(os.tmpdir(), `three-deleters-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
    vault = new MockVault(root);
    adapter = vault.adapter as unknown as A;
    Object.defineProperty(vault, "adapter", { get: () => adapter, configurable: true });
    const remove = adapter.remove.bind(adapter);
    adapter.remove = async (p: unknown) => {
      if (!fs.existsSync(path.join(root, String(p)))) throw new Error(`ENOENT: ${String(p)}`);
      return remove(p);
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const put = (p: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  };
  const vanishBefore = (op: string, target: string) => {
    const orig = adapter[op].bind(adapter);
    adapter[op] = async (...args: unknown[]) => {
      if (args[0] === target) fs.rmSync(path.join(root, target), { force: true });
      return orig(...args);
    };
  };
  const copyRecord = async (content: string, timeLabel: number): Promise<FileInfo> => ({
    ...emptyFileInfo(),
    path: BASE,
    timeLabel,
    deviceLabel: "phone",
    sha: await sha(content),
    size: content.length,
    originSha: await sha(content),
  });

  it("removeIfPresent: a file already gone is done; a removal that fails while the file is there still fails", async () => {
    await expect(removeIfPresent(vault.adapter as never, "missing.md")).resolves.toBe(false);
    put("x.md", "x");
    expect(await removeIfPresent(vault.adapter as never, "x.md")).toBe(true);
    put("y.md", "y");
    adapter.remove = async () => {
      throw new Error("EACCES");
    };
    await expect(removeIfPresent(vault.adapter as never, "y.md")).rejects.toThrow("EACCES");
  });

  it("🔑 drain: a TRACKED copy removed between its stat and its read ([←] got there) → the record is pruned, no failure", async () => {
    put(BASE, "ours\n");
    const rec = await copyRecord("theirs\n", 2000);
    const copyPath = buildSiblingFilePath(BASE, 2000, "phone");
    put(copyPath, "edited by hand\n"); // differs from the record → it must read
    vanishBefore("readBinary", copyPath);
    const store = new ConflictStoreV2({ vault: vault as unknown as Vault, selfPluginId: "git-easy-sync" });
    const state = emptyConflictsState();
    state.entries.set(BASE, { conflictBase: { ...emptyFileInfo(), path: BASE }, siblings: [rec] });
    const out = await processConflicts(
      { vault: vault as unknown as Vault, store, computeSha: calculateGitBlobSHA },
      state,
    );
    expect(out.entries.has(BASE)).toBe(false);
  });

  it("🔑 drain: the previous copy it is about to fold was removed meanwhile → read as 'not found', no failure", async () => {
    const rec = await copyRecord("theirs\n", 2000);
    const copyPath = buildSiblingFilePath(BASE, 2000, "phone");
    put(copyPath, "theirs\n");
    vanishBefore("readBinary", copyPath);
    expect(
      await readSiblingFileFromVault(vault as unknown as Vault, {
        path: BASE,
        timeLabel: 2000,
        deviceLabel: "phone",
        sha: rec.sha,
        size: rec.size,
        mtime: null,
      }),
    ).toBeNull();
  });

  it("🔑 drain recovery: the new copy of an interrupted replace removed during the integrity check → rolled back, no failure", async () => {
    const store = new ConflictStoreV2({ vault: vault as unknown as Vault, selfPluginId: "git-easy-sync" });
    const tx = new SiblingTx({
      vault: vault as unknown as Vault,
      selfPluginId: "git-easy-sync",
      store,
      computeSha: calculateGitBlobSHA,
      generateGuid: () => "g",
    });
    const oldSib = await copyRecord("old\n", 1000);
    const newSib = await copyRecord("merged\n", 2000);
    put(buildSiblingFilePath(BASE, 1000, "phone"), "old\n");
    put(buildSiblingFilePath(BASE, 2000, "phone"), "merged\n");
    const s = emptyConflictsState();
    s.entries.set(BASE, { conflictBase: { ...emptyFileInfo(), path: BASE }, siblings: [oldSib] });
    await store.save(s);
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })["writeMark"]({
      guid: "g",
      path: BASE,
      oldSibling: oldSib,
      newSibling: newSib,
    });
    vanishBefore("readBinary", buildSiblingFilePath(BASE, 2000, "phone"));
    await expect(tx.recoverIfNeeded()).resolves.toBeUndefined();
    const after = await store.load();
    expect(after.entries.get(BASE)!.siblings.map((x) => x.timeLabel)).toEqual([1000]);
  });

  it("🔑 [←]: the copy it removes after an identical resolution was removed by the cleanup first → the commit completes", async () => {
    const SIB = buildSiblingFilePath(BASE, 2000, "phone");
    put(BASE, "ours\n");
    put(SIB, "theirs\n");
    const NOW = "2026-10-12T10:00:00.000Z";
    const meta = await startSession(vault as unknown as Vault, "id1", BASE, SIB, NOW);
    // Both sides resolved to the same text → step 6.5 removes the copy; the
    // cleanup sees "copy equal to its file" and gets there first. (The FIRST
    // remove of the copy's name is the promote of its new bytes; the second
    // is step 6.5.)
    const remove = adapter.remove.bind(adapter);
    let removesOfCopy = 0;
    adapter.remove = async (p: unknown) => {
      if (p === SIB && ++removesOfCopy === 2) fs.rmSync(path.join(root, SIB), { force: true });
      return remove(p);
    };
    const res = await commit7Step(
      vault as unknown as Vault,
      "id1",
      meta,
      { base: "agreed\n", sibling: "agreed\n" },
      { now: NOW },
    );
    expect(removesOfCopy).toBe(2); // the race really happened at step 6.5
    expect(fs.existsSync(path.join(root, SIB))).toBe(false);
    expect(res.siblingRemoved).toBe(true);
  });
});
