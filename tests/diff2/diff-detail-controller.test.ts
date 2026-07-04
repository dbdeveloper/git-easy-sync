// @vitest-environment happy-dom
//
// S2 of the panel/editor split (docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12).
//
// Drives the EXTRACTED detail engine through its host seam — the coverage the old
// diff-edit-view-v2-glue.test.ts couldn't reach ("private ItemView glue with no mount
// harness"). DiffDetailController is now a plain class, and getView() (added for the
// host Mod+F hook) doubles as a test handle, so we can:
//   - mount(connectedDiv, entry) → edit via getView().dispatch → exit(entry)
//   - assert WHICH host callback fired (onCommitExit vs onLeaveDetail) + the disk effect.
// This guards the panel-host path against a cancel-path inversion or an S3–S6 regression.
//
// Scope (advisor caveat): only the modal-FREE paths — fresh mount, net>0 commit, net-0
// discard, no-session leave. The Resume/Empty/Alt modals need real `app` wiring and aren't
// worth faking here; their decisions are pinned by diff-edit-view-v2-glue.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { undo } from "@codemirror/commands";
import { applyResolve } from "../../src/diff2/diff-resolve";
import type { App } from "obsidian";
import type { Vault } from "obsidian";
import { Vault as MockVault } from "../../mock-obsidian";
import {
  DiffDetailController,
  type DiffDetailHost,
} from "../../src/diff2/diff-detail-controller";
import type { DiffEditViewDeps } from "../../src/diff2/diff-edit-view";
import {
  autosaveIdForEntry,
  type ConflictEntry,
} from "../../src/diff2/synthetic-detector";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { DiffPaneOwner } from "../../src/diff2/diff-pane-owner";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

// Obsidian patches HTMLElement with createDiv/createEl at runtime; happy-dom has neither.
// The controller's mount() uses them for the toolbar/body scaffold (the owner itself mounts
// via document.createElement, so this minimal subset — cls + text — is enough). Guarded so it
// never double-installs and stays scoped to this file's environment.
type DomInfo = string | { cls?: string | string[]; text?: string; attr?: Record<string, string> };
function applyInfo(el: HTMLElement, info?: DomInfo): HTMLElement {
  if (!info) return el;
  if (typeof info === "string") {
    el.className = info;
    return el;
  }
  if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
  if (info.text != null) el.textContent = info.text;
  if (info.attr) for (const k of Object.keys(info.attr)) el.setAttribute(k, info.attr[k]);
  return el;
}
const proto = HTMLElement.prototype as unknown as {
  createEl?: (tag: string, info?: DomInfo) => HTMLElement;
  createDiv?: (info?: DomInfo) => HTMLElement;
};
if (!proto.createEl) {
  proto.createEl = function (this: HTMLElement, tag: string, info?: DomInfo) {
    const el = applyInfo(document.createElement(tag), info);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, info?: DomInfo) {
    return (this as unknown as { createEl: (t: string, i?: DomInfo) => HTMLElement }).createEl("div", info);
  };
}

