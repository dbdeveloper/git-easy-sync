# DIFF-EDITOR — детальна специфікація

> Канонічний документ для representation-INDEPENDENT шару diff-editor: R7.7.a
> (intra-session autosave / REDO-log + cursor-timer), R7.7.b (recovery dialog),
> cleanup-правила, `[← back]` 7-step commit, mobile-perf benchmark і round-trip
> інваріанти. **Модель представлення документа + interaction — у
> [`DIFF-EDITOR-V2.md`](./DIFF-EDITOR-V2.md)** (єдина офіційна імплементація diff-editor).
>
> [`DIFF2_IMPLEMENTATION_PLAN.md`](../DIFF2_IMPLEMENTATION_PLAN.md) тримає
> лише **cross-subsystem інтерфейси** (директорійна розкладка, що переживає
> crash, тригери cleanup, phased-rollout у `R9.1`) і вказівник сюди. Уся
> внутрішня механіка diff-editor — у цьому документі.
>
> Cross-references: [`PSEUDO-MERGE-MODE.md`](../PSEUDO-MERGE-MODE.md) §4.4
> (preserve-all-commits — durable archive **між** sync-кліками). DIFF-EDITOR
> покриває принципово **інший** рівень — intra-session, intra-chunk undo
> всередині одного відкриття DiffPane, який жодного `[Sync]` ще не бачив.

> **✅ СТАТУС: DIFF-EDITOR-V2 — ЄДИНА офіційна імплементація diff-editor у diff2** (гілка
> `fix-diff-editor`, реалізовано + device-verified). V2 **повністю замінила** ранню §1-модель —
> та була хибною гілкою і **прибрана з `src/` + `tests/` І з цього документа**: колишній §1 «R7.7
> core» (Segment[] + `\0/\1` joined-doc + §1.x поведінка) та §0.1–§0.4 §1→V2 міграційний контракт
> **ВИДАЛЕНО** — V1 більше ніде шукати не треба. Модель представлення + interaction (terminal-`\n`
> per ver-block + Inclusive RangeSet, §2.2.x) — у **[`DIFF-EDITOR-V2.md`](./DIFF-EDITOR-V2.md)**.
> Цей документ = representation-INDEPENDENT шар: §0.5 персистентність (COMMAND-LOG + карусель,
> канон), §2–§5 (autosave / recovery / cleanup / `commit7Step` + A–K recovery / trash), §6–§8.
> **bug-56 hardening (живе):** `replayHistoryV2` ЗУПИНЯЄТЬСЯ на першому непридатному блоці (не
> throw) → resume не брикається; `autoResolveFilter` пропускає `replayDispatch` (replay не
> пере-каскадить); pre-flight dry-run → чесний "NNN edits saved". **Не-фічі (майбутнє):**
> recovery-replay perf (`TODO.md`), entry-points E4/E5/E6, History/Compare/Deleted режими,
> search-панель (Ctrl+F). Live-pointer статусу — memory `project-diff2-resume-point`.

## Зміст

- §0.5. **Персистентність V2: COMMAND-LOG + «карусель» (канон)** — формат `history.jsonl`, replay, compaction
- _(§0.1–§0.4 §1→V2 міграційний контракт + §1 «R7.7 core» V1-модель — ВИДАЛЕНО; модель у [DIFF-EDITOR-V2.md](./DIFF-EDITOR-V2.md))_
- §2. R7.7.a — Persistent autosave (REDO-log + cursor-timer)
- §3. R7.7.b — Recovery dialog
- §4. Cleanup / TTL (три умови видалення)
- §5. R7.7.c / R7.7.d — interfaces (короткий референс)
- §6. Mobile append benchmark — test button у Settings
- §7. Тестовий план
- §8. Open questions / TBD

---

## §0. Модель + персистентність

> **Модель представлення документа + interaction — у [`DIFF-EDITOR-V2.md`](./DIFF-EDITOR-V2.md)**
> (terminal-`\n` per ver-block + Inclusive RangeSet + §2.2.x взаємодія); рішення/розбір — у
> [`DIFF-EDITOR-V2-ANALYSIS.md`](./DIFF-EDITOR-V2-ANALYSIS.md). V2 — єдина, реалізована й
> device-verified імплементація; рання §1-модель (Segment[] + `\0/\1` joined-doc) та її файли
> (`editor-model.ts`, `joined-doc.ts`, старий `diff-pane.ts`/`decorations.ts`, §1
> `history-log.ts`/`history-replay.ts`) **видалені з `src/` + `tests/`** — нема dual-support.
> Тут лишається **§0.5 — канон персистентності** (COMMAND-LOG + карусель):
> representation-independent, спільний з §2–§5.

### §0.5 Персистентність: COMMAND-LOG + «карусель» (канон)

Єдине джерело правди для НОВОЇ моделі персистентності. **Стратифіковано по статусу збірки** — не плутати
збудоване з планованим. Витісняє §0.2-«derive structure on replay», §0.3#2, §0.4(a) вище.

#### §0.5.1 Курсор резолюції — ✅ ЗБУДОВАНО + закомічено (`ba76415`)
CM6-native історія відновлює selection **мапінгом крізь геометрію змін** → втратно для каретки ВСЕРЕДИНІ
заміненого регіону → дрейф на undo-after-redo (доведено `v2-cm6-paste-undo-probe`). Тому резолюція несе
курсор як **явні дані**: `resolveCaret = StateEffect<{before,after}>` (diff-structure.ts) їде на forward;
`cursorHistory = invertedEffects` пропагує його на КОЖЕН undo/redo-хоп (патерн `structureHistory`);
`cursorRestoreListener` (updateListener, diff-pane-v2.ts) ставить `before` на undo / `after` на redo
selection-only `addToHistory:false` dispatch'ем (re-entrancy валідовано на view, `v2-cursor-history-view-probe`).
`before` = keyboard:курсор-натиску / pointer:`ver1.from`; `after` = кінець вставки. **Лише резолюція** несе
маркер. Звичайний typing/delete/copy/paste — **native plain-text** (рішення 2026-06-13: «максимально
стандартна plain-text поведінка, не чіпаємо»). Fuzz 60/60.

#### §0.5.2 Формат блоку — мінімальна дельта, append-only command-log
`history.jsonl` = NDJSON, по рядку на операцію. **Блок = мінімальна ДЕЛЬТА, НІКОЛИ весь документ** (відновити
3 символи → у блоці 3 символи):
- `{kind:"edit", seq, at, change, structure?, caret?, sel?, sum}` — `change`=ChangeSpec (лише змінені байти).
  `structure` (VerRange[] = **решта груп**, не doc) + `caret:{before,after}` присутні **ЛИШЕ для резолюції**
  (та `setStructure`/`resolveCaret` несе транзакція). `sel:{before:{a,h}, after:{a,h}}` (виділення ДО/ПІСЛЯ
  правки) присутнє **ЛИШЕ для звичайної правки** (НЕ резолюції — одне курсор-механізм/блок) — потрібне, щоб
  replay відтворив CM6-селекшни undo/redo точно, як у живому редакторі (інакше курсор «блукає» у відновленому
  doc на typing/paste/delete; `before` необхідний, бо чисті рухи курсора між правками НЕ записуються). Typing/
  free-edit → `change` + `sel`; резолюція → `change` + `structure` + `caret`.
- `{kind:"undo", seq, at, sum}` / `{kind:"redo", ...}` — нуль тексту.
- Writer-правило: з `tr.effects` зчитати `setStructure`→`structure`, `resolveCaret`→`caret`; для НЕ-резолюції
  записати `sel` (`tr.startState`/`tr.state` головне виділення); `tr.isUserEvent("undo"/"redo")`→{kind};
  пропускати non-docChanged + `replayDispatch`. **Replay** ставить `sel.before` (no-history, ЛИШЕ на newGroup) +
  `change` + `sel.after`; `caret` лишається на `resolveCaret`; legacy-блоки без `sel` → старий map-only fallback.

#### §0.5.3 Replay — RE-RUN COMMANDS
edit→`dispatch({changes:change, effects:[setStructure(structure)?, resolveCaret(caret)?], annotations:
[isolateHistory, replayDispatch]})`; undo→`undo(view)`; redo→`redo(view)`. **doc + структура + undo-глибина +
redo-after-crash** відновлюються бо переграємо КОМАНДИ. resolution-курсор — з reconstructed resolveCaret;
typing-курсор — native; фінал — `cursor.json` (§2.9). startState = `buildModel(base,sibling)` (V2).
`joinedDocSha` (§2.5 gate) = **`SHA(buildModel doc + serialized ranges)`** (фінгерпринт І doc, І меж груп —
diff-library drift може зсунути межі при тих самих байтах).

#### §0.5.4 Статус gate — proven-with-gap

**ТВЕРДА ВИМОГА (2026-06-13):** `history.jsonl` відтворює undo-модель редактора **БАЙТ-В-БАЙТ**. Якщо в живому
редакторі N undo-кроків глибини — у лозі рівно N edit-блоків (не рахуючи `undo`/`redo`-command-записів та
відновлених ними). Тобто **#edit-блоків на undo-стеку == жива undo-глибина**. Це робить **1b ОБОВ'ЯЗКОВИМ**
(не «або per-tx» — per-tx відкинуто): writer мусить зліплювати burst набору в 1 блок = 1 undo-група.

- ✅ **per-tx шлях** (`v2-mixed-recovery-spike`, 2026-06-13): змішана сесія type→resolve→type→resolve→undo×2
  →redo×1 через РЕАЛЬНУ JSON-серіалізацію → recovered doc+структура+resolution-курсор == live.
