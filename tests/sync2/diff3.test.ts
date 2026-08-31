import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import {
  _diff3,
  DELETED,
  Diff3Deps,
  FileInfo,
  emptyFileInfo,
  mergeBlobsWithMainThreadDiff3,
} from "../../src/sync2/diff3";
import { DELETED_SHA_HASH } from "../../src/sync2/discovery";
import {
  BaseFileNotInRepoError,
  CompareWrongFilesError,
  LocalFileNotFoundError,
  NetworkError,
  RemoteFileNotInRepoError,
} from "../../src/errors";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII category A (29) — _diff3 rules §II.1 п.2-4 as a pure-ish
// function; A.1 (п.1-20) — the .obsidian/ + plugins/** branch;
// P.20-22 — rule 7's lazy remote.size. A.1 п.21-25 (main-loop mtime
// sourcing) belong to the loop-assembly step, not here.

const PLUGIN_ID = "git-easy-sync";
const HEAD = "headsha";

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

const fi = (over: Partial<FileInfo>): FileInfo => ({
  ...emptyFileInfo(),
  ...over,
});
// An ordinary side with content available inline (skips the store).
const side = (p: string, content: string, over?: Partial<FileInfo>): FileInfo =>
  fi({
    path: p,
    sha: `sha(${content})`,
    size: content.length,
    blob: enc(content),
    mode: "",
    ...over,
  });
const deletedSide = (p: string): FileInfo =>
  fi({ path: p, sha: "pre-sentinel", mode: DELETED });

