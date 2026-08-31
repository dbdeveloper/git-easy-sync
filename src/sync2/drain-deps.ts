// Production DrainDeps builder (Phase 5.5 step 2c) — composes the real
// engine surfaces into the DrainDeps contract drainOnce was built and
// tested against. NOTHING live calls this yet: the wiring into
// syncAll happens at THE SWITCH (step 4). Until then this module is
// the one place that knows how every seam maps onto production:
//
//   DrainClient        ← GithubClient (+ worker base64) via
//                        makeDrainClient below
//   getGuardedHead     ← MainHeadGuard, the SYNC2 §7.10 monotonic-head
//                        guard ported out of sync2-manager (which dies
//                        at THE SWITCH); guard STATE outlives a drain
//                        (replica lag is a session concern), so the
//                        caller owns the instance
//   baselines          ← FileBaselinesStore group ops (§2.2.1)
//   hot                ← HotMetadataStore (conflictBranch.head is
//                        written as "" — VESTIGIAL, the new drain
//                        always reads the conflict head live per
//                        §II.7; the field dies at THE SWITCH)
//   vaultFiles         ← makeVaultFileReader (step 2b)
//   mergeBlobs         ← makeWorkerMergeBlobs (step 2b)
//   discovery          ← discovery.ts Layer 1 + getCommitInfoForPath
//   claimBatch         ← BatchClaimer (R3b), one instance per build
//   Layer-2 transport  ← getContentsMetadataAtRef with the
//                        sync_store as blobSink (§II.13)
//
// ⚠️ Deliberately NOT decided here (step-4 items, recorded in
// MASTER-PLAN §5.5.0): git author identity + per-batch commit
// messages — commitMessage() is per-drain for now, and no author is
// injected (author.date would change what the mtime invariant's
// committedAt means).

import { type Vault } from "obsidian";
import { NotFoundError, ConflictError } from "../errors";
import type { NewTreeRequestItem } from "../github/client";
import type {
  DrainDeps,
  DrainClient,
  VaultFileReader,
} from "./drain";
import {
  getChangedFilesFromGitHubRepo,
  getCommitInfoForPath,
} from "./discovery";
import { makeWorkerMergeBlobs } from "./diff3";
import { makeVaultFileReader } from "./vault-file-reader";
import BatchClaimer from "./get-batch";
import { collectQueueReferencedShas } from "./queue-sha-index";
import NetworkRetry from "./retry-network";
import SyncStore from "./sync-store";
import DrainJournal from "./drain-journal";
import ConflictStoreV2 from "./conflict-store-v2";
import SiblingTx from "./sibling-tx";
import {
  formatSyncMessage,
  formatConflictMessage,
  formatMergeConflictBranchMessage,
} from "./commit-message";
import type { TrashHooks } from "./trash-hooks";

interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error?(message: string, data?: unknown): void;
}

// ── MainHeadGuard — SYNC2 §7.10, ported verbatim ────────────────────
// Never trust a head read that matches a head we confirmed earlier
// this session and have already superseded — that is a replica-lagged
// read of our own past push. Back off and re-read until the replica
// catches up; past the window, accept a still-behind read as reality
// (append-only assumption). State spans drains: the caller owns one
// instance per session.

const MONOTONIC_HEAD_WINDOW_MS = 10_000;
const MONOTONIC_HEAD_BASE_DELAY_MS = 500;
const MONOTONIC_HEAD_MAX_DELAY_MS = 4_000;

export class MainHeadGuard {
  private recentConfirmedHeads: Array<{ sha: string; at: number }> = [];
  private readonly windowMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: Logger;

  constructor(opts?: {
    windowMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    logger?: Logger;
  }) {
    this.windowMs = opts?.windowMs ?? MONOTONIC_HEAD_WINDOW_MS;
    this.baseDelayMs = opts?.baseDelayMs ?? MONOTONIC_HEAD_BASE_DELAY_MS;
    this.maxDelayMs = opts?.maxDelayMs ?? MONOTONIC_HEAD_MAX_DELAY_MS;
    this.now = opts?.now ?? (() => Date.now());
    this.sleep =
      opts?.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.logger = opts?.logger;
  }

  // Record a head we just CONFIRMED (pushCommitFromTree 200, or the
  // FINALIZE merge's main PATCH — BOTH movers of main feed the guard).
  noteConfirmedHead(sha: string): void {
    const nowMs = this.now();
    this.recentConfirmedHeads.push({ sha, at: nowMs });
    const cutoff = nowMs - this.windowMs;
    this.recentConfirmedHeads = this.recentConfirmedHeads.filter(
      (h) => h.at >= cutoff,
    );
  }

