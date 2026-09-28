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
// ⚠️ `githubOwner` is the LAST resort and it is not always this person:
// on a repo owned by an organisation or by a colleague it names THEM. It
// stands because it is the only identifier available with no network at
// all, and because naming an org is a far smaller wrong than naming
// another individual — but it is meant to be short-lived. `learnGitIdentity`
// fills both fields from the authenticated account on the first sync, and
// from then on this branch is unreachable.
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
  // GET /user — the authenticated account, i.e. WHOSE TOKEN THIS IS: the
  // person at this device. That is the only identity we may ever stamp.
  // `email` is null when the profile keeps it private, which is ordinary
  // and not an error.
  getAuthenticatedUser(): Promise<{
    login: string;
    name: string | null;
    email: string | null;
  } | null>;
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
  // name without an email is still better than falling back to a repo
  // owner who may not be this person at all. An empty object means
  // "nothing better to offer" — not an error, because the derived default
  // is already valid.
  //
  // ⚠️ ONE source, deliberately: the authenticated account. An earlier
  // version also fell back to the REPO's most recent commit author, on the
  // reasoning that it keeps a repository's history on one identity. That
  // reasoning silently assumed a single-author repo. With ten people
  // pushing, the last commit is whoever pushed last — so this device would
  // have stamped its commits with A COLLEAGUE'S NAME AND EMAIL, a false
  // attribution in a permanent public record. A no-reply address derived
  // from OUR OWN login is worse-looking and strictly more honest.
  const out: Partial<GitIdentity> = {};
  try {
    const user = await client.getAuthenticatedUser();
    if (!user) return out;
    const name = user.name?.trim() || user.login.trim();
    if (name) out.name = name;
    // A private profile email is ordinary; the no-reply form derived from
    // this same login still points at this same account.
    out.email = user.email?.trim() || noreplyEmailFor(user.login.trim());
  } catch {
    // Offline, an expired token, a tightened scope: all ordinary, and the
    // fallback covers every one of them.
  }
  return out;
}
