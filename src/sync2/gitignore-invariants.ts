// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import InvariantStateStore, {
  InvariantFileState,
  SectionId,
} from "./invariant-state";
import GitignoreSeedStore from "./gitignore-seeds";
import {
  assembleManagedSections,
  ManagedSection,
} from "./gitignore-assemble";
import { atomicWriteFile } from "./atomic-write";

// Markers of the managed `invariants` section. Editing anything between
// BEGIN and END on disk triggers a rewrite back to canonical on the next
// sync.
//
// 🔒 FROZEN FOREVER (DOT-FILES §3.1.3). Not the punctuation, not the case,
// not the number of `=`. These two lines are the ONLY bridge between plugin
// versions: a version that rewrites a marker finds no section in any
// existing install, appends a second one, and leaves the first behind as
// litter that can override it by last-match-wins.
//
// ⚠️ They were redefined ONCE, on 2026-09-21, while the plugin still had a
// single user (the owner) — ASCII instead of the em dash, and the plugin
// name in the closing line too, so the section's boundaries read clearly.
// Same class of act as the rename: cheap then, impossible after. Em-dash
// sections already on disk are NOT recognised and are removed by hand; no
// legacy-marker list lives in this code, by decision.
export const INVARIANTS_BEGIN =
  "# ===== git-easy-sync invariants - DO NOT EDIT =====";
export const INVARIANTS_END =
  "# ===== end of git-easy-sync invariants =====";

// Markers of the managed `final` section — the one nothing may override.
// Same 🔒 frozen contract as the pair above, same 2026-09-21 birthday.
// It is a SEPARATE pair because the two sections mean opposite things
// about user authority (§3.1): `invariants` is a default the user is
// invited to tune from below, `final` is not up for discussion. One pair
// could not express that, since in gitignore position IS strength.
export const FINAL_BEGIN = "# ===== git-easy-sync final - DO NOT EDIT =====";
export const FINAL_END = "# ===== end of git-easy-sync final =====";

// Markers + body are DELIBERATELY separate values (DOT-FILES §3.1.3). The
// two halves have opposite life cycles — markers are frozen forever, bodies
// change freely with every redesign of the rules — and while they lived in
// one template nothing structurally stopped an edit to the content from
// nicking the "brackets" and silently orphaning the section on every
// install. Composition happens at the write site, here:
function composeSection(begin: string, body: string, end: string): string {
  return `${begin}\n${body}\n${end}`;
}

// Body of the invariant block in <configDir>/.gitignore. The plugin
// rewrites this block in place; the user keeps full ownership of any
// content above or below it.
// Whole content of `<configDir>/plugins/.gitignore` — the per-device
// "Sync plugins data.json" switch, materialised (DOT-FILES §3.1.4).
// Ours outright, rewritten from the setting on every pass; no markers,
// because there is no user content here to preserve.
//
// Three things about it are load-bearing, each measured against real
// git as well as our matcher:
//
//   `*/data.json` — NOT `plugins/*/data.json`. A .gitignore anchors to
//   its OWN directory, so at this level the second form would mean
//   `<configDir>/plugins/plugins/*/data.json` and match nothing.
//
//   the level — one ABOVE the plugin folders, which is what lets a
//   plugin's own `.gitignore` speak last and overrule the switch in
//   either direction. That is intended: the user asked for it, and a
//   hardcoded gate (the syncConfigDir shape) could not provide it.
//
//   the first line — ANCHORED `/.gitignore`, hiding this file alone.
//   The bare form would match a `.gitignore` at ANY depth below here,
//   i.e. every plugin's own one, and since this node is above them it
//   would silently undo `!/plugins/*/.gitignore` from <configDir>.
//   Exactly the trap §3.1.1 documents for the configDir node; caught
//   here by an existing test rather than by reading. The file must not
//   travel (the switch is per-device), and because this node is the
//   deepest one speaking about its own path, no rule above can undo
//   that — verified against git with `!`-rules planted in the root
//   file, in <configDir>/.gitignore, and in both at once.
function pluginsDirGitignore(pushPluginsDataJson: boolean): string {
  return `# git-easy-sync: per-device switch "Sync plugins data.json".
# Managed file - edit the setting, not this.
/.gitignore
${pushPluginsDataJson ? "!*/data.json" : "*/data.json"}
`;
}

// BODY (no markers) of the managed `final` section in
// <configDir>/.gitignore — the SINGLE place that decides what it looks
// like, so there is no duplication and no per-call drift.
//
// There is no `invariants` section in this file at all (DOT-FILES
// §3.1.1): everything we write here protects data, and nothing in it is
// a default the user is invited to overrule. Being last is what makes
// that true — and it is also what closes both pinned toggle defects
// (§3.4.1), since our data.json line now outranks both the recommended
// catch-all `plugins/*/*` above it and any relic allow-line from an
// older install.
//
// The two `!` lines re-admit control files at their OWN node: root `.*`
// catches `.gitignore` by basename at any depth, and re-admitting the
// DIRECTORY does not rescue a dot-FILE inside it (measured — §10 probe
// 4). Both are ANCHORED: bare `!.gitignore` would also resurrect
// `<configDir>/snippets/.gitignore`, a direct D6 violation.
function configDirFinalBody(opts: { syncConfigDir: boolean }): string {
  if (!opts.syncConfigDir) {
    // syncConfigDir=OFF. `/.gitignore` takes this file itself out of
    // sync (so the OFF decision does not travel), `*` silences the whole
    // subtree. Purely for git consistency: the hardcoded configDir gate
    // in isSyncable cuts all of <configDir>/ regardless of this text.
    //
    // ⚠️ The data.json line is carried through the OFF state even though
    // `*` below makes it inert. This gitignore is the ONLY store of that
    // toggle (that is what lets it travel between devices), so dropping
    // the line would silently reset the user's opt-in every time they
    // turned configDir sync off and on again. Inert, not absent.
    return `# Editing this block triggers a rewrite to canonical on next load.

# syncConfigDir is OFF on this device.
/.gitignore
*`;
  }
  return `# Editing this block triggers a rewrite to canonical on next load.

# Control files, re-admitted at their own node (anchored - bare forms
# would also resurrect nested ones).
!/.gitignore
!/plugins/*/.gitignore

# Per-device state - never propagate between machines.
workspace.json
workspace-mobile.json
community-plugins.json`;
}

