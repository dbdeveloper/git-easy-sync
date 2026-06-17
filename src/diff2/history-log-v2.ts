// V2 persistence — COMMAND-LOG writer + pure block core (DIFF-EDITOR.md §0.5.2,
// §0.5.5, §0.5.5.1). Parallel to the §1 `history-log.ts`, which dies at Phase 6.
//
// MODEL (canon §0.5): `history.jsonl` = append-only NDJSON, one CM6 transaction =
// one line. A block is the MINIMAL DELTA — never the whole document:
//   edit: { kind:"edit", seq, at, change, newGroup, structure?, caret?, sum }
//   undo: { kind:"undo", seq, at, sum }
//   redo: { kind:"redo", seq, at, sum }
// `change` is `ChangeSet.toJSON()` (only the changed bytes). `structure` (the
// REMAINING VerRange groups) and `caret` ride ONLY on a resolution — the tx that
// carries `setStructure` + `resolveCaret`. Typing / free-edit → `change` only;
// the structure RangeSet maps inclusively, no `setStructure`. undo / redo carry
// zero text — replay re-runs the command (§0.5.3).
//
// `newGroup` (approach B, §0.5.4): the EDGE measures `undoDepth(state)` around the
// dispatch and passes the delta; +1 ⇒ a new undo group started, 0 ⇒ this tx
// coalesced into the current one. Replay forces the SAME grouping with
// `isolateHistory.of("before")` on `newGroup` blocks (history-replay-v2.ts), so
// the recovered undo-model matches BYTE-FOR-BYTE (1b gate, `v2-1b-coalescing-spike`).
//
// §0.5.5.1 pure-core / thin-edges: `buildEditBlock` / `buildCommandBlock` /
// `serializeBlock` / `parseBlock` / `verifyBlock` / `accrueStats` / `shouldCompact`
// are PURE — unit-testable with plain data, no vault, no CM6. `HistoryWriterV2`
// is the thin vault edge (serialized append). `compact()` itself is the carousel
// (§0.5.5) — a SEPARATE later increment, not built here.

import { Annotation } from "@codemirror/state";
import type { StateEffect } from "@codemirror/state";
import type { Vault } from "obsidian";
import { autosaveDir } from "./autosave-store";
import type { VerRange } from "./diff-model";
import { fromRangeSet, resolveCaret, setStructure } from "./diff-structure";