  async guardedRead(read: () => Promise<string>): Promise<string> {
    let delay = this.baseDelayMs;
    let waited = 0;
    for (;;) {
      const got = await read();
      const cutoff = this.now() - this.windowMs;
      this.recentConfirmedHeads = this.recentConfirmedHeads.filter(
        (h) => h.at >= cutoff,
      );
      const idx = this.recentConfirmedHeads.findIndex((h) => h.sha === got);
      const superseded =
        idx >= 0 && idx < this.recentConfirmedHeads.length - 1;
      if (!superseded) return got;
      if (waited >= this.windowMs) {
        this.logger?.warn(
          "monotonic-head: read stuck behind a confirmed head past the window — accepting as real (append-only assumption)",
          { read: got },
        );
        return got;
      }
      this.logger?.info(
        "monotonic-head: read is a SUPERSEDED confirmed head (replica lag) — backoff + re-read",
        { read: got, delayMs: delay },
      );
      await this.sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, this.maxDelayMs);
    }
  }
}

// ── makeDrainClient — GithubClient → DrainClient ────────────────────

// Structural subset of GithubClient the adapter touches — kept
// explicit so unit tests fake exactly this surface and nothing more.
export interface DrainGithubClient {
  getBranchHeadSha(args?: {
    retry?: boolean;
    maxRetries?: number;
  }): Promise<string>;
  getBranchHeadShaByName(args: {
    branch: string;
    retry?: boolean;
  }): Promise<string | null>;
  getCommit(args: {
    sha: string;
    retry?: boolean;
  }): Promise<{ tree: { sha: string } }>;
  createTree(args: {
    tree: { tree: NewTreeRequestItem[]; base_tree?: string };
    retry?: boolean;
  }): Promise<string>;
  createBlob(args: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
  }): Promise<{ sha: string }>;
  createCommit(args: {
    message: string;
    treeSha: string;
    parents?: string[];
    author?: { name: string; email: string; date: string };
    retry?: boolean;
  }): Promise<string>;
  pushCommitFromTree(args: {
    treeSha: string;
    parent: string | null;
    message: string;
    author?: { name: string; email: string; date: string };
  }): Promise<{ sha: string; committedAt: number }>;
  pushCommitToBranch(args: {
    branch: string;
    parent: string | null;
    entries: Array<{ path: string; sha: string | null }>;
    message: string;
    author?: { name: string; email: string; date: string };
  }): Promise<{ sha: string }>;
  getContentsMetadataAtRef(args: {
    path: string;
    ref: string;
    blobSink?: {
      has(sha: string): Promise<boolean>;
      save(sha: string, bytes: ArrayBuffer): Promise<void>;
    };
    retry?: boolean;
  }): Promise<{ sha: string; size: number; blob: ArrayBuffer | null } | null>;
  getBlob(args: {
    sha: string;
    retry?: boolean;
  }): Promise<{ content: string; encoding: string }>;
  updateReference(args: {
    ref: string;
    sha: string;
    retry?: boolean;
  }): Promise<void>;
  deleteReference(args: { ref: string; retry?: boolean }): Promise<void>;
  compare(args: {
    base: string;
    head: string;
    retry?: boolean;
  }): Promise<{
    status: "ahead" | "behind" | "identical" | "diverged";
    files: Array<{
      filename: string;
      status: string;
      sha: string | null;
      previous_filename?: string;
    }>;
  }>;
  getRepoTree(args: { sha: string; retry?: boolean }): Promise<{
    files: Array<{ path: string; sha: string; size: number | null }>;
    truncated: boolean;
  }>;
  listCommitsForPath(args: {
    path: string;
    branch: string;
    perPage?: number;
    retry?: boolean;
  }): Promise<Array<{ sha: string; date: string; message: string }>>;
}

export interface MakeDrainClientDeps {
  client: DrainGithubClient;
  // The configured main branch — updateMainRef needs the name and the
  // adapter deliberately doesn't know settings.
  mainBranch(): string;
  headGuard: MainHeadGuard;
  decodeBase64(b64: string): Promise<ArrayBuffer>;
  // sync_store — the §II.13 blobSink for inline GET-fallback bytes.
  blobSink: {
    has(sha: string): Promise<boolean>;
    save(sha: string, bytes: ArrayBuffer): Promise<void>;
  };
}

