# 1. Data Model

Part of the SYNC2 reference ([overview](../SYNC2.md)).

This chapter defines what the engine knows and where it keeps it. Every later
chapter is an algorithm over these structures, so the vocabulary introduced
here — *Vault*, *Repo*, *baseline*, *batch*, *sync store*, *journal*,
*ledger* — is used without further definition elsewhere.

---

## 1.1 Three places, three versions

A file under synchronization exists in up to three places:

- **The Vault** — the user's Obsidian vault on this device. It is the only
  place the user edits, and the engine treats it as the user's property: it
  writes into the Vault only as the result of a decided merge, and never
  deletes from it without a reason it can name.
- **The Repo** — one branch of one GitHub repository, identified by
  `(owner, repo, branch)`. It is the shared truth all devices converge on. The
  engine reaches it only through the GitHub REST API. Next to it, each device
  may own one **conflict branch** in the same repository (chapter 5), which
  holds the versions that could not be merged automatically.
- **The device's runtime state** — a folder the engine owns,
  `<configDir>/plugins/<plugin-id>/.runtime/`. It records what this device
  last agreed with the Repo, what it has committed but not yet pushed, and
  where an interrupted sync stopped. It is per device and is **never
  synchronized**: the change detector denies the whole `.runtime/` subtree by
  a hardcoded rule, not by a `.gitignore` line a user could remove.

Every merge decision compares three versions of one path:

| Name | Meaning | Where it comes from |
|---|---|---|
| **base** | The last version this device and the Repo agreed on | the per-file baseline (§1.4) |
| **local** | What this device has to say about the path | a committed batch (§1.5), never the live Vault file |
| **remote** | What the Repo says now | the delta between two Repo commits (chapter 4) |

`local` is deliberately not "the file on disk right now". The engine splits
synchronization into two independent processes: the **commit pass** records
local changes into an append-only queue of batches, and the **drain** later
pushes those batches and pulls remote changes. The drain never scans the
Vault for edits; it only sees what a commit recorded. This separation is what
lets the user keep editing during a long drain without the drain reading a
half-saved file, and what lets a commit made offline survive until the next
network window.

## 1.2 Identity of content

Content is identified by its **git blob SHA-1** — the hash git itself computes
over `"blob <size>\0" + bytes`. Using git's own identity, rather than a hash of
our choosing, means a sha recorded locally can be compared directly with the
shas the GitHub API returns, with no translation and no second hash.

Two conventions follow from it:

- **The deletion sentinel.** A deletion is represented by the git null sha,
  `0000000000000000000000000000000000000000` (`DELETED_SHA_HASH`,
  `src/sync2/discovery.ts`). No real content hashes to it, so "deleted" can
  travel through the same fields as a sha without a second channel. In a batch
  entry the same meaning is carried by `sha: null`, the convention the GitHub
  tree API itself uses for deletions.
- **Size before hash.** Where only "did it change?" is asked and a size is
  already at hand, sizes are compared first. A different size *proves* a
  change and saves reading and hashing the file; an equal size proves nothing
  and only invites the hash. This rule is applied wherever it fits — the
  change detector, the crash repair of a batch — and is never inverted: equal
  sizes are never taken as equality.

When the user enables text normalization, text files the user edits are
compared in their canonical form — LF line endings, no byte-order mark, one
trailing newline — not byte-for-byte: two versions that differ only in what
normalization removes are the same content. Files under the configuration
folder are never normalized; Obsidian rewrites them itself. Chapter
3 describes where normalization is applied; here it matters only that a
baseline sha is always the sha of the bytes *as they are in the Repo*.

## 1.3 The sync anchor (hot metadata)

A handful of global values tell the engine where this device stands relative
to the Repo. Losing them means the engine no longer knows what "changed since
last time" means, so they get the most conservative storage in the project.

| Field | Meaning |
|---|---|
| `lastSyncCommitSha` | The Repo commit the last completed drain ended on — the starting point of the next remote delta |
| `lastSyncTreeSha` | The tree of that commit, stored beside it as one pair |
| `lastCommitMtime` | A modification-time watermark for the change detector (see the note below) |
| `remoteIdentity` | `(owner, repo, branch)` the state was built against |
| `conflictBranch` | This device's conflict branch, `{ name, head }`, or `null` |
| `heldPluginUpdates` | Plugin updates held back because this Obsidian cannot load them (chapter 7); `{}` normally |

