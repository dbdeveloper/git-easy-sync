// The drain must STAGE our own plugin's loadable files, never write
// them live (owner, 2026-10-01: "може і не робить, але МУСИТЬ
// робити").
//
// WHY IT MATTERS MORE THAN FOR ANY OTHER FILE. Every torn write in this
// vault is repaired at our next onload — except one. If `main.js` is
// damaged or missing, Obsidian does not load us, so the repair code
// never runs and the user is left reinstalling by hand. So the live
// file is touched at exactly ONE moment: the top of onload, by the
// bootloader, while the OLD code is running and healthy.
//
// The drain's job is therefore to put the new bytes beside the live
// file (`main.ges-tmp.js`) and raise the marker that says "this one is
// complete". Nothing else.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { Vault as MockVault } from "../../mock-obsidian";
import { makeVaultFileReader } from "../../src/sync2/vault-file-reader";
import { calculateGitBlobSHA } from "../../src/utils";

const PLUGIN_ID = "git-easy-sync";
const DIR = `.obsidian/plugins/${PLUGIN_ID}`;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "self-update-"));
  const vault = new MockVault(root);
  const files = makeVaultFileReader({
    vault: vault as never,
    computeSha: calculateGitBlobSHA,
    selfPluginId: PLUGIN_ID,
  });
  return {
    root,
    vault,
    files,
    abs: (rel: string) => path.join(root, rel),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("staging our own plugin's files", () => {
  it("🔑 the LIVE file is untouched; the staged pair appears beside it", async () => {
    const f = fixture();
    try {
      await f.vault.adapter.write(`${DIR}/main.js`, "RUNNING CODE");
      await f.files.stageSelfUpdate(`${DIR}/main.js`, enc("NEW CODE"));

      // The one assertion that matters: what Obsidian loads did not move.
      expect(readFileSync(f.abs(`${DIR}/main.js`), "utf8")).toBe(
        "RUNNING CODE",
      );
      expect(existsSync(f.abs(`${DIR}/main.ges-tmp.js`))).toBe(true);
      expect(readFileSync(f.abs(`${DIR}/main.ges-tmp.js`), "utf8")).toBe(
        "NEW CODE",
      );
      // The marker is the bootloader's integrity signal — and it names
      // the sha the staged file must hash to, so "the write returned"
      // cannot be mistaken for "the bytes are on disk".
      expect(existsSync(f.abs(`${DIR}/.main.js.ges-tmp.`))).toBe(true);
      expect(readFileSync(f.abs(`${DIR}/.main.js.ges-tmp.`), "utf8")).toBe(
        await calculateGitBlobSHA(enc("NEW CODE")),
      );
    } finally {
      f.cleanup();
    }
  });

  it("the marker is raised AFTER the bytes, never before", async () => {
    // Ordering is the whole integrity contract (bootloader case C): a
    // marker beside a half-written staging file would make the
    // bootloader apply garbage over working code.
    //
    // ⚠️ The spies go on a SNAPSHOT of the adapter, and the reader is
    // built over that snapshot. mock-obsidian's `get adapter()` returns
    // a brand-new object on every access, so patching
    // `vault.adapter.X` is a silent no-op — a test written that way
    // passes while observing nothing (the harness trap of 2026-09-28).
    const f = fixture();
    const order: string[] = [];
    try {
      const adapter = f.vault.adapter;
      const realWrite = adapter.writeBinary.bind(adapter);
      adapter.writeBinary = async (p: string, b: ArrayBuffer) => {
        order.push(`bytes:${p}`);
        return realWrite(p, b);
      };
      const realText = adapter.write.bind(adapter);
      adapter.write = async (p: string, c: string) => {
        order.push(`text:${p}`);
        return realText(p, c);
      };
      const files = makeVaultFileReader({
        vault: { adapter, configDir: ".obsidian" } as never,
        computeSha: calculateGitBlobSHA,
        selfPluginId: PLUGIN_ID,
      });
      await files.stageSelfUpdate(`${DIR}/main.js`, enc("NEW"));
      const tmpAt = order.findIndex((o) => o.includes("ges-tmp.js"));
      const markerAt = order.findIndex((o) => o.includes(".main.js.ges-tmp."));
      expect(tmpAt).toBeGreaterThanOrEqual(0);
      expect(markerAt).toBeGreaterThan(tmpAt);
    } finally {
      f.cleanup();
    }
  });

  it("re-staging the SAME bytes is recognised, so a sync does not re-download them", async () => {
    const f = fixture();
    try {
      const bytes = enc("NEW CODE");
      const sha = await calculateGitBlobSHA(bytes);
      expect(await f.files.isSelfUpdateStaged(`${DIR}/main.js`, sha)).toBe(
        false,
      );
      await f.files.stageSelfUpdate(`${DIR}/main.js`, bytes);
      expect(await f.files.isSelfUpdateStaged(`${DIR}/main.js`, sha)).toBe(
        true,
      );
      // A DIFFERENT update supersedes it — the answer is about these
      // bytes, not about "something is staged".
      expect(
        await f.files.isSelfUpdateStaged(`${DIR}/main.js`, "other-sha"),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("a staged pair with no marker is not mistaken for a complete one", async () => {
    const f = fixture();
    try {
      const bytes = enc("HALF");
      const sha = await calculateGitBlobSHA(bytes);
      await f.vault.adapter.writeBinary(`${DIR}/main.ges-tmp.js`, bytes);
      expect(await f.files.isSelfUpdateStaged(`${DIR}/main.js`, sha)).toBe(
        false,
      );
    } finally {
      f.cleanup();
    }
  });
});
