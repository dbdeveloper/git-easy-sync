// Stage 2.1 — the 7-step `[← back]` commit + TOCTOU detector
// (DIFF-EDITOR.md §5.0 / §5.0 Step 1.5 / §5.0.e save-to-alt).
//
// Composes Stage 2.0 (startSession creates the real meta + dir) with Stage
// 2.1 commit7Step, so the meta contract is exercised, not faked. Node env
// (real fs over tmpdir), with the commit happy-path also run under
// MOCK_PLATFORM=mobile to pin Capacitor rename semantics (CLAUDE.md rule:
// any new write-then-rename path owes a mobile-paired test).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault, setMockPlatform, TFile } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../../src/utils";
import { stagingPathFor } from "../../src/sync2/atomic-write";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import {
  classifyToctou,
  commit7Step,
  commitOrDiscardExit,
  recoverCommit,
  type DoneJson,
} from "../../src/diff2/exit-commit";

const NOW = "2026-06-02T12:00:00.000Z";
const ID = "tracked-commit";
const BASE = "Notes/meeting.md";
const SIB = "Notes/meeting.conflict-from-Phone-X.md";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(os.tmpdir(), `exit-commit-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

async function seedConflict(vault: Vault, base: string, sibling: string) {
  await vault.adapter.writeBinary(BASE, enc(base));
  await vault.adapter.writeBinary(SIB, enc(sibling));
  return startSession(vault, ID, BASE, SIB, NOW);
}

describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
  "commit7Step happy path (under $platform)",
  ({ platform }) => {
    let fx: ReturnType<typeof fixture>;
    beforeEach(() => {
      setMockPlatform(platform);
      fx = fixture();
    });
    afterEach(() => {
      setMockPlatform("desktop");
      fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it("writes BOTH sides, removes done.json + staging + dir; differing sides keep the sibling", async () => {
      const meta = await seedConflict(fx.vault, "OLD base\n", "OLD sibling\n");
      const res = await commit7Step(
        fx.vault,
        ID,
        meta,
        { base: "RESOLVED base\n", sibling: "RESOLVED sibling\n" },
        { now: NOW },
      );

      expect(await fx.vault.adapter.read(BASE)).toBe("RESOLVED base\n");
      expect(await fx.vault.adapter.read(SIB)).toBe("RESOLVED sibling\n");
      expect(res.siblingRemoved).toBe(false);

      // No leftover staging / barrier / session dir.
      for (const p of [
        `${BASE}.sync-tmp.md`,
        `${BASE}.sync-bak.md`,
        `${SIB}.sync-tmp.md`,
        `${SIB}.sync-bak.md`,
      ]) {
        expect(await fx.vault.adapter.exists(p)).toBe(false);
      }
      expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    });

    it("identical resolved sides → step 6.5 removes the redundant sibling", async () => {
      const meta = await seedConflict(fx.vault, "OLD base\n", "OLD sibling\n");
      const res = await commit7Step(
        fx.vault,
        ID,
        meta,
        { base: "MERGED\n", sibling: "MERGED\n" },
        { now: NOW },
      );
      expect(res.siblingRemoved).toBe(true);
      expect(await fx.vault.adapter.read(BASE)).toBe("MERGED\n");
      expect(await fx.vault.adapter.exists(SIB)).toBe(false);
      expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    });
  },
);

describe("commit7Step — done.json hash consistency + save-to-alt", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    setMockPlatform("desktop");
    fx = fixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("done.json expected SHAs hash the exact committed bytes", async () => {
    // Capture done.json by crashing step 3's writeBinary (after step 2 wrote it).
    const meta = await seedConflict(fx.vault, "old\n", "old\n");
    const orig = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(fx.vault),
      "adapter",
    )!.get!;
    Object.defineProperty(fx.vault, "adapter", {
      configurable: true,
      get() {
        const real = orig.call(this) as {
          writeBinary: (p: string, b: ArrayBuffer) => Promise<void>;
        };
        const wb = real.writeBinary;
        real.writeBinary = async (p: string, b: ArrayBuffer) => {
          // Only the step-3 base/sibling staging (.md); NOT done.json's own
          // atomicWriteFile staging (.sync-tmp.json), which must complete first.
          if (p.includes(".sync-tmp.md")) throw new Error("crash step 3");
          return wb(p, b);
        };
        return real;
      },
    });

    await expect(
      commit7Step(fx.vault, ID, meta, { base: "B-bytes\n", sibling: "S-bytes\n" }, { now: NOW }),
    ).rejects.toThrow(/crash step 3/);

    Object.defineProperty(fx.vault, "adapter", { configurable: true, get: orig });
    const done = JSON.parse(
      await fx.vault.adapter.read(`${autosaveDir(ID)}/done.json`),
    ) as DoneJson;
    expect(done.v).toBe(1);
    expect(done.expectedBaseSha).toBe(await calculateGitBlobSHA(enc("B-bytes\n")));
    expect(done.expectedSiblingSha).toBe(await calculateGitBlobSHA(enc("S-bytes\n")));
  });

  it("save-to-alt: writes fresh alt paths, leaves originals untouched, skips step 6.5", async () => {
    const meta = await seedConflict(fx.vault, "GitHub-pulled base\n", "current sibling\n");
    const altBase = "Notes/meeting.diff2-stale-1716987131.md";
    const altSib = "Notes/meeting.conflict-from-Phone-X.diff2-stale-1716987131.md";

    const res = await commit7Step(
      fx.vault,
      ID,
      meta,
      { base: "MERGED\n", sibling: "MERGED\n" }, // identical, but alt → 6.5 must NOT fire
      { now: NOW, targetBasePath: altBase, targetSiblingPath: altSib },
    );

    expect(res.siblingRemoved).toBe(false); // 6.5 gated on target===meta.siblingPath
    expect(await fx.vault.adapter.read(altBase)).toBe("MERGED\n");
    expect(await fx.vault.adapter.read(altSib)).toBe("MERGED\n");
    // Originals untouched (the externally-changed content survives).
    expect(await fx.vault.adapter.read(BASE)).toBe("GitHub-pulled base\n");
    expect(await fx.vault.adapter.read(SIB)).toBe("current sibling\n");
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });
});

describe("classifyToctou — §5.0 Step 1.5 detection", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    setMockPlatform("desktop");
    fx = fixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("unchanged vault → ok", async () => {
    const meta = await seedConflict(fx.vault, "b\n", "s\n");
    expect((await classifyToctou(fx.vault, meta)).kind).toBe("ok");
  });

  it("base changed externally → mismatch with flags + current SHAs", async () => {
    const meta = await seedConflict(fx.vault, "b\n", "s\n");
    await fx.vault.adapter.writeBinary(BASE, enc("b-pulled\n"));
    const st = await classifyToctou(fx.vault, meta);
    expect(st.kind).toBe("mismatch");
    if (st.kind === "mismatch") {
      expect(st.baseChanged).toBe(true);
      expect(st.siblingChanged).toBe(false);
      expect(st.currentBaseSha).toBe(await calculateGitBlobSHA(enc("b-pulled\n")));
    }
  });

  it("ABSENT base (delete-vs-modify) → ok, not an ENOENT crash (bug-29, 2026-06-18)", async () => {
    // base deleted locally, sibling holds the remote side. classifyToctou must
    // read the absent base as SHA("")=baseShaAtStart ⇒ no TOCTOU, not throw.
    await fx.vault.adapter.writeBinary(SIB, enc("remote\n"));
    const meta = await startSession(fx.vault, ID, BASE, SIB, NOW);
    expect(meta.baseExistedAtStart).toBe(false);
    expect((await classifyToctou(fx.vault, meta)).kind).toBe("ok");
  });

  it("absent-base resolve-to-CONTENT → creates base, removes sibling (bug-29)", async () => {
    await fx.vault.adapter.writeBinary(SIB, enc("remote\n"));
    const meta = await startSession(fx.vault, ID, BASE, SIB, NOW);
    // Resolving the group to theirs makes both sides agree on the remote bytes.
    const res = await commit7Step(
      fx.vault,
      ID,
      meta,
      { base: "remote\n", sibling: "remote\n" },
      { now: NOW },
    );
    expect(res.siblingRemoved).toBe(true);
    expect(await fx.vault.adapter.exists(BASE)).toBe(true);
    expect(Buffer.from(await fx.vault.adapter.readBinary(BASE)).toString()).toBe("remote\n");
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
  });
});

describe("commitOrDiscardExit — §4.1 zero-edit invariant + §5.0 exit decision", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("recordCount 0 → DISCARDED: dir wiped, base/sibling bytes UNTOUCHED", async () => {
    const base = "OLD base\n";
    const sib = "OLD sibling\n";
    const meta = await seedConflict(fx.vault, base, sib);
    const baseShaBefore = await calculateGitBlobSHA(await fx.vault.adapter.readBinary(BASE));
    const sibShaBefore = await calculateGitBlobSHA(await fx.vault.adapter.readBinary(SIB));

    // A would-be commit of an unedited session — resolved == inputs.
    const outcome = await commitOrDiscardExit(
      fx.vault,
      ID,
      meta,
      { base, sibling: sib },
      0, // zero recorded edits
    );

    expect(outcome).toEqual({ kind: "discarded" });
    // The autosave dir is gone…
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    // …and the input files were NEVER touched (НЕ ЗМІНЮЮЧИ ВХІДНІ ФАЙЛИ).
    expect(await calculateGitBlobSHA(await fx.vault.adapter.readBinary(BASE))).toBe(baseShaBefore);
    expect(await calculateGitBlobSHA(await fx.vault.adapter.readBinary(SIB))).toBe(sibShaBefore);
    // No staging files were created (no safeRename swap ran).
    expect(await fx.vault.adapter.exists("Notes/meeting.sync-tmp.md")).toBe(false);
    expect(await fx.vault.adapter.exists("Notes/meeting.sync-bak.md")).toBe(false);
  });

  it("recordCount > 0, vault unchanged → COMMITTED (both sides written, dir gone)", async () => {
    const meta = await seedConflict(fx.vault, "OLD base\n", "OLD sibling\n");
    const outcome = await commitOrDiscardExit(
      fx.vault,
      ID,
      meta,
      { base: "RESOLVED base\n", sibling: "RESOLVED sibling\n" },
      3,
    );
    expect(outcome.kind).toBe("committed");
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    expect(new TextDecoder().decode(await fx.vault.adapter.readBinary(BASE))).toBe("RESOLVED base\n");
    expect(new TextDecoder().decode(await fx.vault.adapter.readBinary(SIB))).toBe("RESOLVED sibling\n");
  });

  it("recordCount > 0, vault changed under the session → TOCTOU (dir survives)", async () => {
    const meta = await seedConflict(fx.vault, "b\n", "s\n");
    await fx.vault.adapter.writeBinary(BASE, enc("b-pulled-externally\n"));
    const outcome = await commitOrDiscardExit(
      fx.vault,
      ID,
      meta,
      { base: "resolved\n", sibling: "resolved\n" },
      2,
    );
    expect(outcome.kind).toBe("toctou");
    if (outcome.kind === "toctou") {
      expect(outcome.toctou.baseChanged).toBe(true);
      expect(outcome.toctou.siblingChanged).toBe(false);
    }
    // The view owns the §5.0.e modal → dir is NOT torn down here.
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(true);
  });
});

describe("commit7Step — modify-in-place (bug3: preserve an open editor tab)", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  // Wrap the mock vault to expose the production Obsidian APIs commit7Step's
  // promoteInPlace gates on: getAbstractFileByPath (sync index lookup) +
  // modifyBinary (in-place write that, in real Obsidian, keeps an open tab's
  // cursor/scroll). modifyBinary writes through the adapter AND records the
  // call so we can assert the in-place path was taken (not safeRename).
  function withModifyBinary(vault: Vault) {
    const existing = new Set<string>();
    const modifyCalls: string[] = [];
    const renamedAway: string[] = [];
    const realAdapter = vault.adapter;
    const adapter = Object.create(realAdapter) as typeof realAdapter;
    adapter.rename = async (s: string, d: string) => {
      renamedAway.push(`${s} -> ${d}`);
      return realAdapter.rename(s, d);
    };
    // Loosely typed (Object.create → any) so the mock TFile's shape doesn't
    // fight obsidian's TAbstractFile signature; cast back to Vault at the seam.
    const wrapped = Object.create(vault);
    Object.defineProperty(wrapped, "adapter", { get: () => adapter });
    // new TFile(p) so promoteInPlace's `instanceof TFile` holds at runtime
    // (obsidian is aliased to mock-obsidian under test).
    wrapped.getAbstractFileByPath = (p: string) =>
      existing.has(p) ? new TFile(p) : null;
    wrapped.modifyBinary = async (f: { path: string }, b: ArrayBuffer) => {
      modifyCalls.push(f.path);
      await realAdapter.writeBinary(f.path, b);
    };
    return { wrapped: wrapped as Vault, existing, modifyCalls, renamedAway };
  }

  it("promotes existing TFiles via modifyBinary, never renames the original aside", async () => {
    const meta = await seedConflict(fx.vault, "OLD base\n", "OLD sibling\n");
    const { wrapped, existing, modifyCalls, renamedAway } = withModifyBinary(fx.vault);
    existing.add(BASE);
    existing.add(SIB); // both are open/existing TFiles

    const res = await commit7Step(
      wrapped,
      ID,
      meta,
      { base: "RESOLVED base\n", sibling: "RESOLVED sibling\n" },
      { now: NOW },
    );

    // The in-place path was taken for BOTH sides (the bug3 fix)…
    expect(modifyCalls.sort()).toEqual([BASE, SIB].sort());
    // …and the ORIGINAL files were never renamed aside (what closed the tab).
    expect(renamedAway.some((r) => r.startsWith(`${BASE} ->`))).toBe(false);
    expect(renamedAway.some((r) => r.startsWith(`${SIB} ->`))).toBe(false);
    // No .sync-bak is ever produced by the modify-in-place commit.
    expect(await fx.vault.adapter.exists(stagingPathFor(BASE, "bak"))).toBe(false);
    expect(await fx.vault.adapter.exists(stagingPathFor(SIB, "bak"))).toBe(false);

    // Net effect is identical: both sides written, staging + dir gone.
    expect(res.basePath).toBe(BASE);
    expect(await fx.vault.adapter.read(BASE)).toBe("RESOLVED base\n");
    expect(await fx.vault.adapter.read(SIB)).toBe("RESOLVED sibling\n");
    expect(await fx.vault.adapter.exists(stagingPathFor(BASE, "tmp"))).toBe(false);
    expect(await fx.vault.adapter.exists(stagingPathFor(SIB, "tmp"))).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });

  it("a brand-NEW target (no TFile) falls back to an atomic rename", async () => {
    const meta = await seedConflict(fx.vault, "OLD base\n", "OLD sibling\n");
    const { wrapped, existing, modifyCalls } = withModifyBinary(fx.vault);
    existing.add(BASE); // base open; sibling NOT marked existing → new-file path

    await commit7Step(
      wrapped,
      ID,
      meta,
      { base: "RESOLVED base\n", sibling: "RESOLVED sibling\n" },
      { now: NOW },
    );

    // Only base went through modifyBinary; sibling took the rename fallback.
    expect(modifyCalls).toEqual([BASE]);
    expect(await fx.vault.adapter.read(BASE)).toBe("RESOLVED base\n");
    expect(await fx.vault.adapter.read(SIB)).toBe("RESOLVED sibling\n");
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });
});

describe("commit7Step — config-dir (.obsidian/) conflict paths (dot-dir)", () => {
  // A conflict CAN land on a config-dir file (undesirable but possible). Those
  // files are NOT opened in Obsidian tabs and are not TFiles, so promoteInPlace
  // takes the safeRename fallback (no editor to preserve) — and the staging /
  // recovery must work for the hidden-dir path shape just as for a vault file.
  const CBASE = ".obsidian/plugins/foo/data.json";
  const CSIB = ".obsidian/plugins/foo/data.conflict-from-Phone-X.json";
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    setMockPlatform("desktop");
    fx = fixture();
  });
  afterEach(() => {
    setMockPlatform("desktop");
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  async function seedCfg(base: string, sib: string) {
    await fx.vault.adapter.writeBinary(CBASE, enc(base));
    await fx.vault.adapter.writeBinary(CSIB, enc(sib));
    return startSession(fx.vault, ID, CBASE, CSIB, NOW);
  }

  it("commits both config files; staging lives inside the dot-dir; dir torn down", async () => {
    const meta = await seedCfg('{"a":1}\n', '{"a":2}\n');
    const res = await commit7Step(
      fx.vault,
      ID,
      meta,
      { base: '{"a":3}\n', sibling: '{"a":3}\n' }, // converge → 6.5 removes sibling
      { now: NOW },
    );
    expect(res.siblingRemoved).toBe(true);
    expect(await fx.vault.adapter.read(CBASE)).toBe('{"a":3}\n');
    expect(await fx.vault.adapter.exists(CSIB)).toBe(false);
    // Staging used the dot-dir ext-insert shape and was cleaned up.
    expect(await fx.vault.adapter.exists(".obsidian/plugins/foo/data.sync-tmp.json")).toBe(false);
    expect(await fx.vault.adapter.exists(".obsidian/plugins/foo/data.sync-bak.json")).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });

  it("crash mid-promote on a dot-path → recoverCommit forward-completes the pair", async () => {
    const meta = await seedCfg("OLD\n", "OLDSIB\n");
    const origGet = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(fx.vault),
      "adapter",
    )!.get!;
    Object.defineProperty(fx.vault, "adapter", {
      configurable: true,
      get() {
        const real = origGet.call(this) as { rename: (s: string, d: string) => Promise<void> };
        const rn = real.rename;
        real.rename = async (s: string, d: string) => {
          if (d === CSIB) throw new Error("crash sibling promote");
          return rn(s, d);
        };
        return real;
      },
    });
    await expect(
      commit7Step(fx.vault, ID, meta, { base: "NEWB\n", sibling: "NEWS\n" }, { now: NOW }),
    ).rejects.toThrow(/crash sibling/);
    Object.defineProperty(fx.vault, "adapter", { configurable: true, get: origGet });

    const rec = await recoverCommit(fx.vault, ID);
    expect(rec).toEqual({ kind: "rolled-forward", siblingRemoved: false });
    expect(await fx.vault.adapter.read(CBASE)).toBe("NEWB\n");
    expect(await fx.vault.adapter.read(CSIB)).toBe("NEWS\n");
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });
});