Implementation: `src/sync2/hot-metadata.ts`.

**Storage: a two-slot ping-pong.** The values live in two files,
`metadata-a.json` and `metadata-b.json`, each carrying a monotonically
increasing integer `seq`. Reading takes the slot with the highest valid `seq`.
Writing goes to the *other* slot — the one with the smaller `seq` — with the
next `seq`. The slot holding the maximum `seq` is never written.

This is why a plain, non-atomic file write is safe here. A write that is torn
by a crash or power loss damages only the slot being replaced; the other slot
still holds the last good state, and the damaged slot reads as invalid and
becomes the next write target, so it heals without a repair path. The target
slot and the next `seq` are derived from the disk on every write, never from
memory, because the disk can change in ways memory cannot see: a torn slot
after a crash, a reset that wiped `.runtime/`, a restored backup.

**One blob, not one file per field.** Every write persists all fields
together. `lastSyncCommitSha` and `lastSyncTreeSha` describe one point in the
Repo's history; a crash between writing one and the other would leave an
anchor that points at two different places. `heldPluginUpdates` lives here for
the same reason: a held update and the per-file baselines it set aside must
change together (chapter 7).

**A counter, not a clock.** `seq` orders writes; a clock can step backwards,
tie within a millisecond, or differ between the moments two slots were
written. The payload carries no timestamp at all, so nothing can mistake one
for the discriminator.

**Leniency per field.** A malformed field reads as its default instead of
disqualifying the slot; only a missing `seq` or unparseable JSON does. A
held-update record missing either its condition or its saved baselines is
dropped whole, because acting on half of it would hold paths whose baselines
are gone.

**The identity check.** At the start of every sync the recorded
`remoteIdentity` is compared with the current settings
(`Sync2Manager.reconcileRemoteIdentity`). A mismatch means the user pointed
the plugin at a different repository or branch, and nothing recorded against
the old one is valid. The progress log, the drain journal and the baselines
are wiped first; then the anchor is reset to the new identity; then the queue
and the conflict records are cleared. Wiping the old state before recording
the new identity makes that part safe to interrupt: until the identity is
recorded, the next sync sees the same mismatch and wipes again. Conflict copies
in the Vault are left untouched, as a reset leaves them. The data cannot make this decision on its own — a different
repository can look exactly like a mass deletion — so only identity can.

> **Note for the owner (open).** In the current code nothing writes
> `lastCommitMtime`; it is always `null`, so the change detector never uses the
> watermark and always falls through to the per-file stat comparison (§1.4).
> `lastSyncTreeSha` is written by the drain's epilogue and read only by that
> same epilogue, to avoid re-fetching the tree when the head did not move; no
> other code reads it. Both are listed in the chapter's review notes.

## 1.4 Per-file baselines (cold metadata)

For every synchronized path the engine records its **baseline**: the blob sha
of the version this device and the Repo last agreed on, together with the
local `(mtime, size)` observed when that agreement was recorded.

```ts
interface FileBaseline {
  baselineSha: string; // the diff3 base
  mtime: number;       // local stat at the time of agreement
  size: number;
}
```

The baseline plays two roles:

1. **It is the base of every three-way decision.** `local == base` means "this
   device did not change the path"; `remote == base` means "nobody else did".
   Without it, two different versions of a file cannot be told apart from an
   edit on one side, and the engine would have to raise a conflict where a
   clean pull or push was correct. Baselines are therefore *not* a cache; they
   cannot be recomputed from either side alone.
2. **Its stat pair is the change detector's short-circuit.** If a file's
   current `(mtime, size)` equals the recorded pair, the file is unchanged and
   is not read. Only a stat mismatch costs a read and a hash.

Implementation: `src/sync2/file-baselines.ts`.

**Storage: hash buckets.** The map is split into 64 buckets,
`.runtime/file-baselines/<id>.json`, where the bucket of a path is FNV-1a
(32-bit) of the path modulo 64. A change to one file rewrites one bucket, not
a map of the whole vault, and a torn write can damage one bucket, not all of
them. Each bucket is written through `atomicWriteFile` (chapter 6). The hash
function and the bucket count together are the on-disk layout: changing
either would move every path of every vault, so both are fixed.

