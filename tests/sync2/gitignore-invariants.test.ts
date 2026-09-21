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
  FINAL_BEGIN,
  FINAL_END,
  type SectionMarkers,
  type SectionAnomalyReport,
  extractSection,
  FINAL_SECTION,
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
import GI from "../../src/gi";
import { isUnhonouredGitignore } from "../../src/sync2/change-detector";
import { calculateGitBlobSHA } from "../../src/utils";

const CONFIG_DIR = ".obsidian";
const SELF = "git-easy-sync";

function fixture(syncConfigDir = true) {
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
    syncConfigDir: () => syncConfigDir,
    gi: { invalidate: () => {} },
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
// The toggle now lives in the FINAL section, so the pure-helper tests
// read from there.
const extractSection2 = (content: string) =>
  extractSection(content, FINAL_SECTION);

const sect = (body: string) =>
  `${INVARIANTS_BEGIN}\n${body}\n${INVARIANTS_END}`;

// A `final`-shaped section for the placement cases, with throwaway
// marker text: what is under test here is that placement is a parameter
// and BOTTOM works, not the shipped rule text.
const BOTTOM: SectionMarkers = {
  id: "final",
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

  it("creates configDir/.gitignore with recommended defaults ABOVE the final section when absent", async () => {
    expect(fs.existsSync(cdGitignore(f.root))).toBe(false);
    await f.inv.enforce();
    const content = fs.readFileSync(cdGitignore(f.root), "utf8");
    // Only a `final` section here — nothing we write into configDir is
    // a default the user may overrule (DOT-FILES §3.1.1).
    expect(content).toContain(FINAL_BEGIN);
    expect(content).toContain(FINAL_END);
    expect(content).not.toContain(INVARIANTS_BEGIN);
    expect(content).toContain("workspace.json");
    expect(content).toContain("Recommended defaults");
    expect(content).toContain("plugins/*/*");
    // ...and it is LAST, which is what makes the data.json line outrank
    // the catch-all in those defaults. This ordering is the whole fix
    // for the two formerly-pinned toggle defects (§3.4.1).
    expect(content.indexOf("plugins/*/*")).toBeLessThan(
      content.indexOf(FINAL_BEGIN),
    );
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

  it("appends the final section BELOW a pre-existing user file", async () => {
    const cdPath = cdGitignore(f.root);
    fs.writeFileSync(cdPath, "*.user-rule\n");
    await f.inv.enforce();
    const content = fs.readFileSync(cdPath, "utf8");
    expect(content).toContain(FINAL_BEGIN);
    expect(content).toContain("*.user-rule");
    expect(content.indexOf("*.user-rule")).toBeLessThan(
      content.indexOf(FINAL_BEGIN),
    );
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

describe("extractSection / blockHasAllowLine (pure)", () => {
  // Canonical OFF block: data.json line present WITHOUT leading `!`
  // → block rule. Canonical ON block: same line WITH leading `!`
  // → allow rule. The line is ALWAYS in our block; only the
  // prefix flips.
  const blockOff = [
    FINAL_BEGIN,
    "# stuff",
    "git-easy-sync-metadata.json",
    "plugins/*/data.json",
    FINAL_END,
  ].join("\n");
  const blockOn = [
    FINAL_BEGIN,
    "# stuff",
    "git-easy-sync-metadata.json",
    "!plugins/*/data.json",
    FINAL_END,
  ].join("\n");

  it("extractSection: returns body between markers, exclusive", () => {
    const body = extractSection2(blockOff);
    expect(body).not.toBeNull();
    expect(body).toContain("git-easy-sync-metadata.json");
    expect(body).not.toContain(FINAL_BEGIN);
    expect(body).not.toContain(FINAL_END);
  });

  it("extractSection: returns null when markers missing or out-of-order", () => {
    expect(extractSection2("no markers anywhere")).toBeNull();
    expect(extractSection2(FINAL_BEGIN + "\nno end")).toBeNull();
    expect(
      extractSection2(FINAL_END + "\nmiddle\n" + FINAL_BEGIN),
    ).toBeNull();
  });

  it("blockHasAllowLine: true for ON block (with !)", () => {
    expect(blockHasAllowLine(extractSection2(blockOn)!)).toBe(true);
  });

  it("blockHasAllowLine: false for OFF block (without !)", () => {
    expect(blockHasAllowLine(extractSection2(blockOff)!)).toBe(false);
  });

  it("blockHasAllowLine: variants are NOT matched (toggle owns the exact line)", () => {
    // Deeper glob — user-style hand-edit inside our block. Treated
    // as "not ON"; the next enforce() rewrites the block back to
    // canonical and clobbers it.
    const fancier = [
      FINAL_BEGIN,
      "!plugins/**/data.json",
      FINAL_END,
    ].join("\n");
    expect(blockHasAllowLine(extractSection2(fancier)!)).toBe(false);
  });

  it("blockHasAllowLine: matching line OUTSIDE the block is irrelevant", () => {
    // The caller passes the EXTRACTED body. A matching line OUTSIDE
    // our block is user territory and stays untouched.
    const fileWithOutsideMatch =
      blockOff + "\n\nplugins/*/*\n!plugins/*/data.json\n";
    const body = extractSection2(fileWithOutsideMatch);
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

describe("the restore pass over a DYNAMIC file set (DOT-FILES §3.1.2)", () => {
  let f: ReturnType<typeof fixture>;
  const foreignDir = (root: string) =>
    path.join(root, CONFIG_DIR, "plugins", "brat");
  const foreign = (root: string) => path.join(foreignDir(root), ".gitignore");
  const FOREIGN_REL = `${CONFIG_DIR}/plugins/brat/.gitignore`;

  beforeEach(async () => {
    f = fixture();
    await f.state.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("a fingerprint that no longer matches rewrites an UNTOUCHED file", async () => {
    // The regression that killed the old short-circuit: a plugin upgrade
    // changes the constant while the file on disk never moves, so
    // mtime+size still agree and the new rules never ship. Here the
    // record claims a body we no longer want — the pass must not believe
    // the file is fresh.
    await f.inv.enforce();
    const rootPath = path.join(f.root, ".gitignore");
    fs.writeFileSync(rootPath, `${sect("# something we never wrote")}\n`);
    const stat = fs.statSync(rootPath);
    await f.state.set(".gitignore", {
      mtime: stat.mtimeMs,
      size: stat.size,
      invariants: await fingerprintOf("# a body from an older version"),
    });

    await f.inv.enforce();
    expect(fs.readFileSync(rootPath, "utf8")).toContain("*.conflict-from-*");
  });

  it("re-stats AFTER writing, so a settled file is not rewritten forever", async () => {
    // A pre-write mtime in the record makes the next pass see "changed",
    // rewrite, and record another pre-write mtime — for ever.
    await f.inv.enforce();
    const rootPath = path.join(f.root, ".gitignore");
    const firstMtime = fs.statSync(rootPath).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    await f.inv.enforce();
    expect(fs.statSync(rootPath).mtimeMs).toBe(firstMtime);
    expect(f.state.getFor(".gitignore")?.mtime).toBe(firstMtime);
  });

  it("invalidates the matcher for the level it just wrote", async () => {
    // gi holds a parsed level by mtime for 500 ms, so without this the
    // isSyncable calls LATER IN THE SAME pass answer from the rules we
    // just replaced.
    const invalidated: (string | undefined)[] = [];
    const inv = new GitignoreInvariants({
      vault: f.vault as unknown as import("obsidian").Vault,
      state: f.state,
      configDir: CONFIG_DIR,
      selfPluginId: SELF,
      seeds: f.seeds,
      syncConfigDir: () => true,
      gi: { invalidate: (dir) => invalidated.push(dir) },
      onAnomaly: () => {},
    });
    await inv.enforce();
    expect(invalidated).toContain(""); // root
    expect(invalidated).toContain(CONFIG_DIR);
    expect(invalidated).toContain(`${CONFIG_DIR}/plugins/${SELF}`);
  });

  it("a third-party plugin's file is picked up by listing, not by a hardcoded name", async () => {
    fs.mkdirSync(foreignDir(f.root), { recursive: true });
    fs.writeFileSync(foreign(f.root), "*.map\n");
    await f.inv.enforce();
    // It entered the managed set...
    expect(f.state.getFor(FOREIGN_REL)).toBeDefined();
    // ...and nothing of theirs was touched: at syncConfigDir=ON we have
    // no section to put there, so the file is byte-identical.
    expect(fs.readFileSync(foreign(f.root), "utf8")).toBe("*.map\n");
  });

  it("we never CREATE a .gitignore in someone else's plugin folder", async () => {
    // A plugin folder without one has no deeper node, so the configDir
    // rules already cover it. Writing a file there to say something
    // already true would be pure intrusion.
    fs.mkdirSync(foreignDir(f.root), { recursive: true });
    fs.writeFileSync(path.join(foreignDir(f.root), "main.js"), "//");
    await f.inv.enforce();
    expect(fs.existsSync(foreign(f.root))).toBe(false);
    expect(f.state.getFor(FOREIGN_REL)).toBeUndefined();
  });

  it("our section is REMOVED from a third-party file when it should not be there", async () => {
    // Left behind by an earlier version, or by the toggle having been
    // OFF. "Should not be there" means gone, not an empty marked block.
    fs.mkdirSync(foreignDir(f.root), { recursive: true });
    fs.writeFileSync(
      foreign(f.root),
      `*.map\n\n${FINAL_BEGIN}\n*\n${FINAL_END}\n`,
    );
    await f.inv.enforce();
    const after = fs.readFileSync(foreign(f.root), "utf8");
    expect(after).toBe("*.map\n");
    expect(after).not.toContain(FINAL_BEGIN);
  });

  it("an uninstalled plugin's record is pruned, and no file is resurrected", async () => {
    fs.mkdirSync(foreignDir(f.root), { recursive: true });
    fs.writeFileSync(foreign(f.root), "*.map\n");
    await f.inv.enforce();
    expect(f.state.getFor(FOREIGN_REL)).toBeDefined();

    fs.rmSync(foreignDir(f.root), { recursive: true, force: true });
    await f.inv.enforce();
    expect(f.state.getFor(FOREIGN_REL)).toBeUndefined();
    expect(fs.existsSync(foreign(f.root))).toBe(false);
  });
});

describe("section CONTENT: two strengths in the root file (DOT-FILES §3.1)", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.state.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  const rootFile = () => fs.readFileSync(path.join(f.root, ".gitignore"), "utf8");

  it("lays the root file out as policy / user zone / final", async () => {
    await f.inv.enforce();
    const c = rootFile();
    expect(c.indexOf(INVARIANTS_BEGIN)).toBe(0);
    expect(c).toContain(".*\n");
    expect(c).toContain("!/.gitignore");
    // The user's zone sits between the two sections.
    expect(c.indexOf("Recommended defaults")).toBeGreaterThan(
      c.indexOf(INVARIANTS_END),
    );
    expect(c.indexOf(FINAL_BEGIN)).toBeGreaterThan(
      c.indexOf("Recommended defaults"),
    );
    // The final rules, and nothing of them left up top.
    expect(c).toContain(`!${CONFIG_DIR}/`);
    expect(c).toContain("*.conflict-from-*");
    expect(c.indexOf("*.conflict-from-*")).toBeGreaterThan(
      c.indexOf(FINAL_BEGIN),
    );
    expect(c.trimEnd().endsWith(FINAL_END)).toBe(true);
  });

  it("a user rule between the sections overrides the policy but NOT the final rules", async () => {
    // This is the asymmetry the whole two-section split exists for, and
    // it is checked through the REAL matcher over the REAL file we just
    // wrote — not against our idea of what the file says.
    await f.inv.enforce();
    const rootPath = path.join(f.root, ".gitignore");
    const c = rootFile();
    fs.writeFileSync(
      rootPath,
      c.replace(
        FINAL_BEGIN,
        `!.editorconfig\n!*.conflict-from-*\n\n${FINAL_BEGIN}`,
      ),
    );

    const gi = new GI(f.root);
    // Overrides the dot-hide policy above: opt-in works.
    expect(gi.ignored(".editorconfig")).toBe(false);
    // Cannot touch the final rules below: the sibling stays hidden.
    expect(
      gi.ignored("note.conflict-from-Mac-2026-01-01T00-00-00Z.md"),
    ).toBe(true);
  });

  it("the dot-hide policy actually hides dot-space, and configDir survives it", async () => {
    await f.inv.enforce();
    const gi = new GI(f.root);
    expect(gi.ignored(".editorconfig")).toBe(true);
    expect(gi.ignored("notes/.hidden/x.md")).toBe(true);
    expect(gi.ignored("notes/.gitignore")).toBe(true); // D6, natively
    expect(gi.ignored(".gitignore")).toBe(false);
    expect(gi.ignored("note.md")).toBe(false);
    // `!<configDir>/` in the final section keeps the config subtree in
    // play; its own files decide the rest from there.
    expect(gi.ignored(`${CONFIG_DIR}/app.json`)).toBe(false);
    expect(gi.ignored(`${CONFIG_DIR}/.gitignore`)).toBe(false);
    expect(gi.ignored(`${CONFIG_DIR}/plugins/${SELF}/main.js`)).toBe(false);
    expect(gi.ignored(`${CONFIG_DIR}/plugins/${SELF}/data.json`)).toBe(true);
  });
});

describe("section CONTENT: syncConfigDir=OFF silences the config subtree", () => {
  let f: ReturnType<typeof fixture>;
  const foreignDir = () => path.join(f.root, CONFIG_DIR, "plugins", "brat");

  beforeEach(async () => {
    f = fixture(false); // syncConfigDir OFF
    await f.state.load();
    fs.mkdirSync(foreignDir(), { recursive: true });
    fs.writeFileSync(path.join(foreignDir(), ".gitignore"), "*.map\n");
    fs.writeFileSync(path.join(foreignDir(), "main.js"), "//");
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("writes the silencer into configDir, our own file, and every foreign one that exists", async () => {
    await f.inv.enforce();
    const cd = fs.readFileSync(cdGitignore(f.root), "utf8");
    expect(cd).toContain("/.gitignore"); // this file stops syncing too
    expect(cd).toContain("\n*");

    // Our own file: the silencer is part of the constant we own, and it
    // is needed because our node speaks LAST for our own folder — the
    // allowlist would otherwise keep main.js visible.
    const self = fs.readFileSync(selfGitignore(f.root), "utf8");
    expect(self).toContain("!main.js");
    expect(self).toContain(FINAL_BEGIN);
    expect(self.indexOf("!main.js")).toBeLessThan(self.indexOf(FINAL_BEGIN));

    // A third party's file: our section only, their rules untouched.
    const foreign = fs.readFileSync(
      path.join(foreignDir(), ".gitignore"),
      "utf8",
    );
    expect(foreign).toContain("*.map");
    expect(foreign).toContain(FINAL_BEGIN);
  });

  it("and the matcher agrees: nothing under configDir is visible", async () => {
    await f.inv.enforce();
    const gi = new GI(f.root);
    expect(gi.ignored(`${CONFIG_DIR}/app.json`)).toBe(true);
    expect(gi.ignored(`${CONFIG_DIR}/plugins/${SELF}/main.js`)).toBe(true);
    expect(gi.ignored(`${CONFIG_DIR}/plugins/brat/main.js`)).toBe(true);
    // ...while the rest of the vault is unaffected.
    expect(gi.ignored("note.md")).toBe(false);
  });

  it("turning it back ON removes the silencer everywhere, including third-party files", async () => {
    await f.inv.enforce();
    // Same vault and same state store, only the toggle flipped — the
    // pass has to converge from the OFF layout to the ON one.
    const inv = new GitignoreInvariants({
      vault: f.vault as unknown as import("obsidian").Vault,
      state: f.state,
      configDir: CONFIG_DIR,
      selfPluginId: SELF,
      seeds: f.seeds,
      syncConfigDir: () => true,
      gi: { invalidate: () => {} },
      onAnomaly: () => {},
    });
    await inv.enforce();

    const foreign = fs.readFileSync(
      path.join(foreignDir(), ".gitignore"),
      "utf8",
    );
    expect(foreign).toBe("*.map\n"); // section gone, not left empty
    expect(fs.readFileSync(selfGitignore(f.root), "utf8")).not.toContain(
      FINAL_BEGIN,
    );
    expect(new GI(f.root).ignored(`${CONFIG_DIR}/app.json`)).toBe(false);
  });
});

describe("§12 Крок A done-criteria that the content tests above do not cover", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.state.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("TD2.1a/b — a user `/.gitignore` takes the root file out of sync, and control is unaffected (D6a)", async () => {
    // Reading a control file is ABSOLUTE and does not go through
    // isSyncable (D2.1); membership in the sync set is ordinary and may
    // lapse. Making the root file per-device is a FEATURE — device A
    // shares `!.editorconfig`, device B keeps its own.
    await f.inv.enforce();
    const rootPath = path.join(f.root, ".gitignore");
    const before = fs.readFileSync(rootPath, "utf8");
    fs.writeFileSync(
      rootPath,
      before.replace(FINAL_BEGIN, `/.gitignore\n\n${FINAL_BEGIN}`),
    );

    // (a) the file leaves scope...
    expect(new GI(f.root).ignored(".gitignore")).toBe(true);

    // (b) ...while it keeps governing, and enforce() keeps maintaining
    // it: the user's line survives, our sections stay canonical.
    await f.inv.enforce();
    const after = fs.readFileSync(rootPath, "utf8");
    expect(after).toContain("/.gitignore\n");
    expect(after).toContain(INVARIANTS_BEGIN);
    expect(after).toContain(FINAL_BEGIN);
    expect(new GI(f.root).ignored("notes/.hidden/x.md")).toBe(true);
  });

  it("the configDir re-admission is ANCHORED: a nested .gitignore stays hidden", async () => {
    // Bare `!.gitignore` at this node would also resurrect
    // `<configDir>/snippets/.gitignore` — a direct D6 violation. The
    // anchored form leaves it hidden. (§3.1.1, and §10 probe 4's same
    // conclusion for the root node.)
    fs.mkdirSync(path.join(f.root, CONFIG_DIR, "snippets"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(f.root, CONFIG_DIR, "snippets", ".gitignore"),
      "!x.css\n",
    );
    await f.inv.enforce();

    const gi = new GI(f.root);
    expect(gi.ignored(`${CONFIG_DIR}/.gitignore`)).toBe(false);
    expect(gi.ignored(`${CONFIG_DIR}/snippets/.gitignore`)).toBe(true);
    // And the isSyncable backstop agrees independently of the rule text.
    expect(
      isUnhonouredGitignore(`${CONFIG_DIR}/snippets/.gitignore`, CONFIG_DIR),
    ).toBe(true);
  });

  it("`!/plugins/*/.gitignore` works BELOW the catch-all — a third party's file syncs", async () => {
    // Above `plugins/*/*` this line does nothing (the catch-all
    // re-ignores it by last-match). It is only load-bearing because the
    // whole section moved to the bottom of the file.
    fs.mkdirSync(path.join(f.root, CONFIG_DIR, "plugins", "brat"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(f.root, CONFIG_DIR, "plugins", "brat", ".gitignore"),
      "*.map\n",
    );
    await f.inv.enforce();

    const gi = new GI(f.root);
    expect(gi.ignored(`${CONFIG_DIR}/plugins/brat/.gitignore`)).toBe(false);
    // ...while the catch-all still does its job for everything else in
    // that folder.
    expect(gi.ignored(`${CONFIG_DIR}/plugins/brat/other.js`)).toBe(true);
  });
});

describe("the data.json toggle survives a syncConfigDir round-trip", () => {
  // This gitignore is the ONLY store of that toggle — which is exactly
  // what lets it travel between devices. So turning configDir sync off
  // and back on must not quietly reset the user's opt-in.
  let f: ReturnType<typeof fixture>;
  let syncConfigDir = true;

  const invWith = (state: InvariantStateStore) =>
    new GitignoreInvariants({
      vault: f.vault as unknown as import("obsidian").Vault,
      state,
      configDir: CONFIG_DIR,
      selfPluginId: SELF,
      seeds: f.seeds,
      syncConfigDir: () => syncConfigDir,
      gi: { invalidate: () => {} },
      onAnomaly: () => {},
    });

  beforeEach(async () => {
    f = fixture();
    await f.state.load();
    syncConfigDir = true;
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("ON → configDir OFF → configDir ON keeps the opt-in", async () => {
    const inv = invWith(f.state);
    await inv.enforce();
    await inv.setPushPluginsDataJson(true);
    expect(await inv.getPushPluginsDataJson()).toBe(true);

    syncConfigDir = false;
    await inv.enforce();
    // Still remembered while inert — and still inert: `*` below wins.
    expect(await inv.getPushPluginsDataJson()).toBe(true);
    expect(
      new GI(f.root).ignored(`${CONFIG_DIR}/plugins/brat/data.json`),
    ).toBe(true);

    syncConfigDir = true;
    await inv.enforce();
    expect(await inv.getPushPluginsDataJson()).toBe(true);
  });
});
