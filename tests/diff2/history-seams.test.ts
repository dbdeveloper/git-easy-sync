// Phase 7 §4.7 stage 7a.1 — the four History seams, all DEFAULT-OFF (the
// conflict path stays byte-identical; the full existing suite is that proof).
// Contract A (recovery-guardrail): classifyReopen(ignoreBase) reads base from
// the immutable snapshot. Contract B (read-only base): startSession(readOnlyBase)
// materializes base from passed bytes, never from vault — History has no vault
// file for "version V", and basePath===siblingPath===currentFile.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../../src/utils";
import { buildModel, serializeModel } from "../../src/diff2/diff-model";
import {
  classifyReopen,
  startSession,
  readMeta,
  autosaveDir,
  deriveAutosaveId,
} from "../../src/diff2/autosave-store";
import {
  planBackNav,
  persistedEditorState,
  ephemeralAutosaveIdFromState,
  type EditorTabState,
} from "../../src/diff2/editor-tabs";
import { autosaveIdForEntry, type ConflictEntry } from "../../src/diff2/synthetic-detector";
import { historyDeletedOrphans } from "../../src/diff2/history-deleted-lifecycle";

const NOW = "2026-07-03T12:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `history-seams-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

// ── Seam 1: deriveAutosaveId += "history" kind ───────────────────────────────
describe("deriveAutosaveId — history kind", () => {
  const CF = "Folder/note.md";

  it("accepts the 'history' kind and prefixes the id", () => {
    expect(deriveAutosaveId("history", CF, CF)).toMatch(/^history-/);
  });

  // §4.5.2 (A1) — History is keyed PER-FILE (currentFile passed twice); the id is
  // stable/deterministic per file. (Per-version keying was DROPPED — see
  // autosaveIdForEntry.)
  it("per-file: same currentFile → same id (deterministic)", () => {
    expect(deriveAutosaveId("history", CF, CF)).toBe(
      deriveAutosaveId("history", CF, CF),
    );
  });

  it("history id is distinct from a same-file synthetic id (kind prefix)", () => {
    expect(deriveAutosaveId("history", CF, CF)).not.toBe(
      deriveAutosaveId("synthetic", CF, CF),
    );
  });
});