- ✅ **1b-coalescing — ДОВЕДЕНО** (`v2-1b-coalescing-spike`, 2026-06-13). **Підхід B (record-boundaries) ОБРАНО**
  (чистіший за coalesce-у-writer): writer пише **per-tx блоки** + прапор `newGroup`, обчислений з дельти
  **`undoDepth(state)`** (`@codemirror/commands`): зріс на +1 → нова група; 0 → злився в поточну. Replay форсує
  ту саму групову структуру `isolateHistory.of("before")` на `newGroup`-блоках (решта зливається). Доведено:
  CM6 зліплює adjacent `input.type` burst у 1 групу; `undoDepth`-дельта точно мітить межі (`G··G·`); replay
  відтворює undoDepth **і гранулярність** (undo відкочує ЦІЛИЙ burst, не посимвольно); MIXED (burst+резолюція+
  undo/redo) → recovered doc+структура+undoDepth==live, resolution-undo→group+`before`, burst→1 крок.
  Net-глибина = (#edit − #undo + #redo) переграних. **Усі persistence-gate'и закриті → продакшн розблоковано.**

#### §0.5.5 «Карусель» — compaction (✅ DONE 2026-06-20 — reopen + threshold тригери)
> **СТАН 2026-06-20 (bug-31/32):** metric-фікс (лічильник рахує `newGroup` = жива undo-depth, `2472ed8`) +
> conservative `compactHistoryV2` (pure, lockstep-доведено на реальному 428→68 лозі) + seq-in-checksum/`reseal`
> (`e76e225`) + atomic-swap `rewriteHistoryAtomic`/`recoverHistoryRewrite` + reopen-тригер `compactSessionLog`
> (перед Resume-модалкою; onload marker-recovery) (`b11bf3a`/`383f588`). **Threshold-тригер DONE (`fbc2436`):**
> пороги {100 undo / 200KB cancelled}; `cancelledBytes` був dead-wired (feed не передавав `undoneBytes`) → feed
> тепер міряє повний span undo (deleted+inserted); writer запускає injected `compactRunner` НА своєму tail після
> flush (mutually-exclusive з appends → race-free), reset seq+stats; `drain()` чекає на compaction (exit-commit
> читає recordCount після). Boundary [compacted prefix]++[appends] replay-доведено через undo/redo-прохід.

Append-only лог росте; periodic compaction його стискає (видаляє скасовані undo/redo-послідовності), зберігаючи
net-стан.

> **REOPEN-ТРИГЕР (рішення користувача 2026-06-20, bug-31/32).** При відкритті конфлікту з diff-panel, якщо
> `history.jsonl` має filesize > 0, **СПЕРШУ запустити `compact()`** і atomic-перезаписати `history.jsonl`, а
> ВЖЕ ПОТІМ показувати модалку «Resume previous edit session?» з пост-компресійним «edits saved». Це найбезпечніший
> момент (ще немає живої undo-стопки в редакторі → compaction безумовно безпечна), і він тримає лог малим на
> природному checkpoint. Threshold-тригер (`shouldCompact` mid-edit) — окремий ПІЗНІШИЙ інкремент (де
> undo-preservation під час активного редагування складніша; не блокуюче).
>
> **МETRIC-нюанс (bug-31/32, інспекція реального логу 2026-06-20):** «edits saved» у модалці росло до 162 при
> живій undo-глибині ~20 — це **НЕ bloat, а metric-баг**. `assessHistoryV2.edits = #edit − #undo + #redo` рахує
> ВСІ edit-блоки, але CM6 коалесує бурст у ОДНУ undo-групу (кілька `newGroup:false`-блоків). Реальний лог: 275 edit
> (з них 133 `newGroup:true`), 133 undo, 20 redo → net 162, але **живих undo-груп = 133−133+20 = 20**. Правильна
> «edits saved» = `#(edit&&newGroup) − #undo + #redo`. Консервативна compaction net-інваріантна → лічильник НЕ
> змінює; metric — окремий дешевий фікс (рахувати лише `newGroup`-edits).

> **СЕМАНТИКА = CONSERVATIVE (рішення користувача 2026-06-20).** Приклад: 10 правок → undo×7 → +1 правка → після
> compaction РІВНО 4 (перші 3, що пережили undo, + 1 нова). Тобто прибираємо ЛИШЕ **мертві** edits (undone +
> redo-гілка обрізана наступною правкою) разом з їх undo-командами; **живу** undo/redo-досяжність зберігаємо
> (нічого досяжного не викидаємо — НЕ aggressive). Після recovery undo/redo сягають рівно як до краху.
> **POSITION-SAFETY (чому видалення коректне):** мертві edits скасовуються (undo) ПЕРЕД наступною правкою, тож
> `ChangeSet` живих edits після них уже позиціонований відносно doc БЕЗ мертвих → видалення не зсуває позиції.
> **АЛГОРИТМ (pure, simulate-our-undo-model):** пройти блоки, ведучи `undoStack`/`redoStack` груп (edit newGroup→
> push нову групу + CLEAR redoStack[обрізання]; newGroup:false→append у топ-групу + clear redo; undo→pop undo→push
> redo; redo→pop redo→push undo). Наприкінці emit мінімальний лог = [живі undo-групи edits, у порядку] + [живі
> redo-групи edits] + [undo×(redo-count)] → replay дає той самий doc+structure+undo-depth+redo-depth. Re-seq/re-sum.
> **ВИМОГА (користувач 2026-06-20):** після compact+recovery-replay undo-to-bottom (рівно N=живих-груп UNDO) має
> повернути до ПОЧАТКОВОГО стану конфлікту (базовий diff-документ). Conservative це гарантує (зберігає всі N живих
> undo-груп). ⇒ ORACLE = **повний lockstep undo-до-дна + redo-до-верху**: `replay(compact(log))` == `replay(log)`
> покроково (doc+structure+caret на КОЖНОМУ кроці), не лише фінальний стан (lossy vs conservative нерозрізнимі на
> фіналі — різниця лише в undo/redo-проході).

**Тригери (OR):** (1) поріг кількості undo-записів; (2) поріг суми **скасованих байтів** (накопичувати
розмір, що кожен undo відкотив). **Bloat-stats** у лог (total bytes/entries/undo-count/cancelled-bytes) → щоб
емпірично вивести константи. **Compaction крутиться на MAIN** (рішення 2026-06-13: воркер-офлоуд відмінено —
тригериться РІДКО по порогу, тож невеликий фріз на мобільному, якщо й виникне, то дуже-дуже рідко; не вартий
воркер-транспорту). `compact()` лишається ЧИСТОЮ функцією (§0.5.5.1) → офлоуд у воркер тривіальний ПІЗНІШЕ,
якщо рідкісний фріз колись стане проблемою.
**Atomic-swap (forward-recovery marker, як `atomic-write.ts`):** in-memory черга пише в обидва файли→сходяться →
`write .history.sync-tmp.json` (маркер: новий повний) → `remove history.jsonl` → `rename history.sync-tmp.json
→ history.jsonl` → `remove marker`. Краш: маркер є→новий авторитетний (доробити rename); нема→старий.
`onload-recovery.ts` sweep має знати маркер. Ортогонально 7step: commit бере живий `splitModel`, лог не читає,
Step-7 видаляє весь dir (карусель-temp включно); не гонити compaction у commit-вікні.

#### §0.5.5.1 Pure-core / thin-edges (принцип структури — 2026-06-13)
Уся персистентність — **чиста абстракція над даними**; vault / worker / CM6 — тонкі імперативні краї без логіки.
Чисте ядро (unit-тестовне без vault/worker, як спайки): `recordBlock(change, effects, undoDepthDelta)→Block`;
`replayStep(entry)→"dispatch"|"undo"|"redo"`; `compact(jsonl)→jsonl` (CPU-важка, чиста — крутиться на MAIN,
worker-офлоуд відмінено §0.5.5); `shouldCompact(stats)→bool` (тригер); `accrueStats(stats, block, undoneBytes)
→stats` (bloat-reducer). Краї: `vault.append/read/atomic-swap` (main); CM6 `dispatch/undo()/redo()` (replay,
main). **Наслідок:** усе на main, але ядро ЧИСТЕ → unit-тестовне без vault (як спайки) і тривіально офлоудиться
у воркер ПІЗНІШЕ, якщо рідкісний compaction-фріз колись стане проблемою. Write-path лишається main (запис
дешевий §1-бенчмарк ~3ms; durability потребує швидкого main-запису).

#### §0.5.6 Next-steps (sequenced)
- ✅ **Усі gate-спайки закриті** (§0.5.4): курсор (`ba76415`), command-log per-tx (`v2-mixed-recovery-spike`),
  1b-coalescing (`v2-1b-coalescing-spike`). Продакшн розблоковано.
1. ✅ **Продакшн-екстракція — ЗРОБЛЕНО.** `src/diff2/history-log-v2.ts` + `history-replay-v2.ts`. Чисте ядро
   (§0.5.5.1, тестовне без vault/CM6): `buildEditBlock`/`buildCommandBlock` (newGroup з `undoDepth`-дельти +
   `setStructure`→structure / `resolveCaret`→caret), `serializeBlock`/`parseBlock`/`verifyBlock` (FNV-1a-32; **sum
   покриває kind/change/newGroup/structure/caret** — §1-стиль {change,structure} пропустив би тихий злам recovery),
   `accrueStats`/`shouldCompact` (bloat-stats), `replayStep`, `scanHistoryV2`/`assessHistoryV2`. Краї: тонкий
   `HistoryWriterV2` (vault append, serialized tail, **БЕЗ `truncateLastBlock`** — undo/redo тепер command-блоки) +
   `replayHistoryV2(view, jsonl)` на MOUNTED view (re-run commands; **annotation = 1b-стратегія**: `userEvent:
   "input.type"` на КОЖЕН edit + `isolateHistory` ЛИШЕ на `newGroup` — superset, що відтворює coalesced burst'и;
   change як `ChangeSet.toJSON()`→`fromJSON` на replay). `replayDispatch` визначено. Тести (`history-log-v2.test.ts`
   13 / `history-replay-v2.test.ts` 15): pure-core + **обидва gate-спайки (mixed-recovery + 1b) портовані через
   РЕАЛЬНИЙ serialize→jsonl→parse→replay**. ⚠️ **Gotcha для тесту/wiring:** у синхронному тесті ops зливаються
   (нема паузи > `newGroupDelay`); `isolateHistory` — стенд-ін паузи; у проді межі дає реальна пауза → undoDepth+1.
   **Step-2 gap:** `replayDispatch` НЕ покриває `undo(view)`/`redo(view)` (вони будують власні неанотовні tx) → wiring
   мусить мати `replaying`-прапор, що глушить запис на ВЕСЬ replay.
2. **Wiring — feed-bridge + replay-guard ЗРОБЛЕНО (2026-06-13).** `src/diff2/history-feed.ts`: чиста
   `classifyFeed` (skip/edit/undo/redo — truth-table; undo/redo ПЕРЕД docChanged, бо їх tx теж docChanged) +
   тонкий `historyFeedListener(sink, flag, now?)` (per-tx дельта з `tr.startState`→`tr.state`, НЕ update-рівня —
   update батчить tx; skip на `replayDispatch`-annotation АБО `replaying`-прапорі) + `HistorySink` (HistoryWriterV2
   задовольняє) + `ReplayFlag`/`replayWithGuard` (ОДИН спільний інстанс глушить ВЕСЬ replay, бо `undo(view)`/
   `redo(view)` будують неанотовні tx). `assessHistoryV2.edits` → NET-лічба `#edit−#undo+#redo` clamp≥0 (тип-3-undo-3
   → empty → без модалки; евристика, не точна — coalescing зливає burst в 1 групу). `mountDiffPaneV2`/
   `createDiffPaneState` — опційний `hooks:{sink,flag}` (off у чистих CM6-тестах). Тести (`history-feed.test.ts` 12):
   classifyFeed-таблиця + net-count + **ОБИДВА gate-спайки через РЕАЛЬНИЙ `historyFeedListener`** (retire ручного
   `liveRecorder`) → serialize → `replayWithGuard` у свіжий view; replay==live ТА sink реплей-view порожній
   (трап-2 no-double-record). **Лишилось на Phase 6** (потребує DiffEditView lifecycle + Obsidian Modal, не unit-
   тестовне без vault): `startSession` з V2-`joinedDocSha`; recovery-flow (`classifyReopen`→`reopenAction`→
   `ResumeRecoveryModal`→`replayWithGuard`); `cursor.json` restore.
3. **Карусель** (§0.5.5) — окремий пізніший інкремент (worker-офлоуд відмінено; `compact()` на main + atomic-swap +
   тригери з `shouldCompact`).

---

## §2. R7.7.a — Persistent autosave (REDO-log + cursor-timer)

### §2.1 Scope і границі

**Покриваємо:** intra-session, intra-chunk undo всередині однієї resolve-сесії
DiffPane. Сценарій:

1. Користувач відкриває конфлікт `X`, редагує 10 хв (натиснув `[apply]` на
   трьох chunks, вручну дописав абзац у четвертому).
2. Obsidian killed (low-memory на iOS, battery die, OS restart, force quit).
3. Через 2 години відкриває той самий конфлікт.
4. **Recovery dialog** (§3) пропонує `[Continue editing]`.
5. Натиснув → DiffPane у стані за ~1 секунду до crash; cursor приблизно там,
   де був; `Ctrl+Z` повертає до chunk-2, chunk-1, etc.

**НЕ покриваємо:** durable archive **між** sync-кліками — це PSEUDO-MERGE-MODE
§4.4. Між цими рівнями немає overlap-у.

### §2.2 Принцип: vault недоторканий до `[←]`

Файли `base` і `sibling` у vault фізично **НЕ перезаписуються** під час
редагування у DiffPane. Запис у vault — **тільки** при `[←]` (write base +
proactive sibling cleanup, R7.11 та §5).

Load-bearing for two reasons:

1. **Recovery математично можливий тільки якщо вхідні файли незмінні** —
   history-log накатується поверх свіжо-побудованого `buildModel(base, sibling)`.
2. **Tab close `[x]` має чітку семантику "викинути сесію"** — vault лишається
   у pre-session стані, без слідів проміжного редагування.

### §2.3 Гранулярність REDO-блоку = 1 CM6 transaction

> ⚠️ **SUPERSEDED §0.5.4 (2026-06-13).** V2 НЕ робить «1 tx = 1 undo-step». Канон: writer пише per-tx блоки, але
> межі undo-груп мітить прапором `newGroup` з дельти `undoDepth(state)` (**approach B**) — typing-burst зливається
> в 1 undo-групу (як native CM6), replay форсує ту саму гранулярність `isolateHistory` на `newGroup`-блоках.
> `newGroupDelay:0` теж відкинуто — межі дає реальна пауза набору. Per-tx «1 tx = 1 step» РОЗГЛЯНУТО Й ВІДКИНУТО.

Кожна CM6 transaction = один REDO-блок у логу. Природна одиниця `Ctrl+Z` —
користувач сприймає кожен undo-step як одне "повернутись".

**Конфігурація:** `history({ newGroupDelay: 0 })` (per Phase 5 spike findings —
`tests/diff2/spikes/`).

Default `newGroupDelay` (~500ms) групує consecutive transactions у один
undo-group — неприйнятно для diff-editor: програмні chunk-action dispatches
([apply] / [remove]) повинні бути окремими Ctrl+Z-steps.

**In-memory UNDO стек** — vanilla CM6 historyField, живе **тільки в RAM**. На
crash зникає. На recovery — відновлюється природним шляхом: `view.dispatch(tx)`
для кожного replayed-блока автоматично записує undoable step у CM6 historyField.

### §2.4 Директорійна розкладка

> **Розташування:** у production — `<configDir>/plugins/<pluginId>/.diff2-autosave/`
> (виставляється на onload через `setAutosaveRoot`, як `TrashStore` / `.token_expired`),
> щоб autosave жив РАЗОМ з даними плагіна, не засмічував корінь vault і був усередині
> gitignored-зони плагіна (ніколи не синкається). `AUTOSAVE_ROOT` — `export let` (live
> binding; `autosave-cleanup.ts` бачить оновлення); default `.diff2-autosave` (корінь) —
> для unit-тестів. Нижче `<root>/` = цей налаштований корінь.

```
<root>/                              ← <configDir>/plugins/<id>/.diff2-autosave (prod)
└── .diff2-autosave/
    ├── <conflictId-1>/
    │   ├── meta.json
    │   ├── history.jsonl       ← constant name
    │   ├── cursor-a.json      ← 2-slot ping-pong (§2.9)
    │   ├── cursor-b.json
    │   ├── base.snapshot       ← byte-copy of basePath at session start
    │   ├── sibling.snapshot    ← byte-copy of siblingPath at session start
    │   └── done.json           ← optional, present ONLY during [← back] commit
    ├── <conflictId-2>/
    │   ├── meta.json
    │   ├── history.jsonl
    │   ├── cursor-a.json      ← 2-slot ping-pong (§2.9)
    │   ├── cursor-b.json
    │   ├── base.snapshot
    │   └── sibling.snapshot
    └── <conflictId-3>/
        ├── meta.json
        ├── history.jsonl
        ├── cursor-a.json
        ├── cursor-b.json
        ├── base.snapshot
        └── sibling.snapshot
```

**П'ять обов'язкових файлів** + **один optional**:

- `meta.json` — пишеться **раз** при старті сесії; не модифікується (§2.5).
  Відсутність → §4.2 cleanup (1).
- `history.jsonl` — append-only лог CM6 transactions (§2.6–§2.8). **Constant
  ім'я**, не передається через meta.json (один на сесію — `.diff2-autosave/<id>/`
  завжди створюється з нуля). Відсутність → §4.2 cleanup (2).
- `cursor-a.json` / `cursor-b.json` — позиція курсора, **2-слот ping-pong** —
  механіку (slots, `seq`, recovery) див. **§2.9** (єдине джерело). На старті сесії
  пишеться `cursor-a.json` (`seq 0`); відсутність **обох** слотів → §4.2 cleanup (3).
- `base.snapshot` — byte-exact copy of `basePath` content at session start.
  Пишеться **раз** на старті, не модифікується. Це **"ground truth"**
  baseline: усі recovery / TOCTOU перевірки порівнюють поточний vault state
  до цих snapshots, не до stored SHAs. Відсутність → §4.2 cleanup (4).
- `sibling.snapshot` — analogously для `siblingPath`. Відсутність → §4.2 cleanup (5).
- `done.json` — **optional**. Пишеться тільки на старті `[← back]` commit
  (§5.0 step 2). Містить pre-computed `expectedBaseSha` + `expectedSiblingSha`.
  **Присутність — це сигнал "commit-in-progress, roll-forward via §5.0 recovery"**;
  §4.2 cleanup НЕ запускається, поки done.json лежить. Після успішного commit
  (step 7) done.json зникає разом з рештою через `rmdir(autosave-dir)`.

**Чому snapshots замість stored SHAs у meta.json:**

- **Ground truth для recovery / TOCTOU**: коли vault змінився під час
  редагування — у нас лишається оригінал що user реально бачив на старті;
  recovery dialog може показати informed options (форма — §3.2.a) замість silent wipe.
- **Простіша meta.json**: без полів `baseShaAtStart`, `siblingShaAtStart`,
  `historyFile`. Менше state, менше сумнівних операцій (SHA recompute з
  byte-snapshots завжди правильний).
- **Constant filenames** для всіх runtime файлів — менше fragility (не
  потрібно tracking назву history-файлу через meta).
- **Robust до edge case** "vault змінився під час сесії": не вибираємо
  одне з двох (cleanup user-work АБО overwrite vault), а даємо користувачу
  усвідомлений вибір через recovery modal з повним діагностичним контекстом.

Storage overhead (2x file size per session) — для типового markdown-vault'у
30-300 kB на сесію. Negligible.

**`<conflictId>`** — джерела залежно від типу сесії:

> ⚠️ **ЗМІНЕНО 2026-08-31 (Фаза 5.5 крок 3b, порт на conflict store v2).**
> v1-ре́корд з opaque UUID помер разом зі старим ConflictStore; у v2
> (conflicts.json) записи не мають UUID — стабільною ідентичністю tracked
> конфлікту є детермінована пара `(basePath, siblingPath)` (ім'я sibling-а
> детерміноване: buildSiblingFilePath). Тому tracked перейшов на ту САМУ
> формулу §2.4.1, з kind-префіксом `tracked-`, який гарантує, що tracked-
> і synthetic-сесія однієї пари ніколи не колізують. Кут "нова генерація
> конфлікту вивела старе ім'я sibling-а → той самий id" покривається
> reopen-класифікацією (вона валідує content-SHA сесії проти диска).
> Старий стан на диску не існує (blank-slate cutover) — міграції нема.

