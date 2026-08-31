// Autosave-directory foundation for the diff-editor (DIFF-EDITOR.md §2.4–§2.5;
// Stage 2.0). This is the shared scaffolding the 7-step `[← back]` commit
// (Stage 2.1, §5.0 — done.json lives in this dir, TOCTOU reads meta, recovery
// scans it) AND persistent autosave (Stage 3, §2.6–§4) both build on.
//
// Location: `<configDir>/plugins/<pluginId>/.diff2-autosave/` in production
// (set at onload via setAutosaveRoot, so the autosave lives WITH the plugin's
// other data — TrashStore, .token_expired — not cluttering the vault root, and
// inside the plugin's gitignored area so it never syncs). The default below is
// a vault-root path used by the unit tests (and as back-compat).
//
// What lives here, per `<root>/.diff2-autosave/<conflictId>/`:
//   meta.json        — written LAST at session start (§2.5.a commit point)
//   base.snapshot    — byte-exact copy of basePath at session start
//   sibling.snapshot — byte-exact copy of siblingPath
//   cursor-a/b.json  — 2-slot ping-pong (§2.9); cursor-a (seq 0) at start,
//                      timer-rewritten in Stage 3 / W3 (cursor-store.ts)
//   history.jsonl    — empty at start; append-only REDO-log in Stage 3
//   done.json        — added by the Stage 2.1 commit only
//
// This module: deterministic conflict-id derivation (§2.4.1), the session-start
// protocol (§2.5.a), and reopen DETECTION (§2.5.b — returns a status; the
// recovery dialog / cleanup are Stage 3 / §4). Greenfield, not yet wired into
// the view (like the trash subsystem 9a).
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §2.4, §2.4.1, §2.5, §2.5.a, §2.5.b.
//
// Mobile: every byte write delegates to atomicWriteFile, whose Capacitor
// remove-then-rename is separately tested — this module adds no new
// write-then-rename path, so it owes no MOCK_PLATFORM=mobile test of its own.

import { normalizePath, type Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import { detectEol, toLf, commonEol } from "./eol";
import { atomicWriteFile } from "../sync2/atomic-write";
import { buildModel, serializeModel } from "./diff-model";

// The autosave root, read live by autosaveDir() / sweepAll() (ES live binding,
// so autosave-cleanup.ts sees updates). Default = vault-root (tests / back-compat);
// the plugin reconfigures it to the plugin dir at onload (setAutosaveRoot).
export let AUTOSAVE_ROOT = ".runtime/diff2-autosave";

// The trailing segment is constant; setAutosaveRoot receives the PARENT (the
// plugin dir) and appends it, so callers pass `<configDir>/plugins/<id>`. All
// plugin runtime state lives under a single `.runtime/` subfolder (2026-07-03) —
// a top-level runtime file in the plugin dir made BRAT reload-loop (see main.ts).
export const AUTOSAVE_DIRNAME = ".runtime/diff2-autosave";

// Point the autosave root at `<parentDir>/.diff2-autosave`. Called ONCE at
// plugin onload (before recoverAutosaveDirs). Idempotent.
export function setAutosaveRoot(parentDir: string): void {
  AUTOSAVE_ROOT = normalizePath(`${parentDir}/${AUTOSAVE_DIRNAME}`);
}

const utf8Decode = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);

// ── conflict-id derivation (§2.4 / §2.4.1) ───────────────────────────

