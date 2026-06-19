# DIFF-EDITOR-V2 — план решти роботи (інтеракційні фічі)

> **V2-редактор фактично ПРАЦЮЄ.** Модель (terminal-`\n` + Inclusive RangeSet), представлення, резолюція
> (scenario-2 region-replace), навігація (`cursorVert` крізь height:0), нумерація, персистентність
> (command-log `history-log-v2`/`history-replay-v2`), commit/recovery (representation-independent
> `commit7Step`/`recoverCommit`), absent-base + empty-resolution — **shipped на гілці `fix-diff-editor`**.
>
> Цей документ описує **ЛИШЕ останні фічі**, яких бракує:
> **§2.2.7** clipboard, **§2.2.12** злиття diff-groups, **§2.2.13** динамічний re-resolve, **§2.2.5 п.3**
> merge-trigger. Історія міграції §1→V2 (рішення Minimal-bridge, gate-спайки 1a/1b, фазовий план 0–5) —
> ВИКОНАНА і тут не дублюється. Складено з /advisor 2026-06-20.

---

## 1. Що лишилось реалізувати

| § | Фіча | Тригери | UNDO/REDO |
|---|---|---|---|
| 2.2.7 | diff-group ↔ clipboard (fenced `github-easy-sync` блок) | Ctrl+C/Ctrl+X (copy), Ctrl+V (paste) | plain edits + replay-парсер |
| 2.2.12 | злиття 2/3/4 diff-groups в одну | Delete/Backspace/Ctrl+Y/paste-між-групами | plain edits + replay |
| 2.2.13 | re-resolve: після КОЖНОЇ зміни ver-block → `diff2()` на групі | будь-яка правка ver-block | plain edits + replay |
| 2.2.5 п.3 | gesture, що ініціює злиття (єдиний `\n` між групами) | Delete/Backspace/Ctrl+Y | (тригер 2.2.12) |

**Ключове уточнення користувача (DIFF-EDITOR-V2.md:1210–1211): «ПІСЛЯ ЗЛИТТЯ ЗАВЖДИ ЗАПУСКАТИ diff2() на новій
групі (п.2.2.13)! А після paste з clipboard завжди запускати перевірку груп на злиття. Тобто це — каскадні
replay.»** Тобто recompute-реакції утворюють **КАСКАД** (пайплайн): одна користувацька дія тригерить ланцюг:

```
paste/edit  ─►  merge-check (суміжні групи?) ─► merge (concat)  ─►  re-diff (diff2 на ураженій групі)
                                                                     └► split / shrink / vanish (auto-resolve)
```

- результат 2.2.12.2 (сира конкатенація ver1s+ver2s) — ПРОМІЖНИЙ стан; фінальний вигляд = re-diffed;
- paste завжди проганяється через merge-check (бо може зробити групи суміжними), той — через merge, той — через
  re-diff. **Кожна ланка — детермінована реакція; на replay весь каскад re-run-иться з ОДНОГО plain-edit.**

**Наслідок:** 2.2.13 (re-diff) — спільний фінальний крок каскаду; 2.2.12 (merge) — середня ланка; paste (2.2.7) —
вхід. → **2.2.13 = фундамент, 2.2.12 = його споживач, paste = вхід каскаду.**

`diff2()` тут — той самий `buildModel`/jsdiff, що вже використовується для початкового порівняння (детермінований;
library-drift уже ловиться `joinedDocSha`-gate). Тобто «re-diff групи» = взяти ver1-контент + ver2-контент
ураженого регіону → `diff2()` → нове розбиття RangeSet для цього регіону.

---

## 2. Архітектурне рішення (з /advisor 2026-06-20)

**Recompute = реакція на ЛОКАЦІЮ правки (`tr.changes`), а НЕ глобальний чистий `normalizeStructure(doc)`.**
Чиста функція doc→structure не відрізнить щойно-злиту групу (concat, без re-diff) від відредагованої (треба
re-diff). Дискримінатор — де приземлилась правка:

- правка **всередині ver-block** → re-diff цієї групи (2.2.13: split / shrink-after / shrink-before / vanish);
- правка **усуває роздільник** між групами (Delete єдиного `\n`, Ctrl+Y, paste, що робить групи суміжними) →
  affected-set = суміжні групи → **concat → re-diff** (2.2.12, per 1210).

Уніфікація: «affected-set → зібрати ver1-контент + ver2-контент → `diff2()` → re-tile». Для in-block правки
affected-set = {ця група}; для merge = {суміжні групи}. **Один re-diff рушій, різний affected-set.**

**Replay-безпека (стратегія, спільна для 2.2.7 / 2.2.12 / 2.2.13 — вони всі це кажуть):** у `history.jsonl`
пишемо ТІЛЬКИ plain-edit команди (ChangeSet); recompute — детермінована **реакція** на `tr.changes`, не окремий
записаний структурний дельта-блок. Replay re-dispatch-ить ті самі зміни → та сама локація → той самий recompute
→ структура відтворюється безкоштовно. (Це той самий принцип, що вже працює для резолюції: scenario-2 пише
plain-text region-replace, а структура деривується фільтром на replay.)

**Auto-resolve (ver1==ver2 → зникнення групи) = ВИРОДЖЕНИЙ re-diff:** якщо `diff2()` ураженої групи дає 0
diff-рядків → група дропається, лишаються normal lines без термінального `\n`. Окремої машинерії не треба — це
найдешевший зріз 2.2.13.

---

## 3. Граф залежностей

```
                ┌─────────────────────────────────────────────┐
                │  GATE-СПАЙК (структурний replay + undo/redo)  │  ← блокує все
                └───────────────────┬─────────────────────────┘
                                    │
                 ┌──────────────────▼───────────────────┐
                 │  re-diff рушій (edit-location-driven) │  = ядро 2.2.13
                 │  recompute(affected-set → diff2)      │
                 └───┬───────────────┬──────────────┬────┘
        auto-resolve │      full 2.2.13              │  2.2.12 merge (concat→re-diff)
        (ver1==ver2) │  (split/shrink)               │  + 2.2.5 п.3 trigger (cases 1&2)
                     ▼               ▼               ▼
                                                clipboard PASTE (2.2.7) ──► merge cases 3&4

   clipboard COPY (2.2.7)  ── НЕЗАЛЕЖНА (потребує лише selection §2.2.6, вже є) ──► будь-коли
```

---

## 4. Послідовність (tightest-constraint-first)

1. **GATE-СПАЙК** (mandated 2.2.12/2.2.13) — §5 нижче. Якщо провалиться, модель «plain-edit-log + детермінований
   recompute» змінюється → блокує все.
2. **Auto-resolve (ver1==ver2 → vanish)** — заявлена кінцева мета користувача + найдешевший вироджений re-diff.
   Будує мінімальний edit-location-driven recompute scaffolding. ** Shipped first.**
3. **Повний 2.2.13** (split / shrink-after / shrink-before) на тому ж scaffolding — 5 сценаріїв.
4. **2.2.12 merge cases 1&2** (Delete/Backspace-роздільника, select+Delete) + **2.2.5 п.3** trigger + Ctrl+Y.
   Concat affected-set → переви́користовує re-diff з кроку 3 (per 1210).
5. **2.2.7 clipboard COPY** — незалежна; serialize виділеної групи у fenced-блок. Слот будь-де після кроку 1.
6. **2.2.7 PASTE** (парсер fenced-блоку → вставка групи) → **розблоковує 2.2.12 cases 3&4** (paste-між-групами,
   paste-bracketed-by-groups) тими самими тригерами кроку 4.

---

## 5. Gate-спайк (ОБОВ'ЯЗКОВО перед кодом)