// BODY of our `final` section inside a THIRD-PARTY plugin's .gitignore.
// null = the section must not be there at all.
//
// Only the OFF silencer ever goes here. Their node speaks last for
// everything under their folder, so an allowlist of theirs (`!main.js`
// and friends) would otherwise survive the `*` we put in <configDir>.
function foreignPluginFinalBodyFor(syncConfigDir: boolean): string | null {
  if (syncConfigDir) return null;
  return `# syncConfigDir is OFF on this device (git-easy-sync).
*`;
}

// Recommended defaults seeded ONLY when sync2 first creates
// <configDir>/.gitignore. Pre-existing files keep the user's content
// untouched; our managed section goes at the END, below all of it.
const CONFIG_DIR_RECOMMENDED_DEFAULTS = `# Recommended defaults - feel free to edit.

# Plugin folder allowlist - by default sync only the four canonical
# files (main.js, manifest.json, styles.css; data.json is governed
# by the settings-tab toggle "Push plugins data.json to GitHub",
# which lives in the managed block at the END of this file).
plugins/*/*
!plugins/*/
!plugins/*/main.js
!plugins/*/manifest.json
!plugins/*/styles.css`;

// Canonical content of <configDir>/plugins/<self>/.gitignore. Unlike
// the configDir gitignore, the plugin owns this file outright — full
// rewrite each time, no user content carried over.
function selfPluginGitignore(syncConfigDir: boolean): string {
  const allowlist = `*
!main.js
!manifest.json
!styles.css
!.gitignore
`;
  if (syncConfigDir) return allowlist;
  // Our own node speaks last for our own folder, so without this the
  // allowlist above keeps main.js visible to the matcher even with `*`
  // in <configDir> (§3.1.1). Same silencer the third-party files get,
  // but here it is simply part of the constant we own outright.
  return `${allowlist}${composeSection(
    FINAL_BEGIN,
    foreignPluginFinalBodyFor(false) as string,
    FINAL_END,
  )}\n`;
}

// BODY of the `invariants` section at the TOP of <vault>/.gitignore:
// the dot-hide policy (DOT-FILES §3.1, D1).
//
// ⚠️ This section is OVERRIDABLE ON PURPOSE, and its position is what
// makes it so. `!`-rules the user writes BELOW it win by last-match —
// that is the entire opt-in mechanism for dot-space (D2 source 3), the
// set §4.2 builds from, and the per-device control file of D6a.
// Measured 2026-09-21: moving these three lines to the bottom silently
// kills all three at once.
//
//   `.*`  hides any dot-BASENAME at any depth
//   `.*/` hides dot-DIRECTORIES (redundant - `.*` catches those too;
//         kept for explicitness, §10 probe 5-E)
//   `!/.gitignore` ANCHORED to root, so only the root control file
//         comes back. NOT `!.gitignore` (would un-hide `notes/.gitignore`
//         and break D6) and NOT `!./.gitignore` (matches nothing at all).
const ROOT_INVARIANTS_BODY = `# Editing this block triggers a rewrite to canonical on next load.
# Rules BELOW this block override it - that is how you opt a dot-file
# or an anchored dot-directory back into sync.

# Everything starting with a dot is invisible to sync by default.
.*
.*/

# ...except this file, the one that decides the rest.
!/.gitignore`;

// BODY of the `final` section at the END of <vault>/.gitignore: the
// rules that are NOT up for discussion (DOT-FILES §3.1).
//
// A `!`-rule of the user's must not be able to resurrect any of these,
// which is precisely why they live at the bottom rather than beside the
// dot-hide policy above. Conflict siblings are per-device markers, and
// propagating them creates feedback loops where one device's deferred
// state lands on the others as unrelated files; the staging artifacts
// are transient files of the crash-safe write protocol.
//
// `!<configDir>/` re-admits the config subtree UNCONDITIONALLY — it does
// NOT follow the syncConfigDir toggle. Switching that off acts one level
// down, inside <configDir>/.gitignore and the plugin files, so both root
// sections stay constants and all the state lives in one place.
function rootFinalBody(configDir: string): string {
  return `# Editing this block triggers a rewrite to canonical on next load.
# These rules are final - nothing below or above overrides them.

# The config subtree, governed by its own .gitignore files from here on.
!${configDir}/

# Conflict-resolver sibling files - per-device markers that must
# never propagate via sync.
*.conflict-from-*

# Atomic-write staging + backup artifacts.
# Transient files written by the crash-safe write protocol; the
# onload recovery sweep cleans them up. Must never reach GitHub.
*.ges-tmp*
*.ges-bak*`;
}

