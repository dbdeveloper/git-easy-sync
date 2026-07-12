# CLAUDE.md

Guidelines for Claude Code (claude.ai/code) working in this repository.

This file governs your **local behavior as an agent**. Global architecture, final
design decisions, and the judgment on whether work is actually *good* stay with the
human. When in doubt — that's who you ask.

In this workflow there are three distinct voices: **you** (the executing agent,
Claude Code), the **human** (who owns architecture and final judgment), and the
**advisor** (a model in a consulting role, invoked via `claude /advisor` — it
reviews and suggests, but does not execute). None of the three is exempt from
verification.

---

## Core rules — always apply

1. **Don't assume. Don't hide confusion.** If anything is unclear or ambiguous, say so and ask before acting. Surface trade-offs instead of silently picking one.

2. **Touch only what the task requires — no wider.** Don't edit, rename, or "improve" code the task didn't ask you to change. Clean up only the mess you made.

3. **Build the minimum that solves the task, the simplest way that works.** No speculative features (YAGNI). Do not introduce a new abstraction, class, or layer until at least two real cases already need it — until then, a plain function is the answer.

4. **Test-first where you can.** Every non-trivial pure function gets a unit test. Every non-trivial interaction gets a unit or integration test. A feature is not done until its tests are green.

5. **One small feature at a time.** Keep each step small enough that both you and the human can fully understand and verify it before moving on.

6. **Explain in plain language.** After any non-trivial step, state what you did, how, and why — so a non-expert can follow and check it. If you can't explain it simply, you don't understand it well enough yet; slow down.

7. **Document and commit every step.** One logical change per commit. Commit messages are documentation — write them for someone who will have to debug this alone, months from now, with no other context.

8. **Don't invent — check.** If you are unsure how an API behaves, what a library does, or what's in a file: read it, run it, or look it up. Never fill a gap with a plausible guess presented as fact.

9. **Doubt everything — including yourself, the human, and the advisor.** Verify against reality, not against confidence. "It should work" is not evidence; a green test, a real run, actual output is. If a claim can't be checked, treat it as unproven and say so.

---

## Before you write code — the plan must be clear

For anything with consequences, do not start coding on the first message. First:

- **This applies to decisions, not to every keystroke.** If the task is a direct, unambiguous, easily reversible change (a typo, a comment, a log message, a config value you were told to change, an obvious one-line fix), just do it — asking permission for the obvious is its own failure. The plan-and-"yes" gate is for changes with consequences: new behavior, architecture, anything hard to undo. When unsure which kind it is, treat it as the second kind.
- Restate the task, your intended approach, and the trade-offs in plain language. Get an explicit "yes" before writing any code.
- List **every** ambiguity and point of confusion up front — down to small details — and resolve them first. A plan that does not fully cohere is not ready.
- Define what "done" looks like for this task (the success criteria) here, before coding. Then loop until reality meets it.
- Uncertainty is never a reason to guess. It is a reason to ask.

## Test at a realistic scale and watch how cost grows

- You cannot know the real data size from the code alone — it lives in the product and its users, not the source. Before writing scale tests, ask: what is the realistic maximum this function will face in production, and what is a normal case? Don't guess the ceiling — get it from the human.
- Then test at that stated realistic size and at ~10× it. If time or memory grows far faster than the input (e.g., 10× input → 100× time), stop: that is hidden quadratic (or worse) behavior. Surface it as a defect, not a performance nicety.
- If the human says the input is always small and bounded (e.g. "never above 10 KB"), record that assumption in the test itself — so a future reader knows the small inputs are deliberate, not an oversight.
- "Green on small inputs" is the most dangerous kind of green when the real inputs are large. A passing test on toy data — with no known reason the data stays small — is an untested function wearing a costume.

## Refactoring is not a default action

- **Never** rename, restructure, or rewrite existing code on your own initiative. Refactoring happens **only** on an explicit human command that says "refactor".
- Even on command, refactor only when the affected area is covered by tests that could actually catch a mistake — especially tests for real edge cases. Green tests are the **precondition**, not an afterthought.
- A refactor must preserve behavior. If your change alters what the code *does*, it is not a refactor — stop and raise it as a separate decision.
- Renaming a function, file, or public interface is a structural change. Same rule: only by explicit command.
- Passing tests prove you did not break what was covered. They do **not** prove the new design is better. That judgment is the human's — ask before assuming a refactor is an improvement just because it is green.
- Optimization refactors need a measured baseline. If the stated goal of a refactor is speed or memory, measure the current cost before touching anything, and prove the improvement with the same measurement after. No benchmark before → no optimization: without a baseline you are guessing, not optimizing. And a number that improves the metric but hurts readability is not an improvement — raise it as a trade-off for the human to weigh, never decide it silently.

