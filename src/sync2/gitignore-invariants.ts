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
// The data.json rule the toggle owns. ALWAYS present inside the
// invariant block — only the leading `!` flips with the toggle:
//
//   OFF (default, safe): `plugins/*/data.json`     ← block rule
//   ON  (user opted in): `!plugins/*/data.json`    ← allow rule
//
// We don't rely on `plugins/*/*` (the seeded recommended catch-all)
// being in the file at all: if the user's gitignore pre-existed
// when our plugin first ran, only the invariant block was prepended
// and the recommended-defaults section never got seeded. Our block
// must stand alone, so the OFF state has to carry an explicit block
// rule (without `!`), not rely on a sibling rule below.
//
// Toggle state is read by checking whether the line starts with `!`
// (allow) or not (block). If neither variant is present in the
// block — defensive: e.g. malformed/hand-edited block — we report
// the safe-default OFF and let the next enforce() fix the block.
const DATA_JSON_BLOCK_LINE = "plugins/*/data.json";
const DATA_JSON_ALLOW_LINE = "!plugins/*/data.json";

// BODY (no markers) of the managed section in <configDir>/.gitignore. The
// section is rewritten by spliceInvariantBlock on every enforce() and on
// every toggle, so this function is the SINGLE place that decides what the
// body looks like — no duplication, no per-call drift.
function configDirInvariantsBody(opts: {
  pushPluginsDataJson: boolean;
}): string {
  const dataJsonLine = opts.pushPluginsDataJson
    ? DATA_JSON_ALLOW_LINE
    : DATA_JSON_BLOCK_LINE;
  return `# Editing this block triggers a rewrite to canonical on next load.

# Per-device state - never propagate between machines.
workspace.json
workspace-mobile.json
community-plugins.json
${dataJsonLine}`;
}

// Recommended defaults seeded ONLY when sync2 first creates
// <configDir>/.gitignore. Pre-existing files keep the user's content
// untouched below the invariant block.
const CONFIG_DIR_RECOMMENDED_DEFAULTS = `# Recommended defaults - feel free to edit.

# Plugin folder allowlist - by default sync only the four canonical
# files (main.js, manifest.json, styles.css; data.json is governed
# by the settings-tab toggle "Push plugins data.json to GitHub",
# which lives in the invariant block above).
plugins/*/*
!plugins/*/
!plugins/*/main.js
!plugins/*/manifest.json
!plugins/*/styles.css`;

// Canonical content of <configDir>/plugins/<self>/.gitignore. Unlike
// the configDir gitignore, the plugin owns this file outright — full
// rewrite each time, no user content carried over.
const SELF_PLUGIN_GITIGNORE = `*
!main.js
!manifest.json
!styles.css
!.gitignore
`;

// BODY (no markers) of the managed section in the ROOT <vault>/.gitignore
// (Stage 6.5). Forces conflict-sibling files (`<base>.conflict-from-<label>-
// <iso-no-colons>.<ext>`) to never be pushed: they're per-device
// markers, propagating them across devices would create feedback
// loops where one device's deferred state shows up on others as
// unrelated user files. Splice-on-edit semantics, same as configDir.
const ROOT_INVARIANTS_BODY = `# Editing this block triggers a rewrite to canonical on next load.

# Conflict-resolver sibling files - per-device markers that must
# never propagate via sync.
*.conflict-from-*

# Atomic-write staging + backup artifacts.
# Transient files written by the crash-safe write protocol; the
# onload recovery sweep cleans them up. Must never reach GitHub.
*.ges-tmp*
*.ges-bak*`;

// Recommended root-level defaults seeded ONLY when sync2 first
// creates <vault>/.gitignore. Pre-existing files keep user content
// untouched below the invariant block.
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
}

export interface GitignoreMatcherCache {
  invalidate(dir?: string): void;
}

export interface SectionAnomalyReport {
  path: string;
  section: SectionId;
  anomaly: SpliceAnomaly;
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