**A small MRU cache.** Six buckets are kept in memory; any access, a read
included, refreshes a bucket's recency, so a bucket that is read often but
never written does not age out. Writes go through to disk immediately.

**Group access is the primary interface.** `getMany`, `setMany` and
`removeMany` group the requested paths by bucket and open each bucket once.
With six buckets in memory, a loop that sets paths one by one across more
buckets than that would evict and re-read on every step; the grouped calls
make "ten paths in three buckets" cost exactly three bucket reads and three
writes. Full scans (`forEachBucket`) read every bucket once and do not insert
what they read into the cache, so a scan does not wipe the working set.

**Who writes baselines.** A baseline records an *agreement* with the Repo, so
it is written only when one has been reached:

- the **drain**, after it has applied a remote version to the Vault, deleted a
  file the Repo deleted, or pushed a local version (the epilogue writes them
  all at once);
- the **progress log** replay (§1.8), for agreements a drain reached before it
  was interrupted;
- the **self-update settle** at start-up, when the bootloader has applied a
  new build of this plugin (chapter 7);
- the **hold lift**, which restores the baselines it set aside (chapter 7).

The commit pass never records a new `baselineSha`. It only refreshes the stat
pair of a file that was touched but whose content still equals its baseline,
and forgets the baselines of paths that have left the synchronized set.

The drain writes a new baseline with `mtime: 0`, because the local mtime of a
file it just wrote is not a fact it controls. The first commit pass after it
sees the stat mismatch, hashes the file once, finds it equal to the baseline
and records the real stat pair. If the baseline sha did not change, the drain
keeps the existing stat pair instead (`keepProvenStats`), so an unchanged file
is not re-hashed.

**Losing a bucket.** A bucket that cannot be parsed reads as empty: its paths
become paths the device has never seen. The next commit pass re-reads and
re-hashes them, and the drain decides each one without a base. Where a path
reaches the three-way decision with different content on both sides and no
base, the rules treat it as created independently on both sides: for an
ordinary file the result is a conflict copy, never a silent overwrite; for a
configuration file the Repo's version wins (chapter 4). The cost of the loss
is extra work and possibly extra conflicts, not lost content.

## 1.5 The commit queue and the sync store

A commit pass produces a **batch**: a directory under `.runtime/push-queue/`
holding one metafile, `meta.json`.

```ts
interface BatchMetafile {
  v: 1;
  id: string;
  createdAt: number;   // the local commit moment
  entries: BatchEntry[];
}
interface BatchEntry {
  path: string;
  sha: string | null;       // null = deletion
  size: number | null;
  mtime: number | null;     // local mtime at commit time
  deletedSha: string | null;// deletion only: the last live bytes, kept for restore
}
```

Implementation: `src/sync2/batch-metafile.ts`, `batch-writer.ts`,
`get-batch.ts`.

The metafile is the batch's only content list, and it carries **no file
content**. The bytes of every version the engine handles live in the **sync
store**, `.runtime/sync_store/<sha>`: one file per blob, named by its git
blob sha (`src/sync2/sync-store.ts`). A batch refers to content by sha.

This design has three consequences that later chapters rely on:

- **A version is stored once**, however many batches, merges or conflict
  records refer to it.
- **Metadata is written before content.** The commit records the metafile
  first and the blobs after it. A crash in between leaves a metafile that
  names blobs not yet present — which the drain can detect and repair from
  the Vault, or discard if the file has changed since (chapter 3) — but never
  an unreferenced blob that a cleanup could reap while a batch still needs it.
- **A file name is a claim, not a proof.** On a mobile device a power loss
  without `fsync` can leave a file with the right name and size and wrong
  bytes. The first read of a blob within a drain hashes it (*hash-on-load*)
  and treats a mismatch exactly like absence: a remote version is downloaded
  again, a local one is repaired from the Vault or skipped for this round.

The store holds two kinds of blob, and the difference is why it is called a
store and not a cache. **Local versions** — committed content, intermediate
merge results — exist nowhere else; losing one makes its commit
uncompletable. **Remote versions** — bases and remote content downloaded from
GitHub — can be fetched again. The cleanup (the *sweep*) keeps every blob that
something still references (a batch, the drain journal, a conflict record, a
pin held by a running commit) and removes the rest; it does not need to know
which kind a blob is.

