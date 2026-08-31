// Tree accumulator — the MAIN-branch push side of the new drain
// (NEW-DRAIN §II.15, Phase 4 step 2). Turns a batch's resolved
// FileInfos into ONE commit through a CHAIN of createTree calls:
// inline `content` for provably-text files (GitHub makes the blob
// itself — the difference between ~2 requests per batch and 20 002
// requests on a 20k cold start against a 5000/hour limit),
// `createBlob`+base64 for everything else, `base_tree` chaining so
// "free the memory" and "make the commit" stay independent actions.
//
// 🔒 Scope boundary (§II.15): MAIN pushes only. The conflict branch
// (STEP1/STEP2, Phase 5) keeps its plain blob-list path — units of
// files, no rate-limit pressure.
//
// The inline gate is a PROOF, not a guess: hasTextExtension is the
// cheap sieve, utf8RoundTrip the proof. For an inline entry GitHub
// assigns the sha server-side and we never re-read it — we compute it
// locally from encode(decode(bytes)), which equals the true bytes
// ONLY for valid UTF-8. Gating on extension alone is the live
// engine's silent-corruption bug (cp1251 .csv → U+FFFD on the server
// + a baseline the disk can never match → eternal churn); failing the
// gate demotes the file to createBlob, which carries bytes verbatim.
//
// uploadedBlobs — resume-at-k for binaries: every createBlob success
// is persisted IMMEDIATELY (a crash at picture 317 of 500 resumes at
// 318, not 1). Lives in its own DATA file `uploaded-blobs.json`
// inside the batch dir — deliberately NOT a field of meta.json: the
// claimer's crash repair rewrites meta.json keeping only its OWN
// fields (get-batch.ts), so a meta.json field would be silently
// stripped on repair; a sibling file survives untouched and dies with
// the dir's rmdir. A record can go STALE (GitHub GC'd the unreachable
// blob → 422 on createTree) — the caller's recovery is clear() +
// re-upload, never a per-file "does the server have this sha" query
// (asking costs exactly the round-trips this module exists to avoid).

import { arrayBufferToBase64, normalizePath, type Vault } from "obsidian";
import { NewTreeRequestItem } from "../github/client";
import { hasTextExtension } from "../utils";
import { utf8RoundTrip } from "./text-normalize";
import { DELETED } from "./diff3";

// Flush threshold — counts BYTES of accumulated inline content, not
// entries (one 5 MB file must flush by itself). A typical 100-file
// batch (~400 KB) never trips it; the threshold is a guard against
// pathology, not a daily mode.
export const MAX_INLINE_BYTES = 1_000_000;

export const UPLOADED_BLOBS_FILE = "uploaded-blobs.json";

export interface TreeAccumulatorClient {
  createTree(args: {
    tree: { tree: NewTreeRequestItem[]; base_tree?: string };
    retry?: boolean;
  }): Promise<string>;
  createBlob(args: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
  }): Promise<{ sha: string }>;
}

// One file as the accumulator needs it — the relevant slice of
// _diff3's FileInfo. `blob` is required for non-deleted entries.
export interface TreeFile {
  path: string;
  sha: string | null;
  blob: ArrayBuffer | null;
  mode: "" | typeof DELETED | null;
}

export function inlineOk(path: string, bytes: ArrayBuffer): string | null {
  if (!hasTextExtension(path)) return null;
  return utf8RoundTrip(bytes);
}

// Per-batch persisted resume cache. Keyed by path; a record counts
// only when it was made for the SAME content (sha match) — an edit
// between attempts re-uploads.
export class UploadedBlobs {
  private constructor(
    private readonly vault: Vault,
    private readonly filePath: string,
    private map: Record<string, string>,
  ) {}

  static async load(vault: Vault, batchDir: string): Promise<UploadedBlobs> {
    const filePath = normalizePath(`${batchDir}/${UPLOADED_BLOBS_FILE}`);
    let map: Record<string, string> = {};
    if (await vault.adapter.exists(filePath)) {
      try {
        const parsed = JSON.parse(
          await vault.adapter.read(filePath),
        ) as Record<string, unknown>;
        for (const [p, sha] of Object.entries(parsed)) {
          if (typeof sha === "string") map[p] = sha;
        }
      } catch {
        // Torn write — resume from scratch; re-uploading is always
        // correct, just slower.
        map = {};
      }
    }
    return new UploadedBlobs(vault, filePath, map);
  }

  matches(path: string, sha: string): boolean {
    return this.map[path] === sha;
  }

  get(path: string): string | undefined {
    return this.map[path];
  }

  // Persist IMMEDIATELY — this is what makes resume-at-k real; a
  // record deferred to batch end would vanish with the crash it
  // exists to survive.
  async record(path: string, sha: string): Promise<void> {
    this.map[path] = sha;
    await this.vault.adapter.write(this.filePath, JSON.stringify(this.map));
  }

