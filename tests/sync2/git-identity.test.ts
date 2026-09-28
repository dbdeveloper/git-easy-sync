// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, vi } from "vitest";
import {
  resolveGitIdentity,
  noreplyEmailFor,
  learnGitIdentity,
  type IdentityProbeClient,
} from "../../src/sync2/git-identity";

describe("resolveGitIdentity is TOTAL — a push is never left without a date", () => {
  it("🔑 answers even when nothing at all is configured", () => {
    // The defect this replaces returned null here, which skipped the
    // author object, which made GitHub stamp PUSH time instead of the
    // batch's creation time — and the `.obsidian/` mtime tiebreak then
    // compared push-time against edit-time. Field bug 2026-09-28: a stale
    // build overwrote a fresh one.
    const id = resolveGitIdentity({});
    expect(id.name).not.toBe("");
    expect(id.email).not.toBe("");
  });

  it("🔑 falls back to the owner and a no-reply address", () => {
    // Derived, not invented: GitHub's own no-reply form still attributes
    // the commit to the account, which matters because it lands in a
    // permanent public record.
    expect(resolveGitIdentity({ githubOwner: "acme" })).toEqual({
      name: "acme",
      email: noreplyEmailFor("acme"),
    });
  });

  it("what the user typed always wins, field by field", () => {
    // Each field falls back independently: half-configured is a real
    // state, and it must not discard the half that IS set.
    expect(
      resolveGitIdentity({ githubOwner: "acme", gitAuthorName: "Ada" }),
    ).toEqual({ name: "Ada", email: noreplyEmailFor("acme") });
    expect(
      resolveGitIdentity({ githubOwner: "acme", gitAuthorEmail: "a@b.c" }),
    ).toEqual({ name: "acme", email: "a@b.c" });
  });

  it("whitespace-only settings count as unset", () => {
    // Android paste habits put spaces in fields; a name of " " would be
    // accepted by the API and read as blank by a human.
    expect(
      resolveGitIdentity({
        githubOwner: "acme",
        gitAuthorName: "   ",
        gitAuthorEmail: "  ",
      }),
    ).toEqual({ name: "acme", email: noreplyEmailFor("acme") });
  });
});

describe("learnGitIdentity — best effort, never fatal", () => {
  const client = (
    user: Awaited<ReturnType<IdentityProbeClient["getAuthenticatedUser"]>>,
    repo: Awaited<ReturnType<IdentityProbeClient["getLatestCommitAuthor"]>> = null,
  ): IdentityProbeClient & { repoCalls: () => number } => {
    let repoCalls = 0;
    return {
      getAuthenticatedUser: async () => user,
      getLatestCommitAuthor: async () => {
        repoCalls++;
        return repo;
      },
      repoCalls: () => repoCalls,
    };
  };

  it("takes the account's name and email when the profile exposes them", async () => {
    const c = client({ login: "acme", name: "Ada L", email: "ada@x.io" });
    expect(await learnGitIdentity(c)).toEqual({
      name: "Ada L",
      email: "ada@x.io",
    });
    // The repo is not consulted when the account already answered.
    expect(c.repoCalls()).toBe(0);
  });

  it("🔑 a PRIVATE profile email falls back to the repo's own history", async () => {
    // Measured as the common case: `GET /user` answers with email: null,
    // and `GET /user/emails` is denied to a fine-grained token
    // ("Resource not accessible by personal access token"). The repo's own
    // last commit is the better answer anyway — it keeps one repository's
    // history on ONE identity instead of introducing a second halfway
    // through.
    const c = client({ login: "acme", name: "Ada L", email: null }, {
      name: "Ada Lovelace",
      email: "ada@repo.io",
    });
    expect(await learnGitIdentity(c)).toEqual({
      name: "Ada L",
      email: "ada@repo.io",
    });
  });

  it("uses the login when the profile has no display name", async () => {
    const c = client({ login: "acme", name: null, email: "a@b.c" });
    expect(await learnGitIdentity(c)).toEqual({ name: "acme", email: "a@b.c" });
  });

  it("🔑 learns NOTHING rather than throwing, and that is not an error", async () => {
    // Offline, expired token, tightened scope — all ordinary. The caller
    // keeps its derived default, which is already valid, so there is
    // nothing to report and nothing to retry loudly.
    const throwing: IdentityProbeClient = {
      getAuthenticatedUser: async () => {
        throw new Error("offline");
      },
      getLatestCommitAuthor: async () => null,
    };
    await expect(learnGitIdentity(throwing)).resolves.toEqual({});
    await expect(learnGitIdentity(client(null))).resolves.toEqual({});
  });

  it("returns a partial when only one half is knowable", async () => {
    // Without this the caller could not fill the name it DID learn, and
    // would fall back to the bare login for no reason.
    const c = client({ login: "acme", name: "Ada L", email: null });
    expect(await learnGitIdentity(c)).toEqual({ name: "Ada L" });
  });
});
