import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  getRemoteFileSha,
  installRequestFaultInjector,
  integrationEnabled,
  type RequestFaultInjector,
  uniqueBranchName,
} from "../../../helpers";
import { createSync2Client, Sync2TestClient, sync2AllAndAssertNoErrors } from "../helpers";
import { calculateGitBlobSHA } from "../../../../../src/utils";
import { MAX_SYNC_FILE_BYTES } from "../../../../../src/sync2/change-detector";
import { CancelSignal } from "../../../../../src/cancel-signal";
import { BlobTooLargeError } from "../../../../../src/errors";

// Big files against REAL GitHub (owner, 2026-10-11). The unit suites pin
// the logic; these pin it against the server it was measured on:
//   - GitHub's REST blob ceiling is 40 MiB (measured: 39.96 MiB → 201,
//     40 MiB → 422 "input was too large"), not the documented 100 MB, so
//     MAX_SYNC_FILE_BYTES = 40 000 000. A file just under it must sync; one
//     just over must stay out of the commit while the rest syncs.
//   - "Cancel sync" must stop an upload IN FLIGHT (production HTTP path:
//     WorkerClient + CancelSignal), and the next sync must finish the job.
//   - GitHub's 422 "too large" is final: one attempt, the entry is skipped,
//     the rest of the batch is pushed.
// Each run uploads ~40-60 MB per test; the branch is deleted afterwards,
// and blobs no commit references are GitHub's to collect.

const isCreateBlob = (url: string, method: string): boolean =>
  method === "POST" && /\/git\/blobs(\?|$)/.test(url);

async function gitSha(bytes: Buffer): Promise<string> {
  return calculateGitBlobSHA(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function writeBytes(c: Sync2TestClient, rel: string, bytes: Buffer): void {
  const abs = path.join(c.vaultPath, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function writeSparse(c: Sync2TestClient, rel: string, size: number): void {
  const abs = path.join(c.vaultPath, rel);
  fs.closeSync(fs.openSync(abs, "w"));
  fs.truncateSync(abs, size);
}

describe.skipIf(!integrationEnabled())("sync2 — big files against real GitHub", () => {
  let client: Sync2TestClient | undefined;
  let branch: string;

  beforeAll(async () => {
    await ensureRepoNotBare();
  });

  beforeEach(async () => {
    branch = uniqueBranchName("sync2-big-files");
    const head = await getDefaultBranchHead();
    if (!head) throw new Error("default branch missing");
    await createBranchFromHead(branch, head);
  });

  afterEach(async () => {
    installRequestFaultInjector(null);
    client?.cleanup();
    client = undefined;
    await deleteBranchIfExists(branch);
  });

  it(
    "just under the limit syncs end-to-end (GitHub accepts it); just over stays out; the rest syncs",
    async () => {
      client = await createSync2Client({ branch, autoCanonicalize: false });
      await sync2AllAndAssertNoErrors(client);

      const under = crypto.randomBytes(MAX_SYNC_FILE_BYTES - 1000);
      writeBytes(client, "under-limit.bin", under);
      writeSparse(client, "over-limit.bin", MAX_SYNC_FILE_BYTES + 1);
      await client.vault.adapter.write("note.md", "beside the big files\n");

      await sync2AllAndAssertNoErrors(client);

      expect(await getRemoteFileSha(branch, "under-limit.bin")).toBe(await gitSha(under));
      expect(await getRemoteFileSha(branch, "over-limit.bin")).toBeNull();
      expect(await getRemoteFileSha(branch, "note.md")).not.toBeNull();
      expect(await client.queue.list()).toEqual([]);
    },
    300_000,
  );

  it(
    "Cancel stops an upload IN FLIGHT within seconds; nothing reaches the server; the next sync finishes",
    async () => {
      const signal = new CancelSignal();
      client = await createSync2Client({ branch, autoCanonicalize: false, cancelSignal: signal });
      await sync2AllAndAssertNoErrors(client);

      const big = crypto.randomBytes(30 * 1024 * 1024);
      writeBytes(client, "cancel-me.bin", big);

      // The production path uses fetch (not the mock requestUrl): watch it
      // to know when the blob upload has started.
      const origFetch = globalThis.fetch;
      let uploadStarted!: () => void;
      const started = new Promise<void>((r) => (uploadStarted = r));
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (isCreateBlob(url, init?.method ?? "GET")) uploadStarted();
        return origFetch(input, init);
      }) as typeof fetch;
      try {
        const run = client.manager.syncAll().catch((e) => e);
        await started;
        await new Promise((r) => setTimeout(r, 1500)); // well inside the upload
        const t0 = Date.now();
        client.manager.cancelDrain();
        await run;
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(client.manager.wasLastDrainCancelled()).toBe(true);
        expect(await getRemoteFileSha(branch, "cancel-me.bin")).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }

      await sync2AllAndAssertNoErrors(client);
      expect(await getRemoteFileSha(branch, "cancel-me.bin")).toBe(await gitSha(big));
    },
    300_000,
  );

  it(
    "a queued entry over the limit never reaches GitHub (0 uploads) — the rest of its batch is pushed",
    async () => {
      client = await createSync2Client({ branch, autoCanonicalize: false });
      await sync2AllAndAssertNoErrors(client);

      // Queued past the commit-side gate, as an older build would leave it.
      const tooBig = crypto.randomBytes(41 * 1024 * 1024);
      writeBytes(client, "too-big.bin", tooBig);
      await client.vault.adapter.write("note.md", "ships anyway\n");
      const mtime = Date.now();
      await client.batchWriter.writeBatch([
        { kind: "added", path: "too-big.bin", size: tooBig.length, mtime },
        { kind: "added", path: "note.md", size: 13, mtime },
      ]);

      let blobPosts = 0;
      const counter: RequestFaultInjector = {
        intercept(url, method) {
          if (isCreateBlob(url, method)) blobPosts++;
          return null;
        },
      };
      installRequestFaultInjector(counter);
      await client.manager.resumeQueue();

      expect(blobPosts).toBe(0); // the drain's own size gate: not even tried
      expect(await getRemoteFileSha(branch, "note.md")).not.toBeNull();
      expect(await getRemoteFileSha(branch, "too-big.bin")).toBeNull();
      expect(await client.queue.list()).toEqual([]);
    },
    300_000,
  );

  // The drain's gate keeps such files from GitHub, so the 422 itself is
  // reached only if GitHub ever lowers its ceiling below ours — pinned here
  // at the client, against the real server: ONE attempt, BlobTooLargeError
  // (a ValidationError would make the drain restart the batch and loop).
  it(
    "real GitHub answers a 41 MiB blob with 422 'too large': the client tries ONCE and throws BlobTooLargeError",
    async () => {
      client = await createSync2Client({ branch, autoCanonicalize: false });
      let blobPosts = 0;
      installRequestFaultInjector({
        intercept(url, method) {
          if (isCreateBlob(url, method)) blobPosts++;
          return null;
        },
      });
      const content = crypto.randomBytes(41 * 1024 * 1024).toString("base64");
      const err = await client.client.createBlob({ content, retry: true }).catch((e) => e);
      expect(err).toBeInstanceOf(BlobTooLargeError);
      expect(blobPosts).toBe(1);
    },
    300_000,
  );
});
