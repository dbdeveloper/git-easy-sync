// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { hasTextExtension } from "../utils";
import {
  pluginDirFileRole,
  compareSemver,
} from "./plugin-js";
import { mergeText, MergeOutcome } from "./three-way-merge";
import { ConflictKind } from "./conflict-store";

// Pluggable three-way merge function. The default is the
// synchronous main-thread mergeText (suitable for unit tests).
// Sync2Manager passes a Worker-backed async wrapper that routes
// large merges through the CPU pool. Either form is awaited by
// the caller, so the gate is async even when the default is
// inline.
export type MergeTextFn = (
  ours: string,
  base: string,
  theirs: string,
) => MergeOutcome | Promise<MergeOutcome>;

// Auto-merge dispatch helpers. See docs/PSEUDO-MERGE-MODE.md §7 for
// the dispatch table (text 3-way / plugin-js semver / binary always-
// register / modify-vs-delete short-circuit).
//
// Pure functions. No vault/network I/O. Wired into
// `Sync2Manager.applyRemoteAddOrModify` (pull side) and
// `reconcileBatchAgainstHead` (push side).

// ── classifyConflictKind ──────────────────────────────────────────────

// Per-side state at the conflict point. "modified" covers both
// add-and-edit; "deleted" means the side wants the file gone.
export type Side = "modified" | "deleted";

// Map (oursSide, theirsSide) → ConflictKind, or null when the pair
// is not a real registered conflict — either both sides agree
// (delete-vs-delete) or the resolution is automatic (modify-vs-
// delete: local-modify always wins, file resurrects on remote;
// see attemptAutoMerge's "modify-wins" outcome).
export function classifyConflictKind(
  oursSide: Side,
  theirsSide: Side,
): ConflictKind | null {
  if (oursSide === "modified" && theirsSide === "modified") {
    return "modify-vs-modify";
  }
  if (oursSide === "deleted" && theirsSide === "modified") {
    return "delete-vs-modify";
  }
  // modify-vs-delete → null: caller does NOT register a record. The
  // batch's "modified" entry passes through to push unchanged,
  // resurrecting the file on remote.
  return null;
}

// ── attemptAutoMerge ──────────────────────────────────────────────────

// Outcome of the auto-merge gate. Caller acts on each variant:
//   - "clean": push merged content to main as if nothing happened
//   - "atomic": push the winning side's existing content
//   - "modify-wins": modify-vs-delete branch — remote deleted, ours
//     modified, local-intent wins. Push ours, resurrecting the file
//     on remote. Surfaced as a structured auto-merge outcome (not
//     a silent `continue`) so it shows up in the log alongside the
//     other auto-resolutions.
//   - "register-conflict": call ConflictStore.create(kind:
//     "modify-vs-modify" | "delete-vs-modify", ...) and write a
//     sibling for the user to resolve.
export type AutoMergeResult =
  | { type: "clean"; content: ArrayBuffer }
  | { type: "atomic"; side: "ours" | "theirs" }
  | { type: "modify-wins" }
  | { type: "register-conflict" };

// Plugin-dir resolve context (§28) — caller pre-reads the plugin's
// manifest.json version on each side and gathers the mtimes before
// invoking attemptAutoMerge. We don't read disk here. `null` version
// means the manifest was missing or malformed; the resolver falls back
// to the mtime tie-breaks.
export interface PluginResolveContext {
  oursVersion: string | null;
  theirsVersion: string | null;
  // §28 rule 1 vs rule 3 selector for styles.css: does the
  // version-coupled bundle (main.js / *.js / manifest.json) differ
  // between ours and theirs? For "code" files (the bundle itself) this
  // is inherently true and unused.
  codeDiffers: boolean;
  // The canonical bundle mtime PER SIDE — one value at the plugin-id
  // level, identical for every coupled file of the plugin. Feeding the
  // SAME mtime to main.js, manifest.json and styles.css is the
  // atomicity lynchpin: on a semver tie they can never resolve to
  // different sides (which would ship a Frankenstein plugin).
  codeOursMtime: number;
  codeTheirsMtime: number;
  // The resolving FILE's own mtime — used only for styles.css when the
  // bundle is byte-identical on both sides (rule 3) and for data.json
  // (rule 4).
  fileOursMtime: number;
  fileTheirsMtime: number;
}

export interface AttemptAutoMergeArgs {
  path: string;
  ours: ArrayBuffer;
  // Bytes from the remote side. `null` ONLY when the remote deleted
  // the file (modify-vs-delete branch); caller short-circuits to
  // the "modify-wins" outcome.
  theirs: ArrayBuffer | null;
  // Last-common-ancestor bytes for 3-way merge. `null` when no shared
  // ancestor exists (e.g., file added independently on both sides);
  // in that case text auto-merge bails to register-conflict.
  base: ArrayBuffer | null;
  configDir: string;
  // Required when pluginDirFileRole(path, configDir) !== null — the
  // §28 plugin-dir resolver needs it to pick an atomic winner. Missing
  // it, the resolver defaults to "theirs" rather than registering a
  // conflict, because a plugin dir must NEVER grow a conflict sibling.
  pluginResolve?: PluginResolveContext;
  // Optional three-way merge function. Sync2Manager passes the
  // WorkerClient-backed async wrapper so large merges run in the
  // CPU pool; unit tests omit it and the default sync mergeText
  // runs inline.
  mergeFn?: MergeTextFn;
}

