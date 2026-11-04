# SYNC2: A REST-Only Synchronization Engine for Obsidian Vaults

> **This reference is being written** (chapter by chapter, against the code). Until a
> chapter is marked written, the engine's behaviour is defined by the code under
> `src/sync2/`, `src/github/` and `src/worker/`.
>
> **Older code comments** refer to sections of the first edition as `SYNC2 §N` or
> `SYNC2.md §N`. That edition is archived at
> [`archive/SYNC2-v1.md`](./archive/SYNC2-v1.md); chapter 10 maps its sections to
> this one.

## Overview

*To be written last, once the chapters are in place: the idea, the constraints
(GitHub REST API only, desktop and mobile alike), the principles, and the
properties the engine guarantees.*

The abstract conflict-resolution model the engine implements is described
separately in [`PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md).

## Chapters

| # | Chapter | Status |
|---|---|---|
| 1 | [Data Model](./sync2/01-data-model.md) | written |
| 2 | [Scope: What Is Synchronized](./sync2/02-scope.md) | not yet written |
| 3 | [The Commit Pass](./sync2/03-commit-pass.md) | not yet written |
| 4 | [The Drain](./sync2/04-drain.md) | not yet written |
| 5 | [Conflicts](./sync2/05-conflicts.md) | not yet written |
| 6 | [Crash Safety and Recovery](./sync2/06-crash-safety.md) | not yet written |
| 7 | [Plugins and Obsidian Versions](./sync2/07-plugins.md) | not yet written |
| 8 | [Platform Contracts and Performance](./sync2/08-platform-performance.md) | not yet written |
| 9 | [What the User Sees](./sync2/09-user-facing.md) | not yet written |
| 10 | [Reference](./sync2/10-reference.md) | not yet written |