  // 422-on-createTree recovery: GitHub GC'd a blob a stale record
  // still points at — drop the whole batch's cache and re-upload.
  async clear(): Promise<void> {
    this.map = {};
    if (await this.vault.adapter.exists(this.filePath)) {
      await this.vault.adapter.remove(this.filePath);
    }
  }
}

// One commit-in-progress. `baseTreeSha` is the IMMUTABLE tree of the
// parent commit (null on a bare repo) — the empty-commit check
// compares the final chain link against IT, never against the
// previous link (a batch whose LAST portion is a no-op but earlier
// portions were not would falsely read as empty and vanish — Q.11).
export interface TreeCommitAccumulator {
  entries: NewTreeRequestItem[];
  inlineBytes: number;
  treeSha: string | null;
  readonly baseTreeSha: string | null;
}

export function newTreeAccumulator(
  parentTreeSha: string | null,
): TreeCommitAccumulator {
  return {
    entries: [],
    inlineBytes: 0,
    treeSha: parentTreeSha,
    baseTreeSha: parentTreeSha,
  };
}

// §II.15 buildTreeEntry + threshold flush. Deletion → sha:null tree
// entry (0 requests). Provable text → inline content (0 requests).
// Cached upload for the SAME content → sha reference (0 requests).
// Otherwise createBlob (base64, bytes verbatim) + record IMMEDIATELY.
export async function addFileToTree(
  acc: TreeCommitAccumulator,
  client: TreeAccumulatorClient,
  uploadedBlobs: UploadedBlobs,
  f: TreeFile,
): Promise<void> {
  if (f.mode === DELETED) {
    // ⚠️ NO BASE TREE ⇒ NO DELETION (gate audit 2026-08-31). A
    // deletion entry only makes sense against a tree that could
    // contain the path. With acc.treeSha === null (bare repo whose
    // seed was skipped — a deletion-only batch) GitHub answers 409
    // "Git Repository is empty" for createTree, and even on a
    // non-bare repo a deletion for a path the base tree lacks is the
    // documented 422 GitRPC::BadObjectState. Dropping it here is not
    // a loss: the remote genuinely does not have the file, which is
    // exactly the state the deletion asked for, and the epilogue
    // removes the path from the baselines either way.
    if (acc.treeSha === null) return;
    acc.entries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
    return;
  }
  if (f.blob === null || f.sha === null) {
    throw new Error(
      `tree-accumulator: non-deleted ${f.path} arrived without blob/sha — caller bug`,
    );
  }
  const inlineText = inlineOk(f.path, f.blob);
  if (inlineText !== null) {
    acc.entries.push({
      path: f.path,
      mode: "100644",
      type: "blob",
      content: inlineText,
    });
    acc.inlineBytes += f.blob.byteLength;
    if (acc.inlineBytes >= MAX_INLINE_BYTES) {
      await flushTreeAccumulator(acc, client);
    }
    return;
  }
  if (uploadedBlobs.matches(f.path, f.sha)) {
    acc.entries.push({
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: uploadedBlobs.get(f.path)!,
    });
    return;
  }
  const blob = await client.createBlob({
    content: arrayBufferToBase64(f.blob),
    encoding: "base64",
    retry: true,
  });
  await uploadedBlobs.record(f.path, blob.sha);
  acc.entries.push({
    path: f.path,
    mode: "100644",
    type: "blob",
    sha: blob.sha,
  });
}

// Chain link: the accumulated portion lands on top of the CURRENT
// treeSha; the first flush builds on the parent commit's tree (or on
// nothing at all for a bare repo — Q.15). createTree is atomic: a
// network failure mid-flush leaves no partial tree, only an
// unreachable one GitHub's GC reaps (same class as orphan trees after
// a 422 restart, when the whole chain built against a stale parent is
// DISCARDED and rebuilt — blobs survive via uploadedBlobs).
export async function flushTreeAccumulator(
  acc: TreeCommitAccumulator,
  client: TreeAccumulatorClient,
): Promise<void> {
  if (acc.entries.length === 0) return;
  const treeSha = await client.createTree({
    tree: {
      tree: acc.entries,
      ...(acc.treeSha !== null ? { base_tree: acc.treeSha } : {}),
    },
    retry: true,
  });
  acc.treeSha = treeSha;
  acc.entries = [];
  acc.inlineBytes = 0;
}

// §11 П11 in chained form: commit iff the FINAL tree differs from the
// ORIGINAL parent tree. Call after the final flush — and the final
// flush itself is load-bearing (Q.8): without it the batch tail that
// never reached the threshold silently never becomes a tree (class I1).
export function treeChanged(acc: TreeCommitAccumulator): boolean {
  return acc.treeSha !== acc.baseTreeSha;
}
