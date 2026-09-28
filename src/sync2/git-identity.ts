// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// The git identity every push is stamped with — and why it may never be
// absent.
//
// ⚠️ This is a DATA-INTEGRITY concern, not a cosmetic one, which is the
// whole reason this module exists. The engine injects
// `date = batch.createdAt` on main pushes so that `remote.mtime` means the
// EDIT moment (SYNC2 §4.4); the `.obsidian/` mtime tiebreak then compares
// edit-time against edit-time. But the GitHub API will not take a date on
// its own — measured against the live API, 2026-09-28:
//
//   author: { date }                     → 422 «"email", "name" weren't supplied»
//   author: { name, email, date }        → accepted, and the date STICKS
//
// So no identity means no date, which means GitHub stamps PUSH time, which
// means a batch that was written hours ago but pushed just now looks NEWER
// than a file edited in between. That is exactly the data loss reported on
// 2026-09-28: an older build, stuck behind an expired token, overwrote a
// freshly built one.
//
// Hence `resolveGitIdentity` NEVER returns null. It used to
// (`name && email ? {...} : null`), and a silent null turned a documented
// invariant into a coin flip that depended on whether the user had filled
// in an optional Settings field.

export interface GitIdentity {
  name: string;
  email: string;
}

// GitHub's own no-reply form. Commits carrying it are still attributed to
// the account on github.com, so this is a real address for the purpose,
// not a placeholder — which matters, because it ends up in a permanent
// public record.
export function noreplyEmailFor(owner: string): string {
  return `${owner}@users.noreply.github.com`;
}

// The identity to stamp, from what is on hand. Pure and total: the caller
// is a push that must not be left without a date.
//
// Preference order, most specific first: what the user typed, then the
// account we are pushing as, then the derived no-reply address.
export function resolveGitIdentity(settings: {
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  githubOwner?: string;
}): GitIdentity {
  const owner = settings.githubOwner?.trim() || "git-easy-sync";
  const name = settings.gitAuthorName?.trim() || owner;
  const email = settings.gitAuthorEmail?.trim() || noreplyEmailFor(owner);
  return { name, email };
}

export interface IdentityProbeClient {
  // GET /user — the authenticated account. `email` is null when the
  // profile keeps it private, which is ordinary and not an error.
  getAuthenticatedUser(): Promise<{
    login: string;
    name: string | null;
    email: string | null;
  } | null>;
  // The most recent commit's author on the sync branch — what PREVIOUS
  // syncs actually wrote, so adopting it keeps one repo's history
  // consistent instead of introducing a second identity halfway through.
  getLatestCommitAuthor(): Promise<GitIdentity | null>;
}

// Best-effort: learn a real identity to OFFER the user, so the Settings
// fields arrive filled in rather than blank.
//
// Distinct from resolveGitIdentity on purpose. That one must always answer
// and never touch the network; this one may fail, and failing costs
// nothing because the fallback is already correct.
//
// ⚠️ `GET /user/emails` is deliberately NOT used: measured with the
// plugin's own fine-grained token it answers "Resource not accessible by
// personal access token", and asking users to widen a token's scope for a
// default value would be a poor trade.
export async function learnGitIdentity(
  client: IdentityProbeClient,
): Promise<Partial<GitIdentity>> {
  // PARTIAL on purpose: the two fields are learned independently, and a
  // name without an email is still better than falling back to the bare
  // account login. An empty object means "nothing better to offer" — not
  // an error, because the derived default is already valid.
  const out: Partial<GitIdentity> = {};
  try {
    const user = await client.getAuthenticatedUser();
    if (user) {
      const name = user.name?.trim() || user.login.trim();
      if (name) out.name = name;
      if (user.email) out.email = user.email;
    }
    if (out.email === undefined) {
      // A private profile email is ordinary, and the repo itself still
      // knows what its own commits were signed with — which is the better
      // answer anyway: it keeps one repo's history on one identity instead
      // of introducing a second halfway through.
      const fromRepo = await client.getLatestCommitAuthor();
      if (fromRepo?.email) {
        out.email = fromRepo.email;
        if (out.name === undefined && fromRepo.name) out.name = fromRepo.name;
      }
    }
  } catch {
    // Offline, an expired token, a tightened scope: all ordinary, and the
    // fallback covers every one of them.
  }
  return out;
}
