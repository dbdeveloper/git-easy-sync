// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// The opt-in set: which dot-paths this device may sync at all
// (DOT-FILES §4.2). Everything in dot-space is invisible by default
// (D1); this module is where the exceptions come from.
//
// It exists as its own module for two reasons. It is consumed by more
// than the change detector — the synthetic-conflict scan (Крок C) needs
// the same set — and the CLASSIFICATION half is pure, so it can be
// tested against the rule table without a vault.
//
// ⚠️ D7, and the reason this set is not just a convenience: `isSyncable`
// must never allow a dot-path that push-discovery cannot reach. If it
// did, the path would sit in the baselines, answer "syncable", and be
// absent from the scan — which Pass 2 reads as "deleted" and propagates
// to every device. One character (`!/.myconfig/` → `!.myconfig/`) would
// wipe a directory. So "permitted" and "discoverable" are one set, not
// two that have to agree.

import { normalizePath, type Vault } from "obsidian";

// What a single `!`-rule resolved to.
export type RuleTarget =
  // A concrete root-level dot-FILE: pass 2 stats it by path.
  | { kind: "file"; path: string }
  // A concrete anchored dot-DIRECTORY: pass 3 walks it.
  | { kind: "dir"; path: string }
  // Everything that does not address one concrete path. NOT an error —
  // the documented answer for globs, unanchored directories, and
  // dot-files buried in ordinary subfolders (§4.2, README §7).
  | { kind: "none" };

export interface OptInSet {
  // Exact vault-relative paths, stat'd directly — no listing of the
  // vault root (that is what `walkRootDotfiles` used to do, and it made
  // every root dotfile syncable whether or not anyone asked).
  dotFiles: Set<string>;
  // Directory prefixes (no trailing slash) that pass 3 walks.
  walkTargets: Set<string>;
}

// Does this rule address ONE concrete path, and is that path a dot-path?
// Returns the bare path with the leading `/` stripped, or null.
function addressedPath(rule: string): { path: string; isDir: boolean } | null {
  if (!rule.startsWith("!")) return null;
  let body = rule.slice(1).trim();
  if (body === "") return null;
  // A glob addresses a shape, not a path. `!**/.foo`, `!*.x`, `!.foo?`,
  // `![ab].x` — all of them would need a scan to enumerate, which is
  // precisely the discoverability D7 refuses to assume.
  if (/[*?[\]\\]/.test(body)) return null;
  const isDir = body.endsWith("/");
  if (isDir) body = body.slice(0, -1);
  if (body.startsWith("/")) body = body.slice(1);
  if (body === "" || body.endsWith("/")) return null;
  // Only dot-paths matter here: ordinal paths are visible by default,
  // so a `!`-rule naming one grants nothing this set needs to carry.
  if (!body.split("/").some((seg) => seg.startsWith("."))) return null;
  return { path: body, isDir };
}

// Classify ONE `!`-rule. Pure: the caller supplies what the disk says,
// because two of the cases can only be decided by looking.
//
// `onDisk` is what a stat of the addressed path found, or null when it
// is absent. It is only consulted for the forms that are genuinely
// ambiguous — an absent path simply contributes nothing this pass, and
// will be classified on a later one once it exists.
export function classifyRule(
  rule: string,
  onDisk: "file" | "dir" | null,
): RuleTarget {
  const addressed = addressedPath(rule);
  if (!addressed) return { kind: "none" };
  const { path, isDir } = addressed;
  const anchored = path.includes("/");

  if (isDir) {
    // A trailing slash says "directory" outright. It still has to be
    // ANCHORED: `!.myconfig/` matches a directory of that name at any
    // depth, and "somewhere, maybe several somewheres" is not a walk
    // target — it is the Blocker-1 shape (§4.2).
    return anchored || rule.slice(1).startsWith("/")
      ? { kind: "dir", path }
      : { kind: "none" };
  }

  // No trailing slash. In git this form matches BOTH a file and a
  // directory of that name, and our matcher agrees — measured on both,
  // 2026-09-22. So the disk decides (§4.2 row 3).
  if (!anchored) {
    // Single segment: `!.editorconfig` or `!/.editorconfig`. We address
    // the ROOT one; git would also match it at depth, and that
    // narrowing is the documented §4.2 limitation.
    if (onDisk === "dir") return { kind: "dir", path };
    // Absent counts as a file: the user named a concrete root path, and
    // stat'ing a path that does not exist yet costs nothing and makes
    // the rule work the moment they create it.
    return { kind: "file", path };
  }

  // Multi-segment and no trailing slash, e.g. `!notes/.hidden`. As a
  // DIRECTORY this is a perfectly good walk target. As a FILE it is a
  // dot-file buried in an ordinary subfolder, which §4.2 deliberately
  // does not support — reaching it would mean scanning subfolders we
  // otherwise never open, and a rule that half-works is worse than one
  // that does nothing (§4.2, "чому «pull-only» НЕ існує").
  return onDisk === "dir" ? { kind: "dir", path } : { kind: "none" };
}

