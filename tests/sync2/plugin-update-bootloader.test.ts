// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { Vault as MockVault } from "../../mock-obsidian";
import {
  runSelfUpdateBootloader,
  extractAffectedPluginId,
  isOwnPluginRecoverableFile,
} from "../../src/sync2/plugin-update-bootloader";
import type { DataAdapter } from "obsidian";

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "bootloader-test-"));
  const vault = new MockVault(root) as unknown as { adapter: DataAdapter };
  const pluginDir = ".obsidian/plugins/git-easy-sync";
  return {
    root,
    adapter: vault.adapter,
    pluginDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function setup(
  adapter: DataAdapter,
  pluginDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await adapter.write(`${pluginDir}/${name}`, content);
  }
}

interface CapturedReload {
  count: number;
  delays: number[];
}

function captureReload(): {
  reloadPlugin: () => void;
  scheduleReload: (cb: () => void, delay: number) => void;
  fireDeferred: () => void;
  captured: CapturedReload;
} {
  let pending: (() => void) | null = null;
  const captured: CapturedReload = { count: 0, delays: [] };
  return {
    reloadPlugin: () => {
      captured.count += 1;
    },
    scheduleReload: (cb, delay) => {
      pending = cb;
      captured.delays.push(delay);
    },
    fireDeferred: () => {
      if (pending) {
        const cb = pending;
        pending = null;
        cb();
      }
    },
    captured,
  };
}

// Filenames used throughout. Bootloader handles main.js, manifest.json,
// and styles.css (data.json is excluded — never synced from remote).
const FILES = {
  main: {
    final: "main.js",
    tmp: "main.ges-tmp.js",
    marker: ".main.js.ges-tmp.",
    bak: "main.ges-bak.js",
  },
  manifest: {
    final: "manifest.json",
    tmp: "manifest.ges-tmp.json",
    marker: ".manifest.json.ges-tmp.",
    bak: "manifest.ges-bak.json",
  },
  styles: {
    final: "styles.css",
    tmp: "styles.ges-tmp.css",
    marker: ".styles.css.ges-tmp.",
    bak: "styles.ges-bak.css",
  },
};

