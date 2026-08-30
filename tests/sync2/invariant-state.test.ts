import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import InvariantStateStore from "../../src/sync2/invariant-state";

// Own-file storage for the managed-gitignore freshness markers
// (METAFILE §1.B / DOT-FILES §3.1.2 — storage form only, today's
// {mtime,hash} slot shape). The consumer-side behavior is pinned by
// gitignore-invariants.test.ts; this file pins the storage contract:
// plain write-through + the degraded mode (corrupt/missing → empty →
// the next enforce() re-derives by re-hashing real files, losing
// nothing but one pass).

const PLUGIN_ID = "git-easy-sync";

describe("InvariantStateStore", () => {
  let dir: string;
  let vault: Vault;
  let store: InvariantStateStore;

  const file = (): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "gitignore-invariants.json",
    );

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "invariant-state-test-"));
    vault = new Vault(dir);
    store = new InvariantStateStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await store.load();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty; set persists immediately (write-through, no explicit save)", async () => {
    expect(store.get()).toEqual({});
    await store.set("rootGitignore", { mtime: 5, hash: "h1" });
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    expect(raw.rootGitignore).toEqual({ mtime: 5, hash: "h1" });

    const fresh = new InvariantStateStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.get().rootGitignore).toEqual({ mtime: 5, hash: "h1" });
  });

  it("corrupt file reads as empty (degraded mode) and heals on the next set", async () => {
    await store.set("configDirGitignore", { mtime: 1, hash: "h" });
    fs.writeFileSync(file(), '{"configDirGitignore": {"mtim'); // torn

    const fresh = new InvariantStateStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.get()).toEqual({});
    await fresh.set("configDirGitignore", { mtime: 2, hash: "h2" });
    expect(JSON.parse(fs.readFileSync(file(), "utf8")).configDirGitignore).toEqual(
      { mtime: 2, hash: "h2" },
    );
  });

  it("malformed slots are dropped on load; valid ones survive", async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify({
        rootGitignore: { mtime: 3, hash: "ok" },
        selfPluginGitignore: { mtime: "bad" },
        unknownSlot: { mtime: 1, hash: "x" },
      }),
    );
    const fresh = new InvariantStateStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.get()).toEqual({ rootGitignore: { mtime: 3, hash: "ok" } });
  });
});
