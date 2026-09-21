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
  INVARIANTS_BEGIN,
  INVARIANTS_END,
  spliceInvariantBlock,
  extractInvariantBlock,
  blockHasAllowLine,
} from "../../src/sync2/gitignore-invariants";
import InvariantStateStore from "../../src/sync2/invariant-state";
import GitignoreSeedStore from "../../src/sync2/gitignore-seeds";
import { Vault } from "../../mock-obsidian";
import { calculateGitBlobSHA } from "../../src/utils";

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
  const state = new InvariantStateStore({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF,
  });
  const seeds = new GitignoreSeedStore({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF,
  });
  const inv = new GitignoreInvariants({
    vault: vault as unknown as import("obsidian").Vault,
    state,
    configDir: CONFIG_DIR,
    selfPluginId: SELF,
    seeds,
  });
  return { root, vault, state, seeds, inv };
}

const cdGitignore = (root: string) =>
  path.join(root, CONFIG_DIR, ".gitignore");
const selfGitignore = (root: string) =>
  path.join(root, CONFIG_DIR, "plugins", SELF, ".gitignore");

// The splice takes a BODY now and composes the markers itself — the
// frozen half and the mutable half stopped sharing a template
// (DOT-FILES §3.1.3). `sect` mirrors that composition so the expectations
// below still read as "what lands on disk".
const sect = (body: string) =>
  `${INVARIANTS_BEGIN}\n${body}\n${INVARIANTS_END}`;

describe("spliceInvariantBlock (pure)", () => {
  it("replaces an existing block in place", () => {
    const existing = `prefix\n${sect("OLD")}\nsuffix`;
    expect(spliceInvariantBlock(existing, "NEW")).toBe(
      `prefix\n${sect("NEW")}\nsuffix`,
    );
  });

  it("prepends when markers are missing", () => {
    expect(spliceInvariantBlock("user content\n", "X")).toBe(
      `${sect("X")}\n\nuser content\n`,
    );
  });

  it("creates fresh content when input is empty", () => {
    expect(spliceInvariantBlock("", "Y")).toBe(`${sect("Y")}\n`);
  });

  it("leaves user content above and below the block alone", () => {
    const existing = `# header\n\n${sect("OLD")}\n\n# footer\n*.log\n`;
    const out = spliceInvariantBlock(existing, "NEW");
    expect(out).toContain("# header");
    expect(out).toContain("# footer");
    expect(out).toContain("*.log");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
  });

  it("the markers are ASCII — no em dash can creep back in", () => {
    // DOT-FILES §3.1.3: the four marker lines are frozen, and since
    // 2026-09-21 they are ASCII. A non-ASCII character here would also
    // put UTF-8 bytes back into the length the repair path measures.
    for (const m of [INVARIANTS_BEGIN, INVARIANTS_END]) {
      expect(m).toMatch(/^[\x20-\x7e]+$/);
      expect(m).toContain("git-easy-sync");
    }
  });
});

