// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// LEAK GUARD — "can a token reach GitHub?"
//
// Every other gitignore test in this repo checks the *content* of the
// managed blocks (does enforce() write the right lines) or the pure
// splice/extract helpers. None of them answered the question that
// actually matters: run the REAL matcher over a REAL vault tree and
// tell me whether a token-bearing file is syncable.
//
// What is and is NOT a security boundary here — the distinction this
// suite is built around:
//
//   NOT a boundary. Other plugins' `data.json` may legitimately travel;
//   that is the user's call. Field history on the owner's test repo
//   proves they DID travel (cmdr, obsidian-linter, obsidian-vimrc-
//   support, templater-obsidian were all committed by earlier tooling
//   and only removed on 2026-05-03, by the first sync that installed
//   the invariant block). The `plugins/*/data.json` line is a safe
//   DEFAULT with a settings-tab toggle, not a guarantee.
//
//   IS a boundary — two independent layers, either one sufficient:
//     L1  hardcoded deny in isSyncable()  — `<self>/data.json` and the
//         whole `<self>/.runtime/` subtree. No gitignore involved, so
//         it holds even on a vault with no gitignore at all.
//     L3  the allowlist `.gitignore` a sync plugin ships INSIDE its own
//         folder (`*` + main.js/manifest.json/styles.css/.gitignore).
//         Both `git-easy-sync` and the pre-rename `github-easy-sync`
//         carry one, so the OLD plugin's token file is covered too —
//         which is what protects the live ~/Obsidian-test vault.
//
// The remaining layers are hygiene, not secrets: L4 root block
// (per-device artifacts, logs), L5 the toggle's two states, L6 the
// pre-rename migration relic.
//
// isSyncable is the ONE gate every push path shares (discovery filters
// both the local scan and the remote tree through it), so `false` here
// means the bytes are never even read for upload.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import GitignoreInvariants from "../../src/sync2/gitignore-invariants";
import InvariantStateStore from "../../src/sync2/invariant-state";
import { isSyncable } from "../../src/sync2/change-detector";
import GI from "../../src/gi";
import { Vault } from "../../mock-obsidian";

const CONFIG_DIR = ".obsidian";
const SELF = "git-easy-sync";
// The pre-rename plugin, still sitting in the live test vault. It is
// NOT covered by the hardcoded deny (that keys on the current id) — the
// allowlist .gitignore it shipped is what protects its token.
const OLD_SELF = "github-easy-sync";
// A plugin with no .gitignore of its own: only the configDir default
// stands between its data.json and the repo, and the user may lift it.
const OTHER = "obsidian42-brat";

// The allowlist file both sync plugins ship in their own folder.
const SHIPPED_ALLOWLIST = "*\n!main.js\n!manifest.json\n!styles.css\n!.gitignore\n";

// A syntactically real-looking PAT so a failing assertion reads like
// the incident it prevents. Never a real token.
const FAKE_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

interface Fixture {
  root: string;
  inv: GitignoreInvariants;
  /** Fresh GI per call — GI caches parsed .gitignore per directory
   *  node, and these tests rewrite those files mid-test. */
  syncable(p: string, opts?: { syncConfigDir?: boolean }): Promise<boolean>;
  write(rel: string, content: string): void;
  read(rel: string): string;
}

let fixtures: string[] = [];

function makeFixture(): Fixture {
  const root = path.join(
    os.tmpdir(),
    `leak-guard-${crypto.randomBytes(4).toString("hex")}`,
  );
  fixtures.push(root);
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  // A realistic vault, shaped like ~/Obsidian-test: our plugin, the
  // pre-rename one, and a third-party one — each with a token-bearing
  // data.json. Both sync plugins carry their shipped allowlist.
  write(
    `${CONFIG_DIR}/plugins/${SELF}/data.json`,
    JSON.stringify({ githubToken: FAKE_TOKEN }),
  );
  write(`${CONFIG_DIR}/plugins/${SELF}/main.js`, "// our build\n");
  write(`${CONFIG_DIR}/plugins/${SELF}/.gitignore`, SHIPPED_ALLOWLIST);
  write(
    `${CONFIG_DIR}/plugins/${OLD_SELF}/data.json`,
    JSON.stringify({ githubToken: FAKE_TOKEN }),
  );
  write(`${CONFIG_DIR}/plugins/${OLD_SELF}/main.js`, "// old build\n");
  write(`${CONFIG_DIR}/plugins/${OLD_SELF}/.gitignore`, SHIPPED_ALLOWLIST);
  write(
    `${CONFIG_DIR}/plugins/${OTHER}/data.json`,
    JSON.stringify({ apiKey: FAKE_TOKEN }),
  );
  write(`${CONFIG_DIR}/plugins/${OTHER}/main.js`, "// their build\n");
  write("note.md", "hello\n");

  const vault = new Vault(root);
  const inv = new GitignoreInvariants({
    vault: vault as unknown as import("obsidian").Vault,
    state: new InvariantStateStore({
      vault: vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF,
    }),
    configDir: CONFIG_DIR,
    selfPluginId: SELF,
  });

  const reader = async (abs: string) => {
    try {
      const st = fs.statSync(abs);
      return { content: fs.readFileSync(abs, "utf8"), mtime: st.mtimeMs };
    } catch {
      return null;
    }
  };

  return {
    root,
    inv,
    write,
    read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
    syncable: (p, opts) =>
      isSyncable(
        p,
        CONFIG_DIR,
        SELF,
        opts?.syncConfigDir ?? true,
        new GI(root),
        reader,
      ),
  };
}

