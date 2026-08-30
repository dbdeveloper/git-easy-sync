import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import {
  MAX_INLINE_BYTES,
  TreeAccumulatorClient,
  TreeCommitAccumulator,
  TreeFile,
  UploadedBlobs,
  addFileToTree,
  flushTreeAccumulator,
  inlineOk,
  newTreeAccumulator,
  treeChanged,
} from "../../src/sync2/tree-accumulator";
import { DELETED } from "../../src/sync2/diff3";
import { NewTreeRequestItem } from "../../src/github/client";
import { ValidationError } from "../../src/errors";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII category Q (§II.15) — inline content + round-trip gate, tree
// chaining, uploadedBlobs resume. Q.5 (the createTree-sha canary) is
// the integration half in tests/integration/inline-sha-canary.test.ts.

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

const textFile = (p: string, content: string): TreeFile => ({
  path: p,
  sha: `sha(${content.slice(0, 12)})`,
  blob: enc(content),
  mode: "",
});
const bytesFile = (p: string, bytes: number[]): TreeFile => ({
  path: p,
  sha: `sha(${p})`,
  blob: new Uint8Array(bytes).buffer as ArrayBuffer,
  mode: "",
});
// Like the real drain: f.sha IS the git blob sha of the bytes — the
// uploadedBlobs cache only honours records made for the same content.
const bytesFileReal = async (p: string, bytes: number[]): Promise<TreeFile> => {
  const blob = new Uint8Array(bytes).buffer as ArrayBuffer;
  return { path: p, sha: await calculateGitBlobSHA(blob), blob, mode: "" };
};
const deletedFile = (p: string): TreeFile => ({
  path: p,
  sha: null,
  blob: null,
  mode: DELETED,
});

