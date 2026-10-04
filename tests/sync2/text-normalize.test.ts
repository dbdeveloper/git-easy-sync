import { describe, it, expect } from "vitest";
import {
  canonicalizeBytes,
  normalizeText,
  shouldCanonicalize,
} from "../../src/sync2/text-normalize";

// The contract:
//   1. Strip a leading UTF-8 BOM (decoded to the U+FEFF code point).
//   2. CRLF → LF, lone CR → LF.
//   3. Append a single trailing \n iff the result is non-empty.
//   4. `changed` is true iff output bytes differ from input bytes.
//
// Tests below cover each rule in isolation, the combinations between
// them, and the idempotency guarantee that the rest of the sync2
// pipeline relies on (running normalize twice must not introduce
// further changes).

describe("normalizeText — pass-through (no-op cases)", () => {
  it("empty string stays empty", () => {
    const r = normalizeText("");
    expect(r.content).toBe("");
    expect(r.changed).toBe(false);
  });

  it("single LF line with trailing newline is unchanged", () => {
    const r = normalizeText("hello\n");
    expect(r.content).toBe("hello\n");
    expect(r.changed).toBe(false);
  });

  it("multi-line LF text with trailing newline is unchanged", () => {
    const r = normalizeText("a\nb\nc\n");
    expect(r.content).toBe("a\nb\nc\n");
    expect(r.changed).toBe(false);
  });

  it("multiple trailing newlines are preserved", () => {
    // Important for markdown paragraph spacing — we don't collapse runs.
    const r = normalizeText("paragraph\n\n\n");
    expect(r.content).toBe("paragraph\n\n\n");
    expect(r.changed).toBe(false);
  });
});

describe("normalizeText — BOM stripping", () => {
  it("strips a leading UTF-8 BOM from a non-empty file", () => {
    const r = normalizeText("﻿hello\n");
    expect(r.content).toBe("hello\n");
    expect(r.changed).toBe(true);
  });

  it("BOM-only file becomes empty (and stays empty per the trailing-NL rule)", () => {
    const r = normalizeText("﻿");
    expect(r.content).toBe("");
    expect(r.changed).toBe(true);
  });

  it("U+FEFF in the middle is preserved (it's ZWNBSP, not BOM)", () => {
    // Unicode treats U+FEFF at non-zero positions as ZERO WIDTH NO-BREAK
    // SPACE. Stripping mid-content would mutate user data.
    const r = normalizeText("abc﻿def\n");
    expect(r.content).toBe("abc﻿def\n");
    expect(r.changed).toBe(false);
  });

  it("BOM followed by CRLF is stripped of both BOM and CRLF", () => {
    const r = normalizeText("﻿hello\r\n");
    expect(r.content).toBe("hello\n");
    expect(r.changed).toBe(true);
  });
});

describe("normalizeText — line endings", () => {
  it("CRLF becomes LF", () => {
    const r = normalizeText("a\r\nb\r\n");
    expect(r.content).toBe("a\nb\n");
    expect(r.changed).toBe(true);
  });

  it("lone CR (Mac Classic-style) becomes LF", () => {
    const r = normalizeText("a\rb\rc\r");
    expect(r.content).toBe("a\nb\nc\n");
    expect(r.changed).toBe(true);
  });

  it("mixed LF + CRLF normalises every line ending to LF", () => {
    const r = normalizeText("a\nb\r\nc\nd\r\n");
    expect(r.content).toBe("a\nb\nc\nd\n");
    expect(r.changed).toBe(true);
  });

  it("mixed LF + lone CR normalises every line ending to LF", () => {
    const r = normalizeText("a\nb\rc\nd\r");
    expect(r.content).toBe("a\nb\nc\nd\n");
    expect(r.changed).toBe(true);
  });

  it("mixed LF + CRLF + lone CR all become LF", () => {
    const r = normalizeText("a\rb\r\nc\nd\r\ne\rf");
    expect(r.content).toBe("a\nb\nc\nd\ne\nf\n");
    expect(r.changed).toBe(true);
  });

  it("\\r\\n at the end is collapsed, no extra trailing \\n added", () => {
    // Without care, sloppy ordering could produce "abc\n\n".
    const r = normalizeText("abc\r\n");
    expect(r.content).toBe("abc\n");
    expect(r.changed).toBe(true);
  });
});

