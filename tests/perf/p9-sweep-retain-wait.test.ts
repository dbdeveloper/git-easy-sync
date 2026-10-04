import { describe, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import SyncStore, { PIN_OWNER_DELETED_BIN } from "../../src/sync2/sync-store";
import { emit } from "./perf-helpers";

// P9 — sync_store sweep under the per-blob lock (COMMIT-PASS-PERF §6.1).
//
// Two numbers decide whether design B holds up:
//   - the sweep's own duration (the lock is now taken once per
//     unreferenced blob) vs the pre-lock baseline of 4.97 s at 20k;
//   - how long a retain() — what a user's delete awaits through
//     captureForDelete — waits while that sweep runs. Design B promises
//     "at most one unlink"; design A would have been "the whole sweep".
//
// Sizes: 20k is the OWNER'S stated realistic maximum for one sweep (the
// first commit of a large vault, all SHAs distinct — 2026-10-04); 200k
// is the CLAUDE.md 10x check. Each blob is 200 bytes: the cost is per
// FILE (one unlink each), not per byte.
//
// ⚠️ Node fs on the desktop, NOT Capacitor: on mobile every unlink is a
// bridge round-trip, so both numbers scale up there; the RATIO between
// retain's wait and the sweep's length is the point.
//
// Output: PERF_BASELINE {"name":"P9-sweep-<n>", ...}

const PLUGIN_ID = "git-easy-sync";

describe("P9 — sweep vs retain under the per-blob lock", () => {
  for (const n of [20_000, 200_000]) {
    it(`P9-sweep-${n}`, async () => {
      const root = path.join(os.tmpdir(), `p9-sweep-${crypto.randomBytes(4).toString("hex")}`);
      const dir = path.join(root, ".obsidian/plugins", PLUGIN_ID, ".runtime/sync_store");
      fs.mkdirSync(dir, { recursive: true });
      const body = Buffer.alloc(200, 120);
      for (let i = 0; i < n; i++) {
        fs.writeFileSync(path.join(dir, i.toString(16).padStart(40, "0")), body);
      }
      const store = new SyncStore({ vault: new Vault(root) as never, selfPluginId: PLUGIN_ID });

      const t0 = performance.now();
      let done = false;
      const sweep = store.sweep([async () => new Set()]).then((r) => {
        done = true;
        return r;
      });
      // A delete arriving again and again while the sweep runs.
      const waits: number[] = [];
      let k = 0;
      while (!done) {
        const sha = `f${(k++).toString(16).padStart(39, "0")}`;
        const w0 = performance.now();
        await store.retain(PIN_OWNER_DELETED_BIN, sha, async () => body.buffer.slice(0, 200) as ArrayBuffer);
        waits.push(performance.now() - w0);
        store.unpin(PIN_OWNER_DELETED_BIN, sha);
        await new Promise((r) => setTimeout(r, 5));
      }
      const r = await sweep;
      const ms = performance.now() - t0;
      waits.sort((a, b) => a - b);
      const pct = (p: number): number =>
        Number(waits[Math.min(waits.length - 1, Math.floor(waits.length * p))].toFixed(2));
      emit({
        name: `P9-sweep-${n}`,
        ms: Math.round(ms),
        removed: r.removed,
        msPerBlob: Number((ms / n).toFixed(3)),
        retains: waits.length,
        retainWaitP50: pct(0.5),
        retainWaitP99: pct(0.99),
        retainWaitMax: Number(waits[waits.length - 1].toFixed(2)),
      });
      fs.rmSync(root, { recursive: true, force: true });
    }, 30 * 60_000);
  }
});
