// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import InvariantStateStore, { InvariantFileState } from "./invariant-state";

// Invariant block markers. Editing anything between BEGIN and END on
// disk triggers a rewrite back to canonical on the next sync.
export const INVARIANT_BEGIN =
  "# ===== git-easy-sync invariants — DO NOT EDIT =====";
export const INVARIANT_END =
  "# ===== end of invariants =====";

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

// Build the canonical contents of the invariant block in
// <configDir>/.gitignore. The block is rewritten in place by
// spliceInvariantBlock on every enforce() and on every toggle, so
// this function is the SINGLE place that decides what the block
// looks like — no duplication, no per-call drift.
function configDirInvariantBlock(opts: {
  pushPluginsDataJson: boolean;
}): string {
  const dataJsonLine = opts.pushPluginsDataJson
    ? DATA_JSON_ALLOW_LINE
    : DATA_JSON_BLOCK_LINE;
  return `${INVARIANT_BEGIN}
# Editing this block triggers a rewrite to canonical on next load.

# Per-device state — never propagate between machines.
git-easy-sync-metadata.json
workspace.json
workspace-mobile.json
community-plugins.json
${dataJsonLine}
${INVARIANT_END}`;
}

// Recommended defaults seeded ONLY when sync2 first creates
// <configDir>/.gitignore. Pre-existing files keep the user's content
// untouched below the invariant block.
const CONFIG_DIR_RECOMMENDED_DEFAULTS = `# Recommended defaults — feel free to edit.

# Plugin folder allowlist — by default sync only the four canonical
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

// Body of the invariant block in the ROOT <vault>/.gitignore (Stage
// 6.5). Forces conflict-sibling files (`<base>.conflict-from-<label>-
// <iso-no-colons>.<ext>`) to never be pushed: they're per-device
// markers, propagating them across devices would create feedback
// loops where one device's deferred state shows up on others as
// unrelated user files. Splice-on-edit semantics, same as configDir.
const ROOT_INVARIANT_BLOCK = `${INVARIANT_BEGIN}
# Editing this block triggers a rewrite to canonical on next load.

# Conflict-resolver sibling files — per-device markers that must
# never propagate via sync.
*.conflict-from-*

# Atomic-write staging + backup artifacts.
# Transient files written by the crash-safe write protocol; the
# onload recovery sweep cleans them up. Must never reach GitHub.
*.ges-tmp*
*.ges-bak*
${INVARIANT_END}`;