describe("normalizeText — trailing newline (rule c)", () => {
  it("non-empty content without trailing newline gets one added", () => {
    const r = normalizeText("abc");
    expect(r.content).toBe("abc\n");
    expect(r.changed).toBe(true);
  });

  it("multi-line content without trailing newline gets one added", () => {
    const r = normalizeText("first\nsecond");
    expect(r.content).toBe("first\nsecond\n");
    expect(r.changed).toBe(true);
  });

  it("single character without trailing newline gets one added", () => {
    const r = normalizeText("x");
    expect(r.content).toBe("x\n");
    expect(r.changed).toBe(true);
  });

  it("empty string does NOT get a newline added", () => {
    const r = normalizeText("");
    expect(r.content).toBe("");
    expect(r.changed).toBe(false);
  });

  it("a content that becomes empty after BOM strip stays empty (no \\n added)", () => {
    const r = normalizeText("﻿");
    expect(r.content).toBe("");
    expect(r.changed).toBe(true);
  });
});

describe("normalizeText — combined transformations", () => {
  it("BOM + CRLF + missing trailing newline", () => {
    const r = normalizeText("﻿header\r\nbody");
    expect(r.content).toBe("header\nbody\n");
    expect(r.changed).toBe(true);
  });

  it("BOM + lone CR + missing trailing newline", () => {
    const r = normalizeText("﻿header\rbody");
    expect(r.content).toBe("header\nbody\n");
    expect(r.changed).toBe(true);
  });

  it("BOM + mixed line endings + already-trailing newline", () => {
    const r = normalizeText("﻿a\r\nb\rc\n");
    expect(r.content).toBe("a\nb\nc\n");
    expect(r.changed).toBe(true);
  });

  it("a single CR alone normalises to a single LF (still non-empty)", () => {
    const r = normalizeText("\r");
    expect(r.content).toBe("\n");
    expect(r.changed).toBe(true);
  });

  it("a single CRLF alone normalises to a single LF", () => {
    const r = normalizeText("\r\n");
    expect(r.content).toBe("\n");
    expect(r.changed).toBe(true);
  });
});

describe("normalizeText — idempotency", () => {
  // Property: applying normalize twice returns the same content as
  // applying it once, AND the second application reports changed=false.
  // This is what the sync2 pipeline depends on so that the post-pull
  // auto-republish doesn't keep producing fresh "modify" commits.
  const inputs = [
    "",
    "abc",
    "abc\n",
    "abc\r\n",
    "abc\r",
    "﻿abc",
    "﻿abc\r\n",
    "a\rb\r\nc\nd",
    "paragraph\n\n\n",
    "x﻿y",
    "\r",
    "\n",
    "\r\n",
    "﻿",
    "﻿\r\n",
  ];

  for (const input of inputs) {
    it(`normalize is idempotent for ${JSON.stringify(input)}`, () => {
      const first = normalizeText(input);
      const second = normalizeText(first.content);
      expect(second.content).toBe(first.content);
      expect(second.changed).toBe(false);
    });
  }
});

describe("normalizeText — `changed` flag fidelity", () => {
  it("returns changed=false only when output equals input byte-for-byte", () => {
    expect(normalizeText("").changed).toBe(false);
    expect(normalizeText("x\n").changed).toBe(false);
    expect(normalizeText("a\nb\n").changed).toBe(false);
  });

  it("returns changed=true for any modification", () => {
    expect(normalizeText("﻿").changed).toBe(true); // BOM only
    expect(normalizeText("a\r\nb\n").changed).toBe(true); // CRLF
    expect(normalizeText("a\rb\n").changed).toBe(true); // lone CR
    expect(normalizeText("abc").changed).toBe(true); // missing trailing NL
  });
});

