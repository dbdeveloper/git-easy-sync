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
  re-diff. **Каскад обчислюється РІВНО ОДИН РАЗ — наживо (в `transactionFilter`); його результат (текст +
  структура) записується, а undo/redo і replay його ЗАСТОСОВУЮТЬ, НЕ переганяючи каскад знову (див. §2).**

**Наслідок:** 2.2.13 (re-diff) — спільний фінальний крок каскаду; 2.2.12 (merge) — середня ланка; paste (2.2.7) —
вхід. → **2.2.13 = фундамент, 2.2.12 = його споживач, paste = вхід каскаду.**

`diff2()` тут — той самий `buildModel`/jsdiff, що вже використовується для початкового порівняння (детермінований;
library-drift уже ловиться `joinedDocSha`-gate). Тобто «re-diff групи» = взяти ver1-контент + ver2-контент
ураженого регіону → `diff2()` → нове розбиття RangeSet для цього регіону.

---

## 2. Архітектурне рішення: «текст + прикріплені Ranges» (з /advisor + спостереження користувача)

**Спостереження користувача (точне й спрощувальне): на рівні UNDO/REDO/replay усе зводиться до «звичайна
текстова зміна + правильно прикріплені наші Ranges».** Хоч би яким складним був каскад, його РЕЗУЛЬТАТ — це
(а) `ChangeSet` (текст) і (б) новий `RangeSet` (структура diff-groups, без якої groups не працюють). Тому
**каскад обчислюється РІВНО ОДИН РАЗ — наживо**, а undo/redo і replay лише ЗАСТОСОВУЮТЬ записаний результат.

**Каскад = чисте обчислення в `transactionFilter` (live, один раз).** Фільтр перехоплює тригерну правку, читає
її ЛОКАЦІЮ (`tr.changes`: in-block → re-diff цієї групи; усунення роздільника/paste → merge-check суміжних),
проганяє каскад (merge-check → concat → re-diff → fixpoint) як ЧИСТУ функцію і ПЕРЕПИСУЄ транзакцію в один
composed-spec: `{changes, effects:[setStructure(finalRangeSet)], selection}`. Одна користувацька дія = одна
транзакція = одна undo-одиниця. **Дискримінатор локації потрібен лише ТУТ (live), на replay — ні.** (Це той самий
патерн filter-rewrite, що вже працює для резолюції scenario-2.)

**UNDO/REDO (наживо) = нативний CM6 + invertedEffects, БЕЗ повтору каскаду.** CM6 інвертує `ChangeSet` (текст);
`structureHistory = invertedEffects.of(...)` версіонує `RangeSet` (структуру) — обидва стани (до/після) вже в
history. Один Ctrl+Z відновлює і текст, і Ranges. Це **буквально** «звичайний text + наші Ranges» (вже доведено
fuzz 60/60 для резолюції).

**Replay (recovery) = застосувати ЗАПИСАНЕ, БЕЗ повтору каскаду й diff2.** Блок `history.jsonl` несе
`{change, structure?}` — `structure` лише коли tr мала `setStructure` (структурні оп: резолюція / merge / re-diff /
paste); звичайний набір → без `structure` (RangeSet авто-map-иться). Replay = `dispatch(change + (structure ?
setStructure(structure) : []))`. **Це ВЖЕ так працює для резолюції** (`history-log-v2` `EditBlock.structure?`);
каскадні оп просто роблять те саме.

→ **Каскадна складність живе ВИКЛЮЧНО в live-filter (рахується раз). Undo/redo і replay — тупе застосування
записаних `(text, structure)`. Це ПРИБИРАЄ ризик «replay мусить відтворити каскад/diff2 байт-точно» (diff2 на
replay не ганяється взагалі).**

> **Корекція мого попереднього чернеткового §2:** я писав «replay re-run-ить каскад / структура деривується на
> replay» — це НЕправильно ускладнювало. Правильно (за спостереженням користувача + існуючим механізмом
> резолюції): записуємо структуру в блок і ЗАСТОСОВУЄМО її на replay; diff2 проганяється лише наживо, раз.

