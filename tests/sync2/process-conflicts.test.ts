import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import ConflictStoreV2, {
  ConflictsState,
  emptyConflictsState,
} from "../../src/sync2/conflict-store-v2";
import { processConflicts } from "../../src/sync2/process-conflicts";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { FileInfo, emptyFileInfo } from "../../src/sync2/diff3";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII category I — process_conflicts() dedup TRACKED vs SYNTHETIC
// (§III п.2.1-2.4), over a real fs-backed mock vault + the real
// ConflictStoreV2.

const PLUGIN_ID = "git-easy-sync";

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
const sha = (s: string): Promise<string> => calculateGitBlobSHA(enc(s));

describe("process_conflicts (§VIII I)", () => {
  let dir: string;
  let vault: Vault;
  let store: ConflictStoreV2;
  let saves: number;

  const deps = () => ({
    vault: vault as never,
    store,
    computeSha: calculateGitBlobSHA,
  });

  const putFile = (p: string, content: string): void => {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  // A tracked sibling: FileInfo in the list + its derived file on disk.
  const tracked = async (
    basePath: string,
    content: string,
    mtime: number,
    label = "phone",
    onDisk = true,
  ): Promise<FileInfo> => {
    const f: FileInfo = {
      ...emptyFileInfo(),
      path: basePath,
      sha: await sha(content),
      size: content.length,
      mtime,
      deviceLabel: label,
      mode: "",
    };
    if (onDisk) {
      putFile(buildSiblingFilePath(basePath, mtime, label), content);
    }
    return f;
  };

  const entry = (
    state: ConflictsState,
    basePath: string,
    siblings: FileInfo[],
  ): void => {
    state.entries.set(basePath, {
      conflictBase: {
        ...emptyFileInfo(),
        path: basePath,
        sha: "cb-sha-immutable",
      },
      siblings,
    });
  };

  const siblingExists = (
    basePath: string,
    mtime: number,
    label = "phone",
  ): boolean =>
    fs.existsSync(path.join(dir, buildSiblingFilePath(basePath, mtime, label)));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "proc-conf-test-"));
    vault = new Vault(dir);
    store = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    saves = 0;
    const origSave = store.save.bind(store);
    store.save = async (s) => {
      saves += 1;
      return origSave(s);
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("I.1: tracked and synthetic with the SAME sha in one group → tracked always wins, the synthetic file is deleted", async () => {
    putFile("note.md", "base\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "dup content\n", 2000);
    entry(state, "note.md", [t]);
    // Synthetic twin: same content, sibling-shaped name the engine
    // never created (different label/timestamp) — and NEWER, so a
    // naive newest-wins would wrongly kill the tracked one.
    putFile(
      buildSiblingFilePath("note.md", 9000, "stranger"),
      "dup content\n",
    );

    const result = await processConflicts(deps(), state);
    expect(result.entries.get("note.md")!.siblings).toEqual([t]);
    expect(siblingExists("note.md", 2000)).toBe(true); // tracked survived
    expect(siblingExists("note.md", 9000, "stranger")).toBe(false);
  });

  it("I.2: several tracked duplicates → the NEWEST survives; the rest leave both the disk and the list", async () => {
    putFile("note.md", "base\n");
    const state = emptyConflictsState();
    const older = await tracked("note.md", "same\n", 1000);
    const newer = await tracked("note.md", "same\n", 5000);
    entry(state, "note.md", [older, newer]);

    const result = await processConflicts(deps(), state);
    expect(result.entries.get("note.md")!.siblings).toEqual([newer]);
    expect(siblingExists("note.md", 1000)).toBe(false);
    expect(siblingExists("note.md", 5000)).toBe(true);
  });

  it("I.3: synthetic-only duplicate group → newest by timestamp survives", async () => {
    putFile("note.md", "base\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "tracked content\n", 100);
    entry(state, "note.md", [t]);
    putFile(buildSiblingFilePath("note.md", 3000, "a"), "syn dup\n");
    putFile(buildSiblingFilePath("note.md", 7000, "b"), "syn dup\n");
    // fs mtime drives newestByTimestamp for synthetics — set explicitly.
    fs.utimesSync(
      path.join(dir, buildSiblingFilePath("note.md", 3000, "a")),
      3,
      3,
    );
    fs.utimesSync(
      path.join(dir, buildSiblingFilePath("note.md", 7000, "b")),
      7,
      7,
    );

    await processConflicts(deps(), state);
    expect(siblingExists("note.md", 3000, "a")).toBe(false);
    expect(siblingExists("note.md", 7000, "b")).toBe(true);
  });

  it("I.4: sibling sha == base sha → auto-resolve, IDENTICALLY for tracked and synthetic; prune on the transition", async () => {
    putFile("note.md", "reconciled\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "reconciled\n", 2000);
    entry(state, "note.md", [t]);
    putFile(
      buildSiblingFilePath("note.md", 8000, "other"),
      "reconciled\n",
    );

    const result = await processConflicts(deps(), state);
    expect(result.entries.has("note.md")).toBe(false); // non-empty → empty = prune
    expect(siblingExists("note.md", 2000)).toBe(false);
    expect(siblingExists("note.md", 8000, "other")).toBe(false);
  });

  it("I.5: base+sibling moved away (both files gone from the old path) → the old record prunes cleanly; the new-path synthetic pair belongs to the diff2 scan (Phase 5.5)", async () => {
    // No files created at all — the user moved them elsewhere.
    const state = emptyConflictsState();
    const t: FileInfo = {
      ...emptyFileInfo(),
      path: "old/place.md",
      sha: "sha-x",
      mtime: 100,
      deviceLabel: "phone",
    };
    entry(state, "old/place.md", [t]);

    const result = await processConflicts(deps(), state);
    expect(result.entries.has("old/place.md")).toBe(false);
  });

  it("I.6: a tracked sibling the user deleted by hand → leaves the list, nothing else happens", async () => {
    putFile("note.md", "base\n");
    const state = emptyConflictsState();
    const gone = await tracked("note.md", "was here\n", 1000, "phone", false);
    const stays = await tracked("note.md", "still here\n", 2000);
    entry(state, "note.md", [gone, stays]);

    const result = await processConflicts(deps(), state);
    expect(result.entries.get("note.md")!.siblings).toEqual([stays]);
    expect(siblingExists("note.md", 2000)).toBe(true);
  });

  it("I.7: entry with an EMPTY siblings list on entry survives (STEP1→STEP3 transient) — deletion is a TRANSITION only", async () => {
    const state = emptyConflictsState();
    entry(state, "fresh.md", []); // fresh STEP1 record
    const result = await processConflicts(deps(), state);
    expect(result.entries.has("fresh.md")).toBe(true); // still blocks FINALIZE
    expect(saves).toBe(0); // nothing changed → no disk write
  });

  it("I.8: ambient EMPTY state ≠ null — a just-cancelled record must NOT resurrect from the durable copy", async () => {
    // Durable copy still holds a record…
    const durable = emptyConflictsState();
    entry(durable, "cancelled.md", [
      await tracked("cancelled.md", "x\n", 100),
    ]);
    await store.save(durable);
    saves = 0;
    // …but the caller has ALREADY cancelled it in the ambient state.
    const ambient = emptyConflictsState();
    const result = await processConflicts(deps(), ambient);
    expect(result.entries.size).toBe(0); // NOT reloaded from disk

    // And null DOES mean "load the durable copy".
    const fromNull = await processConflicts(deps(), null);
    expect(fromNull.entries.has("cancelled.md")).toBe(true);
  });

  it("I.9: the same contract at every call — a second pass over the same state is a no-op (idempotent, zero extra saves)", async () => {
    putFile("note.md", "base\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "sibling content\n", 2000);
    entry(state, "note.md", [t]);

    const first = await processConflicts(deps(), state);
    const savesAfterFirst = saves;
    const second = await processConflicts(deps(), first);
    expect(second.entries.get("note.md")!.siblings).toEqual([t]);
    expect(saves).toBe(savesAfterFirst); // no state change → no save
  });

  it("conflictBase passes through VERBATIM — the reconciler never rewrites the network-borne half", async () => {
    putFile("note.md", "base\n");
    const state = emptyConflictsState();
    const gone = await tracked("note.md", "a\n", 100, "phone", false);
    const stays = await tracked("note.md", "b\n", 200);
    entry(state, "note.md", [gone, stays]);
    const originalBase = state.entries.get("note.md")!.conflictBase;

    const result = await processConflicts(deps(), state);
    expect(result.entries.get("note.md")!.conflictBase).toBe(originalBase);
  });

  // ── confirmResolved prune seam (Phase 5.5 step 3d, R3.5 layer 1b) ──

  it("I.10: confirmResolved fires EXACTLY once, on the non-empty→empty prune transition, with the base path", async () => {
    const resolved: string[] = [];
    const hookDeps = () => ({
      ...deps(),
      trashHooks: {
        confirmResolved: async (p: string) => {
          resolved.push(p);
        },
      },
    });
    const state = emptyConflictsState();
    putFile("note.md", "same\n");
    // Sibling content == base content → auto-resolve → prune.
    entry(state, "note.md", [await tracked("note.md", "same\n", 100)]);
    // A second, still-live conflict must NOT fire.
    putFile("live.md", "base\n");
    entry(state, "live.md", [await tracked("live.md", "other\n", 200)]);

    const r1 = await processConflicts(hookDeps(), state);
    expect(resolved).toEqual(["note.md"]); // once, prune only
    expect(r1.entries.has("live.md")).toBe(true);

    // Second pass over the SAME state: the entry is gone — no re-fire.
    await processConflicts(hookDeps(), r1);
    expect(resolved).toEqual(["note.md"]);
  });

  it("I.11: a THROWING confirmResolved hook warns and never blocks — the prune still happens", async () => {
    const warns: string[] = [];
    const state = emptyConflictsState();
    putFile("note.md", "same\n");
    entry(state, "note.md", [await tracked("note.md", "same\n", 100)]);

    const r = await processConflicts(
      {
        ...deps(),
        trashHooks: {
          confirmResolved: async () => {
            throw new Error("trash exploded");
          },
        },
        logger: { info: () => {}, warn: (m: string) => warns.push(m) },
      },
      state,
    );
    expect(r.entries.has("note.md")).toBe(false); // pruned anyway
    expect(warns.some((w) => w.includes("confirmResolved"))).toBe(true);
  });

  it("I.12: an EMPTY-on-entry siblings list prunes NOTHING and fires NOTHING (I.7 transient stays a transient)", async () => {
    const resolved: string[] = [];
    const state = emptyConflictsState();
    entry(state, "fresh.md", []); // STEP1 ran, STEP3 hasn't
    const r = await processConflicts(
      {
        ...deps(),
        trashHooks: {
          confirmResolved: async (p: string) => {
            resolved.push(p);
          },
        },
      },
      state,
    );
    expect(r.entries.has("fresh.md")).toBe(true);
    expect(resolved).toEqual([]);
  });
});