Commit and drain share the queue without a lock: the commit appends at the
tail and the drain claims from the head, coordinating through two marker files
in each batch directory (`.attempted-commit`, `.attempted`). Chapter 3
describes the protocol.

## 1.6 The drain journal

A drain can span many batches, several pushes and pulls, and — when the
network is unstable — several attempts hours or days apart. Its working state
is persisted so that an interrupted drain resumes where it stopped instead of
starting over.

```ts
interface DrainState {
  trackedFiles: Map<string, TrackedFile>;
  conflicts: Map<string, ConflictEntry>;
  conflictBranchName: string | null;
}
interface TrackedFile {
  base: FileInfo;            // the version the path is being merged against
  remote: FileInfo;          // the current Repo-side version, possibly a merge result
  isManualConflict: boolean;
}
```

Implementation: `src/sync2/drain-journal.ts`.

A **tracked file** carries one path through the whole drain: it starts as the
remote version from the delta, may be replaced by a merge result when a local
batch touches the same path, and at the end is applied to the Vault. Chapter 4
gives the algorithm; here it matters that the journal stores only metadata —
shas, sizes, modes — and never content, which stays in the sync store.

The journal uses the same two-slot ping-pong as the anchor,
`tracked-files-a.json` / `tracked-files-b.json`, and is written once per
**completed batch**, not per file. Its three parts are one blob because they
must be read back consistent with each other. Its presence at the start of a
drain is the signal that the previous drain died mid-way; a drain that
finishes deletes it. Because it names every blob an interrupted drain still
depends on, it is also one of the sources the sweep consults.

The Repo head is deliberately *not* in the journal. It is always read live:
a head remembered from an earlier attempt may be days old.

## 1.7 The conflict ledger

Manual conflicts outlive drains. Their durable record is
`.runtime/conflicts.json` (`src/sync2/conflict-store-v2.ts`):

```ts
{
  lastSiblingTxGuid: string | null,  // the last completed copy-replace transaction
  conflicts: {
    "<path>": {
      conflictBase: FileInfo,   // this device's version, as pushed to the conflict branch
      siblings: FileInfo[],     // the conflict copies in the Vault, in creation order
    }
  }
}
```

The two halves differ in how they can be recovered, and the format reflects
it. `conflictBase` refers to content on the conflict branch and can be
recovered only from the network, so whoever rewrites a record carries it
through unchanged. `siblings` describes files in the Vault and can be
re-derived from the filesystem; it is an ordered list because the newest copy
is the one later merges work with. An empty list is a legal state, distinct
from "no record".

The ledger is written only by the drain. Everything else — the user interface,
the commit pass — reads it together with the disk to answer "is this conflict
still in force?" through one predicate (chapter 5). A ledger that cannot be
parsed reads as empty and the event is logged as a real degradation: the
sibling halves come back from the filesystem, the conflict-branch halves do
not.

## 1.8 Other per-device state

Everything below lives in `.runtime/` unless stated otherwise. **Data files**
there have ordinary names; **marker files** — files whose existence or content
*decides* something — start with a dot and have no extension, wherever they
live. The convention makes a marker recognisable at a glance and, outside
`.runtime/`, hides it from Obsidian's file index.

