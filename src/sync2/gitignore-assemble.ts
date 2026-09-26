// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §3.1.5 — LINE-WISE assembly of the managed .gitignore
// sections. Replaces the block-splice model as the MECHANISM; the
// markers, their texts and the two sections' roles are unchanged.
//
// WHY NOT BLOCKS. `spliceSection` searched for a PAIR of markers, and a
// lone BEGIN does not yield to it: the stale body stays in the file and,
// sitting below ours, wins. That is the entire reason orphan repair
// existed — record `{sha, len}` of the body we wrote, find exactly that
// span, cut it — and in the worst case it refused to guess and told the
// user. Self-healing was partial and carried a state file behind it.
//
// THE MODEL (owner, 2026-09-26), resting on two presuppositions:
//   1. our rules are few, and either global (`invariants`) or final;
//   2. a SECOND copy of one of our rules is meaningless — so it is
//      forbidden, and removed.
//
// ⚠️ (2) is a DECISION, not an observation. Under last-match-wins a
// later duplicate is an OVERRIDE, not a redundancy: `.*` written again
// below `!/.editorconfig` re-hides that file. The owner considered that
// case and forbids it — such global re-definitions confuse the rules.
// Removal must therefore be REPORTED (see `removed`), because silently
// deleting a line someone wrote is the same defect class as the silent
// refusal §4.2 had to fix.
//
// Everything here is PURE: the whole algorithm is string work, so it is
// pinned without a vault, and the byte-exact output can be asserted
// directly — which §8.0's seed marker depends on.

export interface ManagedSection {
  begin: string;
  end: string;
  // The lines between the markers. May contain blank lines; they are
  // CONSTRUCTED from this template, never searched for (see below).
  body: string;
}

export interface AssembleResult {
  content: string;
  // Texts of lines deleted because they duplicated one of ours. The
  // caller logs these — see the note on presupposition (2).
  removed: string[];
  // BEGIN markers whose interior was dropped because both of that
  // section's markers were found. Informational only — the drop is
  // unconditional, not a mode.
  replacedSections: string[];
}

// git ignores trailing whitespace in a pattern unless it is escaped, so
// `.*` and `.* ` are the SAME rule to git and must be to us. Leading
// whitespace is NOT trimmed: it is part of the pattern, and trimming it
// would let us delete an indented line that means something else.
const norm = (line: string): string => line.replace(/\s+$/, "");

const isBlank = (line: string | null): boolean =>
  line !== null && line.trim() === "";

// Same rule to git, therefore the same rule to us.
const sameLine = (a: string, b: string): boolean => norm(a) === norm(b);

// Split into lines, dropping the trailing empty element a final newline
// produces. Trailing blank lines are dropped too: the `final` section is
// anchored to EOF, and a trailing blank would leave it not-last.
function toLines(content: string): string[] {
  const lines = content.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines;
}

// Remove `lines[idx]`, then clean up after ourselves (§3.1.5).
//
//   1. non-blank above OR non-blank below → remove just the line
//   2. blank above AND blank below        → remove the line and the
//                                           blank BELOW it
//
// The file boundary counts as NON-blank (rule 1): treating "nothing
// above" as blank would cut a line we never put there. Which blank goes
// is fixed as "the one below" — either choice yields identical text, but
// the choice must be DETERMINISTIC: the idempotence test and §8.0's
// byte-exact seed match both rest on it.
function removeLineAt(lines: string[], idx: number, lowerBound: number): void {
  const above = idx - 1 >= lowerBound ? lines[idx - 1] : null;
  const below = idx + 1 < lines.length ? lines[idx + 1] : null;
  const alsoBlankBelow = isBlank(above) && isBlank(below);
  lines.splice(idx, alsoBlankBelow ? 2 : 1);
}

// Delete EVERY occurrence of `text` in [from, until), cleaning up after
// each.
//
// Deliberately SILENT: what to report is decided separately, by counting
// (see `countExtras`). Reporting from here would have to know whether a
// given copy is the user's or one of OUR other section's — the shared
// line belongs to both root blocks — and that is not a question the
// deletion mechanics can answer.
function purge(
  lines: string[],
  text: string,
  from: number,
  until: () => number,
): void {
  const want = norm(text);
  let i = from;
  while (i < until()) {
    if (norm(lines[i]) === want) {
      removeLineAt(lines, i, from);
      continue; // do not advance: the array shifted under us
    }
    i += 1;
  }
}