describe("runSelfUpdateBootloader — marker-based recovery for main.js + manifest.json + styles.css", () => {
  it("Case D: clean state (nothing pending) → 'no-pending', no reload", async () => {
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "current-code",
        [FILES.manifest.final]: "{}",
        [FILES.styles.final]: "/* css */",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({ action: "no-pending" });
      expect(r.captured.count).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("Case C (main.js only): ges-tmp without marker → DROPPED (NOT applied), 'no-pending'", async () => {
    // The bug fix: previous SHA-comparison bootloader applied
    // unverified bytes. Marker-based bootloader drops ges-tmp
    // when marker is absent (safe — write may have been partial).
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "current-code",
        [FILES.main.tmp]: "POTENTIALLY-CORRUPTED-BYTES",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      // No files applied → overall result is no-pending (the
      // per-file cleanup happened but isn't surfaced in the
      // aggregated action).
      expect(result).toEqual({ action: "no-pending" });
      expect(r.captured.count).toBe(0);
      // Sync-tmp gone, main.js untouched (correctness — did NOT
      // apply unverified bytes).
      expect(await f.adapter.exists(`${f.pluginDir}/${FILES.main.tmp}`)).toBe(
        false,
      );
      expect(await f.adapter.read(`${f.pluginDir}/${FILES.main.final}`)).toBe(
        "current-code",
      );
    } finally {
      f.cleanup();
    }
  });

  it("Case B (main.js only): marker without ges-tmp → orphan cleaned, 'no-pending'", async () => {
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "post-apply-code",
        [FILES.main.marker]: "",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({ action: "no-pending" });
      expect(r.captured.count).toBe(0);
      expect(await f.adapter.exists(`${f.pluginDir}/${FILES.main.marker}`)).toBe(
        false,
      );
      expect(await f.adapter.read(`${f.pluginDir}/${FILES.main.final}`)).toBe(
        "post-apply-code",
      );
    } finally {
      f.cleanup();
    }
  });

  it("Case A (main.js only): marker + ges-tmp + main.js → applied, reload scheduled", async () => {
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "old-code-bytes",
        [FILES.main.tmp]: "new-code-bytes",
        [FILES.main.marker]: "",
      });
      const r = captureReload();
      const notices: string[] = [];

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
        notice: (msg) => notices.push(msg),
      });

      expect(result.action).toBe("applied");
      if (result.action === "applied") {
        expect(result.appliedFiles).toEqual(["main.js"]);
      }
      expect(r.captured.delays).toEqual([500]);
      r.fireDeferred();
      expect(r.captured.count).toBe(1);
      expect(await f.adapter.read(`${f.pluginDir}/${FILES.main.final}`)).toBe(
        "new-code-bytes",
      );
      expect(await f.adapter.exists(`${f.pluginDir}/${FILES.main.tmp}`)).toBe(
        false,
      );
      expect(await f.adapter.exists(`${f.pluginDir}/${FILES.main.marker}`)).toBe(
        false,
      );
      expect(await f.adapter.exists(`${f.pluginDir}/${FILES.main.bak}`)).toBe(
        false,
      );
      expect(notices[0].toLowerCase()).toContain("updated");
    } finally {
      f.cleanup();
    }
  });

  it("Case A (manifest.json only): pending manifest update → applied, reload scheduled", async () => {
    // Same protocol works for manifest.json (Obsidian re-reads it
    // on plugin enable; reload picks up the new declared version /
    // permissions / etc).
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "code",
        [FILES.manifest.final]: '{"version":"1.0.0"}',
        [FILES.manifest.tmp]: '{"version":"2.0.0"}',
        [FILES.manifest.marker]: "",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result.action).toBe("applied");
      if (result.action === "applied") {
        expect(result.appliedFiles).toEqual(["manifest.json"]);
      }
      expect(r.captured.delays).toEqual([500]);
      expect(
        await f.adapter.read(`${f.pluginDir}/${FILES.manifest.final}`),
      ).toBe('{"version":"2.0.0"}');
    } finally {
      f.cleanup();
    }
  });

  it("Case A (styles.css only): pending styles update → applied, reload scheduled", async () => {
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "code",
        [FILES.styles.final]: "/* old */",
        [FILES.styles.tmp]: "/* new */",
        [FILES.styles.marker]: "",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result.action).toBe("applied");
      if (result.action === "applied") {
        expect(result.appliedFiles).toEqual(["styles.css"]);
      }
      expect(r.captured.delays).toEqual([500]);
      expect(
        await f.adapter.read(`${f.pluginDir}/${FILES.styles.final}`),
      ).toBe("/* new */");
    } finally {
      f.cleanup();
    }
  });

  it("multiple files pending simultaneously: ALL applied, ONE reload scheduled", async () => {
    // Drain pulled a new plugin version where main.js + manifest.json +
    // styles.css all changed. Each gets its own marker + ges-tmp.
    // Bootloader applies all three, schedules ONE reload (Obsidian's
    // reload re-reads everything anyway).
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "old-main",
        [FILES.main.tmp]: "new-main",
        [FILES.main.marker]: "",
        [FILES.manifest.final]: "{}",
        [FILES.manifest.tmp]: '{"new":true}',
        [FILES.manifest.marker]: "",
        [FILES.styles.final]: "/* old */",
        [FILES.styles.tmp]: "/* new */",
        [FILES.styles.marker]: "",
      });
      const r = captureReload();
      const notices: { msg: string; duration?: number }[] = [];

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        pluginLabel: "git-easy-sync",
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
        notice: (msg, d) => notices.push({ msg, duration: d }),
      });

      expect(result.action).toBe("applied");
      if (result.action === "applied") {
        expect(result.appliedFiles).toEqual([
          "main.js",
          "manifest.json",
          "styles.css",
        ]);
      }
      // ONE reload, not three.
      expect(r.captured.delays).toEqual([500]);
      // ONE notice that names the plugin (not a per-file count), even
      // though three files were applied.
      expect(notices.length).toBe(1);
      expect(notices[0].msg).toBe(`Plugin "git-easy-sync" updated`);
      // All applied
      expect(await f.adapter.read(`${f.pluginDir}/${FILES.main.final}`)).toBe(
        "new-main",
      );
      expect(
        await f.adapter.read(`${f.pluginDir}/${FILES.manifest.final}`),
      ).toBe('{"new":true}');
      expect(
        await f.adapter.read(`${f.pluginDir}/${FILES.styles.final}`),
      ).toBe("/* new */");
    } finally {
      f.cleanup();
    }
  });

  it("mixed cases: main.js applied + manifest.json incomplete (no marker) + styles.css clean", async () => {
    // Drain wrote main.js fully (marker present), but crashed
    // while writing manifest.ges-tmp (no marker landed).
    // Bootloader: applies main.js, drops the incomplete
    // manifest ges-tmp, leaves styles.css alone.
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "old-main",
        [FILES.main.tmp]: "new-main",
        [FILES.main.marker]: "",
        [FILES.manifest.final]: '{"version":"1"}',
        [FILES.manifest.tmp]: "INCOMPLETE-BYTES",
        // no manifest marker
        [FILES.styles.final]: "/* css */",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result.action).toBe("applied");
      if (result.action === "applied") {
        expect(result.appliedFiles).toEqual(["main.js"]);
      }
      // main.js applied
      expect(await f.adapter.read(`${f.pluginDir}/${FILES.main.final}`)).toBe(
        "new-main",
      );
      // manifest.json untouched (incomplete ges-tmp was dropped)
      expect(
        await f.adapter.read(`${f.pluginDir}/${FILES.manifest.final}`),
      ).toBe('{"version":"1"}');
      expect(
        await f.adapter.exists(`${f.pluginDir}/${FILES.manifest.tmp}`),
      ).toBe(false);
      // styles.css untouched
      expect(
        await f.adapter.read(`${f.pluginDir}/${FILES.styles.final}`),
      ).toBe("/* css */");
    } finally {
      f.cleanup();
    }
  });

  it("Case A variant: marker + ges-tmp, main.js absent (crash between bak rename and tmp rename) → applied", async () => {
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.tmp]: "new-code-bytes",
        [FILES.main.marker]: "",
        [FILES.main.bak]: "old-code-bytes",
      });
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result.action).toBe("applied");
      expect(r.captured.delays).toEqual([500]);
      expect(await f.adapter.read(`${f.pluginDir}/${FILES.main.final}`)).toBe(
        "new-code-bytes",
      );
      expect(await f.adapter.exists(`${f.pluginDir}/${FILES.main.bak}`)).toBe(
        false,
      );
    } finally {
      f.cleanup();
    }
  });

  it("apply failure (rename throws) → returns 'failed' with failedFile, no reload", async () => {
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.final]: "old",
        [FILES.main.tmp]: "new",
        [FILES.main.marker]: "",
      });
      const adapter: DataAdapter = {
        ...f.adapter,
        exists: f.adapter.exists.bind(f.adapter),
        remove: f.adapter.remove.bind(f.adapter),
        rename: async (): Promise<void> => {
          throw new Error("simulated rename failure");
        },
      } as DataAdapter;
      const r = captureReload();

      const result = await runSelfUpdateBootloader({
        adapter,
        pluginDir: f.pluginDir,
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
      });

      expect(result).toEqual({
        action: "failed",
        reason: "apply-failed",
        failedFile: "main.js",
      });
      expect(r.captured.count).toBe(0);
      expect(r.captured.delays).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("notice names the plugin regardless of how many files applied", async () => {
    const f = makeFixture();
    try {
      await setup(f.adapter, f.pluginDir, {
        [FILES.main.tmp]: "x",
        [FILES.main.marker]: "",
        [FILES.manifest.tmp]: "{}",
        [FILES.manifest.marker]: "",
      });
      const r = captureReload();
      const notices: { msg: string; duration?: number }[] = [];

      await runSelfUpdateBootloader({
        adapter: f.adapter,
        pluginDir: f.pluginDir,
        pluginLabel: "git-easy-sync",
        reloadPlugin: r.reloadPlugin,
        scheduleReload: r.scheduleReload,
        notice: (msg, d) => notices.push({ msg, duration: d }),
      });

      // Always names the plugin, never counts files — a single reload
      // picks up any combination of applied files.
      expect(notices.length).toBe(1);
      expect(notices[0].msg).toBe(`Plugin "git-easy-sync" updated`);
      expect(notices[0].duration).toBe(3000);
    } finally {
      f.cleanup();
    }
  });
});