| File | Purpose | Durability |
|---|---|---|
| `vault-step-progress.jsonl` | **Progress log.** One line per path the current drain has already settled with the Repo, appended *after* the Vault write or the push is confirmed. Replayed into the baselines before the next commit pass, so an interrupted drain does not make its finished work look like new local edits. Deleted by the drain epilogue once it has written the baselines itself. | Append-only lines; a torn last line is ignored |
| `.recheck-paths` | **Ask-again list.** Paths a drain skipped (the Vault write failed, a staged update failed its check). Written *before* the drain moves past the skip, so the anchor can advance without hiding the path; the next drain asks the Repo about each one again. | Append-only lines; removal via temp file and rename |
| `gitignore-seeds.json` | The shas of `.gitignore` content the plugin itself seeded, so the first sync can treat that content as a base instead of as a user edit (chapter 2). | Plain write; loss costs at most one conflict on a first sync |
| `sibling-tx-mark.json` | The in-flight conflict-copy replace transaction (chapter 5). | See chapter 6 |
| `.gitignore-migration-done` | The one-time migration of nested `.gitignore` rules has run (chapter 2). | Marker |
| `.self-update-applied` | What the bootloader applied at start-up, so the baselines can learn it (chapter 7). | Best effort |
| `token_expired` | The last known authentication state, for the UI. In memory the flag is authoritative; the file mirrors it. | Best effort |
| `commit-stats.json` | Timing records from which the commit pass forecasts its own cost (chapter 9). A stale record can only make a progress notice appear or not; it cannot affect data. | Plain write |
| `push-queue/<id>/uploaded-blobs.json` | Blobs of a batch already uploaded to GitHub, so a retried push resumes instead of re-uploading (chapter 4). | Per batch |
| `push-queue-staging/` | Where a new batch directory is born, with its claim marker, before one rename moves it into the queue (chapter 3). | Swept at start-up |
| `deleted.json`, `diff2-autosave/` | State of the conflict editor and the Deleted bin; not part of the engine. | — |
| `../.reset-in-progress`, `../.gitignore-migration-in-progress` | Markers that must survive a reset deleting `.runtime/`, so they live one level up. | — |

## 1.9 Invariants

The engine is designed against seven invariants. Tests are written against
them rather than against the steps of an implementation, and code comments
cite them by number.

- **I1 — No local change is lost silently.** Every change a commit recorded
  eventually reaches the Repo or becomes an explicit conflict.
- **I2 — No remote change is overwritten silently.** When this device and
  another changed the same path from a common base, and the changes cannot be
  merged, the result is a conflict, never an overwrite.
- **I3 — Convergence.** Without new activity, a finite number of syncs brings
  the system to a stable, correct state: the queue empty, conflicts explicit,
  the Repo as expected. A single sync may stop short; the next one finishes
  the work.
- **I4 — A commit is atomic with respect to a drain.** A batch that appears
  while a drain runs is either taken whole by that drain or left whole for the
  next. Never half.
- **I5 — The queue and the baselines are never observably inconsistent.** The
  base each batch is merged against is a real ancestor of the current Repo
  head, and no baseline survives for a path whose agreement was undone.
- **I6 — Nothing spins forever.** Every retry is bounded. When convergence
  cannot be reached now, the drain exits cleanly and leaves its state for the
  next attempt.
- **I7 — Every batch is crash-atomic.** A crash is expected during and after
  every batch. After each one the state on disk is consistent, and a restart
  continues from the queue and the live head. Consequently the drain never
  precomputes the outcome of later batches: each batch is merged against the
  head as it is when that batch's turn comes.

## 1.10 Design decisions

**Why the commit pass and the drain are separate processes.** A single
"scan, merge, push" pass would have to hold the Vault still for the duration
of a network operation that can take minutes on a phone, or read files the
user is editing. Splitting it lets the commit be fast, local and frequent, and
the drain slow, networked and resumable; the queue between them is the only
thing they share. The cost is that a change is visible to the drain only after
a commit has recorded it — which is also what makes I4 enforceable.

**Why content lives in a store addressed by sha, not inside batches.** A
batch that carried copies of its files would duplicate every version on every
re-commit and make a batch the unit of storage as well as the unit of work.
With content addressed by sha, a batch is a few hundred bytes of metadata,
consolidating two batches is a metadata merge, and the same blob serves the
commit, the merge and the conflict record.

**Why hot and cold metadata are stored differently.** The anchor is a few
values that must change together and must never be lost; two whole copies are
cheap and give a crash-proof write without any atomic-rename support from the
platform. Baselines are tens of thousands of small independent records; two
whole copies of them would rewrite the entire map on every sync. Buckets keep
the write proportional to the change and confine damage to one bucket.

**Why mtimes are not trusted for decisions.** Modification times are compared
only as a shortcut ("unchanged since recorded") and, in one deliberately
chosen place, as a tie-breaker between two configuration files (chapter 4).
They are never evidence that content differs: clocks differ between devices,
file copies reset them, and the drain writes files whose mtime it does not
control.
