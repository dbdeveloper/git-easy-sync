// Conflicts-mode detail-view toolbar (R7.9a).
//
// Phase 3 ships:
//   [← Back to list]
//   [Keep all local (<localLabel>) changes]
//   [Apply all remote (<remoteLabel>) changes]
//   [Join all changes]   (markdown files only)
//   ⏩ Auto-advance toggle
//
// Phase 6 will add [Open in external tool] at the far right (R6.3,
// desktop only). Phase 7+ may swap toolbar layout when the view is
// in History / Compare mode; this module owns only the Conflicts
// variant.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.9a (toolbar layout)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (group buttons names)

export interface ConflictsToolbarCallbacks {
  onBack: () => void;
  onKeepAllLocal: () => void;
  onApplyAllRemote: () => void;
  // Optional — undefined disables the button (used for non-markdown
  // base files where blockquote join would corrupt the file format).
  onJoinAll?: () => void;
  // Optional — Phase 3 reads the initial state from settings and
  // persists toggle changes via this callback. When undefined the
  // toggle is rendered as off-only (visual placeholder).
  onAutoAdvanceToggle?: (enabled: boolean) => void;
  // Initial auto-advance state. Defaults to false.
  initialAutoAdvance?: boolean;
}

export interface ConflictsToolbarLabels {
  localLabel: string;
  remoteLabel: string;
}

// Render the toolbar into the supplied container. Idempotent —
// caller empties the container before each render. Returns nothing;
// all interaction goes through the callbacks.
export function renderConflictsToolbar(
  container: HTMLElement,
  labels: ConflictsToolbarLabels,
  callbacks: ConflictsToolbarCallbacks,
): void {
  container.empty();
  container.addClass("diff2-conflicts-toolbar");

  // Left cluster: back-arrow.
  const back = container.createSpan({
    cls: "diff2-back-arrow",
    text: "← Back to list",
  });
  back.style.cursor = "pointer";
  back.addEventListener("click", () => callbacks.onBack());

  // Middle cluster: group resolve buttons.
  const middle = container.createDiv({ cls: "diff2-toolbar-actions" });

  // TODO §6 — short, colour-named buttons (red = ver1/local, green = ver2/
  // remote) tinted to the side colour. Safe because undo/redo is reliable. The
  // full device-scoped description stays on hover (title).
  const keepBtn = middle.createEl("button", {
    cls: "diff2-btn diff2-btn-keep-local",
    text: "Keep all",
  });
  keepBtn.title = `Keep all local (${labels.localLabel}) changes`;
  keepBtn.addEventListener("click", () => callbacks.onKeepAllLocal());

  const applyBtn = middle.createEl("button", {
    cls: "diff2-btn diff2-btn-apply-remote",
    text: "Apply all",
  });
  applyBtn.title = `Apply all remote (${labels.remoteLabel}) changes`;
  applyBtn.addEventListener("click", () => callbacks.onApplyAllRemote());

  if (callbacks.onJoinAll) {
    const joinBtn = middle.createEl("button", {
      cls: "diff2-btn diff2-btn-join-all",
      text: "> Join all",
    });
    joinBtn.addEventListener("click", () => callbacks.onJoinAll!());
  }

  // Right cluster: auto-advance toggle. Phase 3 renders the visual
  // affordance even when no callback is wired; the toggle stays
  // visually consistent across phases.
  const right = container.createDiv({ cls: "diff2-toolbar-right" });
  const autoAdvanceLabel = right.createSpan({
    cls: "diff2-auto-advance-label",
    text: "⏩ Auto-advance",
  });
  void autoAdvanceLabel;
  const checkbox = right.createEl("input", {
    cls: "diff2-auto-advance-checkbox",
    type: "checkbox",
  });
  checkbox.checked = callbacks.initialAutoAdvance ?? false;
  if (callbacks.onAutoAdvanceToggle) {
    checkbox.addEventListener("change", () => {
      callbacks.onAutoAdvanceToggle!(checkbox.checked);
    });
  } else {
    checkbox.disabled = true;
  }
}