// Recommended root-level defaults seeded ONLY when sync2 first
// creates <vault>/.gitignore. They sit BETWEEN the two managed
// sections: overridable like everything in the user's zone.
const ROOT_RECOMMENDED_DEFAULTS = `# Recommended defaults - feel free to edit.

# Logs (covers the plugin's own <plugin-id>.log at the vault root
# plus any other *.log anywhere in the vault). Remove this line if
# you want logs to sync to GitHub - useful for analysing mobile
# logs from desktop, but multi-device writes will collide on the
# same filename.
*.log

# OS noise
.DS_Store
.AppleDouble
.LSOverride
Icon
._*
Thumbs.db
ehthumbs.db
desktop.ini

# Trash can and deleted files
$RECYCLE.BIN/
.trash/
.trashed-*

# Editor/backup junk
*~
*.swp
*.swo
.vscode/
.idea/`;

export interface GitignoreInvariantsDeps {
  vault: Vault;
  state: InvariantStateStore;
  configDir: string;
  selfPluginId: string;
  // DOT-FILES §8.0 seed markers. REQUIRED, not optional — learned the
  // hard way on 2026-09-20: an earlier shape of this fix shipped as an
  // optional dep with a harmless default, the integration harness
  // (which builds its own composition) never passed it, and the fix
  // was inert everywhere except main.ts. A mandatory dep turns that
  // class of mistake into a compile error at every construction site.
  seeds: GitignoreSeedStore;
  // Called when a managed section could not be brought to canonical
  // cleanly (DOT-FILES §3.1.3). REQUIRED for the same reason `seeds` is:
  // an optional reporter with a silent default is a reporter nobody
  // wires, and "unrepairable" is exactly the case the user has to be
  // told about — we deliberately do NOT guess where a damaged section
  // ended, so only they can finish the repair.
  onAnomaly: (report: SectionAnomalyReport) => void;
  // The rule matcher whose parse we are about to invalidate. Narrow on
  // purpose: this owner writes .gitignore files, it does not ask
  // questions of them.
  //
  // Required because the alternative is a silent, same-pass bug: `gi`
  // keys a parsed level on its mtime and trusts it for 500 ms
  // (gi.ts STAT_COOLDOWN_MS), so without this the isSyncable calls that
  // FOLLOW this pass, inside the same commit or drain, would answer from
  // the rules we just replaced.
  gi: GitignoreMatcherCache;
  // Per-device configDir gate, read LIVE (a getter, not a boolean) so
  // flipping the settings checkbox takes effect on the very next pass
  // without re-instantiating anything. Same shape ChangeDetector uses.
  syncConfigDir: () => boolean;
  // Per-device "Sync plugins data.json", read live for the same reason
  // (DOT-FILES §3.1.4). Materialised as <configDir>/plugins/.gitignore
  // rather than enforced in isSyncable, so a plugin's own .gitignore
  // can still overrule it.
  pushPluginsDataJson: () => boolean;
}

export interface GitignoreMatcherCache {
  invalidate(dir?: string): void;
}

// What a managed file is made of: the sections it carries, and the ones
// it must NOT carry (an older version put an `invariants` block into
// <configDir>/.gitignore; §3.1.1 says that file has none).
type ManagedSectionSet = {
  invariants?: ManagedSection;
  final?: ManagedSection;
  remove?: ManagedSection[];
};

export interface SectionAnomalyReport {
  path: string;
  section: SectionId;
  anomaly: SpliceAnomaly;
  // Set for "duplicate-removed": the line we deleted from the user's
  // own space. The removal is deliberate (§3.1.5) and therefore has to
  // be legible — which means naming the line, not just the event.
  line?: string;
}

// Owner of the two managed gitignore files. Public surface:
//   - enforce(): bring both files into canonical state, skipping work
//                when on-disk mtime+hash match the cached state.
//   - notePathSelfWritten(path): used by Sync2Manager.recordSync after
//                a sync2-driven push of one of these files, so the
//                next enforce() sees an immediate cache hit.
export default class GitignoreInvariants {
  private readonly vault: Vault;
  private readonly state: InvariantStateStore;
  private readonly configDirGitignorePath: string;
  private readonly selfPluginGitignorePath: string;
  // Root <vault>/.gitignore. Bare ".gitignore" — relative to vault root.
  private readonly rootGitignorePath = ".gitignore";
  private readonly seeds: GitignoreSeedStore;
  private readonly onAnomaly: (report: SectionAnomalyReport) => void;
  private readonly gi: GitignoreMatcherCache;
  private readonly pluginsDir: string;
  private readonly syncConfigDir: () => boolean;
  private readonly pushPluginsDataJson: () => boolean;
  private readonly configDir: string;
  private readonly pluginsDirGitignorePath: string;

  constructor(deps: GitignoreInvariantsDeps) {
    this.vault = deps.vault;
    this.state = deps.state;
    this.seeds = deps.seeds;
    this.onAnomaly = deps.onAnomaly;
    this.gi = deps.gi;
    this.syncConfigDir = deps.syncConfigDir;
    this.pushPluginsDataJson = deps.pushPluginsDataJson;
    this.configDir = deps.configDir;
    this.configDirGitignorePath = `${deps.configDir}/.gitignore`;
    this.pluginsDir = `${deps.configDir}/plugins`;
    this.pluginsDirGitignorePath = `${this.pluginsDir}/.gitignore`;
    this.selfPluginGitignorePath = `${this.pluginsDir}/${deps.selfPluginId}/.gitignore`;
  }

  // Path of <configDir>/.gitignore. Exposed so callers (e.g.
  // Sync2Manager.recordSync) can recognise self-written paths.
  get configDirPath(): string {
    return this.configDirGitignorePath;
  }

  get selfPluginPath(): string {
    return this.selfPluginGitignorePath;
  }

  get rootPath(): string {
    return this.rootGitignorePath;
  }