// Auto-merge gate. Returns one of four outcomes for the caller to
// apply. Caller (classifyConflictKind first) is responsible for
// short-circuiting delete-vs-modify before reaching here.
//
// Strategy dispatch by path:
//   - theirs === null       → modify-wins (modify-vs-delete: local-
//                             modify always wins, file resurrects)
//   - pluginDirFileRole !== null → §28 atomic plugin-dir resolution;
//                             NEVER register-conflict (no *.conflict-
//                             from.* sibling may appear in a plugin dir)
//   - hasTextExtension      → 3-way merge via mergeText
//   - else (binary)         → register-conflict unconditionally
//                             (2.0.0-beta's silent atomic-mtime is gone)
export async function attemptAutoMerge(
  args: AttemptAutoMergeArgs,
): Promise<AutoMergeResult> {
  if (args.theirs === null) {
    return { type: "modify-wins" };
  }
  const role = pluginDirFileRole(args.path, args.configDir);
  if (role !== null) {
    return resolvePluginDirFile(role, args.pluginResolve);
  }
  if (hasTextExtension(args.path)) {
    return await tryTextMerge(
      args.ours,
      args.theirs,
      args.base,
      args.mergeFn ?? mergeText,
    );
  }
  return { type: "register-conflict" };
}

// ── internals ────────────────────────────────────────────────────────

// §28 plugin-dir resolver. ALWAYS returns an atomic side — never
// register-conflict — because the MAIN GOAL is that no plugin folder
// ever grows a `*.conflict-from.*` sibling. The final tie always
// resolves to "theirs" so every device converges on the server copy.
function resolvePluginDirFile(
  role: "code" | "styles" | "data",
  ctx?: PluginResolveContext,
): AutoMergeResult {
  // No context should be unreachable (the caller reads it for every
  // plugin-dir file), but if it ever is, converge to the server rather
  // than register a conflict.
  if (!ctx) return { type: "atomic", side: "theirs" };

  // data.json (rule 4): per-plugin state, resolved purely by mtime,
  // never version-coupled.
  if (role === "data") {
    return { type: "atomic", side: laterSide(ctx.fileOursMtime, ctx.fileTheirsMtime) };
  }

  // Coupled bundle (main.js / manifest.json / styles.css): semver wins
  // first — this is the whole-group decision.
  const bySemver = semverSide(ctx.oursVersion, ctx.theirsVersion);
  if (bySemver !== null) return { type: "atomic", side: bySemver };

  // Semver tie / both unparseable.
  if (role === "styles" && !ctx.codeDiffers) {
    // Rule 3: the bundle is byte-identical on both sides, so "which
    // side changed the code" (rule 1) doesn't apply — the later
    // styles.css itself wins.
    return { type: "atomic", side: laterSide(ctx.fileOursMtime, ctx.fileTheirsMtime) };
  }
  // Rule 1: the bundle differs → styles.css follows the side whose
  // bundle is newer (the canonical code mtime, shared by every coupled
  // file so the group stays atomic).
  return { type: "atomic", side: laterSide(ctx.codeOursMtime, ctx.codeTheirsMtime) };
}

// Semver comparison for the coupled bundle. Returns the winning side,
// or null on a tie / when neither side has a parseable version. A
// single parseable side wins (the other manifest is missing or borked).
function semverSide(
  oursVersion: string | null,
  theirsVersion: string | null,
): "ours" | "theirs" | null {
  if (oursVersion !== null && theirsVersion !== null) {
    const cmp = compareSemver(oursVersion, theirsVersion);
    if (cmp > 0) return "ours";
    if (cmp < 0) return "theirs";
    return null; // tie
  }
  if (oursVersion !== null) return "ours";
  if (theirsVersion !== null) return "theirs";
  return null;
}

// Later-mtime tie-break. A tie resolves to "theirs" so devices
// converge on the server copy (§28: never leave it unresolved).
function laterSide(oursMtime: number, theirsMtime: number): "ours" | "theirs" {
  return oursMtime > theirsMtime ? "ours" : "theirs";
}

async function tryTextMerge(
  ours: ArrayBuffer,
  theirs: ArrayBuffer,
  base: ArrayBuffer | null,
  mergeFn: MergeTextFn,
): Promise<AutoMergeResult> {
  // 3-way merge needs a shared base. "Added on both sides
  // independently" has no base — register as a conflict and let the
  // user see both versions side-by-side.
  if (base === null) return { type: "register-conflict" };
  const decoder = new TextDecoder();
  const oursText = decoder.decode(ours);
  const theirsText = decoder.decode(theirs);
  const baseText = decoder.decode(base);
  const result = await mergeFn(oursText, baseText, theirsText);
  if (result.kind === "clean") {
    const encoded = new TextEncoder().encode(result.content);
    return {
      type: "clean",
      content: encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ) as ArrayBuffer,
    };
  }
  return { type: "register-conflict" };
}
