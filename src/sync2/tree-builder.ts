// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { arrayBufferToBase64, Vault } from "obsidian";
import { NewTreeRequestItem } from "../github/client";
import { hasTextExtension } from "../utils";
import PushQueue from "./push-queue";
import { QueueBatch } from "./types";

// Minimal client surface TreeBuilder needs. Lets tests inject a stub
// without dragging the full GithubClient (which carries settings,
// retries, etc. that are irrelevant here).
export interface TreeBuilderClient {
  createBlob(args: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
  }): Promise<{ sha: string }>;
}

const VAULT_SUBDIR = "vault";
const QUEUE_DIRNAME = ".runtime/push-queue";

export interface TreeBuilderDeps {
  vault: Vault;
  queue: PushQueue;
  client: TreeBuilderClient;
  configDir: string;
  selfPluginId: string;
}

export default class TreeBuilder {
  private readonly vault: Vault;
  private readonly queue: PushQueue;
  private readonly client: TreeBuilderClient;
  private readonly queueRoot: string;

  constructor(deps: TreeBuilderDeps) {
    this.vault = deps.vault;
    this.queue = deps.queue;
    this.client = deps.client;
    this.queueRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/${QUEUE_DIRNAME}`;
  }

  // Turn a queued batch into the tree[] array for createTree, plus the
  // base_tree SHA the caller should pair with it. Caller is expected
  // to feed the result straight into client.createTree({ tree: entries,
  // base_tree }) and then build a commit on top.
  //
  // Files come from the batch's vault/ subdirectory, NOT from the live
  // vault — the batch represents the user's intent at enqueue time and
  // must not be re-read against current disk state.
  //
  // `hooks.onFileProcessed(done, total)` is an optional progress
  // callback. It fires PRE-OP — once just before each file's blob work
  // begins — so a UI counter shows the file currently shipping and
  // holds for exactly that file's upload. Text files count too: the
  // user thinks in terms of total files shipping to GitHub, not "blob
  // round-trips". Skipped when the batch is delete-only (no files to
  // upload). SYNC2 §4.5.
  async buildTreeEntries(
    batchId: string,
    hooks?: {
      onFileProcessed?: (processed: number, total: number) => void;
    },
  ): Promise<{ entries: NewTreeRequestItem[]; baseTreeSha: string | null; batch: QueueBatch }> {
    const batch = await this.queue.read(batchId);
    const batchVaultDir = `${this.queueRoot}/${batchId}/${VAULT_SUBDIR}`;

    // Group by handling: text files inline content; binary files need
    // a createBlob round-trip first; deletions just set sha: null.
    const textFiles: string[] = [];
    const binaryFiles: string[] = [];
    for (const path of batch.files) {
      if (hasTextExtension(path)) textFiles.push(path);
      else binaryFiles.push(path);
    }

    const entries: NewTreeRequestItem[] = [];
    const totalFiles = textFiles.length + binaryFiles.length;
    let processed = 0;
    const tickProgress = (): void => {
      // Pre-op: advance BEFORE the file's work so a UI counter shows
      // the file currently shipping and holds for exactly that file's
      // upload. SYNC2 §4.5.
      processed += 1;
      hooks?.onFileProcessed?.(processed, totalFiles);
    };

    // Text files: read once, inline as `content`. GitHub stores it as
    // the blob; we never touch createBlob for these.
    for (const path of textFiles) {
      tickProgress();
      const content = await this.vault.adapter.read(
        `${batchVaultDir}/${path}`,
      );
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        content,
      });
    }

    // Binary files: one blob at a time — SEQUENTIAL, not parallel.
    // Peak memory is a single file's bytes (read + base64), not all N
    // resident at once; and to a single host over a bounded uplink,
    // parallel large-blob uploads are bandwidth-bound anyway (they
    // share the pipe — no throughput win). Resume bookkeeping:
    // `batch.uploadedBlobs` holds path→SHA pairs from prior crashed
    // attempts; a cache hit skips the whole createBlob round-trip.
    // Each fresh blob SHA is persisted via `recordBlobUpload`
    // immediately after upload, so a mid-batch crash at file k leaves
    // 1..k-1 recorded — the next drain's pass hits those in cache and
    // resumes at k. Being sequential, there is no concurrent
    // recordBlobUpload, so the old `allSettled` + metaWriteQueue race
    // is gone by construction. SYNC2 §4.5.
    for (const path of binaryFiles) {
      tickProgress();
      const cachedSha = batch.uploadedBlobs[path];
      if (typeof cachedSha === "string") {
        entries.push({
          path,
          mode: "100644",
          type: "blob",
          sha: cachedSha,
        });
        continue;
      }
      const buf = await this.vault.adapter.readBinary(
        `${batchVaultDir}/${path}`,
      );
      const blob = await this.client.createBlob({
        content: arrayBufferToBase64(buf),
        encoding: "base64",
        retry: true,
      });
      await this.queue.recordBlobUpload(batchId, path, blob.sha);
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    // Deletions: per GitHub's tree API, omit content+sha and explicitly
    // set sha to null. The server interprets this as "remove this path
    // from the tree".
    for (const path of batch.deletions) {
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    return {
      entries,
      baseTreeSha: batch.parentTreeSha,
      batch,
    };
  }
}
