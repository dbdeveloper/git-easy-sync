# SYNC2: Keeping an Obsidian Vault on GitHub

> **This reference is being written** chapter by chapter, against the code. Until a
> chapter is marked written, the engine's behaviour is defined by the code under
> `src/sync2/`, `src/github/` and `src/worker/`.
>
> **Older code comments** refer to sections of the first edition as `SYNC2 §N` or
> `SYNC2.md §N`. That edition is archived at
> [`archive/SYNC2-v1.md`](./archive/SYNC2-v1.md); chapter 10 maps its sections to
> this one.

SYNC2 is the synchronization engine of the Git Easy Sync plugin for Obsidian. This
overview explains what the engine is for, what it promises the person using it,
and the few ideas everything else is built on. It assumes no knowledge of the
project. The chapters listed at the end go into detail; each of them assumes this
overview and nothing more.

---

## 0.1 The goal

An Obsidian **vault** is a folder of notes — Markdown files, images, PDFs — plus
Obsidian's own settings. People keep their ideas there and want the same vault on
every device they own: a laptop, a desktop at work, a phone. Some share one vault
with other people.

Git Easy Sync keeps the vault in a **GitHub repository** and keeps every device's
copy in step with it. The repository is the meeting point: each device sends its
own changes there and takes everyone else's changes from there. As a bonus, the
repository keeps the full history of every note. To the engine, another person is
simply another device. Each device carries a name the person gives it in the
settings, and that name appears in its commits and in the conflict copies it causes.

The person this is built for **has no time to learn how synchronization works**.
They want to write, close the laptop, open the phone, and find the same note there.
Everything in this reference serves that: synchronization must be quick, must not
get in the way of editing, must never lose what the person wrote, and, when two
devices disagree, must leave the person a choice they can understand without any
knowledge of git.

## 0.2 Why not an ordinary git client

The obvious way to sync a folder with GitHub is to run git on it. That works on a
desktop with git installed. It does not work on a phone:

- Obsidian Mobile cannot run the `git` program at all.
- The alternative, a git implementation written in JavaScript and bundled into the
  plugin, keeps a full local copy of the repository (`.git`) and does much of its
  work in memory. On a phone with a vault of a few thousand files it runs out of
  memory and crashes, and the local copy of the history keeps growing with every
  version ever written.

SYNC2 takes a third way. It talks to GitHub **only through GitHub's web API** (the
REST API), file by file. Consequences:

- **No local copy of the history.** The history lives on GitHub. Besides the vault,
  the device keeps only a small amount of its own records — chiefly, for each file,
  which version it last agreed on with GitHub — and the file versions that are
  waiting to be sent or merged.
- **Little memory.** Files are processed one at a time, never the whole vault at
  once. Hashing and merging run in a separate background thread, and network calls
  in another, so the editor stays responsive. Work is done in sequence on purpose:
  a phone's memory and network do not stretch, so parallel downloads would only
  make it fail sooner.
- **One code path everywhere.** The same engine runs unchanged on macOS, Windows,
  Linux, Android and iOS.

The price of this choice is that the engine must do by itself what git would
otherwise do: notice what changed, build commits, merge, and recover from
interruptions. The rest of this reference describes how.

## 0.3 What the person sees

A short example runs through the rest of this overview. Ann keeps her vault on a
laptop and a phone.

1. On the laptop she edits `ideas.md` and presses **Sync**. Within a moment a
   notice says the change is recorded, and she keeps typing; she does not wait for
   the network. The sending happens in the background, and the same notice reports
   the result when it is done.
2. On the phone she opens Obsidian. The phone syncs and `ideas.md` shows the
   laptop's edit.
3. Later, without syncing first, she edits `ideas.md` on the phone in one paragraph
   and on the laptop in another. When the second device syncs, the two edits are
   combined automatically and both devices end up with both paragraphs. She is not
   asked anything.