// FNV-1a 64-bit over the UTF-8 bytes of `input`, as 16 lowercase hex chars.
//
// A naive single `hash * prime` overflows 2^53 and silently produces a wrong,
// collision-prone value. BigInt would be the clean fix, but this project's
// tsconfig targets ES6 (no BigInt literals), so we instead carry the 64-bit
// state as four little-endian 16-bit limbs and do the multiply limb-wise. Each
// partial product is < 2^32 and the per-limb sums are < 2^34 — comfortably
// within JS double precision, so the arithmetic is exact. Correctness is
// pinned against PUBLISHED FNV-1a-64 vectors in autosave-id.test.ts (a wrong
// multiply fails them instantly). Hashing UTF-8 bytes (not UTF-16 code units)
// keeps non-ASCII paths stable.
//
// offset basis 0xcbf29ce484222325 → LE 16-bit limbs [0x2325,0x8422,0x9ce4,0xcbf2]
// FNV prime  0x100000001b3        → LE 16-bit limbs [0x01b3,0x0000,0x0100,0x0000]
const P0 = 0x01b3;
const P2 = 0x0100; // P1 and P3 are zero
export function fnv1a64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h0 = 0x2325,
    h1 = 0x8422,
    h2 = 0x9ce4,
    h3 = 0xcbf2;
  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i]; // XOR the byte into the low limb (only low 8 bits matter)
    // (h * prime) mod 2^64, limb k = Σ_{i+j=k} h_i·p_j + carries; p1=p3=0.
    const t0 = h0 * P0;
    const t1 = h1 * P0;
    const t2 = h0 * P2 + h2 * P0;
    const t3 = h1 * P2 + h3 * P0;
    let carry = 0;
    let r = t0 + carry; carry = Math.floor(r / 0x10000); h0 = r & 0xffff;
    r = t1 + carry; carry = Math.floor(r / 0x10000); h1 = r & 0xffff;
    r = t2 + carry; carry = Math.floor(r / 0x10000); h2 = r & 0xffff;
    r = t3 + carry; h3 = r & 0xffff; // bits ≥64 fall off → mod 2^64
  }
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  return hex(h3) + hex(h2) + hex(h1) + hex(h0);
}

// §2.4/§2.4.1 — deterministic, ORDER-INDEPENDENT id for a session.
// Sort canonicalises (a,b)==(b,a); the `\0` delimiter prevents path-boundary
// collisions ("foo"+"bar" vs "foob"+"ar"). Pure: no Date.now / mtime / random.
//
// v2 port (Phase 5.5 step 3b): "tracked" joined the kinds — the v1
// ConflictStore record UUID is gone with the store, and the sibling disk
// name is deterministic, so the path pair IS a tracked conflict's stable
// identity. The kind prefix keeps a tracked and a synthetic session for
// the same pair distinct. (trackedAutosaveId(recordId) died here.)
export function deriveAutosaveId(
  // 7a.1 — "history" is a non-conflict kind. For History path1=currentFile,
  // path2=versionSha: the paths are EQUAL (base is a version of the same file), so
  // the version-sha is the sole discriminator (two versions → two ids), and the
  // kind-prefix keeps a History id distinct from a same-file synthetic conflict.
  kind: "tracked" | "synthetic" | "compare" | "history",
  path1: string,
  path2: string,
): string {
  const [first, second] = [path1, path2].sort();
  return `${kind}-${fnv1a64(`${first}\0${second}`)}`;
}

// ── paths ────────────────────────────────────────────────────────────

export function autosaveDir(conflictId: string): string {
  return normalizePath(`${AUTOSAVE_ROOT}/${conflictId}`);
}
const metaPath = (id: string) => `${autosaveDir(id)}/meta.json`;
const baseSnapshotPath = (id: string) => `${autosaveDir(id)}/base.snapshot`;
const siblingSnapshotPath = (id: string) => `${autosaveDir(id)}/sibling.snapshot`;
// Cursor slot helpers — THE single source of truth for the §2.9 ping-pong slot
// names (cursor-store.ts + classifySweep import these so naming can't drift).
export type CursorSlot = "a" | "b";
export const cursorSlotPath = (id: string, slot: CursorSlot): string =>
  `${autosaveDir(id)}/cursor-${slot}.json`;
const historyPath = (id: string) => `${autosaveDir(id)}/history.jsonl`;

// ── meta.json (§2.5) ─────────────────────────────────────────────────

