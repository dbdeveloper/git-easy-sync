// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { TFolder, type EventRef, type TAbstractFile, type Vault } from "obsidian";

// FolderWatcher (GITKEEP I12, I15; docs/tasks/GITKEEP.md). Obsidian's
// folder events only MARK the folder journal — create, delete, and both
// paths of a rename; file events are ignored. Read-only like
// ConflictWatcher: it never writes, the commit does (I20). It is the
// second explicit exception to the engine's polling rule: events tell
// the commit WHERE to look, the commit still looks at the truth.
//
// Started from workspace.onLayoutReady, not onload: on vault load
// Obsidian fires `create` for every existing item (obsidian.d.ts), which
// would mark every folder on every start. The window before layout-ready
// is covered by the start scan.

export interface FolderWatcherDeps {
  vault: Vault;
  mark: (folder: string) => void;
}

export class FolderWatcher {
  private refs: EventRef[] = [];

  constructor(private readonly deps: FolderWatcherDeps) {}

  start(): void {
    if (this.refs.length > 0) return;
    const { vault, mark } = this.deps;
    this.refs.push(
      vault.on("create", (f: TAbstractFile) => {
        if (f instanceof TFolder) mark(f.path);
      }),
      vault.on("delete", (f: TAbstractFile) => {
        if (f instanceof TFolder) mark(f.path);
      }),
      vault.on("rename", (f: TAbstractFile, oldPath: string) => {
        if (!(f instanceof TFolder)) return;
        mark(f.path);
        mark(oldPath);
      }),
    );
  }

  stop(): void {
    for (const ref of this.refs) this.deps.vault.offref(ref);
    this.refs = [];
  }
}