Ціль — найскладніший interleave структурних мутацій + undo/redo + replay. Два сценарії:

```
A. type-to-split групу → undo → redo → merge двох груп → undo
B. paste-diff-group-між-двома-групами → КАСКАД (merge-check → merge → re-diff) → undo → redo
```

Довести (на ЖИВОМУ view І на replay-into-fresh view, у lockstep):
- **doc + RangeSet + курсор** відтворюються байт-точно на кожному кроці replay;
- **undo/redo** відновлюють і doc, і структуру (split назад у одну групу; merge назад у дві);
- **undo-гранулярність:** ВЕСЬ каскад (`edit → merge → re-diff`) колапсує в ОДИН undo-крок (а не 2–3 — інакше
  Ctrl+Z відкочує каскад поетапно). Це pass/fail гейту;
- **каскад детермінований і термінує** (re-diff не тригерить нескінченний merge-check — після re-diff структура
  стабільна; довести фікс-пойнт за 1 прохід).

Інструмент: vitest (модель-рівень) + при потребі real-Chromium harness для геометрії (як 1a/1b). Файли:
`tests/diff2/spikes/v2-restructure-replay-spike.test.ts`.

---

## 6. Ризики

- **2.2.13 ламає інваріант «вільна правка лише map-ить RangeSet; структуру ставить тільки резолюція».** Тепер
  багато правок ре-структурують → це впливає на history-feed (що пишемо), на фільтри, на replay. Записати як
  ЗМІНУ МОДЕЛІ, не add-on.
- **Recompute-реакція має ПРОПУСКАТИ транзакції, що вже несуть структурні ефекти** (резолюції, replay) — інакше
  подвійна обробка. Патерн уже є: `terminalProtectionFilter`/`externalGuardFilter` пропускають `setStructure`-tr.
  Переви́користати.
- **Undo-гранулярність** (увесь каскад = 1 undo unit) — pass/fail гейту (§5).
- **Каскад має термінувати й бути ідемпотентним** — re-diff після merge не повинен знову тригерити merge-check у
  нескінченність; структура стабілізується за 1 прохід (фікс-пойнт). Довести у гейті.
- **Перф:** re-diff на кожну keystroke-у-групі + каскад на paste. Групи малі → ймовірно ОК; watch-item, не блокер
  (можливий debounce).
- **Merge cases 3&4 залежать від PASTE** — не плутати порядок (paste перед merge-3&4).

---

## 7. Що перевикористати (валідовані CM6-факти)

- **Filter-rewrite патерн (scenario-2):** `transactionFilter` переписує транзакцію в composed-spec
  (`{changes, effects:[setStructure], selection}`). Доведено для programmatic «paste» (`userEvent:"input.paste"`
  БЕЗ OS-clipboard), undo=1 крок, invertedEffects версіонує структуру, replay детермінований
  (spike `v2-resolution-paste-spike`, 3/3). **Clipboard PASTE 2.2.7 і structural recompute йдуть тим самим
  патерном.**
- **Replay = re-dispatch plain edits** (command-log `history-log-v2`/`history-replay-v2`, вже shipped). Нові фічі
  НЕ зберігають структуру в логу — деривують її recompute-реакцією. Узгоджено з §0.5 DIFF-EDITOR.md.
- **Selection §2.2.6** (group-atomic legalization) вже є в `diff-selection.ts` (`legalizeSelection`/`groupsOf`/
  `selectionLegalizeFilter`) — фундамент для clipboard COPY.
- **`diff2()`/`buildModel`** детермінований; library-drift ловить `joinedDocSha`-gate — тому re-diff на replay
  відтворює ту саму структуру, що й наживо.
- **OS-clipboard для diff-group COPY/PASTE — потрібен** (на відміну від резолюції): копіюємо/вставляємо plain
  unicode-текст у fenced-форматі §2.2.7; парсер-фільтр конвертує назад у normal-region (all-or-nothing escape).
