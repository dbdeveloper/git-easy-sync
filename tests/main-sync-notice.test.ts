// @vitest-environment happy-dom
//
// §II.16 — the sync notice's LIFECYCLE, which is the half that keeps
// biting in the field while the text model stays green.
//
// Three bugs reached the owner's device here, and none was about what
// the notice SAID:
//
//   2026-09-26 (a) a 0.5 s sync left its 2 s progress timer pending; it
//       fired over an already-finished sync and latched
//       `syncProgressActive` true FOREVER, so every later sync had its
//       "Nothing to commit" instantly overwritten;
//   2026-09-26 (b) the drain status carried the PREVIOUS run's counters,
//       so what got painted was a real "Uploading 1 of 1" — from a drain
//       twenty seconds in the past;
//   2026-10-03 (c) the 2 s timer painted the DRAIN's text five seconds
//       inside a 7.2 s commit pass: "Committing…" → "Syncing with
//       GitHub" → "Committing 100 of 250".
//
// ⚠️ (c) IS WHY THIS FILE WAS REWRITTEN. Its real cause was not the
// timer but the model: every handler called a "paint this text" method,
// so the last writer won — and commit and drain are NOT mutually
// exclusive (the manager guards drain-vs-drain and commit-vs-commit,
// nothing guards one against the other, by design). Two phases sharing
// one brush will fight whenever they overlap.
//
// Now each phase owns a SLOT and one renderer composes them, so the
// TEXT decisions live in `sync-progress-sections.test.ts` (pure, no
// DOM). What remains here is exactly what that cannot cover: the
// timers, the gate, and the guarantee that the box comes down.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { recordedNotices, clearRecordedNotices } from "../mock-obsidian";
import { EMPTY_NOTICE_STATE, type NoticeState } from "../src/sync-progress-model";

interface NoticeHandle {
  sync2Manager: unknown;
  inFullSync: boolean;
  syncCancelRequested: boolean;
  syncProgressActive: boolean;
  syncProgressTimer: number | null;
  syncNotice: unknown;
  syncNoticeHideTimer: number | null;
  noticeState: NoticeState;
  noticeDeadlineTimer: number | null;
  armSyncProgressNotice(): void;
  clearSyncNotice(): void;
  repaintSyncProgressNotice(): void;
  reportCommitProgress(done: number, total: number): void;
  setCommitSection(s: NoticeState["commit"]): void;
  setDrainSection(s: NoticeState["drain"]): void;
  settleDrainSection(text: string): void;
  handleDrainIdle(): void;
}

function makePlugin(progress: unknown = null): NoticeHandle {
  const p = Object.create(GitHubSyncPlugin.prototype) as unknown as NoticeHandle;
  p.sync2Manager = { getDrainStatus: () => ({ progress }) };
  p.inFullSync = false;
  p.syncCancelRequested = false;
  p.syncProgressActive = false;
  p.syncProgressTimer = null;
  p.syncNotice = null;
  p.syncNoticeHideTimer = null;
  p.noticeState = EMPTY_NOTICE_STATE;
  p.noticeDeadlineTimer = null;
  return p;
}

const lastMessage = (): string =>
  recordedNotices[recordedNotices.length - 1]?.message ?? "";

