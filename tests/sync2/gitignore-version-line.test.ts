// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner, 2026-10-24 (PLUGIN-UPDATE-COMPAT §5.11, format change): the
// version moved OUT of the BEGIN marker into its own line under it:
//
//   # ===== git-easy-sync final - DO NOT EDIT =====
//   # ===== plugin version: 2.0.9-beta        =====
//
// Field finding (three vaults, one repo): a user rule added right above the
// `final` BEGIN on one device, and a version bump of that BEGIN line on
// another, are changes to ADJACENT lines — the line merge made a
// `.gitignore.conflict-from-*`. With the BEGIN line constant, it separates
// the user's zone from the line that changes.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import GitignoreInvariants, { type SectionAnomalyReport } from "../../src/sync2/gitignore-invariants";
import GitignoreSeedStore from "../../src/sync2/gitignore-seeds";
import { Vault } from "../../mock-obsidian";
import {
  beginMarker,
  newerVersionIn,
  parseVersionLine,
  versionLine,
} from "../../src/sync2/gitignore-markers";
import { mergeText } from "../../src/sync2/three-way-merge";

const CONFIG_DIR = ".obsidian";
const SELF = "git-easy-sync";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function vaultAt(version: string, root?: string) {
  const dir = root ?? path.join(os.tmpdir(), `gi-ver-${crypto.randomBytes(4).toString("hex")}`);
  if (!root) {
    fs.mkdirSync(path.join(dir, CONFIG_DIR, "plugins", SELF), { recursive: true });
    roots.push(dir);
  }
  const vault = new Vault(dir);
  const anomalies: SectionAnomalyReport[] = [];
  const inv = new GitignoreInvariants({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF,
    seeds: new GitignoreSeedStore({ vault: vault as unknown as import("obsidian").Vault, selfPluginId: SELF }),
    pushPluginsDataJson: () => false,
    syncConfigDir: () => true,
    gi: { invalidate: () => {} },
    onAnomaly: (r) => anomalies.push(r),
    pluginVersion: version,
  });
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
  const write = (rel: string, c: string) => fs.writeFileSync(path.join(dir, rel), c);
  return { dir, inv, anomalies, read, write };
}

describe("the version line", () => {
  it("🔑 its closing ===== sits under the BEGIN marker's", () => {
    for (const kind of ["invariants", "final"] as const) {
      const begin = beginMarker(kind);
      const line = versionLine(kind, "2.0.9-beta");
      expect(line.startsWith("# ===== plugin version: 2.0.9-beta ")).toBe(true);
      expect(line.endsWith(" =====")).toBe(true);
      expect(line.length).toBe(begin.length);
    }
    expect(versionLine("final", "2.0.9-beta")).toBe("# ===== plugin version: 2.0.9-beta        =====");
  });

  it("a version too long to align still leaves one space", () => {
    const v = "12.345.678-very-long-prerelease.tag";
    expect(versionLine("final", v)).toBe(`# ===== plugin version: ${v} =====`);
  });

  it("is recognised whatever the version and the padding", () => {
    expect(parseVersionLine("# ===== plugin version: 2.0.9-beta        =====")).toBe("2.0.9-beta");
    expect(parseVersionLine("# ===== plugin version: 3.1.0 =====")).toBe("3.1.0");
    expect(parseVersionLine("# ===== plugin version: =====")).toBeNull();
    expect(parseVersionLine("# something else")).toBeNull();
  });

  it("🔑 newerVersionIn reads the version line", () => {
    expect(newerVersionIn(`${beginMarker("final")}\n${versionLine("final", "2.0.9-beta")}\n`, "2.0.3-beta")).toBe(
      "2.0.9-beta",
    );
    expect(newerVersionIn(`${beginMarker("final")}\n${versionLine("final", "2.0.1")}\n`, "2.0.3-beta")).toBeNull();
  });
});