**Auto-resolve (ver1==ver2 → зникнення групи) = вироджений re-diff** усередині live-filter: 0 diff-рядків →
група дропається (structure без неї), лишаються normal lines без термінального `\n`. Записується як
`(change, structure-без-групи)`; undo/replay застосовують. Найдешевший зріз 2.2.13, окремої машинерії не треба.

### 2.1 Детермінований context-dispatch (чому модель проста)

**Ключ:** ми НЕ змішуємо редагування ver-block і normal-string. Цей інваріант **вже забезпечений**: multi-cursor
OFF (§2.2.4(10)) + group-atomic selection (§2.2.6, `diff-selection.ts`) + terminal/separator guards (§2.2.4–2.2.5).
⇒ **кожна транзакція має ОДНОЗНАЧНИЙ контекст** (де приземлилась правка) → реакція = чистий dispatch:

| контекст × операція | детермінована реакція |
|---|---|
| in-line edit у **ver-block** (ми в Range) | універсальний recompute `splitModel→buildModel` (2.2.13: split/shrink/vanish) |
| in-line edit у **normal-string**, не межа груп | plain, без структурної реакції |
| Delete/Backspace/Ctrl+Y прибирає роздільник між групами | **той самий** універсальний recompute → merge «випадає» сам (gate §5: splitModel конкатенує сусідні групи, buildModel re-diff-ить; 2.2.5 п.3, 2.2.12, 1210) |
| Copy/Cut: selection в одному ver-block | plain text без term-`\n` (2.2.7 п.1) |
| Copy/Cut: selection охоплює diff-group (group-atomic) | serialize у fenced plain-text-representation (2.2.7 п.2) |
| Paste у **normal-string** | parse (fenced-block → group, інакше plain) → merge-check → cascade (2.2.7 п.3a/4/5; 2.2.12 cases 3&4) |
| Paste у **ver-block** | as-is, auto term-`\n` якщо треба → re-diff групи (2.2.7 п.3b) |
| Resolution (кнопки/hotkeys) | region-replace scenario-2 (вже реалізовано) |

**Predetermined optimal order** (живий live-filter, раз): (1) визначити контекст із `tr.changes` + структури в
точці правки; (2) обчислити реакцію — **ОДИН універсальний recompute** `splitModel(newDoc, mapped) → buildModel`
(gate §5 довів, що він покриває split/vanish/merge разом) як ЧИСТУ функцію; (3) емітнути ОДИН composed-spec
`{changes, setStructure, selection}`. Далі — §2: записуємо `(text, structure)`, undo/redo+replay застосовують.
**Уся «складність» — це таблиця вище в одному фільтрі; персистентність/undo — вже існуючий механізм.**

---

## 3. Граф залежностей

```
                ┌─────────────────────────────────────────────┐
                │  GATE-СПАЙК ✅ ПРОЙДЕНО (§5)                   │
                └───────────────────┬─────────────────────────┘
                                    │
                 ┌──────────────────▼─────────────────────────┐
                 │  УНІВЕРСАЛЬНИЙ recompute (edit-location-driven) │  = ядро
                 │  splitModel(newDoc, mapped) → buildModel        │  (split/vanish/merge — РАЗОМ)
                 └───┬───────────────┬──────────────┬────────────┘
        auto-resolve │      full 2.2.13              │  2.2.12 merge (= той самий recompute)
        (ver1==ver2) │  (split/shrink)               │  + 2.2.5 п.3 trigger (cases 1&2)
                     ▼               ▼               ▼
                                                clipboard PASTE (2.2.7) ──► merge cases 3&4

   clipboard COPY (2.2.7)  ── НЕЗАЛЕЖНА (потребує лише selection §2.2.6, вже є) ──► будь-коли
```

---

## 4. Послідовність (tightest-constraint-first)

1. **GATE-СПАЙК** (mandated 2.2.12/2.2.13) — §5 нижче. Якщо провалиться, модель «live-filter рахує каскад раз →
   записує (text, structure) → undo/redo+replay застосовують» змінюється → блокує все.
