---
paths:
  - "src/**"
---

# Mobile / cross-platform constraints

Loaded automatically when you touch anything under `src/`. These are the platform
land-mines — several of them cause a **silent plugin crash on Obsidian Mobile at
"Enable"**, which no desktop test catches. Treat every one as load-bearing.

---

## Constraints

- **Paths** always through `normalizePath` from `obsidian` before touching the adapter.
- **Mobile support** — `isDesktopOnly: false` in `manifest.json`. Don't introduce Node-only APIs in `src/`; `benchmark.ts` and `mock-obsidian.ts` are the only Node-side files and aren't bundled. A top-level `import * as fs from "fs"` (or `path`, `os`, `crypto`, etc.) leaves a `require("fs")` at the top of the bundle (esbuild marks these external by default) and **throws on Obsidian Mobile at module load** — there is no Node runtime in the Capacitor WebView — silently crashing the plugin during "Enable" in the community-plugins list. Two valid patterns:
  - (a) use a pure-JS polyfill (`src/gi.ts` uses `path-browserify`; remove the polyfill's name from the esbuild `external` list so it gets bundled instead of `require`'d);
  - (b) wrap the `require` inside a function body with `try/catch` so it's never evaluated at module load — see `defaultReadFile` in `src/gi.ts` for the fs case (only test-time code path; production injects a vault-adapter reader instead).

  To verify, grep the production bundle: `grep -E "=require\\(\\\"fs\\\"\\)|=require\\(\\\"path\\\"\\)" main.js` must return zero matches at file scope.
- **Capacitor `rename` does not overwrite.** On iOS / Android the vault adapter's `rename` throws "Destination file already exists" when the target is occupied. POSIX `rename` overwrites silently. The portable pattern is `if (exists(dst)) await remove(dst); await rename(src, dst);`. `src/sync2/atomic-write.ts` already follows it (and every v2 sibling write goes through it — `conflict-store.ts` itself died at THE SWITCH). Any new write-then-rename path must too — pair it with a `MOCK_PLATFORM=mobile` test.
- **Settings-tab text inputs must trim user input.** Android keyboards (and several third-party iOS ones) reliably append trailing whitespace to paste operations from the suggestion bar. A token like `ghp_abc123 ` (one trailing space) makes every GitHub REST call return 404 with valid permission headers — GitHub masks "valid token, repo outside scope" as 404 to avoid leaking private-repo existence, and a whitespaced token never matches the configured repo's scope. `src/settings/tab.ts` calls `.trim()` in every `onChange` for token/owner/repo/branch, and `src/main.ts:loadSettings` runs a one-pass sanitize on read so existing installs with whitespace-poisoned values self-heal on plugin restart.
- **`vault.adapter.read` is for text only.** Use `readBinary` for anything `hasTextExtension` says false. Especially important on iOS, where the text path silently corrupts binary content.