export interface AutosaveMeta {
  v: 1;
  createdAt: string;
  conflictId: string;
  basePath: string;
  siblingPath: string;
  baseShaAtStart: string;
  siblingShaAtStart: string;
  // §2.5 joinedDocSha — git-blob SHA of serializeModel(buildModel(base, sibling)),
  // i.e. the V2 diff-model's clean doc + VerRange partition (see joinedDocShaV2).
  // Replaces joinAlgoVersion/joinAlgoOptions: replay is valid iff a fresh
  // buildModel reproduces this fingerprint, which detects diff-library drift
  // DIRECTLY (no version tracking). Drives the replay-validity gate in
  // classifyReopen; orthogonal to the input SHAs (which drive the dialog).
  joinedDocSha: string;
  // Whether basePath physically existed at session start. An absent base is a
  // legit conflict input (delete-vs-modify: local deleted, remote modified — the
  // sibling holds the other side). baseShaAtStart cannot encode this: an absent
  // base and a present-but-0-byte base both hash to SHA("") (e69de29…). This
  // flag is the discriminator the empty-resolution commit needs — absent base +
  // resolved-empty ⇒ deletion; present-0-byte base + resolved-empty ⇒ keep the
  // 0-byte file. DIFF2 R3.3 (2026-06-18).
  baseExistedAtStart: boolean;
  // bug-59 — the single session EOL, `commonEol(baseEol, siblingEol)` (absent base →
  // sibling's). The model works in `\n`; write-back restores THIS. Snapshots + SHAs
  // stay byte-exact/raw. Optional for back-compat: an old meta (pre-fix) parses with
  // `eol` undefined → treated as "lf" (a resumed old session writes `\n`, matching the
  // engine default).
  eol?: import("./eol").EolStyle;
}

const utf8 = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

// §2.5 (V2) — the replay-validity fingerprint: git-blob SHA of the canonical
// serialization of the V2 diff-model (clean doc + VerRange partition). Replaces
// the §1 `build()` joined `\0`/`\1` string. ONE helper used at BOTH the
// startSession write and the classifyReopen recompute, so the fingerprint can
// never drift between them. buildModel is deterministic and (unlike §1 build)
// NEVER throws — V2 has no sentinels (DIFF-EDITOR-V2 §2.1) — so this is
// reproducible from (base, sibling) alone.
function joinedDocShaV2(base: string, sibling: string): Promise<string> {
  return calculateGitBlobSHA(utf8(serializeModel(buildModel(base, sibling))));
}

// ── session-start protocol (§2.5.a) ──────────────────────────────────

