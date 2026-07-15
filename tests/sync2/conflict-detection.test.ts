import { describe, it, expect } from "vitest";
import {
  classifyConflictKind,
  attemptAutoMerge,
  type AutoMergeResult,
  type PluginResolveContext,
} from "../../src/sync2/conflict-detection";

// Auto-merge dispatch tests. See src/sync2/conflict-detection.ts
// + docs/PSEUDO-MERGE-MODE.md §7 for the dispatch table.

const CONFIG_DIR = ".obsidian";

function arr(text: string): ArrayBuffer {
  const u = new TextEncoder().encode(text);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function decode(content: ArrayBuffer): string {
  return new TextDecoder().decode(content);
}

// ── classifyConflictKind ──────────────────────────────────────────────

describe("classifyConflictKind", () => {
  it("modified + modified → modify-vs-modify", async () => {
    expect(classifyConflictKind("modified", "modified")).toBe("modify-vs-modify");
  });

  it("deleted + modified → delete-vs-modify (ours deleted, theirs modified)", async () => {
    expect(classifyConflictKind("deleted", "modified")).toBe("delete-vs-modify");
  });

  it("modified + deleted → null (auto-resolves at push: local-modify wins, file resurrects)", async () => {
    // modify-vs-delete is no longer a registered conflict kind — it
    // routes through attemptAutoMerge's "modify-wins" branch.
    // classifyConflictKind returns null for this pair so the caller
    // does NOT call ConflictStore.create.
    expect(classifyConflictKind("modified", "deleted")).toBeNull();
  });

  it("deleted + deleted → null (both agree, not a conflict)", async () => {
    expect(classifyConflictKind("deleted", "deleted")).toBeNull();
  });
});

// ── attemptAutoMerge: text 3-way ──────────────────────────────────────

describe("attemptAutoMerge — text 3-way", () => {
  it("clean merge (non-overlapping edits) → returns merged content", async () => {
    const base = "alpha\nbeta\ngamma\n";
    const ours = "alpha-edited\nbeta\ngamma\n";
    const theirs = "alpha\nbeta\ngamma-edited\n";
    const r = await attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr(ours),
      theirs: arr(theirs),
      base: arr(base),
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("clean");
    if (r.type === "clean") {
      expect(decode(r.content)).toBe("alpha-edited\nbeta\ngamma-edited\n");
    }
  });

  it("overlapping edits → register-conflict (markers would appear)", async () => {
    const base = "alpha\nbeta\ngamma\n";
    const ours = "alpha\nOURS-LINE\ngamma\n";
    const theirs = "alpha\nTHEIRS-LINE\ngamma\n";
    const r = await attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr(ours),
      theirs: arr(theirs),
      base: arr(base),
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("register-conflict");
  });

  it("same edit both sides → clean (excludeFalseConflicts collapses)", async () => {
    const base = "alpha\nbeta\ngamma\n";
    const ours = "alpha\nBOTH-CHANGE\ngamma\n";
    const theirs = "alpha\nBOTH-CHANGE\ngamma\n";
    const r = await attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr(ours),
      theirs: arr(theirs),
      base: arr(base),
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("clean");
    if (r.type === "clean") {
      expect(decode(r.content)).toBe("alpha\nBOTH-CHANGE\ngamma\n");
    }
  });

  it("null base (no shared ancestor) → register-conflict", async () => {
    const r = await attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr("ours\n"),
      theirs: arr("theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("register-conflict");
  });
});

// ── attemptAutoMerge: §28 plugin-dir atomic resolution ───────────────
//
// Rule (docs/PSEUDO-MERGE-MODE.md §7, TODO §28): a plugin folder must
// NEVER grow a `*.conflict-from.*` sibling. main.js/manifest.json/
// styles.css resolve as one atomic group (semver → canonical bundle
// mtime); styles.css follows the bundle winner unless the bundle is
// identical (then its own mtime); data.json resolves purely by mtime.
// Every path returns an atomic side; register-conflict is unreachable.

const MAIN_JS = ".obsidian/plugins/my-plugin/main.js";
const MANIFEST = ".obsidian/plugins/my-plugin/manifest.json";
const STYLES = ".obsidian/plugins/my-plugin/styles.css";
const DATA_JSON = ".obsidian/plugins/my-plugin/data.json";

function pluginCtx(over: Partial<PluginResolveContext> = {}): PluginResolveContext {
  return {
    oursVersion: "1.0.0",
    theirsVersion: "1.0.0",
    codeDiffers: true,
    codeOursMtime: 100,
    codeTheirsMtime: 100,
    fileOursMtime: 100,
    fileTheirsMtime: 100,
    ...over,
  };
}

async function resolve(
  path: string,
  ctx: PluginResolveContext,
): Promise<AutoMergeResult> {
  return attemptAutoMerge({
    path,
    ours: arr("//ours\n"),
    theirs: arr("//theirs\n"),
    base: null,
    configDir: CONFIG_DIR,
    pluginResolve: ctx,
  });
}

describe("attemptAutoMerge — §28 coupled bundle (semver)", () => {
  it("ours version higher → atomic ours", async () => {
    expect(
      await resolve(MAIN_JS, pluginCtx({ oursVersion: "1.2.0", theirsVersion: "1.1.0" })),
    ).toEqual({ type: "atomic", side: "ours" });
  });

  it("theirs version higher → atomic theirs", async () => {
    expect(
      await resolve(MAIN_JS, pluginCtx({ oursVersion: "1.0.0", theirsVersion: "2.0.0" })),
    ).toEqual({ type: "atomic", side: "theirs" });
  });

  it("only ours version parseable → atomic ours (borked-manifest guard)", async () => {
    expect(
      await resolve(MAIN_JS, pluginCtx({ oursVersion: "1.0.0", theirsVersion: null })),
    ).toEqual({ type: "atomic", side: "ours" });
  });

  it("only theirs version parseable → atomic theirs", async () => {
    expect(
      await resolve(MAIN_JS, pluginCtx({ oursVersion: null, theirsVersion: "1.0.0" })),
    ).toEqual({ type: "atomic", side: "theirs" });
  });

  it("semver tie → later canonical bundle mtime (ours newer → ours)", async () => {
    expect(
      await resolve(MAIN_JS, pluginCtx({ codeOursMtime: 200, codeTheirsMtime: 100 })),
    ).toEqual({ type: "atomic", side: "ours" });
  });

  it("semver tie → later canonical bundle mtime (theirs newer → theirs)", async () => {
    expect(
      await resolve(MAIN_JS, pluginCtx({ codeOursMtime: 100, codeTheirsMtime: 200 })),
    ).toEqual({ type: "atomic", side: "theirs" });
  });

  it("§28 FLIP: semver tie AND mtime tie → atomic theirs, NOT register-conflict", async () => {
    // Previously (spec R5) this registered a conflict. §28 forbids any
    // conflict sibling in a plugin dir → the tie converges to the server.
    expect(await resolve(MAIN_JS, pluginCtx())).toEqual({
      type: "atomic",
      side: "theirs",
    });
  });

  it("both versions unparseable, mtimes differ → atomic by bundle mtime", async () => {
    expect(
      await resolve(
        MAIN_JS,
        pluginCtx({
          oursVersion: null,
          theirsVersion: null,
          codeOursMtime: 50,
          codeTheirsMtime: 200,
        }),
      ),
    ).toEqual({ type: "atomic", side: "theirs" });
  });

  it("§28 FLIP: missing context for a plugin path → atomic theirs, NOT register-conflict", async () => {
    const r = await attemptAutoMerge({
      path: MAIN_JS,
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });
});

describe("attemptAutoMerge — §28 group atomicity (the lynchpin)", () => {
  it("main.js, manifest.json AND styles.css resolve to the SAME side on a semver tie", async () => {
    // The whole point of a single canonical bundle mtime: on a semver
    // tie the three coupled files can never split to different sides
    // (which would ship a Frankenstein plugin). Bundle differs, theirs
    // bundle newer → all three follow theirs.
    const ctx = pluginCtx({ codeDiffers: true, codeOursMtime: 100, codeTheirsMtime: 200 });
    const theirs = { type: "atomic", side: "theirs" };
    expect(await resolve(MAIN_JS, ctx)).toEqual(theirs);
    expect(await resolve(MANIFEST, ctx)).toEqual(theirs);
    expect(await resolve(STYLES, ctx)).toEqual(theirs);
  });
});

describe("attemptAutoMerge — §28 styles.css follows the bundle", () => {
  it("RULE 1 (worked example): bundle changed on server, local styles.css newer → server styles.css STILL wins", async () => {
    // Server shipped a new main.js (manifest not bumped → semver tie),
    // user locally edited styles.css so its own mtime is newer. Because
    // the bundle differs and the server's bundle is newer, styles.css
    // must follow the server — NOT the fresher local edit.
    const ctx = pluginCtx({
      codeDiffers: true,
      codeOursMtime: 100, // local bundle untouched (old)
      codeTheirsMtime: 500, // server pushed a new bundle
      fileOursMtime: 900, // local styles.css freshly edited
      fileTheirsMtime: 100,
    });
    expect(await resolve(STYLES, ctx)).toEqual({ type: "atomic", side: "theirs" });
  });

  it("RULE 3: bundle identical on both sides → later styles.css mtime wins", async () => {
    // Only styles.css differs (rule 1 doesn't apply) → its own mtime
    // decides. Local styles.css is newer → ours.
    const ctx = pluginCtx({
      codeDiffers: false,
      codeOursMtime: 100,
      codeTheirsMtime: 500, // irrelevant when the bundle is identical
      fileOursMtime: 900,
      fileTheirsMtime: 100,
    });
    expect(await resolve(STYLES, ctx)).toEqual({ type: "atomic", side: "ours" });
  });

  it("RULE 1 takes priority over styles.css's own mtime", async () => {
    // Same as rule-1 but flip: server bundle newer, and this time the
    // styles.css mtimes would say ours — rule 1 still wins.
    const ctx = pluginCtx({
      codeDiffers: true,
      codeOursMtime: 100,
      codeTheirsMtime: 500,
      fileOursMtime: 999,
      fileTheirsMtime: 1,
    });
    expect(await resolve(STYLES, ctx)).toEqual({ type: "atomic", side: "theirs" });
  });
});

describe("attemptAutoMerge — §28 data.json (rule 4)", () => {
  it("resolves purely by mtime, ignoring semver", async () => {
    // Even though theirs has a higher plugin version, data.json ignores
    // it — later mtime wins. Local data.json newer → ours.
    const ctx = pluginCtx({
      oursVersion: "1.0.0",
      theirsVersion: "9.9.9",
      fileOursMtime: 900,
      fileTheirsMtime: 100,
    });
    expect(await resolve(DATA_JSON, ctx)).toEqual({ type: "atomic", side: "ours" });
  });

  it("theirs mtime newer → atomic theirs", async () => {
    const ctx = pluginCtx({ fileOursMtime: 100, fileTheirsMtime: 900 });
    expect(await resolve(DATA_JSON, ctx)).toEqual({ type: "atomic", side: "theirs" });
  });

  it("mtime tie → atomic theirs (converge to server, never conflict)", async () => {
    const ctx = pluginCtx({ fileOursMtime: 300, fileTheirsMtime: 300 });
    expect(await resolve(DATA_JSON, ctx)).toEqual({ type: "atomic", side: "theirs" });
  });
});

// ── attemptAutoMerge: binary always-register ─────────────────────────

describe("attemptAutoMerge — binary", () => {
  it("PNG → register-conflict (no silent atomic mtime)", async () => {
    const r = await attemptAutoMerge({
      path: "attachments/photo.png",
      ours: new Uint8Array([0x89, 0x50, 0x4e]).buffer as ArrayBuffer,
      theirs: new Uint8Array([0x89, 0x50, 0x4e, 0xff]).buffer as ArrayBuffer,
      base: new Uint8Array([0x89]).buffer as ArrayBuffer,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("PDF → register-conflict", async () => {
    const r = await attemptAutoMerge({
      path: "docs/report.pdf",
      ours: new Uint8Array([0x25, 0x50, 0x44]).buffer as ArrayBuffer,
      theirs: new Uint8Array([0x25, 0x50, 0x44, 0xff]).buffer as ArrayBuffer,
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("mp4 → register-conflict", async () => {
    const r = await attemptAutoMerge({
      path: "video.mp4",
      ours: new Uint8Array([0x00, 0x00, 0x00, 0x18]).buffer as ArrayBuffer,
      theirs: new Uint8Array([0x00, 0x00, 0x00, 0x20]).buffer as ArrayBuffer,
      base: null,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });
});

// ── strategy dispatch sanity ─────────────────────────────────────────

describe("attemptAutoMerge — strategy dispatch", () => {
  it("§28 FLIP: styles.css inside a plugin folder is atomic, NOT a text merge", async () => {
    // Previously styles.css fell through to the 3-way text merge and
    // could register a conflict sibling — the exact §28 bug. Now it is
    // an atomic plugin-dir file.
    const r = await attemptAutoMerge({
      path: ".obsidian/plugins/foo/styles.css",
      ours: arr("a { color: red; }\n"),
      theirs: arr("a { color: blue; }\n"),
      base: arr("a { color: green; }\n"),
      configDir: CONFIG_DIR,
      pluginResolve: pluginCtx({ codeDiffers: false, fileOursMtime: 200, fileTheirsMtime: 100 }),
    });
    expect(r).toEqual({ type: "atomic", side: "ours" });
  });

  it("a nested .css under a plugin folder is NOT the stylesheet → text merge", async () => {
    // Only the top-level styles.css is the plugin stylesheet; a nested
    // one is an ordinary text file.
    const r = await attemptAutoMerge({
      path: ".obsidian/plugins/foo/themes/dark.css",
      ours: arr("a { color: red; }\n"),
      theirs: arr("a { color: red; }\n"),
      base: arr("a { color: red; }\n"),
      configDir: CONFIG_DIR,
    });
    expect(r.type).toBe("clean");
  });

  it("non-text extension outside plugin folder → binary branch", async () => {
    const r = await attemptAutoMerge({
      path: "Vault/asset.bin",
      ours: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
      theirs: new Uint8Array([4, 5, 6]).buffer as ArrayBuffer,
      base: new Uint8Array([0]).buffer as ArrayBuffer,
      configDir: CONFIG_DIR,
    });
    expect(r).toEqual({ type: "register-conflict" });
  });

  it("plugin path under a different configDir is recognized", async () => {
    const r = await attemptAutoMerge({
      path: ".obs-custom/plugins/foo/main.js",
      ours: arr("//ours\n"),
      theirs: arr("//theirs\n"),
      base: null,
      configDir: ".obs-custom",
      pluginResolve: pluginCtx({ oursVersion: "1.0.0", theirsVersion: "1.0.1" }),
    });
    expect(r).toEqual({ type: "atomic", side: "theirs" });
  });
});

// ── type-system sanity for AutoMergeResult ───────────────────────────

describe("AutoMergeResult type", () => {
  it("discriminated union is exhaustively narrowable", async () => {
    const cases: AutoMergeResult[] = [
      { type: "clean", content: arr("") },
      { type: "atomic", side: "ours" },
      { type: "modify-wins" },
      { type: "register-conflict" },
    ];
    for (const c of cases) {
      if (c.type === "clean") {
        expect(c.content).toBeInstanceOf(ArrayBuffer);
      } else if (c.type === "atomic") {
        expect(["ours", "theirs"]).toContain(c.side);
      } else if (c.type === "modify-wins") {
        // no payload — its presence in the union is the assertion
      } else {
        // exhaustiveness
        const _exhaust: "register-conflict" = c.type;
        void _exhaust;
      }
    }
  });

  it("theirs === null → modify-wins (modify-vs-delete branch)", async () => {
    const r = await attemptAutoMerge({
      path: "Notes/note.md",
      ours: arr("local edit\n"),
      theirs: null,
      base: arr("shared\n"),
      configDir: ".obsidian",
    });
    expect(r).toEqual({ type: "modify-wins" });
  });
});