// Found a marker pair? Drop everything between them. Unconditionally —
// there is no second path here and no "migration mode" to look for.
//
// That one rule is why an older version's block replaces seamlessly: the
// interior goes, every body line is then simply MISSING, and the
// assembly below creates it like any other absent line. Nothing knows or
// cares that the old content came from a different version.
//
// The markers themselves stay put: they are template lines too, and the
// assembly relocates them like the rest. When a marker is absent (an
// older version whose marker TEXT differs), this finds nothing and the
// ordinary path applies — rules matching ours textually are drawn into
// place, the unrecognised markers stay in user space.
function dropSectionInterior(
  lines: string[],
  section: ManagedSection,
): boolean {
  const b = lines.findIndex((l) => norm(l) === norm(section.begin));
  if (b < 0) return false;
  const e = lines.findIndex(
    (l, i) => i > b && norm(l) === norm(section.end),
  );
  if (e < 0) return false;
  if (e - b > 1) lines.splice(b + 1, e - b - 1);
  return true;
}

// Place one section's lines at consecutive positions starting at `at`.
//
// Per template line: a BLANK line is inserted outright, a line WITH TEXT
// has every occurrence below purged first and is then inserted.
//
// ⚠️ Blank lines are never searched for. Looking one up by equality
// would match the first blank anywhere below and delete it — collapsing
// the user's formatting into a wall. They exist in the template to be
// CONSTRUCTED, nothing more.
function placeTop(lines: string[], section: ManagedSection): number {
  const template = [section.begin, ...section.body.split("\n"), section.end];
  template.forEach((line, i) => {
    // ⚠️ A line ALREADY at its canonical position is left alone, not
    // cut and re-seated. Both produce the same bytes, but re-seating
    // would report every line of an untouched file as "removed" — and
    // that report is what the user reads to learn what we deleted.
    const inPlace = i < lines.length && sameLine(lines[i], line);
    if (line.trim() === "") {
      if (!inPlace) lines.splice(i, 0, line);
      return;
    }
    purge(lines, line, inPlace ? i + 1 : i, () => lines.length);
    if (!inPlace) lines.splice(i, 0, line);
  });
  return template.length;
}

// The same, anchored to EOF and filled from the LAST line upward. The
// search range is bounded below by `lowerBound` — the top section, once
// assembled, is never touched again.
function placeBottom(
  lines: string[],
  section: ManagedSection,
  lowerBound: number,
): void {
  const template = [section.begin, ...section.body.split("\n"), section.end];
  for (let k = 0; k < template.length; k++) {
    const line = template[template.length - 1 - k];
    const at = lines.length - k; // where this line must be INSERTED
    const inPlace = at - 1 >= lowerBound && sameLine(lines[at - 1], line);
    if (line.trim() === "") {
      if (!inPlace) lines.splice(at, 0, line);
      continue;
    }
    // Everything already seated in the tail is off-limits to the search.
    // ⚠️ Computed LIVE: purge shrinks the array under us, and a bound
    // captured before it would point past the end.
    const until = () => lines.length - k - (inPlace ? 1 : 0);
    purge(lines, line, lowerBound, until);
    if (!inPlace) lines.splice(lines.length - k, 0, line);
  }
}

// Delete a section that must not be in this file at all: the marker
// pair and everything between it.
//
// A LONE marker takes only that line. The body it introduced is left
// where it is — deleting an unbounded span on a guess is how the block
// model's orphan repair ended up refusing to act at all, and here the
// stray lines are at worst inert text in a file that is about to be
// rewritten anyway.
function dropSectionEntirely(lines: string[], section: ManagedSection): void {
  const b = lines.findIndex((l) => sameLine(l, section.begin));
  const e = lines.findIndex((l, i) => i > b && sameLine(l, section.end));
  if (b >= 0 && e > b) {
    lines.splice(b, e - b + 1);
    return;
  }
  for (const marker of [section.begin, section.end]) {
    const i = lines.findIndex((l) => sameLine(l, marker));
    if (i >= 0) lines.splice(i, 1);
  }
}

