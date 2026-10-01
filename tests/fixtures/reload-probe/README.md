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

---

# Фаза 2 — the hold (§5.12)

A different claim from the two runs above, and the one that matters more:
an update meant for a newer Obsidian must **never reach the disk**. Not
"land and fail to load" — not arrive at all, in either direction.

Same fixture, one more payload: `main-v2.js` loads perfectly well. That
is deliberate — if the hold fails, version B loads and announces itself
in the console, so a failure is visible rather than inferred.

## Run 3 — the hold

1. Set the probe up as in Run 1 (manifest.json + `main-ok.js` as
   `main.js`), enable it, Sync so it reaches the repo. The console says
   `version A`.
2. In the repo, on your sync branch, change **both** files of
   `.obsidian/plugins/git-easy-sync-reload-probe/`:
   - `manifest.json` ← the contents of `manifest-future.json`
     (`minAppVersion: 99.0.0`)
   - `main.js` ← the contents of `main-v2.js`
3. In Obsidian — **Sync**.

**Expected**, in `<vault>/git-easy-sync.log`:

```
plugin update HELD for this Obsidian   id=... heldVersion=2.0.0 needs=99.0.0 files=2
```

…and all of this, which is the actual claim:

- `main.js` on disk is **unchanged** — still version A. The console has
  NOT printed `version B`;
- the probe keeps working. Nothing was disabled, no Notice appeared;
- **the repo is untouched** by this device. Check on GitHub: the commit
  history gains nothing for that folder. This is the symmetry half
  (§5.3) — a device that holds must not push its older copy back.

## Run 4 — nothing of ours travels while the hold is on

While the hold is in place, edit the probe's `main.js` locally (any
change — this stands in for installing an older build by hand) and
**Sync**.

**Expected**: the log says `batch entry skipped: plugin update held`,
and GitHub still shows version B. This is the one change the plugin
deliberately does NOT push (owner, 2026-10-01): under a hold the only
version installable by hand is a COMPATIBLE, i.e. OLDER, one, and
letting it travel would roll the update back on every healthy device.

## Run 5 — the lift

The hold lifts when **Obsidian** catches up, which you cannot stage on
demand for `99.0.0`. So move the condition instead — to our code the two
are indistinguishable, since the record is its only input:

1. **Quit Obsidian** (the hot pair is cached in memory; editing it while
   the plugin runs would be overwritten).
2. Open `<vault>/.obsidian/plugins/git-easy-sync/.runtime/` and compare
   `metadata-a.json` and `metadata-b.json`: take the one with the
   **higher `seq`** — that is the live slot.
3. In it, find `heldPluginUpdates` and change the probe's
   `minAppVersion` from `"99.0.0"` to `"1.0.0"`. Leave `baselines`
   exactly as they are — they are what the lift restores.
4. Start Obsidian, **Sync**.

**Expected**:

```
plugin update hold LIFTED   id=... minAppVersion=1.0.0
```

- `main.js` on disk is now version B, and the console says
  `version B (THE HOLD DID NOT HOLD)` — here that line means the lift
  worked, not that the hold failed;
- the probe was reloaded (it is in the affected set), so no restart was
  needed;
- the next Sync is quiet: no commits, no re-download. That is the
  baselines having been restored correctly — if they had not been, this
  sync would push version A back and you would see a commit.

⚠️ If step 4 reports nothing at all, check that you edited the slot with
the higher `seq`. The other one is the next write target and is about to
be overwritten.

## Cleanup

As in Run 1–2, plus: if a `heldPluginUpdates` entry for the probe is
still in the metadata, remove the plugin's folder from the repo and
Sync — the record is dropped when the lift completes.
