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
  spliceSection,
  fingerprintOf,
  INVARIANTS_SECTION,
  type SectionMarkers,
  type SectionAnomalyReport,
  extractInvariantBlock,
  blockHasAllowLine,
} from "../../src/sync2/gitignore-invariants";
import InvariantStateStore from "../../src/sync2/invariant-state";
import GitignoreSeedStore from "../../src/sync2/gitignore-seeds";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import {
  AtomicWriteRecovery,
  stagingPathFor,
} from "../../src/sync2/atomic-write";
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
  const anomalies: SectionAnomalyReport[] = [];
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
    onAnomaly: (report) => anomalies.push(report),
  });
  return { root, vault, state, seeds, inv, anomalies };
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

// A `final`-shaped section for the placement cases. The real FINAL
// markers arrive with their content in A-6; what is under test here is
// that placement is a parameter and BOTTOM works, not the rule text.
const BOTTOM: SectionMarkers = {
  begin: "# ===== test tail - DO NOT EDIT =====",
  end: "# ===== end of test tail =====",
  placement: "bottom",
};
const tail = (body: string) => `${BOTTOM.begin}\n${body}\n${BOTTOM.end}`;

const splice = async (
  existing: string,
  body: string | null,
  extra: {
    markers?: SectionMarkers;
    recorded?: { sha: string; len: number };
  } = {},
) =>
  spliceSection({
    existing,
    markers: extra.markers ?? INVARIANTS_SECTION,
    body,
    recorded: extra.recorded,
  });