describe("GitignoreInvariants.enforce", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.state.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("creates configDir/.gitignore with invariant block + recommended defaults when absent", async () => {
    expect(fs.existsSync(cdGitignore(f.root))).toBe(false);
    await f.inv.enforce();
    const content = fs.readFileSync(cdGitignore(f.root), "utf8");
    expect(content).toContain(INVARIANTS_BEGIN);
    expect(content).toContain(INVARIANTS_END);
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
    expect(content).toContain(INVARIANTS_BEGIN);
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
      `# my header\n\n${INVARIANTS_BEGIN}\ntampered\n${INVARIANTS_END}\n\n# my footer\n*.tmp\n`,
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
    expect(content).toContain(INVARIANTS_BEGIN);
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
    expect(f.state.getFor(`${CONFIG_DIR}/.gitignore`)?.mtime).toBe(
      stat.mtimeMs,
    );
  });

  it("real edit: hash mismatch triggers splice rewrite", async () => {
    await f.inv.enforce();
    const cdPath = cdGitignore(f.root);
    // User tampers with the invariant block.
    fs.writeFileSync(
      cdPath,
      `${INVARIANTS_BEGIN}\nGOTCHA\n${INVARIANTS_END}\n*.user-rule\n`,
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
    expect(f.state.getFor(`${CONFIG_DIR}/.gitignore`)?.mtime).toBe(
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

  it("invariant state survives across new instances (own .runtime file, write-through)", async () => {
    await f.inv.enforce();
    // No explicit save: InvariantStateStore persists on every set.

    // New instance, fresh load.
    const state2 = new InvariantStateStore({
      vault: f.vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF,
    });
    await state2.load();
    expect(state2.getFor(`${CONFIG_DIR}/.gitignore`)).toBeDefined();
    expect(
      state2.getFor(`${CONFIG_DIR}/plugins/${SELF}/.gitignore`),
    ).toBeDefined();
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
      INVARIANTS_BEGIN,
      "# old block",
      "git-easy-sync-metadata.json",
      "plugins/*/data.json",
      INVARIANTS_END,
    ].join("\n");
    fs.writeFileSync(cdPath, staleBody + "\n");
    const staleStat = fs.statSync(cdPath);

    // Seed the store to claim this exact stale content was what we
    // recorded last enforce — the file's real mtime and size, so any
    // "did anyone touch the FILE?" check says no. It has to rewrite
    // anyway: what changed is what WE want, not what is on disk.
    await f.state.set(`${CONFIG_DIR}/.gitignore`, {
      mtime: staleStat.mtimeMs,
      size: staleStat.size,
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
    INVARIANTS_BEGIN,
    "# stuff",
    "git-easy-sync-metadata.json",
    "plugins/*/data.json",
    INVARIANTS_END,
  ].join("\n");
  const blockOn = [
    INVARIANTS_BEGIN,
    "# stuff",
    "git-easy-sync-metadata.json",
    "!plugins/*/data.json",
    INVARIANTS_END,
  ].join("\n");

  it("extractInvariantBlock: returns body between markers, exclusive", () => {
    const body = extractInvariantBlock(blockOff);
    expect(body).not.toBeNull();
    expect(body).toContain("git-easy-sync-metadata.json");
    expect(body).not.toContain(INVARIANTS_BEGIN);
    expect(body).not.toContain(INVARIANTS_END);
  });

  it("extractInvariantBlock: returns null when markers missing or out-of-order", () => {
    expect(extractInvariantBlock("no markers anywhere")).toBeNull();
    expect(extractInvariantBlock(INVARIANTS_BEGIN + "\nno end")).toBeNull();
    expect(
      extractInvariantBlock(INVARIANTS_END + "\nmiddle\n" + INVARIANTS_BEGIN),
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
      INVARIANTS_BEGIN,
      "!plugins/**/data.json",
      INVARIANTS_END,
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

// DOT-FILES §8.0 — the seed markers. The claim they carry is narrow
// and must stay narrow: "this file, right now, is byte-identical to
// what WE seed". Everything else about the file — who wrote it, when,
// which plugin version — is deliberately not recorded, because the
// only consumer asks exactly that one question.
describe("§8.0 seed markers", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  const fresh = async () => {
    const f = fixture();
    roots.push(f.root);
    await f.state.load();
    await f.seeds.load();
    return f;
  };

  const rootPath = (root: string) => path.join(root, ".gitignore");

  it("a file we seeded from nothing is marked — both managed files", async () => {
    const f = await fresh();
    await f.inv.enforce();

    const rootSha = f.seeds.get(".gitignore");
    const cdSha = f.seeds.get(`${CONFIG_DIR}/.gitignore`);
    expect(rootSha).toBeDefined();
    expect(cdSha).toBeDefined();
    // The recorded sha is the git blob sha of what is actually on disk
    // — that is what the drain compares a batch entry against.
    expect(rootSha).toBe(
      await calculateGitBlobSHA(
        new TextEncoder().encode(fs.readFileSync(rootPath(f.root), "utf8"))
          .buffer as ArrayBuffer,
      ),
    );
  });

  it("our own plugin's .gitignore is NEVER marked — it is a constant, not a proposal", async () => {
    const f = await fresh();
    await f.inv.enforce();
    expect(
      f.seeds.get(`${CONFIG_DIR}/plugins/${SELF}/.gitignore`),
    ).toBeUndefined();
  });

  it("a user edit OUTSIDE our block drops the claim on the next pass", async () => {
    const f = await fresh();
    await f.inv.enforce();
    expect(f.seeds.get(".gitignore")).toBeDefined();

    // enforce() deliberately leaves user content alone, so the file is
    // no longer ours — the claim must go, and the path returns to
    // ordinary rules (including a legitimate conflict).
    fs.appendFileSync(rootPath(f.root), "\n# mine\n*.bak\n");
    await f.inv.enforce();
    expect(f.seeds.get(".gitignore")).toBeUndefined();
  });

  it("a plugin upgrade that rewrites the block KEEPS the claim — the file is still 100% ours", async () => {
    const f = await fresh();
    await f.inv.enforce();
    const first = f.seeds.get(".gitignore");

    // Simulate the upgrade shape: the on-disk block drifts from
    // canonical, enforce() rewrites it, and the result is again
    // exactly our seed. A marker written once at seed time would have
    // gone stale here; recomputing every pass keeps it honest.
    const body = fs.readFileSync(rootPath(f.root), "utf8");
    fs.writeFileSync(
      rootPath(f.root),
      body.replace("*.conflict-from-*", "*.conflict-from-*\n# stray"),
    );
    await f.inv.enforce();

    expect(f.seeds.get(".gitignore")).toBe(first);
  });

  it("a user edit INSIDE our block leaves the file ours-plus-theirs → no claim", async () => {
    const f = await fresh();
    await f.inv.enforce();
    // Mangle the block AND add content below it. enforce() restores
    // the block, but the extra line stays — so the file is no longer
    // byte-identical to the seed.
    fs.writeFileSync(
      rootPath(f.root),
      `${INVARIANTS_BEGIN}\nhand-written\n${INVARIANTS_END}\n# theirs\n*.zip\n`,
    );
    await f.inv.enforce();
    expect(f.seeds.get(".gitignore")).toBeUndefined();
  });

  it("markers survive a restart — a fresh store reads them back", async () => {
    const f = await fresh();
    await f.inv.enforce();
    const sha = f.seeds.get(".gitignore");

    const reopened = new GitignoreSeedStore({
      vault: f.vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF,
    });
    await reopened.load();
    expect(reopened.get(".gitignore")).toBe(sha);
    expect(reopened.matches(".gitignore", sha!)).toBe(true);
    expect(reopened.matches(".gitignore", "deadbeef")).toBe(false);
  });
});