function fixture() {
  const root = path.join(os.tmpdir(), `ctrl-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

function entryFor(basePath: string, siblingPath: string): ConflictEntry {
  return { basePath, siblingPath, deviceLabel: "Phone", isoTimestamp: "2026-06-03T10-30-00Z", kind: "synthetic" };
}

// A host that records which navigation callback fired. isStillTargeting always true (one
// pair, no concurrent re-mount in these tests).
function recordingHost(): DiffDetailHost & { leaveCount: number; commitCount: number } {
  return {
    leaveCount: 0,
    commitCount: 0,
    isStillTargeting: () => true,
    onLeaveDetail() {
      this.leaveCount++;
    },
    onCommitExit() {
      this.commitCount++;
    },
  };
}

describe("DiffDetailController host seam (S2)", () => {
  let fx: ReturnType<typeof fixture>;
  let container: HTMLElement;

  beforeEach(() => {
    fx = fixture();
    container = document.createElement("div");
    document.body.appendChild(container); // owner mounts a real CM6 view → needs layout
  });
  afterEach(() => {
    container.remove();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  // deps the controller actually touches: vault + the optional read-fns. conflictStore /
  // conflictCounter are list-host concerns the controller never reads → cast past them.
  // autoFocus:false avoids the rAF-deferred focusFirstConflict (happy-dom has no layout).
  function deps(): DiffEditViewDeps {
    return {
      vault: fx.vault,
      autoFocus: () => false,
    } as unknown as DiffEditViewDeps;
  }

  async function writeInputs(base: string, sibling: string) {
    const basePath = "Notes/g.md";
    const siblingPath = "Notes/g.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc(base));
    await fx.vault.adapter.writeBinary(siblingPath, enc(sibling));
    const entry = entryFor(basePath, siblingPath);
    return { basePath, siblingPath, entry, conflictId: autosaveIdForEntry(entry) };
  }

  it("TODO §17 — conflict mode labels the Vault (ver1) side 'Local', not the device label", async () => {
    const { entry } = await writeInputs("a\nMINE\nc\n", "a\nTHEIRS\nc\n");
    const host = recordingHost();
    // deps DELIBERATELY provides a local device label — the conflict view must IGNORE it for
    // the local side (that's the whole point: "Obsidian" vs "Obsidian" was useless) and show
    // the literal "Local". The remote side keeps entry.deviceLabel ("Phone").
    const labelDeps = {
      vault: fx.vault,
      autoFocus: () => false,
      localDeviceLabel: () => "MyDesktop",
    } as unknown as DiffEditViewDeps;
    const ctl = new DiffDetailController({} as unknown as App, labelDeps, host);
    await ctl.mount(container, entry);

    // Toolbar "Keep all" hint reads "Local", not the device label.
    const keepBtn = container.querySelector(".diff2-btn-keep-local") as HTMLElement | null;
    expect(keepBtn?.title).toBe("Keep all Local changes");

    // The ver1 (top) marker is labelled "Local"; the ver2 (bottom) marker keeps "Phone"
    // (the marker renders the label parenthesized).
    const labels = Array.from(container.querySelectorAll(".diff2-marker-label")).map(
      (e) => e.textContent,
    );
    expect(labels).toContain("(Local)");
    expect(labels.some((l) => l?.includes("MyDesktop"))).toBe(false);
    expect(labels).toContain("(Phone)");
    ctl.dispose();
  });

  it("fresh mount → edit → exit() commits: onCommitExit fires, base written, dir wiped", async () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const { basePath, entry, conflictId } = await writeInputs(base, sibling);
    const host = recordingHost();
    const ctl = new DiffDetailController({} as unknown as App, deps(), host);

    await ctl.mount(container, entry); // fresh (no autosave dir) → startFreshAndMount
    const view = ctl.getView();
    expect(view).not.toBeNull();
    // A real edit → net>0 → commitOrDiscardExit → committed.
    view!.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });

    await ctl.exit(entry);

    expect(host.commitCount).toBe(1);
    expect(host.leaveCount).toBe(0);
    // The committed base reflects the edit, and the autosave dir is gone (commit7Step rmdir).
    expect(dec(await fx.vault.adapter.readBinary(basePath))).toContain("x");
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(false);
    ctl.dispose();
  });

  it("fresh mount → edit → undo → exit() discards: onCommitExit fires, inputs untouched, dir wiped", async () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const { basePath, siblingPath, entry, conflictId } = await writeInputs(base, sibling);
    const host = recordingHost();
    const ctl = new DiffDetailController({} as unknown as App, deps(), host);

    await ctl.mount(container, entry);
    const view = ctl.getView()!;
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    undo(view); // net 0 → recordCount 0 → discarded (silent wipe, still a success → onCommitExit)

    await ctl.exit(entry);

    expect(host.commitCount).toBe(1);
    expect(host.leaveCount).toBe(0);
    // Discard is byte-non-destructive: both inputs are untouched, dir wiped.
    expect(dec(await fx.vault.adapter.readBinary(basePath))).toBe(base);
    expect(dec(await fx.vault.adapter.readBinary(siblingPath))).toBe(sibling);
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(false);
    ctl.dispose();
  });

  it("exit() with no active session → onLeaveDetail (no commit)", async () => {
    const { entry } = await writeInputs("a\n", "b\n");
    const host = recordingHost();
    const ctl = new DiffDetailController({} as unknown as App, deps(), host);

    // No mount → no owner / no activeSession → the bare-leave branch.
    await ctl.exit(entry);

    expect(host.leaveCount).toBe(1);
    expect(host.commitCount).toBe(0);
    ctl.dispose();
  });

  it("dispose() is idempotent (gap-2 — old host calls it from render() AND onClose())", async () => {
    const { entry } = await writeInputs("a\nMINE\nc\n", "a\nTHEIRS\nc\n");
    const host = recordingHost();
    const ctl = new DiffDetailController({} as unknown as App, deps(), host);
    await ctl.mount(container, entry);
    expect(() => {
      ctl.dispose();
      ctl.dispose();
    }).not.toThrow();
    expect(ctl.getView()).toBeNull();
  });

  // REGRESSION: a partial resolve (conflict count N→N-1, still >0) with Auto-focus ON must
  // not blow the stack. focusFirstConflict()'s scrollToConflict dispatches a selection-set
  // transaction that RE-ENTERS refreshToolbar synchronously (CM6 fires updateListeners on
  // selectionSet even for a same-position cursor). If prevConflictCount is updated AFTER the
  // focus call (the original bug) the count-decrease guard never trips on re-entry → infinite
  // recursion → RangeError "Maximum call stack size exceeded" (device crash while editing a
  // small multi-conflict file). NOTE the overflow is SWALLOWED: CM6 wraps updateListener
  // calls in try/catch and routes the exception to console.error ("update listener: …"), so
  // the resolve dispatch does NOT throw to the caller — we must assert on that logged error.
  // deps() here forces autoFocus ON (the device default; the other tests use false).
  it("partial resolve with Auto-focus ON does NOT recurse (refreshToolbar re-entrancy)", async () => {
    // Two conflict groups so resolving one leaves the count at 1 (>0 → auto-focus fires).
    const base = "a\nMINE1\nb\nMINE2\nc\n";
    const sibling = "a\nTHEIRS1\nb\nTHEIRS2\nc\n";
    const { entry } = await writeInputs(base, sibling);
    const host = recordingHost();
    const focusDeps = { vault: fx.vault, autoFocus: () => true } as unknown as DiffEditViewDeps;
    const ctl = new DiffDetailController({} as unknown as App, focusDeps, host);

    await ctl.mount(container, entry);
    const view = ctl.getView()!;

    // Resolve group 1 → count 2→1. The dispatch drives owner.onUpdate → refreshToolbar →
    // focusFirstConflict → re-entrant refreshToolbar. Capture CM6's swallowed listener errors.
    const errs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => void errs.push(args.map(String).join(" "));
    try {
      applyResolve(view, 1, "keep1");
    } finally {
      console.error = origError;
    }

    // Pre-fix: errs is full of "update listener: RangeError: Maximum call stack size exceeded".
    expect(errs.join("\n")).not.toMatch(/call stack/i);
    ctl.dispose();
  });

  it("1B silentResume: a restart-restore REPLAYS the recorded edit with NO modal", async () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const { basePath, siblingPath, entry, conflictId } = await writeInputs(base, sibling);

    // Build a resumable session on disk (the glue-test pattern): start a session, drive a
    // recorded edit through a real owner, drain it to history.jsonl, dispose. The dir is now
    // a mid-session (resumable) state — exactly what a restored leaf finds at restart.
    await startSession(fx.vault, conflictId, basePath, siblingPath);
    const setupEl = document.createElement("div");
    document.body.appendChild(setupEl);
    const owner = new DiffPaneOwner(
      fx.vault,
      conflictId,
      setupEl,
      base,
      sibling,
      { localLabel: "local", remoteLabel: "Phone", date: "", isMarkdown: true },
      0,
    );
    owner.getView().dispatch({ changes: { from: 0, insert: "Z" }, userEvent: "input.type" });
    await owner.drainHistory();
    owner.dispose();
    setupEl.remove();

    // Restore mount with silentResume — `{} as App` proves no ResumeRecoveryModal is even
    // constructed (it would need a real App), and the resumed doc carries the "Z" edit (so it
    // replayed, NOT silently started fresh — the bug a silentResume mis-wire would cause).
    const host = recordingHost();
    const ctl = new DiffDetailController({} as unknown as App, deps(), host);
    await ctl.mount(container, entry, { silentResume: true });

    const view = ctl.getView();
    expect(view).not.toBeNull();
    expect(view!.state.doc.toString()).toContain("Z");
    expect(host.commitCount).toBe(0);
    expect(host.leaveCount).toBe(0);
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(true); // resume KEEPS the dir
    ctl.dispose();
  });
});
