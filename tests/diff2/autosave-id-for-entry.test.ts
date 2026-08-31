// autosaveIdForEntry — the single conflict-entry → autosave-id derivation
// shared by mount (startSession) and reopen (classifyReopen). The recovery
// linchpin: mount and reopen MUST agree on the id, so this must be pure,
// deterministic, and branch correctly on tracked vs synthetic.

import { describe, it, expect } from "vitest";
import type { ConflictEntry } from "../../src/diff2/synthetic-detector";
import { autosaveIdForEntry } from "../../src/diff2/synthetic-detector";
import { deriveAutosaveId } from "../../src/diff2/autosave-store";

function entry(over: Partial<ConflictEntry>): ConflictEntry {
  return {
    basePath: "Notes/idea.md",
    siblingPath: "Notes/idea.conflict-from-Phone-2026-05-26T10-30-00Z.md",
    deviceLabel: "Phone",
    isoTimestamp: "2026-05-26T10-30-00Z",
    kind: "synthetic",
    ...over,
  };
}

describe("autosaveIdForEntry", () => {
  it("tracked entry keys off the kind-prefixed (sorted) path pair — the v2 identity (record UUID is gone)", () => {
    const e = entry({ kind: "tracked" });
    expect(autosaveIdForEntry(e)).toBe(
      deriveAutosaveId("tracked", e.basePath, e.siblingPath),
    );
    expect(autosaveIdForEntry(e).startsWith("tracked-")).toBe(true);
  });

  it("synthetic entry keys off the (sorted) base+sibling path pair", () => {
    const e = entry({ kind: "synthetic" });
    expect(autosaveIdForEntry(e)).toBe(
      deriveAutosaveId("synthetic", e.basePath, e.siblingPath),
    );
  });

  it("a tracked and a synthetic session for the SAME pair never collide (kind prefix)", () => {
    const t = entry({ kind: "tracked" });
    const s2 = entry({ kind: "synthetic" });
    expect(autosaveIdForEntry(t)).not.toBe(autosaveIdForEntry(s2));
  });

  it("is deterministic — same entry yields the same id", () => {
    const e = entry({ kind: "synthetic" });
    expect(autosaveIdForEntry(e)).toBe(autosaveIdForEntry(e));
  });

  it("synthetic id is order-independent in the path pair", () => {
    const a = entry({ basePath: "a.md", siblingPath: "b.md", kind: "synthetic" });
    const b = entry({ basePath: "b.md", siblingPath: "a.md", kind: "synthetic" });
    expect(autosaveIdForEntry(a)).toBe(autosaveIdForEntry(b));
  });
});