4. Once she edits *the same sentence* on both devices. The phone syncs first, so
   GitHub now holds the phone's sentence. When the laptop syncs, there is no safe
   way to combine the two, so the laptop's vault gets a second file next to the
   note:

   ```
   ideas.md                                         ← her laptop version, untouched
   ideas.conflict-from-phone-2026-11-05T10-31-07Z.md ← the phone's version
   ```

   That is all a conflict is: two ordinary files side by side. The phone sees
   nothing unusual — it has its own version, which is also the one on GitHub. Only
   the device that ran into the disagreement holds the conflict, and it decides.

What happens in step 4 is the core of the design, so it has its own section.

## 0.4 Conflicts are ordinary files

Git marks a conflict by writing both versions into the file between markers
(`<<<<<<<`, `=======`, `>>>>>>>`). That works for a developer at a terminal. It
breaks notes when they are rendered as a page, it is unworkable on a phone, and it
means nothing for an image or a PDF.

The usual alternatives fail the same person in other ways. A dialog that pops up
during a background sync interrupts them, shows one file at a time when a sync may
produce several conflicts, is too small on a phone to judge, and, once dismissed
with "decide later", leaves the decision in a place the person cannot see. Refusing
to sync until the conflict is fixed is safe but stops every other note from syncing
too.

SYNC2 never touches the person's file. It writes the other version into a **conflict
copy** (also called a *sibling*) next to it, and the rest of the sync carries on.
If several devices disagree with this one, each contributes its own copy, told apart
by the device name in the file name. The person can compare the two in
Obsidian's own side-by-side editor, or in any other tool they like (`vimdiff`, a
diff app on the phone). They resolve the conflict with the file operations they
already know:

| What the person does | What it means |
|---|---|
| Deletes the conflict copy | "My version wins." |
| Renames the conflict copy over the note | "The other version wins." |
| Edits the two files until they are identical, or edits the note and then deletes the copy | "Here is the combined version." |

No button has to be pressed and no dialog answered. The engine notices the result
on the next sync and acts on it. When the person has made the two files identical,
the copy has nothing left to say, and the next sync removes it. A conflict copy is never synchronized itself: it is
this device's unfinished business, and sending it to other devices would spread
the disagreement instead of a decision.

**Nothing is lost while a conflict is open.** Until the conflict is resolved, the
engine does not send the note's local version to the shared branch (`main`),
because that would overwrite the version the other device sent. It does not throw
it away either. Each device that has open conflicts gets its own private **conflict
branch** in the same repository, and the local version — including any further
edits the person makes while the conflict is open — is committed there. The work
is on GitHub, safe from the loss of the device, while other devices stay protected
from a half-resolved state. The person does not have to stop working on the note:
each further edit, once synced, becomes one more commit on the branch.

When the person resolves the conflict, the decided version goes to `main`. The
conflict branch is then joined to `main` by a merge commit and its name is deleted.
The merge commit changes no files; its only job is to keep the branch's commits part
of `main`'s history, so every intermediate version the person wrote while deciding
can still be found on GitHub years later:

```
main:  ── C1 ── C2 ── C3 ── C4 ───────────── M   (M: merge commit, no file changes)
              \                             /
conflict:      X1 ──── X2 ──── X3 ─────────     (the person's versions while in conflict)
```

This follows a principle that runs through the whole design: **every commit the
person caused the plugin to make stays in the repository.** By default each Sync
with local changes produces its own commits; none are folded together behind the
person's back.

The rest of the vault keeps syncing while a conflict is open. One disputed note
never blocks the others.

## 0.5 How it works: two steps and a queue

Synchronization is split into two separate steps with a queue between them.

**Commit** looks at the vault, finds what changed since the last sync, and records
those changes as **batches** — up to 100 files each, one future GitHub commit per
batch — in a queue on the device. It reads only local files and makes no network
calls, so it is fast. It is the only part the person waits for. In step 1 of the
example, the moment Ann can keep typing is the moment the Commit has recorded her
change. The Commit finds changes by walking the vault each time rather than by
listening for edit events, so an edit made while the plugin was switched off, or by
another program, is found as well. The moment of the Commit becomes the date of the
GitHub commit, even if the commit is sent days later.

