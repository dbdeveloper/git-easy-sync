# SYNC2: A REST-Only Synchronization Engine for Obsidian Vaults

## Abstract

This document specifies the engine layer of the GitHub Easy Sync
plugin. Where [PSEUDO-MERGE-MODE.md](./PSEUDO-MERGE-MODE.md)
describes the abstract algorithm by which conflicting edits across
devices are resolved through filesystem operations, this document
describes the concrete machinery: how the algorithm is layered onto
the GitHub REST API; how persistent state is structured on disk; how
crashes mid-write are recovered; how the system behaves under the
particular constraints of Capacitor on iOS and Android; how the
push pipeline coalesces local edits into commits without losing
work to optimistic concurrency races; and how a small Web Worker
orchestra keeps the UI responsive on devices where the main thread
would otherwise stall.

The intended audience is a developer who needs either to maintain
the existing implementation or to reproduce its behaviour in
another runtime. Wherever the engine implements an algorithmic
guarantee specified in PSEUDO-MERGE-MODE.md, this document
cross-references the relevant section there rather than restating
the rationale.

---

## 1. Architecture: Three Layers, Three Trigger Models

> *Where does state change happen, and how does the plugin keep the
> three concerns — pushing changes, reflecting them in the UI, and
> resolving conflicts — from racing against each other?*

The plugin is organized into three layers, each with a different
trigger model:

| Layer                              | What it does                                                 | When it runs                                                              | Mutates state? |
|------------------------------------|--------------------------------------------------------------|---------------------------------------------------------------------------|----------------|
| **Sync engine**                    | Detects local changes; pushes to GitHub; pulls from GitHub.  | On `[Sync]` click, on interval tick, on plugin load.                      | Yes            |
| **Conflict counter** (UI badge)    | Counts pending unresolved conflicts for status-bar + ribbon. | On any vault `delete` / `modify` / `rename` event affecting a known path. | **No**         |
| **Conflict resolution detection**  | Detects user-completed resolutions; finalises the branch.    | At the start of every `drain()` call.                                     | Yes            |

The strict separation of "things that mutate state" from "things that
only read state" is the most important architectural property of the
design. Vault event listeners — `delete`, `modify`, `rename` — fire
at unpredictable times: the user dragging a sibling to the trash, an
external editor saving a file, the OS replaying a `.swp` cleanup. If
those listeners were allowed to mutate the conflict store directly,
they could race with the sync engine's own writes during a `drain`
(the engine writes a sibling, the listener immediately observes it
and tries to "resolve" the conflict the engine just created, etc.).
Pseudo-merge mode forbids this category of race by construction: the
listener does only one thing — call `counter.markDirty()`, an
idempotent O(1) flag-set — and all real resolution work happens at a
single well-defined moment: the start of the next `drain` cycle.

The drain itself reads:

```
drain():
  if store.records.length > 0:                ← guard: empty store, skip the rest
      evaluateConflictState():
          Phase A: for each record, remove sibling if siblingSha == baseSha
                   or drop record if sibling was deleted by user
          Phase B: for each path whose records are all gone, synthesise
                   a side-batch propagating the live vault state to main

  pull main as usual
  for each batch in queue:                    ← side-batches from Phase B included
      processBatch(batch)
      
  if store.records.length == 0 and conflict branch exists:
      finalise: marker commit, merge-commit on main, deleteRef branch
```

In ninety percent of `drain()` invocations the store is empty and
the conflict-related code path is skipped entirely; the conflict
machinery imposes no runtime cost on the normal synchronization path.

---

## 2. Crash Protection: Two Suffixes, One Recovery Sweep

> *Three things can happen between "the user clicked Sync" and "the
> next stable state of the vault": the network can drop, the operating
> system can suspend the app, the device can lose power. At what
> intermediate states is the vault on disk recoverable, and by what
> mechanism?*

The plugin writes to the vault from **two distinct contexts**, both of
which must be crash-safe. Each context uses one or both of two staging
suffixes — `.sync-tmp` and `.sync-bak` — and each suffix carries a
**single, consistent semantic role** independent of which context
produced it:

* `.sync-tmp` is always **new bytes destined for a target file**
  (forward direction). It is the file that *will* be there once the
  protocol completes.
* `.sync-bak` is always **old bytes preserved before an overwrite**
  (rollback direction). It is the file that *was* there before the
  protocol started.

This naming-to-meaning correspondence is the property §2 walks through.
It is what lets a reader look at any staging file on disk and know
immediately what it represents, regardless of which protocol produced
it. The recovery sweep on the plugin load uses the same correspondence as
its first decision axis.

### 2.1 The Two Callsites at a Glance

| Write path                                       | When it runs                                                                                                  | Uses `.sync-tmp`?                                            | Uses `.sync-bak`?                                                  |
|--------------------------------------------------|---------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------|--------------------------------------------------------------------|
| **Pull-replace** (`atomicWriteFile`)             | A non-conflicting file changed on `main`; the plugin pulls the new bytes and overwrites the local vault file. | Yes — for the transient new bytes during the swap.           | Yes — for the rollback backup of the old bytes.                    |
| **Sibling registration** (`ConflictStore.create`) | A conflict was detected; the plugin writes a new sibling file holding the remote (theirs) content.            | Yes — for the new bytes destined to become the sibling file. | **No** — there is no pre-existing file to back up; this is purely additive. |

The asymmetry is unavoidable: a brand-new sibling file has no prior
version to preserve, so there is nothing for `.sync-bak` to hold. Both
callsites therefore use `.sync-tmp` whenever new bytes are in flight,
but only `atomicWriteFile` ever produces a `.sync-bak`. This is the
property that makes the unified recovery sweep tractable (§2.5).

### 2.2 The Staging-Path Naming Convention

Both suffixes follow the same naming rule: the final path with the
suffix inserted as a **pre-suffix**, immediately before the file
extension. The pre-suffix placement is deliberate. Most file
managers — and Obsidian's own file explorer — preserve the trailing
extension when deciding which icon to show, whether to render a
preview, and so on. A staging file named `note.md.sync-tmp` would
look like a file of an unknown type; `note.sync-tmp.md` looks like a
Markdown file with an unusual stem, which is exactly what it is.

The algorithm, parameterized by which suffix to use:

```
stagingPathFor(finalPath, which ∈ {"tmp", "bak"}):
    suffix = which == "tmp" ? ".sync-tmp" : ".sync-bak"
    if finalPath has no extension OR is a hidden file (".gitignore"):
        return finalPath + suffix              ← appended
    else:
        stem, ext = split on last dot
        return stem + suffix + ext             ← inserted
```

Examples (showing both suffix variants):

| Final path                                  | `.sync-tmp` variant                                | `.sync-bak` variant                                |
|---------------------------------------------|----------------------------------------------------|----------------------------------------------------|
| `Notes/idea.md`                             | `Notes/idea.sync-tmp.md`                           | `Notes/idea.sync-bak.md`                           |
| `Notes/idea.conflict-from-Phone-...md`      | `Notes/idea.conflict-from-Phone-....sync-tmp.md`   | (never produced — Path B is additive)              |
| `attachments/diagram.png`                   | `attachments/diagram.sync-tmp.png`                 | `attachments/diagram.sync-bak.png`                 |
| `.gitignore`                                | `.gitignore.sync-tmp`                              | `.gitignore.sync-bak`                              |
| `README`                                    | `README.sync-tmp`                                  | `README.sync-bak`                                  |

The patterns `*.sync-tmp*` and `*.sync-bak*` are added to the plugin's
recommended `.gitignore` invariants, so neither variant ever leaks
into a commit if it survives a crash. Each glob catches both forms —
pre-suffix (`*.sync-tmp.md`) and trailing-suffix (`.gitignore.sync-tmp`)
— because gitignore's `*` matches any sequence of characters
including the dot.

### 2.3 Path A — Pull-Replace via `atomicWriteFile` (Five Steps)

The first context that produces staging files is the ordinary pull-side
overwritten. When the plugin's pull observes that a file on `main` has
new bytes since the last sync, it must replace the local copy. A
naïve `writeBinary(path, newBytes)` would be hostile to a crash: if
the writing started but did not finish, the file on disk would be a
truncated mix of old and new — *neither version recoverable, both
versions corrupted*. The plugin instead routes every pull-side
overwritten through `atomicWriteFile`, which uses a five-step protocol
that uses **both** suffixes in complementary roles:

```
Step 1: writeBinary(<path>.sync-tmp, newBytes)
            ← new bytes land in a transient staging file
              (.sync-tmp = forward target, the file that will be there)

Step 2: if exists(<path>):
            rename(<path>, <path>.sync-bak)
            ← live file moved aside as the rollback backup
              (.sync-bak = the file that was there)

Step 3: rename(<path>.sync-tmp, <path>)
            ← new bytes promoted to the live name (atomic at OS level)

Step 4: afterCommit()   (typically recordSync)
            ← snapshot updated to match the new live content

Step 5: remove(<path>.sync-bak)
            ← rollback backup is no longer needed
```

The two suffixes here are not interchangeable — they encode the
two facts a recovery agent needs to know if a crash occurs:

* `.sync-tmp` exists ⇒ "new bytes were staged but may not have been
  promoted to the live name yet."
* `.sync-bak` exists ⇒ "the old bytes are still recoverable here, in
  case the new bytes turn out not to have been committed."

Both files coexist briefly during Steps 2–3 of every overwriting, then
the `.sync-tmp` disappears at Step 3 (renamed away), the snapshot is
updated at Step 4, and `.sync-bak` disappears at Step 5.

The order is significant. The snapshot update (Step 4) happens
**between** the rename-into-place (Step 3) and the backup cleanup
(Step 5). This ordering is the **integrity witness** the recovery
sweep will later use to decide what an in-progress state means: if
the snapshot says "this path has remote SHA `X`" and the live file's
SHA matches `X`, then the new writing committed successfully and the
remaining `.sync-bak` is only a cleanup leftover. If the snapshot and
the live file disagree, either the writing was partial or the snapshot
update never ran — in both cases, the `.sync-bak` is the trustable
copy and the sweep restores it.

The protocol covers all four crash points uniformly:

| Crash between                  | What remains on disk                                                       | What the sweep concludes                                                              |
|--------------------------------|----------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| Step 1 and Step 2              | `.sync-tmp` exists; live file unchanged; no `.sync-bak`.                   | `.sync-tmp` is a transient artefact — delete it. Next sync repeats the operation.     |
| Step 2 and Step 3              | `.sync-tmp` exists; `.sync-bak` exists; live path missing.                 | Restore `.sync-bak` → live path; delete `.sync-tmp`. Pre-write state recovered.       |
| Step 3 and Step 4              | Live file = new bytes; `.sync-bak` = old bytes; snapshot still says "old". | SHA(live) ≠ snapshot.remoteSha → restore `.sync-bak`. Conservative; treats Step 4 as "did not commit." |
| Step 4 and Step 5              | Live file = new bytes; `.sync-bak` = old bytes; snapshot says "new".       | SHA(live) === snapshot.remoteSha → delete `.sync-bak`. Cleanup leftover only.         |

### 2.4 Path B — Sibling Registration via `ConflictStore.create` (Three Steps)

The second context is the registration of a new conflict. The crucial
difference from pull-replace is that **the final sibling path does not
exist before this operation**. There is nothing to move aside, nothing
to roll back to: the operation is purely additive. The protocol
therefore uses **only `.sync-tmp`** (no `.sync-bak`) and only three
steps:

```
Step 1: writeBinary(<siblingPath>.sync-tmp.<ext>, theirsContent)
            ← new bytes land in staging
              (.sync-tmp = forward target, same semantics as Path A's Step 1)

Step 2: atomicWrite of meta.json
            ← conflict record persisted (tmp + rename, separate nested atomic op)

Step 3: rename(<siblingPath>.sync-tmp.<ext> → <siblingPath>.<ext>)
            ← staging file promoted to its final name
```