describe("_diff3 (§VIII A + A.1 + P.20-22)", () => {
  let dir: string;
  let vault: Vault;
  let syncStore: SyncStore;
  let repoFetches: string[];
  let metaCalls: string[];

  const makeDeps = (over?: Partial<Diff3Deps>): Diff3Deps => ({
    syncStore,
    verifiedShas: new Set(),
    getBlobFromRepo: async (sha) => {
      repoFetches.push(sha);
      return null;
    },
    getContentsMetadataAtRef: async (p) => {
      metaCalls.push(p);
      return null;
    },
    maxAutoMergeFileSize: () => 10_000_000,
    mergeBlobs: mergeBlobsWithMainThreadDiff3,
    computeSha: calculateGitBlobSHA,
    ...over,
  });

  const t = (base: FileInfo, remote: FileInfo) => ({ base, remote });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "diff3-test-"));
    vault = new Vault(dir);
    syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    repoFetches = [];
    metaCalls = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── A: standard rules ────────────────────────────────────────────

  it("A.1: base=null, only local → local (4.1.a)", async () => {
    const local = side("n.md", "L");
    const r = await _diff3(makeDeps(), null, local, HEAD);
    expect(r).toEqual({ kind: "file", file: local });
  });

  it("A.2: base=null, only remote → remote (4.1.b)", async () => {
    const remote = side("n.md", "R");
    const r = await _diff3(makeDeps(), t(emptyFileInfo(), remote), null, HEAD);
    expect(r).toEqual({ kind: "file", file: remote });
  });

  it("A.3: base=null, local + remote=deleted → local (4.1.c)", async () => {
    const local = side("n.md", "L");
    const r = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), deletedSide("n.md")),
      local,
      HEAD,
    );
    expect(r).toEqual({ kind: "file", file: local });
  });

  it("A.4: base=null, local=deleted + remote → remote (4.1.d)", async () => {
    const remote = side("n.md", "R");
    const r = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), remote),
      deletedSide("n.md"),
      HEAD,
    );
    expect(r.kind).toBe("file");
    expect((r as { file: FileInfo }).file.sha).toBe(remote.sha);
  });

  it("A.5: base=null, local==remote → that content, no conflict (2.a)", async () => {
    const local = side("n.md", "same");
    const remote = side("n.md", "same");
    const r = await _diff3(makeDeps(), t(emptyFileInfo(), remote), local, HEAD);
    expect(r.kind).toBe("file");
    expect((r as { file: FileInfo }).file.sha).toBe(local.sha);
  });

  it("A.6: base=null, both deleted → deleted, no conflict (2.a via equal sentinels)", async () => {
    const r = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), deletedSide("n.md")),
      deletedSide("n.md"),
      HEAD,
    );
    expect(r.kind).toBe("file");
    const f = (r as { file: FileInfo }).file;
    expect(f.mode).toBe(DELETED);
    expect(f.sha).toBe(DELETED_SHA_HASH);
  });

  it("A.7: base=null, local≠remote, both real → MANUAL_CONFLICT (4.2)", async () => {
    const r = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), side("n.md", "R")),
      side("n.md", "L"),
      HEAD,
    );
    expect(r).toEqual({ kind: "manual-conflict" });
  });

  it("A.8: base=A local=A remote=A → A, no push (2.a)", async () => {
    const a = side("n.md", "A");
    const r = await _diff3(makeDeps(), t(a, side("n.md", "A")), a, HEAD);
    expect(r.kind).toBe("file");
    expect((r as { file: FileInfo }).file.sha).toBe(a.sha);
  });

  it("A.9: base=A local=A remote=B → B, clean pull (4.3)", async () => {
    const b = side("n.md", "B");
    const r = await _diff3(
      makeDeps(),
      t(side("n.md", "A"), b),
      side("n.md", "A"),
      HEAD,
    );
    expect(r).toEqual({ kind: "file", file: b });
  });

  it("A.10: base=A local=B remote=A → B, clean push (4.4)", async () => {
    const b = side("n.md", "B");
    const r = await _diff3(
      makeDeps(),
      t(side("n.md", "A"), side("n.md", "A")),
      b,
      HEAD,
    );
    expect(r).toEqual({ kind: "file", file: b });
  });

  it("A.11: base=A local=B remote=B → B, both agreed (2.a)", async () => {
    const b = side("n.md", "B");
    const r = await _diff3(makeDeps(), t(side("n.md", "A"), side("n.md", "B")), b, HEAD);
    expect(r.kind).toBe("file");
    expect((r as { file: FileInfo }).file.sha).toBe(b.sha);
  });

  it("A.12: base=A local=null remote=null → A (2.b, null-as-base)", async () => {
    const a = side("n.md", "A");
    const r = await _diff3(makeDeps(), t(a, emptyFileInfo()), null, HEAD);
    expect(r.kind).toBe("file");
    expect((r as { file: FileInfo }).file.sha).toBe(a.sha);
  });

  it("A.13: base=A local=B remote=null → B (4.5.a)", async () => {
    const b = side("n.md", "B");
    const r = await _diff3(makeDeps(), t(side("n.md", "A"), emptyFileInfo()), b, HEAD);
    expect(r).toEqual({ kind: "file", file: b });
  });

  it("A.14: base=A local=null remote=B → B (4.5.b)", async () => {
    const b = side("n.md", "B");
    const r = await _diff3(makeDeps(), t(side("n.md", "A"), b), null, HEAD);
    expect(r).toEqual({ kind: "file", file: b });
  });

  it("A.15: base=A local=B remote=deleted → B wins (4.6.a, edit beats delete)", async () => {
    const b = side("n.md", "B");
    const r = await _diff3(
      makeDeps(),
      t(side("n.md", "A"), deletedSide("n.md")),
      b,
      HEAD,
    );
    expect(r).toEqual({ kind: "file", file: b });
  });

  it("A.16: base=A local=deleted remote=B → MANUAL_CONFLICT (4.6.b — the deliberate asymmetry of A.15)", async () => {
    const r = await _diff3(
      makeDeps(),
      t(side("n.md", "A"), side("n.md", "B")),
      deletedSide("n.md"),
      HEAD,
    );
    expect(r).toEqual({ kind: "manual-conflict" });
  });

  it("A.17: base=A both deleted → deleted, no conflict (sentinel equality, 2.a)", async () => {
    const r = await _diff3(
      makeDeps(),
      t(side("n.md", "A"), deletedSide("n.md")),
      deletedSide("n.md"),
      HEAD,
    );
    expect(r.kind).toBe("file");
    expect((r as { file: FileInfo }).file.sha).toBe(DELETED_SHA_HASH);
  });

  it("A.18: size gate — max smaller than max(sizes) → MANUAL_CONFLICT even though diff3 would merge cleanly (4.7)", async () => {
    // Non-overlapping edits — a real diff3 merges this cleanly.
    const base = side("n.md", "one\ntwo\nthree\n");
    const local = side("n.md", "ONE\ntwo\nthree\n");
    const remote = side("n.md", "one\ntwo\nTHREE\n");
    const deps = makeDeps({ maxAutoMergeFileSize: () => 5 });
    expect(await _diff3(deps, t(base, remote), local, HEAD)).toEqual({
      kind: "manual-conflict",
    });
    // Sanity: with a permissive limit the same inputs DO merge.
    const ok = await _diff3(makeDeps(), t(base, remote), local, HEAD);
    expect(ok.kind).toBe("file");
  });

  it("A.19: maximum_auto_merge_file_size=0 → diff3 never runs, every differing pair conflicts", async () => {
    let merges = 0;
    const deps = makeDeps({
      maxAutoMergeFileSize: () => 0,
      mergeBlobs: async (...args) => {
        merges += 1;
        return mergeBlobsWithMainThreadDiff3(...args);
      },
    });
    const r = await _diff3(
      deps,
      t(side("n.md", "one\n"), side("n.md", "two\n")),
      side("n.md", "three\n"),
      HEAD,
    );
    expect(r).toEqual({ kind: "manual-conflict" });
    expect(merges).toBe(0);
  });

  it("A.20: sides disagree on path → COMPARE_WRONG_FILES", async () => {
    await expect(
      _diff3(
        makeDeps(),
        t(side("a.md", "A"), side("b.md", "R")),
        side("a.md", "L"),
        HEAD,
      ),
    ).rejects.toThrow(CompareWrongFilesError);
  });

  it("A.21: local.blob absent and not in sync_store → LOCAL_FILE_IS_NOT_FOUND_ERROR", async () => {
    const local = fi({ path: "n.md", sha: "sha-l", size: 3, mode: "" });
    await expect(
      _diff3(
        makeDeps(),
        t(side("n.md", "A"), side("n.md", "R")),
        local,
        HEAD,
      ),
    ).rejects.toThrow(LocalFileNotFoundError);
  });

  it("A.22: remote.blob missing from store, fetched from GitHub → merge succeeds, blob SAVED to store", async () => {
    const base = side("n.md", "one\ntwo\nthree\n");
    const local = side("n.md", "ONE\ntwo\nthree\n");
    const remoteContent = "one\ntwo\nTHREE\n";
    const remoteSha = await calculateGitBlobSHA(enc(remoteContent));
    const remote = fi({
      path: "n.md",
      sha: remoteSha,
      size: remoteContent.length,
      mode: "",
    });
    const deps = makeDeps({
      getBlobFromRepo: async (sha) => {
        repoFetches.push(sha);
        return sha === remoteSha ? enc(remoteContent) : null;
      },
    });
    const r = await _diff3(deps, t(base, remote), local, HEAD);
    expect(r.kind).toBe("file");
    expect(dec((r as { file: FileInfo }).file.blob!)).toBe(
      "ONE\ntwo\nTHREE\n",
    );
    expect(repoFetches).toEqual([remoteSha]);
    expect(await syncStore.existInSyncStore(remoteSha)).toBe(true);
  });

  it("A.23: remote blob NOT in store and NOT on GitHub → REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR", async () => {
    const remote = fi({ path: "n.md", sha: "gone-sha", size: 3, mode: "" });
    await expect(
      _diff3(
        makeDeps(),
        t(side("n.md", "A"), remote),
        side("n.md", "L"),
        HEAD,
      ),
    ).rejects.toThrow(RemoteFileNotInRepoError);
  });

  it("A.24: base blob NOT in store and NOT on GitHub → BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR", async () => {
    const base = fi({ path: "n.md", sha: "gone-base", size: 3, mode: "" });
    await expect(
      _diff3(
        makeDeps(),
        t(base, side("n.md", "R")),
        side("n.md", "L"),
        HEAD,
      ),
    ).rejects.toThrow(BaseFileNotInRepoError);
  });

  it("A.25: NETWORK_ERROR during blob download propagates — never swallowed into a domain error", async () => {
    const remote = fi({ path: "n.md", sha: "sha-r", size: 3, mode: "" });
    const deps = makeDeps({
      getBlobFromRepo: async () => {
        throw new NetworkError("net down");
      },
    });
    await expect(
      _diff3(deps, t(side("n.md", "A"), remote), side("n.md", "L"), HEAD),
    ).rejects.toThrow(NetworkError);
  });

  it("A.26: a clean merge gets a fresh sha, is stored exactly once (skip when present), mtime=null", async () => {
    const base = side("n.md", "one\ntwo\nthree\n");
    const local = side("n.md", "ONE\ntwo\nthree\n");
    const remote = side("n.md", "one\ntwo\nTHREE\n");
    let saves = 0;
    const origSave = syncStore.saveBlobToSyncStore.bind(syncStore);
    syncStore.saveBlobToSyncStore = async (sha, bytes) => {
      saves += 1;
      return origSave(sha, bytes);
    };
    const r1 = await _diff3(makeDeps(), t(base, remote), local, HEAD);
    expect(r1.kind).toBe("file");
    const f = (r1 as { file: FileInfo }).file;
    expect(f.mtime).toBeNull();
    expect(f.sha).toBe(await calculateGitBlobSHA(f.blob!));
    expect(f.size).toBe(f.blob!.byteLength);
    expect(saves).toBe(1);
    // Second identical merge: the blob is already content-addressed
    // in the store — no second write.
    await _diff3(makeDeps(), t(base, remote), local, HEAD);
    expect(saves).toBe(1);
  });

  it("A.27: CRLF base, LF local + LF remote truly diverged → merge keeps LF (local's style)", async () => {
    const base = side("n.md", "one\r\ntwo\r\nthree\r\n");
    const local = side("n.md", "ONE\ntwo\nthree\n");
    const remote = side("n.md", "one\ntwo\nTHREE\n");
    const r = await _diff3(makeDeps(), t(base, remote), local, HEAD);
    expect(r.kind).toBe("file");
    const text = dec((r as { file: FileInfo }).file.blob!);
    expect(text).toBe("ONE\ntwo\nTHREE\n");
    expect(text).not.toContain("\r");
  });

  it("A.28: mirror — CRLF local, LF base/remote → merge keeps CRLF (local's style)", async () => {
    const base = side("n.md", "one\ntwo\nthree\n");
    const local = side("n.md", "ONE\r\ntwo\r\nthree\r\n");
    const remote = side("n.md", "one\ntwo\nTHREE\n");
    const r = await _diff3(makeDeps(), t(base, remote), local, HEAD);
    expect(r.kind).toBe("file");
    expect(dec((r as { file: FileInfo }).file.blob!)).toBe(
      "ONE\r\ntwo\r\nTHREE\r\n",
    );
  });

  it("A.29: local with MIXED line endings → dominant style wins (detectEol tie-break)", async () => {
    // local: 2×CRLF + 1×LF → CRLF dominant.
    const base = side("n.md", "one\ntwo\nthree\nfour\n");
    const local = side("n.md", "ONE\r\ntwo\r\nthree\nfour\n");
    const remote = side("n.md", "one\ntwo\nthree\nFOUR\n");
    const r = await _diff3(makeDeps(), t(base, remote), local, HEAD);
    expect(r.kind).toBe("file");
    expect(dec((r as { file: FileInfo }).file.blob!)).toBe(
      "ONE\r\ntwo\r\nthree\r\nFOUR\r\n",
    );
  });

  // ── A.1: the .obsidian/ + plugins/** branch ─────────────────────

  const OB = ".obsidian/app.json";
  const HK = ".obsidian/hotkeys.json";

  it("A1.1/A1.2: .obsidian, base=null, single side → that side; NO deps touched (never reaches the standard/merge machinery)", async () => {
    const local = side(OB, "L");
    const deps = makeDeps({
      mergeBlobs: async () => {
        throw new Error("A1.1: merge must not run");
      },
    });
    expect(await _diff3(deps, null, local, HEAD)).toEqual({
      kind: "file",
      file: local,
    });
    const remote = side(OB, "R");
    expect(
      await _diff3(deps, t(emptyFileInfo(), remote), null, HEAD),
    ).toEqual({ kind: "file", file: remote });
    expect(repoFetches).toEqual([]);
    expect(metaCalls).toEqual([]);
  });

  it("A1.3/A1.4: .obsidian, base=null, delete-vs-real → the LIVE side wins, mtime not consulted (3.b.1.c/d)", async () => {
    const remote = side(OB, "R");
    const r1 = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), remote),
      deletedSide(OB),
      HEAD,
    );
    expect(r1.kind).toBe("file");
    expect((r1 as { file: FileInfo }).file.sha).toBe(remote.sha);

    const local = side(OB, "L");
    const r2 = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), deletedSide(OB)),
      local,
      HEAD,
    );
    expect(r2).toEqual({ kind: "file", file: local });
  });

  it("A1.5/A1.6: .obsidian, base=null, both real and different → newer mtime wins, NO conflict (3.b.1.e — contrast to A.7)", async () => {
    const newer = side(OB, "L", { mtime: 2000 });
    const older = side(OB, "R", { mtime: 1000 });
    const r1 = await _diff3(makeDeps(), t(emptyFileInfo(), older), newer, HEAD);
    expect(r1).toEqual({ kind: "file", file: newer });

    const r2 = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), side(OB, "R2", { mtime: 3000 })),
      side(OB, "L2", { mtime: 1000 }),
      HEAD,
    );
    expect(r2.kind).toBe("file");
    expect((r2 as { file: FileInfo }).file.mtime).toBe(3000);
  });

  it("A1.7/A1.8: .obsidian, base=A, one side unchanged → the changed side wins (3.b.2.a/b)", async () => {
    const base = side(HK, "A");
    const local = side(HK, "B");
    // remote unchanged as remote==base
    const r1 = await _diff3(makeDeps(), t(base, side(HK, "A")), local, HEAD);
    expect(r1).toEqual({ kind: "file", file: local });
    // remote unchanged as remote=null
    const r2 = await _diff3(makeDeps(), t(base, emptyFileInfo()), local, HEAD);
    expect(r2).toEqual({ kind: "file", file: local });

    const remote = side(HK, "C");
    const r3 = await _diff3(makeDeps(), t(base, remote), side(HK, "A"), HEAD);
    expect(r3).toEqual({ kind: "file", file: remote });
    const r4 = await _diff3(makeDeps(), t(base, remote), null, HEAD);
    expect(r4).toEqual({ kind: "file", file: remote });
  });

  it("A1.9: STRONGEST contrast — .obsidian, base=A, local=deleted, remote edited → remote wins, NO conflict (3.b.2.c inverts 4.6.b)", async () => {
    const remote = side(HK, "edited");
    const r = await _diff3(
      makeDeps(),
      t(side(HK, "A"), remote),
      deletedSide(HK),
      HEAD,
    );
    expect(r).toEqual({ kind: "file", file: remote }); // A.16's shape → conflict OUTSIDE .obsidian
  });

  it("A1.10: mirror — remote=deleted, local edited → local wins (3.b.2.d)", async () => {
    const local = side(HK, "edited");
    const r = await _diff3(
      makeDeps(),
      t(side(HK, "A"), deletedSide(HK)),
      local,
      HEAD,
    );
    expect(r).toEqual({ kind: "file", file: local });
  });

  it("A1.11/A1.12: boundary — deletion with the OTHER side unchanged propagates QUIETLY via a/b, not the DELETED branch", async () => {
    const base = side(HK, "A");
    // local=deleted, remote==base → 3.b.2.a returns LOCAL (the deletion).
    const del = deletedSide(HK);
    const r1 = await _diff3(makeDeps(), t(base, side(HK, "A")), del, HEAD);
    expect(r1.kind).toBe("file");
    expect((r1 as { file: FileInfo }).file.mode).toBe(DELETED);
    // remote=deleted, local==base → 3.b.2.b returns REMOTE (the deletion).
    const r2 = await _diff3(
      makeDeps(),
      t(base, deletedSide(HK)),
      side(HK, "A"),
      HEAD,
    );
    expect(r2.kind).toBe("file");
    expect((r2 as { file: FileInfo }).file.mode).toBe(DELETED);
  });

  it("A1.13/A1.14: .obsidian, base=A, both changed differently → newer mtime wins, no diff3, no conflict (3.b.2.e)", async () => {
    const base = side(HK, "A");
    let merges = 0;
    const deps = makeDeps({
      mergeBlobs: async () => {
        merges += 1;
        return { kind: "conflict" };
      },
    });
    const newerLocal = side(HK, "B", { mtime: 2000 });
    const r1 = await _diff3(deps, t(base, side(HK, "C", { mtime: 1000 })), newerLocal, HEAD);
    expect(r1).toEqual({ kind: "file", file: newerLocal });

    const newerRemote = side(HK, "C", { mtime: 5000 });
    const r2 = await _diff3(deps, t(base, newerRemote), side(HK, "B", { mtime: 1000 }), HEAD);
    expect(r2).toEqual({ kind: "file", file: newerRemote });
    expect(merges).toBe(0);
  });

  it("A1.15/A1.16 (regression 2026-08-28): base=A with one side null and the other unchanged → base's value, no assert/fall-through", async () => {
    const base = side(OB, "A");
    // local=null, remote==base → 3.b.2.b returns remote (== base value).
    const remoteAsBase = side(OB, "A");
    const r1 = await _diff3(makeDeps(), t(base, remoteAsBase), null, HEAD);
    expect(r1.kind).toBe("file");
    expect((r1 as { file: FileInfo }).file.sha).toBe(base.sha);
    // local==base, remote=null → 3.b.2.a returns local (== base value).
    const r2 = await _diff3(
      makeDeps(),
      t(base, emptyFileInfo()),
      side(OB, "A"),
      HEAD,
    );
    expect(r2.kind).toBe("file");
    expect((r2 as { file: FileInfo }).file.sha).toBe(base.sha);
  });

  it("A1.17/A1.18: plugins/<id>/{manifest.json,main.js,styles.css} → plugin-dispatch stub, NOT mtime-tiebreak, NOT standard rules", async () => {
    for (const name of ["manifest.json", "main.js", "styles.css"]) {
      const p = `.obsidian/plugins/some-plugin/${name}`;
      const r = await _diff3(
        makeDeps(),
        t(side(p, "A"), side(p, "R", { mtime: 9000 })),
        side(p, "L", { mtime: 1 }),
        HEAD,
      );
      expect(r).toEqual({ kind: "plugin-dispatch" });
    }
  });

  it("gate fix 2026-08-31: a ONE-SIDED plugin-core change is ordinary 3.b traffic, NOT a dispatch (the wide seam made plugin files never sync — I2)", async () => {
    const p = ".obsidian/plugins/some-plugin/main.js";
    // New local plugin file, remote absent → local wins (3.b.1.a).
    const push = await _diff3(
      makeDeps(),
      null,
      side(p, "L", { mtime: 100 }),
      HEAD,
    );
    expect(push.kind).toBe("file");
    expect((push as { file: FileInfo }).file.sha).toBe(
      side(p, "L", {}).sha,
    );
    // Remote-only plugin update, local absent → remote wins (3.b.1.b).
    const pull = await _diff3(
      makeDeps(),
      t(side(p, "A"), side(p, "R", { mtime: 200 })),
      null,
      HEAD,
    );
    expect(pull.kind).toBe("file");
    expect((pull as { file: FileInfo }).file.sha).toBe(side(p, "R", {}).sha);
  });

  it("A1.19: plugins/<id>/data.json → NOT the plugin branch; resolves via mtime-tiebreak (3.b)", async () => {
    const p = ".obsidian/plugins/some-plugin/data.json";
    const newerRemote = side(p, "R", { mtime: 2000 });
    const r = await _diff3(
      makeDeps(),
      t(side(p, "A"), newerRemote),
      side(p, "L", { mtime: 1000 }),
      HEAD,
    );
    expect(r).toEqual({ kind: "file", file: newerRemote });
  });

  it("A1.20: the SAME input shapes as A1.5/A1.13 but OUTSIDE .obsidian → standard resolution (conflict / real diff3)", async () => {
    // Shape of A1.5 (base=null, both real, differing) outside .obsidian
    // → rule 4.2 MANUAL_CONFLICT, mtime ignored.
    const r1 = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), side("n.md", "R", { mtime: 1 })),
      side("n.md", "L", { mtime: 9000 }),
      HEAD,
    );
    expect(r1).toEqual({ kind: "manual-conflict" });

    // Shape of A1.13 (base=A, both changed) outside .obsidian → REAL
    // diff3 merge, never an mtime auto-win.
    const r2 = await _diff3(
      makeDeps(),
      t(
        side("n.md", "one\ntwo\nthree\n"),
        side("n.md", "one\ntwo\nTHREE\n", { mtime: 1 }),
      ),
      side("n.md", "ONE\ntwo\nthree\n", { mtime: 9000 }),
      HEAD,
    );
    expect(r2.kind).toBe("file");
    expect(dec((r2 as { file: FileInfo }).file.blob!)).toBe(
      "ONE\ntwo\nTHREE\n",
    );
  });

  it("A1 mtime fallback (owner rule, pure-function half of A.1 п.22/23): unknown mtime on EITHER side → remote wins", async () => {
    // remote.mtime null (§II.12 tree-fallback), local.mtime real: a
    // naive JS `local.mtime > remote.mtime` coerces null to 0 and
    // hands the win to local — the exact inversion of the owner's
    // "ambiguity → remote" rule. The explicit null guard is what this
    // test pins.
    const remoteNoMtime = side(OB, "R", { mtime: null });
    const r1 = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), remoteNoMtime),
      side(OB, "L", { mtime: 5000 }),
      HEAD,
    );
    expect(r1.kind).toBe("file");
    expect((r1 as { file: FileInfo }).file.sha).toBe(remoteNoMtime.sha);
    // local.mtime 0 (legacy batch / stat null fallback) → remote too.
    const remoteOld = side(OB, "R2", { mtime: 1 });
    const r2 = await _diff3(
      makeDeps(),
      t(emptyFileInfo(), remoteOld),
      side(OB, "L2", { mtime: 0 }),
      HEAD,
    );
    expect((r2 as { file: FileInfo }).file.sha).toBe(remoteOld.sha);
  });

  // ── P.20-22: rule 7's lazy remote.size ──────────────────────────

  it("P.20/P.21: remote.size=null with NO bytes anywhere → exactly ONE metadata call, rule 7 uses the FETCHED size", async () => {
    const base = side("n.md", "one\ntwo\nthree\n");
    const local = side("n.md", "ONE\ntwo\nthree\n");
    // No blob in hand and nothing in the store → the genuine gap.
    const remote = fi({
      path: "n.md",
      sha: "sha-remote",
      size: null,
      mode: "",
    });
    // Fetched size 200 > max 100 → conflict; the decision came from
    // the fetched size, not a guess.
    const deps = makeDeps({
      maxAutoMergeFileSize: () => 100,
      getContentsMetadataAtRef: async (p) => {
        metaCalls.push(p);
        return { sha: "sha-remote", size: 200 };
      },
    });
    expect(await _diff3(deps, t(base, remote), local, HEAD)).toEqual({
      kind: "manual-conflict",
    });
    expect(metaCalls).toEqual(["n.md"]);
  });

  it("P.20b (free size): bytes in hand OR a blob already in sync_store → rule 7 costs ZERO metadata calls", async () => {
    const base = side("n.md", "one\ntwo\nthree\n");
    const local = side("n.md", "ONE\ntwo\nthree\n");
    const remoteText = "one\ntwo\nTHREE\n";

    // (a) blob in hand.
    const withBlob = fi({
      path: "n.md",
      sha: "sha-remote",
      size: null,
      blob: enc(remoteText),
      mode: "",
    });
    const r1 = await _diff3(makeDeps(), t(base, withBlob), local, HEAD);
    expect(r1.kind).toBe("file");
    expect(metaCalls).toEqual([]); // no network for a size we hold

    // (b) no blob, but the store already has it (pull-folding, a
    // previous drain, a Layer-2 inline fetch).
    metaCalls = [];
    const storedSha = await calculateGitBlobSHA(enc(remoteText));
    await syncStore.saveBlobToSyncStore(storedSha, enc(remoteText));
    const fromStore = fi({
      path: "n.md",
      sha: storedSha,
      size: null,
      mode: "",
    });
    const r2 = await _diff3(makeDeps(), t(base, fromStore), local, HEAD);
    expect(r2.kind).toBe("file");
    expect(metaCalls).toEqual([]); // the store's stat answered it

    // (c) the gate still bites when the free size is over the limit —
    // the shortcut changes the SOURCE of the number, not the rule.
    metaCalls = [];
    const tight = makeDeps({ maxAutoMergeFileSize: () => 5 });
    const r3 = await _diff3(tight, t(base, { ...fromStore }), local, HEAD);
    expect(r3).toEqual({ kind: "manual-conflict" });
    expect(metaCalls).toEqual([]);
  });

  it("P.20a: the path vanished from remote between discovery and the size fetch → RemoteFileNotInRepoError", async () => {
    const remote = fi({ path: "n.md", sha: "sha-r", size: null, mode: "" });
    await expect(
      _diff3(
        makeDeps(), // getContentsMetadataAtRef → null
        t(side("n.md", "A"), remote),
        side("n.md", "L"),
        HEAD,
      ),
    ).rejects.toThrow(RemoteFileNotInRepoError);
  });

  it("P.22: remote.size already present (Layer 2 / tree-fallback filled it) → ZERO extra metadata calls", async () => {
    const base = side("n.md", "one\ntwo\nthree\n");
    const local = side("n.md", "ONE\ntwo\nthree\n");
    const remote = side("n.md", "one\ntwo\nTHREE\n"); // size set by side()
    const r = await _diff3(makeDeps(), t(base, remote), local, HEAD);
    expect(r.kind).toBe("file");
    expect(metaCalls).toEqual([]);
  });

  it("mergeBlobs seam: non-text extension → conflict; invalid-UTF-8 under a text extension → conflict (round-trip gate, never silent corruption)", async () => {
    expect(
      await mergeBlobsWithMainThreadDiff3("img.png", enc("a"), enc("b"), enc("c")),
    ).toEqual({ kind: "conflict" });
    // cp1251-style bytes under a text extension: 0xEF alone is not
    // valid UTF-8 — decode/encode would not round-trip.
    const bad = new Uint8Array([0xef, 0xe0, 0xe1]).buffer as ArrayBuffer;
    expect(
      await mergeBlobsWithMainThreadDiff3("data.csv", bad, enc("x\n"), enc("y\n")),
    ).toEqual({ kind: "conflict" });
  });
});
