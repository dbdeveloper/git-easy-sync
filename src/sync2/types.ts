
// A change discovered by ChangeDetector for one file.
// `sha` (COMMIT-PASS-PERF Крок 2): present when the DETECTOR already
// read, canonicalized, hashed and stored the bytes this change commits —
// `size` is then those bytes' length. BatchWriter records such an entry
// without touching the file again. Absent → the writer reads the file
// itself (the old path): a change the detector did not hash, or one
// whose live file still needs the canonical write-back.
export type FileChange =
  | { kind: "added"; path: string; size: number; mtime: number; sha?: string }
  | {
      kind: "modified";
      path: string;
      size: number;
      mtime: number;
      previousRemoteSha: string;
      sha?: string;
    }
  | { kind: "deleted"; path: string; previousRemoteSha: string };

// ⚰️ `FileSnapshot` and `QueueBatch` lived here until 2026-10-02. They
// were the shapes of the OLD snapshot store and the OLD push queue,
// both deleted at THE SWITCH; per-file baselines (file-baselines.ts)
// and the batch metafile (batch-metafile.ts) replaced them. Nothing
// read these types afterwards — not even a test — so they survived
// only as a suggestion that the old storage still exists.
