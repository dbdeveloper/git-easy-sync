// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner, 2026-10-08 — History and a version that DELETED the file:
//   - one input side is a deletion AND the editor's result is empty (the
//     deleted side taken whole) → the file is DELETED from the vault, its
//     current bytes go to our Deleted bin first, no confirmation;
//   - any other empty result (no side was a deletion, the text was just
//     erased) → an empty file "\n", as before (a 0-byte file would be
//     "restored" from the repo by the zero-byte guard).
// The "this version is a deletion" fact lives in the session meta
// (baseExistedAtStart = false), so it survives a restart mid-session.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { commitHistoryResult } from "../../src/diff2/exit-commit";

const tmpdirs: string[] = [];
function fixture(): { vault: Vault; root: string } {
  const root = path.join(os.tmpdir(), `hist-del-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, "Notes"), { recursive: true });
  tmpdirs.push(root);
  return { vault: new MockVault(root) as unknown as Vault, root };
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const FILE = "Notes/x.md";

async function session(vault: Vault, current: string, version: { bytes: string; absent?: boolean }) {
  await vault.adapter.writeBinary(FILE, enc(current));
  return await startSession(vault, "hid", FILE, FILE, undefined, {
    bytes: enc(version.bytes),
    absent: version.absent,
  });
}

describe("History: a version that deleted the file", () => {
  it("🔑 the session remembers the version is a deletion (meta, survives a restart)", async () => {
    const { vault } = fixture();
    expect((await session(vault, "now\n", { bytes: "", absent: true })).baseExistedAtStart).toBe(false);
    expect((await session(vault, "now\n", { bytes: "old\n" })).baseExistedAtStart).toBe(true);
  });

  it("🔑 deletion side taken whole (empty result) → the file is deleted, its bytes captured first", async () => {
    const { vault, root } = fixture();
    const meta = await session(vault, "now\n", { bytes: "", absent: true });
    const events: string[] = [];
    const r = await commitHistoryResult(vault, "hid", meta, { base: "", sibling: "" }, async (p) => {
      events.push(`capture:${p}:${fs.existsSync(path.join(root, p))}`);
    });
    expect(r).toEqual({ path: FILE, deleted: true });
    expect(events).toEqual([`capture:${FILE}:true`]); // captured while it still existed
    expect(fs.existsSync(path.join(root, FILE))).toBe(false);
    expect(fs.existsSync(path.join(root, autosaveDir("hid")))).toBe(false);
  });

  it("deletion version but the user kept some text → written as usual", async () => {
    const { vault, root } = fixture();
    const meta = await session(vault, "now\n", { bytes: "", absent: true });
    const r = await commitHistoryResult(vault, "hid", meta, { base: "", sibling: "kept\n" }, async () => {});
    expect(r.deleted).toBe(false);
    expect(fs.readFileSync(path.join(root, FILE), "utf8")).toBe("kept\n");
  });

  it("🔑 no side is a deletion, text erased → an empty file \"\\n\", not a deletion", async () => {
    const { vault, root } = fixture();
    const meta = await session(vault, "now\n", { bytes: "old\n" });
    let captured = 0;
    const r = await commitHistoryResult(vault, "hid", meta, { base: "old\n", sibling: "" }, async () => {
      captured++;
    });
    expect(r.deleted).toBe(false);
    expect(captured).toBe(0);
    expect(fs.readFileSync(path.join(root, FILE), "utf8")).toBe("\n");
  });

  it("a failing capture does not stop the deletion (the bin is a safety net)", async () => {
    const { vault, root } = fixture();
    const meta = await session(vault, "now\n", { bytes: "", absent: true });
    const r = await commitHistoryResult(vault, "hid", meta, { base: "", sibling: "" }, async () => {
      throw new Error("disk full");
    });
    expect(r.deleted).toBe(true);
    expect(fs.existsSync(path.join(root, FILE))).toBe(false);
  });
});
