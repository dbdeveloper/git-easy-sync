// Stage 3c — §4.2 onload cleanup sweep. Node env (real fs over tmpdir);
// composes Stage 2.0 startSession for real sessions, then mutates to trigger
// each cleanup condition.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { classifySweep, sweepAll } from "../../src/diff2/autosave-cleanup";
import { buildEditBlock, serializeBlock } from "../../src/diff2/history-log-v2";

const NOW = "2026-06-02T12:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(os.tmpdir(), `cleanup-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

const file = (id: string, name: string) => `${autosaveDir(id)}/${name}`;

// Append one valid (checksummed) V2 history record so the session is NOT empty —
// the §4.1 zero-edit invariant (cond 2b) sweeps a 0-record session, so a "keep"
// case must have recorded at least one edit. The change payload only has to
// round-trip through assessHistoryV2's parse+checksum (not a real replay);
// newGroup=true (delta 1) gives a net edit count of 1.
async function recordOne(vault: Vault, id: string) {
  const block = serializeBlock(buildEditBlock(1, NOW, [10], [], 1));
  await vault.adapter.append(file(id, "history.jsonl"), block + "\n");
}

// Start a real session for `id` with distinct input files; base ≠ sibling.
// Records one edit by default (a keepable session); pass records=0 for the
// empty-history (zero-edit) case.
async function seed(
  vault: Vault,
  id: string,
  base = "base v1\n",
  sib = "sib v1\n",
  records = 1,
) {
  const bp = `b-${id}.md`;
  const sp = `s-${id}.md`;
  await vault.adapter.writeBinary(bp, enc(base));
  await vault.adapter.writeBinary(sp, enc(sib));
  await startSession(vault, id, bp, sp, NOW);
  if (records > 0) await recordOne(vault, id);
  return { bp, sp };
}

describe("classifySweep — §4.2 conditions", () => {
  let fx: ReturnType<typeof fixture>;
  const id = "tracked-c";
  const classify = () => classifySweep(fx.vault, id);

  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("valid session → keep", async () => {
    await seed(fx.vault, id);
    expect(await classify()).toEqual({ action: "keep" });
  });

  it("vault input changed but snapshots intact → keep (NOT a sweep trigger; §3 dialog)", async () => {
    const { bp } = await seed(fx.vault, id);
    await fx.vault.adapter.writeBinary(bp, enc("base v2 — pulled\n")); // input ≠ meta, snapshot unchanged
    expect(await classify()).toEqual({ action: "keep" });
  });

  it("done.json present → defer-to-commit (precedence over §4.2)", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.write(file(id, "done.json"), "{}");
    expect(await classify()).toEqual({ action: "defer-to-commit" });
  });

  it("no meta → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "meta.json"));
    expect(await classify()).toEqual({ action: "sweep", reason: "no-meta" });
  });

  it("no history → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "history.jsonl"));
    expect(await classify()).toEqual({ action: "sweep", reason: "no-history" });
  });

  it("empty history (0 records) → sweep (§4.1 zero-edit invariant, cond 2b)", async () => {
    await seed(fx.vault, id, "base v1\n", "sib v1\n", 0); // history.jsonl empty
    expect(await classify()).toEqual({ action: "sweep", reason: "empty-history" });
  });

  it("a corrupt-FIRST-block history (0 trustworthy, but user activity) → NOT empty-swept", async () => {
    await seed(fx.vault, id, "base v1\n", "sib v1\n", 0);
    await fx.vault.adapter.write(file(id, "history.jsonl"), "{ not valid json\n");
    // assessHistory.empty is false (stoppedAtCorrupt) → cond 2b does NOT fire;
    // the session is kept for the §3.5 corrupt-recovery modal.
    expect(await classify()).toEqual({ action: "keep" });
  });

  it("no cursor (NEITHER ping-pong slot) → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "cursor-a.json")); // only slot at start
    expect(await classify()).toEqual({ action: "sweep", reason: "no-cursor" });
  });

  it("only cursor-b present (slot A swept by ping-pong) → keep", async () => {
    await seed(fx.vault, id);
    // simulate a live session that has ping-ponged onto slot B then lost A.
    await fx.vault.adapter.write(
      file(id, "cursor-b.json"),
      JSON.stringify({ v: 1, seq: 1, anchor: 0, head: 0, scrollTop: 0, savedAt: "x" }),
    );
    await fx.vault.adapter.remove(file(id, "cursor-a.json"));
    expect(await classify()).toEqual({ action: "keep" });
  });

  it("missing snapshot → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "sibling.snapshot"));
    expect(await classify()).toEqual({ action: "sweep", reason: "no-snapshot" });
  });

  it("snapshot SHA ≠ meta → sweep (corruption)", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.writeBinary(file(id, "base.snapshot"), enc("tampered\n"));
    expect(await classify()).toEqual({ action: "sweep", reason: "snapshot-sha-mismatch" });
  });

  it("input file missing → sweep", async () => {
    const { bp } = await seed(fx.vault, id);
    await fx.vault.adapter.remove(bp);
    expect(await classify()).toEqual({ action: "sweep", reason: "input-missing" });
  });

  it("inputs now byte-identical → sweep (self-resolved)", async () => {
    const { bp, sp } = await seed(fx.vault, id);
    await fx.vault.adapter.writeBinary(bp, enc("MERGED\n"));
    await fx.vault.adapter.writeBinary(sp, enc("MERGED\n"));
    expect(await classify()).toEqual({ action: "sweep", reason: "self-resolved" });
  });
});

