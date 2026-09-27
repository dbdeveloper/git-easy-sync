// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §8.1.6 Крок E6 — deleting the consolidated `.gitignore` files
// from the remote, and every reason not to.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import {
  deleteMigratedFromRemote,
  type RemoteCleanupClient,
} from "../../src/sync2/gitignore-remote-cleanup";
import {
  readDoneMarker,
  DONE_MARKER_NAME,
  type MigrationDeps,
} from "../../src/sync2/gitignore-migration";

const CONFIG_DIR = ".obsidian";
const SELF = "git-easy-sync";
const RUNTIME = `${CONFIG_DIR}/plugins/${SELF}/.runtime`;

let root: string;
afterEach(() => {
  if (root && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup(pending: string[] | null): MigrationDeps {
  root = path.join(os.tmpdir(), `e6-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, RUNTIME), { recursive: true });
  if (pending !== null) {
    fs.writeFileSync(
      path.join(root, RUNTIME, DONE_MARKER_NAME),
      JSON.stringify({
        migratedAt: 1,
        sources: pending,
        remotePending: pending,
      }),
    );
  }
  return {
    vault: new Vault(root) as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF,
    dirIgnored: () => false,
    nowMs: () => 1_700_000_000_000,
  };
}

interface Call {
  entries: Array<{ path: string; sha: string | null }>;
  message: string;
  parent: string | null;
  branch: string;
}

function fakeClient(opts: {
  treePaths: string[];
  truncated?: boolean;
  pushThrows?: boolean;
  treeThrows?: boolean;
}): { client: RemoteCleanupClient; pushes: Call[] } {
  const pushes: Call[] = [];
  return {
    pushes,
    client: {
      getBranchHeadSha: async () => "head-sha",
      getCommit: async () => ({ tree: { sha: "tree-sha" } }),
      getRepoTree: async () => {
        if (opts.treeThrows) throw new Error("network down");
        return {
          files: opts.treePaths.map((p) => ({ path: p })),
          truncated: opts.truncated ?? false,
        };
      },
      pushCommitToBranch: async (args) => {
        if (opts.pushThrows) throw new Error("422");
        pushes.push({
          entries: args.entries,
          message: args.message,
          parent: args.parent,
          branch: args.branch,
        });
        return { sha: "new-head" };
      },
    },
  };
}

const run = (deps: MigrationDeps, client: RemoteCleanupClient) =>
  deleteMigratedFromRemote({
    migration: deps,
    client,
    branch: "main",
    deviceLabel: "Mac",
  });

describe("§8.1.6 remote cleanup", () => {
  it("nothing pending: one local read and no network at all", async () => {
    // This is every sync but one, so it must not cost a round trip.
    const deps = setup([]);
    let touched = false;
    const client = {
      getBranchHeadSha: async () => {
        touched = true;
        return "x";
      },
    } as unknown as RemoteCleanupClient;
    const r = await run(deps, client);
    expect(r.outcome).toBe("nothing-pending");
    expect(touched).toBe(false);
  });

  it("no marker at all is also nothing pending", async () => {
    const deps = setup(null);
    const r = await run(deps, fakeClient({ treePaths: [] }).client);
    expect(r.outcome).toBe("nothing-pending");
  });

  it("🔑 deletes only the paths ACTUALLY on the remote", async () => {
    // A redundant deletion entry — one for a path that is not there — is
    // the known `422 BadObjectState`. Filtering against the tree read in
    // this same pass is the guard, and it is why the marker stores paths
    // rather than {path, sha}.
    const deps = setup(["a/.gitignore", "b/.gitignore"]);
    const { client, pushes } = fakeClient({
      treePaths: ["a/.gitignore", "note.md"],
    });
    const r = await run(deps, client);

    expect(r.outcome).toBe("deleted");
    expect(r.deleted).toEqual(["a/.gitignore"]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].entries).toEqual([{ path: "a/.gitignore", sha: null }]);
    expect(pushes[0].parent).toBe("head-sha");
    expect(pushes[0].branch).toBe("main");
    // The message says why an ordinary-looking sync removed files the
    // engine never syncs.
    expect(pushes[0].message).toContain("nested .gitignore");
    expect(pushes[0].message).toMatch(/\(Mac\)$/);
    // Consumed.
    expect((await readDoneMarker(deps))?.remotePending).toEqual([]);
  });

  it("🔑 none on the remote: cleared WITHOUT pushing", async () => {
    // Either they never reached the server, or an earlier attempt landed
    // and only the marker write failed. Pushing anyway would be the
    // redundant deletion entry.
    const deps = setup(["a/.gitignore"]);
    const { client, pushes } = fakeClient({ treePaths: ["note.md"] });
    const r = await run(deps, client);
    expect(r.outcome).toBe("nothing-on-remote");
    expect(pushes).toEqual([]);
    expect((await readDoneMarker(deps))?.remotePending).toEqual([]);
  });

  it("🔑 a TRUNCATED tree defers — absence would prove nothing", async () => {
    // `truncated` breaks the "absent means deleted" equality the filter
    // rests on, the same reason discovery refuses one (§II.13.2). Guessing
    // would either miss a live path or send a deletion for one that never
    // existed. Waiting costs nothing because the list survives.
    const deps = setup(["a/.gitignore"]);
    const { client, pushes } = fakeClient({ treePaths: [], truncated: true });
    const r = await run(deps, client);
    expect(r.outcome).toBe("deferred-truncated");
    expect(pushes).toEqual([]);
    expect((await readDoneMarker(deps))?.remotePending).toEqual([
      "a/.gitignore",
    ]);
  });

  it("🔑 a failure KEEPS the list — a forgotten cleanup is invisible forever", async () => {
    const deps = setup(["a/.gitignore"]);
    const r = await run(
      deps,
      fakeClient({ treePaths: ["a/.gitignore"], pushThrows: true }).client,
    );
    expect(r.outcome).toBe("failed");
    expect((await readDoneMarker(deps))?.remotePending).toEqual([
      "a/.gitignore",
    ]);
  });

  it("a network failure while READING also keeps the list", async () => {
    const deps = setup(["a/.gitignore"]);
    const r = await run(
      deps,
      fakeClient({ treePaths: [], treeThrows: true }).client,
    );
    expect(r.outcome).toBe("failed");
    expect((await readDoneMarker(deps))?.remotePending).toEqual([
      "a/.gitignore",
    ]);
  });

  it("🔑 CONVERGES when the push landed but clearing did not", async () => {
    // The only window the two-write order leaves, and it must heal without
    // ever sending a second deletion entry for the same path. Second pass:
    // the path is gone from the tree → the no-push branch → cleared.
    const deps = setup(["a/.gitignore"]);
    const first = fakeClient({ treePaths: ["a/.gitignore"] });
    await run(deps, first.client);
    expect(first.pushes).toHaveLength(1);

    // Re-arm the marker to simulate the clear having failed.
    fs.writeFileSync(
      path.join(root, RUNTIME, DONE_MARKER_NAME),
      JSON.stringify({
        migratedAt: 1,
        sources: ["a/.gitignore"],
        remotePending: ["a/.gitignore"],
      }),
    );
    const second = fakeClient({ treePaths: [] }); // the push took effect
    const r = await run(deps, second.client);

    expect(r.outcome).toBe("nothing-on-remote");
    expect(second.pushes).toEqual([]); // no second deletion entry
    expect((await readDoneMarker(deps))?.remotePending).toEqual([]);
  });

  it("a second run after success is a no-op", async () => {
    const deps = setup(["a/.gitignore"]);
    await run(deps, fakeClient({ treePaths: ["a/.gitignore"] }).client);
    const again = fakeClient({ treePaths: [] });
    expect((await run(deps, again.client)).outcome).toBe("nothing-pending");
  });
});