// Extract the `!`-rules from a .gitignore body, in file order.
export function negationRules(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("!"));
}

export interface DotSpaceDeps {
  vault: Vault;
  configDir: string;
  syncConfigDir: () => boolean;
  // §4.2 — a `!`-rule that names a dot-path but grants NOTHING is
  // refused on purpose (D7), and until 2026-09-26 it was refused in
  // total silence. Field report: the owner wrote `!.test/` (no anchor),
  // nothing synced, and the log had ZERO mentions of the path — leaving
  // no way to tell a deliberate refusal from a broken feature.
  logger?: { warn(message: string, data?: unknown): void };
}

// Pass 0: read the root .gitignore and turn its `!`-rules into the set.
//
// Reading is ABSOLUTE and does not go through isSyncable (D2.1): this is
// a direct stat+read by path. The file is guaranteed to exist because
// GitignoreInvariants.enforce() runs before every sync operation and
// recreates it; if it is momentarily gone, an empty set is the safe
// answer — dot-space closes rather than opens.
export async function readRootGitignore(
  deps: DotSpaceDeps,
): Promise<OptInSet> {
  const dotFiles = new Set<string>();
  const walkTargets = new Set<string>();

  // ROOT `.gitignore` IS ALWAYS A MEMBER, structurally — not because
  // the file happens to contain `!/.gitignore`.
  //
  // D7 gates every non-configDir dot-path on membership, and the root
  // control file is exactly such a path. Deriving its membership from
  // the file's own contents would make the control file drop out of
  // sync the moment a user exercised D6a (`/.gitignore` below the
  // invariants section) — but D6a is supposed to work through the
  // MATCHER (gi, step 6), which is the layer that can distinguish "the
  // user chose to keep this file local" from "we cannot see it".
  // Membership says reachable; gi says permitted. Conflating them would
  // turn a deliberate per-device choice into a silent discovery hole.
  dotFiles.add(".gitignore");

  // `<configDir>/` joins the SAME set, but from the other source: the
  // per-device settings toggle, not a gitignore rule (§6). It is the
  // only member that is not a `!`-rule, because "do I share my config"
  // is a per-machine decision while the gitignore is shared.
  if (deps.syncConfigDir()) walkTargets.add(deps.configDir);

  const raw = await readIfPresent(deps.vault, ".gitignore");
  if (raw === null) return { dotFiles, walkTargets };

  for (const rule of negationRules(raw)) {
    const addressed = addressedPath(rule);
    if (!addressed) continue;
    const onDisk = await statKind(deps.vault, addressed.path);
    const target = classifyRule(rule, onDisk);
    if (target.kind === "file") dotFiles.add(target.path);
    else if (target.kind === "dir") walkTargets.add(target.path);
    else {
      // It addresses a real dot-path (addressedPath said so) and still
      // grants nothing — so the user wrote something that LOOKS right,
      // git would honour it, and we deliberately do not. Say so.
      deps.logger?.warn(
        "gitignore: this rule does not make a dot-path syncable — " +
          "anchor it with a leading slash, e.g. `!/name/` instead of " +
          "`!name/` (an unanchored rule matches at any depth, and the " +
          "sync cannot know WHERE to look)",
        { rule, path: addressed.path },
      );
    }
  }
  return { dotFiles, walkTargets };
}

