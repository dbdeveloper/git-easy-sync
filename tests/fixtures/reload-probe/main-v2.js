"use strict";
// Version B for the Фаза 2 run — a plugin that loads perfectly well.
// The point there is NOT a crash: it is that an update meant for a
// newer Obsidian never reaches the disk at all. If the hold fails, this
// file loads and says so, which is exactly the evidence we want.
const obsidian = require("obsidian");

module.exports = class ReloadProbe extends obsidian.Plugin {
  async onload() {
    console.log("[reload-probe] loaded — version B (THE HOLD DID NOT HOLD)");
  }
  onunload() {
    console.log("[reload-probe] unloaded");
  }
};
