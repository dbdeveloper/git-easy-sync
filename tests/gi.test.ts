import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import GI from "../src/gi";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gi-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const w = (rel: string, content = "") => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

describe("GI", () => {
  it("returns false when no .gitignore anywhere", () => {
    const gi = new GI(root);
    expect(gi.ignored("a/b/c/file.txt")).toBe(false);
    expect(gi.ignored("note.md")).toBe(false);
  });

  it("root-level *.log ignores everywhere", () => {
    w(".gitignore", "*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("debug.log")).toBe(true);
    expect(gi.ignored("a/b/debug.log")).toBe(true);
    expect(gi.ignored("note.md")).toBe(false);
  });

  it("nested unignore overrides root ignore", () => {
    w(".gitignore", "*.log\n");
    w("a/.gitignore", "!keep.log\n");
    const gi = new GI(root);
    expect(gi.ignored("a/keep.log")).toBe(false);
    expect(gi.ignored("a/other.log")).toBe(true);
    expect(gi.ignored("keep.log")).toBe(true);
  });

  it("OP example: ignore→un→ig→un = NOT ignored", () => {
    w(".gitignore", "a/b/c/file\n");
    w("a/.gitignore", "!b/c/file\n");
    w("a/b/.gitignore", "c/file\n");
    w("a/b/c/.gitignore", "!file\n");
    const gi = new GI(root);
    expect(gi.ignored("a/b/c/file")).toBe(false);
  });

  it("4-level alternating: ig→un→ig→un yields NOT ignored", () => {
    w(".gitignore", "*.x\n");
    w("a/.gitignore", "!*.x\n");
    w("a/b/.gitignore", "*.x\n");
    w("a/b/c/.gitignore", "!*.x\n");
    const gi = new GI(root);
    expect(gi.ignored("a/b/c/file.x")).toBe(false);
  });

  it("4-level alternating reversed: un→ig→un→ig yields ignored", () => {
    w(".gitignore", "!*.x\n");
    w("a/.gitignore", "*.x\n");
    w("a/b/.gitignore", "!*.x\n");
    w("a/b/c/.gitignore", "*.x\n");
    const gi = new GI(root);
    expect(gi.ignored("a/b/c/file.x")).toBe(true);
  });

  it("silent levels keep prior verdict", () => {
    w(".gitignore", "*.tmp\n");
    w("a/.gitignore", "*.foo\n");
    const gi = new GI(root);
    expect(gi.ignored("a/x.tmp")).toBe(true);
    expect(gi.ignored("a/x.foo")).toBe(true);
    expect(gi.ignored("a/x.txt")).toBe(false);
  });

  it("scope: nested /pattern is anchored to its own dir", () => {
    w("a/.gitignore", "/build\n");
    const gi = new GI(root);
    expect(gi.ignored("a/build")).toBe(true);
    expect(gi.ignored("a/x/build")).toBe(false);
    expect(gi.ignored("build")).toBe(false);
  });

  it("absolute paths inside root are accepted", () => {
    w(".gitignore", "*.log\n");
    const gi = new GI(root);
    expect(gi.ignored(path.join(root, "x.log"))).toBe(true);
    expect(gi.ignored(path.join(root, "a/b/x.log"))).toBe(true);
  });

  it("paths outside root return false", () => {
    w(".gitignore", "*\n");
    const gi = new GI(root);
    expect(gi.ignored("/some/other/place/x.log")).toBe(false);
  });

  it("comments and blanks are skipped by parser", () => {
    w(".gitignore", "# a comment\n\n   \n*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("x.log")).toBe(true);
    expect(gi.ignored("x.md")).toBe(false);
  });

  it("non-absolute rootDir throws", () => {
    expect(() => new GI("relative/dir")).toThrow(/absolute/);
  });

  it("missing intermediate .gitignore is fine", () => {
    w("a/b/.gitignore", "*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("a/b/x.log")).toBe(true);
    expect(gi.ignored("a/b/x.md")).toBe(false);
    expect(gi.ignored("a/x.log")).toBe(false);
    expect(gi.ignored("x.log")).toBe(false);
  });

  it("loads only .gitignore files on visited path (lazy)", () => {
    w(".gitignore", "*.log\n");
    w("a/.gitignore", "*.tmp\n");
    w("z/.gitignore", "*.cache\n");
    const reads: string[] = [];
    const gi = new GI(root, (abs) => {
      reads.push(abs);
      try {
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    });
    gi.ignored("a/x.tmp");
    expect(reads.some((r) => r.endsWith("/z/.gitignore"))).toBe(false);
    expect(reads.some((r) => r.endsWith("/.gitignore"))).toBe(true);
    expect(reads.some((r) => r.endsWith("/a/.gitignore"))).toBe(true);
  });

  it("caches: same level isn't re-read on second query", () => {
    w(".gitignore", "*.log\n");
    let count = 0;
    const gi = new GI(root, (abs) => {
      count++;
      try {
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    });
    gi.ignored("x.log");
    const after1 = count;
    gi.ignored("y.log");
    expect(count).toBe(after1);
  });

  it("absent .gitignore is also cached as null (no re-read)", () => {
    let count = 0;
    const gi = new GI(root, () => {
      count++;
      return null;
    });
    gi.ignored("a/b/x.log");
    const after1 = count;
    gi.ignored("a/b/y.log");
    expect(count).toBe(after1);
  });

  it("Windows-style backslash paths normalize to /", () => {
    w(".gitignore", "*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("a\\b\\x.log")).toBe(true);
  });

  it("./ prefix and trailing / normalize", () => {
    w(".gitignore", "*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("./x.log")).toBe(true);
    expect(gi.ignored("x.log/")).toBe(true);
  });

  it("empty input returns false", () => {
    const gi = new GI(root);
    expect(gi.ignored("")).toBe(false);
  });

  it("file at root level checks only root .gitignore", () => {
    w(".gitignore", "*.log\n");
    w("a/.gitignore", "!*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("x.log")).toBe(true);
  });

  it("deeply nested file traverses every intermediate level", () => {
    w(".gitignore", "*.log\n");
    w("a/.gitignore", "!*.log\n");
    w("a/b/.gitignore", "*.log\n");
    w("a/b/c/.gitignore", "!*.log\n");
    w("a/b/c/d/.gitignore", "*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("a/b/c/d/x.log")).toBe(true);
  });

  it("mixed presence of .gitignore at different depths", () => {
    w(".gitignore", "*.log\n");
    w("a/b/.gitignore", "!keep.log\n");
    const gi = new GI(root);
    expect(gi.ignored("a/b/keep.log")).toBe(false);
    expect(gi.ignored("a/b/other.log")).toBe(true);
    expect(gi.ignored("a/keep.log")).toBe(true);
  });

  it("no-descent: a deeper !-rule CANNOT resurrect a file under an ignored folder (git parity)", () => {
    // Was pinned for months as "docs known gap: git would NOT" — the
    // divergence §3.4 named and DOT-FILES §3.1 could not live with,
    // since the dot-hide block excludes `.obsidian` and then re-admits
    // it. Closed 2026-09-01: an excluded directory is never entered, so
    // nothing inside it can be re-included.
    w(".gitignore", "node_modules/\n");
    w("node_modules/.gitignore", "!keep.js\n");
    const gi = new GI(root);
    expect(gi.ignored("node_modules/keep.js")).toBe(true);
  });

  it("no-descent: re-including the DIRECTORY first is what lets deeper rules speak", () => {
    // The other half of the rule, and the shape DOT-FILES §3.1 relies
    // on: `.*` hides the dot-dir, `!<configDir>/` re-admits it, and only
    // then does the configDir's own .gitignore get a vote.
    w(".gitignore", ".*\n.*/\n!.obsidian/\n");
    w(".obsidian/.gitignore", "!.gitignore\nworkspace.json\n");
    const gi = new GI(root);
    expect(gi.ignored(".obsidian/app.json")).toBe(false);
    expect(gi.ignored(".obsidian/.gitignore")).toBe(false);
    expect(gi.ignored(".obsidian/workspace.json")).toBe(true);
    // …while a dot-dir that was NOT re-admitted stays shut, deeper
    // negations notwithstanding.
    w(".other/.gitignore", "!keep.md\n");
    expect(gi.ignored(".other/keep.md")).toBe(true);
  });

  it("no-descent: a file-level ! cannot reach into an excluded directory", () => {
    // Probe 5 case D — the natural "I will just allow the one file I
    // need" attempt, which yields nothing in real git.
    w(".gitignore", ".*\n.*/\n!.obsidian/.gitignore\n");
    w(".obsidian/.gitignore", "!.gitignore\n");
    const gi = new GI(root);
    expect(gi.ignored(".obsidian/.gitignore")).toBe(true);
  });

  it("no-descent: an intermediate directory blocks everything below it", () => {
    w(".gitignore", "build/\n");
    w("build/sub/.gitignore", "!*.js\n");
    const gi = new GI(root);
    expect(gi.ignored("build/sub/app.js")).toBe(true);
    expect(gi.ignored("build/sub/deep/app.js")).toBe(true);
    expect(gi.ignored("src/app.js")).toBe(false);
  });

  it("no-descent: a directory's OWN .gitignore cannot re-admit that directory", () => {
    // git has to enter the directory to read the file, and it never
    // enters — so the rule can only ever apply to its contents.
    w(".gitignore", "secret/\n");
    w("secret/.gitignore", "!/\n!*\n");
    const gi = new GI(root);
    expect(gi.ignored("secret/x.md")).toBe(true);
  });

  it("** double-star matches across directories", () => {
    w(".gitignore", "**/secret.txt\n");
    const gi = new GI(root);
    expect(gi.ignored("secret.txt")).toBe(true);
    expect(gi.ignored("a/secret.txt")).toBe(true);
    expect(gi.ignored("a/b/c/secret.txt")).toBe(true);
  });

  it("dir-only pattern (foo/) ignores files inside but not a file named foo", () => {
    w(".gitignore", "build/\n");
    const gi = new GI(root);
    expect(gi.ignored("build/x.o")).toBe(true);
    expect(gi.ignored("a/build/x.o")).toBe(true);
  });

  it("two queries on same deep path don't double-load", () => {
    w(".gitignore", "");
    w("a/.gitignore", "");
    w("a/b/.gitignore", "*.log\n");
    let count = 0;
    const gi = new GI(root, (abs) => {
      count++;
      try {
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    });
    gi.ignored("a/b/x.log");
    const first = count;
    gi.ignored("a/b/y.md");
    gi.ignored("a/b/c/d/z.log");
    expect(count).toBeLessThanOrEqual(first + 2);
  });

  it("absolute path at exactly rootDir returns false", () => {
    w(".gitignore", "*\n");
    const gi = new GI(root);
    expect(gi.ignored(root)).toBe(false);
  });

  it("relative path with .. that lands back inside root resolves correctly", () => {
    w(".gitignore", "*.log\n");
    const gi = new GI(root);
    const lastSeg = path.basename(root);
    expect(gi.ignored(`../${lastSeg}/a/b/x.log`)).toBe(true);
    expect(gi.ignored(`../${lastSeg}/a/b/x.md`)).toBe(false);
  });

  it("relative path with .. that escapes root returns false", () => {
    w(".gitignore", "*\n");
    const gi = new GI(root);
    expect(gi.ignored("../somewhere-else/file")).toBe(false);
    expect(gi.ignored("../../etc/passwd")).toBe(false);
  });

  it("absolute path inside root is treated like its relative form", () => {
    w(".gitignore", "*.log\n");
    const gi = new GI(root);
    const absInside = path.join(root, "a/b/x.log");
    expect(gi.ignored(absInside)).toBe(gi.ignored("a/b/x.log"));
    expect(gi.ignored(absInside)).toBe(true);
  });

  it("'a/./b' and 'a//b' style noise is normalized", () => {
    w(".gitignore", "*.log\n");
    const gi = new GI(root);
    expect(gi.ignored("a/./b/x.log")).toBe(true);
    expect(gi.ignored("a//b/x.log")).toBe(true);
  });

  describe("async API", () => {
    it("ignoredAsync preloads via async reader, never touches sync reader", async () => {
      w(".gitignore", "*.log\n");
      w("a/.gitignore", "!*.log\n");
      let syncCalls = 0;
      const gi = new GI(root, () => {
        syncCalls++;
        return null;
      });
      const asyncReader = async (abs: string) => {
        try {
          return fs.readFileSync(abs, "utf8");
        } catch {
          return null;
        }
      };
      const result = await gi.ignoredAsync("a/keep.log", asyncReader);
      expect(result).toBe(false);
      expect(syncCalls).toBe(0);
    });

    it("ignoredAsync caches: second call doesn't re-read", async () => {
      w(".gitignore", "*.log\n");
      let asyncCalls = 0;
      const gi = new GI(root);
      const asyncReader = async (abs: string) => {
        asyncCalls++;
        try {
          return fs.readFileSync(abs, "utf8");
        } catch {
          return null;
        }
      };
      await gi.ignoredAsync("x.log", asyncReader);
      const after1 = asyncCalls;
      await gi.ignoredAsync("y.log", asyncReader);
      expect(asyncCalls).toBe(after1);
    });

    it("ignoredAsync visits only the path it needs (lazy)", async () => {
      w(".gitignore", "*.log\n");
      w("a/.gitignore", "*.tmp\n");
      w("z/.gitignore", "*.cache\n");
      const reads: string[] = [];
      const gi = new GI(root);
      await gi.ignoredAsync("a/x.tmp", async (abs) => {
        reads.push(abs);
        try {
          return fs.readFileSync(abs, "utf8");
        } catch {
          return null;
        }
      });
      expect(reads.some((r) => r.endsWith("/z/.gitignore"))).toBe(false);
      expect(reads.some((r) => r.endsWith("/a/.gitignore"))).toBe(true);
    });

    it("ignored() and ignoredAsync() agree on every example", async () => {
      w(".gitignore", "*.log\n");
      w("a/.gitignore", "!keep.log\n");
      w("a/b/.gitignore", "*.log\n");
      const giSync = new GI(root);
      const giAsync = new GI(root, () => null);
      const asyncReader = async (abs: string) => {
        try {
          return fs.readFileSync(abs, "utf8");
        } catch {
          return null;
        }
      };
      const cases = [
        "x.log",
        "a/keep.log",
        "a/x.log",
        "a/b/x.log",
        "a/b/keep.log",
      ];
      for (const c of cases) {
        const s = giSync.ignored(c);
        const a = await giAsync.ignoredAsync(c, asyncReader);
        expect(a, `mismatch on ${c}`).toBe(s);
      }
    });

    it("preloadAsync warms the cache so later sync ignored() works", async () => {
      w(".gitignore", "*.log\n");
      let syncCalls = 0;
      const gi = new GI(root, () => {
        syncCalls++;
        return null;
      });
      await gi.preloadAsync("a/x.log", async (abs) => {
        try {
          return fs.readFileSync(abs, "utf8");
        } catch {
          return null;
        }
      });
      expect(gi.ignored("a/x.log")).toBe(true);
      expect(syncCalls).toBe(0);
    });

    it("invalidate forces a re-read on next query", async () => {
      const giPath = path.join(root, ".gitignore");
      fs.writeFileSync(giPath, "*.log\n");
      const gi = new GI(root);
      expect(gi.ignored("x.log")).toBe(true);
      // Edit on disk:
      fs.writeFileSync(giPath, "*.tmp\n");
      // Without invalidate: stale.
      expect(gi.ignored("x.log")).toBe(true);
      gi.invalidate("");
      expect(gi.ignored("x.log")).toBe(false);
      expect(gi.ignored("x.tmp")).toBe(true);
    });

    it("invalidate of a missing dir is a no-op", () => {
      w(".gitignore", "*.log\n");
      const gi = new GI(root);
      expect(() => gi.invalidate("does/not/exist")).not.toThrow();
      expect(gi.ignored("x.log")).toBe(true);
    });
  });

  describe("mtime-aware auto-refresh", () => {
    // Helper: an mtime-aware async reader backed by a synthetic
    // filesystem the test controls. Lets us prove (a) GI re-reads
    // when mtime moves and (b) GI does NOT re-read when mtime stays.
    type Fake = { content: string | null; mtime: number };
    function makeReader(files: Map<string, Fake>) {
      const calls: { abs: string; ts: number }[] = [];
      const reader = async (abs: string) => {
        calls.push({ abs, ts: Date.now() });
        const f = files.get(abs);
        if (!f || f.content === null) return null;
        return { content: f.content, mtime: f.mtime };
      };
      return { reader, calls };
    }

    it("re-reads when mtime moves on disk", async () => {
      const giAbs = path.join(root, ".gitignore").split(path.sep).join("/");
      const files = new Map<string, Fake>([
        [giAbs, { content: "*.log\n", mtime: 1000 }],
      ]);
      const { reader } = makeReader(files);
      const gi = new GI(root);

      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      // Author flips the rule on disk; mtime advances.
      files.set(giAbs, { content: "*.tmp\n", mtime: 2000 });
      // Outside the cooldown window: GI re-reads, picks up new rules.
      await new Promise((r) => setTimeout(r, 600));
      expect(await gi.ignoredAsync("x.log", reader)).toBe(false);
      expect(await gi.ignoredAsync("x.tmp", reader)).toBe(true);
    });

    it("skips re-read when mtime is unchanged (across cooldown boundary)", async () => {
      const giAbs = path.join(root, ".gitignore").split(path.sep).join("/");
      const files = new Map<string, Fake>([
        [giAbs, { content: "*.log\n", mtime: 1000 }],
      ]);
      const { reader, calls } = makeReader(files);
      const gi = new GI(root);

      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      const after1 = calls.length;
      // Wait past the cooldown window so the next call DOES stat —
      // but mtime hasn't changed, so reader should report it once
      // (stat) and GI should keep the cached parse without re-adding
      // it to ignore().
      await new Promise((r) => setTimeout(r, 600));
      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      // The stat happened (so calls increased), but the parse stayed
      // — verified by the cached behaviour persisting.
      expect(calls.length).toBe(after1 + 1);
      expect(calls[after1].abs).toBe(giAbs);
    });

    it("cooldown: many ignoredAsync calls in quick succession produce one stat", async () => {
      const giAbs = path.join(root, ".gitignore").split(path.sep).join("/");
      const files = new Map<string, Fake>([
        [giAbs, { content: "*.log\n", mtime: 1000 }],
      ]);
      const { reader, calls } = makeReader(files);
      const gi = new GI(root);

      for (let i = 0; i < 50; i++) {
        await gi.ignoredAsync(`a/b/file${i}.log`, reader);
      }
      // The path "a/b/file*" walks 3 levels (root, a, a/b). Only root
      // has a real .gitignore; the other two are nullable. Each level
      // gets statted at most once thanks to the cooldown.
      expect(calls.length).toBeLessThanOrEqual(3);
    });

    it("legacy content-only reader still works (no mtime → re-parses every cooldown cycle)", async () => {
      const giAbs = path.join(root, ".gitignore").split(path.sep).join("/");
      let serveContent = "*.log\n";
      const reader = async (abs: string) => {
        if (abs !== giAbs) return null;
        return serveContent;
      };
      const gi = new GI(root);

      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      // Edit content; with no mtime, GI relies on the cooldown
      // boundary to decide when to re-fetch.
      serveContent = "*.tmp\n";
      // Within cooldown — still old picture.
      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      await new Promise((r) => setTimeout(r, 600));
      // Past cooldown — re-fetches.
      expect(await gi.ignoredAsync("x.log", reader)).toBe(false);
      expect(await gi.ignoredAsync("x.tmp", reader)).toBe(true);
    });

    it("disappearance: file deleted on disk → cached parse is dropped on next stat", async () => {
      const giAbs = path.join(root, ".gitignore").split(path.sep).join("/");
      const files = new Map<string, Fake>([
        [giAbs, { content: "*.log\n", mtime: 1000 }],
      ]);
      const { reader } = makeReader(files);
      const gi = new GI(root);

      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      // The file is gone now.
      files.set(giAbs, { content: null, mtime: 0 });
      await new Promise((r) => setTimeout(r, 600));
      expect(await gi.ignoredAsync("x.log", reader)).toBe(false);
    });

    it("invalidate forces immediate re-read on next call (skips cooldown)", async () => {
      const giAbs = path.join(root, ".gitignore").split(path.sep).join("/");
      const files = new Map<string, Fake>([
        [giAbs, { content: "*.log\n", mtime: 1000 }],
      ]);
      const { reader } = makeReader(files);
      const gi = new GI(root);

      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      // Update content + mtime.
      files.set(giAbs, { content: "*.tmp\n", mtime: 2000 });
      // Within cooldown — would normally stay stale.
      expect(await gi.ignoredAsync("x.log", reader)).toBe(true);
      // Explicit invalidation overrides the cooldown.
      gi.invalidate("");
      expect(await gi.ignoredAsync("x.log", reader)).toBe(false);
    });
  });
});
