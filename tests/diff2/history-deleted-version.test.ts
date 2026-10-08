// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// History lists every commit that TOUCHED a path — a commit that DELETED it
// too (owner's field report, 2026-10-08: every second .gitignore row failed
// with "Version … not found on GitHub"; those rows were "Delete .gitignore"
// commits). Owner's model: a deletion is a version too — the file is absent
// there, so it opens as an EMPTY side against the current file (like a
// delete-vs-modify conflict). No up-front checks; once opened, the row says
// "deleted in this version".

import { describe, expect, it } from "vitest";
import {
  fetchRemoteVersionContent,
  historyRowWhoText,
  loadHistoryVersions,
} from "../../src/diff2/history-versions";

describe("a History version whose commit deleted the file", () => {
  it("🔑 404 at that commit → `deleted` (opened as an empty side), not a failure", async () => {
    const client = { getContentsAtRef: async () => null };
    expect(await fetchRemoteVersionContent(client, ".gitignore", "ac4d3de")).toEqual({ deleted: true });
  });

  it("the file there → its (base64) content", async () => {
    const client = { getContentsAtRef: async () => ({ content: "Kg==" }) };
    expect(await fetchRemoteVersionContent(client, ".gitignore", "9e447a6")).toEqual({
      deleted: false,
      content: "Kg==",
    });
  });

  it("🔑 once opened, the row reads as a deletion", () => {
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
