// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER step 2 (spec §2.14): the logger keeps its last lines in an
// in-memory ring — EXACTLY the text written to the file, with a sequence
// number — and tells subscribers about each new line. The viewer merges
// the ring with the file it read (step 1) and then follows the
// subscription.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../mock-obsidian";
import Logger, { LOG_RING_SIZE } from "../src/logger";
import { parseLogText, mergeWithRecent } from "../src/log-viewer/log-parse";

const PLUGIN_ID = "git-easy-sync";
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("Logger ring + subscription (LOG-VIEWER step 2)", () => {
  let tmp: string;
  let vault: Vault;
  const make = (enabled = true) =>
    new Logger(vault as unknown as import("obsidian").Vault, PLUGIN_ID, enabled);
  const fileText = () => fs.readFileSync(path.join(tmp, `${PLUGIN_ID}.log`), "utf8");

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "logger-ring-"));
    vault = new Vault(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("🔑 the ring holds the EXACT lines written to the file, with rising sequence numbers", async () => {
    const log = make();
    await log.init();
    log.info("one", { a: 1 });
    log.warn("two");
    log.error("three");
    await settle();
    const ring = log.recentLines();
    expect(ring.map((r) => r.line)).toEqual(parseLogText(fileText()).lines);
    expect(ring.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("the ring keeps only the last LOG_RING_SIZE lines", async () => {
    const log = make();
    await log.init();
    for (let i = 0; i < LOG_RING_SIZE + 5; i++) log.info(`m${i}`);
    await settle();
    const ring = log.recentLines();
    expect(ring).toHaveLength(LOG_RING_SIZE);
    expect(ring[0].seq).toBe(6);
    expect(ring[ring.length - 1].seq).toBe(LOG_RING_SIZE + 5);
  });

  it("🔑 a line is in the ring BEFORE it reaches the file (so the merge never misses one on disk)", () => {
    const log = make();
    log.info("now");
    // Synchronously after the call — the append has not happened yet.
    expect(log.recentLines().map((r) => JSON.parse(r.line).message)).toEqual(["now"]);
  });

  it("subscribers get each new line once, with its number; unsubscribe stops delivery", async () => {
    const log = make();
    await log.init();
    const got: Array<{ seq: number; line: string }> = [];
    const off = log.subscribe((r) => got.push(r));
    log.info("a");
    log.info("b");
    off();
    log.info("c");
    await settle();
    expect(got.map((r) => JSON.parse(r.line).message)).toEqual(["a", "b"]);
    expect(got.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("a throwing subscriber does not break logging or the others", async () => {
    const log = make();
    await log.init();
    const got: string[] = [];
    log.subscribe(() => {
      throw new Error("boom");
    });
    log.subscribe((r) => got.push(JSON.parse(r.line).message));
    log.info("still logged");
    await settle();
    expect(got).toEqual(["still logged"]);
    expect(fileText()).toContain("still logged");
  });

  it("a disabled logger keeps nothing and sends nothing", async () => {
    const log = make(false);
    const got: unknown[] = [];
    log.subscribe((r) => got.push(r));
    log.info("x");
    await settle();
    expect(log.recentLines()).toEqual([]);
    expect(got).toEqual([]);
  });

  it("🔑 [Clean] empties the ring — the merge must not bring cleaned entries back", async () => {
    const log = make();
    await log.init();
    log.info("before clean");
    await settle();
    await log.clean();
    expect(log.recentLines()).toEqual([]);
    const m = mergeWithRecent(parseLogText(fileText()).lines, log.recentLines());
    expect(m.extra).toEqual([]);
  });

  it("🔑 disabling logging empties the ring; numbers keep rising after re-enable", async () => {
    const log = make();
    await log.init();
    log.info("old");
    await settle();
    await log.disable();
    expect(log.recentLines()).toEqual([]);
    await log.enable();
    log.info("new");
    expect(log.recentLines().map((r) => r.seq)).toEqual([2]);
  });

  it("end to end: a torn read is completed by the ring", async () => {
    const log = make();
    await log.init();
    log.info("first");
    log.info("second");
    await settle();
    const full = fileText();
    const torn = full.slice(0, full.length - 10); // read caught mid-append
    const file = parseLogText(torn);
    const m = mergeWithRecent(file.lines, log.recentLines());
    expect([...file.lines, ...m.extra.map((r) => r.line)]).toEqual(parseLogText(full).lines);
  });
});
