# Reload probe — the manual check Фаза 1 cannot automate

`docs/tasks/SYNC2-PLUGIN-UPDATE-COMPAT.md` §6.8 names this run explicitly. The unit
tests pin **our reaction** to a mocked plugin manager; they cannot prove that real
Obsidian answers `false` from `enablePlugin`, or that a module-level throw behaves the
way §2.2–§2.3 says it does. Only a device can.

It is deliberately **version-independent**: the failure is a `class extends undefined`
at module evaluation, exactly how Templater 2.24.3 died on Obsidian 1.12.x, so there is
no need to downgrade anything. ⚠️ The obvious alternative — raise `minAppVersion` and
watch the load fail — **does not work on any version**: Obsidian never checks that field
at load time (§2.1, grepped in 1.12.7 and 1.13.4).

Use a **test vault**, not a real one.

## Files

| file | what it is |
|---|---|
| `manifest.json` | the fixture's manifest, v1.0.0, loadable everywhere |
| `main-ok.js` | stage A — a plugin that loads and does nothing |
| `main-boom.js` | stage B — a plugin that throws before `onload()` |
| `manifest-future.json` | v2.0.0 with `minAppVersion: 99.0.0` — for the §4.1 gate run instead |

## Run 1 — the honest report (§4.2, §4.3)

1. In the test vault, create `.obsidian/plugins/git-easy-sync-reload-probe/` and copy
   `manifest.json` plus `main-ok.js` **renamed to `main.js`** into it.
2. Reload Obsidian, enable **Reload probe** in Community plugins. The console says
   `[reload-probe] loaded — version A`. It must be ENABLED — a disabled plugin is
   skipped before any of this is reached.
3. Sync, so the fixture reaches the repo.
4. From the OTHER device (or by committing straight into the repo), replace that
   plugin's `main.js` with `main-boom.js` and push it.
5. On the first device, Sync.

**Expected**, in `<vault>/git-easy-sync.log`:

```
BRAT-style reload scheduled   ids=["git-easy-sync-reload-probe"]
BRAT-style reload FAILED      id=... reason="enablePlugin returned false"
```

…and a Notice naming the plugin and telling you to restart Obsidian. What must NOT
appear: `BRAT-style reload done`, or any "plugin updated" toast for this id. The reason
string may instead be `no plugin instance after enable` — both are the same verdict
reached through the other half of the disjunction, and either is a pass.

The probe is now unloaded and will stay unloaded until a restart. That is the honest
outcome, not a bug: the code on disk cannot run on this Obsidian.

## Run 2 — the gate (§4.1)

Same setup, but at step 4 push **`manifest-future.json` as `manifest.json`** (keep
`main-ok.js` as `main.js` — the point is that we never get far enough to care what the
code does).

**Expected**:

```
BRAT-style reload skipped   id=... reason="needs Obsidian 99.0.0, this is 1.x.y"
```

and the probe **keeps running** — check the console/ribbon, not just the log. Nothing
was disabled, no Notice was shown. That is the whole difference between Фаза 1's two
halves: Run 1 reports damage honestly, Run 2 prevents it.

## Cleanup

Disable and delete the plugin folder in the test vault, and remove it from the repo —
otherwise it travels to every device like any other plugin.