**Drain** empties the queue in the background. It first asks GitHub what other
devices have sent since the last sync. Then, batch by batch, it merges where both
sides changed the same file and sends the result to GitHub as one commit. It touches
the vault **last**: only when every batch is through does it know the final version
of each file, and only then does it write received files into the vault and place
conflict copies. Just before writing a file it looks at the file again: if the
person edited it while the drain was running, that edit is merged in or turned into
a conflict copy like any other — it is never overwritten.

The split is what makes the rest possible:

- **Editing never waits for the network.** The person can type while a long drain
  runs on a slow phone connection. The drain does not read files the person is
  editing; it works from what the Commit recorded.
- **Offline work is kept.** A Commit made without a network stays in the queue and
  is sent by a later drain.
- **One button or two.** **Sync** runs a Commit and then a drain. **Commit** alone
  only records the changes; a later Sync sends them.

To decide what to do with a file, the drain compares three versions of it:

- **base** — the version this device and GitHub last agreed on;
- **local** — the version this device's Commit recorded;
- **remote** — the version on GitHub now.

If only one side differs from the base, that side's version wins: a clean send or a
clean receive. If both differ, the drain first tries a **three-way merge** of text
— combining the two sets of edits relative to the base, as in step 3 of the
example. Only when the edits overlap does it create a conflict copy, as in step 4.
Remembering the base for every file is therefore essential: without it, the engine
could not tell "the other device changed this" from "both devices changed this".

Not every file can be merged as text, so the rule for "both sides changed it"
depends on the kind of file:

| Kind of file | When both sides changed it |
|---|---|
| Text (notes) | Three-way merge; a conflict copy only if the edits overlap. |
| Images, PDFs and other binary files | Always a conflict copy: there is no meaningful merge. |
| A plugin's code (`main.js`, `manifest.json`) | The higher plugin version wins; with equal versions, the newer edit. No conflict: merging a plugin's code line by line would produce a plugin that crashes. |
| Other files in Obsidian's settings folder | The newer edit wins (by the commit dates the devices recorded); no conflict. Obsidian rewrites these files itself, so a copy would only be noise. |

Deletions follow the same idea. A file deleted on one device and edited on another
is kept: the edit is never thrown away silently.

## 0.6 Surviving interruptions

A phone sync can be interrupted at any moment: the person presses Cancel, the train
enters a tunnel, the system kills Obsidian, the battery dies. The engine is built on
the assumption that this *will* happen, in the middle of any step.

- Every important file is written so that a crash leaves either the old content or
  the new, never a mixture. Small state that must never be lost is kept in **two
  alternating copies**, each stamped with a counter that grows by one on every
  write. A write always replaces the copy with the smaller counter, so the copy with
  the larger one — the last good state — survives whatever happens to the write in
  progress.
- The drain records its progress on disk as it goes — which files it has already
  settled, which uploads have already finished. The next sync continues from where
  the last one stopped: no duplicated commits, no files sent twice, and no finished
  work mistaken for new edits.
- Nothing depends on getting a chance to clean up before stopping. A power loss is
  the test case, not Cancel.

## 0.7 What the engine promises

These seven promises — the engine's *invariants*, hence the letter I — are the
design goals. The tests are written against them, and later chapters refer to them
by number.

- **I1 — No local change is lost silently.** Every change a Commit recorded either
  reaches GitHub or becomes a visible conflict.
- **I2 — No remote change is overwritten silently.** If two devices changed the same
  file and the changes cannot be combined, the result is a conflict, never an
  overwrite.
- **I3 — Synchronization settles.** Without new edits, a few syncs bring every
  device to the same correct state: queue empty, conflicts visible. One sync may
  stop early; the next one finishes the work.
- **I4 — A batch is all-or-nothing for the drain.** A batch recorded while a drain
  runs is either taken whole by that drain or left whole for the next one.
- **I5 — The bookkeeping stays consistent.** The queue and the record of agreed
  versions never contradict each other in a way a later step could act on.
- **I6 — Nothing retries forever.** Every retry has a limit. When the engine cannot
  finish now, it stops cleanly and leaves its state for the next attempt.
- **I7 — A crash after any batch is harmless.** After every batch the state on disk
  is consistent, and a restart continues from there.

## 0.8 What the engine deliberately does not do

- **Only GitHub.** The web API it uses is GitHub's; GitLab, Gitea and others are
  not supported.
