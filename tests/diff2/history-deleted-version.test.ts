// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// History lists every commit that TOUCHED a path — a commit that DELETED it
// too (owner's field report, 2026-10-08: every second .gitignore row failed
// with "Version … not found on GitHub"; those rows were "Delete .gitignore"
// commits). Such a row is not an error: it is "the file was deleted in this
// version" (owner's choice 1a — no extra requests; the 404 on open tells).

import { describe, expect, it } from "vitest";
import {
  fetchRemoteVersionContent,
  historyMountFailureText,
  historyRowWhoText,
  loadHistoryVersions,
  VersionDeletedError,
} from "../../src/diff2/history-versions";

describe("a History row whose commit deleted the file", () => {
  it("🔑 404 at that commit → VersionDeletedError (path + id), not a generic failure", async () => {
    const client = { getContentsAtRef: async () => null };
    const err = await fetchRemoteVersionContent(client, ".gitignore", "ac4d3de").catch((e) => e);
    expect(err).toBeInstanceOf(VersionDeletedError);
    expect(err.path).toBe(".gitignore");
    expect(err.id).toBe("ac4d3de");
  });

  it("the file there → its (base64) content", async () => {
    const client = { getContentsAtRef: async () => ({ content: "Kg==" }) };
    expect(await fetchRemoteVersionContent(client, ".gitignore", "9e447a6")).toBe("Kg==");
  });

  it("🔑 the editor says it calmly — not as an error", () => {
    expect(historyMountFailureText(new VersionDeletedError(".gitignore", "ac4d3de"))).toEqual({
      text: ".gitignore was deleted in this version — there is nothing to open.",
      isError: false,
    });
  });

  it("any other failure stays an error", () => {
    expect(historyMountFailureText(new Error("boom"))).toEqual({
      text: "Failed to start the edit session: Error: boom",
      isError: true,
    });
  });

  it("🔑 the row, once known, reads as a deletion", () => {
    const v = { local: false, date: 0, id: "ac4d3de", deviceLabel: "unknown" };
    expect(historyRowWhoText(v, false)).toBe("unknown");
    expect(historyRowWhoText(v, true)).toBe("unknown · deleted in this version");
    expect(historyRowWhoText({ ...v, local: true, deviceLabel: "Mac" }, false)).toBe("Mac · not pushed");
  });
});

// Owner, 2026-10-08: every error the user sees must reach the log too. The
// GitHub part of a History list failing used to be swallowed into a flag —
// the view had nothing to log.
describe("loadHistoryVersions — the GitHub failure is kept for the log", () => {
  it("🔑 githubErrorText carries the reason", async () => {
    const queue = { list: async () => [], read: async () => ({ id: "", createdAt: 0, files: [] }) };
    const client = {
      listCommitsForPath: async () => {
        throw new Error("HTTP 502");
      },
    };
    const r = await loadHistoryVersions(queue, client, ".gitignore", "main", "Mac");
    expect(r.githubError).toBe(true);
    expect(r.githubErrorText).toBe("Error: HTTP 502");
  });
});

// Owner, 2026-10-08: a commit NOT made by this plugin (device "unknown" —
// e.g. "Delete .gitignore" on github.com) is checked BEFORE the list is
// shown — rare, usually none per file — so a deletion is marked from the
// start. One request each, one after another. Our own commits are not
// checked (a deletion there is marked when it is opened). An unknown
// commit that CHANGED the file stays an ordinary row.
describe("loadHistoryVersions — unknown commits are checked up front", () => {
  const queue = { list: async () => [], read: async () => ({ id: "", createdAt: 0, files: [] }) };
  const commits = [
    { sha: "del1", date: "2026-10-05T10:00:00Z", message: "Delete .gitignore" },
    { sha: "ours", date: "2026-10-05T09:00:00Z", message: "Sync at 2026-10-05 11:00:00.000+02:00 (Mac)" },
    { sha: "edit", date: "2026-10-05T08:00:00Z", message: "Update .gitignore" },
  ];
  const client = { listCommitsForPath: async () => commits };

  it("🔑 only the unknown ones are probed, in order; a 404 one comes back as deleted", async () => {
    const probed: string[] = [];
    const exists = async (_p: string, id: string) => {
      probed.push(id);
      return id !== "del1";
    };
    const r = await loadHistoryVersions(queue, client, ".gitignore", "main", "Mac", undefined, undefined, exists);
    expect(probed).toEqual(["del1", "edit"]);
    expect(r.deletedIds).toEqual(["del1"]);
    expect(r.versions.map((v) => v.id)).toEqual(["del1", "ours", "edit"]); // all rows stay
  });

  it("a probe that fails (no network) marks nothing and stops probing", async () => {
    const probed: string[] = [];
    const exists = async (_p: string, id: string) => {
      probed.push(id);
      throw new Error("offline");
    };
    const r = await loadHistoryVersions(queue, client, ".gitignore", "main", "Mac", undefined, undefined, exists);
    expect(probed).toEqual(["del1"]);
    expect(r.deletedIds).toEqual([]);
  });
});
