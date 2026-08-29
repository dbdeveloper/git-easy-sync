# Pseudo-Merge Mode: Resolving Synchronisation Conflicts Through Filesystem Operations

> A design rationale for the conflict-resolution layer in the
> `git-easy-sync` Obsidian plugin.

## Abstract

This article describes **pseudo-merge mode**, the conflict-resolution
mechanism used by `git-easy-sync` to keep an Obsidian vault in step
with a GitHub repository across multiple devices. The plugin operates
under two hard constraints — it speaks only the GitHub REST API (no
`git` binary, no `isomorphic-git`) and it must work identically on
desktop and on a smartphone — so the resolution layer cannot reuse the
machinery a developer takes for granted (merge markers in an editor, an
interactive rebase, a graphical three-pane diff tool). Pseudo-merge
mode instead translates every conflict into a pair of ordinary files in
the vault and asks the user to resolve the conflict with the file
operations they already know: *delete*, *rename*, *edit*. Below the
surface, every step is backed by a private per-device branch on GitHub
that preserves the user's full edit history — including every
iteration produced while a conflict was being resolved — and by a
crash-tolerant atomic write protocol that makes the on-disk state
always recoverable. The resulting GitHub repository is, by
construction, a durable archive of every commit the user ever caused
the plugin to create; no resolution discards a previously-committed
version, even when the version is superseded.

The article assumes a reader who has used `git` casually at least once
and who can read a file path; it does not assume kernel-level
familiarity with version-control internals. Where git terminology
appears, a one-paragraph refresher is provided before it is used.

This document is the **algorithm specification**. It describes
*what* pseudo-merge mode does and *why*, independently of how the
engine that implements it is structured. The companion document
[SYNC2.md](./SYNC2.md) is the **engine specification**: it
describes how the algorithm is realised on top of the GitHub REST
API — the architectural layers, the on-disk state, the
crash-recovery protocols, the cross-platform contracts, the push
pipeline, and the Web Worker orchestra. Where this document refers
to an engine mechanism (a staging-file protocol, a recovery sweep,
a cross-platform contract), it cites the relevant SYNC2.md section
as `SYNC2 §N`. A reader who wants only the conceptual model can
stop at the end of this document; a reader who needs to maintain
or reproduce the implementation should read both.

---

## 1. The Problem: Vault Synchronization Without git

Consider a writer who keeps a vault of Markdown notes in Obsidian on a
laptop and on a phone. The same file, `Notes/idea.md`, lives on both
devices. On the laptop, the writer adds a line to the file. Later, on
the phone, with no recent network synchronization in between, the
writer adds a different line. Both devices then attempt to publish
their version to a shared GitHub repository.

If both devices were running a full `git` installation, the conflict
would be resolved by `git pull --no-rebase`: the second device would
detect the divergence, attempt a three-way textual merge, succeed if
the edits did not overlap, or fall back to inserting `<<<<<<<` /
`=======` / `>>>>>>>` conflict markers into the file for the writer to
disentangle. None of this is available to `git-easy-sync` by
design. The plugin runs inside Obsidian's process — including
Obsidian's Capacitor-based mobile build — and ships with **no `git`
binary and no JavaScript reimplementation of git's merge algorithm**.
The only tool at its disposal is the GitHub REST API, and the only
file operations available are those exposed by Obsidian's vault
adapter: read, write, delete, rename, and directory listing.

Even if a full git implementation were available, two of git's
default conflict workflows degrade badly under the plugin's actual
usage:

* **Merge markers inside text files** assume an environment in which
  the user is already in a code editor with the file open, with
  surrounding context visible, and with the cognitive bandwidth to
  triage `<<<<<<<` blocks. On a phone — Obsidian's mobile build is a
  full-featured target, not an afterthought — this assumption fails.
* **Binary files cannot be three-way-merged at all.** A modified PNG
  attachment on one device and a different modified PNG on the other
  has no meaningful merge result. Real `git` falls back to *"both
  modified — pick one"*, which is exactly the choice the user needs
  surfaced visually, not as a stash-and-checkout dance in a terminal.

The plugin therefore needs a conflict-resolution protocol that:

1. Never requires the user to open a terminal, an editor extension, or
   a modal dialog they did not initiate.
2. Treats text files and binary files uniformly at the level of *how
   the user resolves them*, even if the underlying detection logic
   differs.
3. Survives an interrupted operation — the mobile OS suspending the
   app mid-write, the laptop running out of battery during a push —
   without leaving the vault in a state from which recovery requires
   manual archaeology.
4. Allows the user to keep working on the file even while it is in a
   conflict, because waiting for the conflict to be resolved before
   typing the next sentence is a hostile constraint for a writer.

Pseudo-merge mode is the protocol that meets these four requirements.
It does so by replacing the metaphor of "the editor merges conflicting
versions for you" with the metaphor of "the vault grows an extra
sibling file per conflict, and you resolve the conflict by managing
those files yourself."

---

## 2. A Minimum-Viable Model of git

Pseudo-merge mode is built on top of GitHub's REST API, which in turn
exposes git's underlying data model directly. The article references
four primitives — **blob**, **tree**, **commit**, **branch** — plus
one structural property, **reachability**. A reader already fluent in
git may skim this section; the rest of the article uses these terms
without further explanation.

### 2.1 Blob, Tree, Commit

A **blob** is the content of a single file, addressed by the SHA-1
hash of those bytes. Blobs have no name and no location of their own;
the hash *is* the identity. Two files with identical bytes — say,
`README.md` in different folders — share a single blob in git's
storage.