| Kind                                                     | Джерело id                                                         | Form                |
|----------------------------------------------------------|--------------------------------------------------------------------|---------------------|
| **Tracked conflict** (запис у conflicts.json, R2.2)      | Deterministic hash з `(basePath, siblingPath)` pair (§2.4.1).      | `tracked-<16hex>`   |
| **Synthetic conflict** (sibling-only, R2.2 Правило 3)    | Deterministic hash з `(basePath, siblingPath)` pair (§2.4.1).      | `synthetic-<16hex>` |
| **R2.1 Compare-any-two** (arbitrary file pair, Phase 8)  | Deterministic hash з `(pathA, pathB)` pair, sorted (§2.4.1).       | `compare-<16hex>`   |

#### §2.4.1 Уніфікована формула deriveAutosaveId

**Одна функція** для всіх видів (2026-08-31: tracked приєднався — див.
примітку вище; "history" додано ще у 7a.1):

```typescript
function deriveAutosaveId(
    kind: "tracked" | "synthetic" | "compare" | "history",
    path1: string,
    path2: string,
): string {
    // Sort для order-canonicalization: (A, B) і (B, A) → той самий id
    // Critical для compare — користувач міг вибрати файли у будь-якому
    // порядку через picker. Для synthetic — теж symmetric, хоча на
    // практиці siblingPath завжди derive-ний з basePath, тож order
    // фіксований.
    const [first, second] = [path1, path2].sort();

    // `\0` як delimiter запобігає path-collision ambiguity:
    // ("foo", "bar") vs ("foob", "ar") vs ("fooba", "r") → різні хеші
    // (бо `\0` не зустрічається у valid path).
    const hash = fnv1a64(first + "\0" + second)
        .toString(16)
        .padStart(16, "0");

    return `${kind}-${hash}`;
}
```

**Чому `fnv1a64` (64-bit), а не 32-bit:**

- 32-bit = 8 hex chars = 4 billion buckets. При типовому usage (десятки
  одночасних сесій) — collision rate негайно. Але **paranoid-safe** important
  для diff2 — collision = два різні file pairs шлядать у один autosave dir =
  data loss.
- 64-bit = 16 hex chars. Collision probability negligible на будь-якому
  realistic vault size. Overhead 8 додаткових chars у directory name — copey.

**Чому sort + delimiter (не просто concat):**

- Без sort: `("a.md", "b.md")` ≠ `("b.md", "a.md")` → два різні compare-сесії
  → user resume не знаходить попередню роботу.
- Без delimiter: `"foo" + "bar"` = `"fooba" + "r"` → collision.

**Чому synthetic conflicts теж через цю формулу** (а не просто `hash(siblingPath)`):

- Однорідність — один helper для всіх non-tracked. Менше шансів на divergence
  у тестах і коді.
- Симетричний паттерн — якщо колись синтез ID для synthetic зміниться (наприклад,
  додамо нову форму sibling naming), формула не зламається.

**Invariant** (Phase 1 `synthetic-detector.ts` имплементатор зобов'язаний
дотриматись):

- `deriveAutosaveId("synthetic", basePath, siblingPath)` — **deterministic**,
  pure function of path arguments only. Жодних `Date.now()` / mtime / random.
- `deriveAutosaveId(k, a, b) === deriveAutosaveId(k, b, a)` — order-independent.
- Verified unit-тестом `autosave-id-stable-and-symmetric.test.ts`: build IDs
  для серії pair'ів двічі + у reversed order → усі співпадають.

**Single-detail-area invariant — один активний diff-editor у момент часу.**

**Це навмисний design choice, не технічне обмеження.** Користувач відкриває
й редагує **одну пару файлів** у diff-editor одночасно. Хоче переглянути
інший конфлікт чи compare? — closes поточну сесію, відкриває нову.

**Чому це feature, а не bug:**

1. **Фокус на одній задачі.** Резолюція конфлікту або порівняння двох файлів
   — це акт concentration. Multiple editor tabs змусили б користувача
   "перемикатись" між контекстами, втрачаючи track.
2. **Передбачувана autosave-семантика.** Один active editor = одна
   `<conflictId>` модифікується в момент часу = жодних concurrency-edge cases
   на recovery files.
3. **Простіша cognitive model.** "Я редагую цей конфлікт. Завершу — візьму
   наступний." vs "У мене 5 tabs з різними конфліктами, який зараз активний?"
4. **Без втрати work на accidental clicks.** Випадковий клік на інший
   conflict у списку (чи context-menu Compare) не може стерти 30 хвилин
   роботи — система явно вимагає закриття поточної сесії.

Архітектурна реалізація (Phase 0): **single registerView** → один leaf у
workspace типу `DIFF_EDIT_VIEW_TYPE`. Усередині leaf-а layout з conflicts
list + **detail-area**, де живе DiffPane. Тільки **один** conflict
edits-ається у detail-area в момент часу.

**Усі entry points маршрутизуються через цей єдиний leaf**:

| Entry point                                   | Дія                                                      |
|-----------------------------------------------|----------------------------------------------------------|
| Click conflict у diff2 list                   | Populate detail-area з конфліктом                        |
| Context-menu `Compare with…` (R2.1)           | Open/reveal leaf → populate detail-area з compare-сесією |
| File-menu `Resolve conflict` на sibling-файлі | Open/reveal leaf → populate detail-area з конфліктом     |
| Command palette `Show history of this file`   | Open/reveal leaf → populate detail-area з history-сесією |

**Inherent properties цієї архітектури:**

- Concurrency на autosave files **неможлива** — тільки одна `<conflictId>`
  активна в момент часу.
- Жодних race-conditions на cursor ping-pong writes (§2.9) чи `history.jsonl` appends.
- Single-tab-per-id invariant **inherent**, не потребує enforcement коду.

**Поведінка при invoke entry point з активним detail-area:**

```typescript
function openInDetailArea(newConflictId: string, displayName: string) {
    const currentSession = detailArea.currentSession;
    if (currentSession && currentSession.conflictId === newConflictId) {
        // Уже відкритий цей самий конфлікт — просто focus leaf + scroll up
        revealLeaf(diff2Leaf);
        return;
    }
    if (currentSession && currentSession.hasUnflushedChanges()) {
        // Інша сесія активна з unsaved changes
        new Notice(
            `Close current edit first ([← back] or [×]) to open: ${displayName}`
        );
        revealLeaf(diff2Leaf);  // показуємо тому що user явно ткнув
        return;
    }
    // detail-area вільна або з clean state → populate
    detailArea.load(newConflictId, ...);
}
```

UX-flow:

- Користувач має активну сесію конфлікту X, з history-блоками у RAM.
- Робить context-menu Compare on (A, B) → бачить Notice "Close current edit
  first to open: compare(A, B)"
- Він `[← back]` АБО `[×]` на конфлікт X.
- Detail-area стає вільна.
- Compare можна знов invoke → відкриється.

**Чому НЕ дозволяємо force-replace з discard:** користувач міг витратити 30
хвилин на конфлікт X, і випадковий context-menu клік не повинен втратити цю
роботу. Explicit close = explicit intent.

**Detection list of in-progress autosave sessions** — на disk-рівні через scan
`.diff2-autosave/` (О(N) by кількість директорій; типово N ≤ 5). У runtime ж
завжди тільки одна "active session" — це `detailArea.currentSession`. Без
in-memory index.

**Накопичення autosave dirs з минулих сесій — допустимо.** На диску може
лежати десятки `<conflictId>/` директорій від crash-нутих сесій минулого
(різні конфлікти, різні compare-пари, history-сесії). Вони живуть, поки
не зміниться SHA вхідних файлів (§4 cleanup), і не впливають на runtime
(тільки одна активна за раз). Recovery dialog (§3) показується при
відкритті того конфлікту, чий autosave ще валідний.

### §2.5 `meta.json` — схема і lifecycle

**Пишеться ОДИН РАЗ** при `openDiffPane(conflictId)` (старт сесії).
**КРИТИЧНО**: meta.json пишеться **ОСТАННІМ** у session-start protocol —
ПІСЛЯ створення обох snapshots + cursor-a.json + порожній history.jsonl.
Це дає strong invariant: **наявність meta.json гарантує наявність + валідність
всіх інших файлів та їх SHAs**.

Atomic-write (temp + rename), щоб torn-write не лишив пів-валідний файл.

Чому "один раз": усе, що змінюється під час сесії (cursor, edits) — або в
окремому файлі (cursor-a/b.json, §2.9), або в append-log (history.jsonl). Snapshots
ніколи не змінюються, бо це frozen baseline.

**Схема:**

```json
{
  "v": 1,
  "createdAt": "2026-05-29T14:32:11.842Z",
  "conflictId": "<same as parent directory name>",
  "basePath": "Notes/work/meeting-2026-05-28.md",
  "siblingPath": "Notes/work/meeting-2026-05-28.conflict-from-iphone-1716987131842.md",
  "baseShaAtStart": "a1b2c3d4...",
  "siblingShaAtStart": "e5f6g7h8...",
  "joinedDocSha": "f0e1d2c3..."
}
```

**Поля:**

- `v` — schema version. Bump при будь-якій incompatible зміні.
- `createdAt` — ISO timestamp старту сесії. Recovery dialog показує
  human-readable "X minutes ago".
- `conflictId` — duplicate of directory name; для cross-check.
- `basePath` / `siblingPath` — vault-relative paths.
- `baseShaAtStart` / `siblingShaAtStart` — git-blob SHA байтів **на момент
  snapshot creation**. **Не модифікуються** — це reference value для
  fast TOCTOU/recovery check без необхідності читати весь snapshot.
  Sanity-check на recovery: `sha(read("base.snapshot")) === meta.baseShaAtStart`
  має триматись; якщо ні — corruption → §4.2 cleanup.
- `joinedDocSha` — git-blob SHA рядка `serializeModel(buildModel(base, sibling))` (V2-модель:
  clean doc + VerRange-partition, БЕЗ сентінелів). **Gate валідності replay**: replay проти
  входів `I` валідний ⟺ `SHA(serializeModel(buildModel(I))) === joinedDocSha`. Ортогональний до
  input-SHA (ті керують вибором ДІАЛОГУ §3.2/§3.2.a) — whitespace-only зміна, яку `diffLines`
  згортає, лишає `joinedDocSha` рівним, хоч input-SHA інші → replay валідний, керує саме
  `joinedDocSha`. Пряме порівняння артефакту детектить library-drift напряму (без версійного
  поля). §3.2.a restore ТЕЖ під gate'ом (drift → `serializeModel(buildModel(snapshot))` ≠
  `joinedDocSha` → snapshot не рятує → fresh).

**Примітка:** `historyFile` поле більше **не існує** — `history.jsonl` має constant ім'я (§2.4).

#### §2.5.a Session-start protocol — ordering guarantee

При `openDiffPane(conflictId)` для **нової** сесії (autosave-dir не існує)
init виконується у строгому порядку, де **meta.json пишеться ОСТАННІМ**:

```
Step  1. mkdir .diff2-autosave/<conflictId>/  (idempotent)

Step  2. baseBytes    = await vault.adapter.readBinary(basePath)
Step  3. siblingBytes = await vault.adapter.readBinary(siblingPath)
Step  4. baseShaAtStart    = sha(baseBytes)     // in-memory hash
Step  5. siblingShaAtStart = sha(siblingBytes)

Step  5.5 (§2.5 joinedDocSha). joinedDocSha = sha(utf8(serializeModel(buildModel(
          decode(baseBytes), decode(siblingBytes)))))
          // ВСЕ in-memory, ДО будь-якого disk-write. meta.json write-once
          // immutable і несе joinedDocSha → buildModel + serialize + hash МУСЯТЬ
          // передувати step 10. buildModel — чиста детермінована функція, без
          // сентінелів → жодної collision-перевірки.
          //
          // SINGLE-READ INVARIANT (TOCTOU): baseShaAtStart, siblingShaAtStart,
          // joinedDocSha І обидва snapshot'и МУСЯТЬ бути похідними від ОДНОГО
          // читання вхідних файлів (тих самих буферів baseBytes/siblingBytes зі
          // step 2-3). Перечитування vault між ними → файл міг змінитись →
          // SHA-и розсинхронізуються і meta стає внутрішньо суперечливим. Тому
          // build бере decode(baseBytes), а НЕ окремий adapter.read.
          // Оптимізація «не білдити двічі» (mount уже будує joined для рендера)
          // допустима ЛИШЕ якщо mount передасть startSession І байти, І joined з
          // того САМОГО read; інакше — startSession читає раз і білдить сам
          // (подвійний build — дешева перф-дрібниця проти ризику десинхрону).

Step  6. atomicWriteFile(.diff2-autosave/<conflictId>/base.snapshot,    baseBytes)
Step  7. atomicWriteFile(.diff2-autosave/<conflictId>/sibling.snapshot, siblingBytes)

Step  8. atomicWriteFile(.diff2-autosave/<conflictId>/cursor-a.json,
                          JSON.stringify({v:1, seq:0, anchor:0, head:0, scrollTop:0, savedAt: now()}))
                          // 2-slot ping-pong (§2.9); cursor-b.json зʼявляється на 1-му flush

Step  9. atomicWriteFile(.diff2-autosave/<conflictId>/history.jsonl, "")  // empty file

Step 10. atomicWriteFile(.diff2-autosave/<conflictId>/meta.json, {
             v: 1,
             createdAt: now(),
             conflictId,
             basePath,
             siblingPath,
             baseShaAtStart,    // bytes-binding: гарантовано match snapshot
             siblingShaAtStart,
             joinedDocSha,      // §2.5: замінив joinAlgoVersion/joinAlgoOptions (3b-1)
         })
         // ← COMMIT POINT. Якщо crash до цього кроку — на recovery нема
         //    meta.json → cleanup (умова 1 §4.2) → fresh session.
         //    Якщо crash після — meta.json гарантовано має валідні SHAs
         //    що match snapshots (because SHAs computed з in-memory bytes,
         //    written у snapshots у steps 6-7).
```

**Strong invariant**: `meta.json exists ⇒ всі п'ять обов'язкових файлів існують
і SHAs у meta точно match snapshot bytes.` Це дозволяє recovery code на пізніших
етапах **довіряти** meta.json без додаткової sanity-перевірки sha-of-snapshot —
якщо тільки storage не corrupted (rare).

