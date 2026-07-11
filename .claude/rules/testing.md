---
paths:
  - "tests/**"
---

# Testing reference

Loaded automatically when you work under `tests/`. The high-level command list
(`pnpm test`, `test:integration`, etc.) lives in the root `CLAUDE.md`; the deep detail
lives here so it only costs context when you're actually writing tests.

The three suites: **Unit** (pure helpers, store/queue/classifier invariants,
orchestrator under a fake client — no network, ~5 s), **Integration** (`Sync2Manager`
end-to-end against real GitHub, ~20 min), **Perf baselines** (wall-clock signal on real
GitHub upload paths, ~1 min). `pnpm build` runs `tsc -noEmit` before bundling — keep it
green.

---

Three independent suites — each in its own directory, own vitest config, own `pnpm` script. All run against the same `mock-obsidian.ts` alias (fs-backed vault stand-in); integration + perf hit the real GitHub API on top of that.

| Suite | Scope | Network | Command | Wall-clock |
|---|---|---|---|---|
| Unit | Pure helpers, store/queue/classifier invariants, orchestrator under a fake client | No | `pnpm test` | ~5 s |
| Integration | `Sync2Manager` end-to-end against real GitHub | Yes | `pnpm test:integration` | ~20 min full |
| Perf baselines | Wall-clock signal on real GitHub upload paths | Yes | `pnpm test:perf` | ~1 min |

`pnpm build` runs `tsc -noEmit` before bundling — keep it green.

### Integration env (`.env.test` at repo root)

- `GITHUB_TOKEN` — fine-grained PAT on the persistent int-test repo. Permissions: Contents R/W, Metadata R. Cannot create or delete repos — leak blast radius is one repo's contents.
- `INT_TEST_OWNER` / `INT_TEST_REPO` — that private int-test repo. Tests use branch-per-test (`int-test-<scenario>-<timestamp>-<n>`), deleted in `afterEach`. Default branch is bootstrapped lazily on first run via `ensureRepoNotBare`.
- `GITHUB_BOOTSTRAP_TOKEN` — classic PAT with `public_repo` + `delete_repo`. Only for the bootstrap suite, which must delete+recreate to regain bare state. The two-token split exists because fine-grained PATs can't create repos.
- `INT_BOOTSTRAP_TEST_REPO` — public ephemeral repo the bootstrap suite recreates. Dropped at end of run via `tests/integration/teardown.ts`.
- `INT_TEST_BRANCH_PREFIX` — defaults to `int-test`; override if multiple users share the same int-test repo.

### Test layout (`tests/integration/scenarios/sync2/`)

```
sync2/
├── bootstrap/             # A-series: bare-repo bootstrap (uses BOOTSTRAP_TOKEN)
├── adoption/              # B-series: first sync against non-bare remote
├── normalization/         # C-series: CRLF/BOM round-trips, resume strategies
├── incremental/           # D-series: post-adoption incremental flows
├── conflicts-misc/        # E-series: reconcile-onload, binary, plugin-js semver/mtime
├── edges/                 # F: special chars in paths + content edge cases
├── multi-device/          # G-series: rotation, multi-device conflicts
├── drift/                 # H-series: out-of-band drift, transient PATCH retry
├── settings-lifecycle/    # I-series: reset, syncConfigDir toggle, deviceLabel change, repo switch
├── api-failures/          # J-series: 401/429/404/network drop
├── manifest-corruption/   # K-series: corrupted snapshot manifest scenarios
├── accumulate/            # L-series: accumulate semantics + .attempted marker
├── conflicts/             # Pseudo-merge end-to-end (branch lifecycle, edit-while-in-conflict, etc.)
├── rename/                # gitignore + rename interaction
└── empty-progression.test.ts
```

Tests use **branch-per-test** on the persistent private int-test repo. Bootstrap is the exception — it needs delete+recreate, so uses the public ephemeral repo.

On the `diff2` branch, additional buckets exist: `tests/diff2/` (unit + crash-resilience for the trash subsystem) and `tests/integration/scenarios/diff2/n-series-trash/` (end-to-end against real GitHub). They run automatically under `pnpm test` / `pnpm test:integration`.

### Single-spec runs

```
pnpm vitest run tests/sync2/conflict-store.test.ts
pnpm vitest run --config vitest.integration.config.ts tests/integration/scenarios/sync2/conflicts
```

The bucket form takes a glob — `tests/integration/scenarios/sync2/conflicts*` matches both `conflicts/` and `conflicts-misc/`.

### Sync2-specific test helpers

`tests/integration/scenarios/sync2/helpers.ts`: `createSync2Client`, `Sync2TestClient`, `sync2AllAndAssertNoErrors`, `sync2FileAndAssertNoErrors`. The client owns its vault temp dir by default; pass `ownsVaultPath: false` (first instance) + `ownsVaultPath: true` (second) to share a vault across two test "sessions". Pass `autoCanonicalize: true` to opt into canonicalize for tests that exercise that codepath (helper default is `true` for back-compat with the C-series; production default is `false`).

### Fault injection

`tests/integration/helpers.ts` exports the test-side wrappers; `mock-obsidian.ts` carries the `RequestFaultInjector` itself:

- `failOnNthMatch(matcher, n, message)` — throws on the Nth matching request.
- `respondForFirstN(matcher, n, fakeResponse)` — short-circuits the first N matching requests with a synthesized HTTP response (exercises retry logic without rate-limiting the live PAT).

**Always reset in `afterEach`** via `installRequestFaultInjector(null)` — the injector is global to the vitest worker and would leak between tests otherwise.

### MOCK_PLATFORM-paired tests

`tests/mock-obsidian-platform.test.ts` parametrises a `describe.each([{platform: "desktop"}, {platform: "mobile"}])` so the same body runs under both POSIX rename semantics (overwrites silently) and Capacitor rename semantics (throws on existing destination). Use this pattern for any new test touching `adapter.rename` so a Capacitor-only regression cannot slip through.
