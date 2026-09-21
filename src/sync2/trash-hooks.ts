// TrashHooks — sync2-owned interface for the Deleted bin's one
// engine-side touchpoint. Defined here in sync2/ (not in src/diff2/) so
// the sync engine builds standalone — `pnpm build` must succeed even
// with src/diff2/ removed (sync-only regression runs, the future
// "sync2 as a separate plugin" option).
//
//   captureForDelete — the Vault-step's remove, just before
//                      adapter.remove (R3.4 pull-delete capture).
//                      The bin parks the file's last LIVE bytes and
//                      records them BEFORE anything irreversible
//                      happens (HISTORY-DELETED §5.2.1).
//
// Best-effort on the caller side: a hook failure never blocks the sync
// — the bin is a safety net, not a hard dependency.
//
// ⚠️ THREE HOOKS DIED WITH THE RE-PLATFORM (2026-09-21), and it is
// worth knowing why rather than wondering where they went:
//   confirmDeleted (R3.5 layer 1a) — the hand-off already releases the
//     record at commit time, so "the deletion was published" no longer
//     needs to be announced.
//   confirmResolved (layer 1b) — sibling records are dropped by the
//     retention prune like any other unsyncable path.
//   sweepOlderThan (layer 2) — became DeletedStore.pruneBefore, called
//     by the manager at the end of a fully successful drain.

export interface TrashHooks {
  captureForDelete(path: string): Promise<void>;
}