describe("enforce() writes the new format", () => {
  it("🔑 each section: a constant BEGIN, the version line right under it", async () => {
    const v = vaultAt("2.0.4-beta");
    await v.inv.enforce();
    for (const rel of [".gitignore", `${CONFIG_DIR}/.gitignore`]) {
      const lines = v.read(rel).split("\n");
      for (const kind of ["invariants", "final"] as const) {
        const at = lines.indexOf(beginMarker(kind));
        expect(at, `${rel} ${kind}`).toBeGreaterThanOrEqual(0);
        expect(lines[at + 1]).toBe(versionLine(kind, "2.0.4-beta"));
      }
      expect(lines.filter((l) => parseVersionLine(l) !== null)).toHaveLength(2);
    }
  });

  it("🔑 a second pass changes nothing and reports nothing", async () => {
    const v = vaultAt("2.0.4-beta");
    await v.inv.enforce();
    const first = v.read(".gitignore");
    await v.inv.enforce();
    expect(v.read(".gitignore")).toBe(first);
    expect(v.anomalies).toEqual([]);
  });

  // Owner, 2026-10-24: BEGIN is matched EXACTLY now. The dev-only spelling
  // with the version inside BEGIN is not ours any more — it stays in the
  // user's zone as plain text (acceptable: never released). Our rules that
  // stood under it move into the new blocks like any matching line.
  it("🔑 a file in the dev-only OLD format: our blocks are added, the old BEGIN lines stay as user text", async () => {
    const old = vaultAt("2.0.3-beta");
    const OLD_I = "# ===== git-easy-sync invariants v2.0.3-beta - DO NOT EDIT =====";
    const OLD_F = "# ===== git-easy-sync final v2.0.3-beta - DO NOT EDIT =====";
    old.write(
      ".gitignore",
      `${OLD_I}\n.*\n# ===== end of git-easy-sync invariants =====\n\n*.mine\n\n${OLD_F}\n*.conflict-from-*\n# ===== end of git-easy-sync final =====\n`,
    );
    const v = vaultAt("2.0.4-beta", old.dir);
    await v.inv.enforce();
    const lines = v.read(".gitignore").split("\n");
    expect(lines[0]).toBe(beginMarker("invariants"));
    expect(lines[1]).toBe(versionLine("invariants", "2.0.4-beta"));
    expect(lines).toContain(OLD_I);
    expect(lines).toContain(OLD_F);
    expect(lines).toContain("*.mine");
    // Ours, exactly once each.
    expect(lines.filter((l) => l === ".*")).toHaveLength(1);
    expect(lines.filter((l) => l === "*.conflict-from-*")).toHaveLength(1);
    expect(lines.filter((l) => l === beginMarker("final"))).toHaveLength(1);
  });

  it("an older build yields to a newer version LINE", async () => {
    const newer = vaultAt("2.0.9-beta");
    await newer.inv.enforce();
    const before = newer.read(".gitignore");
    const older = vaultAt("2.0.3-beta", newer.dir);
    await older.inv.enforce();
    expect(older.read(".gitignore")).toBe(before);
    expect(older.anomalies.some((a) => a.anomaly === "yielded-to-newer" && a.version === "2.0.9-beta")).toBe(true);
  });
});

// The field case itself (2026-10-24, the phone): a user rule right above the
// `final` BEGIN on one side, a version bump on the other — now a clean merge.
describe("🔑 the field merge: a user rule above `final` + a version bump", () => {
  it("merges cleanly, with or without a blank line under the rule", async () => {
    const base = vaultAt("2.0.3-beta");
    await base.inv.enforce();
    const baseText = base.read(".gitignore");
    const bumped = vaultAt("2.0.9-beta", base.dir);
    await bumped.inv.enforce();
    const theirs = bumped.read(".gitignore");
    expect(theirs).not.toBe(baseText);

    const lines = baseText.split("\n");
    const fi = lines.indexOf(beginMarker("final"));
    for (const added of [["*.phone-test"], ["*.phone-test", ""]]) {
      const ours = [...lines.slice(0, fi), ...added, ...lines.slice(fi)].join("\n");
      const r = mergeText(ours, baseText, theirs);
      expect(r.kind, JSON.stringify(added)).toBe("clean");
      if (r.kind === "clean") {
        expect(r.content).toContain("*.phone-test");
        expect(r.content).toContain(versionLine("final", "2.0.9-beta"));
      }
    }
  });
});
