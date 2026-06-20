// @vitest-environment happy-dom
//
// V2 replay (DIFF-EDITOR.md §0.5.3). Pure scan/assess/classify tests use plain
// data; the FIDELITY tests (advisor #4) port BOTH proven gate spikes —
// v2-mixed-recovery and v2-1b-coalescing — through the REAL production path:
// capture `tr.changes.toJSON()` + `tr.effects` + undoDepth-delta → buildEditBlock /
// buildCommandBlock → serializeBlock → join NDJSON → scanHistoryV2 (parse+verify) →
// replayHistoryV2 into a fresh mounted view. Recovered doc + structure + undo-model
// + resolution caret must equal the live editor's.

import { describe, it, expect } from "vitest";
import { isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import { resolveGroup } from "../../src/diff2/diff-resolve";
import {
  buildCommandBlock,
  buildEditBlock,
  serializeBlock,
} from "../../src/diff2/history-log-v2";
import type { HistoryBlockV2 } from "../../src/diff2/history-log-v2";
import {
  assessHistoryV2,
  replayHistoryV2,
  replayStep,
  scanHistoryV2,
} from "../../src/diff2/history-replay-v2";

// ── pure: scan / assess / classify ───────────────────────────────────

const editLine = (seq: number, newGroupDelta: number) =>
  serializeBlock(buildEditBlock(seq, "t", [1, [0, "x"]], [], newGroupDelta));

describe("scanHistoryV2 — trust the clean prefix, stop at corruption", () => {
  it("clean log → all blocks, stoppedAtCorrupt false", () => {
    const jsonl = [editLine(1, 1), editLine(2, 0)].join("\n");
    const r = scanHistoryV2(jsonl);
    expect(r.blocks.length).toBe(2);
    expect(r.stoppedAtCorrupt).toBe(false);
  });
  it("torn final line → prefix kept, stoppedAtCorrupt true", () => {
    const jsonl = [editLine(1, 1), '{"kind":"edit","seq":2,"at":"t","change'].join("\n");
    const r = scanHistoryV2(jsonl);
    expect(r.blocks.length).toBe(1);
    expect(r.stoppedAtCorrupt).toBe(true);
  });
  it("checksum mismatch mid-log → stop there", () => {
    const tampered = editLine(2, 0).replace('"newGroup":false', '"newGroup":true');
    const r = scanHistoryV2([editLine(1, 1), tampered].join("\n"));
    expect(r.blocks.length).toBe(1);
    expect(r.stoppedAtCorrupt).toBe(true);
  });
});

describe("assessHistoryV2", () => {
  it("empty input → empty, not corrupt", () => {
    expect(assessHistoryV2("")).toEqual({ edits: 0, stoppedAtCorrupt: false, empty: true, firstBlockCorrupt: false });
  });
  it("first block corrupt → firstBlockCorrupt", () => {
    const a = assessHistoryV2("{garbage");
    expect(a.firstBlockCorrupt).toBe(true);
    expect(a.edits).toBe(0);
  });
  it("edits counts edit blocks only (not undo/redo)", () => {
    const jsonl = [
      editLine(1, 1),
      serializeBlock(buildCommandBlock("undo", 2, "t")),
      serializeBlock(buildCommandBlock("redo", 3, "t")),
    ].join("\n");
    expect(assessHistoryV2(jsonl).edits).toBe(1);
  });

  it("(bug-31/32) counts only newGroup edits = live undo depth, NOT raw edit blocks", () => {
    // a coalesced burst: 1 newGroup + 2 continuations (newGroup:false) → ONE undo
    // group, not three. The old all-edits count gave 3; the live undo depth is 1.
    const jsonl = [editLine(1, 1), editLine(2, 0), editLine(3, 0)].join("\n");
    expect(assessHistoryV2(jsonl).edits).toBe(1); // ← was 3 before the metric fix
  });

  it("(bug-31/32) net over coalesced bursts + undos = live undo depth", () => {
    // 3 groups (each a 2-block coalesced burst) then 2 undos → live depth 1.
    const jsonl = [
      editLine(1, 1), editLine(2, 0), // group 1
      editLine(3, 1), editLine(4, 0), // group 2
      editLine(5, 1), editLine(6, 0), // group 3
      serializeBlock(buildCommandBlock("undo", 7, "t")),
      serializeBlock(buildCommandBlock("undo", 8, "t")),
    ].join("\n");
    // raw-edit count would be 6−2 = 4; live undo groups = 3−2 = 1.
    expect(assessHistoryV2(jsonl).edits).toBe(1);
  });

  it("(bug-31/32) a fully-undone session is empty (no live groups)", () => {
    const jsonl = [
      editLine(1, 1), editLine(2, 0), // one coalesced group
      serializeBlock(buildCommandBlock("undo", 3, "t")),
    ].join("\n");
    expect(assessHistoryV2(jsonl).empty).toBe(true); // 1 newGroup − 1 undo = 0
    expect(assessHistoryV2(jsonl).edits).toBe(0);
  });
});

describe("replayStep — pure classifier", () => {
  it("edit→dispatch, undo→undo, redo→redo", () => {
    expect(replayStep(buildEditBlock(1, "t", [], [], 1))).toBe("dispatch");
    expect(replayStep(buildCommandBlock("undo", 1, "t"))).toBe("undo");
    expect(replayStep(buildCommandBlock("redo", 1, "t"))).toBe("redo");
  });
});

// ── live-session capture: the production updateListener's view ───────
//
// A real Phase-6 updateListener reads `tr.changes.toJSON()`, `tr.effects`, and
// undoDepth(before/after) per transaction. We reproduce that here by building the
// tr from the spec, dispatching that exact tr, then recording via the production
// builders — so the test exercises the SAME serialization the wiring will.
//
// `pause` injects `isolateHistory.of("before")` — the synchronous stand-in for a
// real typing pause (> newGroupDelay) that, in production, makes CM6 start a new
// undo group. The recorded `newGroup` still comes from the REAL undoDepth delta
// (the isolate just makes it deterministic in a zero-time test), so the captured
// data is exactly what a live session with pauses would write.
function liveRecorder(view: EditorView) {
  const log: HistoryBlockV2[] = [];
  let seq = 0;
  return {
    log,
    edit(spec: TransactionSpec, pause = false) {
      const before = undoDepth(view.state);
      const tr = view.state.update(
        pause ? { ...spec, annotations: ([] as unknown[]).concat(spec.annotations ?? [], isolateHistory.of("before")) as TransactionSpec["annotations"] } : spec,
      );
      view.dispatch(tr);
      const delta = undoDepth(view.state) - before;
      log.push(buildEditBlock(++seq, "t", tr.changes.toJSON(), tr.effects, delta));
    },
    undo() {
      undo(view);
      log.push(buildCommandBlock("undo", ++seq, "t"));
    },
    redo() {
      redo(view);
      log.push(buildCommandBlock("redo", ++seq, "t"));
    },
  };
}

const docStruct = (v: EditorView) => ({ doc: v.state.doc.toString(), struct: readStructure(v.state) });

describe("FIDELITY — v2-mixed-recovery ported through the production path", () => {
  const BASE = "top\nA1\nmid\nB1\nbot\n";
  const SIBLING = "top\nA2\nmid\nB2\nbot\n"; // 2 diff-groups

  it("mixed typing + resolution + undo/redo recovers == live (real JSON round-trip)", () => {
    const lp = document.createElement("div");
    const rp = document.createElement("div");
    document.body.append(lp, rp);
    const live = mountDiffPaneV2(lp, BASE, SIBLING);
    try {
      const rec = liveRecorder(live);
      let before2 = -1;
      let after2 = -1;

      // Four distinct ops, each after a (simulated) pause ⇒ four undo groups.
      rec.edit({ changes: { from: 0, insert: "Z" }, userEvent: "input.type" }, true); // op1 type in normal text
      {
        const r = readStructure(live.state);
        const v1 = r.find((x) => x.group === 0 && x.ver === 1)!;
        before2 = v1.from + 1;
        rec.edit(resolveGroup(live.state.doc, r, 0, "keep1", {}, before2)!, true); // op2 resolve
        after2 = live.state.selection.main.head;
      }
      {
        const v1 = readStructure(live.state).find((x) => x.group === 1 && x.ver === 1)!;
        rec.edit({ changes: { from: v1.from + 1, insert: "q" }, userEvent: "input.type" }, true); // op3 type into ver1
      }
      {
        const r = readStructure(live.state);
        const v1 = r.find((x) => x.group === 1 && x.ver === 1)!;
        rec.edit(resolveGroup(live.state.doc, r, 1, "keep2", {}, v1.from + 1)!, true); // op4 resolve
      }
      rec.undo();
      rec.undo();
      rec.redo();

      // CRASH → real NDJSON → parse+verify+replay into a fresh view
      const jsonl = rec.log.map(serializeBlock).join("\n");
      const replayed = mountDiffPaneV2(rp, BASE, SIBLING);
      try {
        const res = replayHistoryV2(replayed, jsonl);
        expect(res.stoppedAtCorrupt).toBe(false);
        expect(docStruct(replayed), "recovered doc+structure == live").toEqual(docStruct(live));

        // undo/redo walk: doc+structure identical every step; RESOLUTION caret exact
        const at = (label: string) => expect(docStruct(replayed), label).toEqual(docStruct(live));
        undo(live); undo(replayed); at("undo→after op2 (op3 typing undone)");
        undo(live); undo(replayed); at("undo→after op1 (op2 resolution undone)");
        expect(replayed.state.selection.main.head, "resolution undo → before2 (recovered)").toBe(before2);
        expect(live.state.selection.main.head, "resolution undo → before2 (live)").toBe(before2);
        redo(live); redo(replayed); at("redo→after op2 (resolution redone)");
        expect(replayed.state.selection.main.head, "resolution redo → after2 (recovered)").toBe(after2);
        expect(live.state.selection.main.head, "resolution redo → after2 (live)").toBe(after2);
      } finally {
        replayed.destroy();
        rp.remove();
      }
    } finally {
      live.destroy();
      lp.remove();
    }
  });
});

describe("FIDELITY — v2-1b-coalescing ported through the production path", () => {
  it("coalesced bursts → undo-depth + granularity reproduced byte-for-byte", () => {
    const lp = document.createElement("div");
    const rp = document.createElement("div");
    document.body.append(lp, rp);
    const live = mountDiffPaneV2(lp, "hello\n", "hello\n"); // no groups — plain text
    try {
      const rec = liveRecorder(live);
      // burst1 "abc" coalesces (adjacent input.type, no pause)
      rec.edit({ changes: { from: 0, insert: "a" }, userEvent: "input.type" });
      rec.edit({ changes: { from: 1, insert: "b" }, userEvent: "input.type" });
      rec.edit({ changes: { from: 2, insert: "c" }, userEvent: "input.type" });
      // [simulated pause] burst2 starts a NEW group (pause=true), "Y" coalesces in
      rec.edit({ changes: { from: 3, insert: "X" }, userEvent: "input.type" }, true);
      rec.edit({ changes: { from: 4, insert: "Y" }, userEvent: "input.type" });

      expect(live.state.doc.toString()).toBe("abcXYhello\n");
      // newGroup must mark exactly the two burst starts (G··G·)
      const flags = rec.log.map((e) => (e.kind === "edit" ? (e.newGroup ? "G" : "·") : "?")).join("");
      expect(flags, "two coalesced bursts ⇒ two group starts").toBe("G··G·");
      const liveDepth = undoDepth(live.state);
      expect(liveDepth, "undo-depth 2").toBe(2);

      const jsonl = rec.log.map(serializeBlock).join("\n");
      const replayed = mountDiffPaneV2(rp, "hello\n", "hello\n");
      try {
        replayHistoryV2(replayed, jsonl);
        expect(replayed.state.doc.toString(), "recovered doc").toBe(live.state.doc.toString());
        expect(undoDepth(replayed.state), "recovered undo-depth == live").toBe(liveDepth);
        // BYTE-FOR-BYTE granularity: each undo reverts a WHOLE burst, in lockstep
        for (let i = 0; i < liveDepth; i++) {
          undo(live);
          undo(replayed);
          expect(replayed.state.doc.toString(), `undo step ${i + 1}`).toBe(live.state.doc.toString());
        }
        expect(replayed.state.doc.toString(), "all undone → back to start").toBe("hello\n");
      } finally {
        replayed.destroy();
        rp.remove();
      }
    } finally {
      live.destroy();
      lp.remove();
    }
  });
});