## When you get stuck

- If you have tried a couple of times on essentially the same approach, and it is not converging, **stop**. Say so plainly. Do not pile fix upon fix — that buries the problem instead of solving it.
- Offer the options, don't decide alone: roll back to the last green commit, or open a branch for an experiment. Let the human choose.
- A dead end named early is inexpensive. A dead end hidden is expensive.

## Creativity — welcome, but in its place

- **While planning:** propose bold, unconventional, even "dreamy" ideas freely. That is exactly where they belong.
- **Once we have agreed and started coding:** hold the line. Execute the agreed plan. Do not improvise scope, architecture, or clever detours mid-flight.
- A new idea that arrives mid-implementation: note it, park it, raise it as a separate decision. Never silently act on it.

---

*If two rules ever seem to conflict, stop and ask. Obeying one rule by quietly breaking another is worse than pausing.*

---

## What this plugin is

An Obsidian plugin that syncs a local vault with a GitHub repository using **only the GitHub REST API** — no `git` binary, no `isomorphic-git`. This constraint is deliberate so the plugin works identically on desktop and on Obsidian Mobile. Branching, rebasing, non-GitHub hosts are out of scope.

## Commands

Package manager is **pnpm** (CI uses `pnpm@latest-10`).

- `pnpm dev` — esbuild watch mode, emits `main.js` with inline sourcemaps. Set `OBSIDIAN_PLUGIN_DIR` env var to also mirror `main.js` / `manifest.json` / `styles.css` into a vault's plugin folder on every successful build (paths starting with `~/` are expanded). On macOS, IDE-set env vars don't pass through shell expansion — the config does that itself.
- `pnpm build` — typecheck (`tsc -noEmit`) then production bundle. Run before committing; CI runs the same on tag pushes.
- `pnpm test` — vitest unit suite, runs once and exits (~5 s).
- `pnpm test:watch` — vitest watch mode.
- `pnpm test:integration` — full integration suite against real GitHub (~20 min). Bootstrap suite included.
- `pnpm test:integration:bootstrap` — bootstrap suite only (~3 min).
- `pnpm test:integration:nonbootstrap` — everything except bootstrap (~17 min).
- `pnpm test:perf` — opt-in performance baselines under `tests/perf/`. Not in CI; emits `PERF_BASELINE {…}` lines.
- `pnpm benchmark` — predates the integration suite; requires SSH-accessible remote. Rarely needed; `test:integration` is preferred.

### Releases

Triggered by a pushed tag matching `[0-9].[0-9]+.[0-9]+*`; a `-beta` suffix cuts a prerelease. `npm version <ver>` runs `version-bump.mjs`, which syncs `manifest.json` and `versions.json` from `package.json`.

**`manifest-beta.json` is NOT auto-synced.** When bumping to a `-beta` version, edit it manually to match.

---

## Where to find things

- **Codebase architecture, module layout, and the design-doc map** (which spec covers what, with section-number navigation for [`SYNC2.md`](./docs/SYNC2.md) / [`PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) / the diff2 specs): [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
- **Current diff2 state / resume point:** memory `project-diff2-resume-point` + [`tasks/DIFF-EDITOR-V2.md`](./docs/tasks/DIFF-EDITOR-V2.md). This — not any prose in this repo — is the live truth for where diff2 stands.
- **Development-path log** (a LIVING, compact milestone-by-milestone diff2 summary): [`BUILDLOG.md`](./docs/BUILDLOG.md). Append a distilled entry as each milestone lands — the *why* and shape of a change that's hard to reconstruct from `git log`. The DETAILED path is the commit messages themselves (§7); `BUILDLOG.md` is their compact narrative. It is NOT frozen and NOT an archive.
- **User-facing docs** (install, settings, conflict-resolution UX, migration): [`README.md`](./README.md). **Per-release notes — RELEASES ONLY** (Keep-a-Changelog; per-shipped-version, NOT day-to-day dev progress): [`CHANGELOG.md`](./CHANGELOG.md).
- **Module-specific rules load automatically by path** (`.claude/rules/`) — you don't need to open them, Claude Code injects them when you touch matching files:
  - engine work (`src/sync2/`, `src/github/`, `src/worker/`, `src/errors.ts`) → `sync2-engine.md`
  - conflict-UI work (`src/diff2/`) → `diff2-ui.md`
  - anything under `src/` → `mobile-cross-platform.md` (the mobile / Capacitor constraints)
  - test work (`tests/`) → `testing.md`