describe("extractAffectedPluginId — plugin file path detection", () => {
  const cfg = ".obsidian";

  it("matches each of main.js / manifest.json / styles.css / data.json", () => {
    expect(
      extractAffectedPluginId(".obsidian/plugins/some-plugin/main.js", cfg),
    ).toBe("some-plugin");
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/manifest.json",
        cfg,
      ),
    ).toBe("some-plugin");
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/styles.css",
        cfg,
      ),
    ).toBe("some-plugin");
    expect(
      extractAffectedPluginId(".obsidian/plugins/some-plugin/data.json", cfg),
    ).toBe("some-plugin");
  });

  it("rejects subdirectory files, unknown filenames, non-plugin paths", () => {
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/data/file.json",
        cfg,
      ),
    ).toBeNull();
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/some-plugin/somethingelse.txt",
        cfg,
      ),
    ).toBeNull();
    expect(extractAffectedPluginId("notes/abc.md", cfg)).toBeNull();
    expect(extractAffectedPluginId(".obsidian/themes/x.css", cfg)).toBeNull();
  });

  it("rejects bare directories + respects custom configDir + handles special IDs", () => {
    expect(
      extractAffectedPluginId(".obsidian/plugins/some-plugin/", cfg),
    ).toBeNull();
    expect(
      extractAffectedPluginId("my-config/plugins/x/main.js", "my-config"),
    ).toBe("x");
    expect(
      extractAffectedPluginId(
        ".obsidian/plugins/com.example.my-plugin/main.js",
        cfg,
      ),
    ).toBe("com.example.my-plugin");
  });
});