The choice of `.sync-tmp` here is not an arbitrary convention; it is
the semantically correct suffix for what is happening. The staging
file holds **new bytes** that have not yet been given their final
identity — exactly the property `.sync-tmp` denotes in Path A. The
sibling file is brand new (no prior version on disk to back up), so
`.sync-bak` would be a misnomer and is not used.

The protocol uses three steps rather than five because the additive
nature removes two concerns:

1. There is no live file to move aside — Path A's Step 2 has no
   analogue here because the sibling path is fresh.
2. There is no need for a separate live-bytes-versus-new-bytes
   distinction — only new bytes exist. The staging file *is* the
   eventual sibling, just sitting at its staging name until Step 3
   renames it.

Step 2 is itself a nested atomic operation (`meta.json.tmp` →
`meta.json`), embedded inside the larger 3-step protocol. The
conflict record is deliberately written **between** the sibling bytes
landing on disk (Step 1) and the final rename (Step 3). This
ordering is the **integrity witness** for this path: a `.sync-tmp`
whose final-path is named by a `ConflictStore` record is a
forward-direction staging file that the sweep can safely promote; the
sweep compares the staging file's actual content SHA to
`record.theirsBlobSha` to decide whether Step 3 can be completed or
whether the staging file must be discarded.

The protocol covers all three crash points uniformly:

| Crash between                  | What remains on disk                                                         | What the sweep concludes                                                                              |
|--------------------------------|------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| Step 1 and Step 2              | `.sync-tmp` exists; no `meta.json`; no sibling.                              | No conflict-store record names this final path → treat as orphan, delete `.sync-tmp`. The conflict will be re-detected on the next sync if still relevant. |
| Step 2 and Step 3              | `.sync-tmp` exists; `meta.json` exists; no sibling.                          | SHA(`.sync-tmp`) === record.theirsBlobSha → rename `.sync-tmp` → sibling. Step 3 completed.            |
| After Step 3 (cleanup leftover) | Sibling exists; `.sync-tmp` may or may not exist.                            | If `.sync-tmp` survived, sibling already exists → delete the staging file (stale).                     |

### 2.5 The Unified Recovery Sweep

`AtomicWriteRecovery.sweep()` runs on plugin load, **before** the
sync engine starts touching the vault. It walks the entire vault
tree looking for any file whose name matches the staging convention
in either form — pre-suffix (`note.sync-tmp.md`) or trailing-suffix
(`.gitignore.sync-tmp`) — using `parseStagingPath` (the inverse of
`stagingPathFor`).

The sweep proceeds in two passes, one per suffix. The two passes are
**asymmetric**, in the way the asymmetry of the protocols themselves
predicts: `.sync-tmp` can come from either Path A or Path B, so it
needs an ownership dispatch; `.sync-bak` can come only from Path A,
so it does not.

**`.sync-tmp` pass — ownership dispatch.** For every `.sync-tmp` it
finds, the sweep computes the corresponding final-path (the inverse
of `stagingPathFor`) and asks the conflict store:

```ts
record = conflictStore.getBySibling(finalPath)
```

The answer determines which integrity witness — and therefore which
recovery direction — applies.

**If a record exists** — this `.sync-tmp` is a Path B staging file,
and the witness is `record.theirsBlobSha`:

| Vault state                                                | Recovery action                                                                                                                                                                                  |
|------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| finalPath exists                                           | Delete `.sync-tmp`; Step 3 already completed, the staging file is stale.                                                                                                                          |
| finalPath missing, SHA(`.sync-tmp`) === `record.theirsBlobSha` | Rename `.sync-tmp` → finalPath; this completes the interrupted Step 3.                                                                                                                            |
| finalPath missing, SHA mismatches                          | Delete `.sync-tmp` and log a warning. The record will be dropped by the next drain's Phase B (its sibling is missing); the conflict will be re-detected on the next sync if still relevant. Data integrity outranks resolution completeness. |

**If no record exists** — this `.sync-tmp` is a Path A transient
artefact (a crashed pull-replace that did not complete Step 3). The
new bytes have no recovery value: the next sync will discover that
`main` still has them and run the overwrite again. The sweep deletes
the file unconditionally.

**`.sync-bak` pass — snapshot-based recovery only.** Because Path B
never produces `.sync-bak`, there is no ownership question to ask.
The witness is always `snapshot.remoteSha`:

| Vault state                                                | Recovery action                                                                                                                                                                                  |
|------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| finalPath missing                                          | Rename `.sync-bak` → finalPath; restore the pre-write state. (Crash between Steps 2 and 3 of Path A.)                                                                                              |
| finalPath exists, SHA(file) === `snapshot.remoteSha`       | Delete `.sync-bak`; the write committed (Step 4 ran), only the cleanup (Step 5) did not.                                                                                                          |
| finalPath exists, SHA(file) ≠ `snapshot.remoteSha`         | Restore from `.sync-bak`: delete finalPath, rename `.sync-bak` → finalPath. The new write was partial or the snapshot update never ran; the backup is the trustable copy.                          |
| finalPath exists, no snapshot entry                        | Conservative restore: same as the row above. An unverified live file is worth less than a known-good backup.                                                                                       |

The two integrity witnesses — `record.theirsBlobSha` for the
`.sync-tmp` ownership-dispatched-to-Path-B branch,
`snapshot.remoteSha` for the `.sync-bak` branch and the
Path-A-orphan `.sync-tmp` branch — are themselves the durable
artefacts that make the protocol work. Both are written *before* the
corresponding staging file is finalised (the record in Path B's
Step 2; the snapshot in Path A's Step 4), so a crash that destroys
the protocol's progress nonetheless leaves enough information on disk
for the sweep to decide what was supposed to happen.

Ownership dispatch lives on the `.sync-tmp` pass for a structural
reason: forward-direction staging is the operation common to both
callsites, and `.sync-tmp` is the suffix that denotes that
operation regardless of which callsite produced it. The
ownership-versus-orphan question is therefore native to `.sync-tmp`
and has no analogue on `.sync-bak`, which is unambiguous by
construction (only `atomicWriteFile` ever produces it). Confining
the dispatch to `.sync-tmp` keeps each suffix readable in isolation:
a `.sync-bak` on disk always means "backup of a previous file
version," and the question of ownership only arises where the
filesystem itself cannot decide which protocol a staging file
belongs to.

### 2.6 Why Vault-Level Staging

Path B's staging file lives in the vault, co-located with the
eventual sibling — not in a private area under the plugin's config
directory parallel to the conflict record. Two properties motivate
this placement:

1. **The atomic-write infrastructure is shared with Path A.** Path A
   uses `atomicWriteFile` with a recovery sweep that walks the vault
   for staging files. Routing Path B through the same primitive
   removes a class of bespoke recovery code and ensures that any
   change to atomic-write semantics propagates to the conflict-store
   path automatically. The single unified sweep described in §2.5
   is the direct dividend.
2. **The staging file is recoverable in place.** If the rename in
   Path B's Step 3 fails (the OS reports an I/O error, the destination
   suddenly exists, etc.), no copying is required to recover — the
   bytes are already at the right parent directory, and the recovery
   sweep only needs to perform the rename a second time.

### 2.7 The Boundary Between `load()` and the Recovery Sweep

The conflict store's `load()` does **not** check the vault for
sibling files. It reads `meta.json` files from the conflict-records
directory and builds its in-memory index purely from that. The
recovery sweep described in §2.5 runs separately, and the
*resolution* of conflicts based on what is or is not in the vault
happens only at the next `drain()`.

This split is deliberate: it makes **filesystem state authoritative**
for resolution. A missing sibling means the user wanted it gone, and
no part of the load path treats it as something to "restore." The
alternative — having `load()` re-emit a missing sibling from a
durable backup — would silently undo the user's intentional deletes
across a plugin restart, which is exactly the failure mode the
"trust the filesystem" rule prevents.

### 2.8 Tail Re-Check Window

A subtle invariant the drain protects: **every committed batch will
eventually be drained by some drain cycle.** Without explicit care,
the following race could lose work:

1. A drain is running. Its inner loop reads `queue.list()` and
   processes the returned IDs.
2. A `commit` operation lands a new batch on disk.
3. The drain's inner loop, which has already moved past the
   `queue.list()` snapshot, finishes processing the batches it
   knew about and exits.
4. The new batch sits in `.push-queue/` waiting for someone to
   come back for it.

Two mechanisms close this race in tandem:

**Tail re-check inside `drain()`.** The inner per-batch loop runs
inside an outer loop that, after the inner loop exits, waits ~50 ms
and re-lists the queue. If any new batches appeared in that window,
the outer loop runs the inner loop again. The 50 ms is enough for
any in-flight filesystem write (a `commit` that ran while we were
draining) to become observable to `list()`. The log line
`"Sync drain tail re-check found new batches; restarting"` makes
"we caught a late arrival" greppable from the field.

**300 ms wait inside `syncAll()` between enqueue and drain.** When
`syncAll` adds a batch and then dispatches the drain, it pauses
300 ms first. The wait guarantees one of two outcomes:

- If a different drain was already running, it has ~300 ms to
  enter its own tail re-check window and pick up our new batch.
- If no drain was running, the 300 ms is negligible and our drain
  call starts cleanly with the new batch visible.

Either way, the new batch gets processed by exactly one drain
cycle. The combined invariant is stronger than either mechanism
alone: even if the tail re-check window misses (50 ms slip), the
300 ms commit-to-drain delay ensures a fresh drain will see the
batch and pick it up.

Durability does the rest. Even if BOTH mechanisms fail in some
adversarial scenario, the batch is on disk in `.push-queue/`. The
next sync click, interval tick, or onload startup pulse drains
it. No committed work is lost — at worst it waits longer than
intended for the next drain.

### 2.9 The Zero-Byte Restore Guard

Added in 2.0.2-beta2. A file that has collapsed to zero bytes is,
in a notes vault, almost never the user's intent — it is the
signature of a truncation or corruption (an editor crash mid-save,
a sync race on another tool, a filesystem fault). Critically, a
zero-length file is **indistinguishable from a deleted file**: in
both cases the path carries no content. The guard treats an
unexpected collapse to zero as an accidental deletion and performs
an **un-delete** — it restores the last good version and prevents
the empty copy from ever reaching the server.

The guard runs at the very start of `processBatch`, before the
batch's bytes are built into a tree, so the corrupted path is
intercepted before any network write.

#### Detection — zero network

For each add/modify path in the batch:

- **ours.size** is the size of the *frozen* copy in
  `.push-queue/<batch>/vault/<path>` — the bytes captured at commit
  time, not a fresh read of the (possibly changed) live file.
  `PushQueue.fileSize` stats it directly, so the check is cheap on
  every drained path.
- **snapshot.size** is the size recorded for the path's
  last-synced version. Because the snapshot's content is the same
  as the merge base, snapshot.size doubles as the base size — there
  is no need to fetch anything from GitHub to know whether the file
  "used to have content."

The collapse is confirmed when `ours.size === 0` **and** a snapshot
entry exists **and** `snapshot.size !== 0`. Two carve-outs let an
empty file through untouched:

- **No snapshot entry** → the file is brand-new; the user just
  created it (possibly deliberately empty). Nothing to restore.
- **snapshot.size === 0** → the file was already empty at the last
  sync; staying empty is not a collapse.

#### The intentional-empty-file path

A user who genuinely wants a zero-length file in the repository
achieves it through an ordinary deletion followed by a creation:
delete the file and commit — which removes its snapshot row — then
create the empty file. On the next drain the guard finds **no
snapshot entry** for the path (the deletion cleared it), so the
"brand-new" carve-out applies: the empty file is pushed and no old
content is resurrected. The guard therefore never fights a
deliberate empty file; it only resists a file that *had* content
and silently lost it.

#### Restore source — last available good version

When a collapse is confirmed the guard restores the *last
available non-zero version*, searched in this order:

1. **All pending push-queue batches, newest-first** (excluding the
   batch being drained). If the user zeroed the file in one batch
   and re-typed it in a later still-unpushed batch, that fresher
   good copy is the correct thing to keep. The newest non-zero
   frozen copy wins.
