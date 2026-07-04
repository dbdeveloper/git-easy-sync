import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { TFile } from "../mock-obsidian";
import { writePreservingOpenViews } from "../src/preserve-open-views";

// writePreservingOpenViews closes the open MarkdownView tab(s) of a file BEFORE writing it
// (so vault.modifyBinary can't freeze the UI re-rendering the live editor for a large file),
// then reopens them FRESH with cursor/scroll (eState) restored. These pin the mechanism's
// ORDER + the try/finally guarantee — the real freeze it prevents is Obsidian-internal and
// can only be device-verified.

interface FakeLeaf {
  view: unknown;
  detach: ReturnType<typeof vi.fn>;
}

// Build a fake app whose workspace has `leaves` open. Records the call ORDER so we can
// assert "detach happens BEFORE the write, reopen AFTER".
function fakeApp(order: string[], leaves: FakeLeaf[]) {
  const openFile = vi.fn(async (_tf: unknown, _opts: unknown) => {
    order.push("reopen");
  });
  const app = {
    workspace: {
      activeLeaf: leaves[0] ?? null,
      iterateAllLeaves: (cb: (l: unknown) => void) => leaves.forEach(cb),
      getLeaf: (_mode: unknown) => ({ openFile }),
    },
    vault: {
      getAbstractFileByPath: (p: string) => new TFile(p),
    },
  } as unknown as App;
  return { app, openFile };
}

// A fake file-backed leaf. The impl duck-types on `.file`, so EVERY file view (markdown,
// canvas, image, pdf, audio, video, community FileView) is handled identically — the `kind`
// here is cosmetic, just to document that non-markdown tabs are covered too.
function fileLeaf(order: string[], path: string, eState: unknown, kind = "markdown"): FakeLeaf {
  const view = { file: { path }, getEphemeralState: () => eState, kind };
  return { view, detach: vi.fn(() => order.push("detach")) };
}

describe("writePreservingOpenViews", () => {
  it("file OPEN in a tab → detach BEFORE write, reopen AFTER with eState, returns the write result", async () => {
    const order: string[] = [];
    const leaf = fileLeaf(order, "big.md", { scroll: 42 });
    const { app, openFile } = fakeApp(order, [leaf]);

    const result = await writePreservingOpenViews(app, "big.md", async () => {
      order.push("write");
      return "written-path";
    });

    expect(result).toBe("written-path");
    // The whole point: the tab is closed BEFORE the write (no live editor to re-render),
    // and reopened AFTER.
    expect(order).toEqual(["detach", "write", "reopen"]);
    expect(leaf.detach).toHaveBeenCalledTimes(1);
    // eState (cursor/scroll) is carried into the reopen.
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile.mock.calls[0][1]).toMatchObject({ eState: { scroll: 42 } });
  });

  it("file NOT open → no detach, no reopen, write still runs", async () => {
    const order: string[] = [];
    // A leaf showing a DIFFERENT file — must be ignored.
    const other = fileLeaf(order, "other.md", null);
    const { app, openFile } = fakeApp(order, [other]);

    await writePreservingOpenViews(app, "big.md", async () => {
      order.push("write");
    });

    expect(order).toEqual(["write"]);
    expect(other.detach).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("write THROWS → the tab is STILL reopened (try/finally never loses a user's tab)", async () => {
    const order: string[] = [];
    const leaf = fileLeaf(order, "big.md", { scroll: 7 });
    const { app, openFile } = fakeApp(order, [leaf]);

    await expect(
      writePreservingOpenViews(app, "big.md", async () => {
        order.push("write");
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");

    expect(leaf.detach).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledTimes(1); // reopened despite the failure
    expect(order).toEqual(["detach", "write", "reopen"]);
  });

  it("file open in MULTIPLE tabs → each is detached and reopened", async () => {
    const order: string[] = [];
    const l1 = fileLeaf(order, "big.md", { scroll: 1 });
    const l2 = fileLeaf(order, "big.md", { scroll: 2 });
    const { app, openFile } = fakeApp(order, [l1, l2]);

    await writePreservingOpenViews(app, "big.md", async () => {
      order.push("write");
    });

    expect(l1.detach).toHaveBeenCalledTimes(1);
    expect(l2.detach).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledTimes(2);
    // Both detaches precede the single write; both reopens follow it.
    expect(order).toEqual(["detach", "detach", "write", "reopen", "reopen"]);
  });

  it("a NON-markdown file view (Canvas / image / pdf) is preserved too — duck-types on .file", async () => {
    const order: string[] = [];
    // A CanvasView-shaped leaf: not a MarkdownView, but has `.file`. A rename would
    // vanish-close it just the same, so it must be detached + reopened like any file tab.
    const canvas = fileLeaf(order, "board.canvas", { zoom: 1.5 }, "canvas");
    const { app, openFile } = fakeApp(order, [canvas]);

    await writePreservingOpenViews(app, "board.canvas", async () => {
      order.push("write");
    });

    expect(canvas.detach).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["detach", "write", "reopen"]);
  });
});