A **tree** is a directory listing: an ordered collection of `(name,
mode, child_sha)` triples. A tree's `child_sha` may point at a blob
(meaning "this entry is a file") or at another tree (meaning "this
entry is a subdirectory"). Trees are themselves content-addressed: the
SHA of a tree object is determined by the SHAs of its children.

A **commit** is a snapshot, not a diff. It carries exactly one root
tree, a list of zero or more parent commits, an author, a committer, a
timestamp, and a free-form message. The root tree captures the entire
state of the project at that moment; the parents establish history.

```
commit  C2                           commit  C1
  tree     T2                          tree     T1
  parents  [C1]                        parents  []
  msg      "add second note"           msg      "initial commit"

           T2                                   T1
           ├── Notes/                           └── Notes/
           │    ├── idea.md  (blob B1)              └── idea.md  (blob B1)
           │    └── todo.md  (blob B2)
           └── ...
```

Notice that the blob `B1` for `idea.md` appears in both trees: the
file did not change between `C1` and `C2`, so git reuses the same
content-addressed blob.

### 2.2 HEAD and Branches

A **branch** in git is, mechanically, a movable label that points at
one commit. The label `main`, for example, is just an entry in a
table — `refs/heads/main → <some commit SHA>`. Pushing a new commit
to `main` updates the label to point at the new commit; the previous
commit is still in the database, still reachable through the new
commit's parent pointer, but `main` no longer names it directly.

**HEAD** is the special label that denotes "where you are right now"
in a local working copy. Pseudo-merge mode does not maintain a
working-copy HEAD in the conventional sense — the vault on disk plays
that role — but the *remote* HEAD of each branch on GitHub matters at
every step, because every push must build on top of the current remote
HEAD of the branch it targets.

### 2.3 Merge-Commit and Reachability

A **merge-commit** is a commit with two or more parents. It does not
introduce any file changes of its own; its tree is typically identical
to one of its parents (or a hand-built combination of them). The
purpose of a merge-commit is purely structural: it records that two
lines of history have been joined.

```
                  M  (merge-commit)
                 / \
                A   B
                 \ /
                  C  (common ancestor)
```

After `M` exists, both `A` and `B` are **reachable** from `M` by
walking parent pointers. Reachability is the property git's garbage
collector uses to decide what to keep: any commit reachable from a
named branch (or from `HEAD`, or from a tag) is preserved
indefinitely; an unreachable commit becomes a candidate for eventual
deletion.

Pseudo-merge mode exploits reachability deliberately: it creates and
later deletes branch labels, but it ensures that every commit ever
made on a conflict branch ends up reachable through a merge-commit on
`main`. Deleting the branch label does **not** delete the commits it
once named, because those commits still have an inbound parent edge
from the merge-commit. The user's edit history — including all the
intermediate attempts during conflict resolution — survives the
session and remains visible in the GitHub network graph.

---

## 3. Why the Conventional Resolution Toolkit Does Not Fit

Suppose the plugin attempted to forward git's standard conflict
behaviour directly to the user. The laptop pushed first; the phone
attempted to push second; GitHub rejected the phone's push because
its parent commit no longer matched `main`'s tip. Three options
present themselves:

**Option A: Insert text merge markers into `idea.md` on the phone.**
This is what `git pull` would do. It requires the user to open the
file, find the `<<<<<<<` blocks, decide what to keep, delete the
markers, save, and commit. On a phone — soft keyboard, small screen,
unstable cellular connection — every one of those steps is more
expensive than on a laptop. Worse, if the user opens the file in a
preview pane (the default in Obsidian Mobile), the markers render as
literal text in the rendered note. The "conflict" leaks into the
user's reading experience until they manually clean it up.

**Option B: Open a modal dialog showing both versions side by side.**
This is what most cloud-storage clients do (Dropbox, iCloud, etc.).
The dialog interrupts the user, forces a decision, and disappears
once a choice is made. Pseudo-merge mode rejects this because: (a)
modal dialogs during a background sync are a known UX failure pattern;
(b) the dialog can only show one conflict at a time, but the same
sync may produce conflicts on many files; (c) on a phone, the dialog
is small enough that the user often cannot see enough context to
choose; (d) once dismissed without a choice ("decide later"), the
state has nowhere to live except a parallel data structure the user
cannot see.

**Option C: Refuse the push and tell the user to fix it somewhere
else.** This is the safest option, but it stalls all other
synchronization. The user cannot push *any* file, including ones
entirely unrelated to the conflict, until the conflict is resolved.
For a vault of hundreds of notes, this is unacceptable.

Pseudo-merge mode takes a fourth path: it converts the conflict into
*two ordinary files in the vault* — the local version under its
original name, and the remote version under a sibling name — and
moves on. Synchronization of unrelated files continues immediately.
The user resolves the conflict at their leisure, with the same file
operations they already use every day in Obsidian's file explorer.

---

## 4. Pseudo-Merge Mode: The Core Idea

> *How can a divergent file be brought into the vault without showing
> raw merge markers, without launching a modal dialog, and without
> blocking the rest of the synchronization?*

The answer has three moving parts:

### 4.1 Try to Auto-Merge First

Before any conflict is registered, the plugin attempts an
**auto-merge** appropriate to the file's type. For ordinary text
files, this is a standard three-way merge using the diff3 algorithm:
given the **base** (the last commit both devices agreed on), **ours**
(the local version), and **theirs** (the remote version), it produces
a clean merged result whenever the edits did not overlap. For the
single specific case of an Obsidian plugin bundle
(`<configDir>/plugins/<id>/main.js` or its `manifest.json`), it
compares semantic versions and picks the higher one — three-way
merging a minified JavaScript bundle would produce garbage that
crashes Obsidian on load, so this case gets atomic resolution by
authorial intent (semver) rather than syntactic merge. For everything
else — images, PDFs, archives — auto-merge is not attempted; a binary
"merge" has no useful definition.

When auto-merge succeeds, the merged content goes straight to GitHub
as if no conflict had ever existed. The user is never informed,
because there is nothing to inform them about: their intent and the
other device's intent were already reconcilable.

When auto-merge fails — text edits on the same line, two different
versions of the same image, plugin bundles with identical versions —
the next two mechanisms engage.

### 4.2 Sibling Files in the Vault

A **sibling file** is created next to the conflicting file, carrying
the remote version's content under a derived name. For
`Notes/idea.md`, the sibling has the form:

```
Notes/idea.conflict-from-<remote-device>-<isoTimestamp>.md
```

For example, if the remote version came from a device labelled
"Phone" at 14:30:22 UTC on 8 May 2026:

```
Notes/
├── idea.md                                                 ← the user's local version (unchanged)
└── idea.conflict-from-Phone-2026-05-08T15-30-00Z.md        ← the remote version, written here
```

The original file is **not** overwritten. The local version of
`idea.md` continues to be the file the user sees in their note list,
opens, edits, and ultimately publishes — until they decide otherwise.
The sibling is a peer artifact, fully visible in Obsidian's file
explorer. The user can open it, read it, copy parts of it,
delete it, or rename it on top of `idea.md`, all using the standard
file operations they already know.

A single file may carry more than one sibling: if the user has
conflicts pending from two different remote devices, each device
contributes its own sibling, distinguishable by the `<remote-device>`
segment of the filename. The path is "in conflict" as long as at
least one sibling exists.

### 4.3 A Per-Device Conflict Branch on GitHub

Sibling files address the user-facing half of the problem. The
*remote* half — how to safely push the local version somewhere so it
is not lost, without forcing it onto `main` where other devices would
see it — is addressed by a **conflict branch**.

When a conflict is first detected on a device, the plugin creates a
GitHub branch named:

```
git-easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>
```

For example, `git-easy-sync-conflicts-Laptop-20260508153022-847`.
The local version of the conflicting file is pushed to this branch;
unrelated files in the same sync continue to flow to `main`. From
the perspective of any other device synchronizing against the same
repository, the conflict branch is invisible — only `main` matters
for incoming pulls. The conflict therefore stays strictly *private to
the device that detected it* until the user explicitly resolves it.

When the resolution is complete (the local version of `idea.md` has
been settled and the sibling has been removed), a **merge-commit** is
constructed manually on `main` whose two parents are: (a) the current
tip of `main`, and (b) the current tip of the conflict branch. The
branch label is then deleted. By the reachability argument from
§2.3, every commit ever made on the branch — including every
intermediate "I edited the file again while trying to resolve this"
commit — remains reachable from `main` through the merge-commit's
second parent. Nothing the user did is lost.

### 4.4 Preserving the Full Edit History

The previous paragraph deserves to be stated as a design goal in its
own right rather than as an emergent consequence of git's reachability
semantics, because it shapes several decisions throughout the
protocol: **every commit the user ever caused the plugin to create
remains accessible in the GitHub repository forever, including the
commits made during a conflict resolution session.**

A naïve conflict-resolution scheme would treat the in-progress
versions of `idea.md` as scratch state — useful for the user
mid-resolution, discardable once the conflict is closed. Pseudo-merge
mode takes the opposite position: those in-progress versions are not
scratch, they are *history*. A writer who deliberated for thirty
minutes between two phrasings produced a record of that deliberation;
discarding it silently is a form of data loss, even if the surviving
final version is the "correct" one.

The mechanism by which this preservation is achieved is the
combination of:

1. **Each iteration is its own commit on the conflict branch.** Six
   `[Sync]` clicks while a file is in conflict produce six commits on
   the branch, not one collapsed commit. (Even with
   `accumulateOfflineSyncs = true`, which folds queued user batches
   together to reduce GitHub API traffic, every distinct push
   produces a distinct commit on the branch.)
2. **The finalise step uses a true merge-commit on `main`**, not a
   fast-forward or a squash. The merge-commit has two parents — the
   prior `main` tip and the conflict-branch tip — so the entire
   branch is reachable from `main` through the second parent.
3. **The branch label is deleted after the merge.** Deleting a label
   does not delete the commits it once named; the commits remain in
   the repository, reachable from `main` through the merge-commit.
   The GitHub Network graph shows the branch as a short side-arm
   joined back to `main` even though no label currently points at
   its tip.

The practical consequence: months or years later, a user can browse
the GitHub repository's history, find the merge-commit for any
resolved conflict, follow its second parent backwards, and see the
sequence of intermediate versions that led to the final resolution.
Nothing about the resolution erases the journey to it. This contrasts
with several competing approaches — e.g., squash-merge workflows or
"resolve in place and discard the working copies" — where the only
artifact preserved is the outcome, not the path. Pseudo-merge mode
treats the repository as a durable archive of the user's actual
edits, not as a presentation layer for their final state.

This benefit compounds with `accumulateOfflineSyncs = false` (the
default): under that setting, every distinct `[Sync]` click on a
device with pending local edits produces a distinct commit, regardless
of whether the affected paths are in conflict. The repository thus
holds, in addition to the conflict-resolution history described
above, the full per-click commit log of the user's normal
synchronization activity. The setting can be enabled for users who
prefer fewer commits at the cost of less granular history; the
default favors preservation.

---

## 5. The Three Kinds of Conflict

The mechanism above is uniform, but the **detection** of a conflict
depends on what each side did to the file. Three cases arise:

### 5.1 Modify-vs-Modify

Both devices edited the same file independently of each other. This
is the canonical conflict.

```
Common ancestor                Local (laptop)        Remote (phone, on main)
# Project Aurora               # Project Aurora      # Project Aurora
Launch by Friday.              Launch by Monday.     Launch by Thursday.
```

The plugin first attempts an auto-merge. For a text file, this is a
three-way merge against the common ancestor; for our example, both
sides modified the same line, so the merge fails. The plugin then
creates a sibling holding the remote content:

```
Notes/idea.md                                              ← "Launch by Monday." (local)
Notes/idea.conflict-from-Phone-2026-05-08T15-30-00Z.md     ← "Launch by Thursday." (remote)
```

The local file is untouched. The user resolves at their convenience.

### 5.2 Delete-vs-Modify

The local device deleted the file; the remote device modified it. The
local intent ("this file should be gone") and the remote intent ("this
file matters and has been improved") are genuinely incompatible — the
plugin cannot decide which one to honor without asking.

A sibling carrying the remote modified content is created. There is
no local file to put next to it; the sibling stands alone in its
parent directory. The user resolves in one of two ways:

* **Delete the sibling** — the local "delete" intent wins; the next
  sync propagates the deletion to `main`.
* **Rename the sibling to the original name** (`idea.conflict-from-...md`
  → `idea.md`) — the remote "modify" intent wins; the next sync
  publishes that content as the current `idea.md`.

### 5.3 Modify-vs-Delete (Asymmetric: Auto-Resolves)

The local device modified the file; the remote device deleted it.
Symmetric with 6.2 in terms of git mechanics, but pseudo-merge mode
treats it asymmetrically and resolves it automatically in favor of
the local modification.

The reasoning: the user **already** demonstrated intent towards this
file by modifying it. The earlier deletion on the other device may
have been a mistake, a stale draft cleanup, or an action the user
themselves no longer endorses. To resolve the conflict in favor of
deletion would discard the more recent and more deliberate signal.

Concretely, the auto-merge gate returns the outcome `modify-wins`:
the file is published to `main` as if the deletion never happened.
On the next sync of the other device, the file is pulled back ("the
file has reappeared"), restoring the same state on both sides. No
sibling is created, no conflict branch is opened, and the user is
not informed — the resolution is deterministic and safe.

The asymmetry between 6.2 and 6.3 is recorded explicitly in the
conflict-kind type: only `modify-vs-modify` and `delete-vs-modify`
exist as registrable kinds. `modify-vs-delete` is not a kind at all —
it is a transient classification that the auto-merge gate intercepts
and resolves before any record is ever written.

---

## 6. Auto-Merge Strategies in Detail

Section 4.1 introduced auto-merge as the first thing tried on any
divergent path. The full dispatch table is:

| Classifier match                                       | Strategy                                                                                                 | Outcome on success  | Outcome on failure                                |
|--------------------------------------------------------|----------------------------------------------------------------------------------------------------------|---------------------|---------------------------------------------------|
| `theirs === null` (remote deleted, local modified)     | None — short-circuit                                                                                     | `modify-wins`       | (cannot fail)                                     |
| `pluginDirFileRole(path)` — a plugin's synced file (§28) | Atomic, per role (see below). **NEVER registers a conflict.**                                          | `atomic: ours / theirs` | (cannot fail — always resolves)                |
| `hasTextExtension(path)`                               | Three-way diff3 (`mergeText(ours, base, theirs)`)                                                        | `clean: <bytes>`    | `register-conflict` (overlapping or no base)      |
| else (binary)                                          | None                                                                                                     | —                   | `register-conflict` unconditionally               |

**Plugin-dir files never conflict (§28).** A plugin folder's
gitignore-bounded synced set — `main.js` / `*.js` / `manifest.json` /
`styles.css` / `data.json` — must **never** grow a `*.conflict-from.*`
sibling: a half-merged bundle (or a conflict marker in one file) breaks
the plugin. `pluginDirFileRole` classifies each path and the resolver
(`resolvePluginDirFile`) always returns an atomic side:

- **coupled bundle** (`main.js` / `*.js` / `manifest.json` / `styles.css`) —
  ONE winner per plugin-id, applied to every coupled file: higher
  `manifest.json` semver wins; on a tie, the later *canonical bundle
  mtime* (one value per side — `main.js`'s, else `manifest.json`'s — so
  the group can never split). `styles.css` **follows** that bundle
  winner (rule 1: updated JS may need updated CSS, so it can't be
  decided from its own bytes) — only when the bundle is byte-identical
  on both sides does it fall back to its own later mtime (rule 3).
- **`data.json`** — per-plugin state, resolved purely by later mtime
  (rule 4), never version-coupled. (Our own plugin's `data.json` is
  hard-excluded from sync — it holds the token.)
- A full tie (equal version AND equal mtime) resolves to **theirs**, so
  every device converges on the server copy. delete-vs-modify on a
  plugin file resurrects the modified side (the modify wins) rather than
  registering.

This replaced the old `isAtomicPluginFile` path (which covered only
`main.js`/`manifest.json`, sent `styles.css` through the 3-way text
merge, and registered on a version+mtime double-tie). The
canonical-bundle-mtime is the atomicity lynchpin — feeding each coupled
file its *own* mtime could split `main.js` and `manifest.json` to
different sides (a Frankenstein plugin).

A few clarifications on the table:

**`atomic` versus `clean`.** A `clean` outcome means the algorithm
produced *new* bytes by combining inputs. An `atomic` outcome means
the algorithm chose one of the two existing sides verbatim. Both are
treated identically by the caller — the resolved bytes are pushed to
`main`; no conflict is registered — but the distinction matters for
logging and for reasoning about what was lost (in `atomic`, the
losing side's bytes are no longer in the resolved file, though they
remain reachable in git history).

**Why binary always registers a conflict.** A plausible alternative
for binary files would be an *atomic mtime* picker — whichever side
has the more recent modification time wins, silently. This is
correct in the trivial case (one device truly has the newer
version) but catastrophic in the non-trivial case (both devices
edited the same image independently — the older version is
destroyed without the user ever knowing). Pseudo-merge mode rejects
the silent picker for that reason: binary files always produce a
sibling so that the user can see both versions and decide. The
user's resolution path is the same as for text — delete the sibling
or rename it over the base — but neither version is discarded
without their consent.

**Why plugin bundles use atomic semver.** The bundled `main.js` of
an Obsidian plugin is minified JavaScript. A three-way diff3 of two
minified bundles produces text that compiles to garbage and crashes
Obsidian when it loads. Sibling-based resolution is awkward for the
same reason: the user is unlikely to want to edit `main.js` by hand.
The atomic semver pick is the safe default because semver is an
explicit declaration of authorial intent — "version `1.4.0` is later
than `1.3.5`" carries actual semantic weight, not just a syntactic
guess.

---

## 7. Editing While in Conflict — A Distinguishing Feature

> *Why must a conflict block further edits to a file? It needs it not.*

A conventional VCS treats a file in conflict as inert: until the
conflict is resolved, the file is in a peculiar half-merged state and
the user is expected to stop working on it. Pseudo-merge mode removes
this restriction. **The user can keep editing `idea.md` even while
the conflict on it is pending,** and those edits flow into the same
private conflict branch the original local version was pushed to.
Other devices remain unaware of all of this until the user finalizes
the resolution.

The mechanism is mechanical and uses no new primitives:

1. The user edits `idea.md`. Obsidian writes the new content to
   disk. The `mtime` of the file changes.
2. On the next `[Sync]` click, the sync engine's normal change
   detector walks the vault, sees that `idea.md` has been modified,
   and enqueues it in a batch as any other change would be.
3. When the batch reaches `processBatch`, the engine **partitions**
   it: paths in conflict (`idea.md` is one) go to the conflict
   branch; paths not in conflict go to `main`. This is the "split
   push" described in SYNC2 §1 (the split-push architecture).
4. The conflict branch grows a new commit holding the latest local
   version of `idea.md`. The conflict branch's tree is always
   rebased forward — its base is the *current* `main.tree` plus the
   override entries for conflicting paths — so when the branch is
   eventually merged back, the merge is trivial.

Branch state during a multi-edit conflict session

```
main:    ── C0 ── C1 ── C2 ── C3 ──────────────────────────── (unrelated edits on main)
                  │
                  └── X1 ─── X2 ─── X3 ─── X4 (marker = "final state")
                      "Mon"  "Tue"  "Wed"  current local content
```
                      
After resolution and finalise:
```
                                    
main:    ── C0 ── C1 ── C2 ── C3 ──────────────── M (merge-commit)
                  │                              /
                  └── X1 ── X2 ── X3 ── X4 ─────/
                  (all commits remain reachable from M's second parent)
```

The motivation is the **preserve-all-commits** principle introduced
in §4.4. Editing while in conflict is the user-facing consequence of
the design's commitment to durability: every iteration the user
deliberately committed must survive in the repository, retrievable
months later through the GitHub Network graph or `git log --all`
against a cloned copy. Were the plugin to absorb multiple in-flight
edits into a single "resolution" commit, that contract would be
broken; the user's thirty-minute deliberation between two phrasings
would collapse into a single artifact stripped of the reasoning. The
private conflict branch is the durable archive of that reasoning, and
the final merge-commit on `main` is what ensures the archive remains
reachable after the branch label is deleted.

Three implications follow:

* **Other devices see nothing.** Until `main` advances (via the
  finalise merge), the conflict branch is invisible to peers. The
  user can experiment freely without polluting collaborators'
  workspaces.
* **The conflict branch may accumulate many commits.** A session
  spanning hours of work may produce dozens of branch commits before
  resolution. This is not a problem: the branch is private, GitHub
  imposes no practical limit, and the final merge-commit on `main` is
  always exactly one commit regardless of branch length.
* **Resolution is still tied to the sibling file.** No matter how
  many times the user edits `idea.md`, the conflict is not resolved
  until the sibling file (`idea.conflict-from-...md`) goes away or
  matches `idea.md` byte-for-byte. The sibling is the user's todo
  list; the branch is the user's history.

---

## 8. Scenarios

The mechanism above is best understood by tracing it through complete
sessions. The following scenarios use one running file,
`Notes/idea.md`, on two devices: a **Laptop** (`deviceLabel = "Laptop"`)
and a **Phone** (`deviceLabel = "Phone"`). Both started from a
common state in which the file contained:

```
# Project Aurora

Launch by Friday.
```

### Scenario A: Simple Modify-vs-Modify, Resolved By Deleting the Sibling

The Laptop edits the file to `Launch by Monday.` and syncs. `main`
on GitHub now holds the Laptop's version.

The Phone, unaware of this, edits the same line to `Launch by
Thursday.` and clicks `[Sync]`. The phone's `drain()` runs:

1. **Pull from `main`** discovers that `idea.md` has a remote SHA
   different from the Phone's snapshot's recorded SHA. The Phone's
   local file is also modified relative to the snapshot — both
   sides changed. The plugin attempts a three-way merge: the base
   is "Launch by Friday."; ours is "Launch by Thursday."; theirs is
   "Launch by Monday." The same line was edited on both sides, so
   the merge produces conflict markers — the auto-merge gate
   returns `register-conflict`.
2. The plugin creates a conflict branch
   `git-easy-sync-conflicts-Phone-20260508153022-847` on the
   current `main` HEAD and pushes the Phone's version of `idea.md`
   to it.
3. A sibling is written to the vault using the `.sync-tmp` staging
   protocol (SYNC2 §2.4):
   `Notes/idea.conflict-from-Laptop-2026-05-08T15-30-00Z.md`
   containing `Launch by Monday.`
4. A conflict record is persisted under
   `.obsidian/plugins/git-easy-sync/.conflicts/<id>/meta.json`.

The status bar shows `🔀 1`. The Phone's `idea.md` still reads
`Launch by Thursday.` — the user can continue editing it.

The user inspects both files, decides the Laptop's "Monday" version
is the right one, opens the file explorer, and **deletes**
`Notes/idea.md` (their own version), then **renames** the sibling
back to `idea.md`. On the next `[Sync]`:

1. `evaluateConflictState`'s **Phase A** runs first. The record's
   sibling path is `idea.conflict-from-Laptop-...md`, but that file
   no longer exists (the user renamed it onto `idea.md`). The
   record is dropped from the store.
2. **Phase B** observes that the path `idea.md` no longer has any
   open records. The store synthesises a side-batch whose effect is
   "push the current vault content of `idea.md` to main." This
   batch is added to the queue.
3. `processBatch` runs over the side-batch. It pushes the new
   content of `idea.md` to `main`.
4. After the queue drains, the conflict-record store is empty and
   the branch exists. The finalised block runs: a marker commit is
   written to the branch capturing the final state, then a
   merge-commit on `main` is constructed manually with two parents
   (the current `main` head and the branch head). The merge-commit
   becomes the new `main` tip, and the branch label is deleted.

The Laptop's next sync sees the merge-commit on `main`, pulls the
new tree, and writes the updated `idea.md`. Convergence achieved.

### Scenario B: A Long Offline Period and Accumulated Edits

The Phone has been offline for two weeks. During that time the
user has, on the Phone, edited `idea.md` six times — each edit
producing a separate commit batch on disk because of the
`accumulateOfflineSyncs = false` setting. Meanwhile, the Laptop has
been online and has made eleven of its own edits to the same file,
all pushed to `main`.

The user opens the Phone, connects to Wi-Fi, and clicks `[Sync]`.

The Phone's queue holds six batches: B1, B2, B3, B4, B5, B6 — each
one containing a successively more refined version of `idea.md`.
The drain processes them sequentially.

For **B1**, the pull-side step observes that `main` has eleven
commits the Phone has not seen. The plugin attempts auto-merge
against the base (the snapshot from two weeks ago), the Phone's B1
content, and the current `main` content. The text diverges — same
line, different edits — and auto-merge fails. A conflict branch is
created, B1's content is pushed to it, a sibling file is written.

For **B2 through B6**, the file is now in `inConflictFiles`. Each
batch's `processBatch` partitions the file into the "conflicting"
side: the content of `idea.md` for that batch is pushed as another
commit on the conflict branch, alongside B1. None of them go to
`main`. None of them update the existing sibling — only the
**branch** grows. The sibling continues to show the version of
`idea.md` that `main` currently has (the Laptop's most recent
version), unchanged.

After all six batches drain, the branch holds seven commits
(B1, B2, B3, B4, B5, B6, plus a `final state` marker added when the
queue empties). The Phone shows `🔀 1` in the status bar. The user
sees a single sibling file with the Laptop's version and the
current local file with the user's own latest version.

The user resolves the conflict — say by choosing their own version —
by deleting the sibling. The next `[Sync]` runs Phases A and B as
described in Scenario A: the record is dropped, the side-batch
propagates the current local content to `main`, and the
merge-commit on `main` lands. The merge-commit's second parent is
the branch head, so all seven branch commits remain reachable.

When the Laptop next synchronises, it pulls the merge-commit, sees
the new `idea.md`, and overwrites its own version. The Phone's
intent — accumulated over six iterations — is now the canonical
state, and the network graph on GitHub shows the full record of how
the Phone arrived at it.

### Scenario C: Multi-Sibling From Multiple Devices

A vault is shared across three devices: Laptop, Phone, Tablet. All
three edit `idea.md` independently during a brief no-connection
window. The Laptop syncs first (its version reaches `main`). The
Phone syncs second:

* Pull from `main` reveals divergence with the Laptop. Auto-merge
  fails (overlapping edits). A sibling is created:
  `idea.conflict-from-Laptop-2026-05-08T15-30-00Z.md` with the
  Laptop's content.
* A conflict branch is created on the Phone; the Phone's version of
  `idea.md` is pushed to it.

The Tablet now syncs. `main` still holds the Laptop's version (the
Phone's branch has not been merged). The Tablet's pull sees the
same divergence the Phone saw, but against the *Laptop's* content,
not the Phone's. Auto-merge fails; the Tablet writes its own
sibling:
`idea.conflict-from-Laptop-2026-05-08T15-30-01Z.md`. The Tablet
opens its own private conflict branch and pushes its own version of
`idea.md` to it.

The Phone now syncs again, having received a notification of the
Tablet's activity. The Phone's pull from `main` reveals no change
(the Tablet's branch is private). But suppose the user has switched
to the Laptop and resolved the original conflict — the Laptop's
merge-commit is now on `main`. The Phone's next pull sees that
`main` has a new version of `idea.md` (the Laptop's resolved
content). Because `idea.md` is already in conflict on the Phone,
the pull-side handler writes a **second** sibling on the Phone:
`idea.conflict-from-Laptop-2026-05-08T15-30-22Z.md`. The Phone now
has two siblings for the same base file, each from a different
"version of the Laptop." The resolution rule generalises naturally:
the conflict on `idea.md` is closed only when **every** sibling for
that path is gone (or matches the base byte-for-byte). The user
deletes or merges siblings one at a time; the path remains "in
conflict" until the last one is settled.

### Scenario D: Crash Mid-Create

The Phone is processing the conflict from Scenario A. Step 1 (write
`idea.conflict-from-Laptop-...sync-tmp.md`) completes. Step 2 (write
`meta.json`) begins. The OS suspends the app before `meta.json` is
fully written.

On the next plugin load:

1. The atomic-write recovery sweep walks the vault, finds the
   `.sync-tmp` staging file, and consults the conflict-record store.
   The record does not exist (Step 2 never finished). Per SYNC2 §2.5's
   `.sync-tmp` pass: no record names this final path → the staging
   file is dropped as a Path A transient (the only safe assumption
   when there is no ownership claim).
2. The conflict store loads (zero records).
3. The next `[Sync]` runs as if the confliet never happened. The
   pull re-encounters the divergence between Phone and `main`,
   auto-merge fails again, and the protocol restarts at Step 1 with
   a fresh record. The user sees the same end state as if the crash
   had not occurred — modulo the (effectively invisible) time
   between attempts.

Had the crash occurred between Step 2 and Step 3 instead — i.e.,
the record was written but the final rename did not happen — the
recovery sweep would find both the `.sync-tmp` staging file and a
record naming the final path. The SHA-verify check would succeed
(the bytes match `record.theirsBlobSha` because they were written
from `theirsContent` in Step 1), and the sweep would complete
Step 3 by performing the rename. The user opens Obsidian and sees
the sibling at its final name; nothing visible suggests anything
went wrong.

### Scenario E: Partial Resolution of a Multi-Path Conflict Session

Scenarios A through D all involved a single conflicted path. Real
multi-device usage routinely produces several conflicts in one
sync. This scenario traces how those resolve one at a time, and
what the relationship is between per-file resolution and the
conflict branch's final merge.

Consider a wider divergence than Scenario A: while the Phone was
offline, the user edited three files on it — `Notes/idea.md`,
`Notes/plan.md`, and `Notes/todo.md` — and the Laptop, online,
edited the same three files. All three pairs of edits land on
overlapping lines, so auto-merge fails on each.

When the Phone reconnects and clicks `[Sync]`, the drain processes
its queued batch:

1. Pull from `main` discovers that all three files diverge.
   Auto-merge attempts run, all three fail, and three conflicts are
   registered in sequence:
   - A conflict branch is created on the first registration —
     `git-easy-sync-conflicts-Phone-20260508153022-847` — at
     the current `main` HEAD. The Phone's pre-conflict version of
     `idea.md` is pushed to it as the first commit
     (`message: "conflict (Phone)"`).
   - The second and third registrations each append one commit to
     the **same** conflict branch, carrying the Phone's
     pre-conflict versions of `plan.md` and `todo.md` respectively.
   - Three sibling files are written next to the originals:
     - `Notes/idea.conflict-from-Laptop-...md`
     - `Notes/plan.conflict-from-Laptop-...md`
     - `Notes/todo.conflict-from-Laptop-...md`
   - Three conflict records are persisted, one per file.

State after the drain:

```
GitHub:
  main:       ── ... ── Cn (Laptop's three edits) ───────────
                            │
                            └── X1 ── X2 ── X3
                              (idea  (plan   (todo
                               Phone) Phone)  Phone)
                                              ↑
                                              conflict branch tip

Phone vault:
  Notes/idea.md                                  ← Phone's version
  Notes/idea.conflict-from-Laptop-...md          ← sibling (Laptop's)
  Notes/plan.md                                  ← Phone's version
  Notes/plan.conflict-from-Laptop-...md          ← sibling (Laptop's)
  Notes/todo.md                                  ← Phone's version
  Notes/todo.conflict-from-Laptop-...md          ← sibling (Laptop's)

Status bar: 🔀 3
```

Three records in the conflict store, one conflict branch with three
commits, three pairs of files in the vault. `main` is unchanged
relative to before the Phone's sync — none of the conflicted files
have reached it.

**First resolution — `idea.md`, by deleting the sibling.** The user
inspects, decides their Phone version of `idea.md` is correct, and
deletes the sibling `idea.conflict-from-Laptop-...md`. On the next
`[Sync]`:

- **Phase A** finds the record for `idea.md` has `!siblingExists`
  (user-deleted) → record dropped from store.
- **Phase B** observes that `idea.md` now has zero records →
  `enqueueSynthetic({path: "idea.md", content: <Phone's bytes>,
  parentCommitSha: lastSync, ...})` adds a side-batch to the queue.
- `processBatch` runs over the side-batch. The path is no longer in
  `inConflictFiles` (no records), so it partitions into `plainPaths`,
  and the new content of `idea.md` is pushed **to `main`** as an
  ordinary commit (`message: "resolve conflict (Phone)"`,
  `meta.synthetic: true`).
- **Finalise gate:** `store.records.length === 2` — `plan.md` and
  `todo.md` still have records. The finalise block at the end of the
  drain skips. The conflict branch is untouched.

```
GitHub:
  main:       ── ... ── Cn ── M1
                            │  ↑
                            │  "resolve conflict (Phone)" — idea.md
                            │
                            └── X1 ── X2 ── X3   (unchanged)

Status bar: 🔀 2
```

**Second resolution — `plan.md`, by renaming the sibling onto the
base.** The user prefers the Laptop's version of `plan.md`. They
rename `plan.conflict-from-Laptop-...md` → `plan.md`, overwriting
the Phone's version. On the next `[Sync]`:

- **Phase A** finds the record for `plan.md` has `!siblingExists`
  (renamed away) → record dropped.
- **Phase B** synthesises a side-batch for `plan.md` containing the
  bytes now sitting at `plan.md` (the Laptop's version).
- `processBatch` pushes the new `plan.md` content to **`main`** as
  another ordinary commit.
- **Finalise gate:** `store.records.length === 1` — `todo.md` still
  pending. Finalise still does not run.

```
GitHub:
  main:       ── ... ── Cn ── M1 ── M2
                            │       ↑
                            │       "resolve conflict (Phone)" — plan.md
                            │
                            └── X1 ── X2 ── X3   (still unchanged)

Status bar: 🔀 1
```

**Third (and last) resolution — `todo.md`, by hand-merging.** The
user opens both `todo.md` and its sibling, copies the wanted lines
from each into `todo.md`, then deletes the sibling. On the next
`[Sync]`:

- **Phase A** finds the record for `todo.md` has `!siblingExists`
  → record dropped.
- **Phase B** synthesises a side-batch for `todo.md` with the
  merged content.
- `processBatch` pushes the merged `todo.md` to `main` as the third
  "resolve conflict (Phone)" commit.
- **Finalise gate:** `store.records.length === 0` **and** the
  conflict branch exists → the finalise block fires:
  1. A marker commit (`final state (Phone)`) is written to the
     branch's tip, preserving the Phone's final state on the branch.
  2. A manual `createCommit({message: "merge conflict-branch
     (Phone)", treeSha: main.tree, parents: [main.head,
     branch.head]})` constructs the merge-commit on `main`.
  3. `updateBranchHead` makes the merge-commit `main`'s new tip.
  4. `deleteReference("heads/git-easy-sync-conflicts-Phone-...")`
     removes the branch label. The four branch commits remain
     reachable through the merge-commit's second parent (§2.3).
  5. `lastSyncCommitSha` is advanced to the merge-commit.

```
GitHub:
  main:       ── ... ── Cn ── M1 ── M2 ── M3 ── M (merge-commit)
                            │                  /
                            └── X1 ── X2 ── X3 ── X4 (final state)
                            (branch label deleted; commits still reachable through M)

Status bar: (empty — no conflicts pending)
```

**Net history view.** The repository now shows, in chronological
order on `main`:

- `Cn` — the Laptop's pre-conflict commits.
- `M1`, `M2`, `M3` — three separate "resolve conflict (Phone)"
  commits, one per resolved file. Each commit touches exactly its
  one file; no batching, no cross-contamination between resolutions.
- `M` — the merge-commit that joins the conflict branch back into
  `main`. Its second parent is the branch tip; the four branch
  commits (X1, X2, X3, X4) remain part of the repository's history
  forever, visible in the GitHub Network graph as a four-commit side
  arm joining `main` at `M`.

**The structural property to note.** The conflict branch was alive
for the full duration of the multi-conflict session — through all
three per-file resolutions — and was only finalised when the
**last** record disappeared from the store. Each per-file resolution
published its result to `main` as an ordinary commit by the same
Phase B → side-batch → `processBatch` → main-push pipeline that any
non-conflicting file would use. The branch and its merge-commit
exist for one reason only: to keep the Phone's pre-conflict and
in-conflict edits to *every* file in this session permanently
reachable from `main`. Per-file closure is therefore cheap and
local — one ordinary commit on `main`, no branch round-trips — and
the branch lifecycle is governed strictly by the "store empty?"
predicate at drain end.

---

## 9. What Pseudo-Merge Mode Does *Not* Promise

Honest engineering documentation must enumerate what the design does
not solve, in addition to what it does. Four points deserve explicit
mention:

**Ping-pong between two devices on the same file is possible.** If
Device A and Device B both detect a conflict on `idea.md` at
roughly the same time, each opens its own private conflict branch.
When A resolves and merges, `main` advances. The next sync on B
sees that advance, may itself detect a fresh conflict against the
new `main` (B's local version still differs from the post-merge
state), and produces *yet another* sibling on B. This is a
fundamental property of distributed concurrent edit, not a flaw in
the protocol. The user resolves it with the same workflow as any
other conflict; the only consequence is that "resolve once and be
done" requires the absence of further independent edits during the
resolution.

**Atomicity per `[Sync]` click no longer holds.** A single click
may produce some commits on `main` (for non-conflicting files) and
some commits on a conflict branch (for conflicting files). This is
analogous to `git pull --rebase` splitting local commits into
patches, and is unavoidable given that the protocol must always be
able to publish non-conflicting changes without waiting on a
human-in-the-loop conflict resolution.

**The conflict branch is private and not shareable.** Another
device — even one owned by the same user — cannot help resolve the
conflict; the branch is invisible to peers, and finalising it can
only be done by the device that opened it. This is a deliberate
trade-off in favour of conceptual simplicity: every sync involves
exactly two entities (this device and `main`), never a triangle.

**Orphan conflict branches accumulate.** If a device is permanently
retired — uninstalled, lost, factory-reset — its conflict branches
remain on GitHub, with no automated cleanup. The user can delete
them manually through the GitHub web UI at any time; the plugin
itself does not enumerate-and-prune, on the principle that doing so
would be too easy to invoke accidentally and would silently destroy
work the user might still want.

---

## 10. Glossary

The following terms appear repeatedly in the article. Definitions are
intentionally concise; consult the relevant section for context.

**Auto-merge** — The first step on any divergent path: an attempt to
reconcile the two sides without surfacing a conflict to the user.
Succeeds for non-overlapping text edits, plugin bundles with
differing semantic versions, and modify-vs-delete pairs; otherwise
the path is registered as a conflict.

**Base** — The last commit (and its corresponding file content) that
both diverging sides agreed on. The "common ancestor" in three-way
merge terminology. Stored locally in the snapshot store
(`metadata.json`'s `lastSyncCommitSha`) and re-fetched as needed
during pull-side reconciliation.

**Batch** — A unit of synchronisation work persisted on disk under
`.obsidian/plugins/git-easy-sync/.push-queue/<id>/`. Holds the
files about to be committed, their target commit message, and the
parent commit SHA the push will build on.

**Blob** — A file's content addressed by the SHA-1 hash of its bytes.
The fundamental unit of git's object storage; has no name and no
location of its own.

**Commit** — A snapshot of a tree, accompanied by a list of parent
commits, an author, a committer, and a message. The unit of
historical record in git.

**Conflict branch** — A per-device GitHub branch named
`git-easy-sync-conflicts-<deviceLabel>-<timestamp>-<msec>` to
which the device's local version of every conflicting file is
pushed. Invisible to other devices until finalised through a
merge-commit on `main`.

**Conflict record** — A persisted entry in the conflict store binding
a vault path to its sibling file, the remote content's SHA, the
remote device's label, and cached `(mtime, size, sha)` triples for
fast freshness checks. Stored on disk as one
`meta.json` per record under
`.obsidian/plugins/git-easy-sync/.conflicts/<id>/`.

**Conflict store** — The in-memory plus on-disk index of all active
conflict records. The single source of truth for "what is in
conflict on this device"; the set of in-conflict file paths is
derived from the store, not stored separately.

**Drain** — The plugin's network worker loop, executed once per
`[Sync]` click (and on interval ticks). One iteration of the loop
pulls from `main`, then pushes one batch from the queue, then
repeats until the queue is empty.

**Finalise** — The closing sequence when a conflict branch's last
record is dropped: marker commit on the branch, a manually
constructed merge-commit on `main` whose parents are
`[main.head, branch.head]`, and a `deleteRef` removing the branch
label. All branch commits remain reachable through the
merge-commit's second parent.

**HEAD** — A label naming "the current commit." On GitHub, every
branch has a HEAD (its tip); the plugin reads each branch's HEAD
during pull and updates `main`'s HEAD on push. The plugin does not
maintain a working-copy HEAD — the vault on disk plays that role.

**Merge-commit** — A commit with two or more parents. Records that
two lines of history have been joined; does not introduce file
changes of its own. The finalise step builds one of these manually
to merge a conflict branch back into `main`.

**Phase A / Phase B** — The two phases of `evaluateConflictState`,
the only function that mutates the conflict store at runtime. Phase
A is per-record: it removes engine-deletable siblings (where the
sibling and base contents are identical) and drops records whose
siblings the user already deleted. Phase B is per-path: for every
path whose records all disappeared during Phase A, it synthesises a
side-batch that propagates the live vault state to `main`.

**Reachability** — A commit is reachable from a label (a branch, a
tag, HEAD) if there is a chain of parent pointers leading from the
label's commit to the commit in question. git's garbage collector
preserves all reachable commits indefinitely; pseudo-merge mode
exploits this to keep branch history alive after the branch label is
deleted.

**Reconciliation (push-side)** — The handling in `processBatch` of
the situation in which `main`'s HEAD advanced between the batch's
creation and its push. The same auto-merge gate as on the pull side
runs against the new `main` tree; failure registers the path as a
conflict, the same as pull-side detection would.

**Sibling file** — An additional file in the vault next to a
conflicting base file, named
`<basename>.conflict-from-<remoteDevice>-<isoTimestamp>.<ext>` and
carrying the remote side's content. The user resolves the conflict
by manipulating this file with standard operations: delete it, edit
it, rename it onto the base, etc.

**Side-batch** — A batch synthesized inline by Phase B of
`evaluateConflictState` to propagate a resolved file's live content
to `main`. Marked `synthetic: true` in its meta.json; treated as a
solo batch by the queue (never folded into other user batches).

**Snapshot store** — The local persistent record of "what each path
looked like in the version of the repository this device most
recently synchronized against." Stored at
`.obsidian/plugins/git-easy-sync/git-easy-sync-metadata.json`.
Used by the change detector and by pull-side reconciliation to
distinguish "this file changed locally" from "this file changed
remotely" from "this file changed on both sides."

**Staging path / `.sync-tmp` / `.sync-bak`** — The intermediate
location of a file during the atomic writing protocols. `.sync-tmp`
holds new bytes destined for a target path (forward direction;
both Path A and Path B produce these). `.sync-bak` holds the old
bytes of a file moved aside before an overwriting (rollback
direction; only Path A produces these). Both use pre-suffix form
(e.g., `note.sync-tmp.md`, `note.sync-bak.md`) so that the file
extension is preserved and gitignore's `*.sync-tmp*` / `*.sync-bak*`
patterns catch them. See SYNC2 §2.

**Tree** — A directory listing in git's object storage: an ordered
collection of `(name, mode, sha)` entries where each `sha` points
at a blob (file) or another tree (subdirectory). Trees are
content-addressed; identical directory contents produce the same
tree SHA regardless of where in the project they appear.

**Watermark** — A timestamp threshold used to skip stat-and-hash
work for unchanged files. The change detector compares each
vault file's `mtime` to `SnapshotStore.lastCommitMtime` and only
considers files modified since that point as candidates for a real
diff. The same pattern is used per-record in the conflict store for
the cached `(siblingMtime, siblingSize, siblingSha)` triple.

**Cross-platform contract** — A rule of the form "this filesystem
/ URL / adapter behaves differently on platform X than on platform
Y" that the protocol normalises in one place. The three current
contracts (forbidden-character set, GitHub Contents URL encoding,
Capacitor-rename-doesn't-overwrite) live in
`src/sync2/cross-platform.ts`; see SYNC2 §3.

**Forbidden character (filename)** — One of the 12 ASCII characters
rejected either by the host platform (Family 1: `< > : " | ? *
\` — Obsidian Android only) or by Obsidian itself (Family 2: `# ^
[ ]` — both platforms, because of wiki-link grammar). Replaced by
`sanitizeFilename()` with visually-faithful Unicode counterparts;
see SYNC2 §3.

**Pending-deletions queue** — Explicit on-disk store at
`<configDir>/plugins/<self>/.pending-deletions/` recording paths
the engine must delete from GitHub on the next push. Used by pull-
side sanitize (SYNC2 §3) when a forbidden-named GitHub file is
materialised locally under its canonical name and the forbidden
path itself needs cleanup. Replaces the older phantom-snapshot
mechanism; see SYNC2 §4.2.

**Pre-flight validation** — A check performed on a push-side
operation (every `createTree` request that carries deletion
entries) *before* the request is sent, against current GitHub
state, to verify the operation's assumptions still hold. The
opposite of optimistic write-and-retry; see SYNC2 §4.1.

**Stale-state error** (`StaleStateError`) — Typed error raised when
two pieces of remote state observed within one sync click no
longer agree. Causes include client URL-encoding bugs, token
permission drift, replica eventual consistency, and concurrent
force-push that rewrote currentHead. Always non-retriable on its
own surface: the per-file catch aborts the loop, the cursor stays
put, the next drain retries. See SYNC2 §5.

**Skip-class** — One of four labels (`applied`, `deferred`,
`already-correct`, `unexpected`) annotated as a source-code
comment on every `continue` / `return` inside the seven core loop
bodies of the sync engine. The `unexpected` class is never a
`continue` — it is `throw new StaleStateError(...)`. See SYNC2 §6.

**Push-queue depth** — Count of batches currently on disk under
`.push-queue/`, waiting to be drained. Surfaced as a numeric badge
on the `[Sync with GitHub]` ribbon icon: depth 0 hides the badge,
depth ≥ 1 shows `(N)` in a green pill. The signal updates after
every persistent queue mutation; see SYNC2 §4.3.