// ── checksum (§0.5.2 `sum`) ──────────────────────────────────────────
//
// FNV-1a 32-bit over UTF-8 bytes, 8 lowercase hex. NOT crypto — a torn-write /
// bit-rot tripwire. `Math.imul` makes the 32-bit multiply exact. Duplicated from
// §1 `history-log.ts` on purpose: that file dies at Phase 6 and V2 must stand
// alone for the clean break. Pinned to published FNV-1a-32 vectors in the test.
export function fnv1a32(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── block format (§0.5.2) ────────────────────────────────────────────

// The main selection {anchor:a, head:h} BEFORE and AFTER an ordinary edit. Recorded
// so replay reconstructs CM6's per-step undo/redo selections IDENTICALLY to the live
// editor — otherwise replay only re-dispatches `change` and CM6 MAPS whatever
// selection it holds, so undo/redo of typing/paste/delete lands the caret wrong in a
// recovered doc (the wander bug, user report 2026-06-17). `before` is essential: a
// pure cursor/selection move between edits is NOT a recorded block, so it can't be
// inferred from the edit chain (e.g. select a range then type over it). RESOLUTIONS
// do NOT carry `sel` — their caret rides `caret`/resolveCaret (ONE mechanism/block).
export interface SelPair {
  before: { a: number; h: number };
  after: { a: number; h: number };
}

export interface EditBlock {
  kind: "edit";
  seq: number; // monotonic from 1 (diagnostics; replay is position-ordered)
  at: string; // ISO timestamp of the transaction
  change: unknown; // ChangeSet.toJSON() — only the changed bytes
  newGroup: boolean; // undoDepth-delta > 0 (approach B group boundary)
  structure?: VerRange[]; // resolution only — the REMAINING groups
  caret?: { before: number; after: number }; // resolution only (resolveCaret)
  sel?: SelPair; // ordinary edit only — before/after selection for faithful u/r replay
  sum: string;
}

export interface CommandBlock {
  kind: "undo" | "redo";
  seq: number;
  at: string;
  sum: string;
}

export type HistoryBlockV2 = EditBlock | CommandBlock;

// ONE serializer used at BOTH write and verify, covering EVERY replay-driving
// field: `kind` (undo↔redo flip), `change`, `newGroup` (undo grouping), `structure`
// + `caret` (resolution). A §1-style {change,structure}-only sum would let a
// corrupted `newGroup`/`caret`/`kind` pass verify and SILENTLY break recovery.
// `JSON.stringify` drops undefined keys identically at write and at verify, so an
// absent `structure`/`caret` (typing) and a present-but-undefined one hash the
// same — no undefined-vs-absent torn-write trap.
function checksumPayload(b: HistoryBlockV2): string {
  if (b.kind === "edit") {
    return JSON.stringify({
      kind: b.kind,
      change: b.change,
      newGroup: b.newGroup,
      structure: b.structure,
      caret: b.caret,
      sel: b.sel,
    });
  }
  return JSON.stringify({ kind: b.kind });
}

// Pure: build an edit block. The EDGE supplies `change` (ChangeSet.toJSON()), the
// tx `effects`, the `undoDepthDelta` it measured around the dispatch, and (for an
// ORDINARY edit) the `sel` before/after selection. Pulls `structure`/`caret` from a
// resolution's `setStructure`/`resolveCaret` effects. A RESOLUTION (has resolveCaret)
// records `caret`, NOT `sel` — one caret mechanism per block; an ordinary edit
// records `sel`. `newGroup = delta > 0`.
export function buildEditBlock(
  seq: number,
  at: string,
  change: unknown,
  effects: readonly StateEffect<unknown>[],
  undoDepthDelta: number,
  sel?: SelPair,
): EditBlock {
  const block: EditBlock = {
    kind: "edit",
    seq,
    at,
    change,
    newGroup: undoDepthDelta > 0,
    sum: "",
  };
  for (const e of effects) {
    if (e.is(setStructure)) block.structure = fromRangeSet(e.value);
    if (e.is(resolveCaret)) block.caret = e.value;
  }
  if (!block.caret && sel) block.sel = sel; // ordinary edit only (resolutions use caret)
  block.sum = fnv1a32(checksumPayload(block));
  return block;
}

// Pure: build an undo / redo command block (zero text).
export function buildCommandBlock(kind: "undo" | "redo", seq: number, at: string): CommandBlock {
  const block: CommandBlock = { kind, seq, at, sum: "" };
  block.sum = fnv1a32(checksumPayload(block));
  return block;
}

export function serializeBlock(b: HistoryBlockV2): string {
  return JSON.stringify(b);
}

// Parse one NDJSON line. Returns null for blank / corrupt / wrong-shape lines —
// replay treats null as "stop here" (§0.5.3, a torn final write leaves a clean
// prefix). Shape is validated per `kind`.
export function parseBlock(line: string): HistoryBlockV2 | null {
  const t = line.trim();
  if (t === "") return null;
  try {
    const o = JSON.parse(t) as { kind?: unknown; seq?: unknown; at?: unknown; sum?: unknown; change?: unknown; newGroup?: unknown };
    if (typeof o.seq !== "number" || typeof o.at !== "string" || typeof o.sum !== "string") {
      return null;
    }
    if (o.kind === "edit") {
      if (o.change === undefined || typeof o.newGroup !== "boolean") return null;
      return o as unknown as EditBlock;
    }
    if (o.kind === "undo" || o.kind === "redo") {
      return o as unknown as CommandBlock;
    }
    return null;
  } catch {
    return null;
  }
}

// True iff the block's recorded sum matches a fresh recompute (§0.5.3 prefix-trust).
export function verifyBlock(b: HistoryBlockV2): boolean {
  return fnv1a32(checksumPayload(b)) === b.sum;
}

// ── replay opt-out marker (Phase-6 wireability) ──────────────────────
//
// The Phase-6 updateListener that feeds HistoryWriterV2 MUST skip transactions
// carrying this annotation — else replaying a session (which re-dispatches every
// restored edit) would re-append them and double the log. Edit re-dispatches in
// replayHistoryV2 carry `replayDispatch.of(true)`. NOTE: `undo(view)`/`redo(view)`
// build their OWN un-annotatable transactions, so suppressing recording across
// the whole replay needs a `replaying` flag the edge toggles (step-2 wiring) — the
// annotation alone does not cover the undo/redo command-replays.
export const replayDispatch = Annotation.define<boolean>();

// ── bloat-stats (§0.5.5 — carousel triggers) ─────────────────────────
//
// Accrued from day 1 so the log carries the data to derive compaction constants
// empirically (§0.5.5). `compact()` itself is deferred (step 3).
export interface BloatStats {
  totalBytes: number; // sum of serialized block lengths incl. the NDJSON newline
  totalEntries: number; // all blocks (edit + undo + redo)
  undoCount: number; // undo command blocks
  cancelledBytes: number; // bytes the undos cancelled — the carousel reclaim estimate
}

export function emptyStats(): BloatStats {
  return { totalBytes: 0, totalEntries: 0, undoCount: 0, cancelledBytes: 0 };
}

// Pure reducer. `undoneBytes` = size of the edit an `undo` cancelled (0 for
// edit / redo blocks); the EDGE supplies it (it knows the current undo-top).
export function accrueStats(stats: BloatStats, block: HistoryBlockV2, undoneBytes = 0): BloatStats {
  return {
    totalBytes: stats.totalBytes + serializeBlock(block).length + 1, // +1 = NDJSON `\n`
    totalEntries: stats.totalEntries + 1,
    undoCount: stats.undoCount + (block.kind === "undo" ? 1 : 0),
    cancelledBytes: stats.cancelledBytes + undoneBytes,
  };
}

export interface CompactThresholds {
  maxUndoCount: number; // OR-trigger 1: count of undo records
  maxCancelledBytes: number; // OR-trigger 2: sum of cancelled bytes
}

// Placeholders — to be derived empirically from logged bloat-stats (§0.5.5).
// Conservative so compaction is RARE (a rare main-thread freeze is acceptable).
export const DEFAULT_COMPACT_THRESHOLDS: CompactThresholds = {
  maxUndoCount: 200,
  maxCancelledBytes: 1_000_000,
};

export function shouldCompact(stats: BloatStats, t: CompactThresholds = DEFAULT_COMPACT_THRESHOLDS): boolean {
  return stats.undoCount >= t.maxUndoCount || stats.cancelledBytes >= t.maxCancelledBytes;
}

// ── thin vault edge: serialized append writer (§0.5.2) ────────────────
//
// Mirrors the §1 HistoryWriter's serialized-tail discipline (Capacitor gives no
// cross-call ordering, so appends run one-at-a-time). DIFFERENCE FROM §1: no
// `truncateLastBlock` — V2 records undo/redo as COMMAND blocks (replay re-runs
// them), so the log only ever grows until the carousel compacts it.
export class HistoryWriterV2 {
  private seq: number;
  private stats: BloatStats = emptyStats();
  private queue: string[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: Vault,
    private readonly autosaveId: string,
    startSeq = 0,
  ) {
    this.seq = startSeq;
  }

  private path(): string {
    return `${autosaveDir(this.autosaveId)}/history.jsonl`;
  }

  // The seq stamp + stats update + enqueue are SYNCHRONOUS (block order is fixed
  // before any await); the append is scheduled on the serialized tail.
  recordEdit(
    change: unknown,
    effects: readonly StateEffect<unknown>[],
    undoDepthDelta: number,
    at: string,
    sel?: SelPair,
  ): void {
    this.seq += 1;
    this.enqueue(buildEditBlock(this.seq, at, change, effects, undoDepthDelta, sel));
  }

  recordCommand(kind: "undo" | "redo", at: string, undoneBytes = 0): void {
    this.seq += 1;
    this.enqueue(buildCommandBlock(kind, this.seq, at), undoneBytes);
  }

  private enqueue(block: HistoryBlockV2, undoneBytes = 0): void {
    this.stats = accrueStats(this.stats, block, undoneBytes);
    this.queue.push(serializeBlock(block));
    this.tail = this.tail.then(() => this.flush()).catch((e) => {
      // A failed append loses one increment; session snapshots + prior history +
      // the [← back] Step-1 drain are the backstop. NEVER propagate into CM6.
      console.error("[gh-sync] diff2 v2 history append failed", e);
    });
  }

  // Append all queued blocks as one NDJSON write (adapter.append is mobile-proven
  // via src/logger.ts). No-op when the queue is empty.
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const data = this.queue.map((line) => `${line}\n`).join("");
    this.queue = [];
    await this.vault.adapter.append(this.path(), data);
  }

  // Await every scheduled append — the [← back] Step-1 flush barrier (§2.8).
  async drain(): Promise<void> {
    await this.tail;
    await this.flush();
  }

  pendingCount(): number {
    return this.queue.length;
  }

  getStats(): BloatStats {
    return this.stats;
  }
}
