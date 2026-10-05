// The two-section notice model (owner, 2026-10-03).
//
// Pure, so the whole lifecycle is checked without a DOM, a plugin or a
// clock: `nowMs` is a parameter. The wiring in main.ts is thin on
// purpose — everything that can be decided here is decided here,
// because this is the node where ordering bugs kept appearing.

import { describe, expect, it } from "vitest";
import {
  EMPTY_NOTICE_STATE,
  nextNoticeDeadline,
  renderNoticeState,
  type NoticeState,
} from "../src/sync-progress-model";

const st = (over: Partial<NoticeState>): NoticeState => ({
  ...EMPTY_NOTICE_STATE,
  ...over,
});

describe("renderNoticeState", () => {
  it("nothing to show → null, which is the signal to CLOSE the box", () => {
    expect(renderNoticeState(EMPTY_NOTICE_STATE, 0)).toBeNull();
  });

  it("one live phase shows only its own lines", () => {
    expect(
      renderNoticeState(st({ commit: { state: "live", text: "Committing…" } }), 0),
    ).toBe("Committing…");
    expect(
      renderNoticeState(
        st({ drain: { state: "live", text: "Syncing with GitHub\nPushing 1 of 4" } }),
        0,
      ),
    ).toBe("Syncing with GitHub\nPushing 1 of 4");
  });

  it("🔑 both live → ONE box, commit above drain", () => {
    const text = renderNoticeState(
      st({
        commit: { state: "live", text: "Committing 100 of 250" },
        drain: { state: "live", text: "Syncing with GitHub\nPushing 12 of 40" },
      }),
      0,
    );
    expect(text).toBe(
      "Committing 100 of 250\nSyncing with GitHub\nPushing 12 of 40",
    );
  });

  it("🔑 the order is FIXED, not chronological — a drain that started first still sits below", () => {
    // Ordering by arrival would put the shuffling we left the stack to
    // escape back inside the box.
    const drainFirst = st({
      drain: { state: "live", text: "Syncing with GitHub" },
      commit: { state: "live", text: "Committing…" },
    });
    expect(renderNoticeState(drainFirst, 0)).toBe(
      "Committing…\nSyncing with GitHub",
    );
  });

  it("a settled section shows until its deadline, then stops", () => {
    const s = st({ commit: { state: "settled", text: "Nothing to commit", until: 1000 } });
    expect(renderNoticeState(s, 999)).toBe("Nothing to commit");
    expect(renderNoticeState(s, 1000)).toBeNull(); // the box closes
  });

  it("🔑 the owner's overlap: commit settles, drain starts before it expires", () => {
    // Both visible for a moment, then the commit line drops and the
    // box SHRINKS around the drain — the owner chose shrinking over a
    // ghost line holding the height.
    const s = st({
      commit: { state: "settled", text: "Nothing to commit", until: 1000 },
      drain: { state: "live", text: "Syncing with GitHub" },
    });
    expect(renderNoticeState(s, 500)).toBe(
      "Nothing to commit\nSyncing with GitHub",
    );
    expect(renderNoticeState(s, 1500)).toBe("Syncing with GitHub");
  });

  it("🔑 far apart: the first expires and the box closes before the second opens", () => {
    const afterCommit = st({
      commit: { state: "settled", text: "Nothing to commit", until: 1000 },
    });
    expect(renderNoticeState(afterCommit, 2000)).toBeNull();
    // A later drain opens a NEW box — two events in time, two boxes.
    const laterDrain = st({ drain: { state: "live", text: "Syncing with GitHub" } });
    expect(renderNoticeState(laterDrain, 2000)).toBe("Syncing with GitHub");
  });
});

describe("pending — a start line has to earn its place", () => {
  it("🔑 invisible before its moment, visible after", () => {
    const s = st({ commit: { state: "pending", text: "Committing…", showAt: 500 } });
    expect(renderNoticeState(s, 499)).toBeNull();
    expect(renderNoticeState(s, 500)).toBe("Committing…");
  });

  it("🔑 the owner's flicker: a phase that settles first never shows its start line", () => {
    // "Committing…" and "Syncing with GitHub" used to appear and be
    // replaced within milliseconds by "Nothing to commit" / "Sync
    // done". Four strings in a blink is flicker, not information.
    let s = st({ commit: { state: "pending", text: "Committing…", showAt: 500 } });
    // …the scan finds nothing at 120 ms, so the section settles:
    s = { ...s, commit: { state: "settled", text: "Nothing to commit", until: 1120 } };
    expect(renderNoticeState(s, 120)).toBe("Nothing to commit");
    // "Committing…" was never rendered at any point in time.
    expect(renderNoticeState(s, 0)).toBe("Nothing to commit");
    expect(renderNoticeState(s, 600)).toBe("Nothing to commit");
  });

  it("slow work still gets its start line, as before", () => {
    const s = st({ commit: { state: "pending", text: "Committing…", showAt: 500 } });
    expect(renderNoticeState(s, 3000)).toBe("Committing…");
  });

  it("a pending section alone keeps the box CLOSED until its moment", () => {
    const s = st({ drain: { state: "pending", text: "Syncing with GitHub", showAt: 500 } });
    expect(renderNoticeState(s, 100)).toBeNull(); // nothing on screen yet
  });

  it("one phase pending, the other already settled → only the settled one shows", () => {
    const s = st({
      commit: { state: "settled", text: "Nothing to commit", until: 1000 },
      drain: { state: "pending", text: "Syncing with GitHub", showAt: 900 },
    });
    expect(renderNoticeState(s, 500)).toBe("Nothing to commit");
    expect(renderNoticeState(s, 950)).toBe(
      "Nothing to commit\nSyncing with GitHub",
    );
  });
});

describe("nextNoticeDeadline", () => {
  it("null when nothing is pending — a LIVE section never expires on its own", () => {
    expect(nextNoticeDeadline(EMPTY_NOTICE_STATE, 0)).toBeNull();
    expect(
      nextNoticeDeadline(st({ drain: { state: "live", text: "x" } }), 0),
    ).toBeNull();
  });

  it("a PENDING section's appearance is a deadline too — one timer, both kinds", () => {
    const s = st({
      commit: { state: "pending", text: "Committing…", showAt: 500 },
      drain: { state: "settled", text: "Sync done", until: 1200 },
    });
    expect(nextNoticeDeadline(s, 0)).toBe(500); // the appearance comes first
    expect(nextNoticeDeadline(s, 600)).toBe(1200);
  });

  it("the EARLIEST future deadline, so one timer serves both sections", () => {
    const s = st({
      commit: { state: "settled", text: "a", until: 1500 },
      drain: { state: "settled", text: "b", until: 900 },
    });
    expect(nextNoticeDeadline(s, 0)).toBe(900);
    expect(nextNoticeDeadline(s, 1000)).toBe(1500); // 900 already passed
    expect(nextNoticeDeadline(s, 2000)).toBeNull();
  });
});