beforeEach(() => {
  fixtures = [];
});

afterEach(() => {
  for (const r of fixtures) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {}
  }
});

describe("L1 — hardcoded deny: OUR token file, with no gitignore in play", () => {
  it("our own data.json is not syncable even when every gitignore is deleted", async () => {
    const f = makeFixture();
    // Strip the one file that would otherwise cover it, and never call
    // enforce() — so the ONLY thing left is the hardcoded deny.
    fs.rmSync(path.join(f.root, CONFIG_DIR, "plugins", SELF, ".gitignore"));
    expect(fs.existsSync(path.join(f.root, ".gitignore"))).toBe(false);
    expect(
      fs.existsSync(path.join(f.root, CONFIG_DIR, ".gitignore")),
    ).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/data.json`),
    ).toBe(false);
  });

  it("an explicit ALLOW line cannot open our data.json or .runtime/ — the deny is unconditional", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    await f.inv.setPushPluginsDataJson(true);
    // Hostile-as-possible gitignore state: someone (a hand edit, or a
    // peer device's synced file) explicitly un-ignores both paths, at
    // the deepest level, where a `!` rule normally wins.
    f.write(
      `${CONFIG_DIR}/plugins/${SELF}/.gitignore`,
      "!data.json\n!.runtime/\n!.runtime/**\n",
    );
    f.write(
      `${CONFIG_DIR}/.gitignore`,
      `!plugins/${SELF}/data.json\n!plugins/${SELF}/.runtime/**\n`,
    );
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/data.json`),
    ).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/.runtime/conflicts.json`),
    ).toBe(false);
  });

  it("our whole .runtime/ subtree is never syncable (queue, conflicts, sync-store, autosave)", async () => {
    const f = makeFixture();
    for (const p of [
      `${CONFIG_DIR}/plugins/${SELF}/.runtime/metadata-a.json`,
      `${CONFIG_DIR}/plugins/${SELF}/.runtime/conflicts.json`,
      `${CONFIG_DIR}/plugins/${SELF}/.runtime/sync-store/da39a3ee`,
      `${CONFIG_DIR}/plugins/${SELF}/.runtime/deep/nested/whatever.bin`,
    ]) {
      expect(await f.syncable(p), p).toBe(false);
    }
  });

  it("the known GI-vs-git gap cannot reach our secrets", async () => {
    // `tests/gi.test.ts` ("docs known gap: deeper !-rule resurrects
    // file under ignored folder") pins a real divergence: git prunes an
    // ignored directory and no `!` inside can resurrect anything under
    // it, while our matcher processes the deeper level and flips the
    // verdict back. Verified against real git while writing this suite:
    // with `.*` at the vault root, `git add -A` stages nothing from
    // `.obsidian/`, but our matcher would still pass main.js.
    //
    // That gap makes us MORE permissive than git — so the layer that
    // has to hold is the code-level deny, not the matcher.
    const f = makeFixture();
    f.write(".gitignore", `${CONFIG_DIR}/\n`); // whole configDir ignored
    f.write(
      `${CONFIG_DIR}/plugins/${SELF}/.gitignore`,
      "!data.json\n!.runtime/**\n", // the resurrecting rules
    );
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/data.json`),
    ).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/.runtime/conflicts.json`),
    ).toBe(false);
  });

  it("the whole configDir is gated when syncConfigDir is OFF", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/main.js`, {
        syncConfigDir: false,
      }),
    ).toBe(false);
    // …and a plain note is unaffected by that gate.
    expect(await f.syncable("note.md", { syncConfigDir: false })).toBe(true);
  });
});

describe("L3 — a plugin's OWN allowlist .gitignore (protects the PRE-RENAME token file)", () => {
  it("the old plugin's data.json is blocked by the allowlist it shipped, with no configDir block present", async () => {
    const f = makeFixture();
    // No enforce() → no configDir invariant block, no root block. The
    // shipped allowlist inside the plugin folder is the only defence,
    // and it is the one covering the live ~/Obsidian-test vault.
    expect(
      fs.existsSync(path.join(f.root, CONFIG_DIR, ".gitignore")),
    ).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OLD_SELF}/data.json`),
    ).toBe(false);
    // Its build files still pass — that is why it is an ALLOWlist.
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OLD_SELF}/main.js`),
    ).toBe(true);
  });

  it("the shipped allowlist survives the data.json toggle being turned ON", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    await f.inv.setPushPluginsDataJson(true);
    // The toggle lifts the configDir rule, but a deeper .gitignore wins
    // on paths inside its own directory: both sync plugins stay closed.
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OLD_SELF}/data.json`),
    ).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/data.json`),
    ).toBe(false);
  });

  it("everything else inside our own plugin dir is blocked; the self-update files are not", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    for (const p of [
      `${CONFIG_DIR}/plugins/${SELF}/secrets.txt`,
      `${CONFIG_DIR}/plugins/${SELF}/data.json.bak`,
      `${CONFIG_DIR}/plugins/${SELF}/notes/scratch.md`,
    ]) {
      expect(await f.syncable(p), p).toBe(false);
    }
    // The self-update path must stay open.
    expect(await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/main.js`)).toBe(
      true,
    );
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/manifest.json`),
    ).toBe(true);
  });
});

describe("L3-external — the shipped allowlist must hold for a FOREIGN git client", () => {
  // When our plugin is disabled and the vault is synced by something
  // else (obsidian-git, a git CLI, another sync plugin), none of our
  // code runs: the hardcoded deny is gone and the ONLY thing left is
  // the text of the .gitignore files on disk. So the rules inside
  // `<configDir>/plugins/<self>/.gitignore` deliberately DUPLICATE what
  // isSyncable enforces in code. These probes use the bare matcher —
  // no isSyncable — because that is what a foreign client is.
  const externalVerdict = async (
    root: string,
    rel: string,
  ): Promise<boolean> => {
    const reader = async (abs: string) => {
      try {
        const st = fs.statSync(abs);
        return { content: fs.readFileSync(abs, "utf8"), mtime: st.mtimeMs };
      } catch {
        return null;
      }
    };
    // GI.ignoredAsync is the same matcher the engine uses, minus every
    // rule that lives in our code.
    return new GI(root).ignoredAsync(rel, reader);
  };

  it("blocks our data.json and .runtime/ by gitignore text alone", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    for (const p of [
      `${CONFIG_DIR}/plugins/${SELF}/data.json`,
      `${CONFIG_DIR}/plugins/${SELF}/.runtime/conflicts.json`,
      `${CONFIG_DIR}/plugins/${SELF}/.runtime/sync-store/da39a3ee`,
    ]) {
      expect(await externalVerdict(f.root, p), `ignored: ${p}`).toBe(true);
    }
    // The three build files plus the .gitignore itself must stay
    // visible to that foreign client — self-update relies on them, and
    // the .gitignore has to travel or peer devices lose the rules.
    for (const p of [
      `${CONFIG_DIR}/plugins/${SELF}/main.js`,
      `${CONFIG_DIR}/plugins/${SELF}/manifest.json`,
      `${CONFIG_DIR}/plugins/${SELF}/styles.css`,
      `${CONFIG_DIR}/plugins/${SELF}/.gitignore`,
    ]) {
      expect(await externalVerdict(f.root, p), `visible: ${p}`).toBe(false);
    }
  });

  it("our own .gitignore is syncable, so the rules reach other devices and tools", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/.gitignore`),
    ).toBe(true);
  });

  it("enforce() restores the duplicating rules after a hostile edit", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    // Someone opens the file and un-ignores the token. While our plugin
    // runs, L1 still covers us — but a foreign client would push it, so
    // the file must be rewritten to canonical on the next load.
    f.write(
      `${CONFIG_DIR}/plugins/${SELF}/.gitignore`,
      "!data.json\n!.runtime/**\n",
    );
    expect(
      await externalVerdict(
        f.root,
        `${CONFIG_DIR}/plugins/${SELF}/data.json`,
      ),
    ).toBe(false); // the hostile state, before repair
    await f.inv.enforce();
    expect(f.read(`${CONFIG_DIR}/plugins/${SELF}/.gitignore`)).toBe(
      SHIPPED_ALLOWLIST,
    );
    expect(
      await externalVerdict(
        f.root,
        `${CONFIG_DIR}/plugins/${SELF}/data.json`,
      ),
    ).toBe(true);
  });
});

describe("L2/L5 — the configDir default for OTHER plugins is a user-flippable default", () => {
  it("OFF (default): a third-party data.json does not travel, while its allowlisted files do", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    expect(await f.inv.getPushPluginsDataJson()).toBe(false); // default
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/data.json`),
    ).toBe(false);
    // The block must not be a blanket ban — the three canonical files
    // are the whole point of syncing plugins at all.
    expect(await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/main.js`)).toBe(
      true,
    );
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/manifest.json`),
    ).toBe(true);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/styles.css`),
    ).toBe(true);
  });

  it.fails(
    "DEFECT (pinned): ON is a NO-OP whenever the recommended catch-all is present",
    async () => {
      // The settings toggle writes `!plugins/*/data.json` INSIDE the
      // invariant block at the top of the file. The recommended
      // defaults below it contain the plugin-folder catch-all
      // `plugins/*/*`, and gitignore is last-match-wins — so the
      // catch-all re-ignores data.json and the opt-in never takes
      // effect. Every vault whose <configDir>/.gitignore was CREATED by
      // this plugin has those defaults, i.e. the common case.
      //
      // The block's own comment claims it "must stand alone, not rely
      // on a sibling rule below" — true for the OFF direction, but the
      // ON direction is defeated by exactly that sibling.
      //
      // Fails SAFE (nothing travels that the user did not ask for), so
      // this is a broken feature, not a leak. Same root cause as the
      // L6 wart below — one ordering fix closes both; which fix is the
      // owner's call (move the managed block below the defaults, or
      // have the ON state also rewrite the catch-all).
      const f = makeFixture();
      await f.inv.enforce();
      await f.inv.setPushPluginsDataJson(true);
      expect(await f.inv.getPushPluginsDataJson()).toBe(true); // holds
      expect(
        await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/data.json`),
      ).toBe(true); // ← the no-op
    },
  );

  it("ON is honoured when the file has NO catch-all below the block", async () => {
    // Proof that the toggle's own line is written correctly and the
    // matcher reads it — isolating the defect above to rule ORDER, not
    // to the toggle mechanism.
    const f = makeFixture();
    f.write(`${CONFIG_DIR}/.gitignore`, ""); // pre-existing, no defaults seeded
    await f.inv.enforce();
    await f.inv.setPushPluginsDataJson(true);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/data.json`),
    ).toBe(true);
  });

  it("flipping back OFF blocks it again — no stale allow line survives the rewrite", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    await f.inv.setPushPluginsDataJson(true);
    await f.inv.setPushPluginsDataJson(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/data.json`),
    ).toBe(false);
    // Exactly one data.json rule in the file, and it is the block form.
    const cd = f.read(`${CONFIG_DIR}/.gitignore`);
    expect(cd.match(/^!?plugins\/\*\/data\.json$/gm)).toEqual([
      "plugins/*/data.json",
    ]);
  });

  it("per-device configDir state never syncs", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    for (const p of [
      `${CONFIG_DIR}/workspace.json`,
      `${CONFIG_DIR}/workspace-mobile.json`,
      `${CONFIG_DIR}/community-plugins.json`,
    ]) {
      expect(await f.syncable(p), p).toBe(false);
    }
  });

  it("a data.json in a NESTED folder under a plugin is covered by the recommended catch-all", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    // `plugins/*/data.json` does not match this path — `plugins/*/*`
    // from the recommended defaults is what covers it.
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/sub/data.json`),
    ).toBe(false);
  });
});

describe("L4 — root .gitignore: per-device artifacts and logs", () => {
  it("conflict siblings, atomic-write staging and backups never leave the device", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    for (const p of [
      // Sibling markers — also covered by isSyncable's own pattern,
      // but the gitignore is the layer that survives a pattern change.
      "note.conflict-from-Macbook-2026-01-01T00-00-00Z.md",
      "folder/note.conflict-from-Phone-2026-01-01T00-00-00Z.md",
      // All three atomic-write shapes (see atomic-write.ts §protocol).
      "note.md.ges-tmp",
      "note.ges-tmp.md",
      ".note.md.ges-tmp.", // modify-in-place marker
      "note.md.ges-bak",
      "folder/deep/note.md.ges-tmp",
    ]) {
      expect(await f.syncable(p), p).toBe(false);
    }
  });

  it("logs, OS noise and trash are blocked at any depth", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    for (const p of [
      "git-easy-sync.log",
      "folder/anything.log",
      ".DS_Store",
      "folder/.DS_Store",
      ".trash/deleted-note.md",
    ]) {
      expect(await f.syncable(p), p).toBe(false);
    }
  });

  it("a user-authored rule below the managed block is honoured", async () => {
    const f = makeFixture();
    await f.inv.enforce();
    fs.appendFileSync(
      path.join(f.root, ".gitignore"),
      "\n# user's own rule\nPrivate/\n*.secret\n",
    );
    expect(await f.syncable("Private/diary.md")).toBe(false);
    expect(await f.syncable("keys.secret")).toBe(false);
    expect(await f.syncable("note.md")).toBe(true);
  });
});

describe("L6 — migration relic: the pre-rename invariant block", () => {
  // The plugin id changed (github-easy-sync → git-easy-sync), and with
  // it the block marker. enforce() therefore does NOT recognise the old
  // block: it prepends a fresh one and leaves the relic in place —
  // including a stale `!plugins/*/data.json` if that device had the
  // toggle ON. gitignore is last-match-wins, so the relic sits BELOW
  // our block and would win… unless something below it re-blocks.
  const RELIC_ON = `# ===== github-easy-sync invariants — DO NOT EDIT =====
# Editing this block triggers a rewrite to canonical on next load.

# Per-device state — never propagate between machines.
github-easy-sync-metadata.json
workspace.json
workspace-mobile.json
community-plugins.json
!plugins/*/data.json
# ===== end of invariants =====
`;
  const RECOMMENDED = `
# Recommended defaults — feel free to edit.

# Plugin folder allowlist — by default sync only the four canonical files.
plugins/*/*
!plugins/*/
!plugins/*/main.js
!plugins/*/manifest.json
!plugins/*/styles.css
`;

  it("relic + recommended defaults (the real ~/Obsidian-test shape): nothing regresses", async () => {
    const f = makeFixture();
    f.write(`${CONFIG_DIR}/.gitignore`, RELIC_ON + RECOMMENDED);
    await f.inv.enforce();

    // Two blocks now coexist; the toggle reads OFF because the relic's
    // marker is not ours, and the catch-all below out-ranks its stale
    // allow line.
    expect(await f.inv.getPushPluginsDataJson()).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/data.json`),
    ).toBe(false);
    // Both token files stay closed regardless.
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/data.json`),
    ).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OLD_SELF}/data.json`),
    ).toBe(false);
  });

  it("relic WITHOUT the catch-all: the two TOKEN files still hold", async () => {
    const f = makeFixture();
    f.write(`${CONFIG_DIR}/.gitignore`, RELIC_ON); // no catch-all below
    await f.inv.enforce();
    // This is the case where the stale allow line does win (see the
    // pinned wart below) — but neither sync plugin's data.json moves,
    // because L1 and L3 are independent of the configDir file.
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${SELF}/data.json`),
    ).toBe(false);
    expect(
      await f.syncable(`${CONFIG_DIR}/plugins/${OLD_SELF}/data.json`),
    ).toBe(false);
  });

  it.fails(
    "WART (pinned): relic WITHOUT the catch-all resurrects the ON state for third-party data.json",
    async () => {
      // A vault whose <configDir>/.gitignore pre-existed when the OLD
      // plugin first ran got only the invariant block prepended — the
      // recommended defaults were never seeded. If that device also had
      // the toggle ON, the relic's `!plugins/*/data.json` is the LAST
      // rule matching the path, so it out-ranks our new OFF block above
      // it and third-party data.json start travelling again.
      //
      // Not a token leak: our own and the pre-rename plugin's files are
      // held by L1 + L3 above, independently of this file. It is the
      // toggle silently reading ON when the settings tab shows OFF —
      // a correctness wart with a privacy edge (another plugin's
      // secrets could travel without the user re-consenting).
      //
      // Fix is a decision for the owner: neutralise a stale allow line
      // outside our block (mutates user content), re-seed the catch-all,
      // or leave it documented. Flip to a normal `it` when it lands.
      const f = makeFixture();
      f.write(`${CONFIG_DIR}/.gitignore`, RELIC_ON);
      await f.inv.enforce();
      expect(
        await f.syncable(`${CONFIG_DIR}/plugins/${OTHER}/data.json`),
      ).toBe(false);
    },
  );
});
