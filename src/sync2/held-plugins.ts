// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// PLUGIN-UPDATE-COMPAT Фаза 2 — what it means for a plugin update to be
// HELD on this device, and which paths that covers.
//
// THE PROBLEM (§1, field incident 2026-08-02). Devices sharing a vault
// almost always run DIFFERENT Obsidian versions, and that is a normal
// state rather than a fault: updating the app is optional and a user may
// stay on an old one forever. When an update meant for a newer Obsidian
// arrives from another device, its files land correctly and the plugin
// then cannot load — and until it is held, it cannot load on EVERY
// restart, forever.
//
// THE UNIT IS THE FOLDER, never a file (§5.2). A plugin is a bundle:
// `main.js` and `manifest.json` may arrive in different batches, and
// holding half of one leaves the rest to be resolved by rules that know
// nothing about the part being held. `data.json` is in it too — a new
// config of a new schema under an old `main.js` is the second way to
// break a working plugin.

import { requireApiVersion } from "obsidian";
import { compareSemver } from "./semver";

// One held update. Deliberately NOT carrying the file CONTENT (§8.1):
// the record names what is held and the repo keeps the bytes, so losing
// this record costs a recomputation, never data.
export interface HeldPluginUpdate {
  // The condition for lifting the hold, re-evaluated offline at the
  // start of every drain: `requireApiVersion(minAppVersion)`.
  minAppVersion: string;
  // For the log line only (§5.8) — it may go stale if the repo updates
  // the plugin again while it is held, and that is harmless.
  heldVersion: string;
  // ⚠️ §5.4, the non-obvious half. Freezing makes these paths ignored,
  // and the change detector's Pass 2 DELETES the baseline of every
  // newly-ignored path ("gitignore is a two-way mute"). Without a copy
  // here, unfreezing would meet Pass 1 with no baseline at all, read
  // every local file as new, and push the OLD local version — a
  // downgrade on every healthy device. Restored FIRST when the hold
  // is lifted.
  baselines: Array<{
    path: string;
    baselineSha: string;
    mtime: number;
    size: number;
  }>;
}

// Keyed by plugin id. Lives in the metafile's hot pair beside the
// per-file baselines (§5.5) — one atomic write, one recovery path.
export type HeldPluginUpdates = Record<string, HeldPluginUpdate>;

// Which plugin folder, if any, this path belongs to.
//
// Segment-wise on purpose. The tempting `path.startsWith(folder)` reads
// `templater-extras` as part of `templater` — a whole class of bugs that
// passes every test written with one plugin in the fixture.
export function pluginFolderOf(
  path: string,
  configDir: string,
): { id: string; folder: string } | null {
  const prefix = `${configDir}/plugins/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest === "") return null;
  const id = rest.split("/")[0];
  // `<configDir>/plugins/.gitignore` is a FILE at this level, not a
  // plugin: it carries the per-device data.json switch and is nobody's
  // bundle (D6a).
  if (id === "" || id === ".gitignore") return null;
  return { id, folder: `${prefix}${id}` };
}

// Is this path inside a plugin whose update we are holding?
//
// THE one question the sync predicate asks. Held paths are invisible in
// BOTH directions (§5.3) — push does not see a local edit under them and
// pull does not see a remote one — and the symmetry is a requirement,
// not a side effect: a user who installs a compatible (i.e. OLDER)
// version by hand must not have it travel to the repo and roll the
// update back on devices that are fine.
export function isHeldPath(
  path: string,
  configDir: string,
  held: HeldPluginUpdates,
): boolean {
  const owner = pluginFolderOf(path, configDir);
  if (owner === null) return false;
  return Object.prototype.hasOwnProperty.call(held, owner.id);
}

// ── The decision (§5.1, §6.3, Крок 5) ───────────────────────────────
//
// Should the incoming version of this plugin be held back on THIS
// device? Pure, so the whole table lives in unit tests without an
// engine, and small enough that the two gates cannot drift from it.
export type HoldDecision =
  | { hold: false; reason: string }
  | { hold: true; minAppVersion: string; heldVersion: string };

// `manifestText` is the manifest FROM THE REPO — the version about to
// land — or `null` when this change carries no manifest at all.
//
// ⚠️ IT FAILS IN THE OPPOSITE DIRECTION TO ФАЗА 1'S RELOAD GATE, and
// both directions are deliberate:
//
//   • the reload gate reads the manifest ON DISK and SKIPS when it
//     cannot read it — a wrong skip costs the user one restart;
//   • this reads the INCOMING manifest and does NOT hold when it cannot
//     read it (§7.1.1) — holding on a corrupt file would leave a state
//     with no automatic way out, because the only thing that could ever
//     lift the hold is the very file we cannot parse. Local wins, the
//     files are not written, and the broken manifest gets fixed from a
//     healthy device as an ordinary commit.
//
// ⚠️ `isDesktopOnly` is NOT a condition here (§5.1, owner 2026-08-02),
// even though it is a REAL Obsidian rule rather than a heuristic. Its
// cure is remote — the author dropping the flag — and a held folder is
// filtered out of every compare, so the manifest that would announce
// the change is exactly the file we stopped reading. That is a one-way
// trap; the cost of not holding is disk space and traffic, and the
// files stay CURRENT for the day the flag goes away.
export function decideHold(manifestText: string | null): HoldDecision {
  if (manifestText === null) {
    // §5.2 — no manifest in this change means the version did not move.
    // An assumption, not a guarantee (someone can edit main.js in the
    // repo by hand), and §5.10 п.1 records it as a known hole.
    return { hold: false, reason: "no manifest in this change" };
  }
  let manifest: { minAppVersion?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(manifestText) as typeof manifest;
  } catch {
    return { hold: false, reason: "incoming manifest is not valid JSON" };
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    return { hold: false, reason: "incoming manifest is not an object" };
  }
  const min = manifest.minAppVersion;
  if (typeof min !== "string" || min.trim() === "") {
    return { hold: false, reason: "no minAppVersion" };
  }
  // ⚠️ A HEURISTIC, and knowing that matters (§5.1): Obsidian does not
  // enforce this field at all (§2.1). It is the AUTHOR'S CLAIM about
  // what their code needs, and the miss that matters — an author who
  // forgets to raise it — is invisible here by construction. Фаза 1's
  // honest reload report is what covers that case.
  if (requireApiVersion(min)) {
    return { hold: false, reason: "this Obsidian is new enough" };
  }
  // An unparseable version reaches this branch as "not satisfied", which
  // would hold forever on a typo. Refuse instead — same reasoning as the
  // corrupt manifest above.
  if (compareSemver(min, min) === null) {
    return { hold: false, reason: "minAppVersion is not a version" };
  }
  return {
    hold: true,
    minAppVersion: min,
    heldVersion: typeof manifest.version === "string" ? manifest.version : "",
  };
}