// Initialise a fresh autosave session in strict order, writing meta.json
// LAST. The strong invariant this buys: **meta.json exists ⇒ all five files
// exist and meta's SHAs match the snapshot bytes** — so later recovery can
// trust meta without re-hashing snapshots (defence-in-depth still re-checks).
// Each write is itself crash-safe via atomicWriteFile (temp + rename). `nowIso`
// is injectable for deterministic tests.
//
// SINGLE-READ INVARIANT (§2.5.a): baseShaAtStart, siblingShaAtStart,
// joinedDocSha AND both snapshots all derive from ONE read of the input bytes —
// build() takes decode(baseBytes), never a separate adapter.read — so the meta
// is internally consistent (no intra-start TOCTOU). build() + joinedDocSha run
// BEFORE mkdir, so a `\0`/`\1` collision throw leaves NO autosave dir at all
// (fail before touching disk). The caller (mount §1.3) guarantees collision-
// free input in practice; here we simply let build() throw.
export async function startSession(
  vault: Vault,
  conflictId: string,
  basePath: string,
  siblingPath: string,
  nowIso: string = new Date().toISOString(),
  // 7a.1 Contract B (History) — when set, the base is a READ-ONLY historical
  // version supplied as raw bytes; it is NOT read from the vault (History has no
  // vault file for "version V", and basePath===siblingPath===currentFile so the
  // vault file holds the SIBLING side). `baseShaAtStart` is still RECOMPUTED from
  // these bytes (never a trusted caller sha) — the base snapshot is written from
  // them, so the sha MUST match or every reopen classifies corrupt→fresh. Bytes
  // must be RAW (byte-exact, pre-EOL-normalization), like a vault read. Default-
  // off ⇒ the conflict path below is textually unchanged.
  readOnlyBase?: { bytes: ArrayBuffer },
): Promise<AutosaveMeta> {
  // Steps 2–5.5 — read inputs ONCE, derive every fingerprint from those bytes.
  // An ABSENT base is a legit delete-vs-modify input — read it as 0 bytes rather
  // than letting readBinary throw ENOENT (the bug that broke opening an absent-
  // base conflict). baseExistedAtStart records the distinction SHA("") can't.
  // A History version always "existed" (History never deletes) ⇒ true.
  const baseExistedAtStart = readOnlyBase
    ? true
    : await vault.adapter.exists(basePath);
  const baseBytes = readOnlyBase
    ? readOnlyBase.bytes
    : baseExistedAtStart
    ? await vault.adapter.readBinary(basePath)
    : (new ArrayBuffer(0) as ArrayBuffer);
  const siblingBytes = await vault.adapter.readBinary(siblingPath);
  const baseShaAtStart = await calculateGitBlobSHA(baseBytes);
  const siblingShaAtStart = await calculateGitBlobSHA(siblingBytes);
  // bug-59 — EOL is detected on the RAW decoded strings, then the model works in `\n`.
  // Session EOL = commonEol of the two sides (absent base → the sibling's, the content
  // source). joinedDocSha is computed on the NORMALIZED strings so replay reproduces it.
  const baseStr = utf8Decode(baseBytes);
  const siblingStr = utf8Decode(siblingBytes);
  const siblingEol = detectEol(siblingStr);
  const eol = baseExistedAtStart ? commonEol(detectEol(baseStr), siblingEol) : siblingEol;
  const joinedDocSha = await joinedDocShaV2(toLf(baseStr), toLf(siblingStr)); // §2.5 — normalized

  await ensureDir(vault, autosaveDir(conflictId)); // step 1 (idempotent), after buildModel

  await atomicWriteFile(vault, baseSnapshotPath(conflictId), baseBytes); // 6
  await atomicWriteFile(vault, siblingSnapshotPath(conflictId), siblingBytes); // 7
  await atomicWriteFile(
    vault,
    cursorSlotPath(conflictId, "a"),
    utf8(
      JSON.stringify({
        v: 1,
        seq: 0,
        anchor: 0,
        head: 0,
        scrollTop: 0,
        savedAt: nowIso,
      }),
    ),
  ); // step 8 — §2.9 ping-pong slot A, seq 0
  await atomicWriteFile(vault, historyPath(conflictId), new ArrayBuffer(0)); // 9 (empty)

  const meta: AutosaveMeta = {
    v: 1,
    createdAt: nowIso,
    conflictId,
    basePath,
    siblingPath,
    baseShaAtStart,
    siblingShaAtStart,
    joinedDocSha,
    baseExistedAtStart,
    eol,
  };
  await atomicWriteFile(vault, metaPath(conflictId), utf8(JSON.stringify(meta))); // step 10 — COMMIT POINT
  return meta;
}

export async function readMeta(
  vault: Vault,
  conflictId: string,
): Promise<AutosaveMeta | null> {
  const p = metaPath(conflictId);
  if (!(await vault.adapter.exists(p))) return null;
  try {
    return JSON.parse(await vault.adapter.read(p)) as AutosaveMeta;
  } catch {
    return null; // corrupt meta → treat as no session (§4.2 cleanup handles the dir)
  }
}

// ── reopen classification (§3.1) — DETECTION ONLY ────────────────────

