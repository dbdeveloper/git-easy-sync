// marker-panel rebuild — the PRECISE layout decision for the diff-group marker rows
// (<<<<< / ===== / >>>>>). Because every piece is CONSTANT width (monospace font, fixed
// button strings, fixed device labels, a gutter that only grows with the line-number digit
// count), we measure the intrinsic widths ONCE (see measureMarkerWidths in diff-pane-v2.ts)
// and then pick the mode by EXACT arithmetic on every width change — no CSS-breakpoint
// guessing. This module is the pure decision; the measurement + apply live with the widget.
//
// Priority order (user-ratified), highest first:
//   1. everything on ONE LINE (device label inline, not wrapped)
//   2. TEXT buttons (vs compact icons)
//   3. NORMAL gutter offset (vs slid left into the empty gutter zone)
// We sacrifice the LOWEST priority first: slide before switching to icons, switch to icons
// before wrapping the label. Only two levers actually change the width — icons and slide —
// and after either flips we RECOMPUTE from the top (e.g. going to icons frees width, so the
// normal offset is retried first). The label wrapping to its own 2nd line is the last resort,
// and once it happens the row's line-1 requirement drops to glyph+buttons (no label).

export interface MarkerWidths {
  /** The line-number gutter width (px) — the room reclaimed by sliding a marker row left. */
  gutter: number;
  /** Widest one-line requirement with TEXT buttons AND the device label inline (glyph+buttons+label). */
  labelRowText: number;
  /** Widest one-line requirement with ICON buttons AND the device label inline. */
  labelRowIcon: number;
  /** Widest line-1 requirement with TEXT buttons and NO label (label wrapped to line 2). */
  buttonsText: number;
  /** Widest line-1 requirement with ICON buttons and NO label. */
  buttonsIcon: number;
}

export interface MarkerMode {
  /** true → compact icon buttons; false → full text buttons. */
  icons: boolean;
  /** true → slide the row left into the gutter zone (reclaim `gutter` px); false → normal offset. */
  slid: boolean;
}

// Pick the most-preferred (icons, slid) mode whose one-line/line-1 requirement fits `avail`
// (the marker's normal available width = the editor content-box width). Sliding adds `gutter`.
// The 8 rungs are the priority ladder above; the first that fits wins. The final rung always
// returns (icons+slid) as the guaranteed-narrowest fallback even if nothing "fits".
export function chooseMarkerMode(avail: number, w: MarkerWidths): MarkerMode {
  const slidAvail = avail + w.gutter;
  // ── one line (label inline) ──
  if (w.labelRowText <= avail) return { icons: false, slid: false }; // 1
  if (w.labelRowText <= slidAvail) return { icons: false, slid: true }; // 2
  if (w.labelRowIcon <= avail) return { icons: true, slid: false }; // 3
  if (w.labelRowIcon <= slidAvail) return { icons: true, slid: true }; // 4
  // ── label wrapped to line 2 → line-1 is glyph+buttons only ──
  if (w.buttonsText <= avail) return { icons: false, slid: false }; // 5
  if (w.buttonsText <= slidAvail) return { icons: false, slid: true }; // 6
  if (w.buttonsIcon <= avail) return { icons: true, slid: false }; // 7
  return { icons: true, slid: true }; // 8 — narrowest, guaranteed fallback
}
