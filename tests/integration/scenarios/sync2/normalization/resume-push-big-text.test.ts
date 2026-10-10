import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  failOnNthMatch,
  getDefaultBranchHead,
  getRemoteFileSha,
  installRequestFaultInjector,
  integrationEnabled,
  type RequestFaultInjector,
  uniqueBranchName,
} from "../../../helpers";
import { createSync2Client, Sync2TestClient, sync2AllAndAssertNoErrors } from "../helpers";
import { calculateGitBlobSHA } from "../../../../../src/utils";
import { MAX_INLINE_BYTES } from "../../../../../src/sync2/tree-accumulator";
import { normalizeText } from "../../../../../src/sync2/text-normalize";

// Large TEXT files take the upload route (owner, 2026-10-10): a text file
// at or above the tree-flush threshold is uploaded as a utf-8 blob, so the
// per-batch resume cache (uploaded-blobs.json) covers it and a crash does
// not send a 2 MB note again.
//
// The FIRST real proof of the client's utf-8 createBlob path — nothing used
// it before. Content is what the owner's vault holds: Cyrillic, CRLF line
// ends, an emoji. GitHub's returned sha must equal the local git blob sha;
// a mismatch would make resume never match and leave the tree pointing at
// bytes the baseline cannot match (the code falls back to base64 then, and
// this test would see the extra base64 upload).

interface CountingInjector extends RequestFaultInjector {
  count: number;
}

const isCreateBlob = (url: string, method: string): boolean =>
  method === "POST" && /\/git\/blobs(\?|$)/.test(url);

function countBlobs(): CountingInjector {
  const injector: CountingInjector = {
    count: 0,
    intercept(url, method) {
      if (isCreateBlob(url, method)) injector.count += 1;
      return null;
    },
  };
  return injector;
}

function bigNote(title: string): string {
  const line = `${title} — Ладософія, ч. ${title.length}: світ, що пам'ятає 🌍\r\n`;
  // Margin large enough to stay above the threshold even after CRLF → LF.
  return line.repeat(Math.ceil((MAX_INLINE_BYTES * 1.1) / Buffer.byteLength(line)));
}

describe.skipIf(!integrationEnabled())(
  "sync2 resume — push of LARGE text skips already-uploaded notes",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-resume-big-text");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    // "Auto-canonicalize text files" is the USER's setting (default off):
    // both states. With it on, the bytes pushed — and so the sha GitHub
    // must return — are the canonical (LF) ones.
    it.each([{ canonicalize: false }, { canonicalize: true }])(
      "kill on the 2nd big-text upload, resume → the 1st is not sent again; GitHub's shas equal ours (canonicalize=$canonicalize)",
      async ({ canonicalize }) => {
        client = await createSync2Client({ branch, autoCanonicalize: canonicalize });
        await sync2AllAndAssertNoErrors(client);

        const notes: Record<string, string> = {
          "Ладософія/ч.1.md": bigNote("Перша"),
          "Ладософія/ч.2.md": bigNote("Друга"),
          "Ладософія/ч.3.md": bigNote("Третя"),
        };
        const localSha: Record<string, string> = {};
        for (const [p, text] of Object.entries(notes)) {
          await client.vault.adapter.write(p, text);
          const pushed = canonicalize ? normalizeText(text).content : text;
          expect(Buffer.byteLength(pushed)).toBeGreaterThanOrEqual(MAX_INLINE_BYTES);
          const bytes = Buffer.from(pushed, "utf8");
          localSha[p] = await calculateGitBlobSHA(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          );
        }

        installRequestFaultInjector(
          failOnNthMatch(isCreateBlob, 2, "Simulated network drop mid-push"),
        );
        await expect(client.manager.syncAll()).rejects.toThrow(/network drop mid-push/i);

        const queueIds = await client.queue.list();
        expect(queueIds.length).toBe(1);
        const cached = JSON.parse(
          fs.readFileSync(
            path.join(
              client.vaultPath,
              ".obsidian",
              "plugins",
              "git-easy-sync",
              ".runtime",
              "push-queue",
              queueIds[0],
              "uploaded-blobs.json",
            ),
            "utf8",
          ),
        ) as Record<string, string>;
        const cachedPaths = Object.keys(cached);
        // Exactly one recorded: the 1st upload succeeded and MATCHED. (Had
        // GitHub's utf-8 sha differed, the 2nd createBlob — the one that
        // drops — would have been the 1st note's base64 retry, and nothing
        // would be recorded.)
        expect(cachedPaths).toHaveLength(1);
        // GitHub's sha for the utf-8 upload IS our git blob sha.
        expect(cached[cachedPaths[0]]).toBe(localSha[cachedPaths[0]]);

        const counter = countBlobs();
        installRequestFaultInjector(counter);
        await sync2AllAndAssertNoErrors(client);

        // Only the two not uploaded before the drop — and ONE upload each:
        // a utf-8 sha mismatch would add a base64 re-upload per file.
        expect(counter.count).toBe(2);
        for (const p of Object.keys(notes)) {
          expect(await getRemoteFileSha(branch, p)).toBe(localSha[p]);
        }
        expect(await client.queue.list()).toEqual([]);
      },
      210_000,
    );
  },
);
