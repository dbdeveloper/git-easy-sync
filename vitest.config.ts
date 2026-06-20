import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The diff2 suite mounts real CM6 EditorViews under happy-dom (heavy), and
    // some fuzz/replay tests do hundreds of dispatches. Under parallel load on a
    // busy machine these legitimately exceed Vitest's 5s default and time out
    // (they pass in ~1.5s standalone). Bump the ceiling so load-induced timeouts
    // stop masquerading as failures, while a genuine hang still surfaces.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests live under tests/integration/ and perf
    // baselines under tests/perf/. Both reach the real GitHub API
    // and have their own configs (vitest.integration.config.ts and
    // vitest.perf.config.ts). Keep them out of the unit run.
    exclude: [
      "**/node_modules/**",
      "tests/integration/**",
      "tests/perf/**",
    ],
    // The Obsidian runtime isn't available under Node — alias to the same
    // mock-obsidian.ts the benchmark script uses. Pure-function tests then
    // run unchanged: anything that touches the actual Obsidian API would
    // need integration-style tests, which we'll add later.
    //
    // The `src` alias mirrors tsconfig.json's baseUrl: src files use
    // bare `src/...` imports (esbuild handles them in production), so
    // vitest needs the same resolution at test time. Without it, IDE
    // runners that bypass `pnpm test` (PyCharm, VS Code) hit
    // "Cannot find package 'src/utils'" the moment a test loads any
    // file that uses the bare-import form.
    alias: {
      obsidian: path.resolve(__dirname, "mock-obsidian.ts"),
      src: path.resolve(__dirname, "src"),
    },
  },
});