// Exactly ONE blank line separates a managed block from whatever sits
// next to it — user text or the OTHER block, no exception (owner,
// 2026-09-26). Only the file's edges have no separator: the top block
// starts at line 1, the bottom block ends at EOF.
//
// The "no exception" part was a correction. Skipping the separator when
// user space is empty sounded tidy and is wrong: with nothing between
// them the two blocks would touch, and a reader could not tell where
// one policy ends and the other begins.
//
// Both are no-ops when the blank is already there, which is what keeps
// a second pass byte-identical.
function separateBelow(lines: string[], at: number): void {
  if (at < lines.length && lines[at].trim() !== "") lines.splice(at, 0, "");
}

function separateAbove(lines: string[], at: number): void {
  if (at > 0 && lines[at - 1].trim() !== "") lines.splice(at, 0, "");
}

// How many copies of each of our lines the file holds BEYOND what our
// sections need — those, and only those, are the user's duplicates.
//
// ⚠️ "Beyond what we need" is not "more than one". The line
// "# Editing this block triggers a rewrite to canonical on next load."
// belongs to BOTH root sections, so two copies are correct and a naive
// count would report one as removed on every single pass — the content
// would be idempotent while the report was not.
function countExtras(lines: string[], sections: ManagedSection[]): string[] {
  const need = new Map<string, number>();
  for (const s of sections) {
    for (const line of [s.begin, ...s.body.split("\n"), s.end]) {
      if (line.trim() === "") continue;
      need.set(norm(line), (need.get(norm(line)) ?? 0) + 1);
    }
  }
  const extras: string[] = [];
  for (const [text, want] of need) {
    const have = lines.filter((l) => norm(l) === text).length;
    for (let i = 0; i < have - want; i++) extras.push(text);
  }
  return extras;
}

// Rebuild `existing` so that the given sections sit at their anchors and
// appear NOWHERE else.
//
// ⚠️ ORDER IS LOAD-BEARING — top first, then bottom. It is not symmetry
// that can be swapped for tidiness: the line
// "# Editing this block triggers a rewrite to canonical on next load."
// belongs to BOTH root sections. The top pass purges every occurrence,
// including the bottom's; the bottom pass then finds it missing and
// creates it. Reverse the passes and the bottom section loses its first
// line. Pinned by its own test.
export function assembleManagedSections(
  existing: string,
  sections: {
    invariants?: ManagedSection;
    final?: ManagedSection;
    // Sections that must NOT exist in this file. `<configDir>/.gitignore`
    // carries a `final` section and no `invariants` one BY DESIGN
    // (§3.1.1) — but an older version put one there, and leaving it
    // would keep its per-device lines in force ABOVE the section that is
    // supposed to be the only authority in that file.
    remove?: ManagedSection[];
  },
): AssembleResult {
  const lines = toLines(existing);
  const present = [sections.invariants, sections.final].filter(
    (x): x is ManagedSection => x !== undefined,
  );
  const replacedSections: string[] = [];

  // Counted BEFORE anything is touched — the only point at which every
  // copy still exists.
  //
  // ⚠️ It has to be here, not after the interior drops. Once a section's
  // body is dropped, OUR copy and the USER's are indistinguishable:
  // they are the same text. The assembly would then quietly reuse the
  // user's line as the source and report nothing, and the removal that
  // presupposition (2) makes deliberate would become the silent kind.
  // Counting first sidesteps the question entirely: `total - need` is
  // how many copies stopped existing, whoever wrote them.
  const removed = countExtras(lines, present);

  for (const section of sections.remove ?? []) {
    dropSectionEntirely(lines, section);
  }

  for (const section of present) {
    if (dropSectionInterior(lines, section)) {
      replacedSections.push(norm(section.begin));
    }
  }

  let lowerBound = 0;
  if (sections.invariants) {
    lowerBound = placeTop(lines, sections.invariants);
    separateBelow(lines, lowerBound);
  }
  if (sections.final) {
    const height =
      2 + sections.final.body.split("\n").length;
    placeBottom(lines, sections.final, lowerBound);
    separateAbove(lines, lines.length - height);
  }

  return { content: `${lines.join("\n")}\n`, removed, replacedSections };
}
