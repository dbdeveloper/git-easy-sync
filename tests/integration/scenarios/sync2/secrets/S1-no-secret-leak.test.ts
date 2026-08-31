// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// S-series — "did a secret reach GitHub?", asked of REAL GitHub.
//
// The unit-level counterpart (tests/sync2/secret-leak-guard.test.ts)
// proves what isSyncable and the gitignore matcher DECIDE. This suite
// proves what actually lands in the repo, and it does so the blunt way:
// after a sync, every blob this sync added or changed is downloaded and
// searched for the token string. A path-name assertion can be fooled by
// a renamed or inlined file; a byte search cannot.
//
// The two guarantees under test (SYNC2 §isSyncable + the shipped
// allowlist) — neither depends on any user setting:
//   1. `<configDir>/plugins/<self>/data.json` and the whole
//      `<self>/.runtime/` subtree never leave the device.
//   2. A sync plugin that ships an allowlist `.gitignore` in its own
//      folder (the pre-rename `github-easy-sync` still sitting in real
//      vaults) is covered by that file alone.
// Both hold with the "push plugins data.json" toggle ON as well as OFF,
// which is why the toggle is exercised in the second test.

import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  integrationEnabled,
  requireEnv,
  uniqueBranchName,
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  getBranchHead,
  readRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";
import GitignoreInvariants from "../../../../../src/sync2/gitignore-invariants";
import InvariantStateStore from "../../../../../src/sync2/invariant-state";

const CONFIG_DIR = ".obsidian";
const SELF = "git-easy-sync";
const OLD_SELF = "github-easy-sync";
const OTHER = "obsidian42-brat";

// Syntactically PAT-shaped so a failure reads like the incident it
// prevents, and unique enough that a byte search cannot false-positive.
const FAKE_TOKEN = "ghp_S1noSecretLeak0123456789abcdefghij";

const SHIPPED_ALLOWLIST =
  "*\n!main.js\n!manifest.json\n!styles.css\n!.gitignore\n";

async function treeAt(
  c: Sync2TestClient,
  sha: string,
): Promise<Map<string, string>> {
  const t = await c.client.getRepoTree({ sha, retry: true });
  return new Map(t.files.map((f) => [f.path, f.sha]));
}

// Plant every secret-bearing shape a real vault carries.
async function plantSecrets(c: Sync2TestClient): Promise<void> {
  const w = (p: string, content: string) => c.vault.adapter.write(p, content);
  // A real note, so the sync has legitimate work to do.
  await w("note.md", "hello from S1\n");
  // (1) our own settings file — the live GitHub token.
  await w(
    `${CONFIG_DIR}/plugins/${SELF}/data.json`,
    JSON.stringify({ githubToken: FAKE_TOKEN }, null, 2),
  );
  await w(`${CONFIG_DIR}/plugins/${SELF}/main.js`, "// our build\n");
  await w(`${CONFIG_DIR}/plugins/${SELF}/manifest.json`, '{"id":"' + SELF + '"}');
  // (2) our runtime state — batches, conflicts, the content-addressed
  // store. Some of it embeds file bytes, and metadata.json can carry
  // paths the user considers private.
  await w(
    `${CONFIG_DIR}/plugins/${SELF}/.runtime/conflicts.json`,
    JSON.stringify({ note: FAKE_TOKEN }),
  );
  await w(
    `${CONFIG_DIR}/plugins/${SELF}/.runtime/sync-store/deadbeef`,
    FAKE_TOKEN,
  );
  // (3) the PRE-RENAME plugin, protected only by the allowlist it
  // shipped inside its own folder.
  await w(`${CONFIG_DIR}/plugins/${OLD_SELF}/.gitignore`, SHIPPED_ALLOWLIST);
  await w(
    `${CONFIG_DIR}/plugins/${OLD_SELF}/data.json`,
    JSON.stringify({ githubToken: FAKE_TOKEN }, null, 2),
  );
  await w(`${CONFIG_DIR}/plugins/${OLD_SELF}/main.js`, "// old build\n");
  // (4) per-device artifacts that can quote file contents.
  await w(`${SELF}.log`, `{"message":"token=${FAKE_TOKEN}"}\n`);
  await w(
    "note.conflict-from-TestDevice-2026-01-01T00-00-00Z.md",
    `sibling holding ${FAKE_TOKEN}\n`,
  );
  await w("note.md.ges-tmp", `staging holding ${FAKE_TOKEN}\n`);
  // (5) a third-party plugin: NOT a guarantee (user-flippable default),
  // planted so the toggle test has a subject.
  await w(
    `${CONFIG_DIR}/plugins/${OTHER}/data.json`,
    JSON.stringify({ apiKey: FAKE_TOKEN }),
  );
  await w(`${CONFIG_DIR}/plugins/${OTHER}/main.js`, "// their build\n");
}

