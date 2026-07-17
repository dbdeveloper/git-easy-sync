import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import ConflictStore, {
  type ConflictRecord,
  type CreateArgs,
} from "../../src/sync2/conflict-store";
import {
  classify,
  evaluateConflictState,
} from "../../src/sync2/conflict-classifier";
import { Vault } from "../../mock-obsidian";

// Conflict-state classifier tests. See src/sync2/conflict-classifier.ts
// + docs/PSEUDO-MERGE-MODE.md §5 for the classifier's role.
//
// Two layers:
//   1. classify() — pure function tested with literal inputs against
//      each spec row.
//   2. evaluateConflictState() — orchestrator tested with a real
//      ConflictStore + fixture vault, covers cache hit / miss /
//      cascade / multi-sibling path-close.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

// Make a fake ConflictRecord at the type-system level — classify()
// doesn't read most fields; we just need a valid shape.
function rec(
  over: Partial<ConflictRecord> &
    Pick<ConflictRecord, "kind" | "oursBlobSha" | "theirsBlobSha">,
): ConflictRecord {
  return {
    id: "rec-1",
    vaultPath: "a.md",
    siblingPath: "a.conflict-from-Phone-2026-01-01T00-00-00Z.md",
    remoteDevice: "Phone",
    createdAt: 0,
    siblingMtime: 0,
    siblingSize: 0,
    siblingSha: "",
    baseMtime: null,
    baseSize: null,
    baseSha: null,
    branchBaseSha: null,
    lastEvaluated: 0,
    ...over,
  };
}

// ── Pure classify() — table-driven against the 11 spec rows ───────────

describe("classify (pure)", () => {
  // ─── Rows 1+2: !siblingExists → accept ours ─────────────────────────

  it("Row 1: !sibling, modify-vs-modify → accept-ours", () => {
    const d = classify(
      rec({ kind: "modify-vs-modify", oursBlobSha: "o", theirsBlobSha: "t" }),
      true,
      "o",
      5,
      false,
      null,
    );
    expect(d).toEqual({ type: "accept-ours" });
  });

  it("Row 1: !sibling, delete-vs-modify → accept-ours", () => {
    const d = classify(
      rec({ kind: "delete-vs-modify", oursBlobSha: null, theirsBlobSha: "t" }),
      false,
      null,
      null,
      false,
      null,
    );
    expect(d).toEqual({ type: "accept-ours" });
  });

  // ─── modify-vs-delete is no longer a registered kind — auto-
  // resolves at push time via attemptAutoMerge's "modify-wins"
  // branch. Former rows 2, 4, 10, 11, 12 dropped with the kind.

  // ─── Row 3 (!base + sibling) returns noop ──────────────────────────
  // The classifier returns noop when the base is deleted but a
  // sibling is still alive — the user must remove every sibling
  // for the path too (or rename one onto the base). Covered by
  // the test at the bottom of this describe block.

  // ─── Row 5: sibling, !base, delete-vs-modify → initial state, noop ─

  it("Row 5: sibling exists, base absent, delete-vs-modify → noop (initial)", () => {
    const d = classify(
      rec({ kind: "delete-vs-modify", oursBlobSha: null, theirsBlobSha: "t" }),
      false,
      null,
      null,
      true,
      "t",
    );
    expect(d).toEqual({ type: "noop" });
  });

  // ─── Row 6: SHA(base) === SHA(sibling) → accept-theirs ──────────────

  it("Row 6: base === sibling, modify-vs-modify → accept-theirs", () => {
    const d = classify(
      rec({ kind: "modify-vs-modify", oursBlobSha: "o", theirsBlobSha: "t" }),
      true,
      "same",
      5,
      true,
      "same",
    );
    expect(d).toEqual({ type: "accept-theirs" });
  });

  it("Row 6: base === sibling, delete-vs-modify → accept-theirs", () => {
    const d = classify(
      rec({ kind: "delete-vs-modify", oursBlobSha: null, theirsBlobSha: "t" }),
      true,
      "same",
      5,
      true,
      "same",
    );
    expect(d).toEqual({ type: "accept-theirs" });
  });

  // ─── Rows 7, 8: delete-vs-modify with custom base / modify-vs-modify
  //               with no-match → noop until siblings disappear ────────

  it("Row 7: sibling exists, base exists, base ≠ sibling, delete-vs-modify → noop", () => {
    const d = classify(
      rec({ kind: "delete-vs-modify", oursBlobSha: null, theirsBlobSha: "t" }),
      true,
      "custom",
      5,
      true,
      "t",
    );
    expect(d).toEqual({ type: "noop" });
  });

  it("Row 8: modify-vs-modify, base ≠ sibling AND base ≠ ours → noop (in-flight edit)", () => {
    const d = classify(
      rec({ kind: "modify-vs-modify", oursBlobSha: "o", theirsBlobSha: "t" }),
      true,
      "in-progress",
      5,
      true,
      "t",
    );
    expect(d).toEqual({ type: "noop" });
  });

  it("Row 9: modify-vs-modify, base === ours (initial state) → noop", () => {
    const d = classify(
      rec({ kind: "modify-vs-modify", oursBlobSha: "o", theirsBlobSha: "t" }),
      true,
      "o",
      5,
      true,
      "t",
    );
    expect(d).toEqual({ type: "noop" });
  });

  // ─── Row 3 noop pin ────────────────────────────────────────────────
  //
  // `!baseExists + modify-vs-modify` returns noop: the engine never
  // cascade-deletes siblings on bare base-deletion. The user must
  // remove every sibling for the path too. This is what enables the
  // mobile delete-then-rename workflow (see
  // docs/PSEUDO-MERGE-MODE.md §6.2).
  it("Row 3 sibling exists, !base, modify-vs-modify → noop (NOT delete-wins-cascade)", () => {
    const d = classify(
      rec({ kind: "modify-vs-modify", oursBlobSha: "o", theirsBlobSha: "t" }),
      false, // baseExists
      null,  // baseSha
      null,  // baseSize
      true,  // siblingExists
      "t",   // siblingSha
    );
    expect(d).toEqual({ type: "noop" });
  });

});