export function makeDrainClient(deps: MakeDrainClientDeps): DrainClient {
  const { client, headGuard } = deps;
  return {
    async getGuardedHead() {
      try {
        return await headGuard.guardedRead(() =>
          client.getBranchHeadSha({ retry: true }),
        );
      } catch (err) {
        // Bare repo: 404 (no such ref) or 409 ("Git Repository is
        // empty") — the drain's legal head==null cold-start signal.
        if (err instanceof NotFoundError || err instanceof ConflictError) {
          return null;
        }
        throw err;
      }
    },

    getCommit: (args) => client.getCommit(args),
    createTree: (args) => client.createTree(args),
    createBlob: (args) => client.createBlob(args),

    async pushCommitFromTree(args) {
      const r = await client.pushCommitFromTree(args);
      headGuard.noteConfirmedHead(r.sha); // we MOVED main — feed the guard
      return r;
    },

    async getContentsMetadataAtRef(path, ref) {
      const r = await client.getContentsMetadataAtRef({
        path,
        ref,
        blobSink: deps.blobSink,
        retry: true,
      });
      return r === null ? null : { sha: r.sha, size: r.size };
    },

    async getBlobFromRepo(sha) {
      let blob: { content: string; encoding: string };
      try {
        blob = await client.getBlob({ sha, retry: true });
      } catch (err) {
        if (err instanceof NotFoundError) return null; // GC'd / never existed
        throw err;
      }
      return deps.decodeBase64(blob.content);
    },

    getBranchHeadSha: (branch) =>
      client.getBranchHeadShaByName({ branch, retry: true }),

    pushCommitToBranch: (args) => client.pushCommitToBranch(args),

    getCommitInfoForPath: (path, atSha) =>
      getCommitInfoForPath(client, path, atSha),

    async createMergeCommit({ treeSha, parents, message, author }) {
      const sha = await client.createCommit({
        message,
        treeSha,
        parents: [...parents],
        author,
        retry: true,
      });
      return { sha };
    },

    async updateMainRef(sha) {
      await client.updateReference({
        ref: `heads/${deps.mainBranch()}`,
        sha,
        retry: true,
      });
      headGuard.noteConfirmedHead(sha); // FINALIZE moves main too
    },

    async compareStatus(base, head) {
      try {
        const r = await client.compare({ base, head, retry: true });
        return r.status;
      } catch (err) {
        // GitHub answers 404 for UNRELATED histories (and for a GC'd
        // sha). Either way the base is certainly NOT an ancestor of
        // head — exactly what FINALIZE's idempotence check wants to
        // know (gate finding, G3/G4).
        if (err instanceof NotFoundError) return "diverged";
        throw err;
      }
    },

    async deleteBranch(branch) {
      // deleteReference already treats "ref does not exist" (422 on
      // this endpoint) as success — "already gone" is the drain's
      // idempotent-FINALIZE case.
      await client.deleteReference({ ref: `heads/${branch}`, retry: true });
    },
  };
}

// ── buildDrainDeps — the full production composition ────────────────

export interface BuildDrainDepsArgs {
  vault: Vault;
  selfPluginId: string;
  client: DrainGithubClient;
  mainBranch(): string;
  headGuard: MainHeadGuard;
  worker: {
    computeSha(bytes: ArrayBuffer): Promise<string>;
    decodeBase64(b64: string): Promise<ArrayBuffer>;
    mergeText(
      ours: string,
      base: string,
      theirs: string,
    ): Promise<
      | { kind: "clean"; content: string }
      | { kind: "conflict"; conflictMarkedContent: string }
    >;
  };
  // Long-lived stores — owned by the manager/session, not per drain.
  syncStore: SyncStore;
  journal: DrainJournal;
  conflictStore: ConflictStoreV2;
  siblingTx: SiblingTx;
  hotMeta: {
    getLastSyncCommitSha(): string | null;
    getConflictBranch(): { name: string } | null;
    update(fields: {
      lastSyncCommitSha: string | null;
      lastSyncTreeSha: string | null;
      conflictBranch: { name: string; head: string } | null;
    }): Promise<void>;
  };
  baselines: {
    get(
      path: string,
    ): Promise<
      { baselineSha: string; mtime: number; size: number } | undefined
    >;
    setMany(
      entries: Array<{
        path: string;
        baselineSha: string;
        mtime: number;
        size: number;
      }>,
    ): Promise<void>;
    removeMany(paths: string[]): Promise<void>;
    allPaths(): Promise<string[]>;
    getMany(paths: string[]): Promise<Map<string, { baselineSha: string }>>;
  };
  tokenExpired(): Promise<boolean>;
  isSyncable(path: string): boolean;
  deviceLabel(): string;
  maxAutoMergeFileSize(): number;
  // S1: git identity thunk (settings gitAuthor) — drainOnce stamps
  // main pushes with batch.createdAt, conflict/merge with now().
  gitAuthor?: () => { name: string; email: string } | null;
  // S1: cooperative cancel (manager's abort flag).
  cancelRequested?: () => boolean;
  trashHooks?: TrashHooks | null;
  onProgress?: (processed: number, total: number, path?: string) => void;
  logger?: Logger;
  now?: () => number;
}