// On `openDiffPane(conflictId)` decide how to open. Returns a status; does NOT
// render the recovery dialog or run cleanup (Stage 3 §3.2/§3.2.a, §4). The
// REPLAY-VALIDITY gate is `joinedDocSha`: replay is valid iff a fresh
// buildModel(currentBase, currentSibling) reproduces meta.joinedDocSha.
//
// V2 NOTE (P6.1): buildModel is INJECTIVE (`splitModel∘buildModel === id`, the
// §0.3 round-trip), so the fingerprint is injective on (base, sibling) — UNLIKE
// the §1 claim, inputs-differ ⟹ fingerprint-differs always. The gate therefore
// collapses to: `resume ⟺ inputs byte-identical`. joinedDocSha buys EXACTLY ONE
// discrimination over a plain input-SHA compare: `library-drift` — same input
// bytes producing a DIFFERENT partition, which can only happen if the diff
// library (jsdiff) changed mid-session. That single case is its whole purpose.
//
//   resume        → joined reproduces        → §3.2 normal recovery dialog
//   library-drift → joined differs, inputs SAME → jsdiff changed; replay
//                    impossible AND restore-from-snapshot can't help either
//                    (buildModel(snapshot) ≠ joinedDocSha too) → start fresh (Notice)
//   vault-changed → joined differs, inputs DIFFER → §3.2.a (the restore path
//                    re-checks buildModel(snapshot) === joinedDocSha itself)
//   corrupt       → meta unparseable / snapshot-integrity fail / input missing
//                    → cleanup → fresh
//   sentinel      → a \0/\1 entered an input since session start (build throws)
//                    → route to the §1.3 "open externally" outcome
//   fresh         → no meta
export type ReopenStatus =
  | { kind: "fresh" }
  | { kind: "corrupt"; reason: "meta" | "snapshot-integrity" | "input-missing" }
  | { kind: "sentinel"; meta: AutosaveMeta }
  | { kind: "resume"; meta: AutosaveMeta }
  | { kind: "library-drift"; meta: AutosaveMeta }
  | {
      kind: "vault-changed";
      meta: AutosaveMeta;
      currentBaseSha: string;
      currentSiblingSha: string;
    };

export async function classifyReopen(
  vault: Vault,
  conflictId: string,
  basePath: string,
  siblingPath: string,
  // 7a.1 Contract A (History) — when true, the base side is the IMMUTABLE session
  // snapshot (the historical version), never the vault file. For History basePath
  // === siblingPath === currentFile, so reading base from the vault would pick up
  // the SIBLING content and spuriously classify vault-changed. Only the sibling is
  // re-checked against the vault. Default-off ⇒ the conflict path is unchanged.
  ignoreBase: boolean = false,
): Promise<ReopenStatus> {
  const meta = await readMeta(vault, conflictId);
  if (!meta) return { kind: "fresh" };

  // Snapshot integrity (§4.2 condition 5 / Stage-2.0-review #2): the stored
  // ground truth must still match its recorded SHA.
  if (
    !(await snapshotMatches(vault, baseSnapshotPath(conflictId), meta.baseShaAtStart)) ||
    !(await snapshotMatches(vault, siblingSnapshotPath(conflictId), meta.siblingShaAtStart))
  ) {
    return { kind: "corrupt", reason: "snapshot-integrity" };
  }

  // Current vault inputs — may be gone (interleaved sync deleted a side).
  // An absent BASE is a legit delete-vs-modify input (read as 0 bytes, matching
  // startSession); only an absent SIBLING is genuine input-loss. This lets an
  // absent-base session resume cleanly instead of falling to corrupt→fresh.
  let baseBytes: ArrayBuffer;
  let siblingBytes: ArrayBuffer;
  try {
    baseBytes = ignoreBase
      ? // Contract A — base is the immutable snapshot (already verified to hash to
        // meta.baseShaAtStart by the integrity check above), so currentBaseSha will
        // equal meta.baseShaAtStart and only the sibling drives resume/vault-changed.
        await vault.adapter.readBinary(baseSnapshotPath(conflictId))
      : (await vault.adapter.exists(basePath))
      ? await vault.adapter.readBinary(basePath)
      : (new ArrayBuffer(0) as ArrayBuffer);
    siblingBytes = await vault.adapter.readBinary(siblingPath);
  } catch {
    return { kind: "corrupt", reason: "input-missing" };
  }

  const currentBaseSha = await calculateGitBlobSHA(baseBytes);
  const currentSiblingSha = await calculateGitBlobSHA(siblingBytes);

  // The replay-validity gate (V2 fingerprint). buildModel never throws under V2
  // (no sentinels) — so the catch is now DEFENSIVE-ONLY (any unexpected hash/
  // serialize failure falls back to the safe "open externally" route). The
  // `sentinel` ReopenStatus + this try/catch retire alongside the §1.3 collision
  // check in the view-swap session; kept here so P6.1 leaves the classifier
  // branch structure untouched. A `\0` in an input is now ordinary text → it
  // shifts the fingerprint and classifies as `vault-changed`, not `sentinel`.
  let currentJoinedSha: string;
  try {
    // bug-59 — normalize to `\n` to match the stored (normalized) meta.joinedDocSha; a
    // CRLF file must not shift the replay-validity fingerprint on its own.
    currentJoinedSha = await joinedDocShaV2(
      toLf(utf8Decode(baseBytes)),
      toLf(utf8Decode(siblingBytes)),
    );
  } catch {
    return { kind: "sentinel", meta };
  }

  if (currentJoinedSha === meta.joinedDocSha) {
    return { kind: "resume", meta }; // replay valid regardless of cosmetic input diffs
  }
  const inputsMatch =
    currentBaseSha === meta.baseShaAtStart && currentSiblingSha === meta.siblingShaAtStart;
  if (inputsMatch) {
    return { kind: "library-drift", meta }; // same inputs, different joined → diff lib changed
  }
  return { kind: "vault-changed", meta, currentBaseSha, currentSiblingSha };
}

