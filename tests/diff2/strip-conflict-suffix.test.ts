import { describe, it, expect } from "vitest";
import { formatConflictTimestamp, stripConflictSuffix } from "src/diff2/strip-conflict-suffix";
import { buildSiblingPath } from "src/sync2/conflict-store";

// Behavior contract for stripConflictSuffix: reverse the naming produced
// by conflict-store.ts::buildSiblingPath. Tests are organized by the
// shape variants buildSiblingPath emits (regular ext, no ext, dotfile,
// nested dirs) plus rejection cases for inputs that aren't siblings.

describe("stripConflictSuffix", () => {
  describe("standard shapes — happy paths", () => {
    it("strips suffix from a regular markdown sibling at root", () => {
      expect(
        stripConflictSuffix(
          "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      ).toBe("note.md");
    });

    it("strips suffix from a sibling inside a folder", () => {
      expect(
        stripConflictSuffix(
          "Notes/idea.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      ).toBe("Notes/idea.md");
    });

    it("preserves multi-segment directory paths", () => {
      expect(
        stripConflictSuffix(
          "A/B/C/note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      ).toBe("A/B/C/note.md");
    });

    it("strips suffix from a binary-extension sibling (.png)", () => {
      expect(
        stripConflictSuffix(
          "attachments/diagram.conflict-from-Laptop-2026-05-26T10-30-00Z.png",
        ),
      ).toBe("attachments/diagram.png");
    });
  });

  describe("base files without a regular extension", () => {
    it("strips suffix from a sibling whose base has no extension", () => {
      // buildSiblingPath shape for `Folder/README`:
      // `Folder/README.conflict-from-<label>-<iso>` (no trailing .ext)
      expect(
        stripConflictSuffix(
          "Folder/README.conflict-from-Phone-2026-05-26T10-30-00Z",
        ),
      ).toBe("Folder/README");
    });

    it("strips suffix from a sibling whose base is a dotfile", () => {
      // buildSiblingPath for `.gitignore`:
      // `.gitignore.conflict-from-<label>-<iso>` (the leading dot is part
      // of the stem; extensionOf() returns "" for dotfiles)
      expect(
        stripConflictSuffix(
          ".gitignore.conflict-from-Phone-2026-05-26T10-30-00Z",
        ),
      ).toBe(".gitignore");
    });

    it("strips suffix from a dotfile inside a folder", () => {
      expect(
        stripConflictSuffix(
          "Folder/.gitignore.conflict-from-Phone-2026-05-26T10-30-00Z",
        ),
      ).toBe("Folder/.gitignore");
    });
  });

  describe("device label variants", () => {
    it("handles a device label containing a dash", () => {
      expect(
        stripConflictSuffix(
          "note.conflict-from-Phone-iPhone-2026-05-26T10-30-00Z.md",
        ),
      ).toBe("note.md");
    });

    it("handles a device label containing whitespace", () => {
      // buildSiblingPath rewrites parens, keeps spaces. Verify the
      // greedy `.+-` segment still anchors on the trailing iso.
      expect(
        stripConflictSuffix(
          "note.conflict-from-My Phone-2026-05-26T10-30-00Z.md",
        ),
      ).toBe("note.md");
    });

    it("handles a device label that was bracket-sanitized from parens", () => {
      // buildSiblingPath turns "Phone (1)" into "Phone [1]" for FS safety.
      expect(
        stripConflictSuffix(
          "note.conflict-from-Phone [1]-2026-05-26T10-30-00Z.md",
        ),
      ).toBe("note.md");
    });
  });

  describe("rejection — inputs that aren't siblings", () => {
    it("returns null for a plain file with no conflict-from segment", () => {
      expect(stripConflictSuffix("note.md")).toBeNull();
    });

    it("returns null for an empty path", () => {
      expect(stripConflictSuffix("")).toBeNull();
    });

    it("returns null for a file that mentions conflict-from but has no iso timestamp", () => {
      expect(
        stripConflictSuffix("note.conflict-from-Phone.md"),
      ).toBeNull();
    });

    it("returns null for a file with a malformed iso timestamp", () => {
      // missing the Z suffix that the regex anchors on
      expect(
        stripConflictSuffix(
          "note.conflict-from-Phone-2026-05-26T10-30-00.md",
        ),
      ).toBeNull();
    });

    it("returns null for a file whose iso has fractional seconds", () => {
      // buildSiblingPath strips milliseconds; reject anything else.
      expect(
        stripConflictSuffix(
          "note.conflict-from-Phone-2026-05-26T10-30-00-123Z.md",
        ),
      ).toBeNull();
    });

    it("returns null for the unresolved-form produced by reset", () => {
      // unresolvedNameFor produces `<stem>.unresolved-<iso><ext>` — a
      // different naming convention. stripConflictSuffix must not
      // accidentally match it.
      expect(
        stripConflictSuffix("note.unresolved-2026-05-26T10-30-00Z.md"),
      ).toBeNull();
    });
  });

  describe("round-trip with buildSiblingPath", () => {
    // The strongest correctness witness: anything buildSiblingPath
    // produces should reverse cleanly back to its input vaultPath.
    const cases: Array<{ vault: string; device: string; label: string }> = [
      { vault: "note.md", device: "Phone", label: "regular root file" },
      { vault: "Folder/idea.md", device: "Phone", label: "regular nested file" },
      { vault: "A/B/C/deep.md", device: "Phone", label: "deeply nested file" },
      {
        vault: "attachments/img.png",
        device: "Laptop",
        label: "binary extension",
      },
      { vault: "README", device: "Phone", label: "no extension" },
      { vault: "Folder/README", device: "Phone", label: "no extension in folder" },
      { vault: ".gitignore", device: "Phone", label: "dotfile at root" },
      {
        vault: "Folder/.gitignore",
        device: "Phone",
        label: "dotfile in folder",
      },
      {
        vault: "note.md",
        device: "Phone (1)",
        label: "device label with parens",
      },
      {
        vault: "note.md",
        device: "My Phone",
        label: "device label with whitespace",
      },
      {
        vault: "note.md",
        device: "Phone-iPhone",
        label: "device label with dash",
      },
    ];

    const ts = Date.UTC(2026, 4, 26, 10, 30, 0); // 2026-05-26T10:30:00Z

    for (const { vault, device, label } of cases) {
      it(`round-trips for ${label}`, () => {
        const sibling = buildSiblingPath(vault, device, ts, "modify-vs-modify");
        expect(stripConflictSuffix(sibling)).toBe(vault);
      });
    }
  });
});

describe("formatConflictTimestamp — FS-safe isoTimestamp → readable for display", () => {
  it("YYYY-MM-DDTHH-MM-SSZ → YYYY-MM-DD HH:MM:SS (same numbers)", () => {
    expect(formatConflictTimestamp("2026-06-05T10-31-30Z")).toBe("2026-06-05 10:31:30");
  });
  it("tolerates a missing trailing Z", () => {
    expect(formatConflictTimestamp("2026-06-05T10-31-30")).toBe("2026-06-05 10:31:30");
  });
  it("leaves an already-formatted / unexpected / empty string untouched", () => {
    expect(formatConflictTimestamp("2026-06-05 10:31:30")).toBe("2026-06-05 10:31:30");
    expect(formatConflictTimestamp("")).toBe("");
    expect(formatConflictTimestamp("whatever")).toBe("whatever");
  });
});
