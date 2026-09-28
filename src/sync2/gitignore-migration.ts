// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §8.1 Крок E4 — the migration PROCEDURE: the forward path, the
// two markers, and recovery from every window in between.
//
// The pure half lives in gitignore-migrate.ts (scope, translation, the
// walk, the proposal assembly, the marker format). This module is the
// part that touches the vault, so it is where the crash windows are.
//
// ⚠️ TWO PHASES ON onload, and they are not interchangeable (§8.1.4):
//
//   runMigrationResume()  — BEFORE AtomicWriteRecovery.sweep. Only the
//     states holding a live `.ges-tmp`, because the sweep walks the whole
//     vault and drops any unmarked staging file ("Always safe to drop").
//     Needs neither the walk nor enforce(): the staging file is already
//     built and the marker's list is the source of truth. Same shape
//     recoverAutosaveDirs already has, for the same reason.
//
//   runMigrationFull()    — AFTER the sweep AND after enforce(). The fresh
//     run needs the ASSEMBLED root `.gitignore`, because §8.1.3 wraps the
//     migrated rules in that file's own two halves.
//
// Reverse the order and the two requirements are simply contradictory:
// enforce() writes through atomicWriteFile, so it must follow a sweep
// whose purpose is clearing foreign half-writes before the engine touches
// the vault.
//
// Canonical spec: docs/tasks/SYNC2-DOT-FILES-REFACTOR.md §8.1.4.

import { normalizePath, type Vault } from "obsidian";
import { safeRename } from "./cross-platform";
import {
  buildSiblingFilePath,
  MIGRATION_DEVICE_LABEL,
} from "./conflict-siblings";
import { SYNC_TMP_SUFFIX } from "./atomic-write";
import {
  findMigrationCandidates,
  translateFile,
  stripOurPluginsDirTemplate,
  splitAtFinalSection,
  buildMigrationProposal,
  serializeMigrationList,
  parseMigrationList,
} from "./gitignore-migrate";

// In the PLUGIN DIR, not `.runtime/`. RESET does `rmdir(.runtime, true)`,
// and a half-renamed migration must still finish afterwards — the exact
// reason `.reset-in-progress` lives there too (reset.ts).
export const IN_PROGRESS_MARKER_NAME = ".gitignore-migration-in-progress";

// In `.runtime/`, so a RESET makes the migration run again. Deliberate:
// "reset everything" should mean it. The re-run finds no live nested
// `.gitignore` (they are `*.bak`) and completes silently.
//
// DOT-prefixed and extension-less, like every marker in this plugin —
// that shape IS how a marker is told apart from data at a glance. It
// holds JSON all the same: a marker may carry content (`token_expired`
// carries its kind tag), and what makes it a marker is what it DECIDES,
// not how much it says.
export const DONE_MARKER_NAME = ".gitignore-migration-done";

// ⚠️ Shipped once as `gitignore-migration-done.json`, before the naming
// rule was written down. Read-through exists so the rename does not throw
// away a `remotePending` list: those paths are the ONLY record of what
// §8.1.6 still has to delete from the remote, and losing them would leave
// nested `.gitignore` files on the server forever, silently — exactly the
// divergence the step exists to end. Self-healing: the first read rewrites
// under the new name and removes the old one, so this never runs twice.
const LEGACY_DONE_MARKER_NAME = "gitignore-migration-done.json";

export interface MigrationDeps {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  // "Would git refuse to ENTER this directory?" — see
  // findMigrationCandidates for why this must be a DIRECTORY verdict from
  // a GI honouring every level.
  dirIgnored: (relDir: string) => boolean | Promise<boolean>;
  nowMs: () => number;
  // GitignoreInvariants.enforce. ⚠️ The migration CALLS it rather than
  // being called after it, because the right order is not "enforce then
  // migrate": enforce REWRITES `<configDir>/plugins/.gitignore` whole, so
  // running it first destroys the very user content this is meant to
  // rescue. Only the migration knows that the ROOT file must be assembled
  // BUT the plugins file must be saved first, so the order lives here, in
  // one place, where a caller cannot get it wrong.
  enforce?: () => Promise<void>;
  logger?: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
}