(Recovery §4.2 умова 5 sanity-check `sha(read("base.snapshot")) === meta.baseShaAtStart`
все ще запускається як defence in depth — для catch'у дискових bit-flip.)

#### §2.5.b Reuse-snapshot optimization при reopen після crash

При `openDiffPane(conflictId)` якщо у `.diff2-autosave/<conflictId>/`
існує валідний meta.json + snapshots (це може статись тільки після crash
чи tab-switch — нормальне `[← back]` цю директорію видалило б):

```
parse meta.json
currentBaseSha    = sha(vault[basePath])
currentSiblingSha = sha(vault[siblingPath])

if (currentBaseSha === meta.baseShaAtStart
    AND currentSiblingSha === meta.siblingShaAtStart):
    → Vault unchanged since session start (relative до crash point).
    → **Reuse existing snapshots** — не перезаписуємо, не recompute.
    → Скіп step "copy basePath → base.snapshot" (вже актуальне).
    → Continue з recovery flow §3 (show "Resume previous edit session?" dialog).

else:
    → Vault changed during edit session.
    → НЕ перезаписуємо snapshots і НЕ перезаписуємо meta — стара версія
      залишається ground-truth.
    → Trigger §3.2.a recovery dialog (форма — див. §3.2.a).
```

**Чому це важлива оптимізація:** після crash зазвичай vault unchanged (типовий
випадок: low-memory kill, користувач відразу перевідкриває). Skip re-copy
снапшотів великих файлів економить I/O на старті recovery. Для робастності —
sanity-check `sha(read("base.snapshot")) === meta.baseShaAtStart` на старті
ВСЕ ОДНО запускаємо (cheap і catches storage corruption).

### §2.6 `history.jsonl` — формат REDO-блоку

> Схема блоку + replay — **канон у §0.5 (COMMAND-LOG)**; тут лише спільні поля + checksum.

**NDJSON** (Newline-Delimited JSON): один блок = один рядок, append-only — existing content
не модифікується, файл лише росте.

**Поля:**

- `seq` — монотонний номер від 1 (діагностика; replay лінійний, згори донизу).
- `kind` — `"edit" | "undo" | "redo"` (§0.5 COMMAND-LOG).
- `change` — `ChangeSet.toJSON()` цієї CM6-транзакції (мінімальна дельта). На РЕЗОЛЮЦІЇ блок
  додатково несе `structure` (`VerRange[]` = решта груп) + `caret:{before,after}`; typing мапить
  структуру через inclusive RangeSet (без `setStructure`).
- `sum` — checksum для torn-write / corruption; покриває `kind`/`change`/`newGroup`/`structure`/`caret`.

**Checksum (`sum`):**

Простий алгоритм, не криптостійкий. Кандидат: FNV-1a 32-bit над JSON-серіалізацією
поля `change` (з тими ж options, що при write). Hex-encoded.

Точний вибір алгоритму — implementor; контракт: `recompute(block.change) === block.sum`
→ блок OK; інакше → блок corrupt, replay зупиняється на цьому блоці.

**Чому не зберігаємо cursor у блоці:** він в окремому файлі (§2.9), оновлюється
по таймеру — окрема життєва логіка, окрема crash-window. Якщо б ми зберігали
cursor у кожному redo-блоці, він "застрягав би" на момент останньої transaction
і не оновлювався під час навігації.

### §2.7 Append через `vault.adapter.append`

**API підтверджено:** `vault.adapter.append(normalizedPath, data, options?)`
існує в `DataAdapter` (`obsidian.d.ts:996`).

**Доказ що працює на mobile:** наш `src/logger.ts:131` використовує цей API
для logger; logger mobile-safe (iOS + Android). Pattern "NDJSON-рядок + `\n` per
call" — proven у production. Не потрібно ні read-modify-write, ні file handles,
ні OS-level append-mode.

#### §2.7.a Undo-truncation — лог дзеркалить undo-стек редактора (TODO §5)

> ⚠️ **SUPERSEDED §0.5.2/§0.5.4 (2026-06-13).** V2 НЕ обрізає лог. undo/redo — це **command-блоки**
> (`kind:"undo"|"redo"`, append-only); replay переграє їх (`undo(view)`/`redo(view)`). `HistoryWriterV2` **не має
> `truncateLastBlock`** (`5338729`). Інваріант «block count == undoDepth» теж замінено: net undo-depth ≈
> `#edit − #undo + #redo` над переграними блоками. Нижче — історичний §1-механізм.

**Інваріант:** `on-disk block count == CM6 undoDepth(state) == HistoryWriter.liveBlockCount()`.

CM6 undo — це теж транзакція; без спецобробки W2-feed записав би її як **forward
inverse-блок**. Replay тоді відтворює коректний стан (advisor: «bloated, NOT
corrupt»), АЛЕ: (a) лог росте **безмежно** на undo/redo-циклах; (b) net-edit-count,
що живить §4.1.a exit-wipe + «N edits» recovery-діалогу, **хибний**. Тому:

- **`tr.isUserEvent("undo")`** у W2-updateListener → `onUndo` → `HistoryWriter.
  truncateLastBlock()` (DROP останнього блоку). **redo** та **edit-after-undo**
  падають у `onRecord` → append (CM6 чистить redo-стек → новий блок коректно
  замінює покинуту гілку). З `history({newGroupDelay:0})` кожна recordable-tx = рівно
  один undo-step, тож 1 undo = 1 блок (пінено тест-оракулом `blockCount===undoDepth`).
- **`liveBlockCount`** (live, == undoDepth) ОКРЕМО від монотонного `seq:`-штампа
  (штамп не декрементиться; replay position-ordered, тож дубль після undo+edit
  benign). `liveBlockCount` декрементиться **синхронно** в `truncateLastBlock` — щоб
  `[← back]` exit-wipe одразу бачив правильний net-count (N edits + N undos → 0 →
  discard, входи недоторкані).
- **Truncate-механіка (немає `truncate`/random-write/positional-append в Obsidian —
  підтверджено `obsidian.d.ts`):** floor = переписати весь файл. `truncateLastBlock`
  **queue-aware**: якщо блок ще в `queue` (не flush'нутий) → `queue.pop()` (без I/O,
  і без race з pending-flush, що інакше записав би undone-блок); інакше — на
  serialized tail re-read → drop останнього рядка → `adapter.write`. **Plain write,
  НЕ atomicWriteFile** (temp+rename насмітив би `.sync-tmp` усередині autosave-dir,
  який обходять recovery-сканери). Torn rewrite → `scanHistory` бере trustworthy-
  prefix; повністю невдалий truncate → «блок не прибрано» (degrade-safe).
- **Re-read (не in-memory дзеркало):** resumed-сесія має попередні блоки лише на
  диску (replay відбудував CM6-undo-стек, але не контент у writer'і); re-read їх
  бачить. Тести: `undo-truncate.test.ts` (3edits→2undo→1блок; undo-to-empty→exit-
  discard; redo; edit-after-undo; undo-into-resumed; **120-step fuzz** з оракулом).

> **FUTURE (НЕ реалізовано — defer): `validCount` gate для multi-MB логів.** Простий
> truncate = O(file) на undo. Це byte-cheap у 99% (CM6-`ChangeSet` зберігає
> ВСТАВЛЕНИЙ текст, не видалений — «delete 1MB» = крихітний блок; лише 1MB **paste** =
> 1MB-блок). ЯКЩО з'являться реальні multi-MB конфлікт-файли з важким undo —
> масштабований апгрейд: персистити `validCount` (==undoDepth), undo/redo лише
> інкрементять/декрементять його (O(1), файл не чіпаємо), фізичний truncate ЛИШЕ на
> new-edit-after-undo (стейл-хвіст завжди в кінці, тож «перші N» коректно). **Ціна:**
> кожен читач (`scanHistory`, `assessHistory.empty` cond-2b, діалог-count, reopen-
> empty) має шанувати gate замість «усі блоки» — складність розмазується по crash-
> critical поверхні. Тому defer: це **чиста перф-оптимізація без зміни контракту**,
> додається пізніше без rework. НЕ робити sentinel-у-лог (переніс би CM6-history-
> семантику в crash-recovery — найгірше місце). Тригер апгрейду = докази multi-MB.

### §2.8 Coalesce window — flush triggers

> **РАТИФІКОВАНО бенчмарком (Android mid-tier, 2026-06-03): coalesce НЕ використовуємо —
> append per CM6 transaction.** `single-append p95 = 3.10 ms` (max 23.70, n=200) → band
> §6.2 `< 10 ms` → «Append per CM6 transaction, no coalesce. Найпростіша імплементація.»
> `HistoryWriter` flush'ить кожну транзакцію негайно (queue cap=1 за фактом). Таблиця
> нижче (idle/typing-pause/queue-cap машинерія) **збережена як contingency-дизайн** на
> випадок, якщо на іншій платформі p95 виросте — production-шлях її не активує.
>
> ⚠️ **УТОЧНЕННЯ V2 §0.5.4 (2026-06-13).** «no coalesce» стосується лише **WRITE-шляху** (пишемо per-tx, бенчмарк
> чинний). Але **block→undo-group coalescing ОБОВ'ЯЗКОВИЙ** (1b, approach B): writer мітить `newGroup` з дельти
> `undoDepth` — typing-burst = 1 undo-група. Це НЕ flush-timer coalesce (той не активний), а record-boundary прапор.

**Contingency-дизайн (НЕ активний):** тримати in-memory pending-queue redo-блоків,
flush по одній з чотирьох умов:

| Тригер                            | Інтервал / умова                                                             | Раціонал                                                                                                                       |
|-----------------------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| 1. **Inter-keystroke idle**       | ≥150 ms з останньої tx                                                       | Користувач зробив паузу в межах "набору". Невелика — щоб не накопичити багато; основний intra-burst tripwire.                  |
| 2. **Typing-pause to navigation** | ≥500 ms з останньої tx ТА відбулась navigation event (caret move без change) | Користувач перестав друкувати і "вийшов" у режим навігації. Цей сценарій займає ~80% сесії; його flush — головний.             |
| 3. **Queue cap**                  | queue ≥10 блоків                                                             | Safety net на випадок безперервного "stress typing" — щоб RAM не залишався не-flushed.                                         |
| 4. **Explicit close**             | Перед `[←]` / `[x]` exit                                                     | Гарантує, що останні до-500ms не загубляться при штатному виході. Flush обов'язково ДО vault-write і ДО `rmdir(autosave-dir)`. |

При flush — один `adapter.append` пише конкатенацію pending-блоків:
`block1\n` + `block2\n` + ... + `blockN\n`. NDJSON природно стрімовий.

**Crash window для history-log:**

- Найгірший випадок: 500 ms (typing-pause-to-nav window), за умови що queue не
  заповнився раніше. Зазвичай — ≤150 ms.
- Користувач втрачає максимум ~5 keystrokes (на швидкості 10 keystroke/sec).

**Це НЕ суперечить принципу "REDO-блок одразу пишеться на диск"** з оригінального
R7.7.a. 150-500 ms — не "ой я забув"-throttle, а нормальний micro-batching.
Семантично — той самий append-only лог.

**Рішення прийняте (2026-06-03):** Android-бенчмарк дав `p95 = 3.10 ms` → coalesce
**викинуто**, append per-transaction (див. банер угорі §2.8). Значення 150/500/10
лишаються лише як contingency на випадок регресу швидкості на іншій платформі.

### §2.9 cursor — окремий файл, 2-слот ping-pong (timer-based)

> **ЄДИНЕ ДЖЕРЕЛО для cursor-механіки.** Усі інші розділи лише іменують файли
> (`cursor-a.json`/`cursor-b.json`) або посилаються сюди — не повторюють логіку.
> **(Code-lag знято 2026-06-13: W3 2-слот ping-pong РЕАЛІЗОВАНО — `cursor-store.ts`/`cursor-timer.ts`.)**

**Окремий файл** для cursor position. **Створюється одразу при старті сесії**
(slot `cursor-a.json`, `seq:0`, `anchor:0, head:0, scrollTop:0`) — щоб після
старту в директорії були всі обов'язкові файли. Після ініціалізації —
перезаписується по таймеру через **2-слотовий ping-pong** (нижче; РАТИФІКОВАНО
2026-06-04 — замінює atomic temp+rename). Не входить у history-log, не залежить
від CM6 transactions.

**Чому окремо:**

- REDO-блоки append-only і прив'язані до **modifications**. Якщо б cursor сидів
  у кожному redo-блоці, він "застрягав би" на момент останньої modification, а
  не реальну позицію курсора у момент crash.
- Користувач ~80% сесії — навігує, не друкує. Навігація не тригерить history-log
  writes (нема нічого записувати), але cursor під час навігації все ж змінюється —
  отже окремий timer-driven файл.
- Окремий файл легко skip-нути при recovery, якщо він corrupt — просто не
  встановлюємо cursor, fall back на natural-after-replay position.

**Схема (кожен slot — `cursor-a.json` / `cursor-b.json`):**

```json
{
  "v": 1,
  "seq": 42,
  "anchor": 1247,
  "head": 1247,
  "scrollTop": 8420,
  "savedAt": "2026-05-29T14:33:42.119Z"
}
```

**Поля:**

- `seq` — монотонний лічильник запису. **Єдиний ключ відновлення** (recovery
  бере slot з найбільшим валідним `seq`). Не залежить від годинника.
- `anchor` / `head` — позиції caret у документі (`view.state.selection.main`).
  Для звичайного caret `anchor === head`; для активного selection — різні.
- `scrollTop` — позиція scroll (опційно; UX-bonus, recovery працює і без нього).
- `savedAt` — ISO timestamp останнього таймер-flush. Лише для діагностики
  staleness / tiebreak (НЕ ключ відновлення — годинник ненадійний).

**Запис — 2-слотовий ping-pong (РАТИФІКОВАНО 2026-06-04).** Замість atomic
temp+rename (на Capacitor `rename` коштує p95≈28ms ТА має вузьке zero-cursor
вікно між `remove(dst)` і `rename`) — пишемо у НЕактивний з двох слотів простим
`adapter.write` (свіжий write ≈3ms — як history-append, §6 benchmark):

```typescript
async function persistCursor() {
    const a = await readSlot("cursor-a.json"); // null якщо нема / torn / bad JSON
    const b = await readSlot("cursor-b.json");
    const seqA = a?.seq ?? -1, seqB = b?.seq ?? -1;
    // Пишемо у слот зі СТАРІШИМ seq (стейл); новий seq = max+1.
    const slot = seqA <= seqB ? "cursor-a.json" : "cursor-b.json";
    const next = {...currentCursor, seq: Math.max(seqA, seqB) + 1};
    await vault.adapter.write(
        `.diff2-autosave/${conflictId}/${slot}`, JSON.stringify(next),
    );
}
```

**Чому це безпечно (атомарність без rename):** завжди рівно ≤2 слоти,
перезаписуються in-place. Пишемо у слот зі старішим `seq` → активний (новіший)
слот лишається ЦІЛИМ. Crash посеред write → torn-слот має старіший seq, recovery
бере інший (цілий, новіший). Жодного `remove`/`rename`, жодного zero-cursor
вікна, жодного накопичення (на відміну від безмежного `cursor-N`).

**Таймер (РАТИФІКОВАНО бенчмарком, Android 2026-06-03):** **2500 ms active /
6000 ms navigation** (§6.2). Бенчмарк мірив atomic-rewrite (p95≈28ms); ping-pong
write дешевший (≈3ms), але cadence лишаємо — recovery-точність на 2.5с достатня,
а курсор некритичний (torn/відсутній → natural-after-replay). Дешевший write —
запас на майбутнє (можна частіше без jank, якщо знадобиться).

| Режим           | Інтервал (запінено) | Раціонал                                                                                                          |
|-----------------|---------------------|-------------------------------------------------------------------------------------------------------------------|
| Active typing   | **2500 ms**         | Користувач друкує, cursor рухається швидко. Коротший інтервал → точніший recovery, але 28ms rewrite ⇒ не частіше. |
| Pure navigation | **6000 ms**         | Користувач лише сканує / читає. Cursor зрушується повільніше; рідше переходить у нову позицію.                    |

**Як визначаємо "active typing" vs "pure navigation":** простий debounce — кожна
CM6 transaction скидає таймер у "active" режим на ≥3 секунди. Після 3 секунд без
transactions — переходимо в "navigation" таймер.

**Дві умови запису (gate — §8 #9, battery):** таймер (а) працює **ЛИШЕ коли редактор
у фокусі редагування** (не-фокус / Obsidian backgrounded → таймер не тикає), і (б) пише
слот **ЛИШЕ якщо позиція (anchor/head/scrollTop) змінилась** із попереднього запису
(dirty-check) — інакше no-op. Тож idle / background не дають ні зайвих writes, ні
battery-drain; окремої "pause when backgrounded" логіки не треба.

**Crash window для cursor:**

- Active typing: до 2 сек назад. У найгіршому випадку cursor десь на 5-10
  символів назад. Користувач не помітить.
- Pure navigation: до 5 сек назад. Cursor може бути на пару рядків назад.
  Прийнятно.
- **Pathological case:** користувач натиснув `[Home]` / `[End]` / `Ctrl+End`
  одразу перед crash, ще до того, як cursor-timer спрацював, → активний
  cursor-слот лишається на попередній позиції. Recovery поставить cursor "не
  туди". Acceptable trade-off: цей сценарій рідкісний, і користувач легко
  переходить заново (`[End]` → 1 keystroke). Інтервал 0.5 сек чи менше не
  врятував би в реальному use.

**Recovery поведінка:**

1. Спершу replay history-log (§3.3).
2. Прочитати ОБИДВА слоти `cursor-a.json` / `cursor-b.json`; кожен parse'иться
   незалежно (torn/bad-JSON → відкинути). Узяти валідний слот з **найбільшим
   `seq`**. Якщо є → set `view.state.selection` згідно з `{anchor, head}`. Якщо
   `anchor > doc.length` → clamp to `doc.length` (документ міг скоротитись через
   replay).
3. Якщо `scrollTop` присутній → `view.scrollDOM.scrollTop = saved.scrollTop`.
4. Якщо ЖОДНОГО валідного слота нема → не set-имо selection; CM6 поставить
   caret природним шляхом (після останньої заміни — наближення §2.9 fallback).

**Якщо обидва слоти відсутні/corrupt**: recovery працює, cursor "де природно
опинився після replay" (зазвичай — кінець останньої зміни). Прийнятно як fallback
(курсор некритичний).

### §2.10 Підсумок: що, коли і куди пишеться

```
┌─────────────────────────────────┬──────────────────────────────────┐
│ Подія                           │ Дія на диск                      │
├─────────────────────────────────┼──────────────────────────────────┤
│ openDiffPane(conflictId)        │ Write meta.json (once, atomic)   │
│                                 │ + Write cursor-a.json (seq 0)    │
│ CM6 transaction (apply/edit)    │ Append history-block per tx      │
│                                 │ (NO coalesce — bench 3ms, §2.8)  │
│ Active typing every 2500 ms     │ ping-pong write cursor slot §2.9 │
│ Navigation every 6000 ms        │ ping-pong write cursor slot §2.9 │
│ `[←]` exit (7-step §5.0)        │ Flush queue → write done.json    │
│                                 │ (SHAs) → write sync-tmp pair →   │
│                                 │ rename pair to .sync-bak →       │
│                                 │ rename sync-tmp to originals →   │
│                                 │ delete .sync-bak → R7.11 sibling │
│                                 │ cleanup → rmdir autosave-dir     │
│ `[x]` tab close                 │ Flush queue (optional, no-op) →  │
│                                 │ rmdir autosave-dir               │
│ Crash                           │ Nothing happens; on-disk state   │
│                                 │ survives                         │
└─────────────────────────────────┴──────────────────────────────────┘
```

---

## §3. R7.7.b — Recovery dialog

### §3.1 Trigger

На вході в `openDiffPane(conflictId)`:

```
1. Read base bytes from vault, compute SHA → currentBaseSha
2. Read sibling bytes from vault, compute SHA → currentSiblingSha
3. Check existence of .diff2-autosave/<conflictId>/meta.json:
   - absent → fresh session, no dialog (create autosave dir from scratch:
     copy basePath → base.snapshot, copy siblingPath → sibling.snapshot,
     write meta.json, init cursor-a.json (seq 0) — §2.9 ping-pong)
   - present → read meta.json
     - JSON.parse fails → cleanup `<conflictId>/`; fresh session
     - sanity-check: sha(read("base.snapshot")) === meta.baseShaAtStart
       AND sha(read("sibling.snapshot")) === meta.siblingShaAtStart
       → If false → corruption; cleanup; fresh session (§4.2 condition 5)
     - **replay-validity gate** (§2.5 `joinedDocSha`):
       `SHA(serializeModel(buildModel(currentBase, currentSibling))) === meta.joinedDocSha`?
       → НЕ збігається І входи незмінні → **library-drift** → start fresh без діалогу
         (restore зі snapshot теж не відтворить; §3.5 / §8 #8). Збігається → продовжуємо нижче.
     - **NEW branch — snapshot vs current vault check:**
       - If currentBaseSha === meta.baseShaAtStart
         AND currentSiblingSha === meta.siblingShaAtStart
         → Vault unchanged since session start → §3.2 normal recovery dialog
       - Else (one or both vault files changed during session/offline)
         → §3.2.a snapshot-mismatch recovery dialog
```

### §3.2 Modal — контракт UX (ЄДИНИЙ recovery-modal)

`ResumeRecoveryModal` — один модаль для будь-якої перерваної сесії (resume І §3.2.a
one-side-changed). `*` маркує файл, що змінився у Vault під сесією (на чистому resume `*` нема).

```
┌───────────────────────────────────────────────────────────────────┐
│  Resume previous edit session?                              [×]   │
│                                                                   │
│  We found an unfinished edit session for:                         │
│  * base:  Notes/work/meeting.md                                   │
│  sibling: Notes/work/meeting.conflict-from-iphone-….md            │
│                                                                   │
│  Started:   12 minutes ago                                        │
│  Edits:     17 saved                                              │
│  Last:      14:32:15                                              │
│                                                                   │
│  * this file changed in the vault since the last editing session. │
│                                                                   │
│       [ Continue editing ]   [ Start over ]   [ Cancel ]          │
└───────────────────────────────────────────────────────────────────┘
```

**Кнопки:**

- **[Continue editing]** — primary. Дія залежить від reopen-стану: resume → replay
  REDO-log + cursor (§3.3, KEEP dir); §3.2.a one-side → перенести правку (механіка §3.2.a).
- **[Start over]** — wipe `.diff2-autosave/<conflictId>/`, fresh session з vault-state.
- **[Cancel]** / **[×]** — назад у list view; autosave **лишається** на диску.

`*`-маркер + зноска з'являються лише коли сторона змінилась (§3.2.a one-side); на чистому
resume їх нема.

### §3.2.a Vault-changed recovery — СИМЕТРИЧНО, реюзає §3.2 modal

Редактор працює і з парою base+sibling, і з **довільними file1/file2** (напр. Compare) —
**жодна сторона не привілейована**, тож відновлення симетричне. На reopen дивимось, ЯКІ
vault-файли змінились під сесією (`SHA(side) ≠ meta`):

- **Жодна не змінилась** (resume) → §3.2 `ResumeRecoveryModal`; Continue = replay-resume.
- **Рівно ОДНА сторона змінилась** → **той самий §3.2 modal** (`*` маркує змінений файл —
  без окремого лякливого «files changed»-діалогу: це просто відновлення від збою). Типово:
  після збою користувач відредагував САМ один файл напряму (§7). Стан резолюції
  (повне/часткове) **не має значення**. Дія Continue — нижче.
- **ОБИДВІ змінились** → **тихо нова сесія, без діалогу** (`reopenAction`:
  `discard-fresh "both-changed"`): правки повністю застаріли, зберігати нема що.

**Continue-механіка (one-side) — СЕСІЯ ПЕРЕСТВОРЮЄТЬСЯ (НЕ auto-merge), СИМЕТРИЧНО:**
записуємо відновлений вміст у сторону, чий **vault-файл НЕ змінився** (зберігаємо там
правку); за зміненою стороною лишаємо новий vault-вміст (її restored-вміст відкидається).

1. `resolved = getResolved()` — реплей у **DETACHED** pane (`{base, sibling}` / `{file1, file2}`);
2. перезаписати **незмінну** сторону її restored-вмістом (`atomicWriteFile`; вільно
   мутабельна §4.2/§5.2); змінену **НЕ чіпаємо**:
   - змінився base → пишемо `resolved.sibling` у `siblingPath`;
   - змінився sibling → **дзеркально** `resolved.base` у `basePath`;
3. `rmdir` стару сесію → `startSession` → нова diff-сесія: нова версія зміненої сторони vs
   restored-вміст незмінної.

- **[Start over]** → `rmdir` (нічого не пишемо) → `startSession` з поточного vault.
- **[Cancel]** → назад у list (dialog-first: нічого не змонтовано); autosave лишається.

**Чому безпечно й просто:** усе **diff2-layer** — нема merge-base, нема auto-merge (нова
сесія порівнює локально; запис у незмінну сторону — легітимна §4.2-мутація, що auto-merge
НЕ тригерить, §4.1/§6). Recreate'нута сесія має snapshots == поточний vault, тож на
`[← back]` exit-TOCTOU (§5.0) у §3.2.a-шляху **не спрацьовує**.

### §3.3 Continue editing — replay algorithm

**V2-канон** (`history-replay-v2.ts`): startState = `buildModel(base.snapshot, sibling.snapshot)`;
replay = **RE-RUN COMMANDS** з `history.jsonl` (§0.5) — edit→`dispatch(change + [setStructure?,
resolveCaret?] + isolateHistory на newGroup + replayDispatch)`, undo→`undo(view)`, redo→`redo(view)`.
Курсор резолюції — з реконструйованого `resolveCaret` (§0.5.1). Replay ЗУПИНЯЄТЬСЯ на першому
непридатному блоці (bug-56: НЕ throw → resume не брикається; base+sibling = ground truth) →
"recovered K of N edits", state = post-block-(K-1).

Після replay — застосувати cursor (§2.9 2-slot ping-pong): прочитати `cursor-a.json` +
`cursor-b.json`, взяти валідний слот з МАКС `seq` (жоден валідний → skip); `anchor/head =
clamp(saved, 0, doc.length)`; `view.dispatch({selection:{anchor, head}})`; за наявності —
`view.scrollDOM.scrollTop = saved.scrollTop`.

**Чому `view.dispatch` (не direct state mutation):** dispatch автоматично пише
undoable step у CM6 historyField. Після replay історія undo така ж, як перед
crash — `Ctrl+Z` йде назад послідовно.

> §3.3.a (synthetic-caret #10) **ВИДАЛЕНО 2026-06-13** — це був #10-throwaway (корінь бага). V2-курсор резолюції
> несе явні дані `resolveCaret {before,after}` (§0.5.1); typing-курсор native plain-text.

### §3.4 Start over — wipe + fresh

```
1. await vault.adapter.rmdir(`.diff2-autosave/${conflictId}`, true)  // recursive
2. Continue normal openDiffPane flow:
   - build joined doc з current base + sibling (тут current = коректно: fresh-session
     snapshots стають = current vault)
   - new meta.json + new history.jsonl + new base.snapshot/sibling.snapshot +
     new cursor-a.json (seq 0)
   - DiffPane opens fresh
```

### §3.5 Edge cases — повна таблиця

| Випадок                                                                           | Поведінка                                                                                                                                                                                                                           |
|-----------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `meta.json` присутній, `history.jsonl` відсутній                                  | Cleanup `<conflictId>/` цілком (§4.2 умова 2); fresh session без modal.                                                                                                                                                             |
| `meta.json` валідний, `history.jsonl` має 0 рядків                                | Modal **не показуємо** (фактично нема edits); видалити stale autosave; fresh session.                                                                                                                                               |
| `meta.json` corrupt JSON                                                          | Cleanup `<conflictId>/` цілком, fresh session (§4.2 умова 1).                                                                                                                                                                       |
| обидва cursor-слоти (cursor-a/b) відсутні | Cleanup `<conflictId>/` цілком (§4.2 умова 3); fresh session.                                                                                                                                                                       |
| `meta.json` валідний, перший блок `history.jsonl` corrupt                         | Modal показує "0 edits saved" + warning "previous session corrupt"; `[Continue]` disabled; доступний лише `[Start over]`.                                                                                                           |
| `meta.json` + redo OK, обидва cursor-слоти corrupt | Modal показуємо normally; `[Continue]` replay-ить redo; cursor — natural (§2.9). Logged warning.                                                                                                               |
| `meta.json` + redo OK, cursor-слот має `anchor > doc.length` | Clamp до `doc.length` (§2.9). Cursor у кінці документу.                                                                                                                                                                                    |
| Замінено base / sibling (SHA mismatch) між sessions                               | Cleanup (§4.2 умова 5); fresh session; modal не показуємо.                                                                                                                                                                          |
| `SHA(base) === SHA(sibling)` (auto-resolved)                                      | Cleanup (§4.2 умова 6); конфлікт фактично зник.                                                                                                                                                                                     |
| **library-drift** — `SHA(serializeModel(buildModel(input))) ≠ meta.joinedDocSha` при незмінних входах (§2.5 gate) | replay неможливий → **start fresh без modal** (restore зі snapshot теж не врятує). Жодного confirm-prompt. |
| `basePath` / `siblingPath` зник з vault                                           | Cleanup на onload sweep (§4.2 умова 4).                                                                                                                                                                                             |

---

## §4. Cleanup / TTL

### §4.1 Принцип: history-logs живуть вічно, поки релевантні

Користувач має право:

- Залишити конфлікт незакритим на тижні чи місяці.
- Мати десятки `<conflictId>/` одночасно.
- Повернутись до будь-якого в будь-який час.

**Безкоштовно**, поки SHA вхідних файлів не змінились і запис конфлікту існує.
Дисковий слід — кілька kB на сесію (cursor-a/b.json ~200 байт each, meta.json ~500 байт,
history-jsonl — пропорційний edit-кількості, типово 1-50 kB).

#### §4.1.a Інваріант zero-edit: сесія БЕЗ жодного запису не зберігається (ВАЖЛИВИЙ USECASE)

> **Named invariant:** *`.diff2-autosave/<id>/` варта зберігання ЛИШЕ якщо
> `history.jsonl` містить ≥1 trustworthy запис.* Сесія з **0 записів** не несе
> recovery-цінності (відкривати її — це лише «Resume previous edit session · 0
> edits saved», що безглуздо) і **нічого не змінює у вхідних файлах**
> (`splitModel(V2-моделі) === (base, sibling)` byte-exact — round-trip інваріант).

Наслідки (де саме чиститься 0-запис сесія):

1. **При БУДЬ-ЯКОМУ контрольованому виході — мовчки витираємо `<id>/`, НЕ
   ЧІПАЮЧИ вхідні файли:**
    - `[← back]` з 0 записів → **пропускаємо commit узагалі** (немає чого
      коммітити; і це обходить `commit7Step`-`safeRename`-swap, що сам по собі
      безпечніше для відкритих у tabs файлів) → `rmdir(<id>/)`, тихо в list.
      Реалізація — `commitOrDiscardExit` (`exit-commit.ts`), гілка
      `recordCount === 0 → discarded`.
    - Покинуто інакше (перемикання sub-tab, закриття view — «інший механізм»):
      `disposeActiveDiffPane` fire-and-forget `rmdir`, якщо
      `activeWriter.currentSeq() === 0`.
2. **Якщо вихід НЕ вдалось відстежити (краш / розряд батареї) — 0-запис dir
   лишається на диску і підчищається анонімно:**
    - onload sweep §4.2 умова **2b** (`assessHistory(history.jsonl).empty`), і/або
    - при повторному вході — reopen-skip (§3.5: empty → no modal → wipe+fresh).

**Зберігаємо `<id>/` ТІЛЬКИ коли:** є ≥1 запис **І** вихід був мимовільний
(краш / випадкове закриття tab `[x]`) — рівно той кейс, заради якого autosave й
існує. Контрольований `[← back]` з правками → правки потрапляють у вхідні файли
(commit) + `rmdir`. Тобто durable-стан між сесіями = **самі вхідні файли**, а
`<id>/` — суто recovery-буфер незакоміченого редагування.

> **Чому corrupt-first-block ≠ empty:** `assessHistory.empty` = 0 блоків **І**
> без corruption. Лог з пошкодженим ПЕРШИМ блоком має 0 trustworthy записів, але
> користувач *починав* редагувати — це окремий рядок §3.5 (модаль з warning), а
> НЕ zero-edit. Тому cond 2b і exit-wipe використовують саме `.empty`, не
> «blocks.length === 0».

### §4.2 Onload sweep — умови видалення

**Pre-check (precedence):** якщо у `<conflictId>/` присутній `done.json` —
це commit-in-progress; **НЕ** запускаємо §4.2 cleanup, натомі сть викликаємо
§5.0.a recovery sweep (roll-forward або rollback залежно від стану vault).
Тільки якщо §5.0.a fall-through на default fallback → переходимо до §4.2.

При plugin onload (інтегровано у `onloadRecoverySweep` — Phase 11 плану, R8.2)
для кожної директорії `<conflictId>/` у `.diff2-autosave/` БЕЗ done.json
перевіряємо:

```
for each <conflictId>/ in .diff2-autosave/:
    cleanup-причини (OR-сум — досить однієї):
        (1) в директорії немає meta.json
            (АБО meta.json не парситься як JSON)
        (2) в директорії немає history.jsonl (constant name)
        (2b) history.jsonl Є, але містить 0 trustworthy записів
             (assessHistory(history.jsonl).empty — §4.1.a zero-edit інваріант).
             NB: corrupt-FIRST-block (0 trustworthy, але .empty=false) НЕ свіпиться
             тут — це §3.5 corrupt-recovery, де БУЛА активність користувача.
             Контрольовані виходи вже витирають 0-запис сесії (§4.1.a); cond 2b
             ловить лише crash-survivors (вийшли до першого запису).
        (3) в директорії немає ЖОДНОГО cursor-слота (cursor-a.json / cursor-b.json)
            (cursor-a створюється при старті сесії — §2.9 ping-pong; якщо жодного
             нема — щось пішло не так на старті, лікуємо cleanup-ом)
        (4) в директорії немає base.snapshot АБО sibling.snapshot
            (snapshots обов'язкові; відсутність = corrupted autosave)
        (5) SHA snapshot-файлів НЕ матчиться з записаним у meta
            (sha(read("base.snapshot")) ≠ meta.baseShaAtStart АБО
             sha(read("sibling.snapshot")) ≠ meta.siblingShaAtStart)
            — corruption detection; meta і snapshots мають бути узгодженими
        (6) одного з вхідних файлів немає у vault
            (basePath АБО siblingPath НЕ exist)
        (7) SHA обидвох вхідних файлів у vault однакові
            (SHA(vault[basePath]) === SHA(vault[siblingPath]))
            — конфлікт фактично self-resolved у vault; autosave безглуздий
    if any of (1)-(7):
        vault.adapter.rmdir(`.diff2-autosave/${conflictId}`, true)
        log info "swept autosave: <conflictId> (reason: <N>)"
```

**Важлива зміна порівняно з попереднім дизайном**: умова "SHA(vault[basePath]) ≠
meta.baseShaAtStart" **більше НЕ cleanup-тригер**. Раніше — wipe autosave якщо
vault змінився. Тепер: vault-mismatch — це **trigger для recovery dialog** (§3.2.a),
де користувач сам вибирає (Continue / Start over / Cancel), а не silent wipe.
Завдяки snapshots ми відновлюємо роботу й несемо restored-вміст незмінної сторони далі (§3.2.a).

**Чому умова (6) — `SHA(base) === SHA(sibling)`** включена окремо: якщо файли
зрівнялись (через sync2 auto-merge на drain, ручне зведення, чи зовнішнє
редагування) — конфлікту нема. Жодна з умов (1)-(5) це сама по собі не
покриває (вхідні файли можуть лишатись на місці з оригінальними SHAs);
треба експліцитна перевірка.

**Note про "конфлікт зник з ConflictStore" як окрему умову:** покривається
сценаріями (4), (5), (6) на практиці — конфлікт зникає або через delete
файлу (4), або через зміну SHAs (5), або через зведення SHAs (6). Окрема
"conflictId not in store" умова — redundant у нормальному flow; пропускаємо.

### §4.3 Sweep idempotent

Повторні sweep-и безпечні. Wired через єдину точку `onloadRecoverySweep` (R8.2).

### §4.4 Manual cleanup

`.diff2-autosave/` лежить у vault і видимий у file explorer (як `.trash/`,
`.conflicts/`). Видалення вручну допустимо. Наступне відкриття будь-якого
конфлікту почнеться як fresh session.

---

## §5. `[← back]` exit algorithm + R7.7.c/R7.7.d interfaces

> ℹ️ **§5 — representation-INDEPENDENT і ВАЛІДНИЙ для V2.** Єдина заміна термінів: старий `split(joined)` → **V2
> `splitModel(doc, ranges)`** (`diff-model.ts`) — `exit-commit.ts` приймає `base`/`sibling: string`, представлення
> йому байдуже. Усюди нижче «`split(currentEditorDoc)`» читати як «`splitModel` живої V2-моделі».

### §5.0 `[← back]` — 7-step pair-atomic commit з `done.json` barrier

`[← back]` — це **точка коміту** обох сторін конфлікту назад у vault. Замість
наївного "записати буфер у один файл", алгоритм використовує `splitModel` (V2-моделі)
для отримання **обидвох** виходів і pair-atomic 2-phase commit protocol з
`done.json` як commit barrier.

**Чому 2-phase commit, а не два послідовних `atomicWriteFile`:** простий
sequential підхід може загубити користувацькі edits ver2-сторони при crash
між write base і write sibling — користувач натиснув `[← back]`, базовий
файл оновився, а sibling лишився старим, на наступному відкритті ver2-edits
silent зникають. 7-step protocol з pre-computed SHAs у `done.json` робить
recovery **deterministic**: на reopen знаємо точно, який стан target і
можемо roll-forward завершити commit.

**Naming convention** — `stagingPathFor()` з `src/sync2/atomic-write.ts`,
існуючий pattern: insert suffix перед extension:

- `"Folder/note.md"` → `"Folder/note.sync-tmp.md"` / `"Folder/note.sync-bak.md"`
- `".gitignore"` → `".gitignore.sync-tmp"` / `".gitignore.sync-bak"` (без ext → append)
- `"file.tar.gz"` → `"file.tar.sync-tmp.gz"` (insert before LAST ext)

Усі стейджинг файли видимі в Obsidian file explorer і indexed (на відміну
від схеми "append after ext", яка б їх скрити при "Show all file types: false").

**`done.json` — commit barrier з pre-computed expected SHAs:**

```json
{
  "v": 1,
  "writtenAt": "2026-05-29T14:45:00.000Z",
  "expectedBaseSha": "<git-blob-sha hex>",
  "expectedSiblingSha": "<git-blob-sha hex>",
  "deleteBase": true
}
```

`deleteBase` (опційне, пишеться лише коли `true`) — committed end-state base =
ABSENT (видалення). Дивись §5.0.g: потрібне для case-4 (had-content emptied),
бо meta не відрізняє його від справжнього 0-байт.

Пишеться atomic temp+rename, БЕЗПОСЕРЕДНЬО перед staging files. Її наявність
сигналізує "commit-in-progress, roll-forward via recovery". Її відсутність →
"no commit started" (autosave-recovery працює як завжди).

**UI guard (Step 0):** при першому кліку на `[← back]` view-state set-ить
`committing = true`; button disabled; повторні кліки rejected до завершення
commit (success / error). Без цього guard'а другий клік під час in-flight
commit (тобто між step 2 і step 7) міг би стартувати другий пройдення, що дає
undefined vault state.

```typescript
async function onBackClick() {
    if (this.state.committing) return;  // ignore
    this.state.committing = true;
    this.state.buttonEnabled = false;
    try {
        await commit7Step();  // §5.0 steps 1-8
    } catch (e) {
        new Notice(`Exit commit failed: ${e.message}. Try again or check log.`);
        this.state.committing = false;
        this.state.buttonEnabled = true;
        // autosave-dir + done.json лишаються; next openDiffPane → §5.0.a roll-forward
    }
    // на success — повертаємось detail→LIST view (Step 8), view НЕ закривається.
    // committing скидається у `finally` (на ВСІХ виходах: success / fail / cancel
    // / no-session), не лише в catch.
}
```

**Реалізовано (Step-0):** `DiffEditView.exitDetailView` — `if (this.committing) return;`
першим рядком, `committing=true`, тіло в `try { … } finally { committing=false; }` (скид на
всіх шляхах). Button-disable (візуальний) **свідомо пропущено**: flag прибирає реальну шкоду
(два конкурентні `commit7Step`), common-path ms-scale, довгий §5.0.e-шлях блокується модаллю,
а toolbar re-render'иться (persistent button-handle немає).

**7-step algorithm (з TOCTOU check на Step 1.5):**

```
Step 1. Flush pending history-queue (§2.8). RAM-state stable.

Step 1.5. **TOCTOU check** — verify input files не змінились ззовні під час сесії.
    currentBaseSha    = sha(vault[basePath])
    currentSiblingSha = sha(vault[siblingPath])
    
    // Порівнюємо до meta-stored SHAs (які за §2.5.a session-start
    // protocol гарантовано match snapshot bytes).
    if (currentBaseSha !== meta.baseShaAtStart
        OR currentSiblingSha !== meta.siblingShaAtStart):
        → НЕ через 7-step. Застосувати симетричне правило §5.0.e:
          • рівно одна змінилась → ТИХО single-side write (у незмінну) + rmdir + close + log;
          • обидві → save-to-alt модалка (editbox; Save/Discard/Cancel).
          (force-overwrite / abort-stay прибрано — змінений файл НІКОЛИ не затираємо.)
    
    else: SHAs match → vault state такий самий як при openDiffPane → continue Step 2.
    
    // Note: §3.2.a (vault-changed reopen) НЕ лишає stale-сесію відкритою — усі три
    // вибори dialog-first (Cancel → list; Continue/Start over → `startSession` →
    // нова сесія, snapshots == поточний vault). Тож у §3.2.a-шляху Step-1.5 TOCTOU
    // вже не спрацьовує. Цей check ловить ЛИШЕ зовнішню зміну base/sibling під ЖИВОЮ
    // сесією (sync2 pull / інший device) між openDiffPane і `[← back]`.

Step 2. (baseBytes, siblingBytes) = split(currentEditorDoc)
        expectedBaseSha = sha(baseBytes)
        expectedSiblingSha = sha(siblingBytes)
        atomicWriteFile(.diff2-autosave/<conflictId>/done.json, {
            v: 1,
            writtenAt: now(),
            expectedBaseSha,
            expectedSiblingSha,
        })
        — done.json завжди atomic temp+rename; partial write неможливий.

Step 3. await vault.adapter.writeBinary(stagingPathFor(basePath, "tmp"), baseBytes)
        await vault.adapter.writeBinary(stagingPathFor(siblingPath, "tmp"), siblingBytes)
        — Parallel (Promise.all) — це безпечно, файли в різних paths.
        — Crash тут: один або обидва staging files можуть бути incomplete.
          Detection: sha(disk file) ≠ done.json.expectedSha → re-execute.

Step 4. await promoteInPlace(vault, baseTmp,    basePath,    baseBytes)
        await promoteInPlace(vault, siblingTmp, siblingPath, siblingBytes)
        — **MODIFY-IN-PLACE (bug3).** promoteInPlace: existing TFile + modifyBinary
          доступний → `vault.modifyBinary(file, bytes)` (запис IN-PLACE — зберігає
          відкритий tab/cursor/scroll; rename-swap робив, що Obsidian бачив зникнення
          файлу й ЗАКРИВАВ tab). Новий файл (нема TFile) / mock → `safeRename(tmp→final)`.
          Оригінал НІКОЛИ не перейменовується вбік → **`.sync-bak` НЕ створюється**.
          Commit-point настає з ПЕРШИМ modifyBinary; до нього originals цілі (rollback).
        — modifyBinary НЕ атомарний → crash може лишити torn final (SHA≠expected). Це
          ОК: clean `.sync-tmp` (Step 3) — авторитетне джерело; recovery форсує його.
        — **SEQUENTIAL BY DESIGN** (base, потім sibling) — recovery читає одну лінійну
          послідовність (§5.0.b). Не Promise.all.

Step 5. await removeIfExists(vault, baseTmp); await removeIfExists(vault, siblingTmp)
        — Прибрати staging tmp. modify-in-place лишає tmp; new-file rename вже його
          спожив → removeIfExists = no-op там. (Це і є "step 6" старого протоколу;
          .sync-bak більше нема, тож окремого bak-cleanup немає.)

Step 6.5. if (expectedBaseSha === expectedSiblingSha):
              await vault.adapter.remove(siblingPath)
          — R7.11 proactive sibling cleanup. Конфлікт фактично закритий:
            sibling-bytes identical to base. adapter-level (не vault.delete),
            щоб не тригерити TrashStore і працювати для .obsidian/* config-dir-у.

Step 7. await vault.adapter.rmdir(`.diff2-autosave/${conflictId}`, true)
        — meta.json + history.jsonl + cursor-a/b.json + done.json зникають разом.

Step 8. return detail → LIST view (R2.2).
        NB: there is NO `historyClear` effect in @codemirror/commands, and none
        is needed — render() disposes the DiffPane and `view.destroy()` discards
        its CM6 history. "detachLeaf" was misleading: the view is NOT closed,
        only detail→list. (Realised: the exitDetailView success tail.)
```

**Чому окремий step 2 (compute SHAs + write done.json) перед step 3:**
рекордимо очікувані SHA **до** першого write на диск. Recovery знаючи expected
SHAs може verify partial writes і вирішити: "цей файл уже cleanly записаний,
залишається лише завершити commit" vs "цей файл torn-written, треба перепрошити".

### §5.0.a Recovery sweep на onload — detection і roll-forward

При plugin onload, додатково до §4.2 cleanup умов, сканем `.diff2-autosave/`:

```
for each <conflictId>/ in .diff2-autosave/:
    if done.json NOT present:
        → нормальна autosave-сесія; standard §4.2 cleanup logic.
        → continue.

    // done.json present → commit-in-progress detected
    parse done.json → (expectedBaseSha, expectedSiblingSha)
    read meta.json → (basePath, siblingPath)

    state-detection (existence + SHA-match) — ПУРА функція диска, per side:
        final = absent | old(SHA=startSha) | new(SHA=expectedSha) | foreign(інше)
        tmp   = absent | tmp✓(SHA=expectedSha) | tmp✗(інше — torn staging)
        // .sync-bak БІЛЬШЕ НЕ існує (modify-in-place ніколи його не створює).

    case analysis (нижче §5.0.b)
```

### §5.0.b Recovery decision — modify-in-place (bug3)

**`recoverCommit` — чиста функція стану диска** (`classifySide` обчислює `final`/`tmp`
для кожної сторони, далі диспетч). Реалізовано саме як диспетч, не як 11 хендлерів.
`.sync-bak`-колонки більше немає — modify-in-place ніколи не перейменовує оригінал
вбік, тож backup не створюється; rollback стається ЛИШЕ до першого modify (originals
цілі), а roll-forward бере байти з clean `.sync-tmp`.

Дискримінатор (по обох сторонах):

1. **Foreign guard:** сторона з `final = foreign` **І** `tmp ≠ tmp✓` → зовнішня правка
   (інший device / manual edit між crash і onload) → **fallback** (прибрати staging +
   dir, foreign-байти НЕ чіпати). NB: `foreign` **з** нашим `tmp✓` — це НАШ torn
   modifyBinary (не атомарний), НЕ зовнішнє → roll forward (нижче). Саме `tmp✓` розрізняє
   torn-наш від foreign-чужого (за rename-моделі torn final був неможливий, тож раніше
   `foreign` сам означав зовнішнє; modify-in-place додав torn-кейс).
2. **`hasNew(side) = final===new || tmp===tmp✓`.** Якщо `hasNew(base) && hasNew(sibling)`
   → **roll forward** обидві: `rollForwardSide` — `final≠new` → `safeRename(tmp→final)`
   (overwrite torn/old/absent чистим tmp; recovery біжить на onload, редактора нема →
   rename безпечний); `final===new` → drop tmp. Потім §6.5 sibling-cleanup + rmdir.
3. **Інакше** (хоча б одна сторона без new-версії — pre-modify / torn staging) → **roll
   back**: originals untouched (modify ще не починався) → видалити tmp(s) + done.json,
   **сесію зберегти** (autosave лишається, користувач дорезолвить).

Crash-точки нового протоколу → дія (усі покриті `exit-commit-recovery-matrix.test.ts`):

| Crash після…                          | base / sibling стан         | Дія          |
|---------------------------------------|------------------------------|--------------|
| Step 2 done.json (нічого не staged)   | old/absent, tmp absent       | roll back    |
| Step 3 staging (torn)                 | old, tmp✗                    | roll back    |
| Step 3 done (обидва tmp✓), pre-modify | old, tmp✓ × 2                 | roll forward |
| base modifyBinary TORN                | base foreign+tmp✓; sib old+tmp✓ | roll forward |
| base modify done, sibling ні          | base new+tmp✓; sib old+tmp✓  | roll forward |
| sibling modifyBinary TORN             | base new+tmp✓; sib foreign+tmp✓ | roll forward |
| обидва modify done, tmp не прибрані    | new+tmp✓ × 2                  | roll forward |
| Step 5 tmp прибрані                   | new, tmp absent × 2          | roll forward |
| GENUINE foreign (зовнішнє, без tmp✓)  | foreign, tmp absent          | **fallback** |

**Default fallback** (foreign без нашого tmp✓, чи meta зникла): прибрати done.json +
staging; vault лишається consistent, сесія втрачена.

### §5.0.c orphan sync-tmp/sync-bak без `.diff2-autosave/` запису

Якщо знаходимо `<path>.sync-tmp.<ext>` або `<path>.sync-bak.<ext>` у vault,
але немає відповідного `meta.json` в `.diff2-autosave/*/` (basePath/siblingPath
mismatch) — це **orphan** від існуючого `AtomicWriteRecovery.sweep` (PSEUDO-MERGE-MODE
§9.5). Не торкаємось — sync2 sweep сам розрулить.

Diff2 recovery sweep торкає тільки `<path>.sync-{tmp,bak}.<ext>` файли,
**які матчаться з якимось `.diff2-autosave/<conflictId>/meta.json`** (basePath
або siblingPath збігається). Інші — sync2-зона.

### §5.0.d Що відбувається на наступному drain (PSEUDO-MERGE-MODE Phase A)

Після успішного завершення `[← back]` (step 7 виконано):

| Стан vault                                | Phase A branch                            | Результат                                                                 |
|-------------------------------------------|-------------------------------------------|---------------------------------------------------------------------------|
| Sibling видалений (step 6.5 спрацював)    | "sibling was deleted by user" branch (§5) | Drop record + push base-bytes на main + sync2 finalizes.                  |
| Sibling лишився, `siblingSha === baseSha` | "engine-deletable" branch (§5)            | Drop record + delete sibling + push. **Резервний шлях**.                  |
| Sibling лишився, `siblingSha !== baseSha` | Conflict tracking branch (§4)             | Конфлікт живе далі. У наступному DiffPane менше diff-рядків — є progress. |

**Round-trip коректність:** `splitModel` ↔ `buildModel` (round-trip інваріант) гарантує,
що повторне відкриття конфлікту після partial-resolve `[← back]` показує
**рівно той самий progress**, який користувач залишив.

### §5.0.e `[← back]` exit when vault changed — symmetric, the SAME rule as §3.2.a

`classifyToctou` (Step 1.5) порівнює поточні base/sibling зі snapshot'ами. Це **той самий
«vault змінився під сесією»**, що й §3.2.a-reopen → **те саме симетричне правило** (записати
`getResolved()`-вміст у **НЕзмінну** сторону; обидві змінені → save-to-alt). Різниця лише в
часі (exit, не reopen) і в тому, що **після** (close замість recreate):

Реалізовано (W5) у `exit-commit.ts` (`commitUnchangedSide`/`commitToAlt`/
`AltTargetExistsError`) + `recovery-dialog.ts` (`SaveToAltModal`), dispatch у
`DiffEditView.resolveToctouExit`. Дискримінант — `baseChanged`/`siblingChanged` з `classifyToctou`:

- **Жодна не змінилась** → нормальний `commit7Step` (7-step pair-atomic, обидві сторони).
- **Рівно ОДНА змінилась** (XOR) → `commitUnchangedSide` — **ТИХО** (без Notice — лише
  `logger.info`): один `atomicWriteFile` `getResolved()`-вмісту у НЕзмінну сторону (змінився
  base → пишемо `resolved.sibling` у `siblingPath`; змінився sibling → дзеркально `resolved.base`
  у `basePath`); змінену сторону лишаємо «як є»; `rmdir` сесії; закриваємось у list. Конфлікт
  триває (нова версія зміненої сторони vs наш resolved незмінної) → користувач дорозв'яже потім.
  Той самий write, що §3.2.a Continue, але **close замість recreate**. НЕ через 7-step (single
  file → один atomic write достатньо, без `done.json`). Якщо після запису `SHA(base)==SHA(sibling)`
  — конфлікт реально закритий → наступний Phase A його drop'не (Step-6.5 тут НЕ дублюємо).
- **ОБИДВІ змінились** → `SaveToAltModal` (тут таки питаємо — незрозуміло, що узгоджували):
  > «Saved files changed — keep your resolution? Save your resolution under a different name,
  >  or discard it. The changed files are left untouched.» + **editbox** (prefilled
  >  `meta.basePath`) → `[Save]` / `[Discard]` / `[Cancel]` (+ ×).
  - **[Save]** з назвою `newName` → `commitToAlt`: якщо резолюція **зійшлась**
    (`resolved.base === resolved.sibling`) → пишемо **ТІЛЬКИ** `newName` (один файл); якщо
    **частковий** конфлікт → `newName` (base) **+** sibling під назвою, **похідною** від `newName`
    через `buildSiblingPath` (`*.conflict-from-*`) → синтетична конфлікт-пара триває під новою
    назвою. base пишемо ПЕРШИМ (краш лишає названий файл, не orphan-sibling). Оригінали (обидва
    змінені ззовні) **недоторкані**.

    **FAIL-CLOSED** (advisor): prefill — це `meta.basePath`, тож не-редагований `[Save]` затер
    би змінений-ззовні оригінал. Тому `commitToAlt` кидає `AltTargetExistsError`, якщо `newName`
    (чи похідний sibling) вже існує; модаль ще й inline-валідує на `[Save]` (не закривається на
    колізії). Це і є той самий інваріант «змінений файл НІКОЛИ не затираємо».

    **НЕ через `commit7Step`** (хоч `Commit7Options.targetBasePath/Path` і є): `recoverCommit`
    класифікує сторони за `meta.basePath/siblingPath`, а `done.json` не несе target-шляхів — тож
    alt-path commit структурно невідновлюваний (зовнішні оригінали → `foreign` → чистить не ті
    staging-слоти). Plain `atomicWriteFile` сам по собі crash-safe, а оригінали недоторкані у
    будь-якому разі — тож full pair-atomicity тут не потрібна (Occam).
  - **[Discard]** → `rmdir` сесії, close (робота відкинута, `logger.info`). **[Cancel]/[×]** →
    лишитись у редакторі.

**force-overwrite ВИДАЛЕНО** — ми НІКОЛИ не затираємо змінений ззовні файл (one-side пише лише
в НЕзмінну сторону; both-changed fail-close'иться на існуючому імені). (Стара форма §5.0.e —
save-to-alt / force / cancel для будь-якого mismatch — superseded цим правилом.)

### §5.0.f — Mid-edit vault-change detection — ВІДХИЛЕНО (§8 #12)

> **РІШЕННЯ (НЕ реалізуємо):** проактивний `vault.on('modify')` banner не потрібен.
> Користувач — власник свого Vault. Наш plugin НЕ модифікує активно-редаговані
> base/sibling при pull'і (нові дані → НОВИЙ sibling, не зміна наявного); зміна під
> сесією = інший plugin (не наша відповідальність) або сам користувач (його справа).
> Єдиний backstop — TOCTOU на `[← back]` (§5.0 Step-1.5). Код нижче — лише ілюстрація
> відхиленої альтернативи.

Поточний spec робить TOCTOU check **тільки** на `[← back]`. Відхилена альтернатива —
proactively detect зміни **під час** редагування:

```typescript
this.app.vault.on("modify", (file) => {
    if (file.path === meta.basePath || file.path === meta.siblingPath) {
        if (currentSha !== meta.shaAtStart) {
            showBannerInDiffPane(
                "⚠ Vault files changed since you opened this. " +
                "[← back] will trigger reconciliation modal. " +
                "Or [×] to discard your work and reload."
            );
        }
    }
});
```

Це дає user heads-up посеред edit-у, замість сюрпризу на `[← back]`. Скоуп
для post-v1.

### §5.1 R7.7.c / R7.7.d cliffsnotes

Деталі семантики виходу і tab-switching —
[`DIFF2_IMPLEMENTATION_PLAN.md`](../DIFF2_IMPLEMENTATION_PLAN.md) R7.7.c та R7.7.d.

**`[← back]`** — повний algorithm у §5.0 вище. Підсумок: flush queue → split →
atomicWriteFile base + sibling → optional sibling-remove on SHA-match → rmdir
autosave-dir → close.

> **§4.1.a zero-edit гілка `[← back]`:** якщо `recordCount === 0` (жодного
> запису в `history.jsonl`) — **пропускаємо весь §5.0 commit**: немає чого
> коммітити (`split(fromEditorModel) === inputs`), тож просто `rmdir(<id>/)` +
> тихо назад у list, **БЕЗ запису у вхідні файли і БЕЗ `safeRename`-swap**.
> Реалізація — `commitOrDiscardExit` (`exit-commit.ts`). Те саме — для
> покидання через перемикання sub-tab / закриття view (`disposeActiveDiffPane`).

**`[×]` tab close / покидання (sub-tab switch, закриття leaf):**

1. CM6 buffer drops з RAM.
2. **§4.1.a розгалуження за `recordCount`:**
    - **0 записів** → `rmdir(.diff2-autosave/<conflictId>, recursive)` (немає чого
      відновлювати; `disposeActiveDiffPane` fire-and-forget).
    - **≥1 запис** → `<conflictId>/` **ЛИШАЄТЬСЯ** — закриття tab могло бути
      випадковим, тож autosave переживає для recovery (рівно кейс, заради якого
      autosave існує). Наступний openDiffPane → recovery dialog (§3).
3. Vault-файли у session-start state у будь-якому разі (покидання НЕ коммітить).

**Crash / Obsidian killed / battery die** (involuntary exit):

1. CM6 buffer lost (RAM).
2. `.diff2-autosave/<conflictId>/` SURVIVES.
    - history-log: до 500 ms staler than RAM (pending-queue lost).
    - cursor.json: до 2 sec staler (active typing) або 5 sec (navigation).
3. Next openDiffPane → recovery dialog (§3).

**Tab switching у межах Obsidian (НЕ tab close):** leaf лишається живим у
background, CM6 буфер у пам'яті переживає, coalesce-flush + cursor-timer
продовжують працювати. Тільки **явне** закриття tab-у видаляє autosave.

**`workspace.on('quit')` / `app.on('quit')`** — НЕ wire як alias до tab-close.
Це б тихо стирало autosave при кожному звичайному Cmd+Q, ламаючи саме той
сценарій (clean shutdown ≈ crash з погляду DiffPane).

---

### §5.0.g Empty-base resolution semantics (R3.3, 2026-06-18..19) — DONE, shipped

Коли resolved base = `""`, що лягає на диск визначає `commit7Step.baseCommitAction`
(а НЕ `resolvedFromView`, який тепер повертає **сирі** `""`). Дискримінатор —
**стан base на старті сесії** (`AutosaveMeta.baseExistedAtStart` + `baseShaAtStart`;
`SHA("")` сам по собі не розрізняє «відсутній» від «присутній-0-байт»):

| випадок (base при відкритті) | resolved base | результат |
|---|---|---|
| **відсутній** (delete-vs-modify) | `""` | **DELETE** — файл лишається відсутнім, без stub |
| **0-байтовий** (справжній порожній) | `""` | записати **0 байт** (SYNC2 §2.9 пропускає при snapshot.size===0) |
| **з контентом**, вичищено (case-4) | `""` (обидві сторони!) | **`EmptyDeleteModal`** 3-way → Delete / Keep("\n") / Cancel |
| будь-який | непорожній | записати байти |

- **`EmptyResolveChoice` = "delete" | "keep" | "cancel".** `commitOrDiscardExit`
  приймає `confirmEmptyDelete` callback, що викликається **лише** на ok-commit
  шляху (після TOCTOU) коли `isHadContentEmptied` (= обидві сторони порожні +
  base мав контент). `cancel`→`{kind:"cancelled"}` (лишитись у редакторі);
  `delete`→`commit7Step({confirmedDelete:true})`; `keep`→звичайний commit
  (`"\n"` fallback). **Both-empty gate** обовʼязковий: partial (base порожній,
  sibling з контентом) НЕ показує модалку (видалення осиротило б sibling →
  re-listed конфлікт), трактується як звичайний edit → `"\n"`.
- **`done.json.deleteBase?: boolean`** (authoritative) — пишеться commit7Step,
  бо meta не відрізняє підтверджений case-4-delete від справжнього 0-байт.
  `recoverCommit` читає `done.deleteBase` (fallback на meta-inference
  `expectedBaseSha===SHA("") && !baseExistedAtStart` для delete-vs-modify).
  `classifySide(expectedAbsent)` мапить absent→committed; `rollForwardSide(delete)`
  довершує видалення; `baseHasNew = deleteBase || …` (sibling гейтить пару →
  безпечний rollback). Обидві порожні сторони комітяться SAME `emptyRepBytes` →
  step 6.5 прибирає sibling.
- **`Commit7Result.baseDeleted`** → `[← back]` Notice каже «Deleted <path>» (а не
  «Saved», bug-30) + суфікс « (conflict file removed)» при step-6.5.
- **§5.0.e + §3.2.a single-write шляхи** (`commitUnchangedSide`/`commitToAlt`/
  reopen restore) лишають локальний `guardEmpty` (empty→`"\n"`) — вони не йдуть
  через commit7Step.
- **Keep-empty = `"\n"` (1 байт), НЕ справжній 0-байт** — це узгоджений компроміс.
  Справжній 0-байт потребував би §2.9 carve-out + одноразового «intentional-empty»
  сигналу в движку (відхилено). Звичайне вичищення нотатки до 0 поза diff-editor
  досі ловиться §2.9 (немає сигналу наміру).

---

## §6. Mobile append benchmark — Settings test button

> **ВІДПРАЦЮВАВ І ПРИБРАНИЙ (2026-06-03).** Кнопку Settings → "Run mobile autosave
> benchmark" (+ `src/diff2/autosave-benchmark.ts` + тест) було додано, прогнано на Android
> mid-tier, і **видалено** — тимчасовий prep-інструмент, що своє відпрацював. Результат:
> `single-append p95 = 3.10 ms`, `cursor-rewrite p95 = 28.01 ms` (n=200, block=641B) →
> запінено per-transaction-no-coalesce (§2.8) + cursor 2500/6000 ms (§2.9). Специфікація
> нижче лишається на випадок повторного заміру (напр. iOS, §6.3) — тоді кнопку відновити з git.

### §6.1 Що вимірюємо

```
1. Створити <vault>/.diff2-perf-test/ директорію.

2. Прокрутити 1000 ітерацій (per-block-append benchmark):
   a. Generate ~200-byte JSON block (типовий history-block).
   b. t0 = performance.now()
   c. await vault.adapter.append(`.diff2-perf-test/single.jsonl`, block + "\n")
   d. t1 = performance.now()
   e. latencies.push(t1 - t0)

3. Прокрутити 100 ітерацій (batched 10x append benchmark):
   a. Generate 10 blocks, concatenate з \n.
   b. t0; append; t1
   c. batchedLatencies.push((t1 - t0) / 10)  // per-block amortized

4. Прокрутити 100 ітерацій (cursor.json atomic-rewrite benchmark):
   a. Generate ~200-byte JSON.
   b. t0
   c. await vault.adapter.write(tmp, data); rename(tmp, cursor.json)
   d. t1; cursorLatencies.push(t1 - t0)

5. Report:
   - p50, p95, p99 (single-append, batched 10x amortized, cursor-rewrite)
   - total wall-time per benchmark
   - throughput (blocks/sec) для single і batched

6. Cleanup: rmdir(.diff2-perf-test/, recursive).

7. Log full result через logger.ts (рівень INFO).

8. Show Notice "Benchmark done; see plugin log for details."
```

### §6.2 Decision rules

Базуючись на single-append p95:

| p95 single-append | Рішення для production                                                                              |
|-------------------|-----------------------------------------------------------------------------------------------------|
| < 10 ms           | Append per CM6 transaction, no coalesce. Найпростіша імплементація.                                 |
| 10–50 ms          | Coalesce 150 ms idle / 500 ms typing-pause / 10 blocks (default plan §2.8). Sweet spot.             |
| 50–200 ms         | Coalesce 300 ms idle / 1000 ms typing-pause / 20 blocks. UX ще ОК.                                  |
| > 200 ms          | **Re-think** — або coalesce на 500 ms / 2000 ms, або writing раз на end-of-session. Critical issue. |

Базуючись на cursor-rewrite p95:

| p95 cursor-rewrite | Рішення для cursor-timer                                                         |
|--------------------|----------------------------------------------------------------------------------|
| < 20 ms            | 1-2 sec active / 3-5 sec navigation (default §2.9).                              |
| 20–80 ms           | 2-3 sec active / 5-8 sec navigation.                                             |
| > 80 ms            | 5 sec active / 10 sec navigation. UX degrades, але recovery все одно прийнятний. |

### §6.3 На якій платформі гнатимемо

- **Android** (mid-tier): ✅ **ПРОГНАНО (2026-06-03)** — Capacitor bridge
  найповільніший, тож це консервативна межа. Результат: `single-append
  p95 = 3.10 ms`, `cursor-rewrite p95 = 28.01 ms` (n=200, block=641B) →
  рішення запінено (§2.8 per-transaction-no-coalesce; §2.9 cursor 2500/6000ms).
- **iOS** (iPhone): не прогнано — APFS зазвичай швидший за Android, тож
  Android-межа покриває. Якщо колись знадобиться — відновити кнопку з git і
  заміряти; нижчі числа лише послаблять вимоги.
- **Desktop**: baseline — не заміряли; очікувано p95 < 5 ms (значно нижче
  Android), тож запінені значення з запасом.

Рішення вже прийняте на Android-даних (найгірший кейс). Кнопку прибрано
(§6 банер).

---

## §7. Тестовий план

> Канонічний набір — **`tests/diff2/*.test.ts`** (+`crash-resilience/`, `spikes/`) та
> `tests/integration/scenarios/diff2/`. Запуск: `pnpm test` / `pnpm test:integration`.
> §1-ерні тести (build-split / collision / §1.x-поведінка / старий persistence-формат)
> **видалені разом із §1-кодом**. Нижче — покриття по КАТЕГОРІЯХ; джерело істини — сам
> каталог (файли додаються без оновлення цього списку).

### §7.1 Unit (`tests/diff2/`)
- **V2-модель + interaction (§2.2.x у DIFF-EDITOR-V2.md):** `diff-model` / `diff-structure` /
  `diff-pane-v2` / `diff-decorations` / `diff-edits` / `diff-resolve` / `diff-selection` /
  `diff-nav` / `diff-line-numbers` / `diff-toolbar` / `word-level-diff` / `auto-resolve` /
  `merge-triggers` / `selection-delete` / `keyboard-selection-motion` / `marker-click-caret` /
  `marker-selection-render` / `mouse-drag-select` / `clipboard-copy` / `clipboard-paste` /
  `editing-behavior` / `touch-only` / `search-gate` / `spec-v2-coverage`.
- **Персистентність (§0.5):** `history-log-v2` / `history-replay-v2` / `history-feed` /
  `history-compact` (карусель) / `recovery-forward` / `bug56-replay`.
- **Autosave / session / commit / recovery (§2–§5):** `autosave-session-start` / `autosave-id`
  (+`-for-entry`) / `autosave-root` / `autosave-cleanup` / `exit-commit` (7-step + A–K) /
  `exit-toctou` / `onload-recovery` / `recovery-dialog` / `reopen-action` / `cursor-store` /
  `cursor-timer` / `undo-redo-cursor-fidelity` / `editor-tabs` / `diff-detail-controller` /
  `diff-pane-owner` / `diff-edit-view-v2-glue`.
- **EOL (bug-59):** `eol` / `crlf-eol`.
- **Конфлікти / trash:** `synthetic-detector` / `conflict-merge-all` / `strip-conflict-suffix` /
  `trash-store-*` / `trash-watcher` / `trash-recovery`.

### §7.2 Crash injection (`tests/diff2/crash-resilience/`)
`autosave-session-start-crash` (session-start ordering), `exit-commit-recovery-matrix`
(§5.0.a A–K roll-forward), `history-rewrite` (карусель atomic swap + onload recovery),
`trash-*` (kill mid-meta / mid-writeBinary / lift / sweep).

### §7.3 Integration (`tests/integration/scenarios/diff2/`)
`n-series-trash/` — end-to-end проти реального GitHub (під `pnpm test:integration`).

### §7.4 Manual / device
- Mobile perf benchmark (§6).
- iOS / Android low-memory + force-kill через OS task manager.
- Battery-die simulation (заряд < 1%).

---

## §8. Open questions / TBD

| #  | Питання                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Default (якщо не вирішимо)                                                                                               |
|----|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| 1  | ~~Lock `diff` library до specific patch / range?~~ **RESOLVED (superseded)** — diff pinned at **v9** (ratified); replay-validity no longer rides on the version. §2.5 `joinedDocSha = SHA(serializeModel(buildModel(base,sibling)))` detects library drift DIRECTLY (classifyReopen → `library-drift`), so a chunk-boundary change is caught at reopen, not guarded by a version lock.                                                                                                           | (resolved)                                                                                                               |
| 2  | ~~Checksum algorithm для §2.6: FNV-1a / CRC32 / SHA-256-prefix?~~ **RESOLVED** — `fnv1a32` (hex), implemented in `history-log-v2.ts`. Fast, no crypto dep.                                                                                                                                                                                                                                                                                                          | (resolved)                                                                                                               |
| 3  | ~~Coalesce window cap — 10 blocks чи інше?~~ **RESOLVED (benchmark, Android 2026-06-03)** — `single-append p95 = 3.10 ms < 10 ms` → flush-timer coalesce **викинуто**, append per CM6 transaction (§2.8). W2: `HistoryWriter` пише per-transaction через **serialized tail-promise chain** (без QUEUE_CAP). **NB (V2 §0.5.4):** це стосується WRITE-шляху; block→undo-group coalescing (1b, `newGroup` з `undoDepth`-дельти) — окреме й ОБОВ'ЯЗКОВЕ, не flush-timer.                                                                                                                                                                | (resolved)                                                                                                               |
| 4  | ~~Single DiffPane tab per conflictId enforcement?~~ **RESOLVED** — §2.4 invariant. Двa tab-и недопустимі (race на autosave).                                                                                                                                                                                                                                                                                                                                                | (resolved)                                                                                                               |
| 5  | ~~Recovery dialog "Edits: N saved" — як рахуємо?~~ **RESOLVED** — рахуємо **REDO-блоки в `history.jsonl`** (= `scanHistory` trustworthy-prefix block-count). W4 — dialog ще не wired, але механізм готовий.                                                                                                                                                                                                                                                                                       | (resolved)                                                                                                              |
| 6  | ~~Окремий nav-log поряд з history-log для cursor?~~ **RESOLVED** — НЕ потрібно; 2-слот ping-pong `cursor-a/b.json` (§2.9) достатньо. | (resolved) |
| 7  | ~~Mobile test button — до / в межах Phase 5?~~ **RESOLVED** — побудовано окремим preflight, прогнано на Android, і **видалено** (values запінено §2.8/§2.9). Не частина Phase 5/6; для iOS re-measure відновити з git.                                                                                                                                                                                                                                                      | (resolved)                                                                                                               |
| 8  | ~~`joinAlgoVersion` mismatch — strict / lenient?~~ **RESOLVED (superseded)** — `joinAlgoVersion` ВИКИНУТО з meta.json; замінено на `joinedDocSha`. Mismatch тепер = classifyReopen's `library-drift` статус. Обробка (W4, узгоджено з §3.1): **start-fresh + warning Notice**, НЕ resume — replay-offsets рахуються проти `baseSiblingToModel(snapshot)`, а зміна diff-lib може дати інший clean-doc, тож replay був би несоундним. (Lib і так пінено v9; drift рідкісний.) | (resolved)                                                                                                               |
| 9  | ~~Cursor-timer paused коли tab not focused / backgrounded?~~ **RESOLVED** — timer працює ЛИШЕ коли редактор у фокусі редагування, і пише слот ЛИШЕ якщо позиція змінилась із попереднього запису (dirty-check). Не-фокус / background → таймер не пише; battery — non-issue. (§2.9.)                                                                                                                                                                                                                                                                                                                                                                                         | (resolved)                                                                                                              |
| 10 | ~~click на `=====` chars — keep as no-op, чи activate ver-blocks?~~ **RESOLVED** — `=====` завжди neutral. `<<<<<` / `>>>>>` чутливі тільки коли відповідний ver-block порожній.                                                                                                                                                                                                                                                                                     | (resolved)                                                                                                               |
| 11 | ~~Recovery-side TOCTOU: якщо crash + vault changed before reopen — wipe autosave + user втрачає всю роботу.~~ **RESOLVED** — §3.2.a recovery dialog тепер дає user-choice (поточна форма — див. §3.2.a) замість silent wipe; snapshots зберігають ground truth.                                                                                                                                                                                | (resolved)                                                                                                               |
| 12 | ~~Проактивний mid-edit banner (§5.0.f) на `vault.on('modify')`?~~ **RESOLVED — НЕ потрібно.** Користувач — власник свого Vault і знає, що робить. Наш plugin **НЕ модифікує** активно-редаговані base/sibling при pull'і з репо (нові дані → НОВИЙ sibling, не зміна наявного); тож зміна base/sibling під сесією — це або інший plugin (не наша відповідальність), або сам користувач (його справа — хай видаляє/перейменовує siblings як хоче). Єдиний backstop — TOCTOU на `[← back]` (§5.0 Step-1.5 → `classifyToctou` aborts-and-stays, WIRED W1).                                                                                                                                                                                                                                        | (resolved)                                                                                                              |

---

**Документ-канон:** оновлювати при будь-яких змінах документ-моделі (§1),
формату history-log або cursor (§2.5–§2.9), recovery-dialog контракту (§3.2),
cleanup правил (§4). Inconsistency між цим документом і кодом — це регресія;
правити одне з двох до синхронізації.
