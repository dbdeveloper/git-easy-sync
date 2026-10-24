// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The log file carries the device label in its name (owner, 2026-10-24):
// `<plugin-id>-<label>.log`, crash log `<plugin-id>-crash-<label>.log`.
// Devices then write DIFFERENT files, so a user who lets `*.log` sync can
// collect every device's log in one vault without collisions.
//
// Owner's rules:
// - characters a file name cannot hold are replaced by allowed ones;
// - a label change RENAMES the log; when a file with the new name is
//   already there, nothing is renamed — the logger just continues in that
//   file ("the user sorts it out");
// - before data.json is read the label is "unknown";
// - two devices with the same label share a file — accepted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault, setMockPlatform } from "../mock-obsidian";
import Logger, {
  crashLogFileNameFor,
  fileSafeLabel,
  logFileNameFor,
} from "../src/logger";

const PLUGIN_ID = "git-easy-sync";

describe("log file names", () => {
  it("🔑 the device label is in both names", () => {
    expect(logFileNameFor(PLUGIN_ID, "test")).toBe("git-easy-sync-test.log");
    expect(crashLogFileNameFor(PLUGIN_ID, "test")).toBe("git-easy-sync-crash-test.log");
  });

  it("🔑 characters a file name cannot hold become '_'", () => {
    expect(fileSafeLabel('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(fileSafeLabel("tab\there\u0000nul\u007f")).toBe("tab_here_nul_");
  });

  it("a trailing dot or space (Windows drops them) becomes '_'", () => {
    expect(fileSafeLabel("phone.")).toBe("phone_");
    expect(fileSafeLabel("my phone ")).toBe("my phone_");
    expect(fileSafeLabel("x. .")).toBe("x___");
  });

  it("Cyrillic, emoji, spaces inside and dots inside stay", () => {
    expect(fileSafeLabel("Мій телефон 📱 v1.2")).toBe("Мій телефон 📱 v1.2");
  });

  it("an empty label is 'unknown' — never a name ending in '-'", () => {
    expect(fileSafeLabel("")).toBe("unknown");
    expect(logFileNameFor(PLUGIN_ID, "")).toBe("git-easy-sync-unknown.log");
  });
});

describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
  "Logger and the device label ($platform)",
  ({ platform }) => {
    let tmp: string;
    let vault: Vault;
    const file = (name: string) => path.join(tmp, name);
    const read = (name: string) => fs.readFileSync(file(name), "utf8");
    const all = (name: string) =>
      read(name)
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l).m as string);
    // The logger's own line about the move is checked separately.
    const messages = (name: string) => all(name).filter((m) => !m.startsWith("Log "));
    const make = (label: string, enabled = true) =>
      new Logger(vault as unknown as import("obsidian").Vault, PLUGIN_ID, enabled, label);
    // Appends are fire-and-forget; give the queue a moment to drain.
    const settle = () => new Promise((r) => setTimeout(r, 20));

    beforeEach(() => {
      tmp = mkdtempSync(path.join(tmpdir(), "logger-label-"));
      vault = new Vault(tmp);
      setMockPlatform(platform);
    });

    afterEach(() => {
      setMockPlatform("desktop");
      rmSync(tmp, { recursive: true, force: true });
    });

    it("🔑 writes to <plugin-id>-<label>.log, and says so", async () => {
      const logger = make("test");
      await logger.init();
      logger.info("hello");
      await settle();
      expect(logger.logPath).toBe("git-easy-sync-test.log");
      expect(messages("git-easy-sync-test.log")).toEqual(["hello"]);
      expect(fs.existsSync(file("git-easy-sync.log"))).toBe(false);
    });

    it("🔑 a label change renames the file; what was written stays, new lines follow", async () => {
      const logger = make("test");
      await logger.init();
      logger.info("before");
      await logger.setDeviceLabel("phone");
      logger.info("after");
      await settle();
      expect(fs.existsSync(file("git-easy-sync-test.log"))).toBe(false);
      expect(messages("git-easy-sync-phone.log")).toEqual(["before", "after"]);
      expect(all("git-easy-sync-phone.log")).toContain("Log file renamed after the device label");
      expect(logger.logPath).toBe("git-easy-sync-phone.log");
    });

    it("🔑 lines logged around an UNAWAITED label change all land in the new file, in order", async () => {
      const logger = make("test");
      await logger.init();
      logger.info("one");
      void logger.setDeviceLabel("phone");
      logger.info("two");
      await settle();
      expect(fs.existsSync(file("git-easy-sync-test.log"))).toBe(false);
      expect(messages("git-easy-sync-phone.log")).toEqual(["one", "two"]);
    });

    it("🔑 a file with the new name already there: no rename — continue in it, the old file stays", async () => {
      fs.writeFileSync(
        file("git-easy-sync-phone.log"),
        JSON.stringify({ t: "t", l: "INFO", m: "phone's own" }) + "\n",
      );
      const logger = make("test");
      await logger.init();
      logger.info("mine");
      await logger.setDeviceLabel("phone");
      logger.info("after");
      await settle();
      expect(messages("git-easy-sync-test.log")).toEqual(["mine"]);
      expect(messages("git-easy-sync-phone.log")).toEqual(["phone's own", "after"]);
      expect(all("git-easy-sync-phone.log").some((m) => m.startsWith("Log continues in an existing file"))).toBe(true);
    });

    it("the same label again changes nothing", async () => {
      const logger = make("test");
      await logger.init();
      logger.info("x");
      await logger.setDeviceLabel("test");
      await settle();
      expect(messages("git-easy-sync-test.log")).toEqual(["x"]);
    });

    it("logging off: a label change creates no file; turning it on uses the new name", async () => {
      const logger = make("test", false);
      await logger.init();
      await logger.setDeviceLabel("phone");
      expect(fs.readdirSync(tmp).filter((n) => n.endsWith(".log"))).toEqual([]);
      await logger.enable();
      logger.info("on");
      await settle();
      expect(messages("git-easy-sync-phone.log")).toEqual(["on"]);
    });

    it("a label with forbidden characters names the file with '_' in their place", async () => {
      const logger = make("a/b:c");
      await logger.init();
      logger.info("x");
      await settle();
      expect(messages("git-easy-sync-a_b_c.log")).toEqual(["x"]);
    });
  },
);