// W4c Step C — read a session's REPLAY inputs back from disk for the "continue"
// path. The session-start SNAPSHOTS (decoded the SAME way startSession computed
// joinedDocSha — `utf8Decode` / TextDecoder utf-8), so the DiffPane built from
// {base, sibling} reproduces the exact doc the recorded ChangeSets are offset
// against. Snapshots are the ground truth — NOT current vault bytes (§3.2.a
// restore + W4a correctness pin). `jsonl` is "" when history.jsonl is absent.
export interface ResumeSession {
  base: string;
  sibling: string;
  jsonl: string;
}

export async function readResumeSession(
  vault: Vault,
  conflictId: string,
): Promise<ResumeSession> {
  const baseBytes = await vault.adapter.readBinary(baseSnapshotPath(conflictId));
  const siblingBytes = await vault.adapter.readBinary(
    siblingSnapshotPath(conflictId),
  );
  const hp = historyPath(conflictId);
  const jsonl = (await vault.adapter.exists(hp))
    ? await vault.adapter.read(hp)
    : "";
  return {
    // bug-59 — snapshots are byte-exact (may be CRLF); the model works in `\n`.
    base: toLf(utf8Decode(baseBytes)),
    sibling: toLf(utf8Decode(siblingBytes)),
    jsonl,
  };
}

// ── internals ────────────────────────────────────────────────────────

async function ensureDir(vault: Vault, dir: string): Promise<void> {
  const root = normalizePath(AUTOSAVE_ROOT);
  if (!(await vault.adapter.exists(root))) await vault.adapter.mkdir(root);
  if (!(await vault.adapter.exists(dir))) await vault.adapter.mkdir(dir);
}

// True iff the snapshot file exists and its bytes hash to `expectedSha`.
async function snapshotMatches(
  vault: Vault,
  snapshotPath: string,
  expectedSha: string,
): Promise<boolean> {
  if (!(await vault.adapter.exists(snapshotPath))) return false;
  try {
    return (await calculateGitBlobSHA(await vault.adapter.readBinary(snapshotPath))) === expectedSha;
  } catch {
    return false;
  }
}
