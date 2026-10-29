// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  getRemoteFileSha,
  integrationEnabled,
  uniqueBranchName,
} from "../../../helpers";
import { createSync2Client, Sync2TestClient, sync2AllAndAssertNoErrors } from "../helpers";

// GITKEEP (docs/tasks/GITKEEP.md) end to end against real GitHub, fed
// through markFolder only — the start scan and the folder events come
// with step 4, so a failure here is the commit pipeline's own:
// an empty .gitkeep per folder reaches the server (the empty blob via
// createBlob on the production path), an excluded folder's does not,
// a receiver gets the folders with 0-byte .gitkeep, and a deleted
// folder's .gitkeep is deleted on the server and on the receiver.
const EMPTY = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

describe.skipIf(!integrationEnabled())("sync2 GK1 — folders travel through .gitkeep", () => {
  let deviceA: Sync2TestClient | undefined;
  let deviceB: Sync2TestClient | undefined;
  let branch: string;

  beforeAll(async () => {
    await ensureRepoNotBare();
  });

  beforeEach(async () => {
    branch = uniqueBranchName("sync2-gk1-folders");
    const head = await getDefaultBranchHead();
    if (!head) throw new Error("default branch missing");
    await createBranchFromHead(branch, head);
  });

  afterEach(async () => {
    deviceA?.cleanup();
    deviceB?.cleanup();
    await deleteBranchIfExists(branch);
  });

  it("A's marked folders reach B as folders with an empty .gitkeep; an excluded one does not; a deletion follows", async () => {
    deviceA = await createSync2Client({ branch });
    const a = (p: string) => path.join(deviceA!.vaultPath, p);
    fs.writeFileSync(a(".gitignore"), "/notes/private/\n");
    fs.mkdirSync(a("notes/sub/deep"), { recursive: true });
    fs.mkdirSync(a("notes/private"), { recursive: true });
    fs.writeFileSync(a("notes/sub/note.md"), "hello\n");
    deviceA.manager.markFolder("notes");
    await sync2AllAndAssertNoErrors(deviceA);

    // On disk: every folder got one, the excluded one too.
    for (const p of ["notes/.gitkeep", "notes/sub/.gitkeep", "notes/sub/deep/.gitkeep", "notes/private/.gitkeep"]) {
      expect(fs.statSync(a(p)).size, p).toBe(0);
    }
    // On the server: the empty blob, and not the excluded folder.
    expect(await getRemoteFileSha(branch, "notes/.gitkeep")).toBe(EMPTY);
    expect(await getRemoteFileSha(branch, "notes/sub/.gitkeep")).toBe(EMPTY);
    expect(await getRemoteFileSha(branch, "notes/sub/deep/.gitkeep")).toBe(EMPTY);
    expect(await getRemoteFileSha(branch, "notes/private/.gitkeep")).toBeNull();

    deviceB = await createSync2Client({ branch });
    const b = (p: string) => path.join(deviceB!.vaultPath, p);
    await sync2AllAndAssertNoErrors(deviceB);
    // The empty folder exists on B only because of its .gitkeep.
    expect(fs.statSync(b("notes/sub/deep/.gitkeep")).size).toBe(0);
    expect(fs.statSync(b("notes/.gitkeep")).size).toBe(0);
    expect(fs.existsSync(b("notes/private"))).toBe(false);

    // A deletes the empty subfolder.
    fs.rmSync(a("notes/sub/deep"), { recursive: true, force: true });
    deviceA.manager.markFolder("notes/sub/deep");
    await sync2AllAndAssertNoErrors(deviceA);
    expect(await getRemoteFileSha(branch, "notes/sub/deep/.gitkeep")).toBeNull();
    expect(await getRemoteFileSha(branch, "notes/sub/.gitkeep")).toBe(EMPTY);

    await sync2AllAndAssertNoErrors(deviceB);
    expect(fs.existsSync(b("notes/sub/deep/.gitkeep"))).toBe(false);
    expect(fs.existsSync(b("notes/sub/note.md"))).toBe(true);
  });

  it("GK2: the start scan alone finds every folder; a second scan after the sync finds nothing", async () => {
    deviceA = await createSync2Client({ branch });
    const a = (p: string) => path.join(deviceA!.vaultPath, p);
    fs.mkdirSync(a("x/y"), { recursive: true });
    fs.mkdirSync(a("z"), { recursive: true });
    fs.writeFileSync(a("z/n.md"), "n\n");
    expect(await deviceA.manager.scanFolders()).toBe(3);
    await sync2AllAndAssertNoErrors(deviceA);
    for (const p of ["x/.gitkeep", "x/y/.gitkeep", "z/.gitkeep"]) {
      expect(await getRemoteFileSha(branch, p), p).toBe(EMPTY);
    }
    expect(await deviceA.manager.scanFolders()).toBe(0);
  });
});
