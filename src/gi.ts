// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import ignore, { Ignore } from "ignore";
// path-browserify is a pure-JS implementation of Node's `path` module,
// safe to load on Obsidian Mobile (no Node runtime). A top-level
// `import "path"` would leave a `require("path")` at the top of the
// bundle (esbuild marks "path" as external by default), which throws
// at load time on mobile and silently crashes the plugin during
// "Enable" in the community-plugins list. Same problem applied to fs;
// see defaultReadFile below for how that one is handled.
import * as path from "path-browserify";

type ReadFile = (absPath: string) => string | null;
type AsyncReadFile = (absPath: string) => Promise<string | null>;

// Mtime-aware async reader. Returns null when the file is missing.
// Used by ignoredAsync() to decide whether a cached level is still
// fresh: if the on-disk mtime hasn't moved, the cached parse is
// still authoritative and we skip the read.
export type AsyncReadFileWithMtime = (
  absPath: string,
) => Promise<{ content: string; mtime: number } | null>;

interface Node {
  dir: string;
  ig: Ignore | null;
  loaded: boolean;
  // mtime of the .gitignore at the moment ig was parsed. Undefined
  // when no file exists at this level, or when the node was loaded
  // via the legacy AsyncReadFile path (which doesn't carry mtime).
  mtime?: number;
  // Local-clock timestamp of the last stat-or-load against this
  // node. Used by the cooldown short-circuit so a single sync run's
  // many ignored() calls produce at most one stat per loaded level.
  lastStatAt?: number;
  children: Map<string, Node>;
}

// Within this many ms of the previous stat, ignoredAsync() trusts
// the cached parse without re-statting. Tunes "cost" vs "freshness":
// 500ms is enough to dedupe stats inside a single sync run while
// still picking up between-sync edits at the start of the next one.
const STAT_COOLDOWN_MS = 500;