2. **Auto-resolve (ver1==ver2 → vanish)** — заявлена кінцева мета користувача + найдешевший вироджений re-diff.
   Будує мінімальний edit-location-driven recompute scaffolding. ** Shipped first.**
3. **Повний 2.2.13** (split / shrink-after / shrink-before) на тому ж scaffolding — 5 сценаріїв.
4. **2.2.12 merge cases 1&2** (Delete/Backspace-роздільника, select+Delete) + **2.2.5 п.3** trigger + Ctrl+Y.
   Concat affected-set → переви́користовує re-diff з кроку 3 (per 1210).
5. **2.2.7 clipboard COPY** — незалежна; serialize виділеної групи у fenced-блок. Слот будь-де після кроку 1.
6. **2.2.7 PASTE** (парсер fenced-блоку → вставка групи) → **розблоковує 2.2.12 cases 3&4** (paste-між-групами,
   paste-bracketed-by-groups) тими самими тригерами кроку 4.

---

## 5. Gate-спайк — ✅ ПРОЙДЕНО (2026-06-20)

**`tests/diff2/spikes/v2-restructure-replay-spike.test.ts` — 4/4 PASS, tsc-clean.** Несуча модель валідована:

1. **Augment-in-filter ПРАЦЮЄ = одна undo-одиниця.** Реальна правка (1-символьний edit / delete роздільника) →
   `transactionFilter` повертає `{changes: ширші-за-user, effects:[setStructure]}` → CM6 робить це ОДНІЄЮ
   транзакцією (`undoDepth` +1; один `undo()` відкочує і текст, і структуру через `structureHistory`/invertedEffects;
   `redo` відновлює). **Тобто follow-up-dispatch+coalesce fallback НЕ потрібен** — §2/§2.1 підтверджено.
2. **Replay застосовує ЗАПИСАНЕ** `(change, structure)` → `dispatch(change + setStructure)` → doc+RangeSet
   байт-ідентичні живому; **diff2 на replay НЕ ганяється** (механізм резолюції `EditBlock.structure?`, узагальнено).
3. **⭐ Універсальний recompute `splitModel(newDoc, mapped) → buildModel` покриває split / vanish / merge ОДНІЄЮ
   функцією** — merge-специфічна гілка НЕ потрібна. Мій початковий страх «splitModel злипає рядки при merge» був
   ХИБНИЙ: у terminal-inside моделі кожен ver-block несе власний `\n`, тож при видаленні normal-роздільника
   splitModel конкатенує сусідні групи зі збереженням меж (`"a\n"+"c\n"="a\nc\n"`), а buildModel re-diff-ить
   конкатенацію (саме семантика 2.2.12.2 + 1210). → **merge «випадає» з re-diff (2.2.13); це НЕ окремий transform.**
4. Покрито: SPLIT (1 група→2, count↑), VANISH/auto-resolve (1→0), MERGE (2→1, delete-роздільника), та
   interleave split→vanish + multi-step replay.

**Наслідок для §2.1 / §3 (спрощення):** структурна реакція — ОДИН універсальний recompute, а не dispatch
merge-vs-re-diff. (Спайк re-diff-ить весь doc для простоти; продакшн скоупить до ураженого регіону — перф, §6.)

---

### Опис гейту (для повноти — що саме доводилось)

Ціль — найскладніший interleave структурних мутацій + undo/redo + replay. Два сценарії:

```
A. type-to-split групу → undo → redo → merge двох груп → undo
B. paste-diff-group-між-двома-групами → КАСКАД (merge-check → merge → re-diff) → undo → redo
```

Довести:
- **live-filter = ОДНА транзакція:** тригерна правка + увесь каскад (concat/re-diff/split/vanish) виходять одним
  composed-spec з `setStructure(finalRangeSet)`;
- **undo-гранулярність:** ВЕСЬ каскад колапсує в ОДИН undo-крок (нативний CM6 інвертує текст + invertedEffects
  відновлює структуру) — а не 2–3. Це pass/fail гейту;
