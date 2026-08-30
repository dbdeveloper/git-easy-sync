import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII category F — sync_store + sweep (NEW-DRAIN §II.9,
// SYNC2-FIX §12.5). F.8/F.9 (vault-repair of a missing local blob,
// GitHub refetch of a missing remote blob) are CALLER contracts —
// F.8 lands with getBatch's CRASH_RECOVERY (category H), F.9 with the
// Phase-4 _diff3 wiring. F.7 (sweep runs at drain start/end + onload)
// is Phase-4/5 wiring too; the formula itself is pinned here.

const PLUGIN_ID = "git-easy-sync";

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

describe("SyncStore (§VIII F)", () => {
  let dir: string;
  let vault: Vault;
  let store: SyncStore;
  let warnings: Array<{ message: string; data?: unknown }>;

  const storeAbs = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "sync_store");

  const shaOf = (s: string): Promise<string> => calculateGitBlobSHA(enc(s));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sync-store-test-"));
    vault = new Vault(dir);
    warnings = [];
    store = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      logger: { warn: (message, data) => warnings.push({ message, data }) },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trip: save → getBlob verifies the hash and returns the bytes", async () => {
    const sha = await shaOf("hello\n");
    await store.saveBlobToSyncStore(sha, enc("hello\n"));
    const got = await store.getBlobFromSyncStore(sha, new Set());
    expect(got).not.toBeNull();
    expect(dec(got!)).toBe("hello\n");
  });

  it("F.1a (regression 2026-08-29): an intact blob is returned WITHOUT the caller knowing any size", async () => {
    // The old (sha, size) signature rejected a healthy, correctly
    // named blob whenever the caller had no size (compare() returns
    // none) — an eternal cache miss re-downloading every file. The
    // signature must not require size at all.
    const sha = await shaOf("payload");
    await store.saveBlobToSyncStore(sha, enc("payload"));
    const verified = new Set<string>();
    expect(dec((await store.getBlobFromSyncStore(sha, verified))!)).toBe(
      "payload",
    );
    expect(verified.has(sha)).toBe(true);
  });

  it("F.1/F.2 hash-on-load: right name, foreign content (no-fsync power-loss shape) → null + warning", async () => {
    const sha = await shaOf("real content");
    // Same LENGTH, different bytes — the corruption size can't catch.
    fs.mkdirSync(storeAbs(), { recursive: true });
    fs.writeFileSync(path.join(storeAbs(), sha), "fake_content"); // 12 == 12
    expect(await store.getBlobFromSyncStore(sha, new Set())).toBeNull();
    expect(warnings.length).toBe(1);

    // Truncated file → also null.
    const sha2 = await shaOf("something long enough");
    fs.writeFileSync(path.join(storeAbs(), sha2), "som");
    expect(await store.getBlobFromSyncStore(sha2, new Set())).toBeNull();
  });

  it("missing blob → null, NOT a warning (plain cache miss)", async () => {
    expect(
      await store.getBlobFromSyncStore(await shaOf("never saved"), new Set()),
    ).toBeNull();
    expect(warnings.length).toBe(0);
  });

  it("F.3: verifiedShas skips re-hashing within its scope — and trust dies with the scope", async () => {
    const sha = await shaOf("v1");
    await store.saveBlobToSyncStore(sha, enc("v1"));
    const scope = new Set<string>();
    await store.getBlobFromSyncStore(sha, scope); // earns trust

    // Corrupt the file behind the store's back. A verified-scope read
    // trusts the name and returns the (now corrupt) bytes — proof the
    // hash step was skipped (that's the documented deal: within a
    // scope, content-addressed names aren't re-checked).
    fs.writeFileSync(path.join(storeAbs(), sha), "XX");
    const trusted = await store.getBlobFromSyncStore(sha, scope);
    expect(dec(trusted!)).toBe("XX");

    // A FRESH scope re-hashes and catches the corruption.
    expect(await store.getBlobFromSyncStore(sha, new Set())).toBeNull();
  });

  it("F.4: existInSyncStore is a bare stat — a corrupt same-named copy passes it, deliberately", async () => {
    const sha = await shaOf("good");
    fs.mkdirSync(storeAbs(), { recursive: true });
    fs.writeFileSync(path.join(storeAbs(), sha), "corrupt");
    expect(await store.existInSyncStore(sha)).toBe(true); // stat only
    expect(await store.existInSyncStore(await shaOf("absent"))).toBe(false);
    // The next read catches what exist deliberately didn't.
    expect(await store.getBlobFromSyncStore(sha, new Set())).toBeNull();
  });

  it("F.5: sweep keeps blobs referenced by EACH injected source independently", async () => {
    const shas = {
      queue: await shaOf("queued"),
      journal: await shaOf("journal-base"),
      inflight: await shaOf("in-flight"),
      conflict: await shaOf("conflict-base"),
      orphan: await shaOf("orphan"),
    };
    for (const [name, sha] of Object.entries(shas)) {
      await store.saveBlobToSyncStore(sha, enc(
        name === "queue" ? "queued"
        : name === "journal" ? "journal-base"
        : name === "inflight" ? "in-flight"
        : name === "conflict" ? "conflict-base"
        : "orphan",
      ));
    }
    const sources = [
      async () => new Set([shas.queue]),
      async () => new Set([shas.journal]),
      async () => new Set([shas.inflight]),
      async () => new Set([shas.conflict]),
    ];
    const { removed, kept } = await store.sweep(sources);
    expect(removed).toBe(1);
    expect(kept).toBe(4);
    for (const sha of [shas.queue, shas.journal, shas.inflight, shas.conflict]) {
      expect(await store.existInSyncStore(sha)).toBe(true);
    }
    expect(await store.existInSyncStore(shas.orphan)).toBe(false);
  });

  it("F.6: a resolved conflict's base blob is reaped by the NEXT sweep once its source stops listing it", async () => {
    const base = await shaOf("conflict-base");
    await store.saveBlobToSyncStore(base, enc("conflict-base"));
    let unresolved = new Set([base]);
    const sources = [async () => unresolved];

    await store.sweep(sources);
    expect(await store.existInSyncStore(base)).toBe(true); // protected

    unresolved = new Set(); // conflict resolved
    await store.sweep(sources);
    expect(await store.existInSyncStore(base)).toBe(false); // reaped
  });

  it("all sources empty → sweep clears the whole store (the unconditional-cleanup case is just a special case)", async () => {
    await store.saveBlobToSyncStore(await shaOf("a"), enc("a"));
    await store.saveBlobToSyncStore(await shaOf("b"), enc("b"));
    const { removed } = await store.sweep([async () => new Set()]);
    expect(removed).toBe(2);
    expect(fs.readdirSync(storeAbs())).toEqual([]);
  });

  it("sweep on a store that never existed → no-op", async () => {
    expect(await store.sweep([])).toEqual({ removed: 0, kept: 0 });
  });

  it("§12.2 dedup shape: same content saved under one name once — a second save is harmless overwrite of identical bytes", async () => {
    const sha = await shaOf("same");
    await store.saveBlobToSyncStore(sha, enc("same"));
    await store.saveBlobToSyncStore(sha, enc("same")); // last-writer-wins, harmless
    expect(dec((await store.getBlobFromSyncStore(sha, new Set()))!)).toBe(
      "same",
    );
    expect(fs.readdirSync(storeAbs())).toHaveLength(1);
  });
});
