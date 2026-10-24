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
    timeLabel: number,
    label = "phone",
    onDisk = true,
  ): Promise<FileInfo> => {
    const f: FileInfo = {
      ...emptyFileInfo(),
      path: basePath,
      sha: await sha(content),
      size: content.length,
      timeLabel,
      deviceLabel: label,
      mode: "",
      originSha: await sha(content), // born from this remote version
    };
    if (onDisk) {
      putFile(buildSiblingFilePath(basePath, timeLabel, label), content);
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
    timeLabel: number,
    label = "phone",
  ): boolean =>
    fs.existsSync(path.join(dir, buildSiblingFilePath(basePath, timeLabel, label)));

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

  it("🔑 a synthetic copy the cleanup removed first (after exists, before remove) is not a drain failure", async () => {
    // The synthetic-copy cleanup runs alongside the drain (owner,
    // 2026-10-12); both may remove the same leftover.
    putFile("note.md", "base\n");
    const state = emptyConflictsState();
    entry(state, "note.md", [await tracked("note.md", "dup content\n", 2000)]);
    const twin = buildSiblingFilePath("note.md", 9000, "stranger");
    putFile(twin, "dup content\n");
    const adapter = vault.adapter;
    Object.defineProperty(vault, "adapter", { get: () => adapter, configurable: true });
    const exists = adapter.exists.bind(adapter);
    adapter.exists = async (p: string) => {
      const r = await exists(p);
      if (p === twin) fs.rmSync(path.join(dir, twin), { force: true }); // the cleanup got there first
      return r;
    };
    // Obsidian's adapter.remove throws on a missing file (the test double
    // is lenient).
    adapter.remove = async (p: string) => {
      if (!fs.existsSync(path.join(dir, p))) throw new Error(`ENOENT: ${p}`);
      fs.rmSync(path.join(dir, p));
    };
    await expect(processConflicts(deps(), state)).resolves.toBeDefined();
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

  // Field, 2026-10-11 (owner, ~/Obsidian-test): the user EDITED the tracked
  // copy until it matched the base. The record still carries the sha the
  // copy was born with, so a rule reading the record never fires — I.4
  // above could not see it, because its copy is born already equal.
  it("I.4c: a tracked copy the user EDITED to match the base → resolved (the file's bytes decide, not the record)", async () => {
    putFile("note.md", "reconciled\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "their version\n", 2000);
    putFile(buildSiblingFilePath("note.md", 2000, "phone"), "reconciled\n");
    entry(state, "note.md", [t]);

    const result = await processConflicts(deps(), state);
    expect(result.entries.has("note.md")).toBe(false);
    expect(siblingExists("note.md", 2000)).toBe(false);
  });

  it("I.4d: a tracked copy edited to something ELSE than the base stays, and so does the conflict", async () => {
    putFile("note.md", "reconciled\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "their version\n", 2000);
    putFile(buildSiblingFilePath("note.md", 2000, "phone"), "half-merged\n");
    entry(state, "note.md", [t]);

    const result = await processConflicts(deps(), state);
    expect(result.entries.get("note.md")?.siblings).toHaveLength(1);
    expect(siblingExists("note.md", 2000)).toBe(true);
  });

  // Cost (owner, 2026-10-11, option 2): the reconciler runs at onload, panel
  // open, editor exit and every drain start. A copy whose SIZE differs from
  // the base cannot match it, so its bytes are never read or hashed — only a
  // same-size copy pays for the SHA.
  it("I.4e: a measured copy of a different size is not read, nor the base — SHA only on equal size", async () => {
    putFile("note.md", "reconciled\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "their much longer version\n", 2000);
    measure(t, "note.md"); // the cache is valid: an UNmeasured copy is read once to fill it
    entry(state, "note.md", [t]);
    const siblingPath = buildSiblingFilePath("note.md", 2000, "phone");
    // mock-obsidian builds a NEW adapter object on every `vault.adapter`
    // read, so patching it in place is lost — spy through a proxy.
    const reads: string[] = [];
    const adapter = vault.adapter;
    const spied = {
      ...adapter,
      readBinary: async (p: string) => {
        reads.push(p);
        return adapter.readBinary(p);
      },
    };
    const spyVault = new Proxy(vault, {
      get: (target, prop, receiver) =>
        prop === "adapter" ? spied : Reflect.get(target, prop, receiver),
    });

    const result = await processConflicts(
      { ...deps(), vault: spyVault as never },
      state,
    );
    expect(reads).not.toContain(siblingPath);
    expect(result.entries.get("note.md")?.siblings).toHaveLength(1);
    expect(siblingExists("note.md", 2000)).toBe(true);
  });

  // ── The copy's content cache (owner, 2026-10-11) ─────────────────────
  // A tracked record keeps {sha, size, mtime} of its copy's FILE as last
  // measured — the same rule the engine applies to every vault file: while
  // size and mtime are unchanged the stored sha is trusted; a change (or no
  // measurement yet) re-reads the file and refreshes the record. The NAME
  // timestamp lives in `timeLabel`, the copy's identity.
  const spied = () => {
    const reads: string[] = [];
    const adapter = vault.adapter;
    const a = {
      ...adapter,
      readBinary: async (p: string) => {
        reads.push(p);
        return adapter.readBinary(p);
      },
    };
    const v = new Proxy(vault, {
      get: (t, prop, r) => (prop === "adapter" ? a : Reflect.get(t, prop, r)),
    });
    return { reads, deps: { ...deps(), vault: v as never } };
  };
  const copyPath = (base: string, timeLabel: number, label = "phone") =>
    buildSiblingFilePath(base, timeLabel, label);
  const measure = (f: FileInfo, base: string): void => {
    const st = fs.statSync(path.join(dir, copyPath(base, f.timeLabel!, f.deviceLabel!)));
    f.size = st.size;
    f.mtime = st.mtimeMs;
  };

  describe("the copy's content cache", () => {
    it("🔑 size and mtime unchanged → the stored sha is used, the copy is NOT read", async () => {
      putFile("note.md", "same size!\n");
      const state = emptyConflictsState();
      const t = await tracked("note.md", "SAME SIZE!\n", 2000); // same size as the base
      measure(t, "note.md");
      entry(state, "note.md", [t]);
      const { reads, deps: d } = spied();

      await processConflicts(d, state);

      expect(reads).not.toContain(copyPath("note.md", 2000));
      expect(siblingExists("note.md", 2000)).toBe(true);
    });

    it("🔑 the copy was edited (mtime moved) → re-read, and the record now describes the file", async () => {
      putFile("note.md", "base\n");
      const state = emptyConflictsState();
      const t = await tracked("note.md", "their version\n", 2000);
      measure(t, "note.md");
      entry(state, "note.md", [t]);
      putFile(copyPath("note.md", 2000), "edited by hand\n");
      fs.utimesSync(path.join(dir, copyPath("note.md", 2000)), 99, 99);

      const result = await processConflicts(deps(), state);

      const rec = result.entries.get("note.md")!.siblings[0];
      expect(rec.sha).toBe(await sha("edited by hand\n"));
      expect(rec.size).toBe("edited by hand\n".length);
      expect(rec.mtime).toBe(99_000);
      expect(rec.originSha).toBe(t.originSha); // where it came from stays
      expect(saves).toBe(1);
    });

    it("no measurement yet (mtime null) → measured once, then trusted", async () => {
      putFile("note.md", "same size!\n");
      const state = emptyConflictsState();
      const t = await tracked("note.md", "SAME SIZE!\n", 2000);
      t.mtime = null;
      entry(state, "note.md", [t]);
      const first = spied();
      const after = await processConflicts(first.deps, state);
      expect(first.reads).toContain(copyPath("note.md", 2000));

      const second = spied();
      await processConflicts(second.deps, after);
      expect(second.reads).not.toContain(copyPath("note.md", 2000));
    });
  });

  // Owner, 2026-10-11: a copy that disappears must say WHY in the log — the
  // field question "my copy vanished at sync" could only be answered by
  // asking the user what they had done to it.
  describe("every removed copy is logged with its reason", () => {
    const logged = () => {
      const lines: Array<{ message: string; data: Record<string, unknown> }> = [];
      // Removals are WARN since 2026-10-24 (every conflict event is); the
      // reason text is what these tests pin, whatever the level.
      const push = (message: string, data?: unknown) =>
        lines.push({ message, data: (data ?? {}) as Record<string, unknown> });
      const logger = { info: push, warn: push };
      return { lines, deps: { ...deps(), logger } };
    };

    it("identical to the file → 'identical to the file', naming the copy", async () => {
      putFile("note.md", "same\n");
      const state = emptyConflictsState();
      entry(state, "note.md", [await tracked("note.md", "same\n", 2000)]);
      const { lines, deps: d } = logged();

      await processConflicts(d, state);

      const line = lines.find((l) => /identical to the file/i.test(l.message));
      expect(line?.data).toMatchObject({ path: "note.md", copy: copyPath("note.md", 2000) });
    });

    it("identical to another copy → 'identical to another copy', naming the one kept", async () => {
      putFile("note.md", "base\n");
      const state = emptyConflictsState();
      const older = await tracked("note.md", "agreed\n", 2000);
      const newer = await tracked("note.md", "agreed\n", 5000, "laptop");
      entry(state, "note.md", [older, newer]);
      const { lines, deps: d } = logged();

      await processConflicts(d, state);

      const line = lines.find((l) => /identical to another copy/i.test(l.message));
      expect(line?.data).toMatchObject({
        path: "note.md",
        copy: copyPath("note.md", 2000),
        kept: copyPath("note.md", 5000, "laptop"),
      });
    });

    it("gone from disk (deleted or renamed by the user) → 'no longer on disk'", async () => {
      putFile("note.md", "base\n");
      const state = emptyConflictsState();
      entry(state, "note.md", [await tracked("note.md", "theirs\n", 2000, "phone", false)]);
      const { lines, deps: d } = logged();

      await processConflicts(d, state);

      const line = lines.find((l) => /no longer on disk/i.test(l.message));
      expect(line?.data).toMatchObject({ path: "note.md", copy: copyPath("note.md", 2000) });
    });
  });

  describe("2.2 dedup decides by the copies' CURRENT content", () => {
    it("🔑 two tracked copies edited to the same content → the newer (by timeLabel) survives", async () => {
      putFile("note.md", "base\n");
      const state = emptyConflictsState();
      const older = await tracked("note.md", "phone version\n", 2000);
      const newer = await tracked("note.md", "laptop version\n", 5000, "laptop");
      entry(state, "note.md", [older, newer]);
      putFile(copyPath("note.md", 2000), "agreed\n");
      putFile(copyPath("note.md", 5000, "laptop"), "agreed\n");

      const result = await processConflicts(deps(), state);

      expect(siblingExists("note.md", 2000)).toBe(false);
      expect(siblingExists("note.md", 5000, "laptop")).toBe(true);
      expect(result.entries.get("note.md")!.siblings.map((s) => s.timeLabel)).toEqual([5000]);
    });

    it("a tracked copy edited to equal a synthetic one → the tracked survives", async () => {
      putFile("note.md", "base\n");
      const state = emptyConflictsState();
      const t = await tracked("note.md", "phone version\n", 2000);
      entry(state, "note.md", [t]);
      putFile(copyPath("note.md", 2000), "agreed\n");
      putFile(copyPath("note.md", 9000, "stranger"), "agreed\n");

      await processConflicts(deps(), state);

      expect(siblingExists("note.md", 2000)).toBe(true);
      expect(siblingExists("note.md", 9000, "stranger")).toBe(false);
    });

    it("🔑 born equal, one EDITED since → both stay (no data loss)", async () => {
      putFile("note.md", "base\n");
      const state = emptyConflictsState();
      const a = await tracked("note.md", "same birth\n", 2000);
      const b = await tracked("note.md", "same birth\n", 5000, "laptop");
      entry(state, "note.md", [a, b]);
      putFile(copyPath("note.md", 2000), "my edit in the older copy\n");

      await processConflicts(deps(), state);

      expect(siblingExists("note.md", 2000)).toBe(true);
      expect(siblingExists("note.md", 5000, "laptop")).toBe(true);
    });

    it("measured copies are not read at all — and neither is the base when no copy has its size", async () => {
      putFile("note.md", "b\n");
      const state = emptyConflictsState();
      const a = await tracked("note.md", "short\n", 2000);
      const b = await tracked("note.md", "a much longer one\n", 5000, "laptop");
      measure(a, "note.md");
      measure(b, "note.md");
      entry(state, "note.md", [a, b]);
      const { reads, deps: d } = spied();

      await processConflicts(d, state);

      expect(reads).toEqual([]);
    });

    it("synthetic duplicates: the newer NAME wins, whatever the files' mtimes say", async () => {
      putFile("note.md", "base\n");
      const state = emptyConflictsState();
      const t = await tracked("note.md", "tracked content\n", 100);
      entry(state, "note.md", [t]);
      putFile(copyPath("note.md", 3000, "a"), "syn dup\n");
      putFile(copyPath("note.md", 7000, "b"), "syn dup\n");
      // The OLDER name was touched last — the name decides, not the file.
      fs.utimesSync(path.join(dir, copyPath("note.md", 3000, "a")), 9, 9);
      fs.utimesSync(path.join(dir, copyPath("note.md", 7000, "b")), 1, 1);

      await processConflicts(deps(), state);

      expect(siblingExists("note.md", 3000, "a")).toBe(false);
      expect(siblingExists("note.md", 7000, "b")).toBe(true);
    });
  });

  it("I.4b: a synthetic that matches the base with NO tracked twin — only 2.3 can reach it", async () => {
    // Found by mutation probe (§IX.3, 2026-09-23): disabling the
    // synthetic half of 2.3 left the suite green. I.4 above looks like
    // it covers this, but its synthetic shares a sha with its tracked
    // sibling, so the 2.2 dedup group deletes the file before 2.3 ever
    // looks at it — the assertion passes for the wrong reason.
    //
    // Here the tracked sibling says something else entirely, so no
    // group forms and the record must survive. The synthetic is the
    // only thing that already agrees with the base, and deleting it is
    // the whole of the action: it was never in the list, so nothing
    // else records that it went.
    putFile("note.md", "reconciled\n");
    const state = emptyConflictsState();
    const t = await tracked("note.md", "still divergent\n", 2000);
    entry(state, "note.md", [t]);
    const synthetic = buildSiblingFilePath("note.md", 8000, "other");
    putFile(synthetic, "reconciled\n");

    const result = await processConflicts(deps(), state);
    expect(fs.existsSync(path.join(dir, synthetic))).toBe(false);
    // …and the real conflict is untouched by the cleanup.
    expect(result.entries.get("note.md")!.siblings).toHaveLength(1);
    expect(siblingExists("note.md", 2000)).toBe(true);
  });

  it("I.5: base+sibling moved away (both files gone from the old path) → the old record prunes cleanly; the new-path synthetic pair belongs to the diff2 scan (Phase 5.5)", async () => {
    // No files created at all — the user moved them elsewhere.
    const state = emptyConflictsState();
    const t: FileInfo = {
      ...emptyFileInfo(),
      path: "old/place.md",
      sha: "sha-x",
      timeLabel: 100,
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
    expect(savesAfterFirst).toBeLessThanOrEqual(1); // at most the cache fill
    const second = await processConflicts(deps(), first);
    expect(second.entries.get("note.md")!.siblings).toHaveLength(1);
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



});