describe("shouldCanonicalize — only USER-edited vault text (excludes <configDir>/**)", () => {
  const cfg = ".obsidian";

  it("vault text files the user edits → true", () => {
    expect(shouldCanonicalize("Notes/idea.md", cfg)).toBe(true);
    expect(shouldCanonicalize("a.txt", cfg)).toBe(true);
    expect(shouldCanonicalize("deep/nested/file.md", cfg)).toBe(true);
  });

  it("anything under the config dir (autogenerated) → false", () => {
    expect(shouldCanonicalize(".obsidian/app.json", cfg)).toBe(false);
    expect(shouldCanonicalize(".obsidian/appearance.json", cfg)).toBe(false);
    // subdirs, incl. the plugin's own text files
    expect(shouldCanonicalize(".obsidian/plugins/foo/manifest.json", cfg)).toBe(false);
    expect(
      shouldCanonicalize(".obsidian/plugins/git-easy-sync/styles.css", cfg),
    ).toBe(false);
  });

  it("a SIBLING that merely shares the prefix is NOT excluded (slash matters)", () => {
    // `.obsidian-notes/` is a real vault folder, not the config dir.
    expect(shouldCanonicalize(".obsidian-notes/x.md", cfg)).toBe(true);
    expect(shouldCanonicalize(".obsidianish.md", cfg)).toBe(true);
  });

  it("non-text files → false regardless of location", () => {
    expect(shouldCanonicalize("img.png", cfg)).toBe(false);
    expect(shouldCanonicalize("Notes/photo.jpg", cfg)).toBe(false);
  });

  it("honours a CUSTOM config dir (the exclusion follows the actual configDir)", () => {
    // With a custom config dir, files under it are excluded and `.obsidian/` is NOT.
    expect(shouldCanonicalize("my-config/app.json", "my-config")).toBe(false);
    expect(shouldCanonicalize(".obsidian/app.json", "my-config")).toBe(true);
  });
});

describe("canonicalizeBytes — the commit side's one canonical form (COMMIT-PASS-PERF Крок 2)", () => {
  const enc = (s: string): ArrayBuffer =>
    new TextEncoder().encode(s).buffer as ArrayBuffer;
  const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

  it("not eligible → the input buffer itself, unchanged", () => {
    const input = enc("a\r\nb");
    const r = canonicalizeBytes(input, false);
    expect(r.bytes).toBe(input);
    expect(r.changed).toBe(false);
    expect(r.content).toBeNull();
  });

  it("eligible + already canonical → the input buffer itself, unchanged", () => {
    const input = enc("hello\n");
    const r = canonicalizeBytes(input, true);
    expect(r.bytes).toBe(input);
    expect(r.changed).toBe(false);
  });

  it("eligible + CRLF, multibyte, no trailing NL → canonical bytes and text", () => {
    const r = canonicalizeBytes(enc("як\r\nтак"), true);
    expect(r.changed).toBe(true);
    expect(r.content).toBe("як\nтак\n");
    expect(dec(r.bytes)).toBe("як\nтак\n");
  });

  it("eligible + leading BOM → stripped (the decode must SEE it)", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("x\n")]);
    const r = canonicalizeBytes(withBom.buffer as ArrayBuffer, true);
    expect(r.changed).toBe(true);
    expect(dec(r.bytes)).toBe("x\n");
    expect(r.bytes.byteLength).toBe(2);
  });

  it("eligible + invalid UTF-8 → passes through UNTOUCHED (no lossy decode)", () => {
    // cp1251 "Привіт\r\n" — not valid UTF-8.
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2, 0x0d, 0x0a]);
    const r = canonicalizeBytes(cp1251.buffer as ArrayBuffer, true);
    expect(r.changed).toBe(false);
    expect(new Uint8Array(r.bytes)).toEqual(cp1251);
  });
});