2. **GitHub, by the snapshot's `remoteSha`.** Fetched by blob SHA
   (`getBlob`) so it is exactly the pre-collapse bytes regardless
   of where the branch HEAD has since moved.

If neither source yields a non-zero version (the blob was
GC'd and no pending batch holds a copy — an extreme edge), the
guard leaves the path in the batch and logs a warning. Pushing the
empty version is judged the lesser evil to silently discarding a
possibly-intentional deletion when no recovery bytes exist.

#### Apply

The restore writes the recovered bytes back to the live vault file
through `atomicWriteFile` (the same crash-safe path used for
pull-replace; §2.3) and removes the path from the batch via
`PushQueue.removeFile`, so the empty version is never pushed. If
removing the path empties the batch, the existing
`entries.length === 0` short-circuit deletes the batch and the
drain moves on.

The guard deliberately does **not** touch the snapshot. The next
`findChanges` re-classifies the restored file: if it was restored
from GitHub (content equals the remote), the SHA matches the
snapshot and it is a cache hit — no re-push; if it was restored
from a newer queued version (content differs from the remote), it
re-enqueues and the good version pushes on the next drain. Both
outcomes converge correctly without any snapshot bookkeeping in the
guard itself.

#### Never silent

Restoration overwrites a local file, so it is surfaced: the
`onZeroByteRestored` callback fires a user-visible Notice
("Restored *path* — the local copy was empty…") and a log line
records the decision (path, previous size, restored size, restore
source). A defensible automatic recovery must still tell the user
their vault changed and why.

---

## 3. Cross-Platform Contracts

The conflict-resolution layer of PSEUDO-MERGE-MODE.md §4–§8 works because the underlying
file primitives behave the same way on every platform the plugin
ships to. They do not — Obsidian Mobile (Android + iOS, Capacitor)
and Obsidian Desktop (Electron) diverge in three places that matter
to the protocol. The plugin pays the cost of normalising these once,
in a single module (`src/sync2/cross-platform.ts`), rather than
scattering the workarounds across every call site that would
otherwise hit one of the divergences.

Three contracts live in that module.

**Filename character set.** Obsidian Android refuses to create a file
whose name contains any of the Windows FAT/NTFS-forbidden ASCII
characters (`< > : " | ? * \`). The rejection is platform policy,
not filesystem policy — the bridge layer enforces it even on
filesystems that would happily store the bytes. Obsidian itself
(Desktop *and* Mobile) rejects a second family (`# ^ [ ]`) because
those characters have grammar meaning in wiki-links
(`[[note#heading]]`, `[[note^block-id]]`, `[[link]]`). The two
families together are 12 ASCII characters that are unsafe in any
vault path the plugin needs to materialise. They can still arrive
from outside — a Desktop user creating a name on macOS, the GitHub
web UI, raw git, a different tool committing to the repo — and the
protocol has to canonicalise them on the way through.

`sanitizeFilename(path)` rewrites every forbidden character to its
visually-faithful Unicode counterpart (curly quote for `"`,
modifier-letter colon for `:`, fullwidth glyphs for the rest). The
12-character map is stable, deterministic, and round-trips through
the sync protocol cleanly because every replacement is a single
Unicode codepoint outside both forbidden families and is accepted by
every vault adapter the plugin ships to. `needsSanitization(path)`
is a cheap fast-path predicate so the common case (a clean path)
costs O(n) regex match and no allocation.

Both functions fire on two surfaces. The push side runs them over
the vault walk before `findChanges`: any local file whose name
contains a forbidden character is renamed in place through
Obsidian's link-aware rename API (so wiki-links pointing at the old
name follow the file), and only then does change-detection see the
canonical form. The pull side runs them over the incoming GitHub
paths: any forbidden-named GitHub file is materialised under its
canonical local name, and the forbidden remote path is recorded in
the pending-deletions queue (§4.2) so the next push cleans GitHub.
A multi-device vault that started with a forbidden-named file ends
up — after one round-trip of sync from any device — with that file
present under its canonical name on every device and on GitHub.

**URL encoding for GitHub Contents API paths.** The
`/repos/.../contents/<path>` endpoint embeds the path directly in
the URL. Characters with URL syntax meaning — `?`, `#`, ` `, `%` —
terminate the path component on the server side: a request for the
path `[1] File ^ opa?.md` reaches the API as the path
`[1] File ^ opa` with `md` as a query parameter, and the API
truthfully returns 404 for a file that doesn't exist at the
truncated path. `encodePathForGithub(path)` percent-encodes per
segment, preserving `/` as the structural separator. The plugin's
GitHub client routes every contents-API URL construction through
this helper so the policy "no raw path interpolation into a URL" is
enforced at the one place where it matters.

**Adapter rename portability.** Capacitor's `adapter.rename` on
Android and iOS throws "Destination file already exists" when the
destination is occupied. POSIX `rename` (Desktop's path) silently
overwrites. The portable pattern — `if (exists(dst)) remove(dst);
rename(src, dst)` — is wrapped as `safeRename(adapter, src, dst)`.
Every protocol step that ends in a rename — the staging-file
promotion of §2.3 Step 3; the conflict-store `meta.json.tmp` rename
in §2.4; the pending-deletions store's persistRecord; the atomic-
write rollback path — calls this helper rather than inlining the
dance. A future contributor who introduces a new write-then-rename
step gets the cross-platform behaviour for free, and the rationale
for the existence of the dance lives in one place rather than
duplicated across five call sites.

These three contracts are not optional decoration. They are
load-bearing properties of the protocol: the conflict layer depends
on `safeRename` to land its `meta.json` atomically, the push
pipeline depends on `encodePathForGithub` to identify the right
remote path under any vault filename, and pull-side reconciliation
depends on `sanitizeFilename` to materialise files Mobile can store.
They share a module because they share an invariant: "anything the
plugin must do differently on Mobile vs. Desktop goes here first;
the call sites do not see the difference."

---

## 4. The Push Pipeline

The conflict-resolution layer of PSEUDO-MERGE-MODE.md §4–§8 describes WHEN a path goes
to the conflict branch and HOW its sibling is constructed. The push
pipeline of this section describes WHAT happens when a
non-conflicting batch reaches GitHub. The path is simple at the top
— fetch HEAD, build tree, create commit, fast-forward branch — but
three structural guarantees make it robust against the failure modes
that show up in multi-device traffic.

### 4.1 Pre-flight validation

Every `createTree` request the plugin sends carries some combination
of file additions, modifications, and deletions. Additions and
modifications include inline content; GitHub assembles them
server-side with no further round-trips to anywhere else. Deletions
are different: they reference a path by name with `sha: null`, and
GitHub interprets the entry as "remove this path from the new tree."
For the interpretation to succeed the path must exist at the parent
tree the create-request is rebasing onto. If it doesn't — if the
path was deleted by another device, or by a manual GitHub web edit,
between when our batch was constructed and when our push reaches the
server — GitHub responds 422 `GitRPC::BadObjectState` and the whole
tree-create fails. Repeated retries fail identically until the local
state is reconciled.

A stale deletion is a structural risk for any multi-device sync —
not a bug to be patched once but a class of inconsistency that the
protocol has to absorb on every push. The plugin's defence is to
validate every deletion entry against `currentHead` before the
tree-create request leaves. The validator lives in `processBatch`
between `TreeBuilder.buildTreeEntries` and `client.createTree`. For
each entry with `sha: null` it calls `getContentsAtRef(path,
currentHead)`. If the path exists at currentHead, the deletion is
kept. If the path is absent (the API returns null), the deletion is
dropped — and the matching snapshot row is removed too, so the next
change-detection pass does not re-emit the same stale deletion. The
batch is sent only with entries that match remote state at push time.

The validator handles its own failure mode explicitly. If
`getContentsAtRef` itself throws (network timeout, GitHub 5xx,
dropped connection), the validator throws and the push aborts;
`lastSync` does not advance, the queued batch survives on disk, the
next drain retries. This is intentional. Pre-flight validation is a
safety net, not a performance optimisation. If the net cannot run,
the engine defers to the next drain rather than optimistically
proceeding and risking the 422 the net was designed to prevent.
From the user's perspective: one click "didn't go through"; the
next click (or interval tick) succeeds once the network recovers.

The validator does not check additions or modifications — those
have content the server resolves regardless of base-tree state.
The discipline is targeted at the one entry shape that turns
"remote state changed under us" into a hard failure.

**Two different 422s, two different retry policies.** The push
pipeline can receive a 422 from two distinct endpoints, and they
must be handled oppositely. The `GitRPC::BadObjectState` above
(POST `/git/trees`) is treated as transient — `createTree` retries
it via `isWriteRetriableStatus`, because the redundant-deletion
variant self-resolves once the empty reconcile lands. The other is
on the final step of a push, the PATCH to `/git/refs/heads/<branch>`
that moves the branch head to the new commit. If the remote head
advanced between the push's head-read and this PATCH — another
device pushed, or, on a single device, the same deterministic
commit got pushed twice — GitHub answers 422 *"Update is not a
fast forward."* This 422 is **not** transient: retrying the
identical PATCH cannot help, because the new commit no longer
fast-forwards the moved head; only reconciling the batch against
the new head can. A first implementation routed ref updates
through `isWriteRetriableStatus` too, so a non-ff PATCH retried
~6 times over ~33 seconds of exponential backoff before failing —
which a user (field report, 2026-05-31) experienced as a hang.
The fix scopes ref updates to `isRefUpdateRetriableStatus`, which
is the write predicate minus 422: a non-ff PATCH fails fast, the
push throws, the batch stays queued, and the next drain's reconcile
(§the push enters Case 4 — `expectedHead != currentHead` — re-targets
the batch onto the new head and, finding the commit already
present, reuses it) completes the work without the wasted backoff.
Failing fast routes both the same-commit collision and a genuine
multi-device divergence into the same recovery path.

### 4.2 Pending-deletions queue

Pull-side sanitize (§3) materialises a forbidden-named GitHub file
under its canonical local name and needs a way to record "delete
this forbidden path on the next push." The naïve approach — write a
`SnapshotStore` entry at the forbidden path so the next change-
detection pass emits a deletion — fits the existing diff-driven
push pipeline but violates the snapshot store's contract: every
snapshot entry is documented as "what we observed on GitHub at the
recorded SHA," and a phantom-for-delete-intent entry is not an
observation. The protocol uses an explicit store instead.

The pending-deletions store lives at
`<configDir>/plugins/<self>/.pending-deletions/`, one folder per
entry, each containing a `meta.json` with the path, the source
(`pull-side-sanitize` / `migration-from-snapshot` / `manual`), the
GitHub commit SHA at which the path was last observed present, and
the blob SHA at that commit. The `processBatch` consumer injects
every queue entry as an additional deletion in the tree-create
request; pre-flight validation (§4.1) covers it just like a
change-detector-emitted deletion; a successful push clears the
matching queue entry; a failed push leaves the entry untouched for
the next drain.

The separation has two structural pay-offs. The snapshot store
stays a verifiable cache — every row is now "we observed this path
with this SHA at this commit on GitHub" — and any reader can trust
its values without checking which entries are real and which are
delete-intents. The pending-deletions store is named for what it
does — its content type is "delete these paths from GitHub on the
next push" — and the activity log entries that reference it
(sources, dropped-as-stale events, successful clear-on-push events)
are diagnosable on their own terms.

Reset semantics are uniform. Plugin Reset (Settings → Reset) wipes
the pending-deletions store alongside the snapshot, the push-queue,
and the conflict store; the store cannot outlive an explicit Reset
action. Plugin uninstall removes `<configDir>/plugins/<self>/`
recursively through Obsidian's own cleanup; the store cannot outlive
the plugin installation. Both lifecycles are honest about ownership.

### 4.3 Push-queue depth as user signal

The ribbon `[Sync with GitHub]` icon carries a numeric badge. The
number it shows is the count of batches currently on disk under
`.push-queue/`, waiting for `drain()` to dispatch them. Depth 0
hides the badge; depth ≥ 1 shows `(N)` in a small green pill at
the corner of the icon. The signal is updated after every persistent
queue mutation: `enqueueOrMerge` writes a new batch (depth +1, or
+0 if folded into an existing one); `processBatch` deletes a
successfully-pushed batch (depth −1); the empty-after-reconcile
branch deletes the queue entry too. On plugin start, the icon is
seeded with the current queue depth from disk so the badge reflects
state even after a restart.

The signal is read-only and load-bearing for the user's mental
model of "I clicked Sync; where did my work go?". The badge appears
the moment a batch lands on disk, persists while drain processes it
(typically 1–3 seconds of HTTP round-trips), and clears when the
push succeeds. Offline syncs accumulate batches — the badge climbs
`(1)` → `(2)` → `(3)` — and the next reconnection drains them with
the badge decrementing in lock-step. The user has direct visibility
into the engine's state without needing to open the activity log.

The badge does not show the unresolved-conflict count. That signal
lives on the status-bar `🔀 N` indicator (§1), which is the
canonical home for the conflict layer's state. The two surfaces are
deliberately distinct: the sync icon reflects pipeline state (do I
have outbound work pending?), the status-bar reflects collaboration
state (do I have unresolved conflicts to address?). The diff2
widget (`DIFF2_IMPLEMENTATION_PLAN.md` R2.7.4) introduces a third
surface — a separate ribbon icon — that mirrors the status-bar
conflict count for users who prefer the ribbon as their primary
visual area.

### 4.4 Commit message format and the local-commit timestamp

Every commit the engine creates carries a message of the form

```
Sync at 2026-05-18 07:59:04.352+02:00 (Pixel6Pro)
```

— a fixed action phrase, a timestamp, and a trailing
`(deviceLabel)`. The phrase varies by commit kind (`Sync`,
`Resolve conflict`, `Conflict`, `Final state`, `Merge
conflict-branch`, `Init`); the timestamp and the trailing label are
present on all of them. The formats are hardcoded in
`commit-message.ts` — there is no user-configurable message
template, by deliberate design.

**Why the timestamp lives in the message body, not just git
metadata.** This is the non-obvious decision worth recording. A
naive reading says "git already stores author and committer dates,
so a timestamp in the message is redundant." That reading is wrong
for this engine, because of *when* the commit object is created.

sync2 separates the local commit from the network push. Clicking
Sync (or a `commit` action) freezes the changes into a batch under
`.push-queue/` with a `createdAt` recorded at that instant. The
actual git commit object, however, is not created until `drain()`
reaches the batch and calls `createCommit` — which can be much
later: the device may be offline for hours, accumulating batches
that all push on the next reconnection. GitHub stamps the commit's
author and committer dates at *creation* time, i.e. push time. So
git's metadata dates do **not** record when the user committed;
they record when the network happened to be available.

Embedding the batch's `createdAt` in the message (rendered in local
time with a UTC offset, §`commit-message.ts:formatLocalTimestamp`)
restores the information git's metadata loses. The message now
answers "when did I actually make this change?" — independent of
when it reached the server. A useful side effect is that every
message becomes unique, so a specific commit, or a group from one
day, is trivial to locate with a text search over `git log`.

**Also setting git's metadata date — the optional git-author
identity.** The message-body timestamp is the always-on,
zero-config baseline. On top of it, the user may *optionally*
make git's own author/committer date record the local commit
moment too, by filling two Settings fields — **Git author name**
and **Git author email** — that mirror `git config user.name` /
`user.email`. When both are set (the name defaults to the GitHub
Owner when its field is left empty), every commit is created with
an `author` and `committer` object carrying that identity plus the
local date (`toGitAuthorDate`, ISO 8601 with offset). git's
metadata date then matches the in-message timestamp, so
date-range queries (`git log --since/--until`, GitHub's UI sort)
work on the true commit moment rather than push time.

The reason this is opt-in rather than automatic: GitHub attributes
a commit to a user account by matching the author *email* to a
verified email on that account. Overriding the author object to
set its date means also supplying an email, and an email that is
not verified on the user's account silently drops attribution (the
commit still lands, but the contribution graph doesn't count it) —
exactly the behaviour of plain `git` with a mismatched
`user.email`. Rather than guess an identity (or fetch and cache the
`{id}+{login}@users.noreply.github.com` form), the engine leaves
the fields empty by default — no override, GitHub stamps the
token's user + push time — and lets a user who wants git-native
dates supply an identity they know is correct. The Settings
description states the verified-email requirement explicitly.

**Why no per-user template.** Provenance (which device) and timing
(when, locally) are the only two signals a sync commit message
needs, and both are delivered by the hardcoded format. A
configurable template invites messages that the inverse parser
(`parseDeviceSuffix`, which recovers the device label from the
trailing `(label)` for multi-device observability) cannot read, and
adds a settings surface with no corresponding user need. The
trailing-label contract is load-bearing for the engine, so the
format stays fixed.

### 4.5 Blob upload — sequential, low-memory, resumable

`TreeBuilder.buildTreeEntries` turns a queued batch into the `tree[]`
array `createTree` consumes. Text files inline their content (GitHub
stores it as the blob, no extra round-trip); binary files each need a
`createBlob` call first, whose returned SHA the tree entry then
references. Those blob uploads are issued **one at a time, in order** —
not concurrently.

This is deliberate, and it corrects an earlier implementation that
fanned the binary uploads out through `Promise.allSettled`. Parallel
uploads buy throughput only when the work is *latency-bound* — many
small requests whose round-trips can overlap. A heavy sync (the only
case that shows progress at all — see below) is *bandwidth-bound*: the
files are large, they all go to the same host (`api.github.com`)
through one network worker (§8) over one uplink, so N concurrent
uploads simply share the pipe and finish in about the same wall-clock
as N sequential ones. What concurrency *did* cost was memory — every
in-flight file held its bytes plus a base64 copy resident at once,
which is exactly the pressure an Obsidian Mobile WebView can least
afford. Sequential upload caps peak memory at a single file's bytes.

Sequential upload is also the simpler thing to **resume**. Each fresh
blob's SHA is persisted to the batch's `uploadedBlobs` map (via
`PushQueue.recordBlobUpload`) immediately after its `createBlob`
returns. If the process dies mid-batch — at file *k* of *N* — files
`1..k-1` are already recorded on disk. The next drain re-runs
`buildTreeEntries` for the same batch; for every path with a recorded
SHA it takes the cache hit and skips the `createBlob` round-trip
entirely, so the upload resumes at exactly file *k*. Because nothing
runs concurrently, there is no interleaving of `recordBlobUpload`
writes, and the serialization the old parallel path needed (a
`metaWriteQueue` guarding against sibling callbacks clobbering each
other's persist) is unnecessary by construction. A mid-batch failure
re-throws after the successful files have recorded — strictly forward
progress, never a lost or double-counted blob.

**Progress signal.** The same per-file boundary drives the user-facing
notice. `buildTreeEntries` fires `onFileProcessed(done, total)`
**pre-op** — once just *before* each file's blob work begins — and the
drain turns that into a long-lived notice that reads `Pushing P/N
files to GitHub` (or `Pushing 1 file to GitHub…` for a single file; no
meaningless `1/1`, no `0/N`). Because the tick is pre-op and uploads
are sequential, each `Pushing P/N` appears before file *P* ships and
stays on screen for exactly that file's transfer — a 300 ms upload
shows for 300 ms, a 3 s upload for 3 s. The pull side mirrors this
contract exactly (`Pulling P/N files from GitHub` /
`Pulling 1 file from GitHub…`), ticked at the head of `pullIfNeeded`'s
per-file loop. The notice opens **lazily on the first tick** and only
when the batch is *heavy* — total bytes over `PROGRESS_BYTES_THRESHOLD`
(500 KB), or, on a tree-fetch failure, more than `PROGRESS_COUNT_THRESHOLD`
(5) files — so ordinary small syncs run silent; the drain-level
`Sync done` finale is their only toast. The lazy-open closure
(`ensurePushProgress`) closes over the drain-loop's notice handle so
the handle it opens is the one the finale later hides, and so a second
batch ticks the same notice rather than spawning a new one.

---

## 5. Error Taxonomy

A sync engine that talks to GitHub fields four broad kinds of
failure: network-level (connection dropped before any HTTP response
was assembled), HTTP-level (GitHub returned a 4xx or 5xx that the
engine must dispatch on), platform-level (the local OS or WebView
refused a vault operation), and inconsistency-level (the engine
observed two pieces of remote state that contradict each other
within a single sync click). The plugin models all four as a typed
class hierarchy in `src/errors.ts`:

```
SyncError                  (abstract base — never thrown directly)
├── NetworkError           (transient — retriable=true)
├── GithubAPIError         (typed HTTP response from GitHub)
│   ├── NotFoundError      (404)
│   ├── ConflictError      (409 — bare repo, ref mismatch)
│   ├── ValidationError    (422 — malformed request OR stale state
│   │                        per body.message)
│   ├── AuthError          (401, 403 — token problems)
│   └── RateLimitError     (429 — retriable=true)
├── PlatformError          (Capacitor / WebView refused a vault
│                            operation — non-retriable, user-visible)
└── StaleStateError        (two pieces of remote state observed in
                              one sync click no longer agree)
```

Three properties make the hierarchy useful at the catch site.

First, **`instanceof` dispatch.** A catch site that needs to handle
"any GitHub HTTP error" matches on `GithubAPIError`; one that needs
only the 404 case matches on `NotFoundError`. The same error
instance answers both queries because TypeScript classes form a real
inheritance tree. No status-code switch is needed; no string
matching on `error.message`; no duck-typing on `(err as { status?:
number }).status`. The catch is as specific or as broad as the
handling demands, no more.

Second, **the `retriable` getter.** Every class declares whether
retrying the operation that produced it can plausibly succeed.
`NetworkError.retriable` is true (a network blip resolves on next
attempt); `ValidationError.retriable` is false (a malformed payload
stays malformed); `RateLimitError.retriable` is true (with backoff);
`PlatformError.retriable` is false (the WebView's rejection is
deterministic until the input changes). The retry policy lives on
the class, not on the catch site, and the retryUntil predicate
consults `error.retriable` rather than re-deriving the answer from
status codes at every call.

Third, **the `name` field.** Every subclass sets `this.name =
new.target.name`, so `String(err)` reads "StaleStateError: ..."
rather than the generic "Error: ...". The activity log and bug
reports get classifiable error names automatically through
`describeError()`'s `ctor` field. Failure modes are filterable in
the log without inspecting the message string; users who paste a
log snippet into an issue carry the class name with it.

The 422 case deserves a note. GitHub returns 422 for two distinct
sub-causes — malformed payload, and `GitRPC::BadObjectState` from
remote state drift (§4.1) — and the type system models both as
`ValidationError`. Catch sites that need the distinction read
`error.body?.message` directly. The choice was pragmatic: the
second sub-cause is rare once pre-flight validation runs, and
splitting the type would couple every catch site to the specific
GitHub message string rather than to the class. The same logic
applies in reverse to `StaleStateError`: the engine raises it for
several causes (compare/fetch disagreement from a client bug, token
permission drift, replica consistency lag, force-push race), all of
which share the same retry policy ("retry one drain; if it repeats,
the operator needs to investigate") and so do not need separate
subclasses.

The hierarchy is deliberately flat. Adding a sixth or seventh
status-code subclass is easy when the engine starts caring about a
new code; adding parallel sub-hierarchies is also possible but
currently unnecessary — catch sites distinguish the rare sub-causes
by reading log context, not by `instanceof`.

---

## 6. Skip-Class Discipline

Loops over remote-change lists and batch entries are full of
`continue` and early `return` statements. Each one represents a
deliberate decision by the loop body to not process the current
item the way it processes its siblings. The decisions look identical
at the language level but mean very different things — and the
consequences of confusing them are visible in the protocol's
history. The discipline below codifies the meanings so future
contributors can audit a skip in isolation.

Four labels enumerate every legitimate reason to skip:

**`applied`** — the operation completed via a non-default code path.
A sibling write that landed the same bytes as the base; a deletion
processed inline rather than through the main flow; a sanitize
migration that ran on the spot. The cursor (snapshot row, lastSync,
queue entry) advances normally; the work is done, just not through
the loop's main branch.

**`deferred`** — the operation is intentionally postponed to a
different code path. The push-queue overlap case is the canonical
instance: when a pull-side change targets a path that has an in-
flight push batch, the pull defers to the post-reconcile drain
rather than racing the push. The cursor does NOT advance for this
path; an `anyOverlapDeferred` flag tells the caller to hold
`lastSync` so the deferred change is not lost on the next
incremental sync.

**`already-correct`** — the desired state is already on disk. SHA-
match resume during pull is the canonical instance: a previous pull
pass wrote the bytes and crashed before recording the snapshot row,
so the next pass reads the local file, hashes it, finds the SHA
matches the expected one, refreshes the snapshot stat-cache, and
skips. The skip is a true no-op for the disk; the snapshot row is
the only thing advancing.

**`unexpected`** — the operation could not be applied and the loop
body does not know why. This is the dangerous case. A silent
`continue` here advances loop state past the failure; if the loop
also advances any cursor (lastSync, snapshot row, queue entry),
the failure is permanently masked — the next sync's compare diff
no longer surfaces the path because the state appears consistent.
The discipline is: an `unexpected` skip is never a `continue`. It
is `throw new StaleStateError(...)`. The error propagates to the
per-file catch in the calling loop, which logs the exact path and
re-throws; the outer loop aborts; the cursor does not advance; the
next sync retries.

Every skip in the seven loops at the heart of the sync engine —
`pullIfNeeded`, `applyRemoteAddOrModify`, `applyRemoteDeletion`,
`processBatch`, `reconcileBatchAgainstHead`, `bootstrapFromRemote`,
`adoptionPullAndRecord` — is annotated with one of these four
labels as a source comment immediately preceding the `continue` or
`return`. The annotation is documentation for future readers, but
it also enforces the protocol's most important contract: there is
no fifth category. If the loop body cannot place a skip into one of
the four buckets, the bucket is `unexpected` and the line should be
a `throw`, not a `continue`.

---

## 7. Field Postmortems

The design as described across PSEUDO-MERGE-MODE.md and §1–§12 here reads as a single coherent
protocol, but the path to that protocol passed through specific
field incidents that surfaced specific structural gaps. The seven
postmortems below preserve the historical record: each one captures
the symptom that was reported, the proximate cause that was
identified, and the section above whose discipline now makes the
class of failure unreachable. Future contributors investigating a
similar symptom can use the list as a triage index.

### 7.1 `FILE_NOTCREATED` on Obsidian Android (2026-05-25)

**Symptom.** Mobile sync of a desktop-created file named
`Actual-projects/Ладовіра/Штрихи до "святої" книги "Віра в Лад".md`
failed with a Notice `Error syncing. Error: FILE_NOTCREATED`. The
plugin log surfaced the full bridge-layer message only after the
observability fix below; the underlying rejection came from
`win.androidBridge.onmessage`.

**Cause.** Obsidian Android refuses to create files whose name
contains any of the Windows FAT/NTFS-forbidden ASCII characters
(`< > : " | ? * \`) — independently of the underlying filesystem,
as a cross-platform-compatibility safeguard so a vault that syncs to
a Windows desktop won't break. Desktop Obsidian on macOS or Linux
happily creates such names because the underlying POSIX filesystem
allows them, and the asymmetry was invisible until the file crossed
platforms.

**Now-covered-by:** §3 *Cross-Platform Contracts* (the
`sanitizeFilename` / `needsSanitization` discipline rewrites the
12-character forbidden set to canonical Unicode replacements on
both push and pull sides; multi-device vaults converge on the
canonical form after one round-trip).

### 7.2 `err: {}` in the plugin log (2026-05-25)

**Symptom.** Every recorded sync failure showed
`additional_data: {"err": {}}` — the captured error object
serialised as an empty object. Bug reports were unactionable: a sync
failure was visible in the log but its cause was not.

**Cause.** Two layers. (1) The `sync()` and `syncCurrentFile()`
click handlers caught errors and showed a Notice but never called
`logger.error`. The toast disappeared in seconds; the log saw
nothing. (2) When the catch site DID reach a logger call (e.g. the
interval-drain handler), `safeStringify` only unwrapped
`v instanceof Error` to extract `name`/`message`/`stack`.
Capacitor's native-bridge errors on Android come through as objects
whose `instanceof Error` evaluates to `false` (different JS realm)
and whose Error-shape fields live on the prototype rather than as
own enumerable properties. `JSON.stringify` of such an object
produces `{}`.

**Now-covered-by:** `src/utils.ts::describeError(err)` extracts
`type`, `ctor`, `string` (via `String(err)`), and the Error-shape
fields via direct property access that survives prototype-only
definitions. `src/logger.ts::safeStringify` mirrors the same
extraction so any `logger.error(msg, { err })` site benefits
automatically. The two click handlers log before showing a Notice.
The typed-error hierarchy of §5 makes the resulting log entries
classifiable by `name` for filtering.

### 7.3 `404` on GitHub Contents URLs containing `?`, `#`, etc. (2026-05-25)

**Symptom.** A file named `[1] File ^ opa?.md` pushed via the
GitHub web UI was unreachable by pull. `GET contents/[1] File ^
opa?.md` returned 404 despite the file existing in the GitHub tree.

**Cause.** The GitHub Contents-API URL was constructed by direct
string interpolation of the path. URL-syntax characters (`?`, `#`,
` `, …) terminate the path component on the server side: the API
saw the path as `[1] File ^ opa` with `md` as a query parameter —
no such file at that path → 404.

**Now-covered-by:** §3 *Cross-Platform Contracts*
(`encodePathForGithub` percent-encodes per segment; every Contents-
API URL construction routes through it; raw path interpolation is
forbidden by convention and missing from the GitHub client code).

### 7.4 Orphaned state after silent skip on null fetch (2026-05-25)

**Symptom.** After the URL-encoding bug in 16.3 was hit on mobile,
the `[1] File ^ opa?.md` file remained absent from the mobile vault
on every subsequent sync — even after the encoding fix shipped. A
Plugin Reset (full re-bootstrap) was required to recover.

**Cause.** `applyRemoteAddOrModify` treated a
`safeFetchContents → null` result as "raced with subsequent remote
delete; skip this file." The 404 from the URL-encoding bug returned
null. The pull loop continued; `lastSync` advanced to the new
branch head. From the next sync forward, the compare diff between
`lastSync` and `currentHead` no longer surfaced the file as a
change — it was present at both ends with the same SHA — and the
file became invisible to incremental sync.

**Now-covered-by:** §6 *Skip-Class Discipline*. The compare-listed-
but-fetch-null case is now `unexpected` and throws
`StaleStateError`. The per-file catch in `pullIfNeeded` logs the
exact path; the loop aborts; `lastSync` stays at the prior
`expectedHead`; the next sync retries. Either succeeds (transient
race resolved, permission drift fixed, fixed-client deployed) or
re-fails until the underlying cause is gone — no orphan state.

### 7.5 `GitRPC::BadObjectState` (422) on stale deletion entries (2026-05-25)

**Symptom.** Two desktop syncs within thirty minutes of one
release produced six retries each (~17 seconds of network noise)
and a final `Error: Failed to create tree, status 422`. Both pushes
carried a deletion entry for a path that had been sanitized away on
a different device hours earlier.

**Cause.** Pull-side sanitize wrote a *phantom snapshot entry* at
the forbidden GitHub path with the GitHub blob SHA. ChangeDetector
Pass 2 saw the snapshot entry had no local file → emitted a
deletion change → TreeBuilder built a `sha:null` entry → push
attempted `createTree` with a deletion targeting a path another
device's sanitize-push had already removed. GitHub responded 422
`GitRPC::BadObjectState`. The bug was rare before pull-side
sanitize existed (the only way to produce a stale deletion was a
manual edit on GitHub web between two syncs) and systemic
afterward (any forbidden path migrated by Device A produced a
phantom on Device B that became stale as soon as Device B pulled
post-migration).

**Now-covered-by:** §4.1 *Pre-flight validation* (the validator
drops stale deletions before `createTree`; the matching snapshot
row is removed so ChangeDetector does not re-emit the same stale
deletion next sync) and §4.2 *Pending-deletions queue* (sanitize
intent is recorded in an explicit store, not as a phantom snapshot
entry; the snapshot invariant "every row is an observation, not a
delete-intent" is restored).

### 7.6 `theirsBytes:0` on >1 MB files → silent overwrite of remote (2026-05-29)

**Symptom.** A Desktop sync push converted eight remote files on
GitHub `main` into 47-byte stubs that contained only the heading
inserted by another Obsidian plugin (filename-as-heading
auto-prepender). Three of the affected files had been >1 MB
markdown notes on GitHub; the overwriting commit was authored by
sync2 with the standard `Sync at <ts> (<device>)` message. Plugin
log showed `Sync2 reconcile path bytes-resident
oursBytes:47 theirsBytes:0` for each file, then silently chose
"ours wins" with no explicit decision log.

**Cause.** Two faults stacked.

1. *Local trigger.* The three large notes had previously become
   0 bytes on Desktop (root cause not in sync2 — most likely an
   external write or a crash mid-write through an unrelated
   plugin). When the user next opened them, the filename-as-heading
   plugin observed empty content and prepended a `# <basename>`
   line, leaving a 47-byte file. Local-only state is by definition
   sync2's input, not sync2's output — so the plugin had no notion
   that the change was unintended.

2. *Reconcile blind spot (the structural bug).* GitHub's Contents
   API has a hard ~1 MB inline-content limit. For files between
   1 MB and 100 MB the API returns status 200 with
   `content: ""` and `encoding: "none"`, expecting the caller to
   fall back to the Blobs API by the file's blob SHA.
   `GithubClient.getContentsAtRef` returned the empty `content`
   verbatim. The reconcile call site decoded it as a 0-byte
   `ArrayBuffer`, computed a 3-way merge against `base=∅, theirs=∅,
   ours=47 bytes`, and concluded `modify-wins → push ours`. The
   resulting tree carried 47-byte blobs for paths that had been
   ~1 MB on remote, and the push committed cleanly because GitHub
   itself does not care about size delta.

**Now-covered-by:** §3 *Cross-Platform Contracts* extended with
the Contents-API size discipline.
`GithubClient.getContentsAtRef` now inspects `size` and `encoding`
on the response: when `size > 0` and `content === ""` (the
documented "too large for inline" case), it fetches the actual
bytes via `getBlob({ sha })`. The fallback path is INFO-logged
with `{ path, ref, size, encoding, sha }` so a production sync
that hits a large file leaves a visible breadcrumb. A unit suite
(`tests/sync2/github-client-large-file.test.ts`, 5 cases) covers
the four branches — inline-content path, legitimately-empty file,
documented-empty large file with Blobs fallback, defensive
`content: null` variant — and an integration suite
(`tests/integration/scenarios/sync2/edges/F-large-file-over-1mb.test.ts`)
exercises a real 1.5 MB markdown round-trip through push, remote
read, and an incremental reconcile cycle. The companion
defensive-guard work (zero-byte → conflict instead of push;
>90 % shrink heuristic; explicit reconcile decision logging) is
tracked as separate hardening tasks and ships in a follow-up
release; this postmortem covers the structural fix that resolves
the primary failure mode.

### 7.7 `File does not exist` (ENOENT) mid-walk fails the whole syncAll on Android (2026-06-03)

**Symptom.** On Obsidian Android, a `[Sync]` shortly after launch
logged `ERROR "syncAll click failed" … "File does not exist" code:
"ENOENT"` with a stack containing only `win.androidBridge.onmessage`
/ `returnResult` (a raw adapter rejection, not plugin logic). A
*concurrent* syncAll, fired ~100 ms apart at startup, committed the
batch fine (3 `.obsidian/*` config files modified), so the failure
was intermittent and left no corruption — the next sync succeeded.

**Cause.** `change-detector.findChanges()` reads each candidate's
bytes (`readBinary`) to SHA it, right after the file was listed in
`allFiles`. Obsidian rewrites its own config (`app.json`,
`appearance.json`, `core-plugins.json`) around startup (and on any
relevant settings change); on Android the Capacitor write has a brief
window where the file is momentarily absent. A concurrent `readBinary`
lands in that window → ENOENT. The read was unguarded, so the
rejection propagated out of `findChanges` and failed the entire
syncAll. Two syncAll calls racing at startup widened the window.

**Now-covered-by:** §6 *Skip-Class Discipline*. `findChanges`'
candidate reads (and the single-path `detectOne`) now go through
`readBinaryOrSkip`, which catches a "file vanished" error
(`code === "ENOENT"` or message `/does not exist|no such file/i`) and
returns `null` → the caller skips that file this pass. Safe because
the file was already in `allFiles` (so Pass-2 sees it as "seen" and
emits no spurious delete); a transient vanish is re-read next sync, a
genuine delete is omitted from the next `allFiles` and emitted then.
Non-missing errors still rethrow. Test:
`change-detector.test.ts` "ENOENT mid-walk … skips it, sync survives".

### 7.8 plugin-js tie-break pulled a STALE remote bundle over a newer local one (2026-06-30)

**Symptom.** A device-tester on a SINGLE machine (one-way sync, Macbook →
GitHub) saw the plugin self-update (`BRAT-style reload`) DOWNGRADE its own
`main.js` to an older remote build during a normal `[Sync]`. Impossible on
its face: the remote can never be "newer" than the only writer. The log
showed `reconcile path bytes-resident main.js oursBytes:274041
theirsBytes:268105` (local NEWER + bigger) yet the engine wrote `theirs`.

**Cause.** `isAtomicPluginFile` paths resolve by semver, falling back to
mtime on a tie (§6 `resolvePluginJs`). With the plugin at an unbumped
`2.0.2-beta` on both sides, `compareSemver` strips the pre-release tag →
TIE → mtime. The "theirs" timestamp was `getCommit(HEAD).committer.date` —
the **branch HEAD** commit date, NOT when `main.js` was last changed. The
tester's conflict-resolution + unrelated commits had advanced HEAD *past*
the commit that last touched `main.js`, so `theirsMtime` (recent HEAD) >
`oursMtime` (the local build's file mtime) → the resolver chose `theirs`
and pulled the stale remote bundle. The existing E4 integration test never
caught it because its remote tweak always made `main.js` the HEAD commit
(HEAD date == file date), so the bug was invisible.

**Fix.** New `GithubClient.getLatestCommitDateForPath({path, ref})` →
`GET /commits?path=&sha=&per_page=1` → the committer date of the LATEST
commit that touched THAT FILE. Both `readPluginJsContext` sites (pull-side
and push-side reconcile) use it for `theirsMtime` instead of the HEAD date.
`null` (no commit / fetch error) → `0` (epoch) → OURS wins — the safe
direction (never pull a remote bundle over local on uncertainty); never
throws. The cross-device intent is unchanged: whichever side's bundle was
*built/committed* more recently wins. Tests (DETERMINISTIC unit only —
**no integration guard**: GitHub's commits-listing `?path=` is eventually
consistent, so an integration test that commits then immediately queries is
inherently flaky, and a flaky regression test gets disabled; production
remote commits are settled, so the lag is not a real concern):
`github-client-large-file.test.ts` (the client method — parse / author-date
fallback / empty→null / error→null) and `sync2-manager.test.ts` "plugin-js
mtime tie-break uses the file's LAST-CHANGE date" (the resolver — proven to
fail on the old HEAD-date code, pass with the fix).

### 7.9 "conflict with yourself" on a single-writer vault — the push→record crash gap (2026-07-01)

**Symptom.** A one-device vault (no other writers, one-way device → GitHub)
registered a `modify-vs-modify` conflict on a file against *itself*. This is
physically impossible with a correct snapshot: a conflict needs the remote to
have diverged from the recorded `base` INDEPENDENTLY of the local edit, and on a
single writer the remote only moves when *we* push — after which *we* record it.

**Cause.** The push flow in `processBatch` (and the conflict-branch finalize
merge) advances the tracked branch and THEN persists the snapshot, with **no
atomicity across the window**:

```
updateBranchHead(commitSha)   ← REMOTE HEAD ADVANCES (point of no return)
...
setLastSync(commitSha, tree)  ← snapshot updated in memory
store.save()                  ← snapshot PERSISTED to disk
```

A crash (kill Obsidian) between the ref-advance and `store.save()` leaves the
remote advanced but the on-disk snapshot frozen at the OLD head — a **stale
base**. A plain crash SELF-HEALS on the next drain (the reconcile's
`ours == theirs` convergence records the snapshot). But if the user EDITS the
file after the interrupted push (the "…and then make local changes" moment), the
next reconcile 3-ways `ours=v2` against `base=v0` (stale) and `theirs=v1` (our
own pushed content) — both "changed" the same region relative to the stale base
→ a false conflict with ourselves. Proven deterministically in
`sync2-manager.test.ts` "REPRO: crash between updateBranchHead and recordSync".
Orthogonal to §7.8 (that is a file-vs-HEAD *date* confusion in the tie-break;
this is a crash *atomicity* gap in snapshot advancement — different mechanism).

**Fix (crash-recovery marker).** `push-inflight.ts`: a per-device
`.push-inflight.json` marker in the plugin's OWN folder
(`<configDir>/plugins/<id>/`, alongside `.push-queue`/`.conflicts` — already
gitignored by the `plugins/*/*` recommended default, so no invariant-block entry
is needed; `vault.adapter`-only → mobile-safe). Written `{newHead, newTreeSha,
batchId}` (best-effort — a marker-write failure never aborts the push) *before*
the MAIN push's `updateBranchHead` (`processBatch`), removed *after* `store.save()`.
**Scope: the main push ONLY.** The conflict-branch FINALIZE-MERGE has the same gap
but is deliberately NOT marked — a crash there must also reconcile
`deleteReference(conflict-branch)` + `clearConflictBranch()`, which the uniform
"re-record lastSync" heal doesn't do (it would leave the store thinking a conflict
branch is active while the snapshot says merged, and would SUPPRESS the reconcile
that would otherwise sort it out — worse than not marking). Marking it, with its
full cleanup, is a separate tested unit (deferred). Conflict-*branch* pushes never
advance the tracked branch, so they need no marker.
`Sync2Manager.recoverPushInflight()` runs BEFORE `findChanges` on
every enqueue path (`syncAll`, `commitOnly`): if a marker is present it re-reads
the real remote head; `realHead == marker.newHead` ⇒ our push landed but wasn't
recorded ⇒ `setLastSync(newHead, tree)` + delete the completed batch, so the base
is correct before the change-detector measures against it. Any other `realHead`
(ref never landed / another device moved it) ⇒ just drop the marker and let the
normal drift reconcile handle it. A `getBranchHeadSha` failure LEAVES the marker
(retry next drain); a corrupt/failed marker degrades to today's
self-heal-or-conflict (never worse). Tests: `push-inflight.test.ts` (marker
fault-tolerance), `sync2-manager.test.ts` "crash gap WITHOUT a post-crash edit
SELF-HEALS", "REPRO …" (no marker → the false conflict), and "FIX: crash gap WITH
the push-inflight marker → recovery re-records the base, NO conflict".

---

## 8. Worker Orchestra

Added in 2.0.2-beta. Before this rework the engine ran every CPU
operation (3-way merge, base64 decode, SHA-1) and every GitHub
HTTP call on the JS main thread. On Obsidian Mobile this could
freeze the UI for tens of seconds when a multi-megabyte file
reached the reconcile path — the node-diff3 algorithm hits a
hard scaling cliff (~16 s at 4 MB on Node desktop, ~85 s on a
mid-tier Android phone in the May 2026 field investigation).

The orchestra consists of three coordinated thread roles:

| Role | Count | Owns |
|---|---|---|
| Main thread | 1 | UI, vault.adapter writes, snapshot store, reconcile decisions, settings I/O |
| CPU worker pool | 2-4 | base64 decode, git-blob SHA-1, node-diff3 3-way merge |
| Network worker | 1 | every GitHub REST call (`fetch` against `api.github.com`) |

Pool size auto-tunes to `max(2, min(4, navigator.hardwareConcurrency - 1))`.

### 8.1 Build pipeline

esbuild produces three bundles: `main.js` (the plugin entry) and
two worker IIFEs (`cpu-worker`, `network-worker`). The worker
IIFEs never ship as separate files. Instead the build step:

1. Bundles each worker source to an in-memory IIFE string.
2. Passes the strings to the main-bundle build via esbuild's
   `define`, substituting `__CPU_WORKER_SOURCE__` and
   `__NETWORK_WORKER_SOURCE__` as literal JS string constants.
3. At runtime `WorkerClient` wraps each constant in a `Blob` and
   creates a `URL.createObjectURL(blob)` — that URL becomes the
   `new Worker(url)` argument.

This sidesteps `importScripts` (network round-trip and caching
concerns) and the Capacitor `app://` URL scheme (unproven in
worker context as of 2026). The Stage 6 CORS feasibility test
on Pixel 6 Pro validated that worker-scope `fetch` against
`api.github.com` works with Authorization Bearer headers —
~800 ms round-trip including worker construction.

### 8.2 Threshold gates

Worker dispatch has a postMessage cost (~5-10 ms round-trip on
mobile). Small operations stay inline on the main thread:

| Operation | Worker threshold |
|---|---|
| SHA computation | ≥ 100 KB |
| Base64 decode | ≥ 2 MB |
| 3-way merge | ≥ 100 KB (largest input) |

Below the threshold, `WorkerClient.computeGitBlobSHA` /
`decodeBase64` / `mergeText` run synchronously through the
fallback handlers (which use identical algorithms — see Stage 4
worker-vs-fallback byte-exact identity tests).

### 8.3 What workers CAN and CANNOT do

CAN: `fetch(url)` (including local files via
`adapter.getResourcePath` URLs the main thread provides),
`crypto.subtle.digest`, `atob`, run pure-JS libraries (node-diff3
is bundled into `cpu-worker.ts`), receive transferable
ArrayBuffers zero-copy via postMessage.

CANNOT: call any Obsidian API (`vault.adapter.write`,
`app.workspace`, settings), mutate the vault directly, construct
nested workers (unsupported on Capacitor).

**Implication**: vault mutations must round-trip through main.
The "main drain worker that does everything" design was
considered and rejected — it would have to round-trip every
vault write back to main, eliminating the parallelism win. Main
thread stays as a thin orchestrator.

### 8.4 Cancellation

`Sync2Manager.cancelDrain()` sets an `abortRequested` flag the
reconcile loop checks between files. For in-flight Worker jobs,
`workerClient.terminate()` is synchronous and instant — the
controller re-creates fresh workers from the source strings for
the next sync (~5-10 ms via Blob URL + new Worker).

### 8.5 Graceful main-thread fallback

If `new Worker()` throws at startup (very old Capacitor versions,
strict CSP, etc.), `WorkerClient` flips into fallback mode and
every op runs synchronously on the main thread using the same
algorithm. Decided once at construction, cached on `isFallback`.
The size guard (§8.6) remains the safety net for the
fallback-mode CPU operations.

### 8.6 Size guard (`maxAutoMergeSizeBytes`)

Defense in depth even with Worker offload. Above the configured
limit (default 1 MB, exposed in Settings → Performance), the
engine skips `attemptAutoMerge` entirely and just uploads the
local bytes. Two reasons for the guard:

1. **node-diff3 wall-clock**: even off the main thread, 5 MB of
   text takes ~26 s on Node, much more on a phone. The user is
   not going to wait. Better to mark "ours wins for this file"
   than to spend 50 s of compute.
2. **Capacitor base64 stalls**: empirically the JS↔native bridge
   on Android could stall under load when decoding multi-MB
   strings, even though the same payload decoded cleanly in
   isolation. The size guard sidesteps the entire class of bug.

Tune up only after measuring on the slowest target device. See
`tests/perf/README.md` for Node-desktop baselines.

---

## 9. SHA-First Reconcile

Added in 2.0.2-beta. The reconcile loop used to fetch base + theirs
**content** for every path in a pending batch, then decoded both,
then ran the 3-way merge — expensive even when SHAs alone could
have resolved the path. SHA-first inverts the order:

1. Read ours bytes from `.push-queue`.
2. Fetch base + theirs **metadata only** (`getContentsMetadataAtRef` —
   returns `{sha, size}` without downloading the blob).
3. Branch on SHAs:

```
                     base.sha === theirs.sha
                              │
                              ▼
                  No remote change → push ours

      base.sha === theirs.sha is false
                              │
                              ▼
                    Compute ours.sha
                              │
                              ▼
                  ours.sha === theirs.sha
                              │
                              ▼
              Drop from batch (already in sync;
              ours and remote are byte-identical)

       ours.sha === theirs.sha is false
                              │
                              ▼
                   ours.sha === base.sha
                              │
                              ▼
        Atomic theirs wins. Fetch theirs bytes
        only; write to vault; drop from batch.

         ours.sha === base.sha is false
                              │
                              ▼
            All three SHAs differ → fetch base
            and theirs bytes; full 3-way merge
            (the slow path, via Worker if above
            the merge threshold).
```

Empirically ~75 % of reconcile paths resolve from SHAs alone (no
remote change OR ours wins OR theirs wins atomic). Net effect:
multiple MB of unnecessary downloads avoided per typical
multi-device sync. The single-MB merge cliff still bites for the
remaining ~25 %, but the size guard (§8.6) covers the worst
cases.

`getContentsMetadataAtRef` is a new method on `GithubClient`. It
hits the same Contents API endpoint but discards the inline
content (and never falls back to Blobs API for >1 MB files,
since we're explicitly not asking for content). Same 404
semantics as `getContentsAtRef`.

---

## 10. Modify-in-Place Crash Safety

Added in 2.0.2-beta. Before this rework, `atomicWriteFile` always
used the rename strategy:

1. `writeBinary(.sync-tmp, newBytes)`
2. `rename(live → .sync-bak)`
3. `rename(.sync-tmp → live)`
4. `afterCommit()`
5. `remove(.sync-bak)`

This works on every filesystem and is crash-safe (the bak holds
the pre-write bytes; the sweep restores from it on next onload).
But it has a UX cost: Obsidian's MarkdownView holds a reference
to the live TFile. Step 2 renames it aside; Obsidian sees the
file disappear and closes the editor. The user's cursor and
scroll are lost mid-pull.

The fix: when the target already exists as a TFile AND the
runtime exposes `vault.modifyBinary`, take an editor-friendly
fast path that writes in place. `vault.modifyBinary` is the
Obsidian-idiomatic write — it fires the right events so the
editor updates its buffer without unloading.

### 10.1 Forward-recovery protocol

`vault.modifyBinary` is atomic at the OS level for single
syscalls but the operation as a whole is a sequence — crashes
between the modify and the snapshot update need recovery.
Symmetric design with the existing rename strategy:

| Step | Operation |
|---|---|
| 1 | `writeBinary(<basename>.sync-tmp.<ext>, newBytes)` — stage the FUTURE state |
| 2 | `write(.<basename>.<ext>.sync-tmp., "")` — drop the marker |
| 3 | `modifyBinary(target, newBytes)` — preserves open editor |
| 4 | `afterCommit()` — caller records new SHA |
| 5 | `remove(.sync-tmp)` — staging gone |
| 6 | `remove(marker)` — recovery signal flipped off LAST |

The marker is a zero-byte file. Its NAME shape is what
disambiguates it from the rename-strategy staging file:

| File | Shape | Recognised by |
|---|---|---|
| Rename-strategy staging | `note.sync-tmp.md` | `parseStagingPath` (sync-tmp in middle, NO trailing dot) |
| Rename-strategy backup | `note.sync-bak.md` | `parseStagingPath` (sync-bak in middle) |
| Modify-in-place marker | `.note.md.sync-tmp.` | `parseModifyMarkerPath` (leading dot, trailing dot) |

The trailing dot is the unambiguous signal. Hidden config files
like `.eslintrc.json.sync-tmp` (legitimate staging for the
existing hidden file `.eslintrc.json`) end in `.sync-tmp` with
NO trailing dot, so they don't trip the marker parser. The
trailing dot also makes the marker invisible to most file
explorers and inert to Capacitor's iOS/Android filesystems
(POSIX allows trailing dots; Windows would strip them, but
Obsidian on Windows uses the rename strategy in any case
because the WinAPI filesystem doesn't support markers cleanly).

### 10.2 Recovery sweep

`AtomicWriteRecovery.sweep` runs at plugin onload, before
`workspace.onLayoutReady`. At this point no editor is yet open;
the rename's editor-close side effect is moot.

For each modify-in-place marker found in the walk:

| State | Action |
|---|---|
| marker + `.sync-tmp` present | `remove(target)` if exists, `rename(.sync-tmp, target)`, `remove(marker)`. Forward-completes the operation. |
| marker without `.sync-tmp` | `remove(marker)`. Step 5 ran (sync-tmp gone) but step 6 crashed; the modify completed successfully and the marker is a stale leftover. |
| `.sync-tmp` without marker | Existing Path A logic drops it as a transient. Crash before step 2; the staging is bytes-without-context. |

No SHA computation, no snapshot lookup. The marker's mere
presence is the entire signal.

### 10.3 Why the rename strategy didn't get a marker

Considered for symmetry and rejected. The rename strategy
already has a unique "in-flight" signal: the `.sync-bak` file
itself, which only exists during steps 2-5. Adding a marker on
top would be redundant. The existing SHA-based bak orphan
recovery (snapshot.remoteSha matches → cleanup, mismatches →
restore) handles all cases correctly.

The modify-in-place strategy has NO bak (the live file is
modified in place, no backup is produced), so the marker is the
ONLY signal. That's why it's essential there.

---

## 11. Plugin Reload After Pull

Added in 2.0.2-beta2. When a Sync delivers updated files to some
plugin's directory under `<configDir>/plugins/<id>/`, Obsidian
keeps running the OLD code in memory until the user manually
disables + re-enables the plugin. The fix is to perform that
reload programmatically at the end of any drain or recovery sweep
that touched a plugin file.

**The reload primitive (`reloadPluginById`).** None of Obsidian's
plugin-manager methods are in the public typings; we feature-detect.
A first implementation assumed `app.plugins.reloadPlugin(id)` and
shipped — then a field report (2026-05-31) showed it failing
silently on **Obsidian Mobile**, where `reloadPlugin` does **not
exist**. The log carried the tell: *"BRAT-style reload requested but
app.plugins.reloadPlugin is unavailable"*. The portable primitive is
the one BRAT actually uses: **`disablePlugin(id)` then
`enablePlugin(id)`**, which exists on desktop and mobile alike.

`reloadPluginById(app, id)` therefore prefers `reloadPlugin` when
present (a single atomic call on desktop) and otherwise falls back
to `disablePlugin` + `enablePlugin`. For a self-reload this means
the running instance disables itself (its `onunload` runs), then
re-enables — loading the new `main.js` already on disk from the
marker swap (§12). `canReloadPlugins` gates the whole path: if
neither mechanism is present, the engine logs a warning and skips
rather than throwing.

### 11.1 Which paths trigger reload

A path under `<configDir>/plugins/<id>/<file>` triggers reload
for `<id>` if and only if `<file>` is one of:

- `main.js` — the plugin's executable code
- `manifest.json` — version, declared permissions
- `styles.css` — CSS Obsidian applies on enable
- `data.json` — the plugin's persisted settings

Subdirectory files (e.g. `<plugin>/<id>/data/notes.json`) do NOT
trigger reload. Obsidian reads them on demand at runtime, not at
plugin enable time. The helper `extractAffectedPluginId(path,
configDir)` in `plugin-update-bootloader.ts` is the canonical
discriminator; any code that needs to ask "does this path
require a plugin reload?" goes through it.

### 11.2 Two trigger surfaces

The drain has two places where a plugin file might land on disk:

**Normal flow — drain-end reload.** During `pullIfNeeded`, the
engine writes plugin files via `writeBinaryRemote` and
`writeRemoteText`. Each successful write calls
`maybeMarkPluginAffected(path)`, which adds `<id>` to the
drain-scoped `affectedPluginIds` Set. At drain end (on full
success), `drain.finally` fires `onPluginsAffected(ids[])` to the
main thread. main.ts schedules `reloadPlugin(id)` for each
affected plugin via `setTimeout(..., 500)` — the 500 ms unwinds
the in-flight drain stack frame before Obsidian's plugin
lifecycle tears the old instance down.

**Crash recovery — sweep-end reload.** When `AtomicWriteRecovery
.sweep` forward-applies a write that landed under a plugin path,
it returns the recovered path in its `appliedPaths` array.
main.ts walks `appliedPaths` through `extractAffectedPluginId`;
any plugin whose file was applied forward gets a `reloadPlugin`
schedule alongside the drain-end path. The sweep's ROLLBACK
cases (`.sync-bak` restored over original) are NOT surfaced —
rollback brings the path back to its pre-write state, which any
already-running plugin already matches, so no reload is needed.

### 11.3 Schedule semantics

For every drain (or sweep) that fires `onPluginsAffected`, the
handler:

1. Reads `app.plugins.enabledPlugins` (a `Set<string>`).
2. Filters affected IDs to those currently enabled (disabled
   plugins don't need a reload they'd ignore).
3. For each surviving ID, schedules
   `setTimeout(() => app.plugins.reloadPlugin(id), 500)`.
4. Surfaces ONE aggregate Notice (`"Plugin <id> updated —
   reloading…"` for one, `"N plugins updated — reloading…"` for
   multiple) so the user has a visible signal.

The 500 ms delay is the same value across both trigger surfaces
and the bootloader (§12). Treat it as the "drain-stack-unwind
budget" — long enough for any in-flight `await` to return,
short enough that the reload feels immediate to the user.

### 11.4 Self-reload — the special case

Updating OUR OWN plugin (`github-easy-sync`) is recursive: the
file being swapped is the file the running code came from.
On POSIX (macOS, Linux, Capacitor Android-on-Chromium), atomic
rename of an open file works at the filesystem layer — the V8
in-memory image is independent of the file's inode, so renaming
`main.js` doesn't affect the currently-running code. Obsidian's
subsequent `reloadPlugin` call disables the old instance and
loads `main.js` fresh, picking up the new bytes.

The complication is the **crash window**: if the engine crashes
between writing the new `main.js` and scheduling the reload,
the next plugin launch finds new code on disk but inconsistent
ancillary state (snapshot may be old, sync-tmp/sync-bak may
linger, etc.). The self-update marker protocol in §12 handles
this case with crash-safe recovery from a state machine the
plugin's own bootloader can drive — even before logger,
settings, or snapshot are initialised.

A field report (2026-05-31) surfaced the reload primitive's
portability gap: a first implementation called
`app.plugins.reloadPlugin(id)`, which exists on desktop but
**not on Obsidian Mobile**, so the auto-reload silently no-op'd
on phones (the log carried *"reloadPlugin is unavailable"*). The
portable primitive — what BRAT itself uses — is
`disablePlugin(id)` then `enablePlugin(id)`, available on both.
`reloadPluginById` prefers `reloadPlugin` when present and falls
back to disable+enable otherwise; `canReloadPlugins` gates the
whole path.

### 11.5 Drain overlap across a reload

The reload is a disable-then-enable of the plugin, so for a brief
moment the OUTGOING instance is tearing down while the INCOMING
instance is starting. Each instance has its own `running`
re-entrant guard, so the guard alone cannot stop the two from
running drains concurrently. Two concurrent drains are a real
hazard: with the deterministic commit identity (§4.4), both can
build the *same* commit SHA for the same batch, and the second
PATCH to move the head then fails non-fast-forward (§4.1).

Three cooperating measures keep the two drains apart, with no
marker files or cross-instance locks:

1. **`onunload` cancels the outgoing drain.** The first action in
   `onunload` is `cancelDrain()` — before the worker pool is
   terminated — so the outgoing instance aborts its in-flight
   drain cleanly (the loop checks `abortRequested` between
   batches/files) rather than crashing on the worker that
   `onunload` then tears down.

2. **The incoming startup sync is delayed.** The new instance
   does not fire its startup sync the instant layout is ready; it
   waits ~1.5 s (`STARTUP_SYNC_DELAY_MS`). That window lets the
   outgoing instance's teardown settle before the incoming drain
   begins. On a normal cold start the delay is imperceptible. The
   timer is cleared in `onunload` so a reload *during* the window
   cannot fire a startup sync on an already-unloaded instance.

3. **Fail-fast absorbs any residual overlap.** If, despite the
   above, two drains still race to push the same batch, the
   loser's ref-update 422 fails fast (§4.1) and the next drain
   reconciles + reuses the already-pushed commit. The overlap
   becomes invisible rather than a 33-second hang.

A cross-instance lock (a `.drain-lock` marker in `.push-queue/`
with a stale-timeout) would close the last theoretical sliver —
an in-flight HTTP call completing after `cancelDrain` — but the
per-drain I/O and the fragile timeout (a long legitimate push
versus a crashed-drain stale lock) are not justified while
fail-fast already makes the case self-heal. It is deferred until
field evidence shows a genuine cross-instance race.

---

## 12. Self-Update Marker Protocol

Added in 2.0.2-beta2. Updating our own plugin's main.js (and
the other recoverable files in our directory) has stricter
crash-safety requirements than other plugins' files: the engine
that performs the write IS the running code, the bootloader
that handles recovery on next launch runs BEFORE the snapshot
store is loaded, and the user can't easily intervene if main.js
ends up corrupted (Obsidian won't load the plugin to even run
recovery code).

The protocol uses a **marker file** as the integrity signal.
This section explains why marker presence is the right signal,
how the write side produces it, and how the bootloader consumes
it.

### 12.1 Why not SHA verification

A previous design used `SHA(main.js) ≠ SHA(main.sync-tmp.js)`
as the "pending update" signal: if the two files differed on
disk, the bootloader applied sync-tmp via atomic rename. This
turned out to be a correctness bug.

`SHA(sync-tmp)` computed at bootloader time is just the hash of
whatever bytes happen to be on disk. If the previous engine
process was killed mid-`writeBinary`, sync-tmp has partial bytes
and SHA(partial) ≠ SHA(main.js). The bootloader would happily
apply those partial bytes, corrupting main.js. The next launch
would then fail to load the plugin at all, requiring the user
to reinstall via BRAT or the Community Plugins store.

The classic `AtomicWriteRecovery.sweep` avoids this trap by
comparing SHA(sync-tmp) to a TRUSTED expected SHA — either the
`theirsBlobSha` on a ConflictStore record (Path B) or the
`remoteSha` on a SnapshotStore entry (rename-strategy bak
recovery). The bootloader can't use either: it runs at the very
top of `onload()`, BEFORE settings load, BEFORE logger init,
BEFORE the snapshot store opens. There is no trusted source of
"what the sync-tmp SHOULD hash to."

The fix is to substitute a separate signal entirely — a marker
file the engine drops AFTER the sync-tmp write completes. The
marker's mere presence certifies that the write reached
completion; bytes on disk are then known to be valid even
without any SHA comparison.

### 12.2 The marker file

For each recoverable file in our plugin directory, the marker
filename is `.<basename>.<ext>.sync-tmp.`:

- `main.js` → `.main.js.sync-tmp.`
- `manifest.json` → `.manifest.json.sync-tmp.`
- `styles.css` → `.styles.css.sync-tmp.`

`data.json` is **excluded** from the protocol because we never
pull it from remote — it's per-device state owned by the
running instance.

The shape (leading dot, trailing dot, `.sync-tmp.` in the
middle) is byte-identical to the modify-in-place marker
convention in §10.1. This is intentional: the existing
`AtomicWriteRecovery.sweep` already handles markers via its
modify-in-place recovery branch, so even if the bootloader is
somehow bypassed (a code bug at the top of `main()`), the sweep
catches the same case at `initSync2` time. Defense in depth at
zero additional implementation cost.

The marker is a zero-byte file. Its presence is the entire
signal — no content needed.

### 12.3 Write protocol

In `Sync2Manager.applySelfUpdateOwnFile(path, bytes, afterCommit)`:

```
Step 1: writeBinary(<basename>.sync-tmp.<ext>, bytes)   — full write commit
Step 2: write(.<basename>.<ext>.sync-tmp., "")          — marker drop
Step 3: rename(<basename>.<ext> → <basename>.sync-bak.<ext>)
                                                         — Capacitor-safe
                                                           backup
Step 4: rename(<basename>.sync-tmp.<ext> → <basename>.<ext>)
                                                         — atomic swap
Step 5: afterCommit()                                    — snapshot update
Step 6: remove(.<basename>.<ext>.sync-tmp.)              — marker cleanup
Step 7: remove(<basename>.sync-bak.<ext>)                — backup cleanup
        affectedPluginIds.add(selfPluginId)              — drain-end reload
```

The protocol runs in the current drain process; it does NOT
defer the swap to a deferred plugin start. POSIX atomic-rename
of a running plugin's main.js is safe (the V8 image is
inode-independent), and applying the swap inline gives the
drain a single `reloadPlugin` call to schedule — no second
reload cycle through a deferred bootloader path.

### 12.4 Bootloader recovery decision matrix

At the top of our `onload()` (before anything else, including
logger init), `runSelfUpdateBootloader` iterates over the three
recoverable files. For each, it probes the presence/absence of
both the marker and the sync-tmp file:

| marker | sync-tmp | Case   | Action |
|--------|----------|--------|--------|
| ✓      | ✓        | **A**  | apply forward (rename swap), schedule reload |
| ✓      | ✗        | **B**  | cleanup orphan marker (swap already completed) |
| ✗      | ✓        | **C**  | drop sync-tmp (write was incomplete) |
| ✗      | ✗        | **D**  | nothing pending, normal load |

Cases B and C are SILENT — no reload is needed because the
running code already matches the on-disk state (B: post-apply,
C: pre-apply with sync-tmp dropped as it would have been by
Path A sweep). Case A schedules ONE `reloadPlugin` regardless of
how many of the three files were applied, since Obsidian
re-reads everything on enable. Case D returns immediately and
the rest of onload runs as usual.

### 12.5 Crash-window matrix

Every step in the write protocol has a deterministic recovery
case at next launch:

| Crash before step | State on disk                          | Bootloader case | Outcome |
|-------------------|----------------------------------------|------------------|---------|
| 2 (marker drop)   | sync-tmp only                          | C                | drop sync-tmp; next sync retries |
| 3 (file → bak)    | sync-tmp + marker + original           | A                | apply forward |
| 4 (sync-tmp → file)| sync-tmp + marker + bak (no original) | A                | apply forward (file appears) |
| 5 (afterCommit)   | new original + marker + bak            | A finishes       | rename(sync-tmp absent → noop); cleanup marker + bak |
| 6 (remove marker) | new original + marker (no sync-tmp)    | B                | cleanup marker |
| 7 (remove bak)    | new original + bak (no marker)         | normal load + standard sweep handles bak |
| after step 7      | new original                           | D                | normal load |

Note that the step-5 crash window collapses to Case A whose
sub-paths handle the absent sync-tmp gracefully (the rename
sync-tmp → original is skipped if sync-tmp doesn't exist; marker
and bak cleanup proceed as in steps 6-7).

The protocol is forward-complete in every crash window: the
bootloader always brings the directory to a consistent state
where the new code is loaded on the NEXT plugin enable (which
happens automatically when the bootloader schedules
`reloadPlugin`).

### 12.6 What the protocol does NOT cover

- **The user reinstalls via BRAT or Community Plugins while
  sync-tmp + marker are pending.** BRAT overwrites main.js
  directly; our bootloader on next launch sees marker +
  sync-tmp + the new main.js from BRAT, applies sync-tmp,
  effectively reverting BRAT's install. The user must clean up
  the staging files manually or run a second BRAT install. Rare
  edge case; not mitigated.

- **Power loss between `writeBinary(sync-tmp)` await completing
  and bytes being flushed to durable storage.** On modern
  filesystems with built-in page-cache → disk write-back, this
  is vanishingly rare. The marker would then be present
  alongside a sync-tmp that the OS has dropped from page cache
  — equivalent to Case C if marker was also lost, Case A if
  marker survived. The Case-A apply might succeed (bytes were
  actually written) or fail (rename succeeds but corrupted
  bytes are now main.js). Not mitigated.

- **Cross-platform atomic rename semantics.** The protocol
  assumes `adapter.rename` is atomic at the OS level. POSIX
  guarantees this. Capacitor on iOS uses underlying APFS,
  which also does. Windows is not a target platform for the
  bootloader path (Obsidian Mobile doesn't run on Windows).

---

## 13. Glossary

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
`.obsidian/plugins/github-easy-sync/.push-queue/<id>/`. Holds the
files about to be committed, their target commit message, and the
parent commit SHA the push will build on.

**Blob** — A file's content addressed by the SHA-1 hash of its bytes.
The fundamental unit of git's object storage; has no name and no
location of its own.

**Commit** — A snapshot of a tree, accompanied by a list of parent
commits, an author, a committer, and a message. The unit of
historical record in git.

**Conflict branch** — A per-device GitHub branch named
`github-easy-sync-conflicts-<deviceLabel>-<timestamp>-<msec>` to
which the device's local version of every conflicting file is
pushed. Invisible to other devices until finalised through a
merge-commit on `main`.

**Conflict record** — A persisted entry in the conflict store binding
a vault path to its sibling file, the remote content's SHA, the
remote device's label, and cached `(mtime, size, sha)` triples for
fast freshness checks. Stored on disk as one
`meta.json` per record under
`.obsidian/plugins/github-easy-sync/.conflicts/<id>/`.

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
`.obsidian/plugins/github-easy-sync/github-easy-sync-metadata.json`.
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
patterns catch them. See §2.

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
`src/sync2/cross-platform.ts`; see §3.

**Forbidden character (filename)** — One of the 12 ASCII characters
rejected either by the host platform (Family 1: `< > : " | ? *
\` — Obsidian Android only) or by Obsidian itself (Family 2: `# ^
[ ]` — both platforms, because of wiki-link grammar). Replaced by
`sanitizeFilename()` with visually-faithful Unicode counterparts;
see §3.

**Pending-deletions queue** — Explicit on-disk store at
`<configDir>/plugins/<self>/.pending-deletions/` recording paths
the engine must delete from GitHub on the next push. Used by pull-
side sanitize (§3) when a forbidden-named GitHub file is
materialised locally under its canonical name and the forbidden
path itself needs cleanup. Replaces the older phantom-snapshot
mechanism; see §4.2.

**Pre-flight validation** — A check performed on a push-side
operation (every `createTree` request that carries deletion
entries) *before* the request is sent, against current GitHub
state, to verify the operation's assumptions still hold. The
opposite of optimistic write-and-retry; see §4.1.

**Stale-state error** (`StaleStateError`) — Typed error raised when
two pieces of remote state observed within one sync click no
longer agree. Causes include client URL-encoding bugs, token
permission drift, replica eventual consistency, and concurrent
force-push that rewrote currentHead. Always non-retriable on its
own surface: the per-file catch aborts the loop, the cursor stays
put, the next drain retries. See §5.

**Skip-class** — One of four labels (`applied`, `deferred`,
`already-correct`, `unexpected`) annotated as a source-code
comment on every `continue` / `return` inside the seven core loop
bodies of the sync engine. The `unexpected` class is never a
`continue` — it is `throw new StaleStateError(...)`. See §6.

**Push-queue depth** — Count of batches currently on disk under
`.push-queue/`, waiting to be drained. Surfaced as a numeric badge
on the `[Sync with GitHub]` ribbon icon: depth 0 hides the badge,
depth ≥ 1 shows `(N)` in a green pill. The signal updates after
every persistent queue mutation; see §4.3.
