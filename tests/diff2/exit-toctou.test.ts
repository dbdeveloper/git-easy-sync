// W5 — §5.0.e symmetric exit-TOCTOU writers (DIFF-EDITOR.md §5.0.e).
//
// The both-changed SaveToAltModal isn't unit-testable (mock-obsidian Modal is a
// stub), so the testable spine is the two pure disk helpers the view calls once
// the modal/XOR decision is made: commitUnchangedSide (one side changed → silent
// single write to the UNCHANGED side) and commitToAlt (both changed → fresh
// name, converged→1 file / partial→pair, FAIL-CLOSED on a colliding name).
// fs-backed mock-obsidian vault; startSession creates the dir the helpers rmdir.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import {
  AltTargetExistsError,
  commitToAlt,
  commitUnchangedSide,
} from "../../src/diff2/exit-commit";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

const tmpdirs: string[] = [];
function fixture(): Vault {
  const root = path.join(
    os.tmpdir(),
    `exit-toctou-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  tmpdirs.push(root);
  return new MockVault(root) as unknown as Vault;
}

afterEach(() => {
  for (const d of tmpdirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const BASE = "Notes/x.md";
const SIB = "Notes/x.conflict-from-Phone-2026-06-03T10-30-00Z.md";

async function seed(vault: Vault, base: string, sibling: string) {
  await vault.adapter.writeBinary(BASE, enc(base));
  await vault.adapter.writeBinary(SIB, enc(sibling));
  const meta = await startSession(vault, "cid", BASE, SIB);
  return meta;
}

describe("commitUnchangedSide — §5.0.e one-side-changed (silent)", () => {
  it("base changed → writes resolved.sibling onto the (unchanged) sibling path; base untouched; dir gone", async () => {
    const vault = fixture();
    const meta = await seed(vault, "OLD-BASE\n", "OLD-SIB\n");
    // base was changed externally; helper writes the resolved UNCHANGED side.
    await vault.adapter.writeBinary(BASE, enc("EXTERNAL-NEW-BASE\n"));

    const resolved = { base: "RES-BASE\n", sibling: "RES-SIB\n" };
    const { writtenPath } = await commitUnchangedSide(
      vault,
      "cid",
      meta,
      resolved,
      "base",
    );

    expect(writtenPath).toBe(SIB);
    expect(dec(await vault.adapter.readBinary(SIB))).toBe("RES-SIB\n");
    // the externally-changed base is left exactly as it was found.
    expect(dec(await vault.adapter.readBinary(BASE))).toBe(
      "EXTERNAL-NEW-BASE\n",
    );
    expect(await vault.adapter.exists(autosaveDir("cid"))).toBe(false);
  });

  it("MIRROR — sibling changed → writes resolved.base onto the (unchanged) base path", async () => {
    const vault = fixture();
    const meta = await seed(vault, "OLD-BASE\n", "OLD-SIB\n");
    await vault.adapter.writeBinary(SIB, enc("EXTERNAL-NEW-SIB\n"));

    const resolved = { base: "RES-BASE\n", sibling: "RES-SIB\n" };
    const { writtenPath } = await commitUnchangedSide(
      vault,
      "cid",
      meta,
      resolved,
      "sibling",
    );

    expect(writtenPath).toBe(BASE);
    expect(dec(await vault.adapter.readBinary(BASE))).toBe("RES-BASE\n");
    expect(dec(await vault.adapter.readBinary(SIB))).toBe("EXTERNAL-NEW-SIB\n");
    expect(await vault.adapter.exists(autosaveDir("cid"))).toBe(false);
  });
});

describe("commitToAlt — §5.0.e both-changed save-to-alt", () => {
  it("converged resolution → ONLY the new base file written (no sibling); originals untouched; dir gone", async () => {
    const vault = fixture();
    await seed(vault, "EXT-BASE\n", "EXT-SIB\n");

    const resolved = { base: "MERGED\n", sibling: "MERGED\n" }; // converged
    const res = await commitToAlt(
      vault,
      "cid",
      "Notes/resolved.md",
      resolved,
      "Phone",
      1_717_400_000_000,
    );

    expect(res.basePath).toBe("Notes/resolved.md");
    expect(res.siblingPath).toBeUndefined();
    expect(dec(await vault.adapter.readBinary("Notes/resolved.md"))).toBe(
      "MERGED\n",
    );
    // the externally-changed originals are NEVER touched.
    expect(dec(await vault.adapter.readBinary(BASE))).toBe("EXT-BASE\n");
    expect(dec(await vault.adapter.readBinary(SIB))).toBe("EXT-SIB\n");
    expect(await vault.adapter.exists(autosaveDir("cid"))).toBe(false);
  });

  it("partial resolution → new base + derived sibling; the synthetic pair continues under the new name", async () => {
    const vault = fixture();
    await seed(vault, "EXT-BASE\n", "EXT-SIB\n");

    const ts = 1_717_400_000_000;
    const resolved = { base: "MINE\n", sibling: "THEIRS\n" }; // partial
    const res = await commitToAlt(
      vault,
      "cid",
      "Notes/resolved.md",
      resolved,
      "Phone",
      ts,
    );

    const expectedSibling = buildSiblingFilePath("Notes/resolved.md", ts, "Phone");
    expect(res.basePath).toBe("Notes/resolved.md");
    expect(res.siblingPath).toBe(expectedSibling);
    expect(dec(await vault.adapter.readBinary("Notes/resolved.md"))).toBe(
      "MINE\n",
    );
    expect(dec(await vault.adapter.readBinary(expectedSibling))).toBe(
      "THEIRS\n",
    );
    // originals untouched, session gone.
    expect(dec(await vault.adapter.readBinary(BASE))).toBe("EXT-BASE\n");
    expect(dec(await vault.adapter.readBinary(SIB))).toBe("EXT-SIB\n");
    expect(await vault.adapter.exists(autosaveDir("cid"))).toBe(false);
  });

  it("normalizes the user-typed name before touching the adapter (CLAUDE.md path rule)", async () => {
    const vault = fixture();
    await seed(vault, "EXT-BASE\n", "EXT-SIB\n");

    // Windows-style separators (mock normalizePath converts \\ → /). The write
    // and the returned path must both be the normalized form, never the raw.
    const messy = "Notes\\resolved.md";
    const res = await commitToAlt(
      vault,
      "cid",
      messy,
      { base: "M\n", sibling: "M\n" },
      "Phone",
      1_717_400_000_000,
    );

    expect(res.basePath).toBe("Notes/resolved.md");
    expect(await vault.adapter.exists("Notes/resolved.md")).toBe(true);
    expect(await vault.adapter.exists(messy)).toBe(false);
  });

  it("FAIL-CLOSED — chosen name already exists → throws AltTargetExistsError, nothing written, dir kept", async () => {
    const vault = fixture();
    await seed(vault, "EXT-BASE\n", "EXT-SIB\n");
    // the prefilled default IS the changed original — clicking Save un-edited
    // must NOT overwrite it.
    await expect(
      commitToAlt(
        vault,
        "cid",
        BASE, // == meta.basePath, already exists
        { base: "MINE\n", sibling: "THEIRS\n" },
        "Phone",
        1_717_400_000_000,
      ),
    ).rejects.toBeInstanceOf(AltTargetExistsError);

    // the original is intact and the session survives (the user re-picks a name).
    expect(dec(await vault.adapter.readBinary(BASE))).toBe("EXT-BASE\n");
    expect(await vault.adapter.exists(autosaveDir("cid"))).toBe(true);
  });
});