// Recommended root-level defaults seeded ONLY when sync2 first
// creates <vault>/.gitignore. Pre-existing files keep user content
// untouched below the invariant block.
const ROOT_RECOMMENDED_DEFAULTS = `# Recommended defaults — feel free to edit.

# Logs (covers the plugin's own <plugin-id>.log at the vault root
# plus any other *.log anywhere in the vault). Remove this line if
# you want logs to sync to GitHub — useful for analysing mobile
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

  constructor(deps: GitignoreInvariantsDeps) {
    this.vault = deps.vault;
    this.state = deps.state;
    this.configDirGitignorePath = `${deps.configDir}/.gitignore`;
    this.selfPluginGitignorePath = `${deps.configDir}/plugins/${deps.selfPluginId}/.gitignore`;
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

  // Verify and, if needed, rewrite all three invariant gitignore
  // files. Cheap path: stat each, compare mtime to recorded; if
  // equal, do nothing else. Slow path (mtime moved): read content,
  // compare hash; if hash matches recorded, refresh just the mtime
  // cache. Only when hash truly changed do we rewrite.
  async enforce(): Promise<void> {
    await this.enforceConfigDirGitignore();
    await this.enforceSelfPluginGitignore();
    await this.enforceRootGitignore();
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
    const before = await this.vault.adapter.read(
      this.configDirGitignorePath,
    );
    const after = spliceInvariantBlock(
      before,
      configDirInvariantBlock({ pushPluginsDataJson: enabled }),
    );
    if (after === before) return;
    await this.write(this.configDirGitignorePath, after);
    await this.refreshState("configDirGitignore", this.configDirGitignorePath);
  }

  // Called by Sync2Manager.recordSync after a successful self-push of
  // one of the invariant files. Updates the cached mtime+hash so the
  // next sync's enforce() short-circuits without re-reading.
  async notePathSelfWritten(path: string): Promise<void> {
    if (path === this.configDirGitignorePath) {
      await this.refreshState("configDirGitignore", path);
    } else if (path === this.selfPluginGitignorePath) {
      await this.refreshState("selfPluginGitignore", path);
    } else if (path === this.rootGitignorePath) {
      await this.refreshState("rootGitignore", path);
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
    const slot = "configDirGitignore" as const;
    const path = this.configDirGitignorePath;
    const recorded = this.state.get()[slot];

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: file doesn't exist. Seed the full template
      // with the requested toggle state (defaults to OFF when the
      // caller didn't supply one).
      const seedPush = desiredPushPluginsDataJson ?? false;
      const block = configDirInvariantBlock({
        pushPluginsDataJson: seedPush,
      });
      const content = `${block}\n\n${CONFIG_DIR_RECOMMENDED_DEFAULTS}\n`;
      await this.write(path, content);
      await this.refreshState(slot, path);
      return;
    }

    // Always read+splice+compare. A short-circuit on `mtime` /
    // `recorded.hash` would skip the splice when the on-disk file
    // hadn't changed since the last enforce — which is fine for
    // user edits but breaks plugin upgrades: if the canonical block
    // CONSTANT changes but the on-disk file doesn't (still pinned
    // to the previous plugin version's block), the recorded hash
    // matches the file's current hash and enforce() would return
    // without applying the new canonical lines.
    //
    // The post-splice `fixed === content` check below is the
    // remaining short-circuit. It's safe — it compares the spliced
    // output to the actual on-disk content, so it can't lie about
    // canonical-block changes.
    const content = await this.vault.adapter.read(path);
    void recorded; // hash/mtime short-circuits dropped — see comment above
    const hash = await sha1Of(content);

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
    const fixed = spliceInvariantBlock(
      content,
      configDirInvariantBlock({ pushPluginsDataJson }),
    );
    if (fixed === content) {
      // Nothing to change on disk; just refresh the cache.
      await this.state.set(slot, { mtime: stat.mtime, hash });
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(slot, path);
  }

  // Same shape as enforceConfigDirGitignore but for the ROOT vault
  // gitignore. The forced rule here is `*.conflict-from-*`, which
  // pins per-device conflict-sibling files to local-only.
  private async enforceRootGitignore(): Promise<void> {
    const slot = "rootGitignore" as const;
    const path = this.rootGitignorePath;
    const recorded = this.state.get()[slot];

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      // Fresh install: file doesn't exist. Seed invariant block + a
      // small set of recommended OS/editor noise defaults so the user
      // gets a sensible starting point. Pre-existing root gitignores
      // (e.g. user already had one) skip this branch entirely.
      const content = `${ROOT_INVARIANT_BLOCK}\n\n${ROOT_RECOMMENDED_DEFAULTS}\n`;
      await this.write(path, content);
      await this.refreshState(slot, path);
      return;
    }

    // Always read+splice+compare. See the matching comment in
    // `enforceConfigDirGitignoreWith` for the rationale (plugin
    // upgrades that change ROOT_INVARIANT_BLOCK must reach disk
    // even when the user's file mtime hasn't moved).
    const content = await this.vault.adapter.read(path);
    void recorded;
    const hash = await sha1Of(content);

    const fixed = spliceInvariantBlock(content, ROOT_INVARIANT_BLOCK);
    if (fixed === content) {
      await this.state.set(slot, { mtime: stat.mtime, hash });
      return;
    }
    await this.write(path, fixed);
    await this.refreshState(slot, path);
  }

  private async enforceSelfPluginGitignore(): Promise<void> {
    const slot = "selfPluginGitignore" as const;
    const path = this.selfPluginGitignorePath;
    const recorded = this.state.get()[slot];

    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      await this.write(path, SELF_PLUGIN_GITIGNORE);
      await this.refreshState(slot, path);
      return;
    }

    // Always read+compare against the canonical constant. No mtime
    // short-circuit, so plugin upgrades that change
    // SELF_PLUGIN_GITIGNORE reach disk even when the file mtime
    // hasn't moved.
    const content = await this.vault.adapter.read(path);
    void recorded;
    const hash = await sha1Of(content);
    if (content === SELF_PLUGIN_GITIGNORE) {
      // Already canonical — refresh cache only.
      await this.state.set(slot, { mtime: stat.mtime, hash });
      return;
    }

    // Sync2 owns this file outright — overwrite anything the user (or
    // anything else) wrote into it.
    await this.write(path, SELF_PLUGIN_GITIGNORE);
    await this.refreshState(slot, path);
  }

  private async refreshState(
    slot: keyof ReturnType<InvariantStateStore["get"]>,
    path: string,
  ): Promise<void> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return;
    const content = await this.vault.adapter.read(path);
    const hash = await sha1Of(content);
    await this.state.set(slot as never, {
      mtime: stat.mtime,
      hash,
    } as InvariantFileState);
  }

  private async write(path: string, content: string): Promise<void> {
    await this.ensureParentDir(path);
    await this.vault.adapter.write(path, content);
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

// Replace the existing invariant block (between the BEGIN/END markers)
// with `block`. If markers aren't both present, prepend the block at
// the top of the file with a blank-line separator. Pure function for
// testability.
export function spliceInvariantBlock(
  existing: string,
  block: string,
): string {
  const beginIdx = existing.indexOf(INVARIANT_BEGIN);
  const endIdx = existing.indexOf(INVARIANT_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    // Markers missing or malformed — prepend canonical block.
    if (existing.length === 0) return `${block}\n`;
    return `${block}\n\n${existing}`;
  }
  const before = existing.substring(0, beginIdx);
  const afterStart = endIdx + INVARIANT_END.length;
  const after = existing.substring(afterStart);
  return `${before}${block}${after}`;
}

async function sha1Of(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
  return await calculateGitBlobSHA(buf);
}

// Pure helpers for the "Push plugins data.json" toggle. Both work
// on the invariant block (between BEGIN/END markers) only — the
// toggle never touches anything outside that block, so whatever
// the user wrote in their recommended-defaults area or below is
// theirs to keep.

// Extract the body of the invariant block from `fileContent`
// (everything between INVARIANT_BEGIN and INVARIANT_END,
// markers excluded). Returns null when the markers are missing or
// malformed — the caller treats that as "toggle is OFF, the file
// will be re-seeded with the canonical block on the next enforce".
export function extractInvariantBlock(fileContent: string): string | null {
  const beginIdx = fileContent.indexOf(INVARIANT_BEGIN);
  const endIdx = fileContent.indexOf(INVARIANT_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return fileContent.substring(beginIdx + INVARIANT_BEGIN.length, endIdx);
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
