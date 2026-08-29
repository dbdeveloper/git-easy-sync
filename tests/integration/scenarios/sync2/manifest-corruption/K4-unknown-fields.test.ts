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

// K4 — forward-compat: unknown top-level keys plus unknown per-file
// keys must be silently dropped. The migrate() function reads only
// the fields it knows about; anything else is ignored so older
// builds keep working when a newer build wrote extra state.

const MANIFEST_REL = ".obsidian/git-easy-sync-metadata.json";

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

        // Hand-edit the manifest: keep known fields, sprinkle in
        // unknown ones at both top level and per-file level.
        const manifestAbs = path.join(vaultPath, MANIFEST_REL);
        const raw = JSON.parse(fs.readFileSync(manifestAbs, "utf8"));
        raw.future_feature_xyz = "newer-build-wrote-this";
        raw.experimental = { from: "2030", count: 42 };
        for (const k of Object.keys(raw.files)) {
          raw.files[k].xattr = "extra";
          raw.files[k].futureSha = "sha-from-newer-build";
        }
        fs.writeFileSync(manifestAbs, JSON.stringify(raw));

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