- **undo/redo** відновлюють і doc, і структуру (split назад у одну групу; merge назад у дві) БЕЗ повтору diff2;
- **replay застосовує ЗАПИСАНЕ:** блок `(change, structure)` → `dispatch(change + setStructure(structure))` →
  doc + RangeSet байт-ідентичні живому (diff2 НЕ ганяється на replay);
- **каскад (live) термінує** — re-diff після merge не тригерить нескінченний merge-check; структура
  стабілізується за 1 прохід (фікс-пойнт). Це властивість LIVE-обчислення, не replay.

Інструмент: vitest (модель-рівень) + при потребі real-Chromium harness для геометрії (як 1a/1b). Файли:
`tests/diff2/spikes/v2-restructure-replay-spike.test.ts`.

---

## 6. Ризики

- **2.2.13 ламає інваріант «вільна правка лише map-ить RangeSet; структуру ставить тільки резолюція».** Тепер
  багато правок ре-структурують → це впливає на history-feed (що пишемо), на фільтри, на replay. Записати як
  ЗМІНУ МОДЕЛІ, не add-on.
- **Live-filter має ПРОПУСКАТИ транзакції, що вже несуть структурні ефекти** (резолюції, replay-dispatch,
  власний composed-spec) — інакше подвійна обробка / рекурсія. Патерн уже є:
  `terminalProtectionFilter`/`externalGuardFilter` пропускають `setStructure`-tr. Переви́користати.
- **Undo-гранулярність** (увесь каскад = 1 undo unit) — ✅ доведено гейтом (§5).
- **⭐ Caret-story для structural ops — РІШЕННЯ УХВАЛЕНО (користувач 2026-06-20): той самий `resolveCaret`
  explicit-before/after патерн, що й резолюція (1:1).** Recompute через whole-doc replace мапить курсор втратно →
  тому каретка йде ЯВНИМИ ДАНИМИ: `resolveCaret.of({before,after})` на composed-spec, `cursorHistory`
  (invertedEffects) розносить на undo/redo, `cursorRestoreListener` застосовує (before-undo/after-redo), у
  `history.jsonl` блок несе `caret:{before,after}`, replay re-emit-ить. Механізм переноситься без змін (доведений
  fuzz 60/60, mixed-recovery). **Plain-edit (без реструктуризації) → курсор НАТИВНИЙ CM6** (як typing), resolveCaret
  не потрібен. **ЄДИНА нова робота кроку 2** — обчислити правильну `after`-позицію per-scenario: VANISH → у normal-
  текст розв'язку; SPLIT → у відповідну під-групу / новий normal-line; MERGE → у точку злиття. (Користувач історично
  чутливий саме до цього — [[project-diff-editor-rewrite-decision]].)
- **⭐ Scope до ураженого регіону — це КОРЕКТНІСТЬ+caret, не лише perf.** Універсальний recompute гейту re-diff-ить
  ВЕСЬ doc; 2.2.13 каже re-diff *цієї групи*. З normal-line якорями між групами результати зазвичай збігаються, АЛЕ
  merge свідомо прибирає якір. **Перевірити (не припускати), що правка в одній групі не зсуває tiling далекої
  групи**; scope до регіону усуває і це, і caret-втрату whole-doc-replace.
- **Каскад (LIVE) має термінувати** — фікс-пойнт за 1 прохід (replay його НЕ переганяє). Watch при scoped-recompute.
- **Перф:** recompute на кожну структурну правку/paste — наживо, раз (НЕ на replay). Групи малі → ймовірно ОК;
  scope+debounce за потреби.
- **Merge cases 3&4 залежать від PASTE** — не плутати порядок (paste перед merge-3&4).
- **(Знято гейтом) «replay мусить відтворити diff2 байт-точно»** — replay застосовує записану структуру, diff2 на
  replay не ганяється. **(Знято гейтом) «augment-in-filter може не бути 1 undo unit»** — доведено, що Є.

### 6.1 After-caret per structural op (правила користувача 2026-06-20)

