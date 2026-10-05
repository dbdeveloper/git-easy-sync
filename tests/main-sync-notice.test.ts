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
//       so what got painted was a real "Pushing 1 of 1" — from a drain
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
  reportCommitStarted(fullScan: boolean): void;
  reportCommitPlan(
    plan: { checks: number; checkBytes: number; unhashedAdds: number; deletions: number },
    total: number,
  ): void;
  reportCommitChecked(done: number, total: number): void;
  commitStats: unknown;
  commitCounterOn: boolean;
  reportCommitDone(count: number): void;
  reportNothingToCommit(queued: boolean): void;
  setCommitSection(s: NoticeState["commit"]): void;
  setDrainSection(s: NoticeState["drain"]): void;
  settleDrainSection(text: string): void;
  settleSyncSummary(n: {
    sent: number;
    received: number;
    conflicts: number;
    pluginsUpdated?: number;
    pluginsRemoved?: number;
  }): void;
  handleDrainIdle(): void;
  handleDrainStatus(s: { state: string }): void;
  lastDrainState: string | null;
  applyRibbonSyncingState(on: boolean): void;
}

// `indexFiles` = what app.vault.getFiles() returns (visible vault files
// only). Default: a vault with plenty of notes.
function makePlugin(progress: unknown = null, indexFiles = 100): NoticeHandle {
  const p = Object.create(GitHubSyncPlugin.prototype) as unknown as NoticeHandle;
  (p as unknown as { app: unknown }).app = {
    vault: { getFiles: () => Array.from({ length: indexFiles }, (_, i) => ({ path: `n${i}.md` })) },
  };
  p.sync2Manager = { getDrainStatus: () => ({ progress }) };
  p.inFullSync = false;
  p.syncCancelRequested = false;
  p.syncProgressActive = false;
  p.syncProgressTimer = null;
  p.syncNotice = null;
  p.syncNoticeHideTimer = null;
  p.noticeState = EMPTY_NOTICE_STATE;
  p.noticeDeadlineTimer = null;
  p.lastDrainState = null;
  p.applyRibbonSyncingState = () => {};
  p.commitStats = undefined;
  p.commitCounterOn = false;
  return p;
}

