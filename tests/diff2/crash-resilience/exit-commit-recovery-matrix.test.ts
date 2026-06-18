// Stage 2.1 — recoverCommit() across the §5.0.b decision matrix (modify-in-place
// variant, bug3).
//
// Recovery is a PURE function of disk state. We hand-craft each row's exact
// on-disk slot configuration (final / .sync-tmp × old/new/torn/foreign/absent),
// run recoverCommit, and assert the vault converges to the committed end-state
// (forward rows) or cleanly rolls back (A–C) / falls back (genuine foreign).
//
// bug3 note: commit7Step now promotes IN PLACE (modifyBinary), so it NEVER
// writes .sync-bak — the original is modified, not renamed aside. modifyBinary
// is non-atomic, so a crash can leave a TORN final (classified "foreign"); the
// discriminator is OUR clean .sync-tmp — torn-final + clean-tmp = our write →
// roll forward; foreign-final + no-clean-tmp = external edit → fall back. Rows
// TB/TS cover the torn cases. Hand-crafting is the ONLY way to reach a partial
// .sync-tmp / a torn final; a secondary injection test then proves a real
// commit7Step crash lands WITHIN the matrix.
//
// The ENTIRE matrix runs over BOTH a regular vault path AND a `.obsidian/` dot-
// dir path (matrixSuite is invoked twice). A conflict can — undesirably but
// possibly — land on a config-dir file; those are never indexed TFiles, so the
// commit takes the safeRename path and the staging-path shape differs
// (`.obsidian/p/data.sync-tmp.json`). Running the full matrix on both proves
// classifySide / stagingPathFor / safeRename handle the hidden-dir shape
// identically. (Production uses vault.adapter throughout — the high-level
// vault.read/modify TFile API does NOT see dot-dir files — and modifyBinary
// only when an indexed TFile exists, i.e. never for dot-dirs.)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault, setMockPlatform } from "../../../mock-obsidian";
import type { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../../../src/utils";
import { stagingPathFor } from "../../../src/sync2/atomic-write";
import { autosaveDir, startSession } from "../../../src/diff2/autosave-store";
import { commit7Step, recoverCommit } from "../../../src/diff2/exit-commit";

const NOW = "2026-06-02T12:00:00.000Z";
const ID = "tracked-recover";

const OLD_BASE = "old base\n";
const OLD_SIB = "old sib\n";
const NEW_BASE = "new base\n";
const NEW_SIB = "new sib\n";
const TORN = "torn partial\n";
const FOREIGN = "external content\n";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(os.tmpdir(), `recover-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

type FinalSlot = "absent" | "old" | "new" | "foreign";
type TmpSlot = "absent" | "tmpNew" | "tmpTorn";
type Slot = { final: FinalSlot; tmp: TmpSlot; bak: boolean };

// Define the full recovery matrix for a given (BASE, SIB) path pair. Invoked
// once for a regular vault path and once for a `.obsidian/` dot-dir path.
function matrixSuite(label: string, BASE: string, SIB: string): void {
  // Build meta + done.json, then place each side's slots exactly.
  async function craft(
    vault: Vault,
    base: Slot,
    sib: Slot,
    opts: { writeDone?: boolean; newBase?: string; newSib?: string } = {},
  ) {
    const newBase = opts.newBase ?? NEW_BASE;
    const newSib = opts.newSib ?? NEW_SIB;
    await vault.adapter.writeBinary(BASE, enc(OLD_BASE));
    await vault.adapter.writeBinary(SIB, enc(OLD_SIB));
    await startSession(vault, ID, BASE, SIB, NOW);

    if (opts.writeDone !== false) {
      await vault.adapter.write(
        `${autosaveDir(ID)}/done.json`,
        JSON.stringify({
          v: 1,
          writtenAt: NOW,
          expectedBaseSha: await calculateGitBlobSHA(enc(newBase)),
          expectedSiblingSha: await calculateGitBlobSHA(enc(newSib)),
        }),
      );
    }

    await vault.adapter.remove(BASE);
    await vault.adapter.remove(SIB);
    await placeSide(vault, BASE, base, OLD_BASE, newBase);
    await placeSide(vault, SIB, sib, OLD_SIB, newSib);
  }

  async function placeSide(
    vault: Vault,
    finalPath: string,
    slot: Slot,
    oldBytes: string,
    newBytes: string,
  ) {
    if (slot.final === "old") await vault.adapter.writeBinary(finalPath, enc(oldBytes));
    else if (slot.final === "new") await vault.adapter.writeBinary(finalPath, enc(newBytes));
    else if (slot.final === "foreign") await vault.adapter.writeBinary(finalPath, enc(FOREIGN));

    if (slot.tmp === "tmpNew")
      await vault.adapter.writeBinary(stagingPathFor(finalPath, "tmp"), enc(newBytes));
    else if (slot.tmp === "tmpTorn")
      await vault.adapter.writeBinary(stagingPathFor(finalPath, "tmp"), enc(TORN));

    if (slot.bak) await vault.adapter.writeBinary(stagingPathFor(finalPath, "bak"), enc(oldBytes));
  }

  async function assertCommitted(vault: Vault) {
    expect(await vault.adapter.read(BASE)).toBe(NEW_BASE);
    expect(await vault.adapter.read(SIB)).toBe(NEW_SIB);
    for (const w of ["tmp", "bak"] as const) {
      expect(await vault.adapter.exists(stagingPathFor(BASE, w))).toBe(false);
      expect(await vault.adapter.exists(stagingPathFor(SIB, w))).toBe(false);
    }
    expect(await vault.adapter.exists(autosaveDir(ID))).toBe(false);
  }

  describe(`recoverCommit [${label}] — forward rows converge to committed`, () => {
    let fx: ReturnType<typeof fixture>;
    beforeEach(() => (fx = fixture()));
    afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

    const FORWARD: Array<[string, Slot, Slot]> = [
      // Modify-in-place crash states (bug3): no .sync-bak is ever created (the
      // original is modified in place, never renamed aside). The clean .sync-tmp
      // is the roll-forward source. A "foreign" final WITH our clean tmp is OUR
      // torn modifyBinary — recovery overwrites it from the tmp (NOT a fallback).
      ["D (both staged, finals old — pre-modify)", { final: "old", tmp: "tmpNew", bak: false }, { final: "old", tmp: "tmpNew", bak: false }],
      ["E (new-file base pre-promote, sibling staged)", { final: "absent", tmp: "tmpNew", bak: false }, { final: "old", tmp: "tmpNew", bak: false }],
      ["F (base staged, new-file sibling pre-promote)", { final: "old", tmp: "tmpNew", bak: false }, { final: "absent", tmp: "tmpNew", bak: false }],
      ["G (both new files pre-promote)", { final: "absent", tmp: "tmpNew", bak: false }, { final: "absent", tmp: "tmpNew", bak: false }],
      ["TB (base modifyBinary TORN + clean tmp)", { final: "foreign", tmp: "tmpNew", bak: false }, { final: "old", tmp: "tmpNew", bak: false }],
      ["H (base modify done, sibling not yet)", { final: "new", tmp: "tmpNew", bak: false }, { final: "old", tmp: "tmpNew", bak: false }],
      ["TS (base done, sibling modifyBinary TORN + clean tmp)", { final: "new", tmp: "tmpNew", bak: false }, { final: "foreign", tmp: "tmpNew", bak: false }],
      ["I (sibling modify done, base not yet)", { final: "old", tmp: "tmpNew", bak: false }, { final: "new", tmp: "tmpNew", bak: false }],
      ["J (both committed, tmps not cleaned)", { final: "new", tmp: "tmpNew", bak: false }, { final: "new", tmp: "tmpNew", bak: false }],
      ["K (both committed, tmps cleaned)", { final: "new", tmp: "absent", bak: false }, { final: "new", tmp: "absent", bak: false }],
    ];

    for (const [name, base, sib] of FORWARD) {
      it(`${name} → rolled-forward`, async () => {
        await craft(fx.vault, base, sib);
        const res = await recoverCommit(fx.vault, ID);
        expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: false });
        await assertCommitted(fx.vault);
      });
    }
  });

  describe(`recoverCommit [${label}] — rollback rows A–C preserve the session`, () => {
    let fx: ReturnType<typeof fixture>;
    beforeEach(() => (fx = fixture()));
    afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

    const ROLLBACK: Array<[string, Slot, Slot]> = [
      ["A (pre-write, both old)", { final: "old", tmp: "absent", bak: false }, { final: "old", tmp: "absent", bak: false }],
      ["B (both torn)", { final: "old", tmp: "tmpTorn", bak: false }, { final: "old", tmp: "tmpTorn", bak: false }],
      ["C (one torn, one good)", { final: "old", tmp: "tmpTorn", bak: false }, { final: "old", tmp: "tmpNew", bak: false }],
    ];

    for (const [name, base, sib] of ROLLBACK) {
      it(`${name} → rolled-back, originals intact, session kept`, async () => {
        await craft(fx.vault, base, sib);
        const res = await recoverCommit(fx.vault, ID);
        expect(res).toEqual({ kind: "rolled-back" });

        expect(await fx.vault.adapter.read(BASE)).toBe(OLD_BASE);
        expect(await fx.vault.adapter.read(SIB)).toBe(OLD_SIB);
        expect(await fx.vault.adapter.exists(stagingPathFor(BASE, "tmp"))).toBe(false);
        expect(await fx.vault.adapter.exists(stagingPathFor(SIB, "tmp"))).toBe(false);
        expect(await fx.vault.adapter.exists(`${autosaveDir(ID)}/done.json`)).toBe(false);
        expect(await fx.vault.adapter.exists(`${autosaveDir(ID)}/meta.json`)).toBe(true);
      });
    }
  });

  describe(`recoverCommit [${label}] — fallback, 6.5-in-recovery, no-commit`, () => {
    let fx: ReturnType<typeof fixture>;
    beforeEach(() => (fx = fixture()));
    afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

    it("GENUINE foreign final (external edit, NO clean tmp of ours) → fallback, foreign intact", async () => {
      await craft(
        fx.vault,
        { final: "foreign", tmp: "absent", bak: false },
        { final: "old", tmp: "tmpNew", bak: false },
      );
      const res = await recoverCommit(fx.vault, ID);
      expect(res).toEqual({ kind: "fallback", reason: "external-modification" });
      expect(await fx.vault.adapter.read(BASE)).toBe(FOREIGN);
      expect(await fx.vault.adapter.exists(stagingPathFor(BASE, "tmp"))).toBe(false);
      expect(await fx.vault.adapter.exists(stagingPathFor(SIB, "tmp"))).toBe(false);
      expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    });

    it("forward with identical committed sides → step 6.5 removes the sibling", async () => {
      await craft(
        fx.vault,
        { final: "old", tmp: "tmpNew", bak: false },
        { final: "old", tmp: "tmpNew", bak: false },
        { newBase: "MERGED\n", newSib: "MERGED\n" },
      );
      const res = await recoverCommit(fx.vault, ID);
      expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
      expect(await fx.vault.adapter.read(BASE)).toBe("MERGED\n");
      expect(await fx.vault.adapter.exists(SIB)).toBe(false);
      expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    });

    it("no done.json → no-commit, nothing touched", async () => {
      await craft(
        fx.vault,
        { final: "old", tmp: "absent", bak: false },
        { final: "old", tmp: "absent", bak: false },
        { writeDone: false },
      );
      const res = await recoverCommit(fx.vault, ID);
      expect(res).toEqual({ kind: "no-commit" });
      expect(await fx.vault.adapter.read(BASE)).toBe(OLD_BASE);
      expect(await fx.vault.adapter.exists(`${autosaveDir(ID)}/meta.json`)).toBe(true);
    });
  });

  describe(`recoverCommit [${label}] under MOCK_PLATFORM=mobile (Capacitor rename)`, () => {
    // roll-forward does safeRename(tmp → final) OVER an existing old final
    // (row D) — a rename-over-occupied path, exactly what the CLAUDE.md mobile
    // rule guards. Confirm it (and the foreign fallback) under strict semantics.
    let fx: ReturnType<typeof fixture>;
    beforeEach(() => {
      setMockPlatform("mobile");
      fx = fixture();
    });
    afterEach(() => {
      setMockPlatform("desktop");
      fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it("row D (rename over occupied final) rolls forward", async () => {
      await craft(
        fx.vault,
        { final: "old", tmp: "tmpNew", bak: false },
        { final: "old", tmp: "tmpNew", bak: false },
      );
      expect(await recoverCommit(fx.vault, ID)).toEqual({
        kind: "rolled-forward",
        siblingRemoved: false,
      });
      await assertCommitted(fx.vault);
    });

    it("GENUINE foreign final (no clean tmp) → fallback, foreign content intact", async () => {
      await craft(
        fx.vault,
        { final: "foreign", tmp: "absent", bak: false },
        { final: "old", tmp: "tmpNew", bak: false },
      );
      expect(await recoverCommit(fx.vault, ID)).toEqual({
        kind: "fallback",
        reason: "external-modification",
      });
      expect(await fx.vault.adapter.read(BASE)).toBe(FOREIGN);
      expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    });
  });

  describe(`recoverCommit [${label}] — secondary: real commit7Step crash lands in the matrix`, () => {
    let fx: ReturnType<typeof fixture>;
    beforeEach(() => (fx = fixture()));
    afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

    it("crash mid-promote (base promoted, sibling not) → recover completes the commit", async () => {
      await fx.vault.adapter.writeBinary(BASE, enc(OLD_BASE));
      await fx.vault.adapter.writeBinary(SIB, enc(OLD_SIB));
      const meta = await startSession(fx.vault, ID, BASE, SIB, NOW);

      // The mock has no modifyBinary → promoteInPlace falls back to safeRename, so
      // we crash on the sibling promote (adapter.rename dst === SIB). Base has
      // already been promoted (final=new, its tmp consumed by the rename); the
      // sibling is still old with its clean tmp staged → recovery rolls forward.
      const origGet = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(fx.vault),
        "adapter",
      )!.get!;
      Object.defineProperty(fx.vault, "adapter", {
        configurable: true,
        get() {
          const real = origGet.call(this) as {
            rename: (s: string, d: string) => Promise<void>;
          };
          const rn = real.rename;
          real.rename = async (s: string, d: string) => {
            if (d === SIB) throw new Error("crash step 5 sibling");
            return rn(s, d);
          };
          return real;
        },
      });

      await expect(
        commit7Step(fx.vault, ID, meta, { base: NEW_BASE, sibling: NEW_SIB }, { now: NOW }),
      ).rejects.toThrow(/crash step 5/);

      Object.defineProperty(fx.vault, "adapter", { configurable: true, get: origGet });

      const res = await recoverCommit(fx.vault, ID);
      expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: false });
      await assertCommitted(fx.vault);
    });
  });
}

// ── delete-base recovery (bug-29 / R3.3 2026-06-18) ──────────────────
//
// An empty-resolved base that was ABSENT at session start (delete-vs-modify
// resolved to the deleted side) commits as a DELETE: commit7Step stages NO base
// tmp and removes the base target (a no-op when already absent); recoverCommit
// INFERS the delete from meta (expectedBaseSha===SHA("") && !baseExistedAtStart)
// and treats the base's committed end-state as ABSENT. Crash states are
// hand-crafted exactly as for the write matrix, then recoverCommit must converge
// to base-absent + sibling-absent (6.5 unifies the two empty sides).
describe("recoverCommit — delete-base (absent base, resolve-to-empty)", () => {
  const BASE = "Notes/del.md";
  const SIB = "Notes/del.conflict-from-Phone-X.md";
  const EMPTY_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // Start an ABSENT-base session (base never written) → baseExistedAtStart=false,
  // baseShaAtStart=SHA(""). done.json records both expected SHAs = SHA("").
  async function craftDelete(sib: Slot) {
    await fx.vault.adapter.writeBinary(SIB, enc(OLD_SIB)); // sibling has content
    const meta = await startSession(fx.vault, "del", BASE, SIB, NOW);
    expect(meta.baseExistedAtStart).toBe(false);
    await fx.vault.adapter.write(
      `${autosaveDir("del")}/done.json`,
      JSON.stringify({
        v: 1,
        writtenAt: NOW,
        expectedBaseSha: EMPTY_SHA,
        expectedSiblingSha: EMPTY_SHA,
      }),
    );
    // base stays absent throughout (delete side stages nothing). Place sibling.
    await fx.vault.adapter.remove(SIB);
    // sibling's "new" bytes for this commit are 0 bytes (the shared empty rep).
    await placeSideRaw(fx.vault, SIB, sib, OLD_SIB, "");
  }

  it("crash after done.json, sibling staged (0-byte tmp) → rolls forward to BOTH absent", async () => {
    await craftDelete({ final: "old", tmp: "tmpNew", bak: false });
    const res = await recoverCommit(fx.vault, "del");
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir("del"))).toBe(false);
  });

  it("crash after sibling promoted (0-byte) before 6.5 → rolls forward to BOTH absent", async () => {
    await craftDelete({ final: "new", tmp: "tmpNew", bak: false });
    const res = await recoverCommit(fx.vault, "del");
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
  });

  it("crash before sibling staged (no tmp) → rolls back, sibling content intact, session kept", async () => {
    await craftDelete({ final: "old", tmp: "absent", bak: false });
    const res = await recoverCommit(fx.vault, "del");
    expect(res).toEqual({ kind: "rolled-back" });
    expect(await fx.vault.adapter.exists(BASE)).toBe(false); // never created
    expect(await fx.vault.adapter.read(SIB)).toBe(OLD_SIB); // restored
    expect(await fx.vault.adapter.exists(`${autosaveDir("del")}/meta.json`)).toBe(true);
  });

  it("defensive: base present as a stray 0-byte file → delete completes it", async () => {
    await craftDelete({ final: "new", tmp: "absent", bak: false });
    await fx.vault.adapter.writeBinary(BASE, enc("")); // stray 0-byte base
    const res = await recoverCommit(fx.vault, "del");
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
    expect(await fx.vault.adapter.exists(BASE)).toBe(false); // removed
  });

  it("real commit7Step (absent base, both empty) → base absent, sibling removed", async () => {
    await fx.vault.adapter.writeBinary(SIB, enc(OLD_SIB));
    const meta = await startSession(fx.vault, "del", BASE, SIB, NOW);
    const res = await commit7Step(fx.vault, "del", meta, { base: "", sibling: "" }, { now: NOW });
    expect(res.siblingRemoved).toBe(true);
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir("del"))).toBe(false);
  });

  // ── case 4: HAD-CONTENT base emptied + confirmed delete ────────────────
  // meta.baseExistedAtStart=TRUE, so recovery cannot infer the delete from meta;
  // done.json carries deleteBase:true (authoritative). Recovery must converge to
  // base-absent + sibling-absent. Base started WITH content (baseShaAtStart≠SHA"").
  async function craftCase4(baseFinal: FinalSlot, sib: Slot) {
    await fx.vault.adapter.writeBinary(BASE, enc(OLD_BASE)); // base HAD content
    await fx.vault.adapter.writeBinary(SIB, enc(OLD_SIB));
    const meta = await startSession(fx.vault, "c4", BASE, SIB, NOW);
    expect(meta.baseExistedAtStart).toBe(true);
    await fx.vault.adapter.write(
      `${autosaveDir("c4")}/done.json`,
      JSON.stringify({
        v: 1,
        writtenAt: NOW,
        expectedBaseSha: EMPTY_SHA,
        expectedSiblingSha: EMPTY_SHA,
        deleteBase: true,
      }),
    );
    await fx.vault.adapter.remove(BASE);
    await fx.vault.adapter.remove(SIB);
    // base may be present-old (not yet deleted) or absent (deleted).
    if (baseFinal === "old") await fx.vault.adapter.writeBinary(BASE, enc(OLD_BASE));
    await placeSideRaw(fx.vault, SIB, sib, OLD_SIB, "");
  }

  it("case 4: crash before base deleted (base old, sibling staged) → forward to BOTH absent", async () => {
    await craftCase4("old", { final: "old", tmp: "tmpNew", bak: false });
    const res = await recoverCommit(fx.vault, "c4");
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
  });

  it("case 4: crash after base deleted, sibling promoted → forward to BOTH absent", async () => {
    await craftCase4("absent", { final: "new", tmp: "tmpNew", bak: false });
    const res = await recoverCommit(fx.vault, "c4");
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
  });

  it("real commit7Step case 4 (confirmedDelete) → base + sibling gone", async () => {
    await fx.vault.adapter.writeBinary(BASE, enc(OLD_BASE));
    await fx.vault.adapter.writeBinary(SIB, enc(OLD_SIB));
    const meta = await startSession(fx.vault, "c4", BASE, SIB, NOW);
    const res = await commit7Step(
      fx.vault,
      "c4",
      meta,
      { base: "", sibling: "" },
      { now: NOW, confirmedDelete: true },
    );
    expect(res.siblingRemoved).toBe(true);
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
  });

  it("END-TO-END case 4: real commit7Step crashes after base delete → recover completes", async () => {
    // Proves commit7Step records done.deleteBase: the base is deleted, then we
    // crash on the sibling promote. meta.baseExistedAtStart=true, so ONLY a
    // persisted deleteBase lets recovery converge (meta-inference would give
    // false → treat base-absent as a not-committed write → wrong).
    await fx.vault.adapter.writeBinary(BASE, enc(OLD_BASE));
    await fx.vault.adapter.writeBinary(SIB, enc(OLD_SIB));
    const meta = await startSession(fx.vault, "c4", BASE, SIB, NOW);

    const origGet = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(fx.vault),
      "adapter",
    )!.get!;
    Object.defineProperty(fx.vault, "adapter", {
      configurable: true,
      get() {
        const real = origGet.call(this) as {
          rename: (s: string, d: string) => Promise<void>;
        };
        const rn = real.rename;
        real.rename = async (s: string, d: string) => {
          if (d === SIB) throw new Error("crash sibling promote");
          return rn(s, d);
        };
        return real;
      },
    });
    await expect(
      commit7Step(fx.vault, "c4", meta, { base: "", sibling: "" }, { now: NOW, confirmedDelete: true }),
    ).rejects.toThrow(/crash sibling/);
    Object.defineProperty(fx.vault, "adapter", { configurable: true, get: origGet });

    // base already deleted by the crash; recovery must NOT resurrect it.
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    const res = await recoverCommit(fx.vault, "c4");
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
    expect(await fx.vault.adapter.exists(BASE)).toBe(false);
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
  });
});

// Like placeSide but with an explicit newBytes string (the delete-base commit's
// sibling "new" version is 0 bytes, not NEW_SIB).
async function placeSideRaw(
  vault: Vault,
  finalPath: string,
  slot: Slot,
  oldBytes: string,
  newBytes: string,
) {
  if (slot.final === "old") await vault.adapter.writeBinary(finalPath, enc(oldBytes));
  else if (slot.final === "new") await vault.adapter.writeBinary(finalPath, enc(newBytes));
  else if (slot.final === "foreign") await vault.adapter.writeBinary(finalPath, enc(FOREIGN));
  if (slot.tmp === "tmpNew")
    await vault.adapter.writeBinary(stagingPathFor(finalPath, "tmp"), enc(newBytes));
  else if (slot.tmp === "tmpTorn")
    await vault.adapter.writeBinary(stagingPathFor(finalPath, "tmp"), enc(TORN));
  if (slot.bak) await vault.adapter.writeBinary(stagingPathFor(finalPath, "bak"), enc(oldBytes));
}

matrixSuite("vault", "Notes/doc.md", "Notes/doc.conflict-from-Phone-X.md");
matrixSuite(
  "dot-dir",
  ".obsidian/plugins/p/data.json",
  ".obsidian/plugins/p/data.conflict-from-Phone-X.json",
);
