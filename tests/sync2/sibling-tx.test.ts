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
import SiblingTx, {
  SIBLING_TX_MARK_FILE,
} from "../../src/sync2/sibling-tx";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { FileInfo, emptyFileInfo } from "../../src/sync2/diff3";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII C.14-22 — the STEP3 replace mark-transaction (§II.11):
// happy path, every crash window, the sibling-driven recovery
// contract, the dropLast degradation (19/19b recovery halves — the
// full two-drain 19a lands with the STEP3 wiring in drainOnce).

const PLUGIN_ID = "git-easy-sync";
const BASE = "note.md";

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
const sha = (s: string): Promise<string> => calculateGitBlobSHA(enc(s));

describe("SiblingTx (§II.11 / §VIII C.14-22)", () => {
  let dir: string;
  let vault: Vault;
  let store: ConflictStoreV2;
  let tx: SiblingTx;
  let shaCalls: number;

  const markAbs = (): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      SIBLING_TX_MARK_FILE,
    );

  const putFile = (p: string, content: string): void => {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const siblingAbs = (f: FileInfo): string =>
    path.join(
      dir,
      buildSiblingFilePath(f.path ?? "", f.mtime ?? 0, f.deviceLabel),
    );

  // A sibling FileInfo whose derived file holds `content` on disk.
  const sibling = async (
    content: string,
    mtime: number,
    label = "phone",
    onDisk = true,
  ): Promise<FileInfo> => {
    const f: FileInfo = {
      ...emptyFileInfo(),
      path: BASE,
      sha: await sha(content),
      size: enc(content).byteLength,
      mtime,
      deviceLabel: label,
      mode: "",
    };
    if (onDisk) {
      putFile(buildSiblingFilePath(BASE, mtime, label), content);
    }
    return f;
  };

  const stateWith = (siblings: FileInfo[]): ConflictsState => {
    const s = emptyConflictsState();
    s.entries.set(BASE, {
      conflictBase: { ...emptyFileInfo(), path: BASE, sha: "cb-sha" },
      siblings,
    });
    return s;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sibling-tx-test-"));
    vault = new Vault(dir);
    store = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    shaCalls = 0;
    tx = new SiblingTx({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      store,
      computeSha: async (b) => {
        shaCalls += 1;
        return calculateGitBlobSHA(b);
      },
      generateGuid: () => "guid-test",
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("C.14 happy path: mark → new file → durable commit → old removed → unmark; the durable write happens INSIDE the tx, not in an epilogue", async () => {
    const oldSib = await sibling("old fold\n", 1000);
    const state = stateWith([oldSib]);
    await store.save(state);

    const merged = await sibling("new fold\n", 2000, "phone", false);
    merged.blob = enc("new fold\n");
    await tx.runReplaceTransaction(state, BASE, oldSib, merged);

    expect(fs.existsSync(siblingAbs(oldSib))).toBe(false);
    expect(fs.existsSync(siblingAbs(merged))).toBe(true);
    expect(fs.existsSync(markAbs())).toBe(false);
    // Durable, not just in-memory:
    const durable = await store.load();
    expect(durable.lastSiblingTxGuid).toBe("guid-test");
    expect(durable.entries.get(BASE)!.siblings.map((s) => s.sha)).toEqual([
      merged.sha,
    ]);
    expect(durable.entries.get(BASE)!.siblings[0].blob).toBeNull();
  });

  it("C.15: crash between the mark and a full new-file write (absent OR torn) → BACKWARD: metadata untouched, artifact cleaned, unmark", async () => {
    const oldSib = await sibling("old\n", 1000);
    await store.save(stateWith([oldSib]));
    const newSib = await sibling("merged\n", 2000, "phone", false);

    // (a) new file never appeared.
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });
    await tx.recoverIfNeeded();
    let durable = await store.load();
    expect(durable.entries.get(BASE)!.siblings.map((s) => s.sha)).toEqual([
      oldSib.sha,
    ]);
    expect(durable.lastSiblingTxGuid).toBeNull();
    expect(fs.existsSync(markAbs())).toBe(false);
    expect(fs.existsSync(siblingAbs(oldSib))).toBe(true);

    // (b) new file appeared TORN (wrong bytes for its recorded sha).
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });
    putFile(
      buildSiblingFilePath(BASE, 2000, "phone"),
      "GARBAGE after power loss",
    );
    await tx.recoverIfNeeded();
    durable = await store.load();
    expect(durable.entries.get(BASE)!.siblings.map((s) => s.sha)).toEqual([
      oldSib.sha,
    ]);
    expect(fs.existsSync(siblingAbs(newSib))).toBe(false); // untrusted artifact removed
    expect(fs.existsSync(siblingAbs(oldSib))).toBe(true);
  });

  it("C.16: crash AFTER a valid new file, BEFORE the durable commit → FORWARD despite guid mismatch: step 3 reconstructed, old removed", async () => {
    const oldSib = await sibling("old\n", 1000);
    await store.save(stateWith([oldSib])); // guid still null = old
    const newSib = await sibling("merged\n", 2000); // valid file ON disk
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });

    await tx.recoverIfNeeded();
    const durable = await store.load();
    expect(durable.entries.get(BASE)!.siblings.map((s) => s.sha)).toEqual([
      newSib.sha,
    ]);
    expect(durable.lastSiblingTxGuid).toBe("guid-test");
    expect(fs.existsSync(siblingAbs(oldSib))).toBe(false); // step 4 completed
    expect(fs.existsSync(markAbs())).toBe(false);
  });

  it("C.17: crash AFTER the durable commit, BEFORE deleting the old file → FORWARD completes ONLY step 4 (store already correct)", async () => {
    const oldSib = await sibling("old\n", 1000);
    const newSib = await sibling("merged\n", 2000);
    const committed = stateWith([{ ...newSib, blob: null }]);
    committed.lastSiblingTxGuid = "guid-test";
    await store.save(committed);
    let saves = 0;
    const origSave = store.save.bind(store);
    store.save = async (s) => {
      saves += 1;
      return origSave(s);
    };
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });

    await tx.recoverIfNeeded();
    expect(saves).toBe(0); // guid matched + file ok → step 3 is a no-op
    expect(fs.existsSync(siblingAbs(oldSib))).toBe(false);
    expect(fs.existsSync(markAbs())).toBe(false);
  });

  it("C.18: new file CORRUPT at recovery, old intact on disk, store already committed → rollback to the old sibling, guid nulled", async () => {
    const oldSib = await sibling("old\n", 1000); // intact on disk
    const newSib = await sibling("merged\n", 2000, "phone", false);
    putFile(buildSiblingFilePath(BASE, 2000, "phone"), "torn bytes");
    const committed = stateWith([{ ...newSib, blob: null }]);
    committed.lastSiblingTxGuid = "guid-test";
    await store.save(committed);
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });

    await tx.recoverIfNeeded();
    const durable = await store.load();
    expect(durable.entries.get(BASE)!.siblings.map((s) => s.sha)).toEqual([
      oldSib.sha, // rolled back
    ]);
    expect(durable.lastSiblingTxGuid).toBeNull();
    expect(fs.existsSync(siblingAbs(newSib))).toBe(false);
    expect(fs.existsSync(siblingAbs(oldSib))).toBe(true); // untouched
  });

  it("C.19 (recovery half): BOTH candidates unusable — (а) old missing / (б) old present-but-CORRUPT → dropLast; len==1 → [], the record SURVIVES", async () => {
    for (const oldOnDiskCorrupt of [false, true]) {
      const suffix = oldOnDiskCorrupt ? "b" : "a";
      const base = `case-${suffix}/${BASE}`;
      const oldSib: FileInfo = {
        ...emptyFileInfo(),
        path: base,
        sha: await sha("old\n"),
        size: enc("old\n").byteLength,
        mtime: 1000,
        deviceLabel: "phone",
      };
      if (oldOnDiskCorrupt) {
        // (б): present but corrupt — an exists-check would wrongly
        // accept it and feed garbage into the next _diff3.
        putFile(buildSiblingFilePath(base, 1000, "phone"), "CORRUPT OLD");
      }
      const newSib: FileInfo = { ...oldSib, sha: await sha("new\n"), mtime: 2000 };
      const committed = emptyConflictsState();
      committed.entries.set(base, {
        conflictBase: { ...emptyFileInfo(), path: base, sha: "cb" },
        siblings: [{ ...newSib, blob: null }],
      });
      committed.lastSiblingTxGuid = "guid-test";
      await store.save(committed);
      await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
        "writeMark"
      ]({ guid: "guid-test", path: base, oldSibling: oldSib, newSibling: newSib });

      await tx.recoverIfNeeded();
      const durable = await store.load();
      // The CATASTROPHIC wrong outcome would be a pruned record →
      // RECONCILE clears the flag → poisoned baseline → silent
      // clobber (19a). The record MUST survive with siblings: [].
      expect(durable.entries.has(base)).toBe(true);
      expect(durable.entries.get(base)!.siblings).toEqual([]);
      expect(durable.lastSiblingTxGuid).toBeNull();
    }
  });

  it("C.19b: same crash with len(siblings)==2 and the OLDER sibling intact → dropLast keeps exactly the older one tracked", async () => {
    const older = await sibling("older fold\n", 500, "tablet"); // intact on disk
    const oldSib = await sibling("old\n", 1000, "phone", false); // gone
    const newSib = await sibling("new\n", 2000, "phone", false); // never written
    const committed = stateWith([
      { ...older, blob: null },
      { ...newSib, blob: null },
    ]);
    committed.lastSiblingTxGuid = "guid-test";
    await store.save(committed);
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });

    await tx.recoverIfNeeded();
    const durable = await store.load();
    // If the rollback wrote [] instead of dropLast, the intact older
    // sibling would turn synthetic and stop blocking FINALIZE — the
    // branch could merge with a live conflict file visible on disk.
    expect(durable.entries.get(BASE)!.siblings.map((s) => s.sha)).toEqual([
      older.sha,
    ]);
    expect(fs.existsSync(siblingAbs(older))).toBe(true);
  });

  it("C.20: crash MID-recovery → a second recovery pass is deterministic and side-effect-free (both directions)", async () => {
    // Forward window: recovery completed store+file work but crashed
    // before deleting the mark.
    const oldSib = await sibling("old\n", 1000);
    const newSib = await sibling("merged\n", 2000);
    await store.save(stateWith([oldSib]));
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });
    await tx.recoverIfNeeded(); // completes fully
    // Simulate the mark surviving the crash mid-pass: re-write it and
    // run again — the state is already terminal.
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });
    const before = fs.readFileSync(
      path.join(dir, ".obsidian/plugins", PLUGIN_ID, ".runtime/conflicts.json"),
      "utf8",
    );
    await tx.recoverIfNeeded();
    const after = fs.readFileSync(
      path.join(dir, ".obsidian/plugins", PLUGIN_ID, ".runtime/conflicts.json"),
      "utf8",
    );
    expect(after).toBe(before); // byte-identical durable state
    expect(fs.existsSync(markAbs())).toBe(false);
  });

  it("C.21: the record was pruned BEFORE recovery (user resolved manually) → artifact cleaned, guid semantics repaired, old file left alone", async () => {
    const oldSib = await sibling("old survived as synthetic\n", 1000);
    const newSib = await sibling("merged\n", 2000);
    // Store has NO record for the path but claims the tx committed.
    const pruned = emptyConflictsState();
    pruned.lastSiblingTxGuid = "guid-test";
    await store.save(pruned);
    await (tx as never as { writeMark: (m: unknown) => Promise<void> })[
      "writeMark"
    ]({ guid: "guid-test", path: BASE, oldSibling: oldSib, newSibling: newSib });

    await tx.recoverIfNeeded();
    const durable = await store.load();
    expect(durable.lastSiblingTxGuid).toBeNull(); // would lie forever otherwise
    expect(fs.existsSync(siblingAbs(newSib))).toBe(false); // our artifact
    expect(fs.existsSync(siblingAbs(oldSib))).toBe(true); // synthetic now — the scan owns it
    expect(fs.existsSync(markAbs())).toBe(false);
  });

  it("C.22: verifySiblingFileIntegrity — a size mismatch fails WITHOUT hashing (size-first short-circuit)", async () => {
    const f = await sibling("twelve bytes\n", 1000);
    shaCalls = 0;
    // Size mismatch: recorded size ≠ file size.
    expect(
      await tx.verifySiblingFileIntegrity({ ...f, size: 5 }),
    ).toBe(false);
    expect(shaCalls).toBe(0); // never hashed
    // Full check passes with the honest size.
    expect(await tx.verifySiblingFileIntegrity(f)).toBe(true);
    expect(shaCalls).toBe(1);
    // Missing file: false, no hash.
    expect(
      await tx.verifySiblingFileIntegrity({ ...f, mtime: 9999 }),
    ).toBe(false);
    expect(shaCalls).toBe(1);
  });

  it("no mark on disk → recovery is a cheap no-op (single exists check, store not loaded)", async () => {
    let loads = 0;
    const origLoad = store.load.bind(store);
    store.load = async () => {
      loads += 1;
      return origLoad();
    };
    await tx.recoverIfNeeded();
    expect(loads).toBe(0);
  });
});