`resolveCaret.after` обчислюється так (це і є «нова робота» кроку 2–4 з §6):

**VANISH / SPLIT / SHRINK (тригер = правка-в-ver) — СПІЛЬНИЙ принцип: каретка лишається на тому самому
ЛОГІЧНОМУ рядку+колонці, які користувач редагував.** Після re-diff цей рядок може стати normal (vanish — увесь
блок normal; split — редагований рядок став спільним між групами; shrink — виїхав before/after), але каретка
СЛІДУЄ за ним. Це найкращий UX (курсор лишається там, де друкували), і це **детермінований** anchor:
`(side, lineInBlock, col)` before-каретки → та сама content-позиція в re-diffed результаті.
- **VANISH** (CONFIRMED): курсор був у ver-block (ver1 чи ver2) на `(lineInBlock, col)`; група з N ver-рядків
  стає N normal-рядків → курсор на той самий `lineInBlock`-й normal-рядок, та сама `col`. Приклад: 10/10 рядків
  стали рівні, курсор був ver2 `4:10` → після → 4-й normal-рядок, col 10.
- **SPLIT** (запропоновано — знімає невизначеність користувача): редагування зробило рядок спільним → він і є
  normal-line МІЖ двома групами → каретка на нього, на `col` редагування. (Той самий «stay on edited line»
  принцип, що VANISH; для multi-line-common — рядок, на якому стояла каретка.)
- **SHRINK** (наслідок того ж принципу): рядок, що став спільним, виїхав before/after групи → каретка слідує.

**MERGE (тригер = delete роздільника) — окреме правило (CONFIRMED, користувач виправив ver2→ver1):** каретка →
**ПЕРШИЙ рядок ОСТАННЬОЇ долученої diff-group у VER1-block** (точка злиття). Для 2 груп — позиція початку ver1
другої групи в злитому ver1-блоці (у прикладі — рядок `3-`, перший рядок ver1 групи-2). Для 3 груп — початок ver1
третьої. Для двох пар (g1+g2, g3+g4 одночасно) — у другому злитому блоці (g3+g4), ver1, перший рядок g4.
Виражати як TEXT-offset (початок ver1-рядків останньої долученої групи в конкатенації); **після обов'язкового
1210-re-diff** каретка мапиться на фінальне положення цієї content-позиції.

---

## 7. Що перевикористати (валідовані CM6-факти)

- **Filter-rewrite патерн (scenario-2):** `transactionFilter` переписує транзакцію в composed-spec
  (`{changes, effects:[setStructure], selection}`). Доведено для programmatic «paste» (`userEvent:"input.paste"`
  БЕЗ OS-clipboard), undo=1 крок, invertedEffects версіонує структуру, replay детермінований
  (spike `v2-resolution-paste-spike`, 3/3). **Clipboard PASTE 2.2.7 і structural recompute йдуть тим самим
  патерном.**
- **`history-log-v2 EditBlock.structure?` + invertedEffects — ВЖЕ роблять «текст + Ranges».** Резолюція вже
  записує `structure` у блок і застосовує її на replay (`dispatch(change + setStructure(structure))`), а
  invertedEffects (`structureHistory`) дає undo/redo. **Каскадні оп (merge/re-diff/paste) — той самий механізм,
  лише складніший `structure`-результат.** Нічого нового в персистентному шарі.
- **Selection §2.2.6** (group-atomic legalization) вже є в `diff-selection.ts` (`legalizeSelection`/`groupsOf`/
  `selectionLegalizeFilter`) — фундамент для clipboard COPY.
- **`diff2()`/`buildModel`** детермінований — але потрібен лише НАЖИВО (раз, у live-filter). На replay структура
  береться з блоку, тож replay від diff2-детермінізму НЕ залежить (зайвий клас ризиків знято).
- **OS-clipboard для diff-group COPY/PASTE — потрібен** (на відміну від резолюції): копіюємо/вставляємо plain
  unicode-текст у fenced-форматі §2.2.7; парсер-фільтр конвертує назад у normal-region (all-or-nothing escape).
