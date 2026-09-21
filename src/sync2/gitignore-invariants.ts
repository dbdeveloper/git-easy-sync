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

  constructor(deps: GitignoreInvariantsDeps) {
    this.vault = deps.vault;
    this.state = deps.state;
    this.seeds = deps.seeds;
    this.onAnomaly = deps.onAnomaly;
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

    // Always read+splice+compare. See the matching comment in
    // `enforceConfigDirGitignoreWith` for the rationale (plugin
    // upgrades that change ROOT_INVARIANTS_BODY must reach disk
    // even when the user's file mtime hasn't moved).
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

  // Splice ONE section of `path`, feeding the repair its recorded
  // fingerprint and reporting whatever the splice found wrong.
  private async spliceOne(
    path: string,
    existing: string,
    body: string | null,
    markers: SectionMarkers = INVARIANTS_SECTION,
  ): Promise<string> {
    const sectionId = markers === INVARIANTS_SECTION ? "invariants" : "final";
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
  begin: string;
  end: string;
  placement: SectionPlacement;
}

export const INVARIANTS_SECTION: SectionMarkers = {
  begin: INVARIANTS_BEGIN,
  end: INVARIANTS_END,
  placement: "top",
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
