import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import GitignoreInvariants, {
  INVARIANT_BEGIN,
  INVARIANT_END,
  spliceInvariantBlock,
  extractInvariantBlock,
  blockHasAllowLine,
} from "../../src/sync2/gitignore-invariants";
import SnapshotStore from "../../src/sync2/snapshot-store";
import { Vault } from "../../mock-obsidian";

const CONFIG_DIR = ".obsidian";
const SELF = "git-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `gi-inv-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, CONFIG_DIR, "plugins", SELF), {
    recursive: true,
  });
  const vault = new Vault(root);
  const store = new SnapshotStore(vault as unknown as import("obsidian").Vault);
  const inv = new GitignoreInvariants({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    configDir: CONFIG_DIR,
    selfPluginId: SELF,
  });
  return { root, vault, store, inv };
}

const cdGitignore = (root: string) =>
  path.join(root, CONFIG_DIR, ".gitignore");
const selfGitignore = (root: string) =>
  path.join(root, CONFIG_DIR, "plugins", SELF, ".gitignore");

describe("spliceInvariantBlock (pure)", () => {
  it("replaces an existing block in place", () => {
    const block = `${INVARIANT_BEGIN}\nNEW\n${INVARIANT_END}`;
    const existing = `prefix\n${INVARIANT_BEGIN}\nOLD\n${INVARIANT_END}\nsuffix`;
    expect(spliceInvariantBlock(existing, block)).toBe(
      `prefix\n${block}\nsuffix`,
    );
  });

  it("prepends when markers are missing", () => {
    const block = `${INVARIANT_BEGIN}\nX\n${INVARIANT_END}`;
    expect(spliceInvariantBlock("user content\n", block)).toBe(
      `${block}\n\nuser content\n`,
    );
  });

  it("creates fresh content when input is empty", () => {
    const block = `${INVARIANT_BEGIN}\nY\n${INVARIANT_END}`;
    expect(spliceInvariantBlock("", block)).toBe(`${block}\n`);
  });

  it("leaves user content above and below the block alone", () => {
    const block = `${INVARIANT_BEGIN}\nNEW\n${INVARIANT_END}`;
    const existing = `# header\n\n${INVARIANT_BEGIN}\nOLD\n${INVARIANT_END}\n\n# footer\n*.log\n`;
    const out = spliceInvariantBlock(existing, block);
    expect(out).toContain("# header");
    expect(out).toContain("# footer");
    expect(out).toContain("*.log");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
  });
});

