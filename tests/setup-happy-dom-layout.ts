// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// GIVE happy-dom A WIDTH. One line of behaviour, a page of why.
//
// ── THE SYMPTOM ──────────────────────────────────────────────────────────────
// Every diff2 suite that mounts a real CM6 pane was paying ~8.6 ms per dispatched
// transaction on a 60-byte document. `vitest.config.ts` already carries the scar:
// its testTimeout was raised to 30 s because these suites "legitimately exceed
// Vitest's 5s default" under parallel load. That was a ceiling raised against a
// cost nobody had measured.
//
// ── THE MEASUREMENT (2026-10-03) ─────────────────────────────────────────────
// A bare CM6 view under the SAME happy-dom costs 0.40 ms per dispatch. The diff2
// pane cost 8.59 ms — 21×. So the cost was ours, not the environment's, and a CPU
// profile put 71 % of it in one place: `markerLayoutController.measureAndApply`.
//
// ── THE CAUSE, which the controller's own source already explains ────────────
// It measures the marker widths ONCE, caches them, and its retry hook is guarded
// by `!this.widths` so that after the first success it "stays inert forever".
// happy-dom has no layout engine: `offsetWidth` is 0 for every element, so the
// measure NEVER succeeds, the cache never fills, the guard never closes — and
// every geometry-changing update rebuilds probe DOM, runs querySelector and
// getComputedStyle. 40 % of total CPU went to happy-dom re-parsing CSS selector
// strings, which it does not cache.
//
// ⚠️ THIS IS NOT A PRODUCTION DEFECT, and that distinction is the point. In
// Obsidian `styles.css` is loaded, widths are non-zero, the cache fills on the
// first paint and the hook goes inert exactly as designed. The tests were paying
// for a condition that does not exist in the product — and worse, they were
// exercising a code path (measure-every-update) that production never takes.
//
// ── WHY `offsetWidth` ONLY ───────────────────────────────────────────────────
// `apply()` bails on `contentDOM.clientWidth === 0`, and clientWidth stays 0 here.
// So no layout mode is chosen, no classes are toggled, and the ONLY thing that
// changes is that the width cache fills. A suite asserting rendered markers sees
// exactly what it saw before.
//
// 📌 It is deliberately NOT a full fake layout. Giving happy-dom believable
// geometry everywhere would let render-dependent assertions pass on numbers no
// browser produced — the "model correct only" trap this project has been bitten
// by before. diff2 render/glyph/caret behaviour still needs a real Chromium; this
// file only removes a cost, it does not add confidence.
//
// ── EFFECT, measured per file ────────────────────────────────────────────────
//   bug56-replay                         11.0 s → 3.9 s   (2.8×)
//   spikes/v2-undo-redo-cursor-spike      4.1 s → 2.3 s   (1.8×)
//   history-replay-v2                     2.2 s → 1.4 s   (1.6×)
//   spikes/v2-recovery-replay-spike       2.1 s → 1.5 s   (1.4×)
//   history-compact (428-block replay)   19.8 s → 3.2 s   (measured first, alone)
//   tests/diff2 total                    69.8 s → 60.3 s
//   full unit suite wall-clock           37.5 s → 34.9 s
//
// ⚠️ READ THAT SHAPE, not the headline. The tax is per DISPATCH, so it only
// shows up where a suite does hundreds of them — the replay-heavy files. The
// twenty-odd suites that mount a pane and then make a handful of edits pay
// milliseconds and are unchanged. "Every diff2 suite pays this" is true and
// mostly irrelevant; "the replay suites paid 3× their cost" is the useful
// sentence. The full-suite number is small because 155 files run in parallel
// and diff2 was never the critical path.
//
// Node-environment test files are untouched: `HTMLElement` is undefined there and
// the guard below returns.

if (typeof HTMLElement !== "undefined") {
  const proto = HTMLElement.prototype as object;
  // `configurable: true` so a suite that genuinely needs the zero-width,
  // never-caching behaviour can still override or delete this.
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get: () => 120,
  });
}
