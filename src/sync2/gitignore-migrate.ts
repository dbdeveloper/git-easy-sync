// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §8.1 Крок E2 — the PURE half of the `.gitignore`
// consolidation: which files must move, and what each of their rules
// becomes once it lives in the root file instead of its own directory.
//
// Nothing here touches the vault, the network or any marker. The
// procedure that does (§8.1.4, Крок E4) composes these two functions;
// keeping them separate is what makes the only genuinely tricky logic —
// rule translation — testable without a crash protocol around it.
//
// Canonical spec: docs/tasks/SYNC2-DOT-FILES-REFACTOR.md §8.1.1–§8.1.3.

import { isWhitelistedGitignoreDir } from "../gi";

// Is this `.gitignore` one the migration must consolidate into the root?
//
// Expressed THROUGH D5's single definition rather than restating the
// honoured set — two encodings of one rule drift, and gi.ts says so
// itself. So the answer is "not honoured", with exactly one addition:
//
// ⚠️ `<configDir>/plugins/.gitignore` IS honoured and STILL migrates.
// It is the one place where "git reads it" and "safe to leave alone"
// come apart: `enforce()` rewrites that file WHOLE (its own comment: "no
// user content here to preserve" — it carries only the per-device
// data.json switch), so any user content there is destroyed on the next
// commit or drain. Being legible to git is no protection from us.
export function needsMigration(
  gitignorePath: string,
  configDir: string,
): boolean {
  const slash = gitignorePath.lastIndexOf("/");
  const name = slash === -1 ? gitignorePath : gitignorePath.slice(slash + 1);
  // The walk hands us whatever it found, and "ends with .gitignore" is
  // not "is one" — `my.gitignore` and `.gitignore.bak` are ordinary
  // files that git never consults.
  if (name !== ".gitignore") return false;
  const dir = slash === -1 ? "" : gitignorePath.slice(0, slash);
  if (dir === `${configDir}/plugins`) return true;
  return !isWhitelistedGitignoreDir(dir, configDir);
}

// Does any segment of this pattern name a dot-path?
function addressesDotPath(pattern: string): boolean {
  return pattern.split("/").some((seg) => seg.startsWith("."));
}

const GLOB_CHARS = /[*?[\]\\]/;

// Translate ONE line of `<dir>/.gitignore` into the form it must take in
// the root file. Comments and blank lines pass through: they are what
// makes the resulting conflict readable, and the user has to understand
// these rules well enough to accept or reject them.
export function translateRule(rule: string, dir: string): string {
  const line = rule.trim();
  if (line === "" || line.startsWith("#")) return line;

  const negated = line.startsWith("!");
  let body = negated ? line.slice(1) : line;

  // A leading backslash escapes `#` or `!`, which are only special at
  // position 0. Once we prefix the pattern they stop being leading, so
  // keeping the escape would make it a LITERAL backslash and the rule
  // would quietly stop matching.
  if (body.startsWith("\\#") || body.startsWith("\\!")) body = body.slice(1);

  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.slice(0, -1);
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);

  // git: a pattern containing a slash other than a trailing one is
  // relative to its own `.gitignore`'s directory — i.e. already
  // anchored. Treating `a/b` like a bare name would turn a one-place
  // rule into an any-depth one.
  const hasInternalSlash = body.includes("/");

  // ⚠️ The one place translation is deliberately NOT literal (§8.1.2).
  // A negated dot-path MUST come out anchored and glob-free, because
  // `addressedPath` rejects globs ("a glob addresses a shape, not a
  // path") and D7 would then grant nothing — the rule would be inert,
  // which is exactly what the dot-space warning shouts about. Anchoring
  // narrows it to one depth, and that narrowing costs nothing real: the
  // rule was never honoured by THIS plugin at any depth before the
  // migration, so nothing that worked stops working.
  //
  // Only for `!`-rules: granting permission is the only thing anchoring
  // affects. A plain dot-pattern merely hides, and hiding runs through
  // the ordinary matcher where `**` is fine.
  const forceAnchor =
    negated && addressesDotPath(body) && !GLOB_CHARS.test(body);

  const prefix = negated ? "!" : "";
  const suffix = dirOnly ? "/" : "";
  const path =
    anchored || hasInternalSlash || forceAnchor
      ? `/${dir}/${body}`
      : `${dir}/**/${body}`;
  return `${prefix}${path}${suffix}`;
}

// Translate a whole source file into the lines it contributes, led by a
// provenance header so the user reading the conflict can see WHERE each
// group came from and judge it.
//
// Rule order is preserved: gitignore is last-match-wins, so reordering
// within a file can invert meaning.
export function translateFile(content: string, dir: string): string[] {
  // `\r` would otherwise become part of the pattern — a Windows-authored
  // `.gitignore` in a cross-platform vault is ordinary, not exotic.
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  const translated = lines.map((l) => translateRule(l, dir));
  // A header over nothing would read as "these rules moved" when none
  // did, so a file carrying no actual rule contributes nothing at all.
  const hasRule = translated.some((l) => l !== "" && !l.startsWith("#"));
  if (!hasRule) return [];
  // Trailing blanks are an artifact of the final newline, not content.
  while (translated.length > 0 && translated[translated.length - 1] === "") {
    translated.pop();
  }
  return [`# rules from ${dir}/.gitignore`, ...translated];
}