// Production sync path: vault-adapter-backed reader injected via
// change-detector.ts → ignoredAsync(). Default below is only used by
// unit tests, hence lazy-require so mobile (no Node) doesn't fail at
// module load.
const defaultReadFile: ReadFile = (absPath) => {
  let fsMod: typeof import("fs");
  try {
    fsMod = require("fs");
  } catch {
    return null;
  }
  try {
    return fsMod.readFileSync(absPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "EISDIR" || e.code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
};


export default class GI {
  private rootDir: string;
  private root: Node;
  private readFile: ReadFile;

  constructor(rootDir: string, readFile: ReadFile = defaultReadFile) {
    // Empty rootDir is allowed: some mobile vault adapters return ""
    // for basePath, and callers already feed us vault-relative paths
    // in that case, so "no prefix" is a valid mode.
    if (rootDir !== "" && !path.isAbsolute(rootDir)) {
      throw new Error(
        `GI: rootDir must be absolute or empty, got "${rootDir}"`,
      );
    }
    this.rootDir =
      rootDir === "" ? "" : path.resolve(rootDir).split(path.sep).join("/");
    this.readFile = readFile;
    this.root = makeNode("");
  }

  ignored(filePath: string): boolean {
    const rel = this.toRelative(filePath);
    if (rel === null || rel === "") return false;

    const parts = rel.split("/");
    const dirs = [""];
    for (let i = 0; i < parts.length - 1; i++) {
      dirs.push(parts.slice(0, i + 1).join("/"));
    }

    const nodes: Node[] = [];
    let node = this.root;
    for (const dir of dirs) {
      node = this.ensureNode(node, dir);
      this.ensureLoaded(node);
      nodes.push(node);
    }

    // git's no-descent rule, and the reason this loop exists at all:
    // an excluded DIRECTORY is never entered, so nothing beneath it can
    // be re-included — not by a `!` in a deeper .gitignore, not by any
    // rule at a lower level. ("It is not possible to re-include a file
    // if a parent directory of that file is excluded.")
    //
    // Each ancestor is judged by the levels ABOVE it only: a
    // directory's own .gitignore cannot re-admit that directory, since
    // git would have to enter the directory to read it. Directories are
    // probed with a trailing slash because that is the only form a
    // dir-only pattern (`foo/`, `.*/`) matches — measured, and the
    // trap that would silently disable this whole rule.
    for (let i = 1; i < dirs.length; i++) {
      if (this.verdict(nodes, dirs, i, `${dirs[i]}/`)) return true;
    }
    return this.verdict(nodes, dirs, dirs.length, rel);
  }

  // Last-match-wins across the first `levels` .gitignore nodes, each
  // asked about `target` rewritten relative to that node's own dir.
  private verdict(
    nodes: Node[],
    dirs: string[],
    levels: number,
    target: string,
  ): boolean {
    let state = false;
    for (let i = 0; i < levels; i++) {
      const ig = nodes[i].ig;
      if (!ig) continue;
      const dir = dirs[i];
      const sub = dir === "" ? target : target.slice(dir.length + 1);
      const r = ig.test(sub);
      if (r.unignored) state = false;
      else if (r.ignored) state = true;
    }
    return state;
  }

  // Async wrapper around ignored(). Walks the path, freshness-checks
  // each level's .gitignore (stat + mtime + cooldown), reloads if
  // disk has moved, then runs the sync matcher. Callers never have to
  // think about cache invalidation: GI keeps itself in sync with the
  // filesystem on its own.
  //
  // Two reader shapes are supported:
  //   - AsyncReadFile (content only): legacy callers; cache stays
  //     valid for the GI's lifetime (no stat → no freshness check).
  //   - AsyncReadFileWithMtime: returns {content, mtime}; GI
  //     stats-with-cooldown and reloads only when mtime moved.
  async ignoredAsync(
    filePath: string,
    reader: AsyncReadFile | AsyncReadFileWithMtime,
  ): Promise<boolean> {
    await this.preloadAsync(filePath, reader);
    return this.ignored(filePath);
  }

  // Walk directories from root down to the file's parent; for each
  // level, refresh from disk if needed (mtime-aware) or do the
  // first-time load. After this completes, ignored() can run fully
  // synchronously against the same path.
  async preloadAsync(
    filePath: string,
    reader: AsyncReadFile | AsyncReadFileWithMtime,
  ): Promise<void> {
    const rel = this.toRelative(filePath);
    if (rel === null || rel === "") return;
    const parts = rel.split("/");
    const dirs = [""];
    for (let i = 0; i < parts.length - 1; i++) {
      dirs.push(parts.slice(0, i + 1).join("/"));
    }
    let node = this.root;
    for (const dir of dirs) {
      node = this.ensureNode(node, dir);
      const giAbs =
        dir === ""
          ? `${this.rootDir}/.gitignore`
          : `${this.rootDir}/${dir}/.gitignore`;
      await this.refreshNode(node, giAbs, reader);
    }
  }

  private async refreshNode(
    node: Node,
    giAbs: string,
    reader: AsyncReadFile | AsyncReadFileWithMtime,
  ): Promise<void> {
    const now = Date.now();

    // Cooldown: if we recently stat-ed this node, trust the cache.
    if (
      node.loaded &&
      node.lastStatAt !== undefined &&
      now - node.lastStatAt < STAT_COOLDOWN_MS
    ) {
      return;
    }

    const result = await reader(giAbs);
    node.lastStatAt = now;

    if (result === null) {
      // No .gitignore at this level. Drop any prior parse.
      node.ig = null;
      node.mtime = undefined;
      node.loaded = true;
      return;
    }

    // Two reader shapes — narrow on whether mtime is present.
    if (typeof result === "string") {
      // Content-only reader. We can't verify freshness, so re-parse
      // every time the cooldown elapses — cheap, but not as cheap
      // as the mtime path.
      node.ig = ignore().add(result);
      node.loaded = true;
      return;
    }

    // mtime-aware reader.
    if (node.loaded && node.mtime === result.mtime) {
      // Disk unchanged since our cached parse — keep it.
      return;
    }
    node.ig = ignore().add(result.content);
    node.mtime = result.mtime;
    node.loaded = true;
  }

  // Drop a cached .gitignore so the next ignored()/ignoredAsync() rereads
  // it from disk. Use after editing a .gitignore at runtime when you
  // *know* the file changed and want to skip even the cooldown check.
  // For routine "did the disk move?" cases, ignoredAsync's mtime-aware
  // auto-stat already handles it.
  invalidate(dir: string = ""): void {
    const target = dir === "" ? this.root : this.findNode(dir);
    if (!target) return;
    target.loaded = false;
    target.ig = null;
    target.mtime = undefined;
    target.lastStatAt = undefined;
  }

  private findNode(targetDir: string): Node | null {
    if (targetDir === "") return this.root;
    let node: Node = this.root;
    const parts = targetDir.split("/");
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const child = node.children.get(seg);
      if (!child) return null;
      node = child;
    }
    return node;
  }

  private toRelative(input: string): string | null {
    if (!input) return null;
    // Normalize backslashes first so Windows-style inputs work uniformly.
    const normalized = input.split("\\").join("/");
    // Relative inputs are anchored to rootDir, not to process.cwd() — the
    // caller thinks in vault-relative terms. Absolute inputs are resolved
    // as-is and then trimmed against rootDir below.
    let absRaw: string;
    if (path.isAbsolute(normalized)) {
      absRaw = path.resolve(normalized);
    } else if (this.rootDir === "") {
      absRaw = path.resolve("/", normalized);
    } else {
      absRaw = path.resolve(this.rootDir, normalized);
    }
    const abs = absRaw.split(path.sep).join("/");
    if (this.rootDir === "") {
      // No prefix to strip — return abs without the leading "/".
      return abs.startsWith("/") ? abs.slice(1) : abs;
    }
    if (abs === this.rootDir) return "";
    const prefix = this.rootDir + "/";
    if (!abs.startsWith(prefix)) return null;
    return abs.slice(prefix.length);
  }

  private ensureNode(parent: Node, targetDir: string): Node {
    if (parent.dir === targetDir) return parent;
    const remainder =
      parent.dir === "" ? targetDir : targetDir.slice(parent.dir.length + 1);
    const firstSeg = remainder.split("/")[0];
    let child = parent.children.get(firstSeg);
    if (!child) {
      const childDir =
        parent.dir === "" ? firstSeg : `${parent.dir}/${firstSeg}`;
      child = makeNode(childDir);
      parent.children.set(firstSeg, child);
    }
    return this.ensureNode(child, targetDir);
  }

  private ensureLoaded(node: Node): void {
    if (node.loaded) return;
    const giAbs =
      node.dir === ""
        ? `${this.rootDir}/.gitignore`
        : `${this.rootDir}/${node.dir}/.gitignore`;
    const content = this.readFile(giAbs);
    if (content !== null) node.ig = ignore().add(content);
    node.loaded = true;
  }
}

function makeNode(dir: string): Node {
  return { dir, ig: null, loaded: false, children: new Map() };
}