describe("isOwnPluginRecoverableFile — write-side bootloader routing", () => {
  const cfg = ".obsidian";
  const self = "git-easy-sync";

  it("returns true for main.js, manifest.json, styles.css under own plugin dir", () => {
    expect(
      isOwnPluginRecoverableFile(
        `${cfg}/plugins/${self}/main.js`,
        cfg,
        self,
      ),
    ).toBe(true);
    expect(
      isOwnPluginRecoverableFile(
        `${cfg}/plugins/${self}/manifest.json`,
        cfg,
        self,
      ),
    ).toBe(true);
    expect(
      isOwnPluginRecoverableFile(
        `${cfg}/plugins/${self}/styles.css`,
        cfg,
        self,
      ),
    ).toBe(true);
  });

  it("returns false for data.json (never synced from remote)", () => {
    expect(
      isOwnPluginRecoverableFile(
        `${cfg}/plugins/${self}/data.json`,
        cfg,
        self,
      ),
    ).toBe(false);
  });

  it("returns false for OTHER plugins' files", () => {
    expect(
      isOwnPluginRecoverableFile(
        `${cfg}/plugins/other-plugin/main.js`,
        cfg,
        self,
      ),
    ).toBe(false);
  });

  it("returns false for subdirectory files and non-plugin paths", () => {
    expect(
      isOwnPluginRecoverableFile(
        `${cfg}/plugins/${self}/data/x.json`,
        cfg,
        self,
      ),
    ).toBe(false);
    expect(isOwnPluginRecoverableFile("notes/a.md", cfg, self)).toBe(false);
  });
});
