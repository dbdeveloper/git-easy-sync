import { type App, TFile } from "obsidian";

// Preserve open MarkdownView tabs across a write to a large file.
//
// WHY: when a file is open in a tab and we write it via vault.modifyBinary, Obsidian applies
// the on-disk change to the LIVE editor incrementally (a 0→N-byte "Restore" becomes thousands
// of tiny edits, each re-rendered) → the main thread freezes for tens of seconds to minutes
// (device: 1.1 MB history [←] = 112 s, with "File system operation timed out" retries). A
// FRESH open of the same file is near-instant — CM6 virtualizes and only renders the visible
// viewport (user-verified: a 1.9 MB note opens instantly and scrolls smoothly).
//
// SO: detach the open view(s) of `path` BEFORE the write (no open editor → the write is fast
// no matter the strategy, AND there is no rename-vanish-close race to fight), run the write,
// then reopen the file FRESH, restoring cursor/scroll via the ephemeral state. The reopen is
// the cheap fresh-render, not the expensive incremental re-render.
//
// try/finally guarantees the tabs come back even if the write throws — we must never lose a
// user's open tab. Returns whatever the write returned.
//
// Reusable by design: diff2 `[←]` uses it now; sync-push (which also writes to files that may
// be open) is the intended Phase-2 caller once this is device-hardened.
export async function writePreservingOpenViews<T>(
  app: App,
  paths: string | readonly string[],
  doWrite: () => Promise<T>,
): Promise<T> {
  // Graceful degradation: without a workspace (headless / unit tests with a bare app), this
  // is a pure passthrough — the view-preservation is a UI enhancement, never a correctness
  // requirement of the write.
  if (typeof app.workspace?.iterateAllLeaves !== "function") {
    return doWrite();
  }

  // A write may touch more than one file (conflict [←] promotes base AND sibling); preserve
  // any tab showing any of them.
  const targets = new Set(typeof paths === "string" ? [paths] : paths);
  interface Snap {
    path: string;
    eState: unknown;
    active: boolean;
  }
  const snaps: Snap[] = [];
  app.workspace.iterateAllLeaves((leaf) => {
    // Duck-type on `.file`, NOT `instanceof MarkdownView`: EVERY file-backed view has a
    // `.file` (MarkdownView, CanvasView, ImageView, PDFView, and any community-plugin
    // FileView). A rename would vanish-close ALL of them, so preserve ALL of them — not just
    // markdown. getEphemeralState / openFile are on the View base, so this works uniformly.
    const v = leaf.view as unknown as {
      file?: { path?: string };
      getEphemeralState?: () => unknown;
    };
    const p = v?.file?.path;
    if (typeof p === "string" && targets.has(p)) {
      snaps.push({
        path: p,
        eState: v.getEphemeralState?.() ?? null,
        active: leaf === app.workspace.activeLeaf,
      });
      leaf.detach(); // close BEFORE the write → no live view to re-render incrementally
    }
  });

  try {
    return await doWrite();
  } finally {
    for (const s of snaps) {
      // Re-fetch per snap: the write may have replaced the TFile (rename → new object), or
      // deleted it (empty-base delete) → getAbstractFileByPath returns null, nothing to reopen.
      const tfile = app.vault.getAbstractFileByPath(s.path);
      if (tfile instanceof TFile) {
        const leaf = app.workspace.getLeaf("tab");
        await leaf.openFile(tfile, {
          active: s.active,
          eState: (s.eState as Record<string, unknown> | null) ?? undefined,
        });
      }
    }
  }
}
