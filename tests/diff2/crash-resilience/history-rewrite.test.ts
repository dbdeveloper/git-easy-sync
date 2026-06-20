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
import { autosaveDir } from "../../../src/diff2/autosave-store";
import { rewriteHistoryAtomic, recoverHistoryRewrite } from "../../../src/diff2/history-rewrite";

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