// ── §8.1.1a the walk ────────────────────────────────────────────────

import type { Vault } from "obsidian";

export interface MigrationCandidate {
  // Vault-relative path of the source file, e.g. "a/b/.gitignore".
  path: string;
  // The directory it governs, e.g. "a/b" — what translateRule needs.
  dir: string;
}

export interface MigrationWalkDeps {
  vault: Vault;
  configDir: string;
  // "Would git refuse to ENTER this directory?" — i.e. is it excluded by
  // a rule above it.
  //
  // ⚠️ Injected rather than derived here, and the distinction it draws is
  // the subtle one. It must be a DIRECTORY verdict: `gi.ignored(dir)`
  // probes the final segment WITHOUT a trailing slash, so a dir-only
  // pattern (`build/`, `.*/`) would not match — the trap gi.ts documents
  // for exactly this reason. And it must not be "is the .gitignore
  // ignored": `.*` hides every dotted basename, including nested
  // `.gitignore` files, yet git still HONOURS them (ignored ≠ unread).
  // Those two different "true"s would collapse into one.
  //
  // In production this comes from a GI honouring EVERY level — the
  // shipped instance carries the D5 whitelist and structurally cannot
  // answer what git would do (§8.1.1a).
  dirIgnored: (relDir: string) => boolean;
}

export interface MigrationWalkResult {
  // Shallowest-first. ⚠️ ORDER IS SEMANTIC, not presentational: flattened
  // into one file under last-match-wins, a deeper rule must appear LATER
  // or it stops overriding the shallower one it overrode in git.
  candidates: MigrationCandidate[];
  // Reported, not swallowed: §8.1.1a's cost claim rests on pruning, so
  // the procedure has to be able to say what it skipped and why.
  dirsScanned: number;
  dirsPruned: number;
  // false when the walk could not finish (unreadable folder, depth cap).
  // ⚠️ Load-bearing: an incomplete walk means "a `.gitignore` may have
  // been missed", and a migration that marked itself done on that basis
  // would never look again. Same contract walkDotDir carries.
  completed: boolean;
}

// Mirrors walkDotDir's cap. A symlink loop produces endless DISTINCT
// paths, so the visited set alone cannot terminate it — the depth cap is
// what does.
const MIGRATION_WALK_MAX_DEPTH = 64;

// Collect every `.gitignore` the migration must consolidate.
//
// Unlike walkDotDir, dot-directories are NOT pruned by name: this walk
// answers "what would git honour", and git has no notion of hidden. A
// dot-directory disappears here only if `dirIgnored` says so — which it
// will for `.*`/`.*/` unless the user opted the directory back in, and
// that is precisely the right answer (§8.1.1a).
export async function findMigrationCandidates(
  deps: MigrationWalkDeps,
): Promise<MigrationWalkResult> {
  const candidates: MigrationCandidate[] = [];
  const visited = new Set<string>();
  let dirsScanned = 0;
  let dirsPruned = 0;
  let completed = true;
  const queue: string[] = [""];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    if (visited.has(dir)) continue;
    visited.add(dir);
    if (dir !== "" && dir.split("/").length > MIGRATION_WALK_MAX_DEPTH) {
      completed = false;
      continue;
    }
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await deps.vault.adapter.list(dir);
    } catch {
      // A folder vanishing mid-walk, a permission error, anything: what
      // we collected stays usable, but the run is no longer a complete
      // picture and must not be recorded as one.
      completed = false;
      continue;
    }
    dirsScanned++;
    for (const filePath of listing.files) {
      if (needsMigration(filePath, deps.configDir)) {
        const slash = filePath.lastIndexOf("/");
        candidates.push({
          path: filePath,
          dir: slash === -1 ? "" : filePath.slice(0, slash),
        });
      }
    }
    for (const folder of listing.folders) {
      if (deps.dirIgnored(folder)) {
        // Not entered at all — which is both the cost saving and the
        // correctness: git does not read a `.gitignore` in here, so its
        // rules affect nothing, and hoisting them to the root would
        // ACTIVATE dead rules rather than preserve live ones.
        dirsPruned++;
        continue;
      }
      queue.push(folder);
    }
  }

  // Breadth-first already yields shallow before deep, but the sort makes
  // the guarantee independent of the traversal — a later switch to a
  // stack must not silently invert rule precedence.
  candidates.sort((a, b) => {
    const d = a.dir.split("/").length - b.dir.split("/").length;
    return d !== 0 ? d : a.dir.localeCompare(b.dir);
  });
  return { candidates, dirsScanned, dirsPruned, completed };
}
