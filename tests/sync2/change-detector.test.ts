import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import GI from "../../src/gi";
import SnapshotStore from "../../src/sync2/snapshot-store";
import ChangeDetector from "../../src/sync2/change-detector";
import { Vault } from "../../mock-obsidian";
import { calculateGitBlobSHA } from "../../src/utils";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture(): {
  root: string;
  vault: Vault;
  store: SnapshotStore;
  gi: GI;
  detector: ChangeDetector;
} {
  const root = path.join(
    os.tmpdir(),
    `change-detector-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const store = new SnapshotStore(
    vault as unknown as import("obsidian").Vault,
  );
  const gi = new GI(root);
  const detector = new ChangeDetector({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: root,
    syncConfigDir: () => true,
  });
  return { root, vault, store, gi, detector };
}

function writeFile(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function shaOf(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
  return await calculateGitBlobSHA(buf);
}

// Helper to set a file's mtime to a specific timestamp so tests can
// drive the watermark-filter deterministically.
function setMtime(root: string, rel: string, msEpoch: number): void {
  const abs = path.join(root, rel);
  fs.utimesSync(abs, new Date(msEpoch), new Date(msEpoch));
}

describe("ChangeDetector", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.store.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  describe("findChanges() — first sync (no watermark)", () => {
    it("emits added for every syncable file when watermark is null", async () => {
      writeFile(f.root, "Notes/x.md", "hello");
      writeFile(f.root, "Notes/y.md", "world");
      const out = await f.detector.findChanges();
      const paths = out.map((c) => c.path).sort();
      expect(paths).toEqual(["Notes/x.md", "Notes/y.md"]);
      expect(out.every((c) => c.kind === "added")).toBe(true);
    });

    it("hardcoded deny: skips sync2 manifest itself", async () => {
      writeFile(
        f.root,
        `${CONFIG_DIR}/git-easy-sync-metadata.json`,
        "{}",
      );
      const out = await f.detector.findChanges();
      expect(out).toEqual([]);
    });

    it("hardcoded deny: skips our plugin's data.json", async () => {
      writeFile(
        f.root,
        `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/data.json`,
        "{}",
      );
      const out = await f.detector.findChanges();
      expect(out).toEqual([]);
    });

    it("hardcoded deny: skips anything inside .git/", async () => {
      writeFile(f.root, ".git/HEAD", "ref: refs/heads/main");
      writeFile(f.root, ".git/objects/ab/cdef", "binary");
      const out = await f.detector.findChanges();
      expect(out).toEqual([]);
    });

    it("§4.5.3 (C2/G2): the WHOLE .runtime/ subtree is excluded (single prefix, no gitignore needed)", async () => {
      // The reorg put ALL per-device runtime state under one `.runtime/` folder; the
      // single hardcoded prefix must exclude every current + future artifact — even with
      // syncConfigDir ON and NO plugin .gitignore seeded (the un-seeded window this
      // safety-net exists for). A regression here feedback-loops per-device state to GitHub.
      const pdir = `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}`;
      writeFile(f.root, `${pdir}/.runtime/push-queue/b1/vault/note.md`, "q");
      writeFile(f.root, `${pdir}/.runtime/conflicts/c1/meta.json`, "{}");
      writeFile(f.root, `${pdir}/.runtime/trash/t1/meta.json`, "{}");
      writeFile(f.root, `${pdir}/.runtime/pending-deletions/p1/meta.json`, "{}");
      writeFile(f.root, `${pdir}/.runtime/diff2-autosave/history-x/meta.json`, "{}");
      writeFile(f.root, `${pdir}/.runtime/push-inflight.json`, "{}");
      writeFile(f.root, `${pdir}/.runtime/token_expired`, "x");
      writeFile(f.root, `${pdir}/.runtime/diff2-layout-restore.json`, "{}");
      // Control: a real plugin file is NOT over-blocked (main.js still syncs).
      writeFile(f.root, `${pdir}/main.js`, "code");
      const paths = (await f.detector.findChanges()).map((c) => c.path);
      expect(paths.filter((p) => p.includes("/.runtime/"))).toEqual([]);
      expect(paths).toContain(`${pdir}/main.js`);
    });

    it("respects gitignore at root", async () => {
      writeFile(f.root, ".gitignore", "*.log\n");
      writeFile(f.root, "x.log", "noise");
      writeFile(f.root, "x.md", "kept");
      const out = await f.detector.findChanges();
      // .gitignore itself is syncable — it propagates rules between
      // devices, so it's expected to show up as added too.
      // (Picked up via walkRootDotfiles since production Obsidian's
      // vault.getFiles() omits root-level dotfiles.)
      const paths = out.map((c) => c.path).sort();
      expect(paths).toEqual([".gitignore", "x.md"]);
    });

    it("picks up root-level dotfiles that vault.getFiles() omits", async () => {
      // Real bug from production: desktop and mobile root `.gitignore`
      // drifted apart for weeks because findChanges never saw edits
      // to it. vault.getFiles() in production Obsidian doesn't index
      // root dotfiles; walkRootDotfiles compensates. The mock mirrors
      // the production gap (root dotfiles are NOT returned by
      // mock's getFiles), so this test fails the moment the
      // compensation breaks.
      writeFile(f.root, ".gitignore", "rule\n");
      writeFile(f.root, ".gitattributes", "* text=auto\n");
      writeFile(f.root, ".editorconfig", "root = true\n");
      writeFile(f.root, "regular.md", "body");
      const out = await f.detector.findChanges();
      const paths = out.map((c) => c.path).sort();
      expect(paths).toEqual([
        ".editorconfig",
        ".gitattributes",
        ".gitignore",
        "regular.md",
      ]);
    });

    it("dotfile coverage: .gitignore, .gitkeep, .blabla sync; .git blocked", async () => {
      // The bug that prompted this test family: walking the vault on
      // mobile, root .gitignore stayed device-local for weeks
      // because vault.getFiles() never returned it. Comprehensive
      // dotfile coverage so future regressions surface immediately.
      writeFile(f.root, ".gitignore", "user rule\n");
      writeFile(f.root, ".gitkeep", ""); // standard git placeholder
      writeFile(f.root, ".blabla", "arbitrary dotfile content");
      writeFile(f.root, ".editorconfig", "[*]\n");
      // .git file at root would normally indicate a git submodule
      // pointer. It must NEVER sync (it's git internals).
      writeFile(f.root, ".git", "gitdir: ../actual/.git");

      const out = await f.detector.findChanges();
      const paths = out.map((c) => c.path).sort();

      // All four user dotfiles flow through; .git is blocked by
      // isSyncable's hardcoded denylist.
      expect(paths).toEqual([
        ".blabla",
        ".editorconfig",
        ".gitignore",
        ".gitkeep",
      ]);
    });

    it("walkRootDotfiles only walks the vault ROOT (no recursion into dotfile-named subdirs)", async () => {
      // Dotfiles inside subdirs (`<vault>/Notes/.todo.md`) are NOT a
      // concern here — vault.getFiles() in production may or may
      // not pick them up, but they aren't the user's "vault config"
      // shape. walkRootDotfiles stays one level deep on purpose.
      writeFile(f.root, ".gitignore", "rule\n");
      writeFile(f.root, "Notes/.hidden.md", "hidden note");
      const out = await f.detector.findChanges();
      const paths = out.map((c) => c.path).sort();
      // .gitignore picked up by walkRootDotfiles. Notes/.hidden.md
      // would only be picked up if Obsidian's index returns it via
      // getFiles(); the mock mirrors production by also omitting
      // dotfiles inside subdirectories. Test asserts root dotfile
      // only — keeps the contract narrow.
      expect(paths).toContain(".gitignore");
      // Whether subdir-dotfile shows up is unspecified at this
      // layer; we assert only what walkRootDotfiles guarantees.
    });
  });

  describe("findChanges() — incremental (with watermark)", () => {
    it("skips files whose mtime <= watermark (cache short-circuit)", async () => {
      writeFile(f.root, "Notes/old.md", "untouched");
      const oldStat = fs.statSync(path.join(f.root, "Notes/old.md"));
      const sha = await shaOf("untouched");
      f.store.set("Notes/old.md", {
        path: "Notes/old.md",
        remoteSha: sha,
        mtime: oldStat.mtimeMs,
        size: oldStat.size,
      });
      // Watermark equals the file's mtime → file is skipped.
      f.store.setLastCommitMtime(oldStat.mtimeMs);

      const adapter = f.vault.adapter as unknown as {
        readBinary: (p: string) => Promise<Buffer>;
      };
      const original = adapter.readBinary;
      const calls: string[] = [];
      adapter.readBinary = async (p: string) => {
        calls.push(p);
        return original.call(adapter, p);
      };
      try {
        const out = await f.detector.findChanges();
        expect(out).toEqual([]);
        expect(calls).toEqual([]);
      } finally {
        adapter.readBinary = original;
      }
    });

    it("picks up files modified after the watermark", async () => {
      // Old file: under watermark, snapshot in sync.
      writeFile(f.root, "Notes/old.md", "v1");
      setMtime(f.root, "Notes/old.md", 1_000_000_000_000);
      const oldSha = await shaOf("v1");
      f.store.set("Notes/old.md", {
        path: "Notes/old.md",
        remoteSha: oldSha,
        mtime: 1_000_000_000_000,
        size: 2,
      });

      // New file: ahead of watermark.
      writeFile(f.root, "Notes/new.md", "fresh");
      setMtime(f.root, "Notes/new.md", 2_000_000_000_000);

      f.store.setLastCommitMtime(1_500_000_000_000);

      const out = await f.detector.findChanges();
      expect(out).toMatchObject([
        { kind: "added", path: "Notes/new.md" },
      ]);
    });

    it("emits modified when stat moved past watermark and content changed", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      setMtime(f.root, "Notes/x.md", 1_000_000_000_000);
      const oldSha = await shaOf("v1");
      f.store.set("Notes/x.md", {
        path: "Notes/x.md",
        remoteSha: oldSha,
        mtime: 1_000_000_000_000,
        size: 2,
      });
      f.store.setLastCommitMtime(1_000_000_000_000);

      // Edit. mtime advances past watermark.
      writeFile(f.root, "Notes/x.md", "v2-bigger");
      setMtime(f.root, "Notes/x.md", 2_000_000_000_000);

      const out = await f.detector.findChanges();
      expect(out).toMatchObject([
        {
          kind: "modified",
          path: "Notes/x.md",
          previousRemoteSha: oldSha,
        },
      ]);
    });

    it("ENOENT mid-walk (file vanished after listing): skips it, sync survives, other changes still detected", async () => {
      // Two modified candidates; one's readBinary throws ENOENT (an external
      // writer — e.g. Obsidian rewriting .obsidian/* — removed it for a moment
      // between listing and read on Android). SYNC2 §6 skip-class: skip the
      // vanished one, don't fail findChanges, still emit the healthy one.
      for (const name of ["Notes/vanish.md", "Notes/ok.md"]) {
        writeFile(f.root, name, "v1");
        setMtime(f.root, name, 1_000_000_000_000);
        f.store.set(name, {
          path: name,
          remoteSha: await shaOf("v1"),
          mtime: 1_000_000_000_000,
          size: 2,
        });
      }
      f.store.setLastCommitMtime(1_000_000_000_000);
      // Edit both → modified candidates past the watermark.
      writeFile(f.root, "Notes/vanish.md", "v2-bigger");
      setMtime(f.root, "Notes/vanish.md", 2_000_000_000_000);
      writeFile(f.root, "Notes/ok.md", "o2-bigger");
      setMtime(f.root, "Notes/ok.md", 2_000_000_000_000);

      // mock-obsidian's `adapter` is a fresh-literal getter, so override the
      // getter to re-wrap readBinary on every access (a plain reassignment is
      // lost). Throw ENOENT only for the "vanished" path.
      const proto = Object.getPrototypeOf(f.vault);
      const origGet = Object.getOwnPropertyDescriptor(proto, "adapter")!.get!;
      Object.defineProperty(f.vault, "adapter", {
        configurable: true,
        get() {
          const real = origGet.call(this) as {
            readBinary: (p: string) => Promise<unknown>;
          };
          const orig = real.readBinary;
          real.readBinary = async (p: string) => {
            if (p === "Notes/vanish.md") {
              const e = new Error("File does not exist") as Error & { code?: string };
              e.code = "ENOENT";
              throw e;
            }
            return orig(p);
          };
          return real;
        },
      });

      try {
        const out = await f.detector.findChanges(); // must NOT throw
        expect(out.find((c) => c.path === "Notes/ok.md")?.kind).toBe("modified");
        expect(out.find((c) => c.path === "Notes/vanish.md")).toBeUndefined();
      } finally {
        Object.defineProperty(f.vault, "adapter", { configurable: true, get: origGet });
      }
    });

    it("touched-but-unchanged: refreshes mtime in snapshot, emits nothing", async () => {
      writeFile(f.root, "Notes/x.md", "same");
      setMtime(f.root, "Notes/x.md", 1_000_000_000_000);
      const sha = await shaOf("same");
      f.store.set("Notes/x.md", {
        path: "Notes/x.md",
        remoteSha: sha,
        mtime: 1_000_000_000_000,
        size: 4,
      });
      f.store.setLastCommitMtime(1_000_000_000_000);

      // Bump mtime without changing content.
      setMtime(f.root, "Notes/x.md", 3_000_000_000_000);

      const out = await f.detector.findChanges();
      expect(out).toEqual([]);
      const refreshed = f.store.get("Notes/x.md");
      expect(refreshed?.mtime).toBe(3_000_000_000_000);
    });
  });

  describe("findChanges() — Pass 2: snapshot-only paths", () => {
    it("emits deleted when snapshot exists and file is gone", async () => {
      f.store.set("Notes/gone.md", {
        path: "Notes/gone.md",
        remoteSha: "abc",
        mtime: 1,
        size: 1,
      });
      const out = await f.detector.findChanges();
      expect(out).toMatchObject([
        { kind: "deleted", path: "Notes/gone.md", previousRemoteSha: "abc" },
      ]);
    });

    it("path now ignored: snapshot dropped silently, no delete emitted", async () => {
      writeFile(f.root, "old.log", "still here");
      writeFile(f.root, ".gitignore", "*.log\n");
      f.store.set("old.log", {
        path: "old.log",
        remoteSha: "stalesha",
        mtime: 1,
        size: 10,
      });

      const out = await f.detector.findChanges();
      expect(out.find((c) => c.path === "old.log")).toBeUndefined();
      expect(f.store.get("old.log")).toBeUndefined();
    });

    it("path now syncable: surfaces as added on next findChanges", async () => {
      writeFile(f.root, ".gitignore", "*.log\n");
      writeFile(f.root, "kept.log", "ignored at first");

      let out = await f.detector.findChanges();
      expect(out.find((c) => c.path === "kept.log")).toBeUndefined();

      // User edits .gitignore so *.log is no longer ignored.
      fs.writeFileSync(path.join(f.root, ".gitignore"), "");
      // Layer A: tell GI to refresh on next query (Sync2Manager wires
      // this via gi.invalidate after a pulled .gitignore lands; tests
      // simulate it directly).
      f.gi.invalidate("");

      out = await f.detector.findChanges();
      const kept = out.find((c) => c.path === "kept.log");
      expect(kept).toMatchObject({ kind: "added", path: "kept.log" });
    });
  });

  describe("recordSync()", () => {
    it("after a push, subsequent findChanges short-circuits", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      const out1 = await f.detector.findChanges();
      expect(out1).toMatchObject([{ kind: "added", path: "Notes/x.md" }]);

      const sha = await shaOf("v1");
      await f.detector.recordSync("Notes/x.md", sha);

      const out2 = await f.detector.findChanges();
      expect(out2).toEqual([]);
    });

    it("if file vanished between push and recordSync, snapshot drops", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      await f.detector.recordSync("Notes/x.md", "abc");
      fs.rmSync(path.join(f.root, "Notes/x.md"));
      await f.detector.recordSync("Notes/x.md", "def");
      expect(f.store.get("Notes/x.md")).toBeUndefined();
    });
  });

  describe("recordDeletion()", () => {
    it("snapshot is removed", () => {
      f.store.set("Notes/x.md", {
        path: "Notes/x.md",
        remoteSha: "abc",
        mtime: 1,
        size: 1,
      });
      f.detector.recordDeletion("Notes/x.md");
      expect(f.store.get("Notes/x.md")).toBeUndefined();
    });
  });

  describe("findChangeForPath()", () => {
    it("file present, no snapshot → added", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      const out = await f.detector.findChangeForPath("Notes/x.md");
      expect(out).toMatchObject({ kind: "added", path: "Notes/x.md" });
    });

    it("file present, snapshot matches stat → null (cache hit)", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      const stat = fs.statSync(path.join(f.root, "Notes/x.md"));
      f.store.set("Notes/x.md", {
        path: "Notes/x.md",
        remoteSha: await shaOf("v1"),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      expect(await f.detector.findChangeForPath("Notes/x.md")).toBeNull();
    });

    it("file present, mtime moved but content unchanged → null + snapshot mtime refreshed", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      const sha = await shaOf("v1");
      f.store.set("Notes/x.md", {
        path: "Notes/x.md",
        remoteSha: sha,
        mtime: 0,
        size: 2,
      });
      expect(await f.detector.findChangeForPath("Notes/x.md")).toBeNull();
      const stat = fs.statSync(path.join(f.root, "Notes/x.md"));
      expect(f.store.get("Notes/x.md")?.mtime).toBe(stat.mtimeMs);
    });

    it("file present, content changed → modified", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      f.store.set("Notes/x.md", {
        path: "Notes/x.md",
        remoteSha: await shaOf("v1"),
        mtime: 1,
        size: 2,
      });
      writeFile(f.root, "Notes/x.md", "v2-different");
      const out = await f.detector.findChangeForPath("Notes/x.md");
      expect(out?.kind).toBe("modified");
    });

    it("file absent, snapshot exists → deleted", async () => {
      f.store.set("Notes/gone.md", {
        path: "Notes/gone.md",
        remoteSha: "OLD",
        mtime: 1,
        size: 1,
      });
      const out = await f.detector.findChangeForPath("Notes/gone.md");
      expect(out).toMatchObject({
        kind: "deleted",
        path: "Notes/gone.md",
        previousRemoteSha: "OLD",
      });
    });

    it("file absent, no snapshot → null", async () => {
      expect(
        await f.detector.findChangeForPath("Notes/never.md"),
      ).toBeNull();
    });

    it("ignored path → null even if file changed", async () => {
      writeFile(f.root, ".gitignore", "*.log\n");
      writeFile(f.root, "noise.log", "growing");
      expect(await f.detector.findChangeForPath("noise.log")).toBeNull();
    });

    it("hardcoded deny: data.json → null", async () => {
      const dataJson = `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/data.json`;
      writeFile(f.root, dataJson, "{}");
      expect(await f.detector.findChangeForPath(dataJson)).toBeNull();
    });
  });

  describe("rename × gitignore matrix", () => {
    // The four matrix cases are observed end-to-end via findChanges:
    // there is no rename hook, only state shifts that the algorithm
    // reads naturally from getFiles() + snapshot store.

    it("syncable → syncable: emits deleted(old) + added(new)", async () => {
      writeFile(f.root, "drafts/a.md", "content");
      const sha = await shaOf("content");
      const stat = fs.statSync(path.join(f.root, "drafts/a.md"));
      f.store.set("drafts/a.md", {
        path: "drafts/a.md",
        remoteSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f.store.setLastCommitMtime(stat.mtimeMs);

      // Rename a.md → b.md. The new path's mtime is fresh (bumped on
      // rename in most filesystems, but we set it explicitly to be
      // robust on those that don't).
      fs.renameSync(
        path.join(f.root, "drafts/a.md"),
        path.join(f.root, "drafts/b.md"),
      );
      setMtime(f.root, "drafts/b.md", stat.mtimeMs + 1000);

      const out = await f.detector.findChanges();
      const kinds = out.map((c) => `${c.kind}:${c.path}`).sort();
      expect(kinds).toContain("added:drafts/b.md");
      expect(kinds).toContain("deleted:drafts/a.md");
    });

    it("syncable → ignored: emits deleted(old) only", async () => {
      writeFile(f.root, ".gitignore", "archive/\n");
      writeFile(f.root, "drafts/note.md", "content");
      const sha = await shaOf("content");
      const stat = fs.statSync(path.join(f.root, "drafts/note.md"));
      f.store.set("drafts/note.md", {
        path: "drafts/note.md",
        remoteSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      // Snapshot also for .gitignore so the test starts from a "synced"
      // baseline and we can isolate the rename effect.
      const giStat = fs.statSync(path.join(f.root, ".gitignore"));
      const giSha = await shaOf("archive/\n");
      f.store.set(".gitignore", {
        path: ".gitignore",
        remoteSha: giSha,
        mtime: giStat.mtimeMs,
        size: giStat.size,
      });
      f.store.setLastCommitMtime(Math.max(stat.mtimeMs, giStat.mtimeMs));

      fs.mkdirSync(path.join(f.root, "archive"), { recursive: true });
      fs.renameSync(
        path.join(f.root, "drafts/note.md"),
        path.join(f.root, "archive/note.md"),
      );

      const out = await f.detector.findChanges();
      const remoteAffecting = out.filter(
        (c) => c.path === "drafts/note.md" || c.path === "archive/note.md",
      );
      expect(remoteAffecting).toMatchObject([
        { kind: "deleted", path: "drafts/note.md" },
      ]);
    });

    it("ignored → syncable: emits added(new) only", async () => {
      writeFile(f.root, ".gitignore", "archive/\n");
      writeFile(f.root, "archive/note.md", "content");
      // Snapshot only .gitignore (archive/* never tracked).
      const giStat = fs.statSync(path.join(f.root, ".gitignore"));
      const giSha = await shaOf("archive/\n");
      f.store.set(".gitignore", {
        path: ".gitignore",
        remoteSha: giSha,
        mtime: giStat.mtimeMs,
        size: giStat.size,
      });
      f.store.setLastCommitMtime(giStat.mtimeMs);

      fs.mkdirSync(path.join(f.root, "drafts"), { recursive: true });
      fs.renameSync(
        path.join(f.root, "archive/note.md"),
        path.join(f.root, "drafts/note.md"),
      );
      // Bump mtime so it exceeds the watermark deterministically.
      setMtime(f.root, "drafts/note.md", giStat.mtimeMs + 5000);

      const out = await f.detector.findChanges();
      const remoteAffecting = out.filter(
        (c) =>
          c.path === "drafts/note.md" || c.path === "archive/note.md",
      );
      expect(remoteAffecting).toMatchObject([
        { kind: "added", path: "drafts/note.md" },
      ]);
    });

    it("ignored → ignored: emits nothing for the renamed file", async () => {
      writeFile(f.root, ".gitignore", "trash/\narchive/\n");
      writeFile(f.root, "archive/note.md", "content");
      const giStat = fs.statSync(path.join(f.root, ".gitignore"));
      const giSha = await shaOf("trash/\narchive/\n");
      f.store.set(".gitignore", {
        path: ".gitignore",
        remoteSha: giSha,
        mtime: giStat.mtimeMs,
        size: giStat.size,
      });
      f.store.setLastCommitMtime(giStat.mtimeMs);

      fs.mkdirSync(path.join(f.root, "trash"), { recursive: true });
      fs.renameSync(
        path.join(f.root, "archive/note.md"),
        path.join(f.root, "trash/note.md"),
      );

      const out = await f.detector.findChanges();
      const affected = out.filter(
        (c) =>
          c.path === "archive/note.md" || c.path === "trash/note.md",
      );
      expect(affected).toEqual([]);
    });
  });

  // ── push-queue dedup (TODO §40) ──────────────────────────────────────
  // When a queue is wired, findChanges must suppress re-emitting a file
  // whose current bytes match its LAST commit (the newest queued batch),
  // but MUST still emit it when the bytes differ — even a revert to an
  // older version. The bug: with an expired token the queue never drains
  // (recordSync never advances the snapshot), so every commit re-detected
  // the same file → an unbounded pile of identical commits.
  describe("findChanges() — push-queue dedup (TODO §40)", () => {
    const WATERMARK = 1_500_000_000_000;
    const AHEAD = 2_000_000_000_000;

    const detectorWithQueue = (
      peek: (path: string) => Promise<string | null>,
    ): ChangeDetector =>
      new ChangeDetector({
        vault: f.vault as unknown as import("obsidian").Vault,
        store: f.store,
        gi: f.gi,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        vaultRoot: f.root,
        syncConfigDir: () => true,
        queue: { peekLatestPathSha: peek },
      });

    // Stage a modified candidate: file ahead of watermark, snapshot at a
    // DIFFERENT (stale) sha so it reaches the queue-dedup check.
    const stageModified = (content: string): void => {
      writeFile(f.root, "a.md", content);
      setMtime(f.root, "a.md", AHEAD);
      f.store.set("a.md", { path: "a.md", remoteSha: "STALE_REMOTE_SHA", mtime: 1, size: 1 });
      f.store.setLastCommitMtime(WATERMARK);
    };

    it("modified: current bytes == last commit → NOT re-emitted", async () => {
      stageModified("current");
      const det = detectorWithQueue(async () => await shaOf("current"));
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });

    it("modified: current bytes != last commit → emitted", async () => {
      stageModified("current");
      const det = detectorWithQueue(async () => "A_DIFFERENT_SHA");
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("revert: current == an OLD version but the last commit is a newer, different version → emitted (preserve-all-commits)", async () => {
      stageModified("v1"); // disk reverted to v1
      // The queue's LATEST commit of a.md is v3, not v1.
      const det = detectorWithQueue(async () => await shaOf("v3"));
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("added (no snapshot): current bytes == last commit → NOT re-emitted", async () => {
      writeFile(f.root, "a.md", "current");
      setMtime(f.root, "a.md", AHEAD);
      f.store.setLastCommitMtime(WATERMARK);
      const det = detectorWithQueue(async () => await shaOf("current"));
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });

    it("added (no snapshot): current bytes != last commit → emitted as added", async () => {
      writeFile(f.root, "a.md", "current");
      setMtime(f.root, "a.md", AHEAD);
      f.store.setLastCommitMtime(WATERMARK);
      const det = detectorWithQueue(async () => "A_DIFFERENT_SHA");
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("added");
    });

    it("no queue wired → falls back to snapshot-only (emits the change)", async () => {
      stageModified("current");
      // f.detector has NO queue → no dedup, the change flows through.
      const out = await f.detector.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("revert to the last-PUSHED bytes while a NEWER version is queued → emitted (TODO §40 step 3)", async () => {
      // Disk reverted to v1; snapshot.remoteSha == sha(v1) (v1 is the last
      // PUSH). But the newest queued commit is v2 → the revert v2→v1 is a
      // real change and must be emitted even though it matches the remote.
      writeFile(f.root, "a.md", "v1");
      setMtime(f.root, "a.md", AHEAD);
      f.store.set("a.md", { path: "a.md", remoteSha: await shaOf("v1"), mtime: 1, size: 1 });
      f.store.setLastCommitMtime(WATERMARK);
      const det = detectorWithQueue(async () => await shaOf("v2")); // last commit = v2
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("matches the last push AND nothing newer is queued → NOT emitted", async () => {
      writeFile(f.root, "a.md", "v1");
      setMtime(f.root, "a.md", AHEAD);
      f.store.set("a.md", { path: "a.md", remoteSha: await shaOf("v1"), mtime: 1, size: 1 });
      f.store.setLastCommitMtime(WATERMARK);
      const det = detectorWithQueue(async () => null); // nothing queued for a.md
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });
  });

  // ── §26: tracked-conflict base reference is the conflict-branch value,
  // not main. Only consult main to know it's tracked.
  describe("findChanges() — §26 tracked-conflict base", () => {
    const WM = 1_500_000_000_000;
    const AHEAD_TS = 2_000_000_000_000;

    const detectorWithConflictBase = (
      resolver: (path: string) => string | null | undefined,
    ): ChangeDetector =>
      new ChangeDetector({
        vault: f.vault as unknown as import("obsidian").Vault,
        store: f.store,
        gi: f.gi,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        vaultRoot: f.root,
        syncConfigDir: () => true,
        conflictBaseSha: resolver,
      });

    const stage = (content: string, remoteSha: string): void => {
      writeFile(f.root, "a.md", content);
      setMtime(f.root, "a.md", AHEAD_TS);
      f.store.set("a.md", { path: "a.md", remoteSha, mtime: 1, size: 1 });
      f.store.setLastCommitMtime(WM);
    };

    it("UNCHANGED base (disk == branch value) → NOT emitted, even though disk ≠ main", async () => {
      stage("V1", "MAIN-SHA");
      const v1 = await shaOf("V1"); // branch value == disk sha
      const det = detectorWithConflictBase(() => v1);
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });

    it("EDITED base (disk ≠ branch value) → emitted", async () => {
      stage("V2", "MAIN-SHA");
      const det = detectorWithConflictBase(() => "OLD-BRANCH-SHA"); // ≠ disk
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("disk == MAIN but ≠ branch value → emitted (main is NOT the reference)", async () => {
      // The essence of §26: matching main does not make a conflict base
      // "unchanged" — only its branch value does.
      const v1 = await shaOf("V1");
      stage("V1", v1); // snapshot.remoteSha == disk (matches main)
      const det = detectorWithConflictBase(() => "DIFFERENT-BRANCH-SHA");
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("resolver returns undefined (not a conflict base) → normal §40 behavior (unchanged vs main → skip)", async () => {
      const v1 = await shaOf("V1");
      stage("V1", v1); // disk == main
      const det = detectorWithConflictBase(() => undefined);
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });
  });
});
