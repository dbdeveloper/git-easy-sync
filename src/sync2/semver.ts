// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// THE semver comparison — one of them, deliberately (PLUGIN-UPDATE-COMPAT
// §5.11). Three places need to ask "which of these two versions is
// newer", and each of them fails silently on a wrong answer:
//
//   1. the managed-section yield rule (§5.11) — a wrong answer makes an
//      older plugin overwrite a newer one's rules, i.e. the ping-pong
//      the rule exists to stop;
//   2. the `requireApiVersion` mock behind Phase 1's tests (§6.0) — a
//      stub that truncates to major.minor turns the reload gate's whole
//      test table green without testing anything;
//   3. the plugin-core resolver (§5.12.5), where the loser is a file.
//
// ⚠️ Do NOT write a second one. The rejected shortcut is comparing
// `major.minor` only: `1.13.4` and `1.13.0` fold into "1.13", compare
// equal, and the gate lets a reload through that should have been
// skipped. That exact pair is pinned in the tests.
//
// Semantics are semver 2.0.0 precedence, with the tolerances the real
// inputs need (a leading `v`, missing fields, build metadata) and one
// deliberate extension: a bare numeric SUFFIX inside an identifier
// (`beta2`) orders numerically against its siblings, because our own
// tags are spelled `2.0.3-beta2` rather than `2.0.3-beta.2`.

// null = "at least one side is not a version". NEVER 0: a corrupt stamp
// that compared equal to everything would silently hand authority to
// whoever wrote the garbage.
export function compareSemver(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;

  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }

  // A prerelease is LOWER than the release it leads to; two releases
  // with equal cores are equal.
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;

  const n = Math.min(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const c = compareIdentifier(x.pre[i], y.pre[i]);
    if (c !== 0) return c;
  }
  // Every shared identifier is equal: the shorter list sorts first.
  if (x.pre.length === y.pre.length) return 0;
  return x.pre.length < y.pre.length ? -1 : 1;
}

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

const CORE_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function parse(raw: string): Parsed | null {
  const s = raw.trim();
  if (s === "") return null;
  // Build metadata carries no precedence (semver §10).
  const noBuild = s.split("+")[0];
  const dash = noBuild.indexOf("-");
  const corePart = dash < 0 ? noBuild : noBuild.slice(0, dash);
  const prePart = dash < 0 ? "" : noBuild.slice(dash + 1);

  const m = CORE_RE.exec(corePart);
  if (m === null) return null;
  const core: [number, number, number] = [
    Number(m[1]),
    m[2] === undefined ? 0 : Number(m[2]),
    m[3] === undefined ? 0 : Number(m[3]),
  ];
  if (core.some((v) => !Number.isFinite(v))) return null;

  const pre = prePart === "" ? [] : prePart.split(".");
  // An empty identifier (`1.0.0-`, `1.0.0-a..b`) is not a version.
  if (pre.some((id) => id === "")) return null;
  return { core, pre };
}

const ALL_DIGITS = /^\d+$/;
// `beta2` → ["beta", 2]. Only a TRAILING run of digits splits: an
// identifier is otherwise compared as written.
const TRAILING_DIGITS = /^(.*?)(\d+)$/;

function compareIdentifier(a: string, b: string): number {
  const aNum = ALL_DIGITS.test(a);
  const bNum = ALL_DIGITS.test(b);
  // Numeric identifiers compare numerically and always sort BELOW
  // alphanumeric ones (semver §11.4.3).
  if (aNum && bNum) return cmpNum(Number(a), Number(b));
  if (aNum) return -1;
  if (bNum) return 1;

  // The `beta2` extension: same alphabetic stem → compare the numeric
  // tails as numbers, so beta2 < beta10. Different stems fall through
  // to the ordinary ASCII comparison.
  const am = TRAILING_DIGITS.exec(a);
  const bm = TRAILING_DIGITS.exec(b);
  if (am !== null && bm !== null && am[1] === bm[1]) {
    return cmpNum(Number(am[2]), Number(bm[2]));
  }
  // A stem alone sorts before the same stem with a number (`beta` <
  // `beta2`), which is what ASCII gives us anyway — stated so the
  // intent survives a future rewrite.
  return a < b ? -1 : a > b ? 1 : 0;
}

const cmpNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
