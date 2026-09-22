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
import HotMetadataStore from "../../src/sync2/hot-metadata";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import ChangeDetector, {
  isUnhonouredGitignore,
  isSyncable,
} from "../../src/sync2/change-detector";
import { Vault } from "../../mock-obsidian";
import { calculateGitBlobSHA } from "../../src/utils";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture(): {
  root: string;
  vault: Vault;
  hot: HotMetadataStore;
  store: FileBaselinesStore;
  gi: GI;
  detector: ChangeDetector;
} {
  const root = path.join(
    os.tmpdir(),
    `change-detector-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const hot = new HotMetadataStore({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const store = new FileBaselinesStore({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const gi = new GI(root);
  const detector = new ChangeDetector({
    vault: vault as unknown as import("obsidian").Vault,
    hotMeta: hot,
    baselines: store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: root,
    syncConfigDir: () => true,
  });
  return { root, vault, hot, store, gi, detector };
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
    await f.hot.load();
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

    it("root `.gitignore` is picked up — the control file always is", async () => {
      // Real bug from production: desktop and mobile root `.gitignore`
      // drifted apart for weeks because findChanges never saw edits to
      // it. vault.getFiles() in production Obsidian does not index root
      // dotfiles, and the mock mirrors that gap, so this fails the
      // moment the compensation breaks.
      //
      // ⚠️ INVERTED at Крок B2 for its NEIGHBOURS. It used to assert
      // that EVERY root dotfile syncs — which was D1 turned inside out.
      // Dot-space is invisible by default now; only the control file is
      // structurally a member, and the rest need a `!`-rule (D2/D7).
      writeFile(f.root, ".gitignore", "rule\n");
      writeFile(f.root, ".gitattributes", "* text=auto\n");
      writeFile(f.root, ".editorconfig", "root = true\n");
      writeFile(f.root, "regular.md", "body");
      const out = await f.detector.findChanges();
      expect(out.map((c) => c.path).sort()).toEqual([".gitignore", "regular.md"]);
    });

    it("a root dotfile syncs once a `!`-rule names it, and not before", async () => {
      // D2 source 3 end to end: the opt-in mechanism the whole dot-space
      // design rests on. Without the rule the file is simply invisible —
      // not an error, not a warning, just not ours to carry.
      writeFile(f.root, ".editorconfig", "root = true\n");
      writeFile(f.root, ".gitignore", "rule\n");
      expect((await f.detector.findChanges()).map((c) => c.path).sort()).toEqual(
        [".gitignore"],
      );

      writeFile(f.root, ".gitignore", "rule\n!.editorconfig\n");
      expect((await f.detector.findChanges()).map((c) => c.path).sort()).toEqual(
        [".editorconfig", ".gitignore"],
      );
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

      // ⚠️ INVERTED at Крок B2. This used to assert all four flow
      // through, which is exactly the default-visible behaviour D1
      // replaces. Now: the control file is a structural member, the
      // others wait for a `!`-rule, and `.git` stays blocked by the
      // hardcoded denylist regardless of any rule.
      expect(paths).toEqual([".gitignore"]);

      // Name two of them and they appear; `.git` still cannot be opted
      // in, because the denylist is checked before any of this.
      writeFile(
        f.root,
        ".gitignore",
        "user rule\n!.gitkeep\n!.blabla\n!.git\n",
      );
      expect(
        (await f.detector.findChanges()).map((c) => c.path).sort(),
      ).toEqual([".blabla", ".gitignore", ".gitkeep"]);
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
      await f.store.set("Notes/old.md", {
        baselineSha: sha,
        mtime: oldStat.mtimeMs,
        size: oldStat.size,
      });
      // Watermark equals the file's mtime → file is skipped.
      await f.hot.update({ lastCommitMtime: oldStat.mtimeMs });

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
      await f.store.set("Notes/old.md", {
        baselineSha: oldSha,
        mtime: 1_000_000_000_000,
        size: 2,
      });

      // New file: ahead of watermark.
      writeFile(f.root, "Notes/new.md", "fresh");
      setMtime(f.root, "Notes/new.md", 2_000_000_000_000);

      await f.hot.update({ lastCommitMtime: 1_500_000_000_000 });

      const out = await f.detector.findChanges();
      expect(out).toMatchObject([
        { kind: "added", path: "Notes/new.md" },
      ]);
    });

    it("emits modified when stat moved past watermark and content changed", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      setMtime(f.root, "Notes/x.md", 1_000_000_000_000);
      const oldSha = await shaOf("v1");
      await f.store.set("Notes/x.md", {
        baselineSha: oldSha,
        mtime: 1_000_000_000_000,
        size: 2,
      });
      await f.hot.update({ lastCommitMtime: 1_000_000_000_000 });

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
        await f.store.set(name, {
          baselineSha: await shaOf("v1"),
          mtime: 1_000_000_000_000,
          size: 2,
        });
      }
      await f.hot.update({ lastCommitMtime: 1_000_000_000_000 });
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
      await f.store.set("Notes/x.md", {
        baselineSha: sha,
        mtime: 1_000_000_000_000,
        size: 4,
      });
      await f.hot.update({ lastCommitMtime: 1_000_000_000_000 });

      // Bump mtime without changing content.
      setMtime(f.root, "Notes/x.md", 3_000_000_000_000);

      const out = await f.detector.findChanges();
      expect(out).toEqual([]);
      const refreshed = await f.store.get("Notes/x.md");
      expect(refreshed?.mtime).toBe(3_000_000_000_000);
    });
  });

  describe("findChanges() — Pass 2: snapshot-only paths", () => {
    it("emits deleted when snapshot exists and file is gone", async () => {
      await f.store.set("Notes/gone.md", {
        baselineSha: "abc",
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
      await f.store.set("old.log", {
        baselineSha: "stalesha",
        mtime: 1,
        size: 10,
      });

      const out = await f.detector.findChanges();
      expect(out.find((c) => c.path === "old.log")).toBeUndefined();
      expect(await f.store.get("old.log")).toBeUndefined();
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
      expect(await f.store.get("Notes/x.md")).toBeUndefined();
    });
  });

  describe("recordDeletions()", () => {
    it("snapshot is removed", async () => {
      await f.store.set("Notes/x.md", {
        baselineSha: "abc",
        mtime: 1,
        size: 1,
      });
      await f.detector.recordDeletions(["Notes/x.md"]);
      expect(await f.store.get("Notes/x.md")).toBeUndefined();
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
      await f.store.set("Notes/x.md", {
        baselineSha: await shaOf("v1"),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      expect(await f.detector.findChangeForPath("Notes/x.md")).toBeNull();
    });

    it("file present, mtime moved but content unchanged → null + snapshot mtime refreshed", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      const sha = await shaOf("v1");
      await f.store.set("Notes/x.md", {
        baselineSha: sha,
        mtime: 0,
        size: 2,
      });
      expect(await f.detector.findChangeForPath("Notes/x.md")).toBeNull();
      const stat = fs.statSync(path.join(f.root, "Notes/x.md"));
      expect((await f.store.get("Notes/x.md"))?.mtime).toBe(stat.mtimeMs);
    });

    it("file present, content changed → modified", async () => {
      writeFile(f.root, "Notes/x.md", "v1");
      await f.store.set("Notes/x.md", {
        baselineSha: await shaOf("v1"),
        mtime: 1,
        size: 2,
      });
      writeFile(f.root, "Notes/x.md", "v2-different");
      const out = await f.detector.findChangeForPath("Notes/x.md");
      expect(out?.kind).toBe("modified");
    });

    it("file absent, snapshot exists → deleted", async () => {
      await f.store.set("Notes/gone.md", {
        baselineSha: "OLD",
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
      await f.store.set("drafts/a.md", {
        baselineSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      await f.hot.update({ lastCommitMtime: stat.mtimeMs });

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
      await f.store.set("drafts/note.md", {
        baselineSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      // Snapshot also for .gitignore so the test starts from a "synced"
      // baseline and we can isolate the rename effect.
      const giStat = fs.statSync(path.join(f.root, ".gitignore"));
      const giSha = await shaOf("archive/\n");
      await f.store.set(".gitignore", {
        baselineSha: giSha,
        mtime: giStat.mtimeMs,
        size: giStat.size,
      });
      await f.hot.update({ lastCommitMtime: Math.max(stat.mtimeMs, giStat.mtimeMs) });

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
      await f.store.set(".gitignore", {
        baselineSha: giSha,
        mtime: giStat.mtimeMs,
        size: giStat.size,
      });
      await f.hot.update({ lastCommitMtime: giStat.mtimeMs });

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
      await f.store.set(".gitignore", {
        baselineSha: giSha,
        mtime: giStat.mtimeMs,
        size: giStat.size,
      });
      await f.hot.update({ lastCommitMtime: giStat.mtimeMs });

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
        hotMeta: f.hot,
        baselines: f.store,
        gi: f.gi,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        vaultRoot: f.root,
        syncConfigDir: () => true,
        queue: { peekLatestPathSha: peek },
      });

    // Stage a modified candidate: file ahead of watermark, snapshot at a
    // DIFFERENT (stale) sha so it reaches the queue-dedup check.
    const stageModified = async (content: string): Promise<void> => {
      writeFile(f.root, "a.md", content);
      setMtime(f.root, "a.md", AHEAD);
      await f.store.set("a.md", { baselineSha: "STALE_REMOTE_SHA", mtime: 1, size: 1 });
      await f.hot.update({ lastCommitMtime: WATERMARK });
    };

    it("modified: current bytes == last commit → NOT re-emitted", async () => {
      await stageModified("current");
      const det = detectorWithQueue(async () => await shaOf("current"));
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });

    it("modified: current bytes != last commit → emitted", async () => {
      await stageModified("current");
      const det = detectorWithQueue(async () => "A_DIFFERENT_SHA");
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("revert: current == an OLD version but the last commit is a newer, different version → emitted (preserve-all-commits)", async () => {
      await stageModified("v1"); // disk reverted to v1
      // The queue's LATEST commit of a.md is v3, not v1.
      const det = detectorWithQueue(async () => await shaOf("v3"));
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("added (no snapshot): current bytes == last commit → NOT re-emitted", async () => {
      writeFile(f.root, "a.md", "current");
      setMtime(f.root, "a.md", AHEAD);
      await f.hot.update({ lastCommitMtime: WATERMARK });
      const det = detectorWithQueue(async () => await shaOf("current"));
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });

    it("added (no snapshot): current bytes != last commit → emitted as added", async () => {
      writeFile(f.root, "a.md", "current");
      setMtime(f.root, "a.md", AHEAD);
      await f.hot.update({ lastCommitMtime: WATERMARK });
      const det = detectorWithQueue(async () => "A_DIFFERENT_SHA");
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("added");
    });

    it("no queue wired → falls back to snapshot-only (emits the change)", async () => {
      await stageModified("current");
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
      await f.store.set("a.md", { baselineSha: await shaOf("v1"), mtime: 1, size: 1 });
      await f.hot.update({ lastCommitMtime: WATERMARK });
      const det = detectorWithQueue(async () => await shaOf("v2")); // last commit = v2
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("matches the last push AND nothing newer is queued → NOT emitted", async () => {
      writeFile(f.root, "a.md", "v1");
      setMtime(f.root, "a.md", AHEAD);
      await f.store.set("a.md", { baselineSha: await shaOf("v1"), mtime: 1, size: 1 });
      await f.hot.update({ lastCommitMtime: WATERMARK });
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
        hotMeta: f.hot,
        baselines: f.store,
        gi: f.gi,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        vaultRoot: f.root,
        syncConfigDir: () => true,
        conflictBaseSha: resolver,
      });

    const stage = async (content: string, remoteSha: string): Promise<void> => {
      writeFile(f.root, "a.md", content);
      setMtime(f.root, "a.md", AHEAD_TS);
      await f.store.set("a.md", { baselineSha: remoteSha, mtime: 1, size: 1 });
      await f.hot.update({ lastCommitMtime: WM });
    };

    it("UNCHANGED base (disk == branch value) → NOT emitted, even though disk ≠ main", async () => {
      await stage("V1", "MAIN-SHA");
      const v1 = await shaOf("V1"); // branch value == disk sha
      const det = detectorWithConflictBase(() => v1);
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });

    it("EDITED base (disk ≠ branch value) → emitted", async () => {
      await stage("V2", "MAIN-SHA");
      const det = detectorWithConflictBase(() => "OLD-BRANCH-SHA"); // ≠ disk
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("disk == MAIN but ≠ branch value → emitted (main is NOT the reference)", async () => {
      // The essence of §26: matching main does not make a conflict base
      // "unchanged" — only its branch value does.
      const v1 = await shaOf("V1");
      await stage("V1", v1); // snapshot.remoteSha == disk (matches main)
      const det = detectorWithConflictBase(() => "DIFFERENT-BRANCH-SHA");
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")?.kind).toBe("modified");
    });

    it("resolver returns undefined (not a conflict base) → normal §40 behavior (unchanged vs main → skip)", async () => {
      const v1 = await shaOf("V1");
      await stage("V1", v1); // disk == main
      const det = detectorWithConflictBase(() => undefined);
      const out = await det.findChanges();
      expect(out.find((c) => c.path === "a.md")).toBeUndefined();
    });
  });
});

describe("D6 backstop — a .gitignore syncs only where it is honoured", () => {
  // DOT-FILES §3.2 step 4. `gi` reads exactly three locations (D5), so a
  // .gitignore anywhere else is a control file we do not execute, and
  // shipping one would put a file that LOOKS authoritative on every
  // other device. The managed sections already hide nested ones through
  // the matcher; this holds in the window where the root file is missing
  // or hand-edited, because it does not depend on any file's contents.
  const CD = ".obsidian";

  it("honoured locations: root, configDir, one level under plugins/", () => {
    expect(isUnhonouredGitignore(".gitignore", CD)).toBe(false);
    expect(isUnhonouredGitignore(`${CD}/.gitignore`, CD)).toBe(false);
    expect(isUnhonouredGitignore(`${CD}/plugins/brat/.gitignore`, CD)).toBe(
      false,
    );
  });

  it("everywhere else: hidden", () => {
    expect(isUnhonouredGitignore("notes/.gitignore", CD)).toBe(true);
    expect(isUnhonouredGitignore(".myconfig/.gitignore", CD)).toBe(true);
    expect(isUnhonouredGitignore(`${CD}/snippets/.gitignore`, CD)).toBe(true);
    expect(isUnhonouredGitignore(`${CD}/themes/x/.gitignore`, CD)).toBe(true);
    // Deeper than one segment under plugins/ is not a node `gi` reads.
    expect(
      isUnhonouredGitignore(`${CD}/plugins/brat/sub/.gitignore`, CD),
    ).toBe(true);
  });

  it("only exact basenames — a file merely ending in .gitignore is not one", () => {
    expect(isUnhonouredGitignore("notes/my.gitignore", CD)).toBe(false);
    expect(isUnhonouredGitignore("notes/.gitignore.bak", CD)).toBe(false);
  });
});

describe("conflict siblings: the device label is NOT restricted to [A-Za-z0-9_-]", () => {
  // buildSiblingFilePath only swaps parentheses for brackets — a space,
  // an apostrophe, Cyrillic, all pass through into the filename. The
  // hardcoded belt in isSyncable used to demand [A-Za-z0-9_-] for the
  // label, so any such sibling was invisible to it and rode on the
  // `*.conflict-from-*` gitignore rule alone. Two layers, one broken.
  const syncable = async (p: string) => {
    const gi = new GI("");
    return isSyncable(
      p,
      ".obsidian",
      "git-easy-sync",
      true,
      gi,
      async () => null,
      // Siblings are ordinary (non-dot) paths, so D7 never looks at the
      // set here; it only has to exist.
      { dotFiles: new Set(), walkTargets: new Set() },
    );
  };
  const TS = "2026-01-01T00-00-00Z";

  it.each([
    ["Home iMac", "a space — the case that started this"],
    ["Вовин ноут", "Cyrillic"],
    ["Bob's Mac", "an apostrophe"],
    ["[work]", "brackets, what parentheses become"],
    ["plain-Label_1", "the alphabet the old pattern allowed"],
  ])("label %j (%s) → sibling is NOT syncable", async (label) => {
    expect(await syncable(`note.conflict-from-${label}-${TS}.md`)).toBe(false);
    // ...at any depth, and with no extension either.
    expect(await syncable(`deep/dir/note.conflict-from-${label}-${TS}`)).toBe(
      false,
    );
  });

  it("still does not swallow ordinary files that merely look similar", async () => {
    // What makes the shape unambiguous is the trailing ISO timestamp,
    // not the label's alphabet — so widening the label cannot widen the
    // false-positive surface.
    expect(await syncable("notes/conflict-from-someone.md")).toBe(true);
    expect(await syncable(`notes/a.conflict-from-x-2026-01-01.md`)).toBe(true);
    expect(await syncable(`notes/a.conflict-from-x-${TS}/inside.md`)).toBe(
      true,
    );
  });
});

describe("D7 — no permission without discoverability (DOT-FILES §3.2 step 5)", () => {
  // The most important invariant in the dot-space design, and the one
  // that is destructive when absent: a path that answers "syncable" but
  // that no scan ever visits sits in the baselines, misses Pass 1, and
  // Pass 2 reads it as deleted — propagating the delete to every device.
  // Losing the anchor off `!/.myconfig/` is a one-character edit.
  const CD = ".obsidian";
  const set = (dotFiles: string[], walkTargets: string[]) => ({
    dotFiles: new Set(dotFiles),
    walkTargets: new Set(walkTargets),
  });
  const ask = (p: string, optIn: ReturnType<typeof set> | null) =>
    isSyncable(p, CD, "git-easy-sync", true, new GI(""), async () => null, optIn);

  it("TD7.1 — an unanchored dot-dir rule grants nothing", async () => {
    // `!.myconfig/` would have matched at any depth; the set that comes
    // out of it is empty, so the path is not permitted either.
    expect(await ask(".myconfig/foo.md", set([], []))).toBe(false);
  });

  it("TD7.2 — a glob grants nothing", async () => {
    expect(await ask(".foo", set([], []))).toBe(false);
    expect(await ask("notes/.foo/x.md", set([], []))).toBe(false);
  });

  it("TD7.3 — a dot-file in an ordinary subfolder is not reachable", async () => {
    expect(await ask("notes/.secret", set([], []))).toBe(false);
  });

  it("TD7.4 — an anchored dot-dir IS a walk target, so its content is permitted", async () => {
    const s = set([], [".myconfig"]);
    expect(await ask(".myconfig/foo.md", s)).toBe(true);
    expect(await ask(".myconfig/deep/bar.md", s)).toBe(true);
    // ...and a sibling that merely shares the prefix is not.
    expect(await ask(".myconfigX/foo.md", s)).toBe(false);
  });

  it("a named dot-FILE is permitted; its neighbours are not", async () => {
    const s = set([".editorconfig"], []);
    expect(await ask(".editorconfig", s)).toBe(true);
    expect(await ask(".gitattributes", s)).toBe(false);
  });

  it("ordinal paths never consult the set at all", async () => {
    expect(await ask("notes/a.md", set([], []))).toBe(true);
  });

  it("TD7.5 — an unpopulated set THROWS; it does not quietly answer false", async () => {
    // Fail-loud is the point. Answering "false" would take the whole
    // dot-space out of scope, Pass 2 would treat every dot-path as
    // gone, and the cause would be a missing call several layers away.
    await expect(ask(".editorconfig", null)).rejects.toThrow(/beginScan/);
    // ...but an ordinal path never reaches the check, so a caller that
    // only handles ordinary files is not punished for someone else's
    // lifecycle bug.
    await expect(ask("notes/a.md", null)).resolves.toBe(true);
  });

  it("`<configDir>/` is answered by the hardcoded gate, not by the set", async () => {
    // Step 3 is the real authority there. Keeping step 5's exemption
    // explicit means it does not depend on how the set was built.
    expect(await ask(`${CD}/app.json`, set([], []))).toBe(true);
    expect(
      await isSyncable(
        `${CD}/app.json`,
        CD,
        "git-easy-sync",
        false, // syncConfigDir OFF
        new GI(""),
        async () => null,
        set([], []),
      ),
    ).toBe(false);
  });
});

describe("pass 3 — walkDotDir: only what was opted in, and no way to hang", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  const paths = async () =>
    (await f.detector.findChanges()).map((c) => c.path).sort();

  it("an anchored `!/.myconfig/` is walked; an unanchored one is not", async () => {
    writeFile(f.root, ".myconfig/note.md", "a");
    writeFile(f.root, ".myconfig/deep/inner.md", "b");

    writeFile(f.root, ".gitignore", "!.myconfig/\n"); // unanchored
    expect(await paths()).toEqual([".gitignore"]);

    writeFile(f.root, ".gitignore", "!/.myconfig/\n"); // anchored
    expect(await paths()).toEqual([
      ".gitignore",
      ".myconfig/deep/inner.md",
      ".myconfig/note.md",
    ]);
  });

  it("D3 prune: a dot-SUBdirectory inside a target is not descended into", async () => {
    // Nested dot-dirs stay hidden unless named again — and naming one
    // makes it a target in its own right, so descending here would both
    // double-visit it and reach dot-dirs nobody opted into.
    writeFile(f.root, ".myconfig/ok.md", "a");
    writeFile(f.root, ".myconfig/.secret/hidden.md", "b");
    writeFile(f.root, ".gitignore", "!/.myconfig/\n");
    expect(await paths()).toEqual([".gitignore", ".myconfig/ok.md"]);

    // Named again → its own target → now it is walked. (`.*` in the
    // managed section would still hide it from the matcher, so the rule
    // has to re-admit it there too; here the fixture has no dot-hide.)
    writeFile(f.root, ".gitignore", "!/.myconfig/\n!/.myconfig/.secret/\n");
    expect(await paths()).toEqual([
      ".gitignore",
      ".myconfig/.secret/hidden.md",
      ".myconfig/ok.md",
    ]);
  });

  it("a deep tree terminates instead of running away", async () => {
    // The depth cap exists so a symlink loop cannot hang the sync. A
    // loop cannot be built portably in a test, but the cap is the thing
    // that actually terminates one, so this pins that it holds and that
    // ordinary depth is unaffected.
    let deep = ".myconfig";
    for (let i = 0; i < 70; i++) deep += `/d${i}`;
    writeFile(f.root, `${deep}/far.md`, "x");
    writeFile(f.root, ".myconfig/near.md", "y");
    writeFile(f.root, ".gitignore", "!/.myconfig/\n");

    const out = await paths();
    expect(out).toContain(".myconfig/near.md");
    expect(out).not.toContain(`${deep}/far.md`);
  });
});

describe("TD4.3 — a root dotfile that is no longer opted in leaves scope SILENTLY", () => {
  // The behaviour change that came with deleting `walkRootDotfiles`.
  // That walk listed the vault root and took every dotfile it found,
  // which made dot-space default-VISIBLE there — the opposite of D1. So
  // a `.editorconfig` synced by an older version is now out of scope.
  //
  // Out of scope must mean a silent `store.remove`, NOT a `deleted`
  // change: emitting the delete would erase the file from the remote
  // and from every other device, over a rule the user never wrote.
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("drops the baseline row and emits nothing", async () => {
    writeFile(f.root, ".editorconfig", "root = true\n");
    writeFile(f.root, ".gitignore", "");
    // It was synced once, by a version that took every root dotfile.
    await f.store.set(".editorconfig", {
      baselineSha: await shaOf("root = true\n"),
      mtime: 1,
      size: 1,
    });

    const out = await f.detector.findChanges();
    expect(out.map((c) => c.path)).not.toContain(".editorconfig");
    expect(out.some((c) => c.kind === "deleted")).toBe(false);
    // ...and the stale row is gone, so it stops being reconsidered.
    expect(await f.store.get(".editorconfig")).toBeFalsy();
    // The file itself is untouched on disk — leaving scope is not
    // deleting.
    expect(fs.existsSync(path.join(f.root, ".editorconfig"))).toBe(true);
  });

  it("naming it again brings it back without any special case", async () => {
    writeFile(f.root, ".editorconfig", "root = true\n");
    writeFile(f.root, ".gitignore", "!/.editorconfig\n");
    const out = await f.detector.findChanges();
    expect(out.map((c) => c.path)).toContain(".editorconfig");
  });
});

describe("Pass 2 belt — an interrupted walk is not a mass deletion (§3.3)", () => {
  // D7 answers "is this path reachable in principle". The belt answers
  // a different question: "did we actually manage to look, this pass".
  // A configured target whose walk dies half-way leaves its subtree
  // unvisited, and from Pass 2's seat unvisited is indistinguishable
  // from deleted — so the belt makes it conclude nothing at all.
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  // Make ONE directory's listing throw, leaving the rest of the vault
  // enumerable — the shape of a folder vanishing mid-walk on Android.
  const breakListingOf = (dir: string) => {
    const real = f.vault.adapter;
    const wrapped = {
      ...real,
      list: async (p: string) => {
        if (p === dir) throw new Error("EPERM: simulated mid-walk failure");
        return real.list(p);
      },
    };
    Object.defineProperty(f.vault, "adapter", { get: () => wrapped });
  };

  it("a failed target's snapshot paths are neither deleted nor forgotten", async () => {
    writeFile(f.root, ".myconfig/note.md", "a");
    writeFile(f.root, ".gitignore", "!/.myconfig/\n");
    await f.store.set(".myconfig/note.md", {
      baselineSha: await shaOf("a"),
      mtime: 1,
      size: 1,
    });

    breakListingOf(".myconfig");
    const out = await f.detector.findChanges();

    expect(out.some((c) => c.path === ".myconfig/note.md")).toBe(false);
    expect(out.some((c) => c.kind === "deleted")).toBe(false);
    // The row survives: it is still true as far as we know, and the
    // next pass looks again.
    expect(await f.store.get(".myconfig/note.md")).toBeTruthy();
  });

  it("configDir is a target like any other, and the belt covers it", async () => {
    // The one that historically threw: Obsidian rewriting its own
    // config mid-walk on Android. Before B2 configDir was walked by a
    // hardcoded branch; it is a walk target now, and the belt has to
    // reach it or a transient listing failure deletes the user's
    // config from every device.
    writeFile(f.root, `${CONFIG_DIR}/app.json`, "{}");
    writeFile(f.root, ".gitignore", "");
    await f.store.set(`${CONFIG_DIR}/app.json`, {
      baselineSha: await shaOf("{}"),
      mtime: 1,
      size: 1,
    });
    breakListingOf(CONFIG_DIR);

    const out = await f.detector.findChanges();
    expect(out.some((c) => c.kind === "deleted")).toBe(false);
    expect(await f.store.get(`${CONFIG_DIR}/app.json`)).toBeTruthy();
  });

  it("PER TARGET: a healthy target still reports its real deletions", async () => {
    // A single boolean would have protected both targets, masking a
    // genuine delete under the one that walked fine. That is why the
    // belt is keyed by target.
    writeFile(f.root, ".myconfig/note.md", "a");
    writeFile(f.root, ".other/gone.md", "b");
    writeFile(f.root, ".gitignore", "!/.myconfig/\n!/.other/\n");
    await f.store.set(".myconfig/note.md", {
      baselineSha: await shaOf("a"),
      mtime: 1,
      size: 1,
    });
    await f.store.set(".other/gone.md", {
      baselineSha: await shaOf("b"),
      mtime: 1,
      size: 1,
    });
    // `.other` walks fine, and its file really is gone from disk.
    fs.rmSync(path.join(f.root, ".other/gone.md"));
    breakListingOf(".myconfig");

    const out = await f.detector.findChanges();
    const deleted = out.filter((c) => c.kind === "deleted").map((c) => c.path);
    expect(deleted).toEqual([".other/gone.md"]);
  });

  it("reports the incomplete target, so a persistent failure is visible", async () => {
    const seen: string[] = [];
    const detector = new ChangeDetector({
      vault: f.vault as unknown as import("obsidian").Vault,
      hotMeta: f.hot,
      baselines: f.store,
      gi: f.gi,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
      vaultRoot: f.root,
      syncConfigDir: () => true,
      logWalkIncomplete: (t) => seen.push(t),
    });
    writeFile(f.root, ".myconfig/note.md", "a");
    writeFile(f.root, ".gitignore", "!/.myconfig/\n");
    breakListingOf(".myconfig");
    await detector.findChanges();
    expect(seen).toEqual([".myconfig"]);
  });
});

describe("scope belongs to the OPERATION, not to the detector", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("the fail-loud still fires AFTER a successful scan", async () => {
    // Left set, `optIn` would outlive its operation and the guard would
    // fire exactly once per process: every later lifecycle bug would
    // silently reuse the PREVIOUS operation's scope — the stale-set
    // state TD7.5 exists to make loud.
    writeFile(f.root, ".gitignore", "");
    await f.detector.findChanges();
    await expect(f.detector.checkSyncable(".editorconfig")).rejects.toThrow(
      /beginScan/,
    );
  });

  it("a scan that throws still releases the scope", async () => {
    writeFile(f.root, ".gitignore", "");
    const real = f.vault.adapter;
    const wrapped = {
      ...real,
      list: async () => {
        throw new Error("boom");
      },
    };
    Object.defineProperty(f.vault, "adapter", {
      get: () => wrapped,
      configurable: true,
    });
    await f.detector.findChanges().catch(() => undefined);
    Object.defineProperty(f.vault, "adapter", {
      get: () => real,
      configurable: true,
    });
    await expect(f.detector.checkSyncable(".editorconfig")).rejects.toThrow(
      /beginScan/,
    );
  });

  it("a fresh scan sees a rule added since the last one", async () => {
    // The matcher holds a parsed level by mtime for up to 500 ms, so
    // without invalidating the root node at scan start the set and `gi`
    // could answer from different generations of the file the user just
    // edited.
    writeFile(f.root, ".editorconfig", "root = true\n");
    writeFile(f.root, ".gitignore", "");
    expect((await f.detector.findChanges()).map((c) => c.path)).not.toContain(
      ".editorconfig",
    );
    writeFile(f.root, ".gitignore", "!/.editorconfig\n");
    expect((await f.detector.findChanges()).map((c) => c.path)).toContain(
      ".editorconfig",
    );
  });
});
