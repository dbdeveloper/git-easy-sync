"use strict";
// Stage A — a plugin that LOADS. Install this one, enable it, and let it
// sync, so that what follows is a working plugin being updated rather
// than a broken one being installed.
const obsidian = require("obsidian");

module.exports = class ReloadProbe extends obsidian.Plugin {
  async onload() {
    console.log("[reload-probe] loaded — version A");
  }
  onunload() {
    console.log("[reload-probe] unloaded");
  }
};
