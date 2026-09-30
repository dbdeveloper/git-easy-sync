"use strict";
// Stage B — a plugin that CANNOT load, failing exactly the way Templater
// 2.24.3 failed on Obsidian 1.12.x (PLUGIN-UPDATE-COMPAT §2.2).
//
// ⚠️ The throw is at MODULE EVALUATION, before onload() is ever called,
// which is why no error handler inside a plugin can catch it and why
// `enablePlugin` answers `false` rather than throwing. `undefined` here
// stands in for a class that exists only in a newer Obsidian.
const obsidian = require("obsidian");

class Boom extends undefined {}

module.exports = class ReloadProbe extends obsidian.Plugin {
  async onload() {
    console.log("[reload-probe] loaded — version B (unreachable)");
  }
};
