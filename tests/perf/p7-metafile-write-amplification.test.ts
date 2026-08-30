import { describe, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import { emit, timed } from "./perf-helpers";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import HotMetadataStore from "../../src/sync2/hot-metadata";

// P7 — metafile WRITE-AMPLIFICATION after the Phase 1 hot/cold split
// (METAFILE-REFACTOR §4 "вимір — для тюнінгу, не як ворота").
//
// Local, no network. Scale assumption (from the owner, recorded in
// the design docs): the realistic vault ceiling is ~20 000 tracked
// files; a batch caps at 100 files (owner decision). Both are
// deliberate here, not toy sizes.
//
// The "before" is computed from the SAME dataset, not from resurrected
// old code: the deleted monolith wrote JSON.stringify of the ENTIRE
// files map on EVERY save (once per pushed batch) — its per-save byte
// cost is exactly the serialized size of the full 20k map.
//
// Output (grep ^PERF_BASELINE):
//   PERF_BASELINE {"name":"P7-monolith-per-save-bytes", ...}
//   PERF_BASELINE {"name":"P7-single-file-update", ...}
//   PERF_BASELINE {"name":"P7-batch-100-setMany", ...}
//   PERF_BASELINE {"name":"P7-full-scan-forEachBucket", ...}
//   PERF_BASELINE {"name":"P7-hot-anchor-write-bytes", ...}

const N_FILES = 20_000;
const BATCH = 100;
const PLUGIN_ID = "git-easy-sync";

const fakeSha = (i: number): string =>
  crypto.createHash("sha1").update(`blob-${i}`).digest("hex");

describe("P7 — metafile write-amplification (20k entries)", () => {
  it("single update / 100-file batch / full scan vs monolith per-save cost", async () => {
    const root = path.join(
      os.tmpdir(),
      `p7-metafile-${crypto.randomBytes(4).toString("hex")}`,
    );
    fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
    const vault = new Vault(root) as unknown as import("obsidian").Vault;
    try {
      const baselines = new FileBaselinesStore({
        vault,
        selfPluginId: PLUGIN_ID,
      });
      const hot = new HotMetadataStore({ vault, selfPluginId: PLUGIN_ID });
      await hot.load();

      // Seed 20k entries (one grouped write pass — also a datapoint).
      const entries = Array.from({ length: N_FILES }, (_, i) => ({
        path: `dir-${i % 200}/note-${i}.md`,
        baselineSha: fakeSha(i),
        mtime: 1_700_000_000_000 + i,
        size: 1000 + (i % 5000),
      }));
      await timed(
        "P7-seed-20k-setMany",
        { files: N_FILES, bucketWrites: 0 },
        async () => baselines.setMany(entries),
      );
      const seedWrites = baselines.stats.bucketWrites;

      // The monolith's per-save cost: the whole map, serialized, on
      // every batch push.
      const monolithBytes = JSON.stringify({
        files: Object.fromEntries(
          entries.map((e) => [
            e.path,
            { path: e.path, remoteSha: e.baselineSha, mtime: e.mtime, size: e.size },
          ]),
        ),
      }).length;
      emit({ name: "P7-monolith-per-save-bytes", ms: 0, bytes: monolithBytes });

      // New model, case 1: one file changed (the smallest epilogue).
      const bucketsDir = path.join(
        root,
        ".obsidian",
        "plugins",
        PLUGIN_ID,
        ".runtime",
        "file-baselines",
      );
      const bucketBytes = (): number =>
        Math.max(
          ...fs
            .readdirSync(bucketsDir)
            .map((f) => fs.statSync(path.join(bucketsDir, f)).size),
        );
      const w0 = baselines.stats.bucketWrites;
      await timed("P7-single-file-update", { files: 1 }, async () =>
        baselines.set(entries[0].path, {
          baselineSha: fakeSha(999_999),
          mtime: Date.now(),
          size: 42,
        }),
      );
      emit({
        name: "P7-single-file-update-cost",
        ms: 0,
        bucketWrites: baselines.stats.bucketWrites - w0,
        maxBucketBytes: bucketBytes(),
        monolithBytes,
      });

      // Case 2: a full 100-file batch epilogue (grouped setMany).
      const batchEntries = entries.slice(500, 500 + BATCH).map((e) => ({
        ...e,
        baselineSha: fakeSha(e.mtime),
      }));
      const w1 = baselines.stats.bucketWrites;
      await timed("P7-batch-100-setMany", { files: BATCH }, async () =>
        baselines.setMany(batchEntries),
      );
      emit({
        name: "P7-batch-100-cost",
        ms: 0,
        bucketWrites: baselines.stats.bucketWrites - w1,
        monolithBytes,
      });

      // Case 3: the findChanges Pass-2 full scan.
      const r0 = baselines.stats.bucketReads;
      let seen = 0;
      await timed("P7-full-scan-forEachBucket", { files: N_FILES }, async () =>
        baselines.forEachBucket((files) => {
          seen += files.size;
        }),
      );
      emit({
        name: "P7-full-scan-cost",
        ms: 0,
        bucketReads: baselines.stats.bucketReads - r0,
        seen,
      });

      // Hot anchor write (one slot).
      await hot.update({
        lastSyncCommitSha: fakeSha(1),
        lastSyncTreeSha: fakeSha(2),
        lastCommitMtime: Date.now(),
      });
      const hotBytes = fs.statSync(
        path.join(
          root,
          ".obsidian",
          "plugins",
          PLUGIN_ID,
          ".runtime",
          "metadata-a.json",
        ),
      ).size;
      emit({ name: "P7-hot-anchor-write-bytes", ms: 0, bytes: hotBytes });
      emit({ name: "P7-seed-bucket-writes", ms: 0, bucketWrites: seedWrites });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