export type MigrationKind =
  // The done marker is present; nothing to do.
  | "already-done"
  // Ran, found no non-whitelisted `.gitignore`. Marked done.
  | "nothing-found"
  // Ran, moved rules, raised a proposal. Marked done.
  | "migrated"
  // Finished an interrupted run. Marked done.
  | "resumed"
  // The walk could not complete, so a `.gitignore` may have been missed.
  // NOT marked done — the next run looks again.
  | "incomplete"
  // The root file has no `final` section, so no proposal can be built
  // without risking the absolute rules. NOT marked done.
  | "refused"
  // ⚠️ Sources are already `*.bak` but the staging file is gone, so the
  // rules cannot be re-derived. Should be unreachable while resume
  // precedes the sweep; detected rather than assumed away.
  | "stalled";

export interface MigrationResult {
  kind: MigrationKind;
  // Source `.gitignore` paths that were renamed away. Also what §8.1.6's
  // remote deletion needs, which is why the done marker records them.
  sources: string[];
  // The proposal raised, when one was.
  conflictPath: string | null;
  // Set for `incomplete` / `refused` / `stalled`, for the caller to log
  // or surface.
  reason?: string;
}

export interface DoneMarker {
  migratedAt: number;
  sources: string[];
  // Paths §8.1.6 must still delete from the remote. Emptied by the drain
  // that performs them. Paths only, not {path, sha}: an arbitrary
  // interval passes before that drain, so the only correct answer to "is
  // this path on the server" is the one read at the time.
  remotePending: string[];
}

function pluginDir(deps: MigrationDeps): string {
  return normalizePath(
    `${deps.vault.configDir}/plugins/${deps.selfPluginId}`,
  );
}

function inProgressPath(deps: MigrationDeps): string {
  return normalizePath(`${pluginDir(deps)}/${IN_PROGRESS_MARKER_NAME}`);
}

function donePath(deps: MigrationDeps): string {
  return normalizePath(`${pluginDir(deps)}/.runtime/${DONE_MARKER_NAME}`);
}

function legacyDonePath(deps: MigrationDeps): string {
  return normalizePath(
    `${pluginDir(deps)}/.runtime/${LEGACY_DONE_MARKER_NAME}`,
  );
}

// Has the migration completed? Both marker names, because the answer must
// not change just because the file was renamed — a device that ran the
// migration under the old name has ALREADY done it, and re-running would
// be wrong.
async function doneMarkerExists(deps: MigrationDeps): Promise<boolean> {
  return (
    (await deps.vault.adapter.exists(donePath(deps))) ||
    (await deps.vault.adapter.exists(legacyDonePath(deps)))
  );
}

async function readIfPresent(
  vault: Vault,
  path: string,
): Promise<string | null> {
  try {
    if (!(await vault.adapter.exists(path))) return null;
    return await vault.adapter.read(path);
  } catch {
    return null;
  }
}

// The proposal's disk name, and the staging name it is renamed from.
// Derived from the RESERVED label, which is also how the pre-sync gate
// recognises the class (§8.1.5a).
function proposalPathFor(atMs: number): string {
  return buildSiblingFilePath(".gitignore", atMs, MIGRATION_DEVICE_LABEL);
}

// Any proposal already on disk, whatever its timestamp. Recovery needs
// this: it knows a run was interrupted but not which moment named it.
async function findExistingProposal(vault: Vault): Promise<string | null> {
  try {
    const { files } = await vault.adapter.list("");
    const prefix = `.gitignore.conflict-from-${MIGRATION_DEVICE_LABEL}-`;
    for (const f of files) {
      const p = normalizePath(f);
      if (p.startsWith(prefix) && !p.endsWith(SYNC_TMP_SUFFIX)) return p;
    }
  } catch {
    // Unreadable root is handled by the callers' own failure paths.
  }
  return null;
}

async function findStagingProposal(vault: Vault): Promise<string | null> {
  try {
    const { files } = await vault.adapter.list("");
    const prefix = `.gitignore.conflict-from-${MIGRATION_DEVICE_LABEL}-`;
    for (const f of files) {
      const p = normalizePath(f);
      if (p.startsWith(prefix) && p.endsWith(SYNC_TMP_SUFFIX)) return p;
    }
  } catch {
    // Same.
  }
  return null;
}