describe("GitignoreInvariants.enforce", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.store.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("creates configDir/.gitignore with invariant block + recommended defaults when absent", async () => {
    expect(fs.existsSync(cdGitignore(f.root))).toBe(false);
    await f.inv.enforce();
    const content = fs.readFileSync(cdGitignore(f.root), "utf8");
    expect(content).toContain(INVARIANT_BEGIN);
    expect(content).toContain(INVARIANT_END);
    expect(content).toContain("workspace.json");
    expect(content).toContain("Recommended defaults");
    expect(content).toContain("plugins/*/*");
    // `*.log` rule moved from configDir to root .gitignore — the
    // plugin's log lives at the vault root now, so the matching
    // gitignore rule lives there too.
    expect(content).not.toContain("*.log");
  });

  it("creates root .gitignore with conflict-sibling + atomic-write artifact invariants + *.log default when absent", async () => {
    const rootGitignorePath = path.join(f.root, ".gitignore");
    expect(fs.existsSync(rootGitignorePath)).toBe(false);
    await f.inv.enforce();
    const content = fs.readFileSync(rootGitignorePath, "utf8");
    // Invariant block: conflict-sibling files + atomic-write
    // staging/backup artifacts must never propagate across devices.
    expect(content).toContain(INVARIANT_BEGIN);
    expect(content).toContain("*.conflict-from-*");
    expect(content).toContain("*.ges-tmp");
    expect(content).toContain("*.ges-bak");
    // Recommended defaults: *.log (the plugin's own log lives at
    // <vault>/<plugin-id>.log; remove the rule to opt into log
    // sync).
    expect(content).toContain("*.log");
    // OS noise + editor junk seeded too.
    expect(content).toContain(".DS_Store");
    expect(content).toContain("*.swp");
  });

  it("creates self-plugin/.gitignore with canonical allowlist when absent", async () => {
    expect(fs.existsSync(selfGitignore(f.root))).toBe(false);
    await f.inv.enforce();
    const content = fs.readFileSync(selfGitignore(f.root), "utf8");
    expect(content).toContain("*\n");
    expect(content).toContain("!main.js");
    expect(content).toContain("!manifest.json");
    expect(content).toContain("!styles.css");
    expect(content).toContain("!.gitignore");
  });

  it("preserves user content above and below the invariant block on rewrite", async () => {
    const cdPath = cdGitignore(f.root);
    fs.writeFileSync(
      cdPath,
      `# my header\n\n${INVARIANT_BEGIN}\ntampered\n${INVARIANT_END}\n\n# my footer\n*.tmp\n`,
    );
    await f.inv.enforce();
    const content = fs.readFileSync(cdPath, "utf8");
    expect(content).toContain("# my header");
    expect(content).toContain("# my footer");
    expect(content).toContain("*.tmp");
    expect(content).toContain("workspace.json");
    expect(content).not.toContain("tampered");
  });

  it("prepends the invariant block when user file lacks markers", async () => {
    const cdPath = cdGitignore(f.root);
    fs.writeFileSync(cdPath, "*.user-rule\n");
    await f.inv.enforce();
    const content = fs.readFileSync(cdPath, "utf8");
    expect(content).toContain(INVARIANT_BEGIN);
    expect(content).toContain("*.user-rule");
    // Recommended defaults should NOT appear — file existed beforehand.
    expect(content).not.toContain("Recommended defaults");
  });

  it("self-plugin gitignore is fully overwritten regardless of prior content", async () => {
    fs.writeFileSync(selfGitignore(f.root), "completely\nbogus\ncontent\n");
    await f.inv.enforce();
    const content = fs.readFileSync(selfGitignore(f.root), "utf8");
    expect(content).not.toContain("bogus");
    expect(content).toContain("!main.js");
  });

  it("cache hit: second enforce with unchanged mtime makes no writes", async () => {
    await f.inv.enforce();
    const stat1 = fs.statSync(cdGitignore(f.root));

    await new Promise((r) => setTimeout(r, 30));
    await f.inv.enforce();
    const stat2 = fs.statSync(cdGitignore(f.root));
    // mtime should NOT have moved (no rewrite happened).
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("touched-but-unchanged: refreshes mtime cache without rewriting", async () => {
    await f.inv.enforce();
    const cdPath = cdGitignore(f.root);
    const original = fs.readFileSync(cdPath, "utf8");

    // Bump mtime without changing content.
    fs.utimesSync(cdPath, new Date(), new Date(Date.now() + 5_000));
    await f.inv.enforce();
    expect(fs.readFileSync(cdPath, "utf8")).toBe(original);

    // Cached state now matches new mtime.
    const stat = fs.statSync(cdPath);
    expect(f.store.getInvariantState().configDirGitignore?.mtime).toBe(
      stat.mtimeMs,
    );
  });

  it("real edit: hash mismatch triggers splice rewrite", async () => {
    await f.inv.enforce();
    const cdPath = cdGitignore(f.root);
    // User tampers with the invariant block.
    fs.writeFileSync(
      cdPath,
      `${INVARIANT_BEGIN}\nGOTCHA\n${INVARIANT_END}\n*.user-rule\n`,
    );
    fs.utimesSync(cdPath, new Date(), new Date(Date.now() + 10_000));

    await f.inv.enforce();
    const content = fs.readFileSync(cdPath, "utf8");
    expect(content).not.toContain("GOTCHA");
    expect(content).toContain("workspace.json");
    expect(content).toContain("*.user-rule");
  });

  it("notePathSelfWritten refreshes the cache after a sync2 push", async () => {
    await f.inv.enforce();
    const cdPath = cdGitignore(f.root);

    // Simulate sync2 receiving a pulled .gitignore that's already
    // canonical — the same bytes enforce() would produce. Re-stat to
    // mimic the post-write mtime bump.
    const canonical = fs.readFileSync(cdPath, "utf8");
    fs.writeFileSync(cdPath, canonical + "# user added later\n");
    fs.utimesSync(cdPath, new Date(), new Date(Date.now() + 5_000));

    await f.inv.notePathSelfWritten(`${CONFIG_DIR}/.gitignore`);
    const stat = fs.statSync(cdPath);
    expect(f.store.getInvariantState().configDirGitignore?.mtime).toBe(
      stat.mtimeMs,
    );

    // Next enforce() reads + splices + compares (there is no
    // mtime/hash short-circuit). Splice produces the same content
    // → no rewrite. Test verifies the post-splice equality short-
    // circuit holds for canonical content.
    const before = fs.readFileSync(cdPath, "utf8");
    await f.inv.enforce();
    expect(fs.readFileSync(cdPath, "utf8")).toBe(before);
  });

  it("invariant state survives across new instances (persisted in store)", async () => {
    await f.inv.enforce();
    await f.store.save();

    // New instance, fresh load.
    const store2 = new SnapshotStore(
      f.vault as unknown as import("obsidian").Vault,
    );
    await store2.load();
    expect(store2.getInvariantState().configDirGitignore).toBeDefined();
    expect(store2.getInvariantState().selfPluginGitignore).toBeDefined();
  });

  // ─── enforce() applies new canonical block on plugin upgrade ────────
  //
  // GitignoreInvariants.enforce always reads, splices, and compares
  // against the current canonical constant. There is no
  // mtime/hash short-circuit, so a plugin upgrade that introduces
  // new canonical-block lines reaches the on-disk gitignore even
  // when the user's file mtime hasn't changed.
  it("enforce applies a new canonical block even when mtime matches recorded", async () => {
    const cdPath = cdGitignore(f.root);

    // Plant a STALE on-disk gitignore: structured like a canonical
    // block but missing a hypothetical "future-canonical-rule"
    // (stand-in for `*.ges-bak*` after a plugin upgrade — any line
    // a future canonical adds that the recorded snapshot was unaware
    // of).
    const staleBody = [
      INVARIANT_BEGIN,
      "# old block",
      "git-easy-sync-metadata.json",
      "plugins/*/data.json",
      INVARIANT_END,
    ].join("\n");
    fs.writeFileSync(cdPath, staleBody + "\n");
    const staleStat = fs.statSync(cdPath);
    // Recompute the hash the same way GitignoreInvariants does
    // internally (SHA-1 hex of the file content). The exact algorithm
    // is private to gitignore-invariants.ts; the store's cache just
    // needs SOME value that, paired with the file's current mtime,
    // claims "this state was recorded".
    const staleHash = crypto
      .createHash("sha1")
      .update(fs.readFileSync(cdPath, "utf8"))
      .digest("hex");

    // Seed the store's invariant state to claim this exact stale
    // content was recorded last enforce.
    f.store.setInvariantState("configDirGitignore", {
      mtime: staleStat.mtimeMs,
      hash: staleHash,
    });

    // enforce() must re-splice the file and rewrite to current
    // canonical (which is wider than staleBody — contains
    // workspace.json + workspace-mobile.json + community-plugins.json
    // invariants that staleBody omits).
    await f.inv.enforce();

    const after = fs.readFileSync(cdPath, "utf8");

    // The current canonical block carries lines staleBody didn't.
    // Pick any line known to be in the current block but missing
    // from our stale stand-in.
    expect(after).toContain("workspace.json");
    expect(after).toContain("plugins/*/data.json");
    // Stale marker line removed (canonical block fully rewritten).
    expect(after).not.toContain("# old block");
  });
});

describe("extractInvariantBlock / blockHasAllowLine (pure)", () => {
  // Canonical OFF block: data.json line present WITHOUT leading `!`
  // → block rule. Canonical ON block: same line WITH leading `!`
  // → allow rule. The line is ALWAYS in our block; only the
  // prefix flips.
  const blockOff = [
    INVARIANT_BEGIN,
    "# stuff",
    "git-easy-sync-metadata.json",
    "plugins/*/data.json",
    INVARIANT_END,
  ].join("\n");
  const blockOn = [
    INVARIANT_BEGIN,
    "# stuff",
    "git-easy-sync-metadata.json",
    "!plugins/*/data.json",
    INVARIANT_END,
  ].join("\n");

  it("extractInvariantBlock: returns body between markers, exclusive", () => {
    const body = extractInvariantBlock(blockOff);
    expect(body).not.toBeNull();
    expect(body).toContain("git-easy-sync-metadata.json");
    expect(body).not.toContain(INVARIANT_BEGIN);
    expect(body).not.toContain(INVARIANT_END);
  });

  it("extractInvariantBlock: returns null when markers missing or out-of-order", () => {
    expect(extractInvariantBlock("no markers anywhere")).toBeNull();
    expect(extractInvariantBlock(INVARIANT_BEGIN + "\nno end")).toBeNull();
    expect(
      extractInvariantBlock(INVARIANT_END + "\nmiddle\n" + INVARIANT_BEGIN),
    ).toBeNull();
  });

  it("blockHasAllowLine: true for ON block (with !)", () => {
    expect(blockHasAllowLine(extractInvariantBlock(blockOn)!)).toBe(true);
  });

  it("blockHasAllowLine: false for OFF block (without !)", () => {
    expect(blockHasAllowLine(extractInvariantBlock(blockOff)!)).toBe(false);
  });

  it("blockHasAllowLine: variants are NOT matched (toggle owns the exact line)", () => {
    // Deeper glob — user-style hand-edit inside our block. Treated
    // as "not ON"; the next enforce() rewrites the block back to
    // canonical and clobbers it.
    const fancier = [
      INVARIANT_BEGIN,
      "!plugins/**/data.json",
      INVARIANT_END,
    ].join("\n");
    expect(blockHasAllowLine(extractInvariantBlock(fancier)!)).toBe(false);
  });

  it("blockHasAllowLine: matching line OUTSIDE the block is irrelevant", () => {
    // The caller passes the EXTRACTED body. A matching line OUTSIDE
    // our block is user territory and stays untouched.
    const fileWithOutsideMatch =
      blockOff + "\n\nplugins/*/*\n!plugins/*/data.json\n";
    const body = extractInvariantBlock(fileWithOutsideMatch);
    expect(blockHasAllowLine(body!)).toBe(false);
  });
});
