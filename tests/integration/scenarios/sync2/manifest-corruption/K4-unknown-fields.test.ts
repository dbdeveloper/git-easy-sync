import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  countBranchCommits,
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// K4 — forward-compat: unknown keys in the hot slot AND unknown keys
// inside baseline-bucket entries must be silently dropped. Both
// stores read only the fields they know about, so older builds keep
// working when a newer build wrote extra state.

const RUNTIME_REL = ".obsidian/plugins/git-easy-sync/.runtime";

// Read the CURRENT (max valid seq) hot slot: [absPath, parsedJson].
function readMaxHotSlot(vaultPath: string): [string, Record<string, unknown>] {
  let best: [string, Record<string, unknown>] | null = null;
  for (const slot of ["a", "b"]) {
    const abs = path.join(vaultPath, RUNTIME_REL, `metadata-${slot}.json`);
    if (!fs.existsSync(abs)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
      if (typeof raw.seq !== "number") continue;
      if (best === null || raw.seq > (best[1].seq as number)) best = [abs, raw];
    } catch {
      continue;
    }
  }
  if (best === null) throw new Error("no valid hot slot on disk");
  return best;
}


describe.skipIf(!integrationEnabled())(
  "sync2 K4 — unknown manifest fields (forward-compat)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-k4-unknown-fields");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "unknown top-level + per-file fields → ignored; known fields preserved; sync works",
      async () => {
        const first = await createSync2Client({
          branch,
          ownsVaultPath: false,
        });
        const vaultPath = first.vaultPath;
        client = {
          ...first,
          cleanup: () => {
            try {
              fs.rmSync(vaultPath, { recursive: true, force: true });
            } catch {}
          },
        };
        await first.vault.adapter.write("a.md", "a\n");
        await sync2AllAndAssertNoErrors(first);
        const afterFirst = await countBranchCommits(branch);

        // Hand-edit the CURRENT hot slot: keep known fields, sprinkle
        // in unknown ones.
        const [slotAbs, raw] = readMaxHotSlot(vaultPath);
        raw.future_feature_xyz = "newer-build-wrote-this";
        raw.experimental = { from: "2030", count: 42 };
        fs.writeFileSync(slotAbs, JSON.stringify(raw));
        // And every baseline bucket: unknown per-entry keys.
        const bucketsDir = path.join(vaultPath, RUNTIME_REL, "file-baselines");
        for (const f of fs.readdirSync(bucketsDir)) {
          const bAbs = path.join(bucketsDir, f);
          const bRaw = JSON.parse(fs.readFileSync(bAbs, "utf8"));
          for (const k of Object.keys(bRaw.files ?? {})) {
            bRaw.files[k].xattr = "extra";
            bRaw.files[k].futureSha = "sha-from-newer-build";
          }
          bRaw.future_bucket_field = true;
          fs.writeFileSync(bAbs, JSON.stringify(bRaw));
        }

        // Re-instantiate, sync — unknown fields are dropped silently.
        client = await createSync2Client({
          branch,
          vaultPath,
          ownsVaultPath: true,
        });
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
        // Known fields survived; lastSync still points at the same
        // commit; no new commit landed.
        const afterRecover = await countBranchCommits(branch);
        expect(afterRecover).toBe(afterFirst);
      },
      300_000,
    );
  },
);
