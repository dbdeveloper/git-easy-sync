import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  failOnNthMatch,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  type RequestFaultInjector,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// C2 — resume of a crashed push. Mirrors C1 (resume-bootstrap-pull)
// but on the push side: when `createBlob` fails mid-batch (network
// drop, kill, etc.), the SHAs of the binaries that DID make it
// through must persist somewhere durable so the retry can skip them.
// PushQueue stores them in the batch's .meta.json (uploadedBlobs
// map); TreeBuilder consults the map before each createBlob.
//
// Why this matters: GitHub deduplicates blobs by content SHA, so
// repeat uploads don't grow storage — but the bytes ARE re-sent over
// the wire each time. For a multi-megabyte vault on a flaky mobile
// link, that's the difference between "resume in a few seconds" and
// "starts over every time".

interface CountingInjector extends RequestFaultInjector {
  count: number;
}

function countMatches(
  matcher: (url: string, method: string) => boolean,
): CountingInjector {
  const injector: CountingInjector = {
    count: 0,
    intercept(url, method) {
      if (matcher(url, method)) injector.count += 1;
      return null;
    },
  };
  return injector;
}

const isCreateBlob = (url: string, method: string): boolean =>
  method === "POST" && /\/git\/blobs(\?|$)/.test(url);

// Deterministic, non-compressible binary bytes for each path. Keeps
// blob SHAs stable across runs and ensures each path has a unique
// SHA (so the dedup test isn't paper-thin).
function bytesFor(path: string): Buffer {
  const seed = Buffer.from(`seed:${path}`, "utf-8");
  const out = Buffer.alloc(2048);
  for (let i = 0; i < out.length; i++) {
    out[i] = seed[i % seed.length] ^ (i * 131 + 7);
  }
  return out;
}

describe.skipIf(!integrationEnabled())(
  "sync2 resume — push of binary blobs skips already-uploaded ones",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-resume-push");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "kill on the Nth createBlob, then resume → fewer createBlobs on second pass, all files land",
      async () => {
        // Default settings (consolidateCommits=false). The C2
        // semantics — "interrupted commit must finish before any
        // other batch ships" — is achieved by ChangeDetector
        // consulting the push-queue: a file already snapshotted into
        // a pending batch with unchanged content is treated as
        // "committed locally" and not re-emitted into a new batch.
        // So findChanges in the resume run returns [] and only the
        // queued B1 drains, exercising uploadedBlobs as designed.
        client = await createSync2Client({ branch });
        // Prime: first syncAll aligns the local snapshot with the
        // baseline branch (it's still empty user-content-wise). This
        // gets the per-device manifest out of the way so the second
        // syncAll has a clean Case 3 head match.
        await sync2AllAndAssertNoErrors(client);

        // binaries at varying depths. PNG extension to keep
        // `hasTextExtension` returning false → tree-builder routes
        // them through createBlob.
        const paths = [
          "attachments/a.png",
          "attachments/Nested/b.png",
          "Folder/Sub/c.png",
          "A/B/C/D/d.png",
          "root.png",
        ];
        for (const p of paths) {
          await client.vault.adapter.writeBinary(
            p,
            bytesFor(p).buffer.slice(
              bytesFor(p).byteOffset,
              bytesFor(p).byteOffset + bytesFor(p).byteLength,
            ) as ArrayBuffer,
          );
        }

        // First syncAll: fail on the 3rd createBlob. We expect 2 to
        // succeed (their SHAs land in uploadedBlobs), the 3rd to
        // throw, the rest never attempted.
        installRequestFaultInjector(
          failOnNthMatch(
            isCreateBlob,
            3,
            "Simulated network drop mid-push",
          ),
        );
        await expect(client.manager.syncAll()).rejects.toThrow(
          /network drop mid-push/i,
        );

        // The queued batch must still be on disk with uploadedBlobs
        // populated. We inspect via the test client's queue, which
        // shares the same disk state the manager will see on retry.
        const queueIds = await client.queue.list();
        expect(queueIds.length).toBe(1);
        const queuedBatch = await client.queue.read(queueIds[0]);
        const cachedPaths = Object.keys(queuedBatch.uploadedBlobs);
        expect(cachedPaths.length).toBeGreaterThan(0);
        expect(cachedPaths.length).toBeLessThan(paths.length);
        for (const cached of cachedPaths) {
          expect(paths).toContain(cached);
        }

        // Resume: counter measures how many createBlob calls the
        // second pass actually issues. Without uploadedBlobs the
        // count would be N (the full set); with it, the count is
        // strictly less.
        const counter = countMatches(isCreateBlob);
        installRequestFaultInjector(counter);

        await sync2AllAndAssertNoErrors(client);

        // Resume MUST be strictly cheaper than a from-scratch push.
        // Without uploadedBlobs the second pass would call createBlob
        // for every file (== paths.length). With it, createBlob fires
        // only for paths NOT cached after the crash — i.e. the gap.
        expect(counter.count).toBeLessThan(paths.length);
        // Exactly (paths.length - cachedPaths.length): each missing
        // path gets one createBlob; cached paths skip the call
        // entirely. retryUntil could in theory re-issue a transient
        // failure but in a clean run the math is tight.
        const expectedRemaining = paths.length - cachedPaths.length;
        expect(counter.count).toBe(expectedRemaining);

        // Crucially: findChanges in the resume syncAll must NOT have
        // enqueued a second batch — the queue grew to 1 (B1 only)
        // and then drained to 0. Anything else would mean we lost
        // the "interrupted commit completes before others" invariant.
        const finalQueue = await client.queue.list();
        expect(finalQueue).toEqual([]);
        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);