// First free name in `.bak`, `.bak2`, `.bak3`… NEVER overwrite: POSIX
// rename would clobber an older backup silently and Capacitor would
// throw, and both are worse than an extra suffix (owner, 2026-09-27).
async function freeBakPath(vault: Vault, source: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${source}.bak` : `${source}.bak${n}`;
    if (!(await vault.adapter.exists(candidate))) return candidate;
  }
}

// Step 3. Idempotent per file — which is what lets recovery cases 3 and 4
// share one action: a source that is already gone was already renamed.
async function renameSourcesAway(
  deps: MigrationDeps,
  sources: string[],
): Promise<void> {
  for (const source of sources) {
    if (!(await deps.vault.adapter.exists(source))) continue;
    const bak = await freeBakPath(deps.vault, source);
    await safeRename(deps.vault.adapter, source, bak);
    deps.logger?.info("gitignore migration: source renamed", { source, bak });
  }
}

// Steps 5 and 6, in that order. The done marker goes down BEFORE the
// in-progress one is lifted, so the only reachable in-between state is
// "both present", which recovery case 1 resolves by finishing step 6.
// The reverse order would leave a window with NEITHER marker, and a run
// interrupted there would redo everything.
async function finish(
  deps: MigrationDeps,
  sources: string[],
): Promise<void> {
  // ⚠️ remotePending MERGES with whatever is already recorded. A manual
  // re-run can land before the drain that consumes the previous run's
  // list (§8.1.6), and replacing it would silently drop those paths — the
  // nested `.gitignore` files would stay on the remote forever, which is
  // the one thing the deletion step exists to prevent.
  const prior = await readDoneMarker(deps);
  const pending = new Set([...(prior?.remotePending ?? []), ...sources]);
  const marker: DoneMarker = {
    migratedAt: deps.nowMs(),
    sources: [...new Set([...(prior?.sources ?? []), ...sources])],
    remotePending: [...pending],
  };
  const dir = `${pluginDir(deps)}/.runtime`;
  if (!(await deps.vault.adapter.exists(dir))) {
    await deps.vault.adapter.mkdir(dir);
  }
  await deps.vault.adapter.write(donePath(deps), JSON.stringify(marker, null, 2));
  const inProgress = inProgressPath(deps);
  if (await deps.vault.adapter.exists(inProgress)) {
    await deps.vault.adapter.remove(inProgress);
  }
}

// ── PHASE 1 — resume, BEFORE AtomicWriteRecovery.sweep ──────────────
export async function runMigrationResume(
  deps: MigrationDeps,
): Promise<MigrationResult> {
  const none = { sources: [], conflictPath: null };

  // Case 1 — the done marker is down, so step 6 is all that can be left.
  if (await doneMarkerExists(deps)) {
    const inProgress = inProgressPath(deps);
    if (await deps.vault.adapter.exists(inProgress)) {
      await deps.vault.adapter.remove(inProgress);
      deps.logger?.info("gitignore migration: stale in-progress marker cleared");
    }
    return { kind: "already-done", ...none };
  }

  const raw = await readIfPresent(deps.vault, inProgressPath(deps));
  // No marker: either nothing ever ran, or case 2 (a staging file with no
  // marker). Case 2 needs no action here — the sweep performs exactly the
  // deletion it wants, and the full run then starts fresh.
  if (raw === null) return { kind: "already-done", ...none };

  const sources = parseMigrationList(raw);
  if (sources === null) {
    // A torn marker cannot be trusted as a list, and must NOT be read as
    // an empty one — that would mark a migration done having moved
    // nothing. Discard it so the full run starts over.
    deps.logger?.warn(
      "gitignore migration: in-progress marker incomplete, discarding",
    );
    await deps.vault.adapter.remove(inProgressPath(deps));
    return { kind: "already-done", ...none };
  }

  // Marker says there was nothing to migrate — step 4 is skipped by
  // definition, so only steps 5 and 6 remain.
  if (sources.length === 0) {
    await finish(deps, []);
    return { kind: "resumed", sources: [], conflictPath: null };
  }

  const existing = await findExistingProposal(deps.vault);
  if (existing !== null) {
    // Case 5 — step 4 already happened. Step 3 is idempotent, so running
    // it again costs one `exists` per source and closes the window where
    // it had only partly finished.
    await renameSourcesAway(deps, sources);
    await finish(deps, sources);
    return { kind: "resumed", sources, conflictPath: existing };
  }

  const staging = await findStagingProposal(deps.vault);
  if (staging !== null) {
    // Cases 3 and 4 — the staging file is intact, so the list is
    // trustworthy and the rest of the forward path simply continues.
    await renameSourcesAway(deps, sources);
    const proposal = staging.slice(0, -SYNC_TMP_SUFFIX.length);
    await safeRename(deps.vault.adapter, staging, proposal);
    await finish(deps, sources);
    return { kind: "resumed", sources, conflictPath: proposal };
  }

  // ⚠️ Neither proposal nor staging, but the marker names sources. The
  // rules are in `*.bak` and cannot be re-derived, because the walk can
  // no longer see the files they came from. Should be unreachable while
  // this runs before the sweep; reported rather than assumed away, and
  // the marker is KEPT so the situation is not forgotten.
  deps.logger?.error(
    "gitignore migration STALLED: sources were renamed but the staged " +
      "proposal is gone. Their rules are in the .bak files listed here " +
      "and must be restored by hand.",
    { sources },
  );
  return {
    kind: "stalled",
    sources,
    conflictPath: null,
    reason: "staged proposal missing after sources were renamed",
  };
}

// ── PHASE 2 — the fresh run, AFTER the sweep and AFTER enforce() ────
export async function runMigrationFull(
  deps: MigrationDeps,
  opts: { force?: boolean } = {},
): Promise<MigrationResult> {
  const none = { sources: [], conflictPath: null };
  // The done marker gates the AUTOMATIC run only. The Settings button
  // (§8.1.5) exists precisely for the case the marker cannot cover: a
  // user who added a nested `.gitignore` after the first run.
  if (!opts.force && (await doneMarkerExists(deps))) {
    return { kind: "already-done", ...none };
  }

  // ── BEFORE enforce: rescue `<configDir>/plugins/.gitignore` ───────
  //
  // Field report 2026-09-28: a rule a user added to that file was silently
  // replaced by our template, with no `.bak` and no mention in the modal.
  // The cause was the wiring — enforce() ran first and rewrote the file
  // WHOLE (its own comment: "no user content here to preserve"), so by the
  // time the walk read it there was nothing left to find.
  //
  // Owner's rule: compare with our template; identical → drop it from the
  // process; different → carry its rules into the proposal, move the file
  // to `.bak`, and let our template take its place.
  //
  // ⚠️ Known window, stated rather than papered over: between the rename
  // and the staged proposal, a crash leaves the user's bytes in the `.bak`
  // and nothing pointing at them. Nothing is DESTROYED — that is the point
  // of renaming first — but the next run would not re-offer them, and the
  // user would have to find the `.bak` themselves. Closing it would mean a
  // second recovery path for a single file; the trade is deliberate.
  const pluginsPath = `${deps.configDir}/plugins/.gitignore`;
  const pluginsDir = `${deps.configDir}/plugins`;
  let rescued: string | null = null;
  const pluginsRaw = await readIfPresent(deps.vault, pluginsPath);
  if (pluginsRaw !== null) {
    const stripped = stripOurPluginsDirTemplate(pluginsRaw);
    // "Identical to our template" is exactly "nothing survives the strip",
    // and saying it that way makes it tolerant of line order and spacing
    // instead of demanding a byte match.
    if (translateFile(stripped, pluginsDir).length > 0) {
      const bak = await freeBakPath(deps.vault, pluginsPath);
      await safeRename(deps.vault.adapter, pluginsPath, bak);
      rescued = stripped;
      deps.logger?.info("gitignore migration: rescued plugins/.gitignore", {
        bak,
      });
    }
  }

  // §8.1.3 needs the ASSEMBLED root file — the proposal is built out of its
  // own two halves — so enforce runs HERE: after the rescue above, before
  // anything that reads the root. It also recreates the plugins file from
  // the template, which is the second half of the owner's rule.
  await deps.enforce?.();

  const rootContent = await readIfPresent(deps.vault, ".gitignore");
  const split = rootContent === null ? null : splitAtFinalSection(rootContent);
  if (split === null) {
    // enforce() runs before this, so the section is there in practice.
    // Refusing rather than improvising matters because the proposal
    // BECOMES the root file when accepted: one without the bottom half
    // would drop the absolute rules, `*.conflict-from-*` included, and
    // every sibling in the vault would become pushable.
    return {
      kind: "refused",
      ...none,
      reason: "root .gitignore has no final section",
    };
  }

  const walk = await findMigrationCandidates({
    vault: deps.vault,
    configDir: deps.configDir,
    dirIgnored: deps.dirIgnored,
  });
  if (!walk.completed) {
    // A `.gitignore` may have been missed, so the done marker must NOT go
    // down — otherwise the migration would never look again.
    return {
      kind: "incomplete",
      ...none,
      reason: "the vault walk could not finish",
    };
  }
  deps.logger?.info("gitignore migration: walk finished", {
    dirsScanned: walk.dirsScanned,
    dirsPruned: walk.dirsPruned,
    candidates: walk.candidates.length,
  });

  if (walk.candidates.length === 0 && rescued === null) {
    // Steps 1 and 4 are skipped: nothing to stage, nothing to rename. The
    // marker pair still runs, so the protocol has one shape rather than
    // two and recovery's "marker is only 0" branch stays live.
    await deps.vault.adapter.write(
      inProgressPath(deps),
      serializeMigrationList([]),
    );
    await finish(deps, []);
    return { kind: "nothing-found", ...none };
  }

  // Shallowest-first, which is why translate happens in walk order:
  // last-match-wins means a deeper rule must land LATER in the file.
  const blocks: string[][] = [];
  const sources: string[] = [];
  // ⚠️ TWO lists, and conflating them is a real bug the tests caught.
  // `toRename` drives step 3 and goes into the crash marker; `sources` is
  // what the user is TOLD about. The rescued plugins file belongs only to
  // the second: it was already renamed above, and enforce() RECREATED it
  // from the template — so putting it in step 3's list would rename our
  // own fresh template to `.bak2` and leave the folder without the file.
  // The same list drives step 3 on resume, so the exclusion has to be in
  // the marker, not just in this pass.
  const toRename: string[] = [];
  if (rescued !== null) {
    // Its block goes FIRST: it is the shallowest source there is, and
    // shallowest-first is semantic here (last-match-wins).
    blocks.push(translateFile(rescued, pluginsDir));
    sources.push(pluginsPath);
  }
  const pluginsDirGitignore = pluginsPath;
  for (const candidate of walk.candidates) {
    const raw = await readIfPresent(deps.vault, candidate.path);
    if (raw === null) continue; // vanished mid-run — skip-class
    // Our own managed template must not travel into the root file.
    const content =
      candidate.path === pluginsDirGitignore
        ? stripOurPluginsDirTemplate(raw)
        : raw;
    const block = translateFile(content, candidate.dir);
    // ⚠️ RENAME ONLY WHAT CONTRIBUTED. Renaming is the destructive half,
    // and doing it for a file whose rules we did not take buys nothing:
    // for `<configDir>/plugins/.gitignore` it would be pure churn, since
    // enforce() owns that file and recreates it on the next pass, leaving
    // a stray `.bak` behind. A file with no rules had no effect to
    // preserve either way.
    if (block.length === 0) continue;
    blocks.push(block);
    sources.push(candidate.path);
    toRename.push(candidate.path);
  }
  if (sources.length === 0) {
    // (The rescue above would have put a source here, so reaching this
    // means neither it nor the walk found anything worth moving.)
    // Candidates existed but none carried a rule worth moving — the same
    // outcome as finding none, and it must be recorded the same way or
    // the migration would never stop looking.
    await deps.vault.adapter.write(
      inProgressPath(deps),
      serializeMigrationList([]),
    );
    await finish(deps, []);
    return { kind: "nothing-found", ...none };
  }

  const at = deps.nowMs();
  const proposal = proposalPathFor(at);
  const staging = `${proposal}${SYNC_TMP_SUFFIX}`;

  // Step 1. A PLAIN write, deliberately not atomicWriteFile: that would
  // stage under its own `.ges-tmp` AND drop a modify-marker, and the
  // sweep would then FORWARD-COMPLETE our half-built file onto the
  // proposal path. A bare staging file is the one the sweep drops, which
  // is exactly the semantics recovery case 2 relies on.
  await deps.vault.adapter.write(
    staging,
    buildMigrationProposal(split, blocks),
  );
  // Step 2 — the list becomes durable only now, so a crash before this
  // leaves a staging file nobody claims (case 2) rather than renamed
  // sources nobody can explain.
  await deps.vault.adapter.write(
    inProgressPath(deps),
    serializeMigrationList(toRename),
  );
  // Step 3, then 4.
  await renameSourcesAway(deps, toRename);
  await safeRename(deps.vault.adapter, staging, proposal);
  // ⚠️ `toRename`, not `sources`: §8.1.6 deletes from the REMOTE, and the
  // rescued `<configDir>/plugins/.gitignore` never travels there — its own
  // canonical content starts with `/.gitignore`, which hides it. Passing it
  // was harmless (the tree filter drops what is not on the server) but it
  // is a path we would be asking about for no reason, and the field log
  // showed it sitting in `pending` where a reader would wonder why.
  await finish(deps, toRename);

  deps.logger?.info("gitignore migration: done", {
    sources,
    proposal,
  });
  return { kind: "migrated", sources, conflictPath: proposal };
}

// What the Settings button says, for each outcome (§8.1.5). Pure, because
// the wording is the feature: this is the only surface that reports a
// `.gitignore` problem on its own, so vague copy here means a user who
// never learns their rules are in dispute.
//
// ⚠️ The three states the owner specified: new files found → say what
// moved; nothing new but a proposal still unresolved → REMIND, with a way
// in; nothing at all → say so reassuringly, because "no output" reads as
// "the button is broken".
export function migrationReportText(
  result: MigrationResult,
  unresolvedProposal: string | null,
): { title: string; body: string; resolvePath: string | null } {
  const n = result.sources.length;
  const files = `${n} .gitignore ${n === 1 ? "file" : "files"}`;
  switch (result.kind) {
    case "migrated":
      return {
        title: "Rules collected",
        body:
          `${files} outside the root were found. Their rules have been ` +
          `translated and offered as a change to the root .gitignore; the ` +
          `originals were renamed to .bak, so nothing was deleted. ` +
          `Syncing stays paused until you accept or discard the change.`,
        resolvePath: result.conflictPath,
      };
    case "already-done":
    case "nothing-found":
      return unresolvedProposal !== null
        ? {
            title: "One thing still open",
            body:
              "No new .gitignore files were found, but an earlier proposed " +
              "change to the root .gitignore has not been resolved yet. " +
              "Syncing stays paused until it is.",
            resolvePath: unresolvedProposal,
          }
        : {
            title: "No problems with .gitignore files",
            body:
              "Every .gitignore rule in this vault lives in the root file, " +
              "which is the only one this plugin reads. Nothing to do.",
            resolvePath: null,
          };
    case "resumed":
      return {
        title: "Finished an interrupted check",
        body: `A previous check was interrupted and has now completed (${files}).`,
        resolvePath: result.conflictPath ?? unresolvedProposal,
      };
    case "incomplete":
      return {
        title: "Could not check the whole vault",
        body:
          "Part of the vault could not be read, so a .gitignore file may " +
          "have been missed. Nothing was changed. Try again — the check " +
          "has NOT been marked as done.",
        resolvePath: null,
      };
    case "refused":
      return {
        title: "Root .gitignore is not ready",
        body:
          "The plugin's managed block is missing from the root .gitignore, " +
          "so a change to it cannot be prepared safely. It is rewritten on " +
          "the next sync — try again after that.",
        resolvePath: null,
      };
    case "stalled":
      return {
        title: "A previous check did not finish",
        body:
          `${files} were renamed to .bak but their rules were never saved. ` +
          `The .bak files still hold them and must be restored by hand; ` +
          `the log lists which.`,
        resolvePath: null,
      };
  }
}

// §8.1.6 — the remote deletion consumed the pending list. Clearing is a
// SEPARATE write from the push on purpose, and it happens AFTER it: if the
// push lands and this fails, the next attempt re-reads the tree, finds the
// paths already absent, and clears without pushing anything. A redundant
// deletion entry is the one thing that must never be sent — it is the
// known `422 BadObjectState` (memory project-github-422-on-deletion-entry).
export async function clearRemotePending(deps: MigrationDeps): Promise<void> {
  const marker = await readDoneMarker(deps);
  if (marker === null) return;
  await deps.vault.adapter.write(
    donePath(deps),
    JSON.stringify({ ...marker, remotePending: [] }, null, 2),
  );
}

// Read the done marker, for §8.1.6's remote deletion and for the Settings
// report. Returns null when the migration has not completed.
export async function readDoneMarker(
  deps: MigrationDeps,
): Promise<DoneMarker | null> {
  let raw = await readIfPresent(deps.vault, donePath(deps));
  if (raw === null) {
    // One-time read-through from the pre-rename name, then heal.
    raw = await readIfPresent(deps.vault, legacyDonePath(deps));
    if (raw === null) return null;
    try {
      await deps.vault.adapter.write(donePath(deps), raw);
      await deps.vault.adapter.remove(legacyDonePath(deps));
      deps.logger?.info("gitignore migration: marker renamed to the dot form");
    } catch {
      // The read succeeded, which is what the caller needs; healing can
      // wait for the next pass rather than fail the run.
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DoneMarker>;
    if (!Array.isArray(parsed.sources)) return null;
    return {
      migratedAt: typeof parsed.migratedAt === "number" ? parsed.migratedAt : 0,
      sources: parsed.sources.filter((s): s is string => typeof s === "string"),
      remotePending: Array.isArray(parsed.remotePending)
        ? parsed.remotePending.filter((s): s is string => typeof s === "string")
        : [],
    };
  } catch {
    return null;
  }
}
