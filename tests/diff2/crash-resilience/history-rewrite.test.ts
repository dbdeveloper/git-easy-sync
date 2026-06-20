// §0.5.5 carousel — crash-resilience of the history.jsonl atomic compaction-swap.
// A crash at ANY step of rewriteHistoryAtomic must leave a consistent history.jsonl
// (old OR new, never lost/torn) after recoverHistoryRewrite (the onload sweep).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../../mock-obsidian";
import type { Vault } from "obsidian";
import { readFileSync } from "node:fs";
import { autosaveDir } from "../../../src/diff2/autosave-store";
import {
  compactSessionLog,
  rewriteHistoryAtomic,
  recoverHistoryRewrite,
} from "../../../src/diff2/history-rewrite";
import { assessHistoryV2, scanHistoryV2 } from "../../../src/diff2/history-replay-v2";

const ID = "rewrite-crash";
const OLD = "old-line-1\nold-line-2\nold-line-3\n";
const NEW = "new-line-1\n"; // compacted (shorter)

function fixture() {
  const root = path.join(os.tmpdir(), `histrw-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}
const dir = () => autosaveDir(ID);
const P = () => `${dir()}/history.jsonl`;
const TMP = () => `${P()}.sync-tmp`;
const BAK = () => `${P()}.sync-bak`;

async function read(vault: Vault, p: string): Promise<string | null> {
  return (await vault.adapter.exists(p)) ? vault.adapter.read(p) : null;
}
async function mkdir(vault: Vault): Promise<void> {
  await vault.adapter.mkdir(dir());
}
async function endState(vault: Vault) {
  return {
    history: await read(vault, P()),
    tmp: await read(vault, TMP()),
    bak: await read(vault, BAK()),
  };
}

describe("rewriteHistoryAtomic — happy path", () => {
  it("replaces history.jsonl with the new content; no tmp/bak left behind", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    await vault.adapter.write(P(), OLD);
    await rewriteHistoryAtomic(vault, ID, NEW);
    expect(await endState(vault)).toEqual({ history: NEW, tmp: null, bak: null });
  });
});

describe("recoverHistoryRewrite — every interrupted state ends consistent", () => {
  it("crash after step 1 (tmp written, no bak, old history) → OLD kept, tmp discarded", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    await vault.adapter.write(P(), OLD);
    await vault.adapter.write(TMP(), NEW); // step 1 done, crashed
    await recoverHistoryRewrite(vault, ID);
    expect(await endState(vault)).toEqual({ history: OLD, tmp: null, bak: null });
  });

  it("crash between step 3 and 4 (history→bak, tmp present, no history) → NEW promoted", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    await vault.adapter.write(TMP(), NEW);
    await vault.adapter.write(BAK(), OLD); // history already moved to bak
    await recoverHistoryRewrite(vault, ID);
    expect(await endState(vault)).toEqual({ history: NEW, tmp: null, bak: null });
  });

  it("crash between 3 and 4 but tmp gone/torn (no history, bak only) → OLD restored", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    await vault.adapter.write(BAK(), OLD); // history moved to bak, tmp lost
    await recoverHistoryRewrite(vault, ID);
    expect(await endState(vault)).toEqual({ history: OLD, tmp: null, bak: null });
  });

  it("crash after step 4 (history=new, bak present) → NEW kept, bak dropped", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    await vault.adapter.write(P(), NEW);
    await vault.adapter.write(BAK(), OLD); // step 4 done, crashed before step 5
    await recoverHistoryRewrite(vault, ID);
    expect(await endState(vault)).toEqual({ history: NEW, tmp: null, bak: null });
  });

  it("nothing in flight (only history) → no-op", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    await vault.adapter.write(P(), OLD);
    await recoverHistoryRewrite(vault, ID);
    expect(await endState(vault)).toEqual({ history: OLD, tmp: null, bak: null });
  });
});

// THE reopen-trigger integration (advisor: test the call site, not the function).
describe("compactSessionLog — the reopen-trigger end-to-end on disk", () => {
  const fx = (n: string) =>
    readFileSync(`${process.cwd()}/tests/diff2/fixtures/${n}`, "utf8");

  it("real bug-31 log: reopen shrinks the on-disk file AND drops the surfaced count's bloat", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    const original = fx("bug31-history.jsonl");
    await vault.adapter.write(P(), original);

    const before = scanHistoryV2(original);
    const rewrote = await compactSessionLog(vault, ID);
    expect(rewrote).toBe(true);

    const onDisk = await vault.adapter.read(P()); // what the modal/replay now read
    const after = scanHistoryV2(onDisk);
    expect(after.blocks.length).toBeLessThan(before.blocks.length); // 428 → fewer on disk
    expect(onDisk.length).toBeLessThan(original.length); // bytes dropped
    expect(after.stoppedAtCorrupt).toBe(false); // rewritten log is valid (checksums hold)
    // the live undo depth ("edits saved") is preserved (conservative, net-invariant).
    expect(assessHistoryV2(onDisk).edits).toBe(assessHistoryV2(original).edits);
    // no swap leftovers.
    expect(await endState(vault)).toMatchObject({ tmp: null, bak: null });
  });

  it("already-compact (clean) log → NO rewrite (no churn): bytes untouched", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    // compact the bloated log ONCE, write that as the on-disk log, reopen again.
    const compactedOnce = (() => {
      // run the trigger once to produce a clean log
      return fx("bug31-history.jsonl");
    })();
    await vault.adapter.write(P(), compactedOnce);
    await compactSessionLog(vault, ID); // first reopen compacts
    const afterFirst = await vault.adapter.read(P());
    const rewroteAgain = await compactSessionLog(vault, ID); // second reopen
    expect(rewroteAgain).toBe(false); // clean log → no-op
    expect(await vault.adapter.read(P())).toBe(afterFirst); // byte-identical, untouched
  });

  it("missing history.jsonl → no-op (returns false)", async () => {
    const { vault } = fixture();
    await mkdir(vault);
    expect(await compactSessionLog(vault, ID)).toBe(false);
  });
});
