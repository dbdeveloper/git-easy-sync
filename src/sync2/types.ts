
// A change discovered by ChangeDetector for one file.
export type FileChange =
  | { kind: "added"; path: string; size: number; mtime: number }
  | {
      kind: "modified";
      path: string;
      size: number;
      mtime: number;
      previousRemoteSha: string;
    }
  | { kind: "deleted"; path: string; previousRemoteSha: string };

// ⚰️ `FileSnapshot` and `QueueBatch` lived here until 2026-10-02. They
// were the shapes of the OLD snapshot store and the OLD push queue,
// both deleted at THE SWITCH; per-file baselines (file-baselines.ts)
// and the batch metafile (batch-metafile.ts) replaced them. Nothing
// read these types afterwards — not even a test — so they survived
// only as a suggestion that the old storage still exists.