describe("sweepAll — list, rmdir condemned, defer commits, keep valid", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("no autosave root → []", async () => {
    expect(await sweepAll(fx.vault)).toEqual([]);
  });

  it("mixed dirs: sweeps invalid, keeps valid, defers commit", async () => {
    await seed(fx.vault, "keep-me"); // valid
    await seed(fx.vault, "no-meta");
    await fx.vault.adapter.remove(file("no-meta", "meta.json"));
    const { bp, sp } = await seed(fx.vault, "resolved");
    await fx.vault.adapter.writeBinary(bp, enc("SAME\n"));
    await fx.vault.adapter.writeBinary(sp, enc("SAME\n"));
    await seed(fx.vault, "committing");
    await fx.vault.adapter.write(file("committing", "done.json"), "{}");

    const results = await sweepAll(fx.vault);
    const byId = new Map(results.map((r) => [r.conflictId, r.decision.action]));
    expect(byId.get("keep-me")).toBe("keep");
    expect(byId.get("no-meta")).toBe("sweep");
    expect(byId.get("resolved")).toBe("sweep");
    expect(byId.get("committing")).toBe("defer-to-commit");

    // Condemned dirs gone; keeper + deferred remain.
    expect(await fx.vault.adapter.exists(autosaveDir("keep-me"))).toBe(true);
    expect(await fx.vault.adapter.exists(autosaveDir("no-meta"))).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir("resolved"))).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir("committing"))).toBe(true);
  });

  it("§4.5.3 (B1): SKIPS ephemeral history-/deleted- dirs even when condemnable", async () => {
    // A history dir has base===sibling paths → its content is identical → cond-7
    // "self-resolved" would normally CONDEMN it. The conflict sweep must NOT touch it
    // (the layoutReady orphan-sweep owns ephemeral dirs). Seed it self-resolved.
    const { bp, sp } = await seed(fx.vault, "history-eph");
    await fx.vault.adapter.writeBinary(bp, enc("SAME\n"));
    await fx.vault.adapter.writeBinary(sp, enc("SAME\n"));
    await seed(fx.vault, "deleted-eph");

    const results = await sweepAll(fx.vault);
    const ids = results.map((r) => r.conflictId);
    expect(ids).not.toContain("history-eph"); // not even classified
    expect(ids).not.toContain("deleted-eph");
    // Both dirs survive the conflict sweep.
    expect(await fx.vault.adapter.exists(autosaveDir("history-eph"))).toBe(true);
    expect(await fx.vault.adapter.exists(autosaveDir("deleted-eph"))).toBe(true);
  });

  it("idempotent: a second sweep keeps the survivors (§4.3)", async () => {
    await seed(fx.vault, "keep-me");
    await seed(fx.vault, "doomed");
    await fx.vault.adapter.remove(file("doomed", "cursor-a.json"));
    await sweepAll(fx.vault);
    const second = await sweepAll(fx.vault);
    expect(second.map((r) => r.conflictId)).toEqual(["keep-me"]);
    expect(second[0].decision.action).toBe("keep");
  });
});