// True when `path` sits under one of the walk targets (or IS one).
export function underWalkTarget(path: string, targets: Set<string>): boolean {
  for (const t of targets) {
    if (path === t || path.startsWith(`${t}/`)) return true;
  }
  return false;
}

async function statKind(
  vault: Vault,
  path: string,
): Promise<"file" | "dir" | null> {
  try {
    const st = await vault.adapter.stat(normalizePath(path));
    if (!st) return null;
    return st.type === "folder" ? "dir" : "file";
  } catch {
    return null;
  }
}

async function readIfPresent(
  vault: Vault,
  path: string,
): Promise<string | null> {
  try {
    const p = normalizePath(path);
    if (!(await vault.adapter.exists(p))) return null;
    return await vault.adapter.read(p);
  } catch {
    return null;
  }
}

// How deep below a walk target the enumeration may go. Generous for a
// notes vault and irrelevant to a healthy one; its only job is to make
// a symlink loop terminate instead of hanging (§4.1).
const WALK_MAX_DEPTH = 64;

export interface WalkedFile {
  path: string;
  stat: { mtime: number; size: number };
}

// Recursively enumerate ONE walk target via adapter.list().
//
// Lives here rather than inside ChangeDetector because it has two
// consumers: the change scan (push discovery) and diff2's
// synthetic-conflict list, which needs the same boundaries without
// dragging the scan's lifecycle (`beginScan`, the opt-in set) into the
// UI layer.
//
// PRUNE (D3): dot-SUBdirectories are not descended into. A dot-dir
// inside an opted-in dot-dir stays hidden unless named again, and
// naming it again makes it a target in its own right — so descending
// here would visit it twice and, worse, would reach dot-dirs nobody
// opted into. The matcher agrees: root `.*` matches at any depth
// (§10 probe 2).
//
// Reports whether it FINISHED. The push side's Pass-2 belt needs that
// per target: an interrupted walk leaves its subtree unvisited, and
// unvisited must not be read as deleted (§3.3).
export async function walkDotDir(
  vault: Vault,
  prefix: string,
): Promise<{ files: WalkedFile[]; completed: boolean }> {
  const out: WalkedFile[] = [];
  // Cycle safety (§4.1 MUST-FIX). A symlink loop (`a/link -> a`,
  // desktop only — mobile vaults are sandboxed without symlinks)
  // produces an endless sequence of DISTINCT paths, so a visited-set
  // alone cannot stop it; the depth cap is what actually terminates.
  // The visited set still earns its place against a listing that
  // repeats a folder. Neither has ever fired in practice — they are
  // here so a hang is impossible, not because one was observed.
  const visited = new Set<string>();
  const baseDepth = prefix.split("/").length;
  const stack: string[] = [prefix];
  try {
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      if (visited.has(dir)) continue;
      visited.add(dir);
      if (dir.split("/").length - baseDepth > WALK_MAX_DEPTH) continue;
      if (!(await vault.adapter.exists(dir))) continue;
      const { files, folders } = await vault.adapter.list(dir);
      for (const filePath of files) {
        const stat = await vault.adapter.stat(filePath);
        if (!stat) continue;
        out.push({
          path: filePath,
          stat: { mtime: stat.mtime, size: stat.size },
        });
      }
      for (const folder of folders) {
        const name = folder.slice(folder.lastIndexOf("/") + 1);
        if (name.startsWith(".")) continue; // D3 prune, see above
        stack.push(folder);
      }
    }
  } catch {
    // A folder vanishing mid-walk, a permission error, anything: the
    // subtree is INCOMPLETE, and saying so is what stops the push
    // side's Pass 2 from reading the gap as a mass deletion. Whatever
    // we did collect is still usable.
    return { files: out, completed: false };
  }
  return { files: out, completed: true };
}
