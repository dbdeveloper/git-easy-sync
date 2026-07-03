import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { TFile, TFolder, Vault as MockVault } from "../../mock-obsidian";
import { TrashStore } from "../../src/diff2/trash-store";
import { TrashWatcher } from "../../src/diff2/trash-watcher";

// trash-watcher unit tests: verify the monkey-patch wrapper behaviour
// in isolation. Real Obsidian's vault.delete / vault.trash semantics
// are out of scope here — we use a fake vault with vi.fn()-spy methods
// to assert ordering, error handling, and the lifecycle contract.
//
// The integration test that exercises the full UI-delete pipeline
// (vault.delete → patched wrapper → TrashStore on disk) lands in PR-5
// as `n01-base-delete-confirms-via-1a` once layer 1a cleanup is in
// place to complete the end-to-end loop.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

interface FakeVault {
  delete: (file: unknown, ...rest: unknown[]) => Promise<void>;
  trash: (file: unknown, ...rest: unknown[]) => Promise<void>;
}

function fixture() {
  // Real-disk vault (for TrashStore intercept side-effects).
  const root = path.join(
    os.tmpdir(),
    `trash-watcher-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const mockVault = new MockVault(root);

  // Deterministic clock for TrashStore (1 ms tick per now()).
  let currentMs = Date.UTC(2026, 4, 26, 10, 30, 0, 0);
  const now = () => {
    const t = new Date(currentMs);
    currentMs += 1;
    return t;
  };

  const trashStore = new TrashStore({
    vault: mockVault as never,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now,
  });

  // Fake vault that the watcher patches. delete/trash are vi.fn() so we
  // can assert call order against trashStore.intercept. The actual
  // file-removal effect is performed by hooking through to fs.unlinkSync
  // so trashStore.list() reflects the post-delete state if we ever ask.
  const fakeRemove = (file: unknown) => {
    const f = file as { path: string };
    const abs = path.join(root, f.path);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      fs.rmSync(abs, { recursive: true });
    } else {
      fs.unlinkSync(abs);
    }
  };
  const fakeDelete = vi.fn(async (file: unknown) => fakeRemove(file));
  const fakeTrash = vi.fn(async (file: unknown) => fakeRemove(file));

  const fakeVault: FakeVault = {
    delete: fakeDelete,
    trash: fakeTrash,
  };

  const watcher = new TrashWatcher(fakeVault as never, trashStore);

  return {
    root,
    mockVault,
    trashStore,
    fakeVault,
    fakeDelete,
    fakeTrash,
    watcher,
    trashRoot: `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/.runtime/trash`,
  };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

function makeFile(filePath: string): TFile {
  const f = new TFile(filePath);
  return f;
}

function makeFolder(folderPath: string): TFolder {
  return new TFolder(folderPath);
}

describe("TrashWatcher", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.trashStore.init();
  });

  afterEach(() => {
    fx.watcher.uninstall();
    cleanup(fx.root);
  });

  describe("install / uninstall lifecycle", () => {
    it("install replaces vault.delete and vault.trash with wrappers", () => {
      const beforeDelete = fx.fakeVault.delete;
      const beforeTrash = fx.fakeVault.trash;
      fx.watcher.install();
      expect(fx.fakeVault.delete).not.toBe(beforeDelete);
      expect(fx.fakeVault.trash).not.toBe(beforeTrash);
    });

    it("uninstall restores the originals captured at install time", () => {
      const beforeDelete = fx.fakeVault.delete;
      const beforeTrash = fx.fakeVault.trash;
      fx.watcher.install();
      fx.watcher.uninstall();
      expect(fx.fakeVault.delete).toBe(beforeDelete);
      expect(fx.fakeVault.trash).toBe(beforeTrash);
    });

    it("install called twice without uninstall throws", () => {
      fx.watcher.install();
      expect(() => fx.watcher.install()).toThrow(/install called twice/);
    });

    it("uninstall without prior install is a no-op (no throw)", () => {
      expect(() => fx.watcher.uninstall()).not.toThrow();
    });

    it("install → uninstall → install again works (full cycle reset)", () => {
      const beforeDelete = fx.fakeVault.delete;
      fx.watcher.install();
      fx.watcher.uninstall();
      expect(fx.fakeVault.delete).toBe(beforeDelete);
      fx.watcher.install(); // must not throw
      expect(fx.fakeVault.delete).not.toBe(beforeDelete);
    });
  });

  describe("captureBeforeDelete ordering", () => {
    it("vault.delete captures bytes BEFORE invoking the original", async () => {
      const content = "intercept-me";
      fs.writeFileSync(path.join(fx.root, "note.md"), content);

      fx.watcher.install();
      const file = makeFile("note.md");
      await fx.fakeVault.delete(file);

      // Original was invoked exactly once with the file argument.
      expect(fx.fakeDelete).toHaveBeenCalledTimes(1);
      expect(fx.fakeDelete).toHaveBeenCalledWith(file);

      // trash has the byte-copy.
      const records = await fx.trashStore.list();
      expect(records).toHaveLength(1);
      expect(records[0].originalPath).toBe("note.md");
      const trashCopy = path.join(
        fx.root,
        fx.trashRoot,
        records[0].id,
        "vault/note.md",
      );
      expect(fs.readFileSync(trashCopy, "utf8")).toBe(content);

      // Original-vault file is gone (the fake original unlinks it).
      expect(fs.existsSync(path.join(fx.root, "note.md"))).toBe(false);
    });

    it("vault.trash captures bytes BEFORE invoking the original", async () => {
      const content = "via trash";
      fs.writeFileSync(path.join(fx.root, "note.md"), content);

      fx.watcher.install();
      const file = makeFile("note.md");
      await fx.fakeVault.trash(file);

      expect(fx.fakeTrash).toHaveBeenCalledTimes(1);
      const records = await fx.trashStore.list();
      expect(records).toHaveLength(1);
      expect(records[0].originalPath).toBe("note.md");
    });

    it("forwards additional arguments (force / system flag) to original", async () => {
      fs.writeFileSync(path.join(fx.root, "note.md"), "x");
      fx.watcher.install();
      const file = makeFile("note.md");
      await fx.fakeVault.delete(file, true);
      expect(fx.fakeDelete).toHaveBeenCalledWith(file, true);
    });

    it("ordering: intercept resolves BEFORE original delete is called", async () => {
      // Detect the ordering by recording the relative timestamp of each side.
      fs.writeFileSync(path.join(fx.root, "note.md"), "ordered");
      const events: string[] = [];

      // Replace the fake original with one that records its invocation.
      const orderedDelete = vi.fn(async () => {
        events.push("original-delete");
      });
      fx.fakeVault.delete = orderedDelete;

      // Wrap intercept to record its invocation as well.
      const realIntercept = fx.trashStore.intercept.bind(fx.trashStore);
      vi.spyOn(fx.trashStore, "intercept").mockImplementation(async (p) => {
        events.push("intercept-start");
        const r = await realIntercept(p);
        events.push("intercept-end");
        return r;
      });

      fx.watcher.install();
      await fx.fakeVault.delete(makeFile("note.md"));

      expect(events).toEqual([
        "intercept-start",
        "intercept-end",
        "original-delete",
      ]);
    });
  });

  describe("folder deletion (v1: not captured)", () => {
    it("vault.delete on TFolder does NOT call intercept", async () => {
      fs.mkdirSync(path.join(fx.root, "Folder"));

      const interceptSpy = vi.spyOn(fx.trashStore, "intercept");
      fx.watcher.install();

      await fx.fakeVault.delete(makeFolder("Folder"));

      // Folder went through original path; intercept never fired.
      expect(interceptSpy).not.toHaveBeenCalled();
      expect(fx.fakeDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe("best-effort capture (failure does not block delete)", () => {
    it("intercept throwing does not prevent the original delete from running", async () => {
      fs.writeFileSync(path.join(fx.root, "note.md"), "x");

      vi.spyOn(fx.trashStore, "intercept").mockRejectedValueOnce(
        new Error("simulated disk error"),
      );
      fx.watcher.install();

      // Should NOT throw — wrapper swallows intercept failure.
      await fx.fakeVault.delete(makeFile("note.md"));

      // Original was still invoked → file gone from vault.
      expect(fx.fakeDelete).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(fx.root, "note.md"))).toBe(false);
    });
  });

  describe("LIFO stacking (compatibility with other patching plugins)", () => {
    it("respects an upper-layer patch installed after our wrapper", async () => {
      fs.writeFileSync(path.join(fx.root, "note.md"), "x");

      fx.watcher.install();
      const ourWrapped = fx.fakeVault.delete;

      // Simulate another plugin patching on top of ours.
      const upperLayer = vi.fn(async (file: unknown, ...rest: unknown[]) => {
        return ourWrapped(file, ...rest);
      });
      fx.fakeVault.delete = upperLayer;

      // Caller invokes the top-most layer.
      await fx.fakeVault.delete(makeFile("note.md"));

      // Upper layer ran, our wrapper underneath captured.
      expect(upperLayer).toHaveBeenCalledTimes(1);
      const records = await fx.trashStore.list();
      expect(records).toHaveLength(1);
    });
  });
});