describe("tree accumulator (§VIII Q)", () => {
  let dir: string;
  let vault: Vault;
  let batchDir: string;
  let treeCalls: Array<{ entries: NewTreeRequestItem[]; baseTree?: string }>;
  let blobCalls: string[]; // base64 payloads
  let treeSeq: number;
  let treeReturns: ((entries: NewTreeRequestItem[]) => string) | null;

  const client: TreeAccumulatorClient = {
    createTree: async ({ tree }) => {
      treeCalls.push({ entries: tree.tree, baseTree: tree.base_tree });
      if (treeReturns) return treeReturns(tree.tree);
      treeSeq += 1;
      return `tree-${treeSeq}`;
    },
    createBlob: async ({ content }) => {
      blobCalls.push(content);
      // Content-addressed like the real API: the returned sha is the
      // git blob sha of the decoded bytes.
      const bytes = Buffer.from(content, "base64");
      return {
        sha: await calculateGitBlobSHA(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        ),
      };
    },
  };

  const loadBlobs = (): Promise<UploadedBlobs> =>
    UploadedBlobs.load(vault as never, batchDir);

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "tree-acc-test-"));
    vault = new Vault(dir);
    batchDir = ".obsidian/plugins/git-easy-sync/.runtime/push-queue/1234";
    treeCalls = [];
    blobCalls = [];
    treeSeq = 0;
    treeReturns = null;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── round-trip gate ──────────────────────────────────────────────

  it("Q.1 🔑: a .csv with valid cp1251 (invalid UTF-8) bytes → inlineOk=false → createBlob carries the bytes VERBATIM", async () => {
    // "Привіт" in cp1251-ish single bytes — none form valid UTF-8.
    const raw = [0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2];
    const f = bytesFile("data.csv", raw);
    expect(inlineOk(f.path, f.blob!)).toBeNull();

    const acc = newTreeAccumulator("parent-tree");
    await addFileToTree(acc, client, await loadBlobs(), f);
    expect(blobCalls).toHaveLength(1);
    // Byte-exactness: the base64 payload decodes to the ORIGINAL
    // bytes — no U+FFFD, no corruption.
    expect([...Buffer.from(blobCalls[0], "base64")]).toEqual(raw);
    // And the tree entry references by sha, not content.
    expect(acc.entries[0].sha).toBeDefined();
    expect(acc.entries[0].content).toBeUndefined();
  });

  it("Q.2: clean UTF-8 .md → inline content in the tree, ZERO createBlob calls", async () => {
    const acc = newTreeAccumulator("parent-tree");
    await addFileToTree(acc, client, await loadBlobs(), textFile("n.md", "привіт\n"));
    expect(blobCalls).toHaveLength(0);
    expect(acc.entries[0]).toEqual({
      path: "n.md",
      mode: "100644",
      type: "blob",
      content: "привіт\n",
    });
  });

  it("Q.3: .png (binary extension) → createBlob, never inline", async () => {
    const acc = newTreeAccumulator("parent-tree");
    await addFileToTree(
      acc,
      client,
      await loadBlobs(),
      bytesFile("img.png", [0x89, 0x50, 0x4e, 0x47]),
    );
    expect(blobCalls).toHaveLength(1);
    expect(acc.entries[0].content).toBeUndefined();
  });

  it("Q.4: BOM / lone-surrogate encoding / stray 0x80 under a text extension — the gate sieves each", () => {
    // BOM: TextDecoder strips it → re-encode is shorter → no round-trip.
    expect(
      inlineOk("bom.md", new Uint8Array([0xef, 0xbb, 0xbf, 0x61]).buffer as ArrayBuffer),
    ).toBeNull();
    // UTF-8-encoded lone surrogate (ED A0 80) is invalid by definition.
    expect(
      inlineOk("sur.md", new Uint8Array([0xed, 0xa0, 0x80]).buffer as ArrayBuffer),
    ).toBeNull();
    // A stray continuation byte.
    expect(
      inlineOk("stray.md", new Uint8Array([0x61, 0x80, 0x62]).buffer as ArrayBuffer),
    ).toBeNull();
    // Control: plain ASCII round-trips.
    expect(inlineOk("ok.md", enc("plain\n"))).toBe("plain\n");
  });

  // ── accumulator + chaining ───────────────────────────────────────

  it("Q.6: a batch under the threshold → exactly ONE createTree", async () => {
    const acc = newTreeAccumulator("parent-tree");
    const blobs = await loadBlobs();
    for (let i = 0; i < 5; i++) {
      await addFileToTree(acc, client, blobs, textFile(`f${i}.md`, `content ${i}\n`));
    }
    await flushTreeAccumulator(acc, client);
    expect(treeCalls).toHaveLength(1);
    expect(treeCalls[0].baseTree).toBe("parent-tree");
    expect(treeCalls[0].entries).toHaveLength(5);
    expect(treeChanged(acc)).toBe(true);
  });

  it("Q.7 + Q.9: crossing the threshold twice → 3 createTree (2 auto flushes + the final), each chained on the previous link", async () => {
    const acc = newTreeAccumulator("parent-tree");
    const blobs = await loadBlobs();
    const big = "x".repeat(Math.ceil(MAX_INLINE_BYTES * 0.6));
    for (let i = 0; i < 5; i++) {
      await addFileToTree(acc, client, blobs, textFile(`big-${i}.md`, big));
    }
    await flushTreeAccumulator(acc, client); // final
    expect(treeCalls).toHaveLength(3);
    expect(treeCalls.map((c) => c.baseTree)).toEqual([
      "parent-tree",
      "tree-1",
      "tree-2",
    ]);
    expect(acc.treeSha).toBe("tree-3");
  });

  it("Q.8 🔑 final-flush regression: the tail below the threshold reaches the commit — the LAST createTree carries it", async () => {
    const acc = newTreeAccumulator("parent-tree");
    const blobs = await loadBlobs();
    const big = "x".repeat(MAX_INLINE_BYTES); // trips the threshold alone
    await addFileToTree(acc, client, blobs, textFile("big.md", big));
    await addFileToTree(acc, client, blobs, textFile("tail.md", "small tail\n"));
    // Without the final flush the tail would silently never become a
    // tree (class I1): at this point only the auto-flush has run.
    expect(treeCalls).toHaveLength(1);
    expect(
      treeCalls[0].entries.some((e) => e.path === "tail.md"),
    ).toBe(false);
    await flushTreeAccumulator(acc, client);
    expect(treeCalls).toHaveLength(2);
    expect(treeCalls[1].entries.map((e) => e.path)).toEqual(["tail.md"]);
  });

  it("Q.10: binaries-only batch → sha references, inlineBytes stays 0, one flush", async () => {
    const acc = newTreeAccumulator("parent-tree");
    const blobs = await loadBlobs();
    for (let i = 0; i < 3; i++) {
      await addFileToTree(acc, client, blobs, bytesFile(`b${i}.png`, [i, 0x80]));
    }
    expect(acc.inlineBytes).toBe(0);
    await flushTreeAccumulator(acc, client);
    expect(treeCalls).toHaveLength(1);
    expect(blobCalls).toHaveLength(3);
  });

  it("Q.11 🔑: the LAST portion is a no-op but earlier ones changed → commit IS made (compare vs the ORIGINAL base, not the previous link)", async () => {
    const acc = newTreeAccumulator("parent-tree");
    const blobs = await loadBlobs();
    const big = "y".repeat(MAX_INLINE_BYTES);
    // Portion 1 really changes things → tree-1.
    treeReturns = () => "tree-1";
    await addFileToTree(acc, client, blobs, textFile("changed.md", big)); // auto-flush
    // Portion 2 is a no-op: GitHub returns the SAME tree sha as its base.
    await addFileToTree(acc, client, blobs, textFile("noop.md", "same as before\n"));
    await flushTreeAccumulator(acc, client);
    expect(acc.treeSha).toBe("tree-1"); // == previous link
    expect(treeChanged(acc)).toBe(true); // ≠ parent-tree → COMMIT
  });

  it("Q.12: no portion changed anything → tree equals the original base → commit skipped (§11 П11)", async () => {
    const acc = newTreeAccumulator("parent-tree");
    treeReturns = () => "parent-tree"; // identical content → same tree
    await addFileToTree(acc, client, await loadBlobs(), textFile("same.md", "no-op\n"));
    await flushTreeAccumulator(acc, client);
    expect(treeChanged(acc)).toBe(false);
  });

  it("empty accumulator: flush is a no-op and treeChanged is false", async () => {
    const acc = newTreeAccumulator("parent-tree");
    await flushTreeAccumulator(acc, client);
    expect(treeCalls).toHaveLength(0);
    expect(treeChanged(acc)).toBe(false);
  });

  // ── uploadedBlobs / resume ───────────────────────────────────────

  it("Q.13: crash at k of n binaries → the retry uploads only n−k; records are PERSISTED per upload, not at batch end", async () => {
    const files = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        bytesFileReal(`pic-${i}.png`, [i, 0x80, 0xff]),
      ),
    );
    // First attempt: the 4th createBlob "crashes".
    let uploads = 0;
    const crashing: TreeAccumulatorClient = {
      ...client,
      createBlob: async (args) => {
        uploads += 1;
        if (uploads === 4) throw new Error("power loss");
        return client.createBlob(args);
      },
    };
    const acc1 = newTreeAccumulator("parent-tree");
    const blobs1 = await loadBlobs();
    await expect(
      (async () => {
        for (const f of files) await addFileToTree(acc1, crashing, blobs1, f);
      })(),
    ).rejects.toThrow("power loss");

    // Second attempt: a FRESH UploadedBlobs instance reads the
    // persisted records — only the 2 unuploaded files hit the network.
    blobCalls = [];
    const acc2 = newTreeAccumulator("parent-tree");
    const blobs2 = await loadBlobs();
    for (const f of files) await addFileToTree(acc2, client, blobs2, f);
    expect(blobCalls).toHaveLength(2);
    expect(acc2.entries).toHaveLength(5); // 3 cached + 2 fresh
  });

  it("a record made for DIFFERENT content (sha mismatch) does not count — the edited file re-uploads", async () => {
    const blobs = await loadBlobs();
    await blobs.record("pic.png", "old-sha");
    const acc = newTreeAccumulator("parent-tree");
    await addFileToTree(acc, client, blobs, bytesFile("pic.png", [1, 0x80]));
    expect(blobCalls).toHaveLength(1); // not served from the stale record
  });

  it("Q.14: stale uploadedBlobs record → createTree 422 → clear() + re-upload + rebuild succeeds (the caller's recovery pattern)", async () => {
    const f = await bytesFileReal("pic.png", [7, 0x80]);
    const blobs = await loadBlobs();
    await blobs.record("pic.png", f.sha!); // valid record… until GC
    let rejected = 0;
    const gcClient: TreeAccumulatorClient = {
      ...client,
      createTree: async (args) => {
        if (rejected === 0) {
          rejected += 1;
          throw new ValidationError("tree references a GC-ed blob");
        }
        return client.createTree(args);
      },
    };

    // Attempt 1: cached sha, tree rejected.
    let acc = newTreeAccumulator("parent-tree");
    await addFileToTree(acc, gcClient, blobs, f);
    expect(blobCalls).toHaveLength(0); // served from cache
    await expect(flushTreeAccumulator(acc, gcClient)).rejects.toThrow(
      ValidationError,
    );

    // Recovery (what the batch loop will do in step 5): clear the
    // batch's cache, rebuild the chain from scratch, re-upload.
    await blobs.clear();
    acc = newTreeAccumulator("parent-tree");
    await addFileToTree(acc, gcClient, blobs, f);
    expect(blobCalls).toHaveLength(1); // re-uploaded
    await flushTreeAccumulator(acc, gcClient);
    expect(treeChanged(acc)).toBe(true);
  });

  it("corrupt uploaded-blobs.json → resume from scratch (re-upload), never a crash", async () => {
    await vault.adapter.write(
      `${batchDir}/uploaded-blobs.json`,
      "{ torn",
    );
    const blobs = await loadBlobs();
    expect(blobs.matches("any.png", "sha")).toBe(false);
  });

  // ── bare repo (Q.15, accumulator half) ──────────────────────────

  it("Q.15: bare repo (no parent tree) → createTree WITHOUT base_tree; a non-empty batch commits", async () => {
    const acc = newTreeAccumulator(null);
    await addFileToTree(acc, client, await loadBlobs(), textFile("first.md", "hello\n"));
    await flushTreeAccumulator(acc, client);
    expect(treeCalls).toHaveLength(1);
    expect(treeCalls[0].baseTree).toBeUndefined();
    expect(treeChanged(acc)).toBe(true);
  });

  it("deletion entry: sha:null, zero requests", async () => {
    const acc = newTreeAccumulator("parent-tree");
    await addFileToTree(acc, client, await loadBlobs(), deletedFile("gone.md"));
    expect(acc.entries[0]).toEqual({
      path: "gone.md",
      mode: "100644",
      type: "blob",
      sha: null,
    });
    expect(blobCalls).toHaveLength(0);
  });

  it("one file above the threshold flushes by itself (bytes counted, not entries)", async () => {
    const acc = newTreeAccumulator("parent-tree");
    await addFileToTree(
      acc,
      client,
      await loadBlobs(),
      textFile("huge.md", "z".repeat(MAX_INLINE_BYTES + 1)),
    );
    expect(treeCalls).toHaveLength(1); // auto-flushed alone
    expect(acc.entries).toHaveLength(0);
  });
});
