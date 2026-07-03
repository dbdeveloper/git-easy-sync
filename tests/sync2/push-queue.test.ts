import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import PushQueue from "../../src/sync2/push-queue";
import { Vault } from "../../mock-obsidian";
import { FileChange } from "../../src/sync2/types";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture(): {
  root: string;
  vault: Vault;
  queue: PushQueue;
  queueRoot: string;
  clock: { tick: () => Date; set: (d: Date) => void };
} {
  const root = path.join(
    os.tmpdir(),
    `push-queue-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let current = new Date("2026-05-03T09:38:23.000Z");
  const clock = {
    tick: () => {
      const d = new Date(current);
      current = new Date(current.getTime() + 1000);
      return d;
    },
    set: (d: Date) => {
      current = d;
    },
  };
  const queue = new PushQueue({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
  });
  const queueRoot = path.join(
    root,
    CONFIG_DIR,
    "plugins",
    SELF_PLUGIN_ID,
    ".runtime/push-queue",
  );
  return { root, vault, queue, queueRoot, clock };
}

function writeVaultFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const ADD = (p: string): FileChange => ({
  kind: "added",
  path: p,
  size: 0,
  mtime: 0,
});

const MOD = (p: string, prevSha = "old"): FileChange => ({
  kind: "modified",
  path: p,
  size: 0,
  mtime: 0,
  previousRemoteSha: prevSha,
});

const DEL = (p: string, prevSha = "old"): FileChange => ({
  kind: "deleted",
  path: p,
  previousRemoteSha: prevSha,
});

describe("PushQueue", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  describe("enqueue + read", () => {
    it("creates a batch directory with vault/, .meta.json, and the file", async () => {
      writeVaultFile(f.root, "Notes/x.md", "hello\n");
      const id = await f.queue.enqueue([ADD("Notes/x.md")], {
        parentCommitSha: "abc123",
        parentTreeSha: "def456",
      });
      expect(id).toMatch(/^\d{17}$/);

      const batchDir = path.join(f.queueRoot, id);
      expect(fs.existsSync(batchDir)).toBe(true);
      expect(fs.existsSync(path.join(batchDir, ".meta.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(batchDir, "vault", "Notes", "x.md")),
      ).toBe(true);
      expect(
        fs.readFileSync(path.join(batchDir, "vault", "Notes", "x.md"), "utf8"),
      ).toBe("hello\n");
    });

    it("read() returns the QueueBatch shape", async () => {
      writeVaultFile(f.root, "x.md", "v1\n");
      const id = await f.queue.enqueue(
        [ADD("x.md"), DEL("Folder/old.md")],
        {
          parentCommitSha: "abc",
          parentTreeSha: "def",
        },
      );

      const batch = await f.queue.read(id);
      expect(batch).toMatchObject({
        id,
        inProgress: false,
        parentCommitSha: "abc",
        parentTreeSha: "def",
        files: ["x.md"],
        deletions: ["Folder/old.md"],
      });
    });

    it("handles binary files via writeBinary", async () => {
      // .png — non-text by hasTextExtension
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const abs = path.join(f.root, "img.png");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("img.png")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "img.png"),
      );
      expect(stored.equals(bytes)).toBe(true);
    });

    it("handles deletions-only batch (no vault/ files, just deleted-paths.txt)", async () => {
      const id = await f.queue.enqueue(
        [DEL("a.md"), DEL("b.md")],
        {
          parentCommitSha: null,
          parentTreeSha: null,
        },
      );
      const batch = await f.queue.read(id);
      expect(batch.files).toEqual([]);
      expect(batch.deletions.sort()).toEqual(["a.md", "b.md"]);
    });

    it("preserves nested directory structure", async () => {
      writeVaultFile(f.root, "Folder/Deep/Nested/note.md", "z\n");
      const id = await f.queue.enqueue(
        [ADD("Folder/Deep/Nested/note.md")],
        {
          parentCommitSha: null,
          parentTreeSha: null,
        },
      );
      const stored = fs.readFileSync(
        path.join(
          f.queueRoot,
          id,
          "vault",
          "Folder",
          "Deep",
          "Nested",
          "note.md",
        ),
        "utf8",
      );
      expect(stored).toBe("z\n");
    });
  });

  describe("list", () => {
    it("returns empty when queue dir doesn't exist", async () => {
      expect(await f.queue.list()).toEqual([]);
    });

    it("returns IDs in chronological (lexicographic) order", async () => {
      writeVaultFile(f.root, "a.md", "1");
      writeVaultFile(f.root, "b.md", "2");
      writeVaultFile(f.root, "c.md", "3");
      const id1 = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      const id2 = await f.queue.enqueue([ADD("b.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      const id3 = await f.queue.enqueue([ADD("c.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      expect(await f.queue.list()).toEqual([id1, id2, id3]);
    });

    it("ignores stray non-batch entries inside the queue root", async () => {
      writeVaultFile(f.root, "a.md", "1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      // Drop a stray dotfile alongside the batch.
      fs.writeFileSync(path.join(f.queueRoot, ".DS_Store"), "");
      fs.mkdirSync(path.join(f.queueRoot, "scratch"), { recursive: true });
      expect(await f.queue.list()).toEqual([id]);
    });

    it("colliding timestamps get bumped to the next millisecond", async () => {
      writeVaultFile(f.root, "a.md", "1");
      writeVaultFile(f.root, "b.md", "2");
      // Lock the clock so consecutive enqueues see the same now()
      // value; PushQueue should resolve the conflict by stepping.
      const fixed = new Date("2026-05-03T09:38:23.500Z");
      f.clock.set(fixed);
      const id1 = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      f.clock.set(fixed);
      const id2 = await f.queue.enqueue([ADD("b.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      expect(id1).not.toBe(id2);
      expect(id2 > id1).toBe(true);
    });
  });

  describe("markInProgress / clearInProgress", () => {
    it("marker survives across PushQueue instances", async () => {
      writeVaultFile(f.root, "a.md", "1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      await f.queue.markInProgress(id);
      // Fresh PushQueue using the same vault sees the marker.
      const other = new PushQueue({
        vault: f.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      const batch = await other.read(id);
      expect(batch.inProgress).toBe(true);
    });

    it("clearInProgress removes the marker; double-clear is safe", async () => {
      writeVaultFile(f.root, "a.md", "1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      await f.queue.markInProgress(id);
      await f.queue.clearInProgress(id);
      await f.queue.clearInProgress(id); // no-op, no throw
      const batch = await f.queue.read(id);
      expect(batch.inProgress).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes the batch directory and everything inside", async () => {
      writeVaultFile(f.root, "Folder/x.md", "1");
      const id = await f.queue.enqueue([ADD("Folder/x.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      expect(fs.existsSync(path.join(f.queueRoot, id))).toBe(true);
      await f.queue.delete(id);
      expect(fs.existsSync(path.join(f.queueRoot, id))).toBe(false);
      expect(await f.queue.list()).toEqual([]);
    });

    it("deleting a missing batch is a no-op", async () => {
      await expect(f.queue.delete("doesnotexist")).resolves.not.toThrow();
    });
  });

  describe("mergeIntoLatestPending", () => {
    it("returns null when there is no pending batch", async () => {
      expect(await f.queue.mergeIntoLatestPending([ADD("a.md")])).toBeNull();
    });

    it("merges new uploads into the latest pending batch", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      writeVaultFile(f.root, "b.md", "fresh");
      const target = await f.queue.mergeIntoLatestPending([ADD("b.md")]);
      expect(target).toBe(id);

      const batch = await f.queue.read(id);
      expect(batch.files.sort()).toEqual(["a.md", "b.md"]);
    });

    it("re-snapshots a path on overwrite", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      writeVaultFile(f.root, "a.md", "v2\n");
      await f.queue.mergeIntoLatestPending([MOD("a.md", "old")]);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(stored).toBe("v2\n");
    });

    it("a deletion overrides a prior upload of the same path", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      await f.queue.mergeIntoLatestPending([DEL("a.md")]);

      const batch = await f.queue.read(id);
      expect(batch.files).toEqual([]);
      expect(batch.deletions).toEqual(["a.md"]);
      expect(
        fs.existsSync(path.join(f.queueRoot, id, "vault", "a.md")),
      ).toBe(false);
    });

    it("an upload overrides a prior deletion of the same path", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([DEL("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      writeVaultFile(f.root, "a.md", "resurrected");
      await f.queue.mergeIntoLatestPending([ADD("a.md")]);

      const batch = await f.queue.read(id);
      expect(batch.files).toEqual(["a.md"]);
      expect(batch.deletions).toEqual([]);
    });

    it("skips in-progress batches and returns null if all are in-progress", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      await f.queue.markInProgress(id);
      writeVaultFile(f.root, "b.md", "v2");
      const target = await f.queue.mergeIntoLatestPending([ADD("b.md")]);
      expect(target).toBeNull();
    });
  });

  // ─── enqueueSynthetic — Phase B side-batch foundation ──────────────
  //
  // Contract:
  //   - Single path per synthetic batch.
  //   - `synthetic: true` in meta.json so mergeIntoLatestPending skips it.
  //   - Never folds with subsequent user mergeIntoLatestPending calls.
  //   - Returns batch id (timestamp-based, same format as enqueue()).
  // See src/sync2/push-queue.ts for the full API doc.
  describe("enqueueSynthetic", () => {
    it("creates batch with synthetic=true and returns id (content variant)", async () => {
      const content = new TextEncoder().encode("resolved theirs\n");
      const id = await f.queue.enqueueSynthetic({
        path: "Notes/note.md",
        content: new Uint8Array(content),
        contentSha: "fakesha-1234",
        parentCommitSha: "parent-commit-sha",
        parentTreeSha: "parent-tree-sha",
      });

      // Same id shape as regular batches.
      expect(id).toMatch(/^\d{17}$/);

      const batchDir = path.join(f.queueRoot, id);
      expect(fs.existsSync(batchDir)).toBe(true);

      // Vault content landed under batch/vault/.
      const stored = fs.readFileSync(
        path.join(batchDir, "vault", "Notes", "note.md"),
        "utf8",
      );
      expect(stored).toBe("resolved theirs\n");

      // Meta carries synthetic=true and parent SHAs.
      const meta = JSON.parse(
        fs.readFileSync(path.join(batchDir, ".meta.json"), "utf8"),
      ) as { synthetic?: boolean; parentCommitSha?: string; parentTreeSha?: string };
      expect(meta.synthetic).toBe(true);
      expect(meta.parentCommitSha).toBe("parent-commit-sha");
      expect(meta.parentTreeSha).toBe("parent-tree-sha");
    });

    it("content=null variant records a deletion in deleted-paths.txt", async () => {
      const id = await f.queue.enqueueSynthetic({
        path: "Notes/gone.md",
        content: null,
        contentSha: null,
        parentCommitSha: "p1",
        parentTreeSha: "t1",
      });

      const batchDir = path.join(f.queueRoot, id);
      expect(fs.existsSync(batchDir)).toBe(true);

      // Vault file absent — this is a deletion synthetic batch.
      expect(
        fs.existsSync(path.join(batchDir, "vault", "Notes", "gone.md")),
      ).toBe(false);

      // Deletion recorded.
      const deletions = fs
        .readFileSync(path.join(batchDir, "deleted-paths.txt"), "utf8")
        .split("\n")
        .filter(Boolean);
      expect(deletions).toEqual(["Notes/gone.md"]);

      // Meta still marks it synthetic.
      const meta = JSON.parse(
        fs.readFileSync(path.join(batchDir, ".meta.json"), "utf8"),
      ) as { synthetic?: boolean };
      expect(meta.synthetic).toBe(true);
    });

    it("mergeIntoLatestPending returns null when only pending batch is synthetic", async () => {
      // Phase B-style: synthetic batch sits in queue, drain hasn't
      // processed it yet (e.g., offline). User changes nothing; calls
      // sync again. enqueueOrMerge → mergeIntoLatestPending must NOT
      // fold into the synthetic batch.
      const buf = new TextEncoder().encode("resolved\n");
      await f.queue.enqueueSynthetic({
        path: "Notes/note.md",
        content: new Uint8Array(buf),
        contentSha: "sha-syn",
        parentCommitSha: "p1",
        parentTreeSha: "t1",
      });

      writeVaultFile(f.root, "Other/edit.md", "user later\n");
      const target = await f.queue.mergeIntoLatestPending([ADD("Other/edit.md")]);

      expect(target).toBeNull();
    });

    it("mergeIntoLatestPending picks the user batch, skipping the synthetic batch", async () => {
      // Two batches sit in queue: a user batch (older) and a synthetic
      // batch (younger). enqueueOrMerge should fold subsequent user
      // changes into the USER batch, even though the synthetic one is
      // the youngest pending non-attempted entry.
      writeVaultFile(f.root, "a.md", "v1\n");
      const userId = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: "p0",
        parentTreeSha: "t0",
      });

      // Synthetic batch lands AFTER user batch (drain Phase B during
      // the same drain).
      const synBuf = new TextEncoder().encode("resolved\n");
      const synId = await f.queue.enqueueSynthetic({
        path: "Notes/note.md",
        content: new Uint8Array(synBuf),
        contentSha: "sha-syn",
        parentCommitSha: "p1",
        parentTreeSha: "t1",
      });

      // Sanity: synId is lexicographically greater than userId.
      expect(synId > userId).toBe(true);

      writeVaultFile(f.root, "b.md", "v2\n");
      const target = await f.queue.mergeIntoLatestPending([ADD("b.md")]);

      // Folds into USER batch (skips synthetic).
      expect(target).toBe(userId);

      // User batch now has both files.
      const userBatch = await f.queue.read(userId);
      expect(userBatch.files.sort()).toEqual(["a.md", "b.md"]);

      // Synthetic batch is unchanged (still single path).
      const synBatch = await f.queue.read(synId);
      expect(synBatch.files).toEqual(["Notes/note.md"]);
    });
  });

  describe("overwriteFile", () => {
    it("replaces a file's content inside an existing batch", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const newContent = new TextEncoder().encode("merged content\n")
        .buffer as ArrayBuffer;
      await f.queue.overwriteFile(id, "a.md", newContent);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(stored).toBe("merged content\n");
    });

    it("creates intermediate directories when overwriting a deeply nested file", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = new TextEncoder().encode("deep\n").buffer as ArrayBuffer;
      await f.queue.overwriteFile(id, "Folder/Deep/Nested/note.md", buf);

      const stored = fs.readFileSync(
        path.join(
          f.queueRoot,
          id,
          "vault",
          "Folder",
          "Deep",
          "Nested",
          "note.md",
        ),
        "utf8",
      );
      expect(stored).toBe("deep\n");
    });
  });

  // ── text canonicalisation — text canonicalisation -------------------------------
  // Push side: any non-canonical text file (CRLF / BOM / missing
  // trailing-NL) gets normalized into the snapshot AND written back to
  // the live vault file. Binaries are byte-exact regardless of byte
  // patterns that might look like CRLF. overwriteFile normalizes the
  // text input as a safety net for cascade-rebase callers.
  describe("text canonicalisation (text canonicalisation)", () => {
    it("CRLF in vault → snapshot has LF, vault file rewritten to LF", async () => {
      writeVaultFile(f.root, "a.md", "first\r\nsecond\r\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // Snapshot is canonical.
      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("first\nsecond\n");

      // Live vault file is also canonical (write-back invariant).
      const live = fs.readFileSync(path.join(f.root, "a.md"), "utf8");
      expect(live).toBe("first\nsecond\n");
    });

    it("config-dir text (.obsidian/**) is NOT canonicalized — CRLF preserved, no write-back", async () => {
      // Autogenerated Obsidian config (app.json, etc.) must be left byte-exact: the
      // trailing-NL rule fights Obsidian's own rewrites → churn on files the user never
      // edits. Same setup as the CRLF test above (autoCanonicalize defaults ON), but
      // under the config dir → shouldCanonicalize() returns false.
      const raw = '{\r\n  "x": 1\r\n}'; // CRLF + no trailing newline
      writeVaultFile(f.root, ".obsidian/app.json", raw);
      const id = await f.queue.enqueue([ADD(".obsidian/app.json")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // Snapshot keeps the RAW bytes (no LF conversion, no trailing-NL added).
      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", ".obsidian/app.json"),
        "utf8",
      );
      expect(snapshot).toBe(raw);
      // Live vault file is untouched.
      const live = fs.readFileSync(path.join(f.root, ".obsidian/app.json"), "utf8");
      expect(live).toBe(raw);
    });

    it("a config-dir SUBDIR (e.g. the plugin's own styles.css) is also left raw", async () => {
      const raw = "body{}\r\nno-trailing-nl"; // CRLF + no trailing newline
      writeVaultFile(f.root, ".obsidian/plugins/some-plugin/styles.css", raw);
      const id = await f.queue.enqueue([ADD(".obsidian/plugins/some-plugin/styles.css")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });
      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", ".obsidian/plugins/some-plugin/styles.css"),
        "utf8",
      );
      expect(snapshot).toBe(raw);
    });

    it("UTF-8 BOM at start → stripped from both snapshot and vault", async () => {
      // The BOM as raw bytes EF BB BF.
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("title\n", "utf-8"),
      ]);
      const abs = path.join(f.root, "doc.md");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("doc.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "doc.md"),
      );
      expect(snapshot.equals(Buffer.from("title\n", "utf-8"))).toBe(true);

      const live = fs.readFileSync(abs);
      expect(live.equals(Buffer.from("title\n", "utf-8"))).toBe(true);
    });

    it("missing trailing newline → added in both snapshot and vault", async () => {
      writeVaultFile(f.root, "a.md", "no trailing nl");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("no trailing nl\n");

      const live = fs.readFileSync(path.join(f.root, "a.md"), "utf8");
      expect(live).toBe("no trailing nl\n");
    });

    it("empty file stays empty (no \\n added)", async () => {
      writeVaultFile(f.root, "empty.md", "");
      const id = await f.queue.enqueue([ADD("empty.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "empty.md"),
        "utf8",
      );
      expect(snapshot).toBe("");

      const live = fs.readFileSync(path.join(f.root, "empty.md"), "utf8");
      expect(live).toBe("");
    });

    it("already-canonical text → vault file is NOT rewritten (mtime preserved)", async () => {
      // Skip the rewrite when nothing changes — preserves mtime so
      // ChangeDetector's stat-cache shortcut keeps working.
      writeVaultFile(f.root, "a.md", "clean\n");
      const abs = path.join(f.root, "a.md");
      const mtimeBefore = fs.statSync(abs).mtimeMs;

      // Wait a tick so a stray write would visibly bump mtime.
      await new Promise((r) => setTimeout(r, 25));

      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const mtimeAfter = fs.statSync(abs).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("clean\n");
    });

    it("binary file with CRLF-like bytes is byte-exact, not normalized", async () => {
      // Binary file (PNG-extension) whose contents happen to contain
      // 0x0D 0x0A pairs. Those are bytes, not line endings — must NOT
      // be touched by normalize.
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, // PNG magic
        0x0d, 0x0a,             // CR LF — incidental byte pair
        0x1a, 0x0a,             // EOF marker, then LF byte
        0xef, 0xbb, 0xbf,       // BOM bytes mid-stream
        0x00, 0x01, 0x02, 0x03, // body
      ]);
      const abs = path.join(f.root, "img.png");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("img.png")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "img.png"),
      );
      expect(snapshot.equals(bytes)).toBe(true);

      // Live file untouched.
      const live = fs.readFileSync(abs);
      expect(live.equals(bytes)).toBe(true);
    });

    it("mergeIntoLatestPending normalizes the re-snapshotted text too", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // User pastes CRLF into the file then triggers Sync (offline
      // accumulate path). Snapshot of v2 must be canonical.
      writeVaultFile(f.root, "a.md", "v2-line1\r\nv2-line2\r\n");
      await f.queue.mergeIntoLatestPending([MOD("a.md", "old")]);

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("v2-line1\nv2-line2\n");

      const live = fs.readFileSync(path.join(f.root, "a.md"), "utf8");
      expect(live).toBe("v2-line1\nv2-line2\n");
    });

    it("overwriteFile normalizes non-canonical text input (cascade-rebase safety net)", async () => {
      writeVaultFile(f.root, "a.md", "seed\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // Caller passes content with CRLF + BOM + no trailing NL —
      // overwriteFile normalizes before storing in the snapshot.
      const dirty = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("merged-line-1\r\nmerged-line-2", "utf-8"),
      ]);
      const ab = dirty.buffer.slice(
        dirty.byteOffset,
        dirty.byteOffset + dirty.byteLength,
      ) as ArrayBuffer;
      await f.queue.overwriteFile(id, "a.md", ab);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(stored).toBe("merged-line-1\nmerged-line-2\n");
    });

    it("overwriteFile leaves binary content byte-exact even with CRLF-like bytes", async () => {
      writeVaultFile(f.root, "a.md", "seed\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const bytes = Buffer.from([0x89, 0x0d, 0x0a, 0xef, 0xbb, 0xbf, 0xff]);
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await f.queue.overwriteFile(id, "img.png", ab);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "img.png"),
      );
      expect(stored.equals(bytes)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // PushQueue.readFile — coverage for the upload-path read step.
  //
  // Sync2 reconcile calls readFile to obtain the "ours" side bytes
  // from the batch snapshot. The implementation routes through
  // `fetch(getResourcePath(...))` on Obsidian (desktop + mobile)
  // to bypass a known Capacitor `readBinary` deadlock; in unit
  // tests the mock adapter doesn't expose getResourcePath so
  // readFile transparently falls through to `readBinary`. Both
  // branches need byte-exact round-trips across the file-shape
  // matrix (size, type, path).
  // ────────────────────────────────────────────────────────────────
  describe("readFile — round-trip integrity (readBinary fallback path)", () => {
    it("small markdown file: bytes match what was enqueued", async () => {
      const content = "# Title\n\nbody line one\nbody line two\n";
      writeVaultFile(f.root, "Notes/small.md", content);
      const id = await f.queue.enqueue([ADD("Notes/small.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, "Notes/small.md");
      expect(new TextDecoder().decode(buf)).toBe(content);
      expect(buf.byteLength).toBe(content.length);
    });

    it("large markdown file (~2 MB): byte-exact round-trip", async () => {
      // The exact regression scenario from the field incident:
      // reconcile of a >1 MB markdown blocked on Capacitor
      // bridge. Even in the readBinary fallback (used by node
      // tests) we want to lock in the byte-for-byte invariant.
      const lines: string[] = ["# Big File\n"];
      let bytes = "# Big File\n".length;
      let i = 0;
      while (bytes < 2_000_000) {
        const line = `Line ${i.toString().padStart(7, "0")}: lorem ipsum dolor sit amet consectetur adipiscing elit\n`;
        lines.push(line);
        bytes += line.length;
        i += 1;
      }
      const content = lines.join("");
      expect(content.length).toBeGreaterThan(2_000_000);

      writeVaultFile(f.root, "Notes/big.md", content);
      const id = await f.queue.enqueue([ADD("Notes/big.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, "Notes/big.md");
      expect(buf.byteLength).toBe(content.length);
      expect(new TextDecoder().decode(buf)).toBe(content);
    });

    it("small binary file: bytes byte-exact (includes 0x00, 0xFF, BOM-like bytes)", async () => {
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0xff, 0xfe, 0xbb, 0xef, 0x7f,
      ]);
      writeVaultFile(
        f.root,
        "Assets/icon.png",
        // writeVaultFile only accepts string; binary write directly
        "" /* placeholder; we overwrite below */,
      );
      const abs = path.join(f.root, "Assets/icon.png");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("Assets/icon.png")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, "Assets/icon.png");
      expect(Buffer.from(new Uint8Array(buf)).equals(bytes)).toBe(true);
    });

    it("large binary file (~2 MB): byte-exact round-trip", async () => {
      const bytes = Buffer.alloc(2_000_000);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = (i * 7919) & 0xff; // deterministic non-trivial pattern
      }
      writeVaultFile(f.root, "Assets/big.bin", "");
      const abs = path.join(f.root, "Assets/big.bin");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("Assets/big.bin")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, "Assets/big.bin");
      expect(buf.byteLength).toBe(bytes.length);
      expect(Buffer.from(new Uint8Array(buf)).equals(bytes)).toBe(true);
    });

    it("empty file (0 bytes) round-trips as empty ArrayBuffer", async () => {
      writeVaultFile(f.root, "Notes/empty.md", "");
      const id = await f.queue.enqueue([ADD("Notes/empty.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, "Notes/empty.md");
      expect(buf.byteLength).toBe(0);
    });

    it("path with Cyrillic characters", async () => {
      const content = "Українська мова\nрядок два\n";
      const p = "Замітки/нотатка.md";
      writeVaultFile(f.root, p, content);
      const id = await f.queue.enqueue([ADD(p)], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, p);
      expect(new TextDecoder().decode(buf)).toBe(content);
    });

    it("path with spaces and parentheses", async () => {
      const content = "title with spaces and punctuation\n";
      const p = "Notes/My Note (draft).md";
      writeVaultFile(f.root, p, content);
      const id = await f.queue.enqueue([ADD(p)], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, p);
      expect(new TextDecoder().decode(buf)).toBe(content);
    });

    it("deeply nested directory path", async () => {
      const content = "nested\n";
      const p = "Level1/Level2/Level3/Level4/note.md";
      writeVaultFile(f.root, p, content);
      const id = await f.queue.enqueue([ADD(p)], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, p);
      expect(new TextDecoder().decode(buf)).toBe(content);
    });

    it("file with CRLF + BOM normalised at enqueue → readFile returns canonical LF", async () => {
      // PushQueue canonicalises text files on enqueue (autoCanonicalize
      // default ON). readFile returns the canonicalised bytes from
      // the snapshot, NOT the original on-disk bytes.
      const dirty = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]), // BOM
        Buffer.from("line1\r\nline2\r\n", "utf-8"),
      ]);
      const abs = path.join(f.root, "Notes/crlf.md");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, dirty);

      const id = await f.queue.enqueue([ADD("Notes/crlf.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = await f.queue.readFile(id, "Notes/crlf.md");
      expect(new TextDecoder().decode(buf)).toBe("line1\nline2\n");
    });

    it("multiple files in a batch — readFile each one independently", async () => {
      writeVaultFile(f.root, "a.md", "alpha\n");
      writeVaultFile(f.root, "Folder/b.md", "beta\n");
      writeVaultFile(f.root, "Folder/Sub/c.md", "gamma\n");
      const id = await f.queue.enqueue(
        [ADD("a.md"), ADD("Folder/b.md"), ADD("Folder/Sub/c.md")],
        { parentCommitSha: null, parentTreeSha: null },
      );

      const a = await f.queue.readFile(id, "a.md");
      const b = await f.queue.readFile(id, "Folder/b.md");
      const c = await f.queue.readFile(id, "Folder/Sub/c.md");
      expect(new TextDecoder().decode(a)).toBe("alpha\n");
      expect(new TextDecoder().decode(b)).toBe("beta\n");
      expect(new TextDecoder().decode(c)).toBe("gamma\n");
    });

    it("readFile after overwriteFile reflects the overwritten content, not the original", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const newContent = new TextEncoder().encode("v2-merged\n");
      await f.queue.overwriteFile(id, "a.md", newContent.buffer as ArrayBuffer);

      const buf = await f.queue.readFile(id, "a.md");
      expect(new TextDecoder().decode(buf)).toBe("v2-merged\n");
    });
  });

  describe("readFile — primary path: fetch(getResourcePath)", () => {
    // Mock-obsidian's `Vault.adapter` is a getter that returns a
    // fresh object every access (mock-obsidian.ts:188), so a naive
    // property assignment doesn't stick. We override the `adapter`
    // getter on the instance to wrap the original return with an
    // added `getResourcePath`, then restore it in afterEach. fetch
    // is patched on globalThis since both Node and the production
    // WebView use the same global.
    let originalFetch: typeof fetch;

    afterEach(() => {
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      }
      // Remove the instance-level adapter override so the
      // prototype getter is visible again.
      delete (f.vault as unknown as { adapter?: unknown }).adapter;
    });

    function patchAdapterAndFetch(opts: { fetchResponse: (url: string) => Response | Promise<Response> }): void {
      originalFetch = globalThis.fetch;
      // Capture the prototype-level adapter getter so we can
      // delegate to it for everything except getResourcePath.
      const protoDescriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(f.vault),
        "adapter",
      );
      const originalGetter = protoDescriptor?.get;
      if (!originalGetter) {
        throw new Error("expected adapter getter on Vault prototype");
      }
      Object.defineProperty(f.vault, "adapter", {
        configurable: true,
        get() {
          const original = originalGetter.call(f.vault);
          return {
            ...original,
            getResourcePath: (p: string) => `mock-resource://${p}`,
          };
        },
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        return await opts.fetchResponse(url);
      }) as typeof fetch;
    }

    it("uses getResourcePath + fetch when adapter exposes it", async () => {
      const content = "fetched via webview\n";
      writeVaultFile(f.root, "x.md", content);
      const id = await f.queue.enqueue([ADD("x.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      let fetchCalls = 0;
      let observedUrl = "";
      patchAdapterAndFetch({
        fetchResponse: (url) => {
          fetchCalls += 1;
          observedUrl = url;
          // Pretend WebView served the bytes from the queue snapshot.
          const stored = fs.readFileSync(
            path.join(f.queueRoot, id, "vault", "x.md"),
          );
          return new Response(stored, { status: 200 });
        },
      });

      const buf = await f.queue.readFile(id, "x.md");
      expect(new TextDecoder().decode(buf)).toBe(content);
      expect(fetchCalls).toBe(1);
      expect(observedUrl).toMatch(/^mock-resource:\/\//);
      expect(observedUrl).toContain("/.runtime/push-queue/");
      expect(observedUrl).toContain("/x.md");
    });

    it("primary fetch and fallback readBinary return identical bytes for same content", async () => {
      const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0xef, 0xbb, 0xbf]);
      const abs = path.join(f.root, "img.bin");
      fs.writeFileSync(abs, bytes);
      const id = await f.queue.enqueue([ADD("img.bin")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // Pass 1: readBinary fallback (no getResourcePath).
      const fallback = await f.queue.readFile(id, "img.bin");

      // Pass 2: fetch primary.
      patchAdapterAndFetch({
        fetchResponse: () => {
          const stored = fs.readFileSync(
            path.join(f.queueRoot, id, "vault", "img.bin"),
          );
          return new Response(stored, { status: 200 });
        },
      });
      const primary = await f.queue.readFile(id, "img.bin");

      expect(primary.byteLength).toBe(fallback.byteLength);
      expect(Buffer.from(new Uint8Array(primary))
        .equals(Buffer.from(new Uint8Array(fallback)))).toBe(true);
    });

    it("throws when fetch returns non-2xx status", async () => {
      writeVaultFile(f.root, "x.md", "irrelevant\n");
      const id = await f.queue.enqueue([ADD("x.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      patchAdapterAndFetch({
        fetchResponse: () =>
          new Response("not found", { status: 404 }),
      });

      await expect(f.queue.readFile(id, "x.md")).rejects.toThrow(/status 404/);
    });

    it("large file (~2 MB) via fetch path returns identical bytes", async () => {
      // Re-runs the large-file regression scenario against the
      // primary fetch path so we know it can handle the size that
      // broke Capacitor's readBinary on mobile.
      const bytes = Buffer.alloc(2_000_000);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = (i * 13) & 0xff;
      }
      const abs = path.join(f.root, "Assets/big.bin");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      const id = await f.queue.enqueue([ADD("Assets/big.bin")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      patchAdapterAndFetch({
        fetchResponse: () => {
          const stored = fs.readFileSync(
            path.join(f.queueRoot, id, "vault", "Assets/big.bin"),
          );
          return new Response(stored, { status: 200 });
        },
      });

      const buf = await f.queue.readFile(id, "Assets/big.bin");
      expect(buf.byteLength).toBe(bytes.length);
      expect(Buffer.from(new Uint8Array(buf)).equals(bytes)).toBe(true);
    });
  });

  describe("readFile — error paths", () => {
    it("throws when the path doesn't exist in the batch", async () => {
      writeVaultFile(f.root, "a.md", "exists\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // Nothing was enqueued at this path → readBinary on a
      // non-existent file errors. Surface that to the caller.
      await expect(f.queue.readFile(id, "b.md")).rejects.toThrow();
    });

    it("throws when the batch id doesn't exist", async () => {
      await expect(
        f.queue.readFile("nonexistent-batch-id", "a.md"),
      ).rejects.toThrow();
    });
  });
});