// Download every blob this sync added or changed and search the bytes.
async function assertNoTokenInPushedBytes(
  c: Sync2TestClient,
  branch: string,
  before: Map<string, string>,
  env: ReturnType<typeof requireEnv>,
): Promise<string[]> {
  const head = await getBranchHead(branch, env);
  expect(head).not.toBeNull();
  const after = await treeAt(c, head as string);
  const changed = [...after.entries()]
    .filter(([p, sha]) => before.get(p) !== sha)
    .map(([p]) => p);
  for (const p of changed) {
    const body = await readRemoteFile(branch, p, env);
    expect(body, `secret bytes found in ${p}`).not.toContain(FAKE_TOKEN);
  }
  return changed;
}

describe.skipIf(!integrationEnabled())("sync2 S1 — no secret leak", () => {
  let client: Sync2TestClient | undefined;
  let branch = "";

  // Our own handle on the managed gitignores: the shared test fixture
  // wires GitignoreInvariants into the manager but does not expose it,
  // and the toggle test has to flip the setting from outside.
  const invariantsFor = (c: Sync2TestClient) =>
    new GitignoreInvariants({
      vault: c.vault,
      state: new InvariantStateStore({
        vault: c.vault,
        selfPluginId: SELF,
      }),
      configDir: CONFIG_DIR,
      selfPluginId: SELF,
    });

  beforeAll(async () => {
    await ensureRepoNotBare();
  });

  beforeEach(async () => {
    branch = uniqueBranchName("secret-leak");
    const base = await getDefaultBranchHead();
    if (base === null) throw new Error("default branch has no head");
    await createBranchFromHead(branch, base);
  });

  afterEach(async () => {
    client?.cleanup();
    client = undefined;
    await deleteBranchIfExists(branch);
  });

  it(
    "toggle OFF (default): no token-bearing path and no token BYTES reach the branch",
    { retry: 0, timeout: 180_000 },
    async () => {
      const env = requireEnv();
      client = await createSync2Client({ branch, syncConfigDir: true });
      const startHead = await getBranchHead(branch, env);
      const before = await treeAt(client, startHead as string);
      await plantSecrets(client);

      await sync2AllAndAssertNoErrors(client);

      const changed = await assertNoTokenInPushedBytes(
        client,
        branch,
        before,
        env,
      );

      // The sync must have actually done something — otherwise the
      // byte search above proves nothing.
      expect(changed).toContain("note.md");
      expect(changed).toContain(`${CONFIG_DIR}/plugins/${SELF}/main.js`);
      expect(changed).toContain(`${CONFIG_DIR}/plugins/${OLD_SELF}/main.js`);

      // And no forbidden shape is present, by path, at any depth.
      for (const p of changed) {
        expect(p.endsWith("data.json"), p).toBe(false);
        expect(p.includes("/.runtime/"), p).toBe(false);
        expect(p.endsWith(".log"), p).toBe(false);
        expect(p.includes(".conflict-from-"), p).toBe(false);
        expect(p.includes(".ges-tmp"), p).toBe(false);
      }
    },
  );

  it(
    "toggle ON: the two sync plugins' data.json STILL never travel",
    { retry: 0, timeout: 180_000 },
    async () => {
      // The opt-in is about OTHER plugins' settings. Our own token file
      // is held by the hardcoded deny, and the pre-rename one by the
      // allowlist it shipped — neither obeys this setting.
      const env = requireEnv();
      client = await createSync2Client({ branch, syncConfigDir: true });
      const startHead = await getBranchHead(branch, env);
      const before = await treeAt(client, startHead as string);
      await plantSecrets(client);
      // enforce() first so the managed block exists, then flip it. The
      // manager's own enforce() at syncAll start reads the block and
      // preserves whatever state it finds, so ON survives into the sync.
      const inv = invariantsFor(client);
      await inv.enforce();
      await inv.setPushPluginsDataJson(true);
      expect(await inv.getPushPluginsDataJson()).toBe(true);

      await sync2AllAndAssertNoErrors(client);

      await assertNoTokenInPushedBytes(client, branch, before, env);

      const head = await getBranchHead(branch, env);
      const after = await treeAt(client, head as string);
      expect(
        after.has(`${CONFIG_DIR}/plugins/${SELF}/data.json`),
        "our own data.json must never be pushed",
      ).toBe(false);
      expect(
        after.has(`${CONFIG_DIR}/plugins/${OLD_SELF}/data.json`),
        "the pre-rename plugin's data.json must never be pushed",
      ).toBe(false);
    },
  );
});