const PHASE_START_DELAY = 700;

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
    expect(lastMessage()).toBe("Syncing with GitHub\nPulling 2 of 10");
  });

  it("🔑 (b) a drain that reported NOTHING cannot inherit counters", () => {
    const p = makePlugin(null); // the manager's snapshot was cleared
    p.setDrainSection({ state: "live", text: "Syncing with GitHub" });
    p.syncProgressActive = true;
    p.repaintSyncProgressNotice();
    expect(lastMessage()).toBe("Syncing with GitHub");
  });

  // ── COMMIT-PASS-PERF §3.1: the commit's lines by FORECAST, no timers ──

  const statsWith = (o: {
    any?: boolean;
    dotMs?: number | null;
    forecast?: number | null;
  }) => ({
    hasAny: () => o.any ?? true,
    dotMs: () => (o.dotMs === undefined ? 100 : o.dotMs),
    forecastCheck: () => (o.forecast === undefined ? 100 : o.forecast),
  });
  const plan = (checks: number, deletions = 0) => ({
    checks,
    checkBytes: checks * 1000,
    unhashedAdds: 0,
    deletions,
  });

  it("🔑 no statistics (first commit after RESET): \"Checking all files…\" AT ONCE; a SMALL commit keeps it to the end", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(true);
    expect(lastMessage()).toBe("Checking all files…"); // no timer, no delay
    // 264 files, ~0.26 MB: neither > 500 files nor > 100 MB.
    p.reportCommitPlan(plan(263, 1), 264);
    p.reportCommitChecked(120, 264);
    expect(lastMessage()).toBe("Checking all files…");
  });

  // Owner, 2026-10-05: a first sync into an (almost) empty vault would
  // flash "Checking all files…" for a few milliseconds — unreadable, so
  // only a blink. Fewer than 10 visible files (getFiles: notes, no
  // dot-space) → the vault is "practically empty", the data will flow
  // FROM the server, and the line is not shown. The plan-stage counter
  // rule (> 500 files or > 100 MB, dot-space included) still applies.
  it("🔑 no statistics, fewer than 10 visible files → NO \"Checking all files…\"", () => {
    const p = makePlugin(null, 9);
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(true);
    expect(recordedNotices).toHaveLength(0);
    p.reportCommitPlan(plan(18), 18);
    p.reportCommitChecked(10, 18);
    expect(recordedNotices).toHaveLength(0);
  });

  it("no statistics, exactly 10 visible files → the line is shown as before", () => {
    const p = makePlugin(null, 10);
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(true);
    expect(lastMessage()).toBe("Checking all files…");
  });

  it("no statistics, an almost empty vault with a HUGE hidden part → the counter still appears", () => {
    const p = makePlugin(null, 1);
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(true);
    p.reportCommitPlan(plan(600), 600);
    expect(lastMessage()).toBe("Checking 0 of 600 files");
  });

  it("🔑 no statistics + MORE than 500 files → the counter", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(true);
    p.reportCommitPlan(plan(525, 1), 526);
    expect(lastMessage()).toBe("Checking 0 of 526 files");
    p.reportCommitChecked(120, 526);
    expect(lastMessage()).toBe("Checking 120 of 526 files");
  });

  it("no statistics + MORE than 100 MB (even under 500 files) → the counter", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(true);
    p.reportCommitPlan(
      { checks: 10, checkBytes: 100 * 1024 * 1024 + 1, unhashedAdds: 0, deletions: 0 },
      10,
    );
    expect(lastMessage()).toBe("Checking 0 of 10 files");
  });

  it("no statistics: exactly 500 files / exactly 100 MB is NOT over the line", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(true);
    p.reportCommitPlan(
      { checks: 500, checkBytes: 100 * 1024 * 1024, unhashedAdds: 0, deletions: 0 },
      500,
    );
    expect(lastMessage()).toBe("Checking all files…");
  });

  it("statistics, fast dot-space and a fast check: NO line at all until the result", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ dotMs: 300, forecast: 800 });
    p.reportCommitStarted(true);
    p.reportCommitPlan(plan(10), 10);
    p.reportCommitChecked(5, 10);
    expect(recordedNotices).toHaveLength(0);
  });

  it("dot-space forecast over the threshold: \"Committing…\" at the start", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ dotMs: 2500, forecast: 500 });
    p.reportCommitStarted(true);
    expect(lastMessage()).toBe("Committing…");
    // A fast check after it adds no counter.
    p.reportCommitPlan(plan(3), 3);
    expect(lastMessage()).toBe("Committing…");
  });

  it("check forecast over the threshold: the counter from the START of stage 2", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ dotMs: 100, forecast: 3400 });
    p.reportCommitStarted(true);
    expect(recordedNotices).toHaveLength(0);
    p.reportCommitPlan(plan(263), 263);
    expect(lastMessage()).toBe("Checking 0 of 263 files");
    p.reportCommitChecked(263, 263);
    expect(lastMessage()).toBe("Checking 263 of 263 files");
  });

  it("🔑 the threshold is 1.5 s (owner, 2026-10-05): 1.6 s shows both lines, exactly 1.5 s shows none", () => {
    // Lowered from 2 s: on the owner's vault the forecast came out ~1.7× low.
    const p = makePlugin();
    p.commitStats = statsWith({ dotMs: 1600, forecast: 1600 });
    p.reportCommitStarted(true);
    expect(lastMessage()).toBe("Committing…");
    p.reportCommitPlan(plan(40), 40);
    expect(lastMessage()).toBe("Checking 0 of 40 files");

    const q = makePlugin();
    clearRecordedNotices();
    q.commitStats = statsWith({ dotMs: 1500, forecast: 1500 });
    q.reportCommitStarted(true);
    q.reportCommitPlan(plan(40), 40);
    expect(recordedNotices).toHaveLength(0);
  });

  it("an action never measured yet (forecast unknown) shows the counter — unknown is not fast", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ dotMs: 100, forecast: null });
    p.reportCommitStarted(true);
    p.reportCommitPlan(plan(5), 5);
    expect(lastMessage()).toBe("Checking 0 of 5 files");
  });

  it("a single-file commit opens nothing, even without statistics", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ any: false, forecast: null });
    p.reportCommitStarted(false);
    expect(recordedNotices).toHaveLength(0);
  });

  it("an empty plan (nothing to check, nothing deleted) adds no counter", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ forecast: 9999 });
    p.reportCommitStarted(true);
    p.reportCommitPlan(plan(0), 0);
    expect(recordedNotices).toHaveLength(0);
  });

  it("singular: \"Checking 0 of 1 file\"", () => {
    const p = makePlugin();
    p.commitStats = statsWith({ forecast: null });
    p.reportCommitStarted(true);
    p.reportCommitPlan(plan(1), 1);
    expect(lastMessage()).toBe("Checking 0 of 1 file");
  });

  // ── the 500 ms start gate ─────────────────────────────────────────

  it("🔑 a fast no-op sync shows NO start lines — only the results", () => {
    // The owner's complaint, as the sequence they actually saw:
    // "Committing…" and "Syncing with GitHub" appearing and being
    // replaced within milliseconds by "Nothing to commit" / "Sync
    // done". Four strings in a blink.
    const p = makePlugin();
    const now = Date.now();
    p.setCommitSection({
      state: "pending",
      text: "Committing…",
      showAt: now + 500,
    });
    expect(p.syncNotice).toBeNull(); // nothing on screen yet
    // The scan finds nothing 120 ms later.
    vi.advanceTimersByTime(120);
    p.setCommitSection({
      state: "settled",
      text: "Nothing to commit",
      until: Date.now() + 1000,
    });
    // Same for the drain.
    p.setDrainSection({
      state: "pending",
      text: "Syncing with GitHub",
      showAt: Date.now() + 500,
    });
    vi.advanceTimersByTime(100);
    p.settleDrainSection("Sync done");

    const all = recordedNotices.map((n) => n.message).join(" | ");
    expect(all).not.toContain("Committing…");
    expect(all).not.toContain("Syncing with GitHub");
    expect(lastMessage()).toBe("Nothing to commit\nSync done");
  });

  it("…but slow work still gets its start line", () => {
    const p = makePlugin();
    p.setCommitSection({
      state: "pending",
      text: "Committing…",
      showAt: Date.now() + 500,
    });
    vi.advanceTimersByTime(600);
    expect(lastMessage()).toBe("Committing…");
  });

  it("a drain inside the start delay that ALREADY has counters shows them", () => {
    // Counters are proof the work is real, so the line is earned even
    // before the 500 ms is up — the repaint upgrades pending → live.
    const p = makePlugin({
      pullDone: 2,
      pullTotal: 10,
      pushDone: 0,
      pushTotal: 0,
      conflicts: 0,
      path: "a.md",
    });
    p.setDrainSection({
      state: "pending",
      text: "Syncing with GitHub",
      showAt: Date.now() + 500,
    });
    p.syncProgressActive = true;
    p.repaintSyncProgressNotice();
    expect(lastMessage()).toBe("Syncing with GitHub\nPulling 2 of 10");
  });

  it("a SETTLED drain is never resurrected by a repaint", () => {
    const p = makePlugin({
      pullDone: 9,
      pullTotal: 9,
      pushDone: 0,
      pushTotal: 0,
      conflicts: 0,
      path: "a.md",
    });
    p.settleDrainSection("Sync done");
    p.syncProgressActive = true;
    p.repaintSyncProgressNotice();
    expect(lastMessage()).toBe("Sync done");
  });

  it("🔑 a running drain repeats its status for every file — the slot opens ONCE", () => {
    // Field report 2026-10-03: "Syncing with GitHub" jumped around.
    //
    // ⚠️ `onProgress` emits `{progress}` WITHOUT touching `state`, so
    // the merged status is still "running" and the listener fires again
    // for every single file. Re-opening the slot on each one pushed
    // `showAt` forever forward: the section went invisible, the render
    // yielded null, THE BOX WAS DESTROYED, and the next repaint built a
    // new one. Not one box changing text — dozens created and thrown
    // away.
    const p = makePlugin();
    p.handleDrainStatus({ state: "running" });
    const first = p.noticeState.drain;
    expect(first.state).toBe("pending");

    // …twenty more progress emits, all still "running", WITH TIME
    // PASSING between them. ⚠️ The clock matters: without it every
    // re-arm computes the same `showAt` and an unguarded listener looks
    // identical to a guarded one. A probe caught exactly that — the
    // first version of this test passed with the guard deleted.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      p.handleDrainStatus({ state: "running" });
    }

    expect(
      p.noticeState.drain,
      "the slot must not be re-armed by a repeat of the same state",
    ).toEqual(first);

    // And the consequence that was visible: by now the section is due,
    // so the box exists. An unguarded listener would have pushed
    // `showAt` a second into the future on the last tick instead.
    vi.advanceTimersByTime(PHASE_START_DELAY);
    expect(lastMessage()).toBe("Syncing with GitHub");
  });

  it("…and the slot opens again for a LATER, separate drain", () => {
    // The guard is about repeats, not about suppressing real restarts.
    const p = makePlugin();
    p.handleDrainStatus({ state: "running" });
    p.handleDrainStatus({ state: "idle" });
    vi.advanceTimersByTime(2000); // the box closes
    p.handleDrainStatus({ state: "running" });
    expect(p.noticeState.drain.state).toBe("pending");
  });

  it("🔑 idle is repeated too — the last line must not be kept alive forever", () => {
    const p = makePlugin();
    p.handleDrainStatus({ state: "running" });
    p.handleDrainStatus({ state: "idle" });
    const settled = p.noticeState.drain;
    expect(settled.state).toBe("settled");
    // Further idle emits must not refresh the deadline.
    vi.advanceTimersByTime(300);
    p.handleDrainStatus({ state: "idle" });
    expect(p.noticeState.drain).toEqual(settled);
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

  it("🔑 the summary WITH numbers stays 2 s; the bare \"Sync done\" keeps its 1 s (owner, 2026-10-05)", () => {
    const p = makePlugin();
    p.settleSyncSummary({ sent: 1, received: 454, conflicts: 0 });
    expect(lastMessage()).toBe("Sync done — 1 sent, 454 received");
    vi.advanceTimersByTime(1900);
    expect(p.syncNotice).not.toBeNull(); // still readable
    vi.advanceTimersByTime(200);
    expect(p.syncNotice).toBeNull();

    const q = makePlugin();
    q.settleSyncSummary({ sent: 0, received: 0, conflicts: 0 });
    expect(lastMessage()).toBe("Sync done");
    vi.advanceTimersByTime(1100);
    expect(q.syncNotice).toBeNull(); // unchanged: one second
  });

  it("🔑 a summary with a plugin line stays 2.5 s (owner, 2026-10-05)", () => {
    const p = makePlugin();
    p.settleSyncSummary({ sent: 1, received: 453, conflicts: 0, pluginsUpdated: 9, pluginsRemoved: 0 });
    expect(lastMessage()).toBe("Sync done — 1 sent, 453 received\n9 plugins updated");
    vi.advanceTimersByTime(2400);
    expect(p.syncNotice).not.toBeNull();
    vi.advanceTimersByTime(200);
    expect(p.syncNotice).toBeNull();
  });

  it("a conflicts-only summary is a summary with a number too — 2 s", () => {
    const p = makePlugin();
    p.settleSyncSummary({ sent: 0, received: 0, conflicts: 2 });
    vi.advanceTimersByTime(1900);
    expect(p.syncNotice).not.toBeNull();
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

  // COMMIT-PASS-PERF step 4 (owner, 2026-10-04): inside a sync the
  // commit's "Committed N files" is NOT shown — the sync's own summary
  // ("Sync done — sent …") carries the number, and the extra line only
  // blinked before the drain's. A standalone [Commit] keeps it.
  it("🔑 step 4: a commit INSIDE a sync shows no \"Committed N files\" line", () => {
    const p = makePlugin();
    p.inFullSync = true;
    p.reportCommitDone(5);
    const all = recordedNotices.map((n) => n.message).join(" | ");
    expect(all).not.toContain("Committed");
    expect(p.noticeState.commit.state).toBe("none");
  });

  it("step 4: …and it takes down a \"Committing…\" line the pass had opened", () => {
    const p = makePlugin();
    p.inFullSync = true;
    p.setCommitSection({ state: "live", text: "Committing…" });
    p.reportCommitDone(5);
    expect(p.noticeState.commit.state).toBe("none");
  });

  it("step 4: a STANDALONE commit still shows \"Committed N files\" for a moment", () => {
    const p = makePlugin();
    p.inFullSync = false;
    p.reportCommitDone(5);
    expect(lastMessage()).toContain("Committed 5 files");
    expect(p.noticeState.commit.state).toBe("settled");
  });

  // "Nothing to commit" speaks for THIS commit call (owner, 2026-10-05).
  describe("\"Nothing to commit\": per call, not per setting", () => {
    it("standalone commit, queue empty → says it", () => {
      const p = makePlugin();
      p.reportNothingToCommit(false);
      expect(lastMessage()).toBe("Nothing to commit");
    });

    it("🔑 standalone commit WITH older batches queued → still says it (only about this call)", () => {
      const p = makePlugin();
      p.inFullSync = false;
      p.reportNothingToCommit(true);
      expect(lastMessage()).toBe("Nothing to commit");
    });

    it("inside a sync, queue empty → says it (followed by the sync's own result)", () => {
      const p = makePlugin();
      p.inFullSync = true;
      p.reportNothingToCommit(false);
      expect(lastMessage()).toBe("Nothing to commit");
    });

    it("🔑 inside a sync WITH batches queued → silent: the drain is about to send them", () => {
      const p = makePlugin();
      p.inFullSync = true;
      p.setCommitSection({ state: "live", text: "Committing…" });
      p.reportNothingToCommit(true);
      const all = recordedNotices.map((n) => n.message).join(" | ");
      expect(all).not.toContain("Nothing to commit");
      expect(p.noticeState.commit.state).toBe("none");
    });
  });
});
