// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { loadLogText, LOG_VIEW_MAX_BYTES } from "../../src/log-viewer/log-load";

// LOG-VIEWER step 5 (spec §2.3): the size is checked with stat BEFORE
// reading; a file over 10 MB is not read at all.

const adapter = (files: Record<string, string>, sizes: Record<string, number> = {}) => {
  const reads: string[] = [];
  return {
    reads,
    stat: async (p: string) =>
      p in files ? { size: sizes[p] ?? files[p].length, mtime: 0, ctime: 0, type: "file" as const } : null,
    read: async (p: string) => {
      reads.push(p);
      return files[p];
    },
  };
};

describe("loadLogText", () => {
  it("the limit is 10 MB (owner)", () => {
    expect(LOG_VIEW_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("a file under the limit is read", async () => {
    const a = adapter({ "x.log": "line\n" });
    expect(await loadLogText(a, "x.log")).toEqual({ kind: "ok", text: "line\n" });
  });

  it("🔑 a file OVER the limit is not read at all — its size is reported", async () => {
    const a = adapter({ "x.log": "…" }, { "x.log": LOG_VIEW_MAX_BYTES + 1 });
    expect(await loadLogText(a, "x.log")).toEqual({ kind: "too-big", size: LOG_VIEW_MAX_BYTES + 1 });
    expect(a.reads).toEqual([]);
  });

  it("exactly the limit is still read", async () => {
    const a = adapter({ "x.log": "a" }, { "x.log": LOG_VIEW_MAX_BYTES });
    expect((await loadLogText(a, "x.log")).kind).toBe("ok");
  });

  it("no file (just enabled, or deleted by hand) → an empty log, not an error", async () => {
    expect(await loadLogText(adapter({}), "x.log")).toEqual({ kind: "ok", text: "" });
  });

  it("a read that fails → an error result with the reason, not a throw", async () => {
    const a = {
      stat: async () => ({ size: 5, mtime: 0, ctime: 0, type: "file" as const }),
      read: async () => {
        throw new Error("EACCES");
      },
    };
    const r = await loadLogText(a, "x.log");
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toContain("EACCES");
  });
});
