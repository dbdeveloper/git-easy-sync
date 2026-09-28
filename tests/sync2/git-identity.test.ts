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

describe("learnGitIdentity — best effort, and only ever THIS account", () => {
  const client = (
    user: Awaited<ReturnType<IdentityProbeClient["getAuthenticatedUser"]>>,
  ): IdentityProbeClient => ({ getAuthenticatedUser: async () => user });

  it("takes the account's name and email when the profile exposes them", async () => {
    expect(
      await learnGitIdentity(client({ login: "acme", name: "Ada L", email: "ada@x.io" })),
    ).toEqual({ name: "Ada L", email: "ada@x.io" });
  });

  it("🔑 a PRIVATE profile email becomes OUR OWN login's no-reply address", async () => {
    // Measured: `GET /user` answers email: null for a private profile, and
    // `GET /user/emails` is denied to a fine-grained token ("Resource not
    // accessible by personal access token").
    //
    // ⚠️ An earlier version fell back to the REPO's last commit author
    // here, reasoning that it keeps a repository's history on one
    // identity. That silently assumed a single-author repo — the owner
    // asked what happens with ten people pushing, and the answer was that
    // this device would stamp its commits with A COLLEAGUE'S name and
    // email. The no-reply form derived from our OWN login looks worse and
    // is strictly more honest.
    expect(
      await learnGitIdentity(client({ login: "acme", name: "Ada L", email: null })),
    ).toEqual({ name: "Ada L", email: noreplyEmailFor("acme") });
  });

  it("uses the login when the profile has no display name", async () => {
    expect(
      await learnGitIdentity(client({ login: "acme", name: null, email: "a@b.c" })),
    ).toEqual({ name: "acme", email: "a@b.c" });
  });

  it("🔑 learns NOTHING rather than throwing, and that is not an error", async () => {
    // Offline, expired token, tightened scope — all ordinary. The caller
    // keeps its derived default, which is already valid, so there is
    // nothing to report and nothing to retry loudly.
    const throwing: IdentityProbeClient = {
      getAuthenticatedUser: async () => {
        throw new Error("offline");
      },
    };
    await expect(learnGitIdentity(throwing)).resolves.toEqual({});
    await expect(learnGitIdentity(client(null))).resolves.toEqual({});
  });
});