  // The restore pass (DOT-FILES §3.1.2). Runs at the start of BOTH
  // commit and drain — they are separate operations and either can be
  // the first thing a session does.
  //
  // The file set is DYNAMIC, which is the whole reason this stopped
  // being three hardcoded calls: third-party `plugins/*/.gitignore`
  // appear and vanish with their plugins, and at syncConfigDir=OFF our
  // section has to reach every one of them that exists.
  //
  // Cost when nothing moved is one `adapter.list` of the plugins folder
  // plus one `stat` per file — no reads, no hashing. That is what makes
  // it affordable on every operation.
  async enforce(): Promise<void> {
    await this.enforceConfigDirGitignore();
    await this.enforceSelfPluginGitignore();
    await this.enforcePluginsDirGitignore();
    await this.enforceRootGitignore();
    for (const path of await this.foreignPluginGitignores()) {
      await this.enforceForeignPluginGitignore(path);
    }
    await this.pruneVanishedRecords();
  }

  // Third-party `<configDir>/plugins/<id>/.gitignore` files that EXIST
  // right now. We never create one: a plugin folder without its own
  // .gitignore has no deeper node, so the `*` in <configDir> already
  // hides it (measured — `plugins/plain/main.js` → hidden). Writing a
  // file into someone else's folder to say something already true would
  // be pure intrusion.
  private async foreignPluginGitignores(): Promise<string[]> {
    let entries: { folders: string[] };
    try {
      entries = await this.vault.adapter.list(this.pluginsDir);
    } catch {
      // No plugins folder yet (fresh vault), or unreadable. Nothing to
      // enumerate; the three files we own are handled above.
      return [];
    }
    const out: string[] = [];
    for (const folder of entries.folders) {
      const candidate = `${folder}/.gitignore`;
      if (candidate === this.selfPluginGitignorePath) continue;
      if (candidate === this.pluginsDirGitignorePath) continue;
      if (await this.vault.adapter.exists(candidate)) out.push(candidate);
    }
    return out;
  }

  // A plugin was uninstalled: its folder and .gitignore are gone. Drop
  // the record — keeping a fingerprint would be a claim about a file
  // that no longer exists, and the next install of the same plugin
  // would then be measured against a stranger's bytes.
  private async pruneVanishedRecords(): Promise<void> {
    for (const path of Object.keys(this.state.get())) {
      if (
        path === this.rootGitignorePath ||
        path === this.configDirGitignorePath ||
        path === this.selfPluginGitignorePath ||
        path === this.pluginsDirGitignorePath
      ) {
        continue;
      }
      if (!(await this.vault.adapter.exists(path))) {
        await this.state.remove(path);
      }
    }
  }

  // Called by Sync2Manager.recordSync after a successful self-push of
  // one of the invariant files. Updates the cached mtime+hash so the
  // next sync's enforce() short-circuits without re-reading.
  async notePathSelfWritten(path: string): Promise<void> {
    if (
      path === this.configDirGitignorePath ||
      path === this.selfPluginGitignorePath ||
      path === this.rootGitignorePath
    ) {
      // No section bodies to record: what landed here came from a pull,
      // not from us. Any fingerprint already on file is kept — it is
      // only ever used as a repair anchor, and a stale one simply fails
      // to match, which declines the repair. Safe direction.
      await this.refreshState(path);
    }
  }

  // ── internal ────────────────────────────────────────────────────────

  // `<configDir>/.gitignore`: user content untouched, our `final`
  // section placed at the end. There is no `invariants` section here —
  // everything we write into configDir protects data, and none of it is
  // a default the user is invited to overrule (DOT-FILES §3.1.1).
  //
  // The body no longer depends on the data.json toggle: that switch is
  // per-device now and lives in its own file one level down
  // (§3.1.4), so this one is a plain function of `syncConfigDir`.
  private async enforceConfigDirGitignore(): Promise<void> {
    const path = this.configDirGitignorePath;
    const body = configDirFinalBody({ syncConfigDir: this.syncConfigDir() });

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: the recommended defaults, then our section BELOW
      // them — the order that makes our rules outrank the catch-all
      // those defaults contain. Taken from seedFor so the bytes we write
      // and the bytes the marker expects cannot disagree.
      //
      // ⚠️ MISSING is not EMPTY. A zero-length .gitignore is the user's
      // decision ("I do not want your recommendations") and takes the
      // ordinary path below, which adds our sections and nothing else.
      const content = this.seedFor(path)!;
      await this.write(path, content);
      await this.refreshState(path, { final: body });
      await this.noteSeedState(path, content);
      return;
    }

    // Freshness gate (§3.1.2): skip the read when the file has not moved
    // AND the section we want is the section we recorded. The second
    // half is the one that was missing before — mtime+size cannot see a
    // plugin upgrade that changes the constant while the file sits
    // untouched, which is why the short-circuit had to be removed and
    // can now come back.
    if (await this.isFresh(path, stat, { final: body })) return;

    const content = await this.vault.adapter.read(path);

    const fixed = this.assemble(path, content);
    if (fixed === content) {
      await this.refreshState(path, { final: body });
      await this.noteSeedState(path, content);
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(path, { final: body });
    await this.noteSeedState(path, fixed);
  }

  // Same shape as enforceConfigDirGitignore but for the ROOT vault
  // gitignore. The forced rule here is `*.conflict-from-*`, which
  // pins per-device conflict-sibling files to local-only.
  private async enforceRootGitignore(): Promise<void> {
    const path = this.rootGitignorePath;

    const finalBody = rootFinalBody(this.configDir);
    const sections = {
      invariants: ROOT_INVARIANTS_BODY,
      final: finalBody,
    };

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: dot-hide policy on top, recommended OS/editor
      // noise defaults in the middle (the user's zone), the final rules
      // at the bottom — from seedFor, the single source (see there).
      //
      // ⚠️ MISSING is not EMPTY: an empty file is the user's decision
      // and takes the ordinary path.
      const content = this.seedFor(path)!;
      await this.write(path, content);
      await this.refreshState(path, sections);
      await this.noteSeedState(path, content);
      return;
    }

