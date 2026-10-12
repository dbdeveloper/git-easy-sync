// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import { buildConflictModel, survivorOf } from "../../src/sync2/conflict-model";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { FileInfo, emptyFileInfo } from "../../src/sync2/diff3";
import { emptyConflictsState, type ConflictsState } from "../../src/sync2/conflict-store-v2";
import { calculateGitBlobSHA } from "../../src/utils";

// The conflict model (owner, 2026-10-12): ONE read-only picture of the
// conflicts, built from the drain's ledger (conflicts.json) plus the disk —
// the ground truth of what the user did since. Every reader (badge, status
// bar, panel, pre-sync gates, editor tabs, the commit pass) reads it; nothing
// in it is ever written back. Per copy:
//   live        — on disk, differs from the base, not a duplicate;
//   gone        — not on disk (deleted, renamed away) — the ledger keeps it
//                 until the drain, and the user may put it back;
//   equals-base — byte-equal to the base: the conflict is resolved;
//   duplicate   — same bytes as a copy that survives (tracked beats
//                 synthetic, then the newer timeLabel — the drain's rule).
// A base is IN FORCE while it has a live TRACKED copy.

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const sha = (s: string) => calculateGitBlobSHA(enc(s));
const BASE = "note.md";

describe("buildConflictModel", () => {
  let dir: string;
  let vault: Vault;
  const reads: string[] = [];
  const deps = () => {
    const adapter = vault.adapter;
    return {
      adapter: {
        stat: (p: string) => adapter.stat(p),
        readBinary: async (p: string) => {
          reads.push(p);
          return adapter.readBinary(p);
        },
      },
      computeSha: calculateGitBlobSHA,
    };
  };
  const put = (p: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  };
  const copyPath = (timeLabel: number, label = "phone") =>
    buildSiblingFilePath(BASE, timeLabel, label);
  // A tracked copy born with `born`, now holding `now` on disk (null = gone).
  const tracked = async (
    born: string,
    now: string | null,
    timeLabel = 2000,
    label = "phone",
  ): Promise<FileInfo> => {
    if (now !== null) put(copyPath(timeLabel, label), now);
    const f: FileInfo = {
      ...emptyFileInfo(),
      path: BASE,
      timeLabel,
      deviceLabel: label,
      sha: await sha(born),
      size: born.length,
      originSha: await sha(born),
    };
    if (now !== null && now === born) {
      const st = fs.statSync(path.join(dir, copyPath(timeLabel, label)));
      f.mtime = st.mtimeMs; // measured by the drain: the cache is valid
    }
    return f;
  };
  const ledger = (siblings: FileInfo[]): ConflictsState => {
    const s = emptyConflictsState();
    s.entries.set(BASE, {
      conflictBase: { ...emptyFileInfo(), path: BASE, sha: "cb" },
      siblings,
    });
    return s;
  };
  const stateOf = (m: Awaited<ReturnType<typeof buildConflictModel>>, p: string) =>
    m.entries.get(BASE)!.copies.find((c) => c.path === p)!.state;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "conflict-model-"));
    vault = new Vault(dir);
    reads.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a copy that differs from the base → live; the base is in force; 1 file in conflict", async () => {
    put(BASE, "ours\n");
    const m = await buildConflictModel(deps(), ledger([await tracked("theirs!!\n", "theirs!!\n")]), []);
    expect(stateOf(m, copyPath(2000))).toBe("live");
    expect(m.entries.get(BASE)!.inForce).toBe(true);
    expect(m.filesInConflict).toBe(1);
  });

  it("🔑 the field case 65→60: the copy edited (size CHANGED) into the base → equals-base, not in force", async () => {
    const base = "x".repeat(59) + "\n"; // 60 bytes
    put(BASE, base);
    const c = await tracked("y".repeat(64) + "\n", base); // born 65, now 60 = the base
    const m = await buildConflictModel(deps(), ledger([c]), []);
    expect(stateOf(m, copyPath(2000))).toBe("equals-base");
    expect(m.entries.get(BASE)!.inForce).toBe(false);
    expect(m.filesInConflict).toBe(0);
  });

  it("🔑 the BASE edited into the copy → equals-base too (the base's current size counts)", async () => {
    const theirs = "theirs!!\n";
    put(BASE, theirs);
    const m = await buildConflictModel(deps(), ledger([await tracked(theirs, theirs)]), []);
    expect(stateOf(m, copyPath(2000))).toBe("equals-base");
    expect(m.filesInConflict).toBe(0);
  });

  it("a copy of another size than the base, unchanged since measured → live, NOTHING read", async () => {
    put(BASE, "o\n");
    const m = await buildConflictModel(deps(), ledger([await tracked("a much longer copy\n", "a much longer copy\n")]), []);
    expect(stateOf(m, copyPath(2000))).toBe("live");
    expect(reads).toEqual([]);
  });

  it("gone: one copy of two gone → that one 'gone', the other keeps the file in conflict", async () => {
    put(BASE, "ours\n");
    const a = await tracked("theirs!!\n", null, 2000);
    const b = await tracked("laptop!!!\n", "laptop!!!\n", 5000, "laptop");
    const m = await buildConflictModel(deps(), ledger([a, b]), []);
    expect(stateOf(m, copyPath(2000))).toBe("gone");
    expect(stateOf(m, copyPath(5000, "laptop"))).toBe("live");
    expect(m.filesInConflict).toBe(1);
  });

  it("every copy gone → not in force (until the user puts one back, or the drain prunes)", async () => {
    put(BASE, "ours\n");
    const m = await buildConflictModel(deps(), ledger([await tracked("theirs!!\n", null)]), []);
    expect(m.entries.get(BASE)!.inForce).toBe(false);
    expect(m.filesInConflict).toBe(0);
  });

  it("base deleted, copy present → live, in force (the conflict goes on)", async () => {
    const m = await buildConflictModel(deps(), ledger([await tracked("theirs!!\n", "theirs!!\n")]), []);
    expect(stateOf(m, copyPath(2000))).toBe("live");
    expect(m.filesInConflict).toBe(1);
  });

  it("two tracked copies with the same content → the NEWER (timeLabel) is live, the older a duplicate", async () => {
    put(BASE, "ours\n");
    const older = await tracked("phone v\n", "agreed!!\n", 2000);
    const newer = await tracked("laptop v\n", "agreed!!\n", 5000, "laptop");
    const m = await buildConflictModel(deps(), ledger([older, newer]), []);
    expect(stateOf(m, copyPath(2000))).toBe("duplicate");
    expect(stateOf(m, copyPath(5000, "laptop"))).toBe("live");
    expect(m.filesInConflict).toBe(1);
  });

  it("a synthetic copy with the same content as a tracked one → the synthetic is the duplicate", async () => {
    put(BASE, "ours\n");
    const t = await tracked("phone v\n", "agreed!!\n", 2000);
    put(copyPath(9000, "stranger"), "agreed!!\n");
    const m = await buildConflictModel(deps(), ledger([t]), [{ path: copyPath(9000, "stranger"), basePath: BASE, timeLabel: 9000 }]);
    expect(stateOf(m, copyPath(9000, "stranger"))).toBe("duplicate");
    expect(stateOf(m, copyPath(2000))).toBe("live");
  });

  it("a synthetic copy equal to the base → equals-base; synthetic copies never put a base in force", async () => {
    put(BASE, "ours\n");
    put(copyPath(9000, "stranger"), "ours\n");
    put(copyPath(9500, "other"), "different\n");
    const m = await buildConflictModel(deps(), emptyConflictsState(), [
      { path: copyPath(9000, "stranger"), basePath: BASE, timeLabel: 9000 },
      { path: copyPath(9500, "other"), basePath: BASE, timeLabel: 9500 },
    ]);
    expect(stateOf(m, copyPath(9000, "stranger"))).toBe("equals-base");
    expect(stateOf(m, copyPath(9500, "other"))).toBe("live");
    expect(m.entries.get(BASE)!.inForce).toBe(false);
    expect(m.filesInConflict).toBe(0);
  });

  it("🔑 two synthetic twins of the same second → the same one survives in either listing order", async () => {
    put(BASE, "ours\n");
    const a = { path: copyPath(9000, "A"), basePath: BASE, timeLabel: 9000 };
    const b = { path: copyPath(9000, "B"), basePath: BASE, timeLabel: 9000 };
    put(a.path, "same\n");
    put(b.path, "same\n");
    const m1 = await buildConflictModel(deps(), emptyConflictsState(), [a, b]);
    const m2 = await buildConflictModel(deps(), emptyConflictsState(), [b, a]);
    expect(stateOf(m1, a.path)).toBe(stateOf(m2, a.path));
    expect(stateOf(m1, b.path)).toBe(stateOf(m2, b.path));
  });

  it("read-only: the ledger's records are left exactly as they were", async () => {
    put(BASE, "ours\n");
    const c = await tracked("theirs!!\n", "ours\n");
    const before = JSON.stringify(c);
    await buildConflictModel(deps(), ledger([c]), []);
    expect(JSON.stringify(c)).toBe(before);
  });
});

// 🔑 Which of two identical copies stays must not depend on listing order
// (advisor, 2026-10-12): the drain lists a directory, the cleanup reads
// Obsidian's index — on a same-second tie each could keep a DIFFERENT copy
// and remove the other, and the bytes would be gone. One rule for both:
// tracked beats synthetic, then the newer timeLabel, then the path.
describe("survivorOf — one total order for drain and cleanup", () => {
  const c = (path: string, timeLabel: number, tracked = false) => ({ path, timeLabel, tracked });
  const key = (x: ReturnType<typeof c>) => x;

  it("same second, two labels → the same survivor whatever the order", () => {
    const a = c("n.conflict-from-A-x.md", 1000);
    const b = c("n.conflict-from-B-x.md", 1000);
    expect(survivorOf([a, b], key)).toBe(survivorOf([b, a], key));
  });

  it("tracked beats synthetic, then the newer", () => {
    expect(survivorOf([c("s", 9000), c("t", 1000, true)], key).path).toBe("t");
    expect(survivorOf([c("old", 1000), c("new", 2000)], key).path).toBe("new");
  });

});