  constructor(deps: GitignoreInvariantsDeps) {
    this.vault = deps.vault;
    this.state = deps.state;
    this.seeds = deps.seeds;
    this.onAnomaly = deps.onAnomaly;
    this.gi = deps.gi;
    this.configDirGitignorePath = `${deps.configDir}/.gitignore`;
    this.pluginsDir = `${deps.configDir}/plugins`;
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
        path === this.selfPluginGitignorePath
      ) {
        continue;
      }
      if (!(await this.vault.adapter.exists(path))) {
        await this.state.remove(path);
      }
    }
  }

  // True iff the allow line is currently inside the invariant
  // block of <configDir>/.gitignore. The block is the only place
  // we ever write that line — anywhere else in the file would be
  // user-territory the toggle deliberately ignores. Returns false
  // on missing file (safe-by-default position).
  async getPushPluginsDataJson(): Promise<boolean> {
    const exists = await this.vault.adapter.exists(
      this.configDirGitignorePath,
    );
    if (!exists) return false;
    const content = await this.vault.adapter.read(
      this.configDirGitignorePath,
    );
    const block = extractInvariantBlock(content);
    if (block === null) return false;
    return blockHasAllowLine(block);
  }

  // Toggle the allow line on or off by rewriting the canonical
  // invariant block (with or without the line) via the existing
  // splice mechanism. Idempotent: a no-change call short-circuits
  // before touching disk. Refreshes the invariant state cache so
  // the next enforceConfigDirGitignore short-circuits cleanly.
  async setPushPluginsDataJson(enabled: boolean): Promise<void> {
    const exists = await this.vault.adapter.exists(
      this.configDirGitignorePath,
    );
    if (!exists) {
      // No file yet — let enforce() seed the full template using
      // the requested toggle state, then return.
      await this.enforceConfigDirGitignoreWith(enabled);
      return;
    }
    const path = this.configDirGitignorePath;
    const before = await this.vault.adapter.read(path);
    const body = configDirInvariantsBody({ pushPluginsDataJson: enabled });
    const after = await this.spliceOne(path, before, body);
    if (after === before) return;
    await this.write(path, after);
    await this.refreshState(path, { invariants: body });
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

  private async enforceConfigDirGitignore(): Promise<void> {
    // No explicit toggle preference — preserve whatever's currently
    // in the on-disk block. Other callers that want to force a
    // specific state pass it via enforceConfigDirGitignoreWith.
    return this.enforceConfigDirGitignoreWith(undefined);
  }

  // `desiredPushPluginsDataJson`:
  //   undefined → preserve the toggle state read from the existing
  //               on-disk invariant block (or false if the file
  //               doesn't exist yet / the block is missing).
  //   true/false → use that exact state.
  private async enforceConfigDirGitignoreWith(
    desiredPushPluginsDataJson: boolean | undefined,
  ): Promise<void> {
    const path = this.configDirGitignorePath;

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: file doesn't exist. Seed the full template
      // with the requested toggle state (defaults to OFF when the
      // caller didn't supply one).
      const seedPush = desiredPushPluginsDataJson ?? false;
      const block = composeSection(
        INVARIANTS_BEGIN,
        configDirInvariantsBody({ pushPluginsDataJson: seedPush }),
        INVARIANTS_END,
      );
      const content = `${block}\n\n${CONFIG_DIR_RECOMMENDED_DEFAULTS}\n`;
      await this.write(path, content);
      await this.refreshState(path, {
        invariants: configDirInvariantsBody({ pushPluginsDataJson: seedPush }),
      });
      await this.noteSeedState(path, content);
      return;
    }

    // Freshness gate (§3.1.2): skip the read entirely when the file has
    // not moved AND the section we want is the section we recorded.
    //
    // The version of this that existed before compared mtime+hash only,
    // and that is exactly why it was removed: it could not see a plugin
    // UPGRADE, where the constant changes while the file on disk sits
    // untouched, so the new rules never reached disk. Comparing the
    // recorded FINGERPRINT against what we now want closes that hole,
    // which is what lets the short-circuit come back.
    //
    // When the toggle state is not forced, either canonical body counts
    // as fresh — the file is untouched, so whichever one we last wrote
    // is still the right one.
    const wanted =
      desiredPushPluginsDataJson === undefined
        ? [true, false].map((pushPluginsDataJson) =>
            configDirInvariantsBody({ pushPluginsDataJson }),
          )
        : [
            configDirInvariantsBody({
              pushPluginsDataJson: desiredPushPluginsDataJson,
            }),
          ];
    for (const candidate of wanted) {
      if (await this.isFresh(path, stat, { invariants: candidate })) return;
    }

    const content = await this.vault.adapter.read(path);

    // The block's "push plugins data.json" toggle survives this
    // rewrite. If the caller asked for a specific state, use it;
    // otherwise read whatever the user (or a peer device, via a
    // synced gitignore) put in the existing block. This is the
    // mechanism that lets the toggle stay shared cross-device:
    // the gitignore is the only source of truth.
    let pushPluginsDataJson: boolean;
    if (desiredPushPluginsDataJson !== undefined) {
      pushPluginsDataJson = desiredPushPluginsDataJson;
    } else {
      const existingBlock = extractInvariantBlock(content);
      pushPluginsDataJson =
        existingBlock !== null && blockHasAllowLine(existingBlock);
    }
    const body = configDirInvariantsBody({ pushPluginsDataJson });
    const fixed = await this.spliceOne(path, content, body);
    if (fixed === content) {
      // Nothing to change on disk; just refresh the cache.
      await this.refreshState(path, { invariants: body });
      await this.noteSeedState(path, content);
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(path, { invariants: body });
    await this.noteSeedState(path, fixed);
  }

  // Same shape as enforceConfigDirGitignore but for the ROOT vault
  // gitignore. The forced rule here is `*.conflict-from-*`, which
  // pins per-device conflict-sibling files to local-only.
  private async enforceRootGitignore(): Promise<void> {
    const path = this.rootGitignorePath;

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: file doesn't exist. Seed invariant block + a
      // small set of recommended OS/editor noise defaults so the user
      // gets a sensible starting point. Pre-existing root gitignores
      // (e.g. user already had one) skip this branch entirely.
      const content = `${composeSection(INVARIANTS_BEGIN, ROOT_INVARIANTS_BODY, INVARIANTS_END)}\n\n${ROOT_RECOMMENDED_DEFAULTS}\n`;
      await this.write(path, content);
      await this.refreshState(path, { invariants: ROOT_INVARIANTS_BODY });
      await this.noteSeedState(path, content);
      return;
    }

    // Same freshness gate as configDir — see the comment there for why
    // the fingerprint half is load-bearing (a plugin upgrade changes
    // ROOT_INVARIANTS_BODY while the file on disk never moves).
    if (await this.isFresh(path, stat, { invariants: ROOT_INVARIANTS_BODY })) {
      return;
    }

    const content = await this.vault.adapter.read(path);

    const fixed = await this.spliceOne(path, content, ROOT_INVARIANTS_BODY);
    if (fixed === content) {
      await this.refreshState(path, { invariants: ROOT_INVARIANTS_BODY });
      await this.noteSeedState(path, content);
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(path, { invariants: ROOT_INVARIANTS_BODY });
    await this.noteSeedState(path, fixed);
  }

  private async enforceSelfPluginGitignore(): Promise<void> {
    const path = this.selfPluginGitignorePath;

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      await this.write(path, SELF_PLUGIN_GITIGNORE);
      await this.refreshState(path);
      return;
    }

    // Always read+compare against the canonical constant. No mtime
    // short-circuit, so plugin upgrades that change
    // SELF_PLUGIN_GITIGNORE reach disk even when the file mtime
    // hasn't moved.
    const content = await this.vault.adapter.read(path);
    if (content === SELF_PLUGIN_GITIGNORE) {
      // Already canonical — refresh cache only.
      await this.refreshState(path);
      return;
    }

    // Sync2 owns this file outright — overwrite anything the user (or
    // anything else) wrote into it.
    await this.write(path, SELF_PLUGIN_GITIGNORE);
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
  // Returns the candidate seed contents for a path — plural for
  // <configDir>/.gitignore, whose canonical form differs only by the
  // data.json toggle line, and EMPTY for anything we do not seed
  // (notably <self>/.gitignore, a constant that never negotiates).
  private canonicalSeeds(path: string): string[] {
    const section = (body: string) =>
      composeSection(INVARIANTS_BEGIN, body, INVARIANTS_END);
    if (path === this.rootGitignorePath) {
      return [
        `${section(ROOT_INVARIANTS_BODY)}\n\n${ROOT_RECOMMENDED_DEFAULTS}\n`,
      ];
    }
    if (path === this.configDirGitignorePath) {
      return [true, false].map(
        (pushPluginsDataJson) =>
          `${section(configDirInvariantsBody({ pushPluginsDataJson }))}` +
          `\n\n${CONFIG_DIR_RECOMMENDED_DEFAULTS}\n`,
      );
    }
    return [];
  }

  private async noteSeedState(path: string, content: string): Promise<void> {
    const candidates = this.canonicalSeeds(path);
    if (candidates.length === 0) return; // not a seeded file
    if (!candidates.includes(content)) {
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
  // null = the section must not be there at all. A-6 gives this the
  // syncConfigDir=OFF silencer.
  private foreignPluginFinalBody(): string | null {
    return null;
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
  | "multiple-pairs";

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

// Extract the body of the invariant block from `fileContent`
// (everything between INVARIANTS_BEGIN and INVARIANTS_END,
// markers excluded). Returns null when the markers are missing or
// malformed — the caller treats that as "toggle is OFF, the file
// will be re-seeded with the canonical block on the next enforce".
export function extractInvariantBlock(fileContent: string): string | null {
  const beginIdx = fileContent.indexOf(INVARIANTS_BEGIN);
  const endIdx = fileContent.indexOf(INVARIANTS_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return fileContent.substring(beginIdx + INVARIANTS_BEGIN.length, endIdx);
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