// ── Orchestrator tests with a real store + fixture vault ──────────────

function fixture(): {
  root: string;
  vault: Vault;
  store: ConflictStore;
  conflictsRoot: string;
  clock: { tick: () => number; set: (ms: number) => void };
  idSeq: { next: () => string };
} {
  const root = path.join(
    os.tmpdir(),
    `conflict-classifier-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let currentMs = Date.UTC(2026, 4, 8, 15, 30, 0, 0);
  const clock = {
    tick: () => {
      const t = currentMs;
      currentMs += 1000;
      return t;
    },
    set: (ms: number) => {
      currentMs = ms;
    },
  };
  let counter = 0;
  const idSeq = {
    next: () => `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`,
  };
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
    idFactory: () => idSeq.next(),
  });
  return {
    root,
    vault,
    store,
    conflictsRoot: path.join(
      root,
      CONFIG_DIR,
      "plugins",
      SELF_PLUGIN_ID,
      ".runtime/conflicts",
    ),
    clock,
    idSeq,
  };
}

function arr(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer.slice(0) as ArrayBuffer;
}

function writeVaultFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("evaluateConflictState (orchestrator)", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  async function createBaseConflict(
    over: Partial<CreateArgs> = {},
  ): Promise<ConflictRecord> {
    await f.store.load();
    return f.store.create({
      vaultPath: "Notes/note.md",
      kind: "modify-vs-modify",
      theirsContent: arr("theirs-content\n"),
      theirsBlobSha: "theirs-sha-1",
      oursBlobSha: "ours-sha-1",
      baseMtime: null,
      baseSize: null,
      baseSha: null,
      remoteDevice: "Phone",
      ...over,
    });
  }

  // ─── Resolution cases ───────────────────────────────────────────────

  it("user deletes sibling (case 1) → record dropped, path resolved", async () => {
    writeVaultFile(f.root, "Notes/note.md", "ours-content\n");
    const rec = await createBaseConflict();
    // User opens file explorer, deletes sibling.
    fs.unlinkSync(path.join(f.root, rec.siblingPath));

    const result = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 100);

    expect(result.recordsRemoved).toEqual([rec.id]);
    expect([...result.pathsResolved]).toEqual(["Notes/note.md"]);
    expect(f.store.get(rec.id)).toBeUndefined();
    // recordDir gone:
    expect(fs.existsSync(path.join(f.conflictsRoot, rec.id))).toBe(false);
  });

  it("user copies sibling onto base (case 6) → record + vault sibling dropped, path resolved", async () => {
    writeVaultFile(f.root, "Notes/note.md", "ours-content\n");
    const rec = await createBaseConflict();
    // User copies sibling content onto base — base now bit-equal to
    // theirs.
    fs.copyFileSync(
      path.join(f.root, rec.siblingPath),
      path.join(f.root, "Notes/note.md"),
    );

    const result = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 100);

    expect(result.recordsRemoved).toEqual([rec.id]);
    expect([...result.pathsResolved]).toEqual(["Notes/note.md"]);
    // Vault sibling removed as part of accept-theirs.
    expect(fs.existsSync(path.join(f.root, rec.siblingPath))).toBe(false);
    // Base still has the (now-converged) content.
    expect(
      fs.readFileSync(path.join(f.root, "Notes/note.md"), "utf8"),
    ).toBe("theirs-content\n");
  });

  it("user deletes base on modify-vs-modify → noop, records + siblings stay", async () => {
    // Orchestrator-level pin: the engine does NOT cascade-delete
    // siblings when the user removes the base file. The user must
    // explicitly resolve EACH sibling (delete it or rename it onto
    // base). The pure-classifier pin for the same rule is in the
    // `classify (pure)` describe block above.
    writeVaultFile(f.root, "Notes/note.md", "ours\n");
    const a = await createBaseConflict({ theirsBlobSha: "sha-A" });
    const b = await createBaseConflict({
      theirsBlobSha: "sha-B",
      theirsContent: arr("from-B\n"),
      remoteDevice: "Laptop",
    });
    // User deletes the base file. Both sibling files still on disk.
    fs.unlinkSync(path.join(f.root, "Notes/note.md"));

    const result = await evaluateConflictState(
      f.store,
      f.vault as unknown as import("obsidian").Vault,
      () => 100,
    );

    // No cascade. Records stay; siblings stay; path NOT resolved.
    expect(result.recordsRemoved).toEqual([]);
    expect(result.pathsResolved.size).toBe(0);
    expect(fs.existsSync(path.join(f.root, a.siblingPath))).toBe(true);
    expect(fs.existsSync(path.join(f.root, b.siblingPath))).toBe(true);
    expect(f.store.getAll().length).toBe(2);
  });

  // modify-vs-delete is no longer a registered conflict kind —
  // attemptAutoMerge resolves it at push time via "modify-wins" so
  // the classifier never sees this kind. Tests for former cases 4
  // (confirm-remote-delete) and 11 (intentional-delete) dropped.

  // ─── No-op cases: cache refresh + cache hit ─────────────────────────

  it("initial state (base === ours, sibling intact) → noop + lastEvaluated bumped", async () => {
    writeVaultFile(f.root, "Notes/note.md", "ours-content\n");
    const rec = await createBaseConflict({
      oursBlobSha: "ours-sha-1",
    });
    // Update base cache fields to match a fresh stat (so the
    // classifier's baseSha-from-cache branch fires).
    const baseStat = fs.statSync(path.join(f.root, "Notes/note.md"));
    await f.store.updateCache(rec.id, {
      baseMtime: baseStat.mtimeMs,
      baseSize: baseStat.size,
      baseSha: "ours-sha-1",
    });

    const result = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 12345);

    expect(result.recordsRemoved).toEqual([]);
    expect(result.pathsResolved.size).toBe(0);
    // record still indexed.
    const survivor = f.store.get(rec.id)!;
    expect(survivor.lastEvaluated).toBe(12345);
  });

  it("sibling mtime+size unchanged → cache hit, no read+hash, no refreshed entry", async () => {
    writeVaultFile(f.root, "Notes/note.md", "ours\n");
    const rec = await createBaseConflict();
    // Sibling was just created → cache reflects current state.

    const result = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 100);

    expect(result.recordsRefreshed).toEqual([]);
  });

  it("sibling touched (mtime changed) → recordsRefreshed includes id, cache updated on disk", async () => {
    writeVaultFile(f.root, "Notes/note.md", "ours\n");
    const rec = await createBaseConflict();
    // Mutate sibling content directly on disk. mtime + size change,
    // SHA changes too.
    const siblingAbs = path.join(f.root, rec.siblingPath);
    fs.writeFileSync(siblingAbs, "edited by user\n");
    const newStat = fs.statSync(siblingAbs);

    const result = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 200);

    expect(result.recordsRefreshed).toEqual([rec.id]);
    const updated = f.store.get(rec.id)!;
    expect(updated.siblingMtime).toBe(newStat.mtimeMs);
    expect(updated.siblingSize).toBe(newStat.size);
    expect(updated.siblingSha).not.toBe(""); // fresh hash computed
    // Persisted on disk:
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(f.conflictsRoot, rec.id, "meta.json"),
        "utf8",
      ),
    ) as ConflictRecord;
    expect(onDisk.siblingSha).toBe(updated.siblingSha);
    expect(onDisk.lastEvaluated).toBe(200);
  });

  // ─── Multi-sibling on same path ─────────────────────────────────────

  it("multi-sibling: resolving one keeps the other; path NOT resolved until both go", async () => {
    writeVaultFile(f.root, "Notes/note.md", "ours\n");
    const a = await createBaseConflict({
      theirsBlobSha: "sha-A",
      remoteDevice: "Laptop",
    });
    const b = await createBaseConflict({
      theirsBlobSha: "sha-B",
      theirsContent: arr("from-B\n"),
      remoteDevice: "Phone",
    });
    // User deletes only A's sibling.
    fs.unlinkSync(path.join(f.root, a.siblingPath));

    const r1 = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 100);

    expect(r1.recordsRemoved).toEqual([a.id]);
    // Path NOT closed — B still active.
    expect(r1.pathsResolved.size).toBe(0);
    expect(f.store.get(b.id)).toBeDefined();

    // Now user deletes B too.
    fs.unlinkSync(path.join(f.root, b.siblingPath));
    const r2 = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 200);
    expect(r2.recordsRemoved).toEqual([b.id]);
    expect([...r2.pathsResolved]).toEqual(["Notes/note.md"]);
    expect(f.store.getAll().length).toBe(0);
  });

  // ─── Sweep doesn't choke on cross-path independence ─────────────────

  it("multi-path: each path classified independently", async () => {
    writeVaultFile(f.root, "a.md", "ours-a\n");
    writeVaultFile(f.root, "b.md", "ours-b\n");
    const ra = await f.store.create({
      vaultPath: "a.md",
      kind: "modify-vs-modify",
      theirsContent: arr("theirs-a\n"),
      theirsBlobSha: "ta",
      oursBlobSha: "oa",
      baseMtime: null,
      baseSize: null,
      baseSha: null,
      remoteDevice: "Phone",
    });
    const rb = await f.store.create({
      vaultPath: "b.md",
      kind: "modify-vs-modify",
      theirsContent: arr("theirs-b\n"),
      theirsBlobSha: "tb",
      oursBlobSha: "ob",
      baseMtime: null,
      baseSize: null,
      baseSha: null,
      remoteDevice: "Phone",
    });
    // User deletes sibling for a.md ONLY. b.md untouched.
    fs.unlinkSync(path.join(f.root, ra.siblingPath));

    const result = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 100);

    expect(result.recordsRemoved).toEqual([ra.id]);
    expect([...result.pathsResolved]).toEqual(["a.md"]);
    expect(f.store.get(rb.id)).toBeDefined();
  });

  // ─── Idempotency: running twice with no changes → second is silent ──

  it("re-running on already-resolved state is a no-op", async () => {
    writeVaultFile(f.root, "Notes/note.md", "ours\n");
    const rec = await createBaseConflict();
    fs.unlinkSync(path.join(f.root, rec.siblingPath));

    const first = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 100);
    expect(first.recordsRemoved).toEqual([rec.id]);

    const second = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 200);
    expect(second.recordsRemoved).toEqual([]);
    expect(second.pathsResolved.size).toBe(0);
    expect(second.recordsRefreshed).toEqual([]);
  });

  // ─── Empty store ────────────────────────────────────────────────────

  it("empty store → empty result, no I/O failures", async () => {
    await f.store.load();
    const result = await evaluateConflictState(f.store, f.vault as unknown as import("obsidian").Vault, () => 100);
    expect(result.recordsRemoved).toEqual([]);
    expect(result.pathsResolved.size).toBe(0);
    expect(result.recordsRefreshed).toEqual([]);
  });

  // Pull-side coincidental SHA match: a pull-side conflict
  // registers a sibling whose SHA happens to equal the current base
  // SHA (e.g., remote was reverted on another device to match
  // local). The next drain Phase A SHA-match cleanup auto-resolves
  // with NO user action — mechanically identical to the user-driven
  // case 6 above, but framed as a pull-side entry point.
  it("pull-side coincidental SHA match → next sweep auto-cleans (no user action)", async () => {
    writeVaultFile(f.root, "Notes/note.md", "shared content\n");
    // Mimic pull-side conflict registration where theirsContent
    // happens to equal current base content (e.g., remote was
    // reverted on another device to match local).
    const rec = await createBaseConflict({
      theirsContent: arr("shared content\n"),
      theirsBlobSha: "shared-sha",
    });
    // Initial state from create(): siblingSha is computed from
    // theirsContent. baseSha is null in the record (create
    // doesn't compute it; evaluator does on demand). On the first
    // evaluator pass, the per-path lazy baseSha computation
    // matches siblingSha → Phase A SHA-match cleanup fires.
    expect(rec.siblingSha).toBeTruthy();
    expect(
      fs.existsSync(path.join(f.root, rec.siblingPath)),
    ).toBe(true);

    const result = await evaluateConflictState(
      f.store,
      f.vault as unknown as import("obsidian").Vault,
      () => 200,
    );

    // Phase A removed sibling + dropped record; Phase B closed
    // path. Zero user action required.
    expect(result.recordsRemoved).toEqual([rec.id]);
    expect([...result.pathsResolved]).toEqual(["Notes/note.md"]);
    expect(
      fs.existsSync(path.join(f.root, rec.siblingPath)),
    ).toBe(false);
    // Base file untouched.
    expect(
      fs.readFileSync(path.join(f.root, "Notes/note.md"), "utf8"),
    ).toBe("shared content\n");
    expect(f.store.getAll().length).toBe(0);
  });
});