// ── Seam 2 (Contract B): startSession(readOnlyBase) ──────────────────────────
describe("startSession — readOnlyBase (Contract B)", () => {
  let fx: ReturnType<typeof fixture>;
  const id = "history-cb";
  const CF = "note.md"; // basePath === siblingPath === currentFile
  const OLD = "old version\n"; // the historical version (read-only base)
  const CUR = "current content\n"; // what the vault file holds NOW (sibling)

  beforeEach(async () => {
    fx = fixture();
    await fx.vault.adapter.writeBinary(CF, enc(CUR));
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("base comes from readOnlyBase.bytes, NOT the vault file at basePath", async () => {
    const meta = await startSession(fx.vault, id, CF, CF, NOW, { bytes: enc(OLD) });
    // base SHA = SHA(OLD), sibling SHA = SHA(CUR) — the vault file fed only the sibling.
    expect(meta.baseShaAtStart).toBe(await calculateGitBlobSHA(enc(OLD)));
    expect(meta.siblingShaAtStart).toBe(await calculateGitBlobSHA(enc(CUR)));
    // basePath === siblingPath is NOT degenerate — both are the current file.
    expect(meta.basePath).toBe(CF);
    expect(meta.siblingPath).toBe(CF);
    // baseExistedAtStart: a history version always "existed" (History never deletes).
    expect(meta.baseExistedAtStart).toBe(true);
  });

  it("base.snapshot holds the version bytes; sibling.snapshot holds the vault bytes", async () => {
    await startSession(fx.vault, id, CF, CF, NOW, { bytes: enc(OLD) });
    const dir = autosaveDir(id);
    const baseSnap = await fx.vault.adapter.readBinary(`${dir}/base.snapshot`);
    const sibSnap = await fx.vault.adapter.readBinary(`${dir}/sibling.snapshot`);
    expect(Buffer.from(baseSnap).toString()).toBe(OLD);
    expect(Buffer.from(sibSnap).toString()).toBe(CUR);
    // snapshot-integrity contract: meta SHAs are the snapshot bytes' SHAs (recomputed,
    // never a trusted caller sha) — else every reopen classifies corrupt→fresh.
    const meta = (await readMeta(fx.vault, id))!;
    expect(meta.baseShaAtStart).toBe(await calculateGitBlobSHA(baseSnap));
  });

  it("joinedDocSha is (version, currentFile), reproducible from snapshots", async () => {
    const meta = await startSession(fx.vault, id, CF, CF, NOW, { bytes: enc(OLD) });
    expect(meta.joinedDocSha).toBe(
      await calculateGitBlobSHA(enc(serializeModel(buildModel(OLD, CUR)))),
    );
  });
});

// ── Seam 3 (Contract A) — the RECOVERY SPIKE: classifyReopen(ignoreBase) ──────
describe("classifyReopen — ignoreBase (Contract A recovery-spike)", () => {
  let fx: ReturnType<typeof fixture>;
  const id = "history-ca";
  const CF = "note.md";
  const OLD = "old version\n";
  const CUR = "current content\n";

  beforeEach(async () => {
    fx = fixture();
    await fx.vault.adapter.writeBinary(CF, enc(CUR));
    // A History session: base = the version (read-only), sibling = the vault file.
    await startSession(fx.vault, id, CF, CF, NOW, { bytes: enc(OLD) });
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("ignoreBase=true, sibling unchanged → resume (base from snapshot)", async () => {
    expect((await classifyReopen(fx.vault, id, CF, CF, true)).kind).toBe("resume");
  });

  // This is what proves ignoreBase is LOAD-BEARING: with ignoreBase=false the base
  // is read from the VAULT (= currentFile = CUR, the sibling side, NOT the version)
  // → wrong joined fingerprint → misclassified vault-changed even though nothing changed.
  it("ignoreBase=false on a History session → MISCLASSIFIES as vault-changed", async () => {
    expect((await classifyReopen(fx.vault, id, CF, CF, false)).kind).toBe(
      "vault-changed",
    );
  });

  it("ignoreBase=true, current file mutated → vault-changed (sibling changed; base stays immune)", async () => {
    await fx.vault.adapter.writeBinary(CF, enc("current content v2\n"));
    const status = await classifyReopen(fx.vault, id, CF, CF, true);
    expect(status.kind).toBe("vault-changed");
    if (status.kind === "vault-changed") {
      // base side unaffected by the vault mutation — it came from the snapshot.
      expect(status.currentBaseSha).toBe(await calculateGitBlobSHA(enc(OLD)));
      expect(status.currentSiblingSha).toBe(
        await calculateGitBlobSHA(enc("current content v2\n")),
      );
    }
  });
});

// ── Conflict byte-identity echo (default-off) ────────────────────────────────
describe("classifyReopen/startSession — conflict path unchanged (default-off)", () => {
  let fx: ReturnType<typeof fixture>;
  const id = "tracked-echo";

  beforeEach(async () => {
    fx = fixture();
    await fx.vault.adapter.writeBinary("base.md", enc("base\n"));
    await fx.vault.adapter.writeBinary("sibling.md", enc("sib\n"));
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("no readOnlyBase / no ignoreBase → a normal conflict still resumes unchanged", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    expect((await classifyReopen(fx.vault, id, "base.md", "sibling.md")).kind).toBe(
      "resume",
    );
  });
});

// ── 7a.3: autosaveIdForEntry for a history entry (the version-discriminator GATE) ──
describe("autosaveIdForEntry — history entry", () => {
  const histEntry = (path: string, sha: string): ConflictEntry => ({
    basePath: path,
    siblingPath: path, // history: base===sibling===currentFile
    deviceLabel: "phone",
    isoTimestamp: "2026-07-03T00-00-00Z",
    kind: "synthetic",
    historyVersionSha: sha,
  });

  // §4.5.2 (A1) — PER-FILE keying: two versions of ONE file share ONE session id
  // (opening another version lands on the same session → the "file busy" open-guard).
  it("keys PER-FILE — two versions of one file → SAME id", () => {
    expect(autosaveIdForEntry(histEntry("F.md", "sha1"))).toBe(
      autosaveIdForEntry(histEntry("F.md", "sha2")),
    );
  });

  it("different files → different ids", () => {
    expect(autosaveIdForEntry(histEntry("A.md", "sha1"))).not.toBe(
      autosaveIdForEntry(histEntry("B.md", "sha1")),
    );
  });

  it("history id is distinct from a same-file synthetic conflict id (no sha)", () => {
    const hist = autosaveIdForEntry(histEntry("F.md", "sha1"));
    const synthetic = autosaveIdForEntry({
      basePath: "F.md",
      siblingPath: "F.md",
      deviceLabel: "phone",
      isoTimestamp: "2026-07-03T00-00-00Z",
      kind: "synthetic",
    });
    expect(hist).not.toBe(synthetic);
    expect(hist).toMatch(/^history-/);
  });
});

// ── 7a.3: persistedEditorState keeps historyVersion, drops openMode ──────────
describe("persistedEditorState — history", () => {
  it("persists historyVersion (survives restart → re-fetch) but strips openMode", () => {
    const state: EditorTabState = {
      origin: "history",
      basePath: "F.md",
      siblingPath: "F.md",
      openMode: "user",
      historyVersion: { local: false, date: 123, id: "sha1", deviceLabel: "phone" },
    };
    expect(persistedEditorState(state)).toEqual({
      origin: "history",
      basePath: "F.md",
      siblingPath: "F.md",
      historyVersion: { local: false, date: 123, id: "sha1", deviceLabel: "phone" },
    });
  });

  it("a conflict state has no historyVersion key", () => {
    const state: EditorTabState = {
      origin: "conflict",
      basePath: "a.md",
      siblingPath: "a.conflict-from-X.md",
      openMode: "user",
    };
    expect(persistedEditorState(state)).toEqual({
      origin: "conflict",
      basePath: "a.md",
      siblingPath: "a.conflict-from-X.md",
    });
  });
});

// ── §4.5.3 C1/G1 — deferred-safe live-id from serialized state (orphan-sweep) ─
describe("ephemeralAutosaveIdFromState (deferred-leaf orphan-sweep)", () => {
  const histState = (basePath: string, id: string): EditorTabState => ({
    origin: "history",
    basePath,
    siblingPath: basePath,
    historyVersion: { local: false, date: 1, id, deviceLabel: "phone" },
  });

  it("history state → the SAME per-file id the view/entry path derives (state-only, no view)", () => {
    // The whole point: identical to what openDesc → autosaveIdForEntry would produce —
    // so a DEFERRED (view-less) leaf claims the same dir a loaded leaf would.
    const fromState = ephemeralAutosaveIdFromState(histState("F.md", "sha1"));
    const fromEntry = autosaveIdForEntry({
      basePath: "F.md",
      siblingPath: "F.md",
      deviceLabel: "phone",
      isoTimestamp: "x",
      kind: "synthetic",
      historyVersionSha: "sha1",
    });
    expect(fromState).toBe(fromEntry);
    expect(fromState).toMatch(/^history-/);
    // Per-file: any version of F.md resolves to the same live id.
    expect(ephemeralAutosaveIdFromState(histState("F.md", "sha2"))).toBe(fromState);
  });

  it("conflict/compare/missing state → null (its dir isn't ephemeral)", () => {
    expect(
      ephemeralAutosaveIdFromState({ origin: "conflict", basePath: "a.md", siblingPath: "a.conflict-from-X.md" }),
    ).toBeNull();
    expect(ephemeralAutosaveIdFromState({ origin: "compare", basePath: "a.md", siblingPath: "b.md" })).toBeNull();
    // history with no version (corrupt) → null.
    expect(ephemeralAutosaveIdFromState({ origin: "history", basePath: "F.md", siblingPath: "F.md" })).toBeNull();
  });

  it("G1 regression: a DEFERRED history leaf's dir is NOT swept (state-derived id claims it)", () => {
    // The dir on disk for F.md's history session:
    const dirId = ephemeralAutosaveIdFromState(histState("F.md", "sha1"))!;
    // A backgrounded (deferred) leaf yields no `view instanceof DiffEditorView`, but its
    // STATE still yields the id → it must be in the live set → dir survives the sweep.
    const live = new Set([ephemeralAutosaveIdFromState(histState("F.md", "sha1"))!]);
    expect(historyDeletedOrphans([dirId], live)).toEqual([]); // kept
    // Contrast: with no live tab (leaf truly closed), the same dir IS an orphan.
    expect(historyDeletedOrphans([dirId], new Set())).toEqual([dirId]);
  });
});

// ── Seam 4: planBackNav history branch (BackNav union) ───────────────────────
describe("planBackNav — history branch", () => {
  it("history origin → { kind: 'history', anchorPath }", () => {
    expect(planBackNav("history", "Folder/note.md", false)).toEqual({
      kind: "history",
      anchorPath: "Folder/note.md",
    });
  });

  it("conflict origin unchanged → panel:conflicts (scroll iff base still has siblings)", () => {
    expect(planBackNav("conflict", "b.md", true)).toEqual({
      kind: "panel",
      tab: "conflicts",
      scrollToBase: "b.md",
    });
  });

  it("deleted origin unchanged → panel:deleted", () => {
    expect(planBackNav("deleted", "x.md", true)).toEqual({
      kind: "panel",
      tab: "deleted",
      scrollToBase: null,
    });
  });
});
