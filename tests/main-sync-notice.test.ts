// @vitest-environment happy-dom
//
// §II.16 — the sync notice's LIFECYCLE, which is the half that keeps
// biting in the field while the text model stays green.
//
// Two bugs reached the owner's device here, and both were about a timer
// nobody watched rather than about what the notice said:
//
//   2026-09-26 (a) a 0.5 s sync left its 2 s progress timer pending; it
//       fired over an already-finished sync and latched
//       `syncProgressActive` true FOREVER, so every later sync had its
//       "Nothing to commit" instantly overwritten;
//   2026-09-26 (b) the drain status carried the PREVIOUS run's counters,
//       so what got painted was a real "Uploading 1 of 1" — from a drain
//       twenty seconds in the past.
//
// The same Object.create(prototype) harness as main-pre-sync-gate: no
// onload, just the methods under test.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { recordedNotices, clearRecordedNotices } from "../mock-obsidian";

interface NoticeHandle {
  sync2Manager: unknown;
  inFullSync: boolean;
  syncCancelRequested: boolean;
  syncProgressActive: boolean;
  syncProgressTimer: number | null;
  syncNotice: unknown;
  syncNoticeHideTimer: number | null;
  armSyncProgressNotice(): void;
  finishSyncNotice(text: string): void;
  clearSyncNotice(): void;
  reportCommitOutcome(text: string): void;
  repaintSyncProgressNotice(): void;
}

// A manager stub whose progress snapshot the test controls — that is
// exactly the value bug (b) was reading from.
function makePlugin(progress: unknown = null): NoticeHandle {
  const p = Object.create(GitHubSyncPlugin.prototype) as unknown as NoticeHandle;
  p.sync2Manager = { getDrainStatus: () => ({ progress }) };
  p.inFullSync = false;
  p.syncCancelRequested = false;
  p.syncProgressActive = false;
  p.syncProgressTimer = null;
  p.syncNotice = null;
  p.syncNoticeHideTimer = null;
  return p;
}

describe("sync notice lifecycle (§II.16)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRecordedNotices();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("🔑 a sync that finishes BEFORE the 2 s mark leaves no armed timer behind", () => {
    // Bug (a). The symptom was not on this sync but on every one after
    // it: the late timer latched a flag that never cleared.
    const p = makePlugin({
      pullDone: 0,
      pullTotal: 0,
      pushDone: 1,
      pushTotal: 1,
      conflicts: 0,
    });
    p.armSyncProgressNotice();
    expect(p.syncProgressTimer).not.toBeNull();

    p.finishSyncNotice("Sync done"); // 0.5 s later, in real life
    expect(p.syncProgressTimer).toBeNull();

    clearRecordedNotices();
    vi.advanceTimersByTime(5000); // long past the 2 s mark
    // Nothing woke up and painted over the finished sync.
    expect(p.syncProgressActive).toBe(false);
    expect(recordedNotices.map((n) => n.message)).not.toContain(
      "Syncing with GitHub\nUploading 1 of 1",
    );
  });

  it("🔑 a stale progress flag cannot survive into the next sync's commit line", () => {
    // The second half of bug (a): with the flag latched, every drain
    // event repainted, and "Nothing to commit" never survived to be read.
    const p = makePlugin({
      pullDone: 0,
      pullTotal: 0,
      pushDone: 1,
      pushTotal: 1,
      conflicts: 0,
    });
    p.armSyncProgressNotice();
    p.finishSyncNotice("Sync done");

    // Next sync: the commit pass speaks first.
    p.inFullSync = true;
    p.reportCommitOutcome("Nothing to commit");
    clearRecordedNotices();
    p.repaintSyncProgressNotice(); // a drain event arrives
    // …and must NOT overwrite it: the 2 s mark has not been reached.
    expect(recordedNotices).toEqual([]);
  });

  it("the progress line only paints once the delay has actually elapsed", () => {
    const p = makePlugin({
      pullDone: 2,
      pullTotal: 10,
      pushDone: 0,
      pushTotal: 0,
      conflicts: 0,
    });
    p.inFullSync = true;
    p.reportCommitOutcome("Nothing to commit");
    p.armSyncProgressNotice();

    clearRecordedNotices();
    vi.advanceTimersByTime(1999);
    expect(recordedNotices).toEqual([]); // still the commit line

    vi.advanceTimersByTime(1);
    expect(recordedNotices.map((n) => n.message)).toEqual([
      "Syncing with GitHub\nDownloading 2 of 10",
    ]);
  });

  it("clearSyncNotice also disarms — an error path must not leave a timer either", () => {
    const p = makePlugin();
    p.armSyncProgressNotice();
    p.clearSyncNotice();
    expect(p.syncProgressTimer).toBeNull();
    expect(p.syncProgressActive).toBe(false);
  });

  it("a commit with NO sync behind it stays a brief toast — nothing is coming to replace it", () => {
    const p = makePlugin();
    p.inFullSync = false; // the [Commit] button, not [Sync]
    p.reportCommitOutcome("Commit 3 files");
    // It did not take over the shared notice, so nothing has to take it
    // down later.
    expect(p.syncNotice).toBeNull();
    expect(recordedNotices.map((n) => n.message)).toEqual([
      "Commit 3 files",
    ]);
  });
});
