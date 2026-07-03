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
import { planBackNav } from "../../src/diff2/editor-tabs";

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

// ── Seam 1: deriveAutosaveId += "history" + the GATE (version discriminator) ──
describe("deriveAutosaveId — history kind (7a.1 GATE)", () => {
  const CF = "Folder/note.md";

  it("accepts the 'history' kind and prefixes the id", () => {
    expect(deriveAutosaveId("history", CF, "sha-abc")).toMatch(/^history-/);
  });

  // THE GATE: two versions of the SAME file must get DIFFERENT ids. This works
  // only because the version-sha (not the equal paths) is the discriminator —
  // so "no new AutosaveMeta field" holds: identity lives in the id/dirname, not
  // in baseShaAtStart (which is the content blob-sha, ≠ the commit-sha).
  it("two versions of the same file → distinct ids (preserve-all-commits)", () => {
    expect(deriveAutosaveId("history", CF, "sha1")).not.toBe(
      deriveAutosaveId("history", CF, "sha2"),
    );
  });

  it("history id is distinct from a same-file synthetic id (kind prefix)", () => {
    expect(deriveAutosaveId("history", CF, "x")).not.toBe(
      deriveAutosaveId("synthetic", CF, "x"),
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