    // Same freshness gate as configDir — see the comment there for why
    // the fingerprint half is load-bearing (a plugin upgrade changes a
    // body while the file on disk never moves).
    if (await this.isFresh(path, stat, sections)) return;

    const content = await this.vault.adapter.read(path);

    const fixed = this.assemble(path, content);
    if (fixed === content) {
      await this.refreshState(path, sections);
      await this.noteSeedState(path, content);
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(path, sections);
    await this.noteSeedState(path, fixed);
  }

  // `<configDir>/plugins/.gitignore` — ours outright, same ownership
  // mode as the self-plugin file: rewritten from a constant, no user
  // content to preserve. What it says is the per-device switch
  // (DOT-FILES §3.1.4).
  private async enforcePluginsDirGitignore(): Promise<void> {
    const path = this.pluginsDirGitignorePath;
    const canonical = pluginsDirGitignore(this.pushPluginsDataJson());
    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      await this.write(path, canonical);
      await this.refreshState(path);
      return;
    }
    // No freshness short-circuit, for the same reason as the self-plugin
    // file: it is ~120 bytes, and skipping the read would need a
    // whole-file fingerprint the record does not carry.
    const content = await this.vault.adapter.read(path);
    if (content === canonical) {
      await this.refreshState(path);
      return;
    }
    await this.write(path, canonical);
    await this.refreshState(path);
  }

  private async enforceSelfPluginGitignore(): Promise<void> {
    const path = this.selfPluginGitignorePath;
    const canonical = selfPluginGitignore(this.syncConfigDir());

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      await this.write(path, canonical);
      await this.refreshState(path);
      return;
    }

    // Always read+compare against the canonical constant. No freshness
    // short-circuit here: the file is ~80 bytes, so the read costs
    // nothing, and skipping it would need a fingerprint of the WHOLE
    // file rather than of a section — a different shape than the record
    // holds, for no gain.
    const content = await this.vault.adapter.read(path);
    if (content === canonical) {
      // Already canonical — refresh cache only.
      await this.refreshState(path);
      return;
    }

    // Sync2 owns this file outright — overwrite anything the user (or
    // anything else) wrote into it.
    await this.write(path, canonical);
    await this.refreshState(path);
  }

  // ── DOT-FILES §8.0 seed markers ─────────────────────────────────
  // "This file, right now, is byte-identical to what WE would seed"
  // — the claim that lets the drain use it as a fake ancestor so the
  // repo's own .gitignore reads as an edit on top of ours instead of
  // an unrelated file (rule 4.3, clean pull) . Recomputed on every
  // pass rather than written once at seed time: a user edit that
  // enforce() deliberately leaves alone (anything outside our block)
  // must drop the claim on the very next pass.
  //
  // THE canonical content of a managed file: what the plugin writes
  // when the file does not exist yet, and — the same bytes, the same
  // call — what §8.0's seed marker compares against.
  //
  // ⚠️ ONE source, and that is the point. This layout used to be spelled
  // out in THREE places, each joining `\n\n` by hand: the fresh-install
  // branch for the root file, the one for <configDir>, and the seed
  // reference. Nothing compared them. A disagreement of a single blank
  // line would not fail anything — it would simply stop the marker from
  // ever being set, and the cold-start manual conflict §8.0 exists to
  // prevent would come back, days later, on another device, with no
  // trace in the log.
  //
  // Returns null for files we do not seed: <self>/.gitignore and
  // <configDir>/plugins/.gitignore are constants the plugin owns
  // outright and never negotiates, so they have no ancestor to offer.
  // Rebuild `content` into canonical form, and SAY what that cost the
  // user's own text.
  //
  // Removal is deliberate (§3.1.5 presupposition 2: a second copy of one
  // of our rules is forbidden), which is exactly why it must be loud —
  // silently deleting a line someone wrote is the defect class §4.2 had
  // to fix, and the owner asked for this one in the log.
  private assemble(path: string, content: string): string {
    const sections = this.sectionsFor(path);
    if (sections === null) return content;
    const r = assembleManagedSections(content, sections);
    for (const line of r.removed) {
      this.onAnomaly({ path, section: "invariants", anomaly: "duplicate-removed", line });
    }
    return r.content;
  }

  private seedFor(path: string): string | null {
    const sections = this.sectionsFor(path);
    if (sections === null) return null;
    return assembleManagedSections(this.defaultUserSpaceFor(path), sections)
      .content;
  }

  // The two managed sections a path carries, or null when the path is
  // not one we seed (<self>/.gitignore and <configDir>/plugins/.gitignore
  // are constants the plugin owns outright — nothing to negotiate, so
  // no ancestor to offer).
  private sectionsFor(path: string): ManagedSectionSet | null {
    if (path === this.rootGitignorePath) {
      return {
        invariants: {
          begin: INVARIANTS_BEGIN,
          end: INVARIANTS_END,
          body: ROOT_INVARIANTS_BODY,
        },
        final: {
          begin: FINAL_BEGIN,
          end: FINAL_END,
          body: rootFinalBody(this.configDir),
        },
      };
    }
    if (path === this.configDirGitignorePath) {
      // No `invariants` here BY DESIGN: nothing we write into the
      // config subtree is a default the user may overrule (§3.1.1).
      // An older version DID put one here, so it is named for removal —
      // left in place its per-device lines would still be in force,
      // above the section meant to be the only authority in this file.
      return {
        final: {
          begin: FINAL_BEGIN,
          end: FINAL_END,
          body: configDirFinalBody({ syncConfigDir: this.syncConfigDir() }),
        },
        remove: [
          { begin: INVARIANTS_BEGIN, end: INVARIANTS_END, body: "" },
        ],
      };
    }
    return null;
  }

  // What a managed file contains BEFORE our sections go in, when it does
  // not exist yet — the recommended rules we offer in the user's own
  // zone. Empty for files that carry no such offer.
  //
  // ⚠️ MISSING is not EMPTY. A zero-length .gitignore is the user
  // saying "I do not want your recommendations"; it takes the ordinary
  // path, which adds our sections and nothing else (owner, 2026-09-26).
  private defaultUserSpaceFor(path: string): string {
    if (path === this.rootGitignorePath) return ROOT_RECOMMENDED_DEFAULTS;
    if (path === this.configDirGitignorePath) {
      return CONFIG_DIR_RECOMMENDED_DEFAULTS;
    }
    return "";
  }

  private async noteSeedState(path: string, content: string): Promise<void> {
    const seed = this.seedFor(path);
    if (seed === null) return; // not a seeded file
    if (seed !== content) {
      await this.seeds.clear(path);
      return;
    }
    const bytes = new TextEncoder().encode(content);
    const sha = await calculateGitBlobSHA(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    await this.seeds.set(path, sha);
  }

  // A third-party plugin's own .gitignore. Ownership mode 3: we touch
  // EXACTLY our `final` section and nothing else — every other line in
  // that file belongs to whoever wrote it.
  //
  // The section only exists to carry the syncConfigDir=OFF silencer
  // (§3.1.1), which arrives with its content in A-6. Until then the
  // desired state is "no section", and that is not a no-op: a file left
  // carrying our section by an earlier version gets it REMOVED, rather
  // than keeping an empty marked block around forever.
  private async enforceForeignPluginGitignore(path: string): Promise<void> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return; // vanished between list and stat — pruned below
    const body = this.foreignPluginFinalBody();
    if (await this.isFresh(path, stat, { final: body })) return;

    const content = await this.vault.adapter.read(path);
    const fixed = await this.spliceOne(path, content, body, FINAL_SECTION);
    if (fixed === content) {
      await this.refreshState(path, { final: body ?? undefined });
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(path, { final: body ?? undefined });
  }

  // Desired body of our section inside a FOREIGN plugin's .gitignore.
  // null = the section must not be there at all.
  private foreignPluginFinalBody(): string | null {
    return foreignPluginFinalBodyFor(this.syncConfigDir());
  }

  // Cheap freshness gate (§3.1.2): skip the read and the hashing when
  // the file has not moved AND what we want from it has not changed.
  //
  // Both halves are needed, and the second is the one that was missing
  // before. `mtime`+`size` answer "did anyone touch the FILE?" — they
  // are blind to a plugin upgrade that changes the constant while the
  // file on disk sits untouched, which is exactly how the new rules
  // failed to reach disk and why the short-circuit was ripped out
  // (`void recorded`) instead of fixed. Comparing the recorded
  // fingerprint against what we NOW want closes that hole, so the
  // short-circuit can come back.
  //
  // `desired` maps a section to the body we want, `null`/undefined
  // meaning "this section must not exist" — in which case freshness
  // requires the record to carry no fingerprint for it either.
  private async isFresh(
    path: string,
    stat: { mtime: number; size: number },
    desired: Partial<Record<SectionId, string | null>>,
  ): Promise<boolean> {
    const rec = this.state.getFor(path);
    if (!rec) return false;
    if (rec.mtime !== stat.mtime || rec.size !== stat.size) return false;
    for (const [id, body] of Object.entries(desired) as Array<
      [SectionId, string | null | undefined]
    >) {
      const recorded = rec[id];
      if (body === null || body === undefined) {
        if (recorded) return false;
        continue;
      }
      if (!recorded) return false;
      const want = await fingerprintOf(body);
      if (recorded.sha !== want.sha || recorded.len !== want.len) return false;
    }
    return true;
  }

  // Splice ONE section of `path`, feeding the repair its recorded
  // fingerprint and reporting whatever the splice found wrong.
  private async spliceOne(
    path: string,
    existing: string,
    body: string | null,
    markers: SectionMarkers = INVARIANTS_SECTION,
  ): Promise<string> {
    const sectionId = markers.id;
    const { content, anomalies } = await spliceSection({
      existing,
      markers,
      body,
      recorded: this.state.getFor(path)?.[sectionId],
    });
    for (const anomaly of anomalies) {
      this.onAnomaly({ path, section: sectionId, anomaly });
    }
    return content;
  }

  // Record what the file looks like NOW, keyed by its path.
  //
  // ⚠️ The stat MUST happen after the write, never before — a pre-write
  // mtime makes the next pass see "changed", rewrite, and record another
  // pre-write mtime, forever (DOT-FILES §3.1.2).
  //
  // `bodies` carries the section bodies we just composed, and only
  // those: a section not named here keeps whatever fingerprint was on
  // file. That matters for notePathSelfWritten, which fires after a PULL
  // — we did not author those bytes, so we must not claim we did, and a
  // stale fingerprint is harmless because it can only ever decline a
  // repair by failing to match.
  private async refreshState(
    path: string,
    bodies?: Partial<Record<SectionId, string>>,
  ): Promise<void> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return;
    const previous = this.state.getFor(path);
    const record: InvariantFileState = {
      mtime: stat.mtime,
      size: stat.size,
      ...(previous?.invariants ? { invariants: previous.invariants } : {}),
      ...(previous?.final ? { final: previous.final } : {}),
    };
    for (const id of ["invariants", "final"] as const) {
      const body = bodies?.[id];
      if (body !== undefined) record[id] = await fingerprintOf(body);
    }
    await this.state.set(path, record);
  }

  // Every write to a managed .gitignore goes through the crash-safe
  // protocol (DOT-FILES §3.1.3). These are not ordinary data files:
  // a truncated one DEFINES SCOPE. A cut-short root file loses the
  // user's `!` opt-ins, so paths silently leave sync; a cut-short
  // configDir file loses the kill-switch. Nothing is destroyed (Pass 2
  // does store.remove, not a delete), but the engine behaves
  // unpredictably until the next enforce() — and that class of risk has
  // no business being here for the sake of one call.
  //
  // In practice this always takes the rename strategy: atomicWriteFile's
  // modify-in-place fast path needs a TFile, and Obsidian does not index
  // dotfiles — the same blindness that makes a separate dot-space walk
  // necessary at all. So there is also no interaction with open editors.
  //
  // Recovery ordering is already right and must stay that way:
  // AtomicWriteRecovery.sweep (main.ts) runs before any sync operation,
  // hence before the first enforce(), so an interrupted write is
  // forward-completed rather than read as "the user damaged the block".
  //
  // ⚠️ NOT the state file in .runtime/ — that one stays a plain write
  // on purpose (§3.1.2): an unreadable state file already reads as
  // empty, so atomicity buys nothing there.
  private async write(path: string, content: string): Promise<void> {
    await this.ensureParentDir(path);
    const bytes = enc.encode(content);
    await atomicWriteFile(
      this.vault,
      path,
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    // The rules at this level just changed. Drop the matcher's parse of
    // it, or the isSyncable calls later in THIS same commit/drain answer
    // from what we replaced (gi.ts holds a level by mtime for 500 ms).
    const slash = path.lastIndexOf("/");
    this.gi.invalidate(slash <= 0 ? "" : path.substring(0, slash));
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const parent = filePath.substring(0, slash);
    if (await this.vault.adapter.exists(parent)) return;
    const parts = parent.split("/");
    let acc = "";
    for (const part of parts) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }
}