describe("sync notice lifecycle (§II.16)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRecordedNotices();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── the gate ──────────────────────────────────────────────────────

  it("the progress gate opens only after the delay", () => {
    const p = makePlugin();
    p.armSyncProgressNotice();
    expect(p.syncProgressActive).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(p.syncProgressActive).toBe(false);
    vi.advanceTimersByTime(2);
    expect(p.syncProgressActive).toBe(true);
  });

  it("🔑 (c) opening the gate cannot move another phase's text", () => {
    // The 2026-10-03 report, as a property rather than a scenario: the
    // commit's slot holds its line, the gate opens mid-commit, and the
    // line is still there. Under the old model the timer painted the
    // drain's header right here.
    const p = makePlugin();
    p.setCommitSection({ state: "live", text: "Committing…" });
    p.armSyncProgressNotice();
    vi.advanceTimersByTime(2500);
    expect(p.syncProgressActive).toBe(true);
    expect(lastMessage()).toBe("Committing…");
  });

  it("the drain's counters appear only past the gate, and only in ITS slot", () => {
    const p = makePlugin({
      pullDone: 2,
      pullTotal: 10,
      pushDone: 0,
      pushTotal: 0,
      conflicts: 0,
      path: "a.md",
    });
    p.setDrainSection({ state: "live", text: "Syncing with GitHub" });
    p.repaintSyncProgressNotice(); // gate shut — ignored
    expect(lastMessage()).toBe("Syncing with GitHub");
    p.syncProgressActive = true;
    p.repaintSyncProgressNotice();
    expect(lastMessage()).toBe("Syncing with GitHub\nDownloading 2 of 10");
  });

  it("🔑 (b) a drain that reported NOTHING cannot inherit counters", () => {
    const p = makePlugin(null); // the manager's snapshot was cleared
    p.setDrainSection({ state: "live", text: "Syncing with GitHub" });
    p.syncProgressActive = true;
    p.repaintSyncProgressNotice();
    expect(lastMessage()).toBe("Syncing with GitHub");
  });

  it("🔑 the commit counter waits for the same gate", () => {
    const p = makePlugin();
    p.setCommitSection({ state: "live", text: "Committing…" });
    p.syncProgressActive = false;
    p.reportCommitProgress(100, 250);
    expect(lastMessage()).toBe("Committing…");
    p.syncProgressActive = true;
    p.reportCommitProgress(100, 250);
    expect(lastMessage()).toBe("Committing 100 of 250");
    // The LAST batch stays silent: the settled line lands in the same
    // tick and would overwrite it anyway.
    p.reportCommitProgress(250, 250);
    expect(lastMessage()).toBe("Committing 100 of 250");
  });

  it("🔑 a commit cannot show the PREVIOUS drain's numbers (owner's check)", () => {
    // Asked after the drain's own version of this had been fixed once
    // in the wrong place. Two independent reasons it cannot: the
    // commit's numbers are passed in live per batch, and the drain's
    // snapshot can only ever reach the DRAIN's slot.
    const p = makePlugin({
      pullDone: 0,
      pullTotal: 0,
      pushDone: 258,
      pushTotal: 258,
      conflicts: 0,
      path: "x.md",
    });
    p.setCommitSection({ state: "live", text: "Committing…" });
    p.syncProgressActive = true;
    p.reportCommitProgress(3, 7);
    expect(lastMessage()).toBe("Committing 3 of 7");
    expect(recordedNotices.map((n) => n.message).join(" | ")).not.toContain(
      "258",
    );
  });

  // ── the box comes down ────────────────────────────────────────────

  it("🔑 a settled section expires and the box CLOSES by itself", () => {
    const p = makePlugin();
    p.settleDrainSection("Sync done");
    expect(lastMessage()).toBe("Sync done");
    expect(p.syncNotice).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(p.syncNotice).toBeNull(); // nothing visible → cleared
  });

  it("🔑 the owner's overlap: the commit line drops, the drain's survives", () => {
    // Both visible, then the earlier deadline passes and the box
    // SHRINKS around what is left — the owner chose shrinking over a
    // ghost line holding the height.
    const p = makePlugin();
    p.setCommitSection({
      state: "settled",
      text: "Nothing to commit",
      until: Date.now() + 1000,
    });
    p.setDrainSection({ state: "live", text: "Syncing with GitHub" });
    expect(lastMessage()).toBe("Nothing to commit\nSyncing with GitHub");
    vi.advanceTimersByTime(1500);
    expect(lastMessage()).toBe("Syncing with GitHub");
    expect(p.syncNotice).not.toBeNull(); // still open: a live section
  });

  it("🔑 settling the drain must NOT take a live commit down with it", () => {
    // The reason the drain's idle path settles instead of clearing: a
    // standalone commit can be running alongside, and clearing the box
    // would erase a phase that is still working.
    const p = makePlugin();
    p.setCommitSection({ state: "live", text: "Committing 100 of 250" });
    p.settleDrainSection("Sync done");
    expect(lastMessage()).toBe("Committing 100 of 250\nSync done");
    vi.advanceTimersByTime(1500);
    expect(lastMessage()).toBe("Committing 100 of 250");
    expect(p.syncNotice).not.toBeNull();
  });

  it("🔑 a drain reaching idle must not erase a commit that is still running", () => {
    // The WIRING, not the helper. A probe that replaced the settle in
    // this branch with a box-wide clear left all twelve tests green —
    // every one of them called `settleDrainSection` directly, so the
    // branch that decides between settling and clearing was unchecked.
    const p = makePlugin();
    p.inFullSync = false; // a background drain: no summary is coming
    p.setCommitSection({ state: "live", text: "Committing 100 of 250" });
    p.setDrainSection({ state: "live", text: "Syncing with GitHub" });

    p.handleDrainIdle();

    expect(lastMessage()).toBe("Committing 100 of 250\nSync done");
    expect(p.syncNotice).not.toBeNull();
  });

  it("a cancel is reported from idle, because a background drain has no summary", () => {
    const p = makePlugin();
    p.syncCancelRequested = true;
    p.handleDrainIdle();
    expect(lastMessage()).toBe("Sync canceled");
    expect(p.syncCancelRequested).toBe(false);
  });

  it("(a) settling always disarms — no timer survives a finished phase", () => {
    const p = makePlugin();
    p.armSyncProgressNotice();
    p.settleDrainSection("Sync done");
    expect(p.syncProgressTimer).toBeNull();
    expect(p.syncProgressActive).toBe(false);
  });

  it("clearSyncNotice wipes the sections too — an error path leaves nothing behind", () => {
    const p = makePlugin();
    p.setCommitSection({ state: "live", text: "Committing…" });
    p.armSyncProgressNotice();
    p.clearSyncNotice();
    expect(p.syncNotice).toBeNull();
    expect(p.noticeState).toEqual(EMPTY_NOTICE_STATE);
    expect(p.noticeDeadlineTimer).toBeNull();
    expect(p.syncProgressTimer).toBeNull();
    expect(p.syncProgressActive).toBe(false);
  });

  it("one box throughout: the Notice object is reused, not replaced", () => {
    const p = makePlugin();
    p.setCommitSection({ state: "live", text: "Committing…" });
    const box = p.syncNotice;
    p.setDrainSection({ state: "live", text: "Syncing with GitHub" });
    expect(p.syncNotice).toBe(box);
  });
});