describe("spliceSection (pure)", () => {
  it("prepends when markers are missing", async () => {
    expect((await splice("user content\n", "X")).content).toBe(
      `${sect("X")}\n\nuser content\n`,
    );
  });

  it("creates fresh content when input is empty", async () => {
    expect((await splice("", "Y")).content).toBe(`${sect("Y")}\n`);
  });

  it("leaves user content above and below the section alone", async () => {
    const existing = `# header\n\n${sect("OLD")}\n\n# footer\n*.log\n`;
    const out = (await splice(existing, "NEW")).content;
    expect(out).toContain("# header");
    expect(out).toContain("# footer");
    expect(out).toContain("*.log");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
  });

  it("FORCES the placement: a section found mid-file moves to the top", async () => {
    // The old splice replaced in place, so a section could sit anywhere.
    // Position is now semantics (last-match-wins), so it is re-asserted
    // every pass — which also migrates a file laid out by an older
    // version without any dedicated migration step.
    const existing = `prefix\n${sect("OLD")}\nsuffix\n`;
    expect((await splice(existing, "NEW")).content).toBe(
      `${sect("NEW")}\n\nprefix\nsuffix\n`,
    );
  });

  it("placement bottom puts the section last, below every user rule", async () => {
    const out = (
      await splice(`*.log\n!keep.log\n`, "FINAL", { markers: BOTTOM })
    ).content;
    expect(out).toBe(`*.log\n!keep.log\n\n${tail("FINAL")}\n`);
    expect(out.indexOf("!keep.log")).toBeLessThan(out.indexOf(BOTTOM.begin));
  });

  it("body=null deletes the section and leaves nothing behind", async () => {
    const existing = `user\n\n${tail("*")}\n`;
    const out = (await splice(existing, null, { markers: BOTTOM })).content;
    expect(out).toBe("user\n");
    expect(out).not.toContain(BOTTOM.begin);
  });

  it("is idempotent — a second pass changes nothing", async () => {
    const once = (await splice("*.log\n", "B", { markers: BOTTOM })).content;
    const twice = (await splice(once, "B", { markers: BOTTOM })).content;
    expect(twice).toBe(once);
    // ...and so is the top placement, where the seam is above.
    const t1 = (await splice("*.log\n", "B")).content;
    expect((await splice(t1, "B")).content).toBe(t1);
  });

  it("cuts EVERY pair, not just the first, and says so", async () => {
    // A leftover pair would sit below ours and override it — the exact
    // failure the old "cut the first, report the rest" rule allowed once
    // the section became placed rather than replaced in place.
    const existing = `${sect("ONE")}\nmiddle\n${sect("TWO")}\ntail\n`;
    const out = await splice(existing, "NEW");
    expect(out.content).toBe(`${sect("NEW")}\n\nmiddle\ntail\n`);
    expect(out.content).not.toContain("ONE");
    expect(out.content).not.toContain("TWO");
    expect(out.anomalies).toContain("multiple-pairs");
  });

  it("END before BEGIN is treated as broken markers, user text intact", async () => {
    const existing = `${INVARIANTS_END}\nstray\n*.user\n`;
    const out = await splice(existing, "NEW");
    expect(out.content).toContain("*.user");
    expect(out.content).toContain("stray");
    expect(out.content.indexOf(INVARIANTS_BEGIN)).toBe(0);
  });

  describe("orphaned BEGIN (END deleted or truncated away)", () => {
    // Prepending a fresh section is NOT a safe default here: the stale
    // body stays in the file and, once the new section is placed, can
    // override it. So the old body is identified by the one thing we
    // recorded about it — byte length + blob SHA — and cut exactly.
    const OLD = "# old\n*.stale";

    it("with a recorded fingerprint: the stale body is cut, no duplicates", async () => {
      const recorded = await fingerprintOf(OLD);
      const existing = `${INVARIANTS_BEGIN}\n${OLD}\n# user keeps this\n`;
      const out = await splice(existing, "NEW", { recorded });
      expect(out.content).toBe(`${sect("NEW")}\n\n# user keeps this\n`);
      expect(out.content).not.toContain("*.stale");
      expect(out.anomalies).toContain("orphan-repaired");
    });

    it("without a fingerprint: we do NOT guess — user text and the damage both stay", async () => {
      const existing = `${INVARIANTS_BEGIN}\n${OLD}\n# user keeps this\n`;
      const out = await splice(existing, "NEW");
      expect(out.content).toContain("# user keeps this");
      expect(out.content).toContain("*.stale"); // untouched, reported instead
      expect(out.anomalies).toContain("orphan-unrepairable");
    });

    it("a fingerprint that does not match declines the repair", async () => {
      const recorded = await fingerprintOf("# something else entirely");
      const existing = `${INVARIANTS_BEGIN}\n${OLD}\n# user keeps this\n`;
      const out = await splice(existing, "NEW", { recorded });
      expect(out.content).toContain("*.stale");
      expect(out.anomalies).toContain("orphan-unrepairable");
    });

    it("the span is measured in UTF-8 BYTES, not characters", async () => {
      // The reason this is pinned even though our own content is ASCII:
      // the body is adjacent to the USER's content, which is not. Under
      // a character-based length the span would end early, the SHA would
      // never match, and the repair would silently never fire.
      const body = "# наш блок\n*.stale";
      const recorded = await fingerprintOf(body);
      expect(recorded.len).toBeGreaterThan(body.length); // multi-byte
      const existing = `${INVARIANTS_BEGIN}\n${body}\n# user keeps this\n`;
      const out = await splice(existing, "NEW", { recorded });
      expect(out.content).toBe(`${sect("NEW")}\n\n# user keeps this\n`);
      expect(out.anomalies).toContain("orphan-repaired");
    });
  });

  it("the markers are ASCII — no em dash can creep back in", () => {
    // DOT-FILES §3.1.3: the marker lines are frozen, and since
    // 2026-09-21 they are ASCII.
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

describe("managed .gitignore writes are crash-safe (DOT-FILES §3.1.3)", () => {
  // A .gitignore is not an ordinary data file: a truncated one DEFINES
  // SCOPE. Lose the tail of the root file and the user's `!` opt-ins go
  // with it, so paths silently leave sync. Hence the write goes through
  // atomicWriteFile, and an interrupted one is forward-completed by the
  // onload sweep BEFORE the first enforce() ever reads the file.
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.state.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("no raw adapter.write is left behind: staging appears and is cleaned up", async () => {
    // mock-obsidian exposes `adapter` as a GETTER that builds a fresh
    // object each access, so assigning onto it is lost. Shadow the
    // getter with an own property returning one wrapped adapter.
    const seen: string[] = [];
    const real = f.vault.adapter;
    const wrapped = {
      ...real,
      writeBinary: async (p: string, b: ArrayBuffer) => {
        seen.push(p);
        return real.writeBinary(p, b);
      },
    };
    Object.defineProperty(f.vault, "adapter", { get: () => wrapped });

    await f.inv.enforce();

    // The root file was staged under .ges-tmp before being renamed into
    // place — the proof the crash-safe path ran at all.
    expect(seen).toContain(stagingPathFor(".gitignore", "tmp"));
    // ...and nothing was left lying around.
    expect(fs.existsSync(path.join(f.root, ".gitignore.ges-tmp"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, ".gitignore.ges-bak"))).toBe(false);
  });

  it("a write interrupted mid-flight is forward-completed, and enforce() then sees a WHOLE file", async () => {
    await f.inv.enforce();
    const rootPath = path.join(f.root, ".gitignore");
    const canonical = fs.readFileSync(rootPath, "utf8");
    const withUserRule = `${canonical}\n!.editorconfig\n`;

    // Simulate a crash between "rename original → .ges-bak" and
    // "rename .ges-tmp → original": the target path does not exist at
    // all, and the two halves of the write sit beside it.
    fs.writeFileSync(path.join(f.root, ".gitignore.ges-bak"), canonical);
    fs.writeFileSync(path.join(f.root, ".gitignore.ges-tmp"), withUserRule);
    fs.rmSync(rootPath);

    const baselines = new FileBaselinesStore({
      vault: f.vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF,
    });
    await new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      baselines,
    ).sweep();

    // Whatever the sweep chose, the file exists and is not truncated:
    // the invariant section is intact, markers and all.
    const recovered = fs.readFileSync(rootPath, "utf8");
    expect(recovered).toContain(INVARIANTS_BEGIN);
    expect(recovered).toContain(INVARIANTS_END);
    expect(recovered).toContain("*.conflict-from-*");

    // And the pass that follows reads a whole file, so the user's rule
    // below our section survives rather than being re-seeded over.
    await f.inv.enforce();
    const after = fs.readFileSync(rootPath, "utf8");
    expect(after).toContain(INVARIANTS_BEGIN);
    expect(after).toContain("*.log"); // recommended defaults still there
    expect(fs.existsSync(path.join(f.root, ".gitignore.ges-tmp"))).toBe(false);
  });
});
