// Stage 2.0 — crash resilience of the session-start protocol
// (DIFF-EDITOR.md §2.5.a).
//
// The load-bearing invariant: meta.json is written LAST, so
//   meta.json present  ⇔  the session is fully initialised
//   meta.json absent   ⇒  classifyReopen returns "fresh" (no half session)
//
// We crash startSession after each protocol step by making the vault
// adapter throw on the writeBinary that stages the NEXT file
// (atomicWriteFile = writeBinary(<x>.ges-tmp) → rename → final path), then
// assert the on-disk state. Node env (real fs over tmpdir), not happy-dom.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../../mock-obsidian";
import type { Vault } from "obsidian";
import {
  autosaveDir,
  classifyReopen,
  readMeta,
  startSession,
} from "../../../src/diff2/autosave-store";

const NOW = "2026-06-02T12:00:00.000Z";
const ID = "tracked-crash";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `autosave-crash-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

// Make adapter.writeBinary throw whenever its path contains `marker`,
// simulating a crash as that file's staging write begins. mock-obsidian's
// `adapter` is a getter that returns a FRESH object literal each access, so
// we override the getter on the instance and re-wrap writeBinary every time.
function crashOnStaging(vault: Vault, marker: string): void {
  const proto = Object.getPrototypeOf(vault);
  const origGet = Object.getOwnPropertyDescriptor(proto, "adapter")!.get!;
  Object.defineProperty(vault, "adapter", {
    configurable: true,
    get() {
      const real = origGet.call(this) as {
        writeBinary: (p: string, b: ArrayBuffer) => Promise<void>;
      };
      const origWB = real.writeBinary;
      real.writeBinary = async (p: string, b: ArrayBuffer) => {
        if (p.includes(marker)) throw new Error(`simulated crash staging ${p}`);
        return origWB(p, b);
      };
      return real;
    },
  });
}

interface Scenario {
  name: string;
  marker: string; // staging-path substring that triggers the crash
  present: string[]; // final files that should have been committed before the crash
}

const SCENARIOS: Scenario[] = [
  { name: "before base.snapshot (step 6)", marker: "base.ges-tmp", present: [] },
  {
    name: "after base.snapshot, before sibling (step 7)",
    marker: "sibling.ges-tmp",
    present: ["base.snapshot"],
  },
  {
    name: "after snapshots, before cursor (step 8)",
    marker: "cursor-a.ges-tmp",
    present: ["base.snapshot", "sibling.snapshot"],
  },
  {
    name: "after cursor, before history (step 9)",
    marker: "history.ges-tmp",
    present: ["base.snapshot", "sibling.snapshot", "cursor-a.json"],
  },
  {
    name: "after history, before meta (step 10 — the commit point)",
    marker: "meta.ges-tmp",
    present: ["base.snapshot", "sibling.snapshot", "cursor-a.json", "history.jsonl"],
  },
];

describe("crash: session-start protocol, meta-last invariant", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.vault.adapter.writeBinary("base.md", enc("base content\n"));
    await fx.vault.adapter.writeBinary("sibling.md", enc("sibling content\n"));
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  for (const sc of SCENARIOS) {
    it(`crash ${sc.name}: meta absent, prior files present, reopen is "fresh"`, async () => {
      crashOnStaging(fx.vault, sc.marker);

      await expect(
        startSession(fx.vault, ID, "base.md", "sibling.md", NOW),
      ).rejects.toThrow(/simulated crash/);

      const dir = autosaveDir(ID);
      const all = ["base.snapshot", "sibling.snapshot", "cursor-a.json", "history.jsonl", "meta.json"];
      for (const f of all) {
        const expected = sc.present.includes(f);
        expect(await fx.vault.adapter.exists(`${dir}/${f}`)).toBe(expected);
      }

      // The crash signature: meta NEVER present on any crash path.
      expect(await fx.vault.adapter.exists(`${dir}/meta.json`)).toBe(false);
      expect(await readMeta(fx.vault, ID)).toBeNull();

      // Reopen must NOT mistake a half-written dir for a usable session.
      const status = await classifyReopen(fx.vault, ID, "base.md", "sibling.md");
      expect(status.kind).toBe("fresh");
    });
  }

  it("no crash: meta present ⇒ session usable (resume), the invariant's other half", async () => {
    const meta = await startSession(fx.vault, ID, "base.md", "sibling.md", NOW);
    expect(await readMeta(fx.vault, ID)).toEqual(meta);
    const status = await classifyReopen(fx.vault, ID, "base.md", "sibling.md");
    expect(status.kind).toBe("resume");
  });
});