export function buildDrainDeps(args: BuildDrainDepsArgs): DrainDeps {
  const now = args.now ?? (() => Date.now());
  const claimer = new BatchClaimer({
    vault: args.vault,
    selfPluginId: args.selfPluginId,
    syncStore: args.syncStore,
    logger: args.logger,
  });
  const computeSha = (bytes: ArrayBuffer): Promise<string> =>
    args.worker.computeSha(bytes);

  return {
    vault: args.vault,
    selfPluginId: args.selfPluginId,
    client: makeDrainClient({
      client: args.client,
      mainBranch: args.mainBranch,
      headGuard: args.headGuard,
      decodeBase64: (b64) => args.worker.decodeBase64(b64),
      blobSink: {
        has: (sha) => args.syncStore.existInSyncStore(sha),
        save: (sha, bytes) => args.syncStore.saveBlobToSyncStore(sha, bytes),
      },
    }),
    syncStore: args.syncStore,
    journal: args.journal,
    // Fresh per build: NetworkRetry scope belongs to the CALLER
    // (per-drain), never module-global — Phase 2 Group A design fact.
    retry: new NetworkRetry({
      vault: args.vault,
      selfPluginId: args.selfPluginId,
    }),
    claimBatch: () => claimer.getBatch(),
    removeBatchDir: (dir) => args.vault.adapter.rmdir(dir, true),
    queueReferencedShas: () =>
      collectQueueReferencedShas(args.vault, args.selfPluginId),
    baselines: {
      get: (p) => args.baselines.get(p),
      setMany: (entries) => args.baselines.setMany(entries),
      removeMany: (paths) => args.baselines.removeMany(paths),
    },
    discoverChangedFiles: (base, head) =>
      getChangedFilesFromGitHubRepo(
        {
          client: {
            compare: (a) => args.client.compare({ ...a, retry: true }),
            getRepoTree: (a) => args.client.getRepoTree({ ...a, retry: true }),
          },
          baselines: args.baselines,
          isSyncable: args.isSyncable,
          logger: args.logger,
        },
        base,
        head,
      ),
    hot: {
      getLastSyncCommitSha: () => args.hotMeta.getLastSyncCommitSha(),
      getConflictBranch: () => {
        const cb = args.hotMeta.getConflictBranch();
        return cb === null ? null : { name: cb.name };
      },
      update: async (f) => {
        await args.hotMeta.update({
          lastSyncCommitSha: f.lastSyncCommitSha,
          lastSyncTreeSha: f.lastSyncTreeSha,
          // `head` is VESTIGIAL: §II.7 — the conflict head is always
          // read live, never persisted. The field exists only because
          // the old engine's schema carries it until THE SWITCH.
          conflictBranch:
            f.conflictBranchName === null
              ? null
              : { name: f.conflictBranchName, head: "" },
        });
      },
    },
    conflictStore: args.conflictStore,
    siblingTx: args.siblingTx,
    tokenExpired: args.tokenExpired,
    trashHooks: args.trashHooks,
    vaultFiles: makeVaultFileReader({
      vault: args.vault,
      computeSha,
      trashHooks: args.trashHooks,
      logger: args.logger,
    }),
    mergeBlobs: makeWorkerMergeBlobs(args.worker),
    computeSha,
    maxAutoMergeFileSize: args.maxAutoMergeFileSize,
    deviceLabel: args.deviceLabel,
    // Per-batch (owner decision, THE SWITCH п.2): drainOnce passes the
    // BATCH's createdAt for main pushes, now() for conflict pushes —
    // formatSyncMessage's uniqueness/greppability contract (§4.4).
    commitMessage: (whenMs) => formatSyncMessage(args.deviceLabel(), whenMs),
    conflictMessage: (whenMs) =>
      formatConflictMessage(args.deviceLabel(), whenMs),
    mergeMessage: (whenMs) =>
      formatMergeConflictBranchMessage(args.deviceLabel(), whenMs),
    gitAuthor: args.gitAuthor,
    cancelRequested: args.cancelRequested,
    now,
    onProgress: args.onProgress,
    logger: args.logger,
  };
}

// Re-exported so the SWITCH commit has one import site for the whole
// production surface.
export type { DrainDeps, DrainClient, VaultFileReader };