- **No git workflow.** No rebase, no user branches, no force-push. The only branch
  besides `main` is the private conflict branch, created and removed by the engine.
- **No files of 40 MB or more.** GitHub's API refuses them (measured: 40 MiB, not
  the documented 100 MB). Such a file stays on its device and is reported; the rest
  of the vault syncs.
- **No vaults beyond roughly 20 000 files.** The engine reads the repository's file
  list in one request, which GitHub caps in size; past the cap it stops with a clear
  message instead of syncing part of the vault.
- **No help from other devices with a conflict.** A conflict branch is private to
  the device that opened it; only that device can resolve and close it.
- **No guarantee against a repeated conflict.** If two devices edit the same note
  while one of them is resolving a conflict on it, the other may get a conflict of
  its own. That is the nature of editing one text in two places at once; it is
  resolved the same way.
- **One Sync is not one indivisible step.** A single Sync may send some files to
  `main` and the disputed ones to the conflict branch. That is the price of never
  letting one conflict hold back the rest of the vault.

## 0.9 Words used throughout

| Term | Meaning |
|---|---|
| **Vault** | The Obsidian folder on one device; the only place the person edits. |
| **Repo** | The GitHub repository and its shared branch (`main`) that all devices sync with. |
| **Commit** (the step) | Finds local changes and records them as batches in the queue. Local, fast. |
| **Batch** | One recorded set of changes; becomes one commit on GitHub. |
| **Queue** | The batches waiting on this device to be sent. |
| **Drain** | Empties the queue: brings in remote changes, merges, sends, updates the vault. |
| **base / local / remote** | The three versions of a file compared by the drain (§0.5). |
| **Baseline** | The stored record of a file's base: the version this device and the Repo last agreed on. |
| **Three-way merge** | Combining two edited versions of a text relative to their common base. |
| **Conflict copy (sibling)** | A file next to a note holding the other side's version, when merging failed. |
| **Conflict branch** | This device's private branch on GitHub, holding local versions of notes in conflict. |
| **Blob SHA** | The fingerprint git and GitHub give to a file's content; the engine uses it to tell versions apart. |
| **configDir** | Obsidian's settings folder, usually `.obsidian/`. Some files there sync, with their own rules (§0.5). |

## Chapters

Each chapter opens with what its subject is for, then what it does, then how it is
stored; implementation notes come last and can be skipped on a first reading. The
two terms in the table above that this overview does not use — *blob SHA* and
*configDir* — appear from chapter 1 on.

| # | Chapter | What it covers | Status |
|---|---|---|---|
| 1 | [Data Model](./sync2/01-data-model.md) | What the engine stores on the device and why | first draft, being rewritten |
| 2 | [Scope: What Is Synchronized](./sync2/02-scope.md) | Which files sync, `.gitignore`, Obsidian's settings folder | not yet written |
| 3 | [The Commit Pass](./sync2/03-commit-pass.md) | How changes are found and recorded quickly | not yet written |
| 4 | [The Drain](./sync2/04-drain.md) | Receiving, merging and sending | not yet written |
| 5 | [Conflicts](./sync2/05-conflicts.md) | Conflict copies, the conflict branch, resolution | not yet written |
| 6 | [Crash Safety and Recovery](./sync2/06-crash-safety.md) | Why an interruption at any point is harmless | not yet written |
| 7 | [Plugins and Obsidian Versions](./sync2/07-plugins.md) | Syncing plugins between devices with different Obsidian versions | not yet written |
| 8 | [Platform Contracts and Performance](./sync2/08-platform-performance.md) | Mobile constraints, threads, limits, scale | not yet written |
| 9 | [What the User Sees](./sync2/09-user-facing.md) | Notices, progress, the log, errors | not yet written |
| 10 | [Reference](./sync2/10-reference.md) | Glossary, module map, old-to-new section map | not yet written |

The conflict model of §0.4 — conflict copies, the private conflict branch, keeping
every version — is worked through in depth, with scenarios, in a companion text,
[`PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md). It describes *what* happens to a
conflict independently of the engine; this reference describes how the engine does
it.