// ── section splicing (DOT-FILES §3.1.3) ─────────────────────────────

// Where a section is allowed to live. In gitignore the POSITION of a
// line IS its strength (last-match-wins), so this is semantics, not
// layout: "top" means the user may override us below, "bottom" means
// nothing can.
export type SectionPlacement = "top" | "bottom";

export interface SectionMarkers {
  id: SectionId;
  begin: string;
  end: string;
  placement: SectionPlacement;
}

export const INVARIANTS_SECTION: SectionMarkers = {
  id: "invariants",
  begin: INVARIANTS_BEGIN,
  end: INVARIANTS_END,
  placement: "top",
};

export const FINAL_SECTION: SectionMarkers = {
  id: "final",
  begin: FINAL_BEGIN,
  end: FINAL_END,
  placement: "bottom",
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// Trim the seam left by cutting, then guarantee exactly one trailing
// newline. Load-bearing for IDEMPOTENCE: without it every pass would
// add another blank line at the cut, and the file would never settle —
// and a file that never settles is a diff on every sync.
function normalizeBody(text: string): string {
  const trimmed = text.replace(/^\n+/, "").replace(/\n+$/, "");
  return trimmed === "" ? "" : `${trimmed}\n`;
}

// A section occupies WHOLE LINES, so cutting it must take its own line
// terminator with it. Without this the cut leaves a blank line behind at
// the seam — stable, but it means every removed section quietly donates
// an empty line to the user's file.
function dropLeadingNewline(text: string): string {
  if (text.startsWith("\r\n")) return text.slice(2);
  if (text.startsWith("\n")) return text.slice(1);
  return text;
}

// Cut EVERY well-formed BEGIN..END pair. Returns the remaining text and
// how many pairs were removed.
//
// "Every", not "the first", is a deliberate inversion of the older rule
// ("cut the first, leave the rest, report"). That was safer when the
// section was replaced IN PLACE; now the section is PLACED, so a pair we
// left behind could sit below ours and override it by last-match. Extra
// pairs still get reported by the caller — they mean manual editing.
function cutAllPairs(
  existing: string,
  markers: SectionMarkers,
): { rest: string; cut: number } {
  let rest = existing;
  let cut = 0;
  for (;;) {
    const b = rest.indexOf(markers.begin);
    if (b === -1) break;
    const e = rest.indexOf(markers.end, b + markers.begin.length);
    if (e === -1) break; // orphan BEGIN — not ours to guess at here
    rest =
      rest.slice(0, b) +
      dropLeadingNewline(rest.slice(e + markers.end.length));
    cut++;
  }
  return { rest, cut };
}

// Why the section was not brought to canonical cleanly. The caller logs
// loudly and shows the user a notice: we will NOT guess where a damaged
// section ended, because the text below a marker is the user's.
export type SpliceAnomaly =
  | "orphan-repaired"
  | "orphan-unrepairable"
  | "multiple-pairs"
  // §3.1.5: a second copy of one of our rules, found in the user's own
  // space and deleted. Deliberate (presupposition 2) and therefore
  // reported — a silent deletion of someone's line is the defect class
  // §4.2 had to fix.
  | "duplicate-removed";

export interface SpliceResult {
  content: string;
  anomalies: SpliceAnomaly[];
}

// Bring one managed section to canonical:
//   - cut every well-formed pair, wherever it sits in the file;
//   - if a marker is orphaned, try to cut the old body by the recorded
//     {len, sha} (§3.1.3) — and if that does not match, leave it alone
//     and report;
//   - place `body` at the section's assigned position (null = delete).
//
// Async because the repair hashes a candidate span with the same
// calculateGitBlobSHA the fingerprints were written with.
export async function spliceSection(args: {
  existing: string;
  markers: SectionMarkers;
  // null deletes the section — e.g. a foreign plugin's file at
  // syncConfigDir=ON, where our section must go away entirely rather
  // than linger empty.
  body: string | null;
  // Fingerprint of the body WE last wrote, from the freshness store.
  // Absent on a first run, after a state loss, or on the very first
  // upgrade to this shape — in which case orphan repair cannot run and
  // the damaged text is left for the user.
  recorded?: { sha: string; len: number };
}): Promise<SpliceResult> {
  const { markers, body, recorded } = args;
  const anomalies: SpliceAnomaly[] = [];

  const { rest: afterPairs, cut } = cutAllPairs(args.existing, markers);
  if (cut > 1) anomalies.push("multiple-pairs");

  let rest = afterPairs;
  if (cut === 0 && rest.includes(markers.begin)) {
    const repaired = await repairOrphanBegin(rest, markers, recorded);
    rest = repaired.text;
    anomalies.push(
      repaired.ok ? "orphan-repaired" : "orphan-unrepairable",
    );
  }

  const user = normalizeBody(rest);
  if (body === null) return { content: user, anomalies };

  const block = composeSection(markers.begin, body, markers.end);
  if (user === "") return { content: `${block}\n`, anomalies };
  return {
    content:
      markers.placement === "top"
        ? `${block}\n\n${user}`
        : `${user}\n${block}\n`,
    anomalies,
  };
}

// Fingerprint of one section BODY: the git blob SHA over its bytes and
// that byte count. They travel together because calculateGitBlobSHA
// binds the length into its preimage (`blob <len>\0`), so `len` cannot
// be forged apart from `sha`. UTF-8 bytes, deliberately — see the note
// in invariant-state.ts.
export async function fingerprintOf(
  body: string,
): Promise<{ sha: string; len: number }> {
  const bytes = enc.encode(body);
  const sha = await calculateGitBlobSHA(
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return { sha, len: bytes.byteLength };
}

// An orphaned BEGIN (the user deleted END, or a crash truncated the
// file) is NOT a harmless "we'll just write a fresh section": the stale
// body stays in the file, and after we place the new section it can end
// up overriding it. So we identify the old body by the ONE thing we
// recorded about it — its byte length and its blob SHA — and cut exactly
// that span.
//
// The measurement is over the body WITHOUT markers, which is what makes
// this work at all: a missing END simply never enters the span.
async function repairOrphanBegin(
  text: string,
  markers: SectionMarkers,
  recorded: { sha: string; len: number } | undefined,
): Promise<{ text: string; ok: boolean }> {
  if (!recorded) return { text, ok: false };
  const b = text.indexOf(markers.begin);
  // The body starts right after the BEGIN line, i.e. past its newline.
  const bodyStart = b + markers.begin.length + 1;
  if (text[b + markers.begin.length] !== "\n") return { text, ok: false };

  // Slice `len` UTF-8 BYTES, not characters. If the span straddles a
  // multi-byte character the decode yields U+FFFD and the SHA will not
  // match — which is the right answer: it was not our body.
  const tailBytes = enc.encode(text.slice(bodyStart));
  if (tailBytes.byteLength < recorded.len) return { text, ok: false };
  const candidateBytes = tailBytes.slice(0, recorded.len);
  const sha = await calculateGitBlobSHA(
    candidateBytes.buffer.slice(
      candidateBytes.byteOffset,
      candidateBytes.byteOffset + candidateBytes.byteLength,
    ) as ArrayBuffer,
  );
  if (sha !== recorded.sha) return { text, ok: false };

  const candidate = dec.decode(candidateBytes);
  let cutEnd = bodyStart + candidate.length;
  // Take a trailing END too when it sits immediately after the body,
  // which is the shape a half-written file leaves behind.
  const afterBody = text.slice(cutEnd);
  if (afterBody.startsWith(`\n${markers.end}`)) {
    cutEnd += 1 + markers.end.length;
  }
  return {
    text: text.slice(0, b) + dropLeadingNewline(text.slice(cutEnd)),
    ok: true,
  };
}

// Pure helpers for the "Push plugins data.json" toggle. Both work
// on the invariant block (between BEGIN/END markers) only — the
// toggle never touches anything outside that block, so whatever
// the user wrote in their recommended-defaults area or below is
// theirs to keep.

// Extract the body of one managed section from `fileContent`
// (everything between its BEGIN and END, markers excluded). Returns
// null when the markers are missing or malformed — the caller treats
// that as "toggle is OFF, the file will be re-seeded with the canonical
// section on the next enforce".
export function extractSection(
  fileContent: string,
  markers: SectionMarkers,
): string | null {
  const beginIdx = fileContent.indexOf(markers.begin);
  const endIdx = fileContent.indexOf(markers.end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return fileContent.substring(beginIdx + markers.begin.length, endIdx);
}

// Returns the toggle state encoded in `blockContent`:
//   true  → block contains `!plugins/*/data.json` (allow / ON)
//   false → block contains `plugins/*/data.json` (block / OFF)
//   false → neither variant present (malformed; safe default)
//
// Caller passes the body returned by extractInvariantBlock, NOT
// the whole file — the toggle deliberately ignores any matching
// line outside our block (that's user territory).
export function blockHasAllowLine(blockContent: string): boolean {
  return /^!plugins\/\*\/data\.json[ \t]*$/m.test(blockContent);
}
