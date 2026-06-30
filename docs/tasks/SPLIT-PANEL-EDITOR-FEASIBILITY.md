# Feasibility: розділення diff-panel і diff-editor по різних табах

> Research note (2026-06-29, branch `fix-diff-editor`). Дослідження можливості +
> **ратифіковані рішення користувача** (Option A, persistent, open-guard, `[←]`).
> Це ще НЕ план імплементації — план у окремій сесії (§9).
>
> **⚠️ СКОУП (advisor-review 2026-06-29).** Дві різні речі в одному доку:
> 1. **РАТИФІКОВАНО + дешево + перевірено:** split конфлікт-редактора (`diff2-panel`
>    singleton + `diff2-editor` multi-tab + write-set open-guard + origin-routing).
>    `DiffPaneOwner` instance-scoped, recovery свайпає всі dir-и — будувати можна зараз.
> 2. **VISION, НЕ free-reuse:** History (§10) і Deleted (§11) **потребують НОВОГО коду** —
>    one-sided recovery (бо `classifyReopen` читає обидві сторони з Vault, а read-only
>    сторона там не live-файл) + виправлений commit (§11 ≠ §10). Залежать від
>    невідвантажених Phase 7/8/9b. Сиквенсити, не будувати замок одразу (§9).

## TL;DR

**Розділення можливе і технічно дешеве.** Дані-шар уже повністю до цього готовий:
`DiffPaneOwner` — instance-scoped (ключ = `conflictId`, власний writer / cursor /
autosave-dir, **жодного module-global стану**), а `recoverAutosaveDirs` на onload
свайпає *усі* autosave-dir-и. Тобто кілька одночасних редакторів уже зараз
disk-safe і recovery-safe. Обмеження «один tab» — це **UI/state-machine рішення в
`DiffEditView`**, а не жорстка зв'язаність.

**АЛЕ** правило «не відкривати другий редактор для того самого файлу» — це не
зручність, а **вимога write-safety** (§3): ключ lock-а — **перетин write-set
`{base, sibling}`**, а НЕ `conflictId`.

---

## 0. ЗВЕДЕНІ ПРАВИЛА (rulebook — канонічний quick-reference)

> Усі ратифіковані правила в одному місці. Розгорнуте обґрунтування — у секціях нижче.

**R-A. View-types (Option A).** Поточний split = **два** view-types; History (§10)
додає **третій**. **🔑 УНІФІКОВАНИЙ ІНВАРІАНТ УНІКАЛЬНОСТІ (user 2026-06-30): КОЖЕН diff2-таб
унікальний за своїм ключем** — дублювання (через Obsidian "Split"/clone) НЕДОПУСТИМЕ для всіх
трьох; guard = «на mount, якщо інший leaf мого view-type з моїм ключем уже існує → я клон →
detach self + reveal original»:
- `diff2-panel` — **ОДИН на Vault** (singleton; ключ = view-type, 1 дозволено). Sub-tabs =
  **тільки Conflicts / Deleted** (як зараз). **History-sub-tab ВИКИНУТО (user 2026-06-30):**
  не дублюємо Obsidian-file-tree у панелі.
- `diff2-history` *(§10)* — **singleton** view-type (ключ = view-type, 1 leaf, reused per file
  через setState). Вхід **ТІЛЬКИ** через пункт **"History" контекст-меню файлу в Obsidian
  file-tree** (не через дерево в панелі). Список GitHub-версій файлу + toolbar-фільтр.
- `diff2-editor` — **багато табів, унікальний за парою `base:sibling`** (ключ = `autosaveId`;
  звідки б пара не походила: конфлікт із панелі, контекст-меню, Compare, чи History-версія).
- Клік по рядку панелі (конфлікт) АБО по History-версії → відкриває `diff2-editor` таб (за
  open-guard).

**R-B. Open-guard (write-set intersection) — уніфіковане правило (2026-06-29).**
- Кожен відкритий редактор має write-set (conflict `{base,sibling}`; history
  `{currentFile}`; deleted `{originalPath}`; compare — за edit-target).
- **(1) Та сама невпорядкована пара** `{A,B}` уже відкрита (зокрема swapped `sibling+base`)
  → **новий таб НЕ відкривається**, просто **фокус** → наявний editor-leaf. Без діалогу.
- **(2) Частковий перетин** write-set нової пари з відкритим (`base:other` / `sibling:other`
  — спільний один файл) → **діалог** «файл `X` зараз зайнятий в іншому diff-editor» з
  двома діями: **[Перемкнутись на той таб]** або **[Cancel]** (лишитись і працювати далі
  в history/deleted/звідки прийшов). Новий таб НЕ відкривається в жодному разі.
- Окремо відкриті користувачем base-/sibling-файли у звичайних редакторах **НЕ лочаться**
  (дозволено; захист — на рівні write-протоколу). Лочимо тільки дубль diff-editor.
- **НЕМА read-only mode** (рішення користувача 2026-06-29): у редакторі є лише
  **touch-mode** (typing блокується, але resolve-кнопки ПИШУТЬ). Окремого «view-only,
  ніколи не пише» режиму нема й не планується. Тому **ВСІ** diff2-редактори
  (вкл. History/Deleted/Compare) — editable → беруть write-set-lock на свою writable-
  сторону весь час, поки відкриті.
- **Прийнятий наслідок:** History/Deleted файлу `note.md` тримає lock на `note.md`, тож
  не можна одночасно тримати відкритим конфлікт того ж `note.md` (Notice «зайнято»). Це
  прямий наслідок write-set-правила — узгоджено.

**R-C. Persistence.**
- І `diff2-panel`, і кожен `diff2-editor` таб **переживають рестарт Obsidian**.
- Кожен editor-таб **сам** запускає recovery при відновленні. Старт може бути трохи
  довшим за багатьох редакторів — прийнятно.
- `getState/setState` на editor-view зберігає **`{origin, anchorPath, basePath,
  siblingPath, kind}`** — `origin`+`anchor` ОБОВ'ЯЗКОВІ, інакше відновлений таб не знає,
  куди вести `[←]` (R-D). + ревізія `main.ts:534` unload-`detachLeavesOfType`.
- **✅ Blocker знято (verified 2026-06-29):** відкрита-незакомічена сесія (без
  `done.json`) при onload НЕ видаляється. `classifySweep` (autosave-cleanup.ts:55-106):
  здоровий mid-session dir (meta + ≥1 правка + cursor-слот + snapshot-и == meta + входи
  на місці + base≠sibling) → `keep`. Свіпаються лише нецінні (0 правок / corrupt / входи
  зникли / self-resolved). Recovery (до `layoutReady`) завершується ДО відновлення табів;
  kept dir → таб тихо replay-ить; нецінний свіпнутий → таб класифікується `fresh`.

**R-C2. Тихий restore vs відоме recovery-повідомлення — за точкою входу.**
- **Restore при рестарті** (plugin/Obsidian; таб був ВІДКРИТИЙ → Obsidian сам кличе
  `setViewState` зі збереженим станом) = **continuation** → **ТИХО** для recoverable
  сесії (replay без модалки). Користувач просто продовжує ту саму сесію.
- **Користувач закрив editor-таб «хрестиком»** (close-x, без `[←]`) → autosave-сесія
  лишається «припаркованою» (не комітнута, не витерта, якщо є реальні правки). **При
  повторному відкритті цієї пари** (через панель/контекст-меню = наш `openEditorForPair`)
  → показуємо **наше відоме `ResumeRecoveryModal`** — але **лише якщо сесія recoverable**
  (статус `resume` або one-side `restore`, R-F).
- Реалізаційний сигнал: `getState()` повертає лише ІДЕНТИЧНІСТЬ пари (без openMode),
  тож restored-стан ніколи не має openMode → тихо; `openEditorForPair` інжектить
  транзієнтний `openMode:"user"` → модалка. (Або `app.workspace.layoutReady` як
  альтернативний сигнал «restore триває».)
- **І restart, і reopen ЗАВЖДИ проганяють `classifyReopen` — але це НЕ запит до
  користувача «файли змінились?».** Це лише ВИРІШУЄ, чи історія застосовна (R-F). Якщо
  ні — **тихо викидаємо історію** й відкриваємо base+sibling з нуля. Жодного блокуючого
  діалогу про зміну файлів.
- close-x чистої сесії БЕЗ правок → §4.1 abandon-wipe прибирає dir → reopen = fresh,
  без модалки (несуперечливо).

**R-F. Матриця відновлення (джерело істини — `classifyReopen` → `reopenAction`).**

> **Принцип:** ground truth = **base+sibling файли** (їх завжди можна відкрити в diff
> з нуля); `history.jsonl` — **ПОХІДНЕ, best-effort**. Користувач завжди може повторити
> правки сам. Якщо replay не лягає чисто — **тихо дропаємо історію** і відкриваємо пару
> з нуля. Якщо виходить відновитись від збою — робимо; якщо ні — тихо ігноримо. НІКОЛИ
> не допитуємо користувача про «файли змінились».

Гейт replay-валідності = `joinedDocSha` (V2 fingerprint доку+partition; інжективний на
`(base,sibling)`). Статуси:

- **`fresh`** (нема meta) → нова сесія.
- **`resume`** (`joinedDocSha` збігається — входи фактично ідентичні) → **RECOVERABLE**,
  replay історії. *reopen після close-x* → §3.2 `ResumeRecoveryModal` (Continue / Start
  over / ×); *restart-restore* → тихо.
- **`vault-changed`, змінилась ОДНА сторона** → `restore`: ще recoverable. Та сама §3.2
  модалка з **«*»** на зміненому файлі (це просто crash-recovery, НЕ страшний діалог);
  на Continue відновлена правка **НЕЗМІНЕНОЇ** сторони пишеться на нову версію + сесія
  перестворюється. **Симетрично** (base ≡ sibling, без привілею).
- **`vault-changed`, змінились ОБИДВІ сторони** → `discard-fresh (both-changed)`:
  **ТИХО** — правки повністю застаріли, історія дропається, base+sibling відкриваються
  з нуля, **без діалогу**.
- **`library-drift`** (входи ті самі, partition інакша = змінився jsdiff) →
  `discard-fresh`: replay-офсети несумісні → fresh (+ Notice).
- **`corrupt`** (`meta` / snapshot-integrity / input-missing) → `discard-fresh`:
  cleanup → fresh.
- **`sentinel`** (`\0/\1` у вході; під V2 практично недосяжно) → defensive `discard-fresh`.

(Примітка: **відсутній base** читається як 0 байтів = легітимний delete-vs-modify —
сесія resume-иться чисто, це НЕ `corrupt`.)

> **🔑 REPLAY vs DETECTION — не плутати (виправлено 2026-06-29 після зауваження
> користувача; verified у коді).**
> - **REPLAY (реконструкція доку для history.jsonl) ЗАВЖДИ зі `*.snapshot`** —
>   `readResumeSession` читає `baseSnapshotPath`/`siblingSnapshotPath`, НЕ оригінали
>   (autosave-store.ts:374). Тобто для history/deleted replay працює БЕЗ змін. Це і є
>   сенс копіювання у `*.snapshot`.
> - **DETECTION (`classifyReopen`)** — ЄДИНЕ місце, що читає **live vault**, і то
>   НАВМИСНО: «чи змінився оригінал з початку сесії» (resume/restore/discard). R-F (дві
>   live-сторони) — для `conflict`/`compare`.
> - Для `history`/`deleted` одна сторона **read-only й immutable** (історія / trash) —
>   її «поточні» байти теж беремо зі **snapshot** (тривіально «не змінилась»); live-vault
>   читаємо лише для **writable** сторони. → **one-sided detection**. Це МАЛЕНЬКА
>   параметризація `classifyReopen` («яка сторона read-only»), НЕ новий recovery-підсистем.
>   Реального бага зараз нема (`classifyReopen` кличеться лише для конфліктів) — закласти
>   на History/Deleted-фазі.

**R-D. `[←]` (back) = finalize-or-discard + close + navigate (за ORIGIN-tag).**
- `[←]` → **фіналізує ЯКЩО є net-правки, інакше discard** (`commitOrDiscardExit` уже
  так робить — нема read-only mode, але «подивився й нічого не змінив» = нема net-правок
  = нічого не пише) → **ЗАКРИВАЄ цей editor-таб**. diff2-editor несе **origin-tag**
  (`conflict | compare | history | deleted`) + anchor-path. Принцип: `[←]` веде туди,
  **звідки прийшов поточний vault-файл**.
- **`conflict`** (anchor = `basePath`): фокус `diff2-panel:Conflicts` + скрол на
  base-групу; якщо base вже без конфліктів → просто фокус панелі.
- **`history`** (anchor = `siblingPath` = поточний файл; base = віртуальна історична
  версія): фокус **`diff2-history`** для поточного файлу (звідти `[←]` → дерево History).
- **`deleted`** (anchor = `basePath` = originalPath; sibling = вміст із `.trash`,
  read-only): фокус `diff2-panel:Deleted` (§11).
- **`compare`** (нема у панелі): відкрити/сфокусувати base-файл у звичайному табі.
- Наслідок: list-mode зникає з editor-таба — `diff2-editor` ЧИСТО detail; списки —
  в `diff2-panel`/`diff2-history`. (Деталі + base/sibling-таблиця: §8 + §10; back-кроки:
  conflict/deleted = 1, history = 2.)

**R-E. Похідні інваріанти (без змін, з наявної архітектури).**
- diff2 не чіпає ConflictStore-семантику, не пушить/не мутує conflict-branch — лише (a)
  пише base через `atomicWriteFile`, (b) `adapter.remove(sibling)` при SHA-match (R7.11).
- `src/sync2/` не імпортує з `src/diff2/` (напрям залежності незмінний).
- R3.7 «last detail-tab close → `resetLifts()`»: «останній таб» = **останній
  editor-leaf** (рахувати відкриті editor-leaf-и; на 0 → `resetLifts`). Стосується
  Compare/Deleted (Phase 8/9b) — не блокує поточний conflict-resolve split.

**R-G. Зовнішня зміна ВІДКРИТОГО редактора (новий ризик довгоживучих табів).**
Multi-tab редактори стоять відкритими набагато довше за старий single-view. Якщо
sync/інший пристрій змінить/видалить base чи sibling, **поки редактор відкритий** —
покладаємось на **exit-TOCTOU** (`classifyToctou` на `[←]` → §5.0.e symmetric write):
live-view показує старий вміст до `[←]`, але запис фіналізується безпечно (ground truth =
файли). Це **узгоджено** з нашою філософією. Окреме live-реагування (ConflictWatcher уже
event-driven — міг би перемалювати/попередити) — **опція на потім**, не вимога Фази 1.

---

## 1. Чому зараз single-tab — і чи split це порушує

Справжні причини в `DIFF2_IMPLEMENTATION_PLAN.md` §R2.0. Усі три — проти
**two-pane-в-одному-табі** (ліва колонка-список + права DiffPane), а НЕ проти
кількох табів:

1. На мобільному ліва панель забирає 30–50% ширини → detail нечитабельний.
2. При роботі через зовнішній diff (R6) detail не потрібен — треба повноширокий список.
3. Single-pane спрощує state-машину і відповідає mobile-native back-stack навігації.

**Висновок: split на окремі ТАБИ не реінтродукує жодної з цих проблем — він їх
ПОСИЛЮЄ.** Кожен таб лишається single-pane на всю ширину; на мобільному «назад» =
перемкнутися на таб-панель (той самий back-stack UX). Тобто пропозиція користувача
*більш* узгоджена з R2.0, ніж поточний list↔detail в одному табі.

Це і є відповідь на objection користувача: одна панель-на-Vault + багато редакторів
прибирає саме те обмеження («панель зайнята, другий файл не відкриєш»), яке зараз
блокує context-menu-entry (R2.7.1) і Compare-any-two (R2.1).

## 2. Технічна основа вже готова

- `DiffPaneOwner` (`diff-pane-owner.ts`) — усе instance-scoped: `view`, `flag`,
  `writer`, `cursorScheduler`, ключ `conflictId`. Нічого глобального → N власників
  одночасно безпечні в пам'яті.
- Autosave/commit/cursor/history — усе на диску в `.diff2-autosave/<id>/`, ключ per
  conflict (`autosaveIdForEntry`: tracked→`record.id`, synthetic→`deriveAutosaveId`).
- `recoverAutosaveDirs` (onload) уже свайпає **усі** dir-и, не один → recovery вже
  multi-session.
- `main.ts:534` детачить усі leaf-и view-type на unload.

## 3. 🔴 Критичний інваріант: lock по WRITE-SET `{base, sibling}` (рішення користувача 2026-06-29)

`commit7Step` — **pair-atomic**: на `[←]` він пише base+sibling разом. Тож у кожного
відкритого редактора є **write-set = `{basePath, siblingPath}`** (обидва файли, які
він перезапише на commit). Два редактори, чиї write-set-и перетинаються, = **гонка за
байти спільного файлу**.

**Правило відкриття (open-guard).** Перед відкриттям нового редактора для пари
`{A, B}`:

- Якщо **та сама невпорядкована пара** `{A, B}` вже відкрита (зокрема `sibling+base` —
  поміняні місцями) → **новий таб НЕ відкривається**, просто фокус → наявний editor-leaf
  (без діалогу).
- Якщо write-set `{A, B}` **частково перетинається** з write-set іншого відкритого
  редактора (напр. `sibling+other_file` ділить `B`) → **діалог** «файл `B` зараз зайнятий
  в іншому diff-editor»: **[Перемкнутись на той таб]** / **[Cancel]** (лишитись і
  працювати далі). Новий таб НЕ відкривається.

**Чому write-set, а не лише base.** `synthetic-detector` повертає
`byBasePath: Map<base → entries[]>` — один base може мати кілька siblings. У чистому
conflict-resolution siblings глобально унікальні (`*.conflict-from-device-ts`), тож
практично перетин буває лише по спільному `base` (= «по base», як інтуїтив користувача).
Але загальне правило «перетин write-set» потрібне наперед під Compare-any-two (R2.1),
де довільний файл може стати стороною іншого порівняння. Read-only — лише **сторона**
(history-snapshot / trash-вміст), яка нікуди не пишеться й тому НЕ входить у write-set;
самого read-only РЕЖИМУ редактора нема (тільки touch-mode). conflict-редактор має
write-set `{base, sibling}`; history → `{currentFile}`; deleted → `{originalPath}`.

**НЕ лочимо** окремо відкриті користувачем base-/sibling-файли у звичайних редакторах —
це дозволено; захист від конкурентного запису — на рівні самого write-протоколу.
Лочимо тільки **дубль diff-editor для вже відкритої пари / перетину**.

Наслідок UX: кілька siblings одного base резолвляться **по черзі** (як зараз). Паралелізм —
між РІЗНИМИ (неперетинними) парами.

## 4. Persistence: таби переживають рестарт, кожен self-recover (рішення користувача 2026-06-29)

Редактори — **persistent**, НЕ ephemeral. І панель, і кожен editor-таб переживають
рестарт Obsidian; кожен editor-таб **сам** запускає recovery при відновленні. Уся
машинерія для цього вже є.

- **Панель** (singleton-список) — тривіально відновлюється (немає стану крім sub-tab).
- **Editor-таб** — `getState()` зберігає лише ідентичність пари
  (`{basePath, siblingPath, kind}`, без openMode); `setViewState()` на відновленні
  ре-маунтить owner. **Тихий vs модалка — за точкою входу (R-C2):** restore при рестарті
  = тихо (continuation); reopen після close-x = `ResumeRecoveryModal` (лише для
  recoverable). Обидва шляхи проганяють `classifyReopen`, але це НЕ запит про зміну
  файлів — лише вибір гілки матриці **R-F** (recoverable → replay; ні → тихо викинути
  історію, відкрити base+sibling з нуля).
- Старт може бути **трохи довшим**, якщо відкрито багато редакторів (кожен реплеїть свій
  `history.jsonl`) — прийнятно.
- ⚠️ Прибрати/уточнити `main.ts:534` `detachLeavesOfType` на unload, щоб воно не
  знищувало editor-таби (інакше вони не переживуть disable/enable — а ми хочемо, щоб
  переживали рестарт). Перевірити взаємодію unload vs app-restart serialization.

## 5. Точки дотику (для майбутньої імплементації, НЕ зараз)

- **View-types.** Розділити `DIFF2_EDIT_VIEW_TYPE` на:
  - `DIFF2_PANEL_VIEW_TYPE` — singleton (списки Conflicts/Deleted), активація =
    reveal-or-create єдиного leaf.
  - `DIFF2_EDITOR_VIEW_TYPE` — multi-leaf, dedup по `basePath`.
- **`activateDiffEditView`** → два шляхи: (a) reveal/create панель; (b)
  `openEditorForBase(basePath, siblingPath)` з per-base reveal-existing.
- **ConflictCounter subscription** — переїжджає в панель (list-refresh). Кожен
  редактор тримає власний `escScope` (push лише поки leaf активний — логіка вже
  per-leaf).
- **R3.7 «last detail-tab close → `trashStore.resetLifts()`».** «Останній таб» тепер
  = **останній EDITOR-leaf** (не один view). Треба лічити відкриті editor-leaf-и і
  кликати `resetLifts()` на 0. Це лише defensive-normalizer (onload-recovery вже
  чистить stale lift-маркери), і стосується Compare/Deleted (Phase 8/9b — ще не
  рендеряться), тож НЕ блокує поточний conflict-resolve split.
- **Title / view-header** — кожен редактор показує свій `basePath` (механіка
  `getDisplayText` + `.view-header-title` уже є).

## 6. Рекомендація: Option A

**Option A — два окремі view-types** (`diff2-panel` singleton + `diff2-editor`
multi-leaf). Робить інваріанти *примусовими* через Obsidian-helper-и:
`getLeavesOfType("diff2-panel")` → singleton; `getLeavesOfType("diff2-editor")` →
ітерація для open-guard (§3 write-set). Трохи більше коду (новий view-type +
розщеплення `activateDiffEditView`), але «одна панель на Vault» — жорсткий інваріант.

Option B (один view-type, кілька leaf, один «вважається» списком) — менше churn, але
«одна панель» тримається лише на конвенції + клас має сам розрізняти панель/редактор.
**Не рекомендую.**

## 7. Рішення користувача (2026-06-29) — зафіксовано

1. **A vs B** — ✅ **Option A**. Два види:
   - `diff2-panel` — **ОДИН на Vault** (singleton).
   - `diff2-editor` — по одному на пару `base:sibling` (звідки б пара не походила).
   - Клік по рядку панелі → новий `diff2-editor` таб.
2. **Persistence** — ✅ **persistent**: і панель, і кожен editor-таб переживають
   рестарт; кожен editor-таб сам запускає recovery (§4).
3. **Open-guard** — ✅ блок по **перетину write-set `{base,sibling}`** усіх відкритих
   редакторів; та сама пара (зокрема swapped) → фокус у наявний таб без нового; інший
   перетин → Notice (§3). Це правило критичне саме під Compare-any-two: довільний файл
   уже відкритий в одній diff-парі не можна знову відкрити в іншій.

## 8. 🔴 `[←]` (back) — закриває editor-таб + навігує (рішення користувача 2026-06-29)

`[←]` лишається фіналізацією конфлікту АБО записом проміжного стану (commit-логіка
`commitOrDiscardExit`/`commit7Step` зберігається). Але тепер це **дія над табом + навігація**,
а не внутрішнє list↔detail-перемикання:

**Завжди:** `[←]` спершу комітить (як зараз), потім **ЗАКРИВАЄ цей `diff2-editor` таб**.

**Куди ведемо далі — залежить від ORIGIN редактора.** diff2-editor несе
**origin-tag** (`conflict | compare | history | deleted`) + явний **anchor-path**, і
`[←]` маршрутизує за ним. Об'єднавчий принцип: **`[←]` веде туди, звідки прийшов
поточний (vault) файл** — лише його «якір» зветься `base` (conflict/deleted) або
`sibling` (history) (див. base/sibling-таблицю у §10).

**Чотири ланцюжки back-кроків:**

```
diff2-editor ─[←]→ diff2-panel:Conflicts            (conflict — 1 крок)
diff2-editor ─[←]→ diff2-panel:Deleted              (deleted  — 1 крок)
diff2-editor ─[←]→ diff2-history (список версій файлу)    (history — 1 крок; далі [←]→ закрити, file-tree завжди в sidebar)
diff2-editor ─[←]→ (звичайний таб base-файлу)       (compare  — 1 крок)
```

**ОНОВЛЕНО (user 2026-06-30):** History-дерево в панелі ВИКИНУТО → history-ланцюжок тепер
1 крок (editor → `diff2-history` список версій); вхід у `diff2-history` = пункт "History"
контекст-меню файлу в Obsidian file-tree (а не дерево в панелі), `[←]` з `diff2-history`
просто закриває таб (file-tree завжди доступне в sidebar). Conflicts/Deleted — плоскі списки в
панелі (1 крок).

- **`conflict`** (пара-конфлікт, є запис у `diff2-panel`; anchor = `basePath`):
  - Відкрити/сфокусувати `diff2-panel:Conflicts` і **проскролити на base-групу**.
  - Після resolve sibling зникає, але якщо у base лишились ІНШІ siblings — base-група
    ще в панелі → скрол до неї. Якщо це був **єдиний** конфлікт цього base → base зникає
    з панелі → скрол неможливий → просто **фокус на панель**.

- **`history`** (anchor = `siblingPath` = поточний файл; base = віртуальна історична
  версія, її у Vault нема):
  - Відкрити/сфокусувати **`diff2-history`** для **поточного файлу** (= шлях sibling).
    Звідти ще `[←]` → дерево `panel:History` з фокусом на файлі.

- **`deleted`** (anchor = `basePath` = originalPath у Vault; sibling = вміст із `.trash`,
  read-only — §11):
  - Відкрити/сфокусувати `diff2-panel:Deleted`. Resolve у бік sibling (вміст) →
    **відновлює** файл; resolve у бік base (порожньо) → лишає **видаленим**.

- **`compare`** (два довільних файли, пари НЕМА в `diff2-panel`):
  - Закрити editor-таб, тоді **відкрити base-файл у звичайному табі** (або сфокусувати).

> Наслідок для §5: «list mode» більше не живе в editor-табі. `diff2-editor` — це
> ЧИСТО detail. Список — лише в `diff2-panel`/`diff2-history`. `[←]` не «повертає в
> список», а закриває таб і передає фокус за origin-якорем.

## 9. Наступний крок — СИКВЕНСИНГ (advisor 2026-06-29)

Не будувати замок одразу. Фази:

**Фаза 1 — split конфлікт-редактора (ратифіковано, дешево, перевірено). ⮕ Детальні
стейджі S1–S6 + поділ 1A/1B — у §12.** Коротко: `DiffPanelView` (singleton, рядок
`diff2-edit-view` СТАЛИЙ) + новий `diff2-editor-view` (multi-tab); екстракція detail-
двигуна (шов = host-callback `onExitComplete`); `openEditorForPair(guard)`; `[←]` →
finalize-or-discard + `leaf.detach()` + навігація (§8, **жива лише гілка `conflict`**);
**1A** = multi-tab+guard+`[←]` (editors ephemeral; resume-modal уже задарма), **1B** =
рестарт-persistence окремо. R3.7 «last editor-leaf close → resetLifts» — у 1B.

**Forward-design ЗАРАЗ (коштує нуль):** `origin`-enum (`conflict|compare|history|
deleted`) і узагальнення write-set/open-guard — закласти одразу, щоб History/Deleted
не вимагали рефакторингу пізніше.

**Фаза 2+ — History (§10) / Deleted (§11): ЗА їхніми фазами (Phase 7/8/9b) І за новим
кодом:** (a) one-sided `classifyReopen` (read-only сторона зі snapshot, R-F-нота); (b)
коректний commit (History=`commitUnchangedSide`; Deleted=delete-aware base-only, НЕ
`commitUnchangedSide`). **Не «free reuse».** (Нема read-only mode — лише touch-mode;
read-only стосується immutable СТОРОНИ, не режиму.)

**Перед Фазою 1 — верифікувати «no coupling» у CALLER-ах** (advisor): grep
`getActiveViewOfType(DiffEditView)` / single-active-view-припущення / module-level
mutable state, окрім `setAutosaveRoot` (config-once = ок). Власника (`DiffPaneOwner`)
вже доведено чистим — лишилось довести callers.

**Persistent-tab × onload-recovery (інваріант, не припущення):** recovery
(`recoverCommit`/`recoverAutosaveDirs`, ДО `layoutReady`) має **завершитись до того**,
як будь-який відновлений таб торкнеться свого `.diff2-autosave/<id>/`; таб, чий dir
recovery прибрав, на committed-результаті класифікується як `fresh`. Ймовірно вже так
за порядком — **ствердити тестом**, не припускати. І: масове відновлення табів
**обходить** `openEditorForPair`-guard (вони були неконфліктними при створенні).

## 10. VISION — History (розширює R2.3 / R7.9b / Phase 7)

> Vision користувача (2026-06-29). Ще один драйвер split-у (окремий `diff2-history`
> view-type). Будувати ПІСЛЯ split-у І за новим one-sided recovery; узгодити з R2.3
> (не форкати). **НЕ «free reuse» — див. point 1.**
>
> **🔴 СПРОЩЕНО (user 2026-06-30): крок-1 (History-дерево в `diff2-panel`) ВИКИНУТО.** Не
> дублюємо Obsidian-file-tree. Вхід у History = **пункт "History" контекст-меню файлу в
> Obsidian file-tree** → відкриває `diff2-history` (singleton) ОДРАЗУ для цього файлу. Тобто
> нижче «крок 1 = дерево» НЕ актуальний; лишаються 2 рівні: `diff2-history` (список версій) →
> `diff2-editor` (версія). `diff2-panel` має ТІЛЬКИ Conflicts/Deleted sub-tabs (як зараз).

**Що хоче користувач (переглянуто 2026-06-29 — back-stack замість 2-panel):**

НЕ робимо 2-panel (знімає мобільний конфлікт R2.0). Замість цього — **single-pane
back-stack із 3 кроків / 3 view-types**:

1. **`diff2-panel` → sub-tab History** = **дерево каталогів Vault** (тільки vault, БЕЗ
   `.obsidian/`). Крок навігації.
2. **`diff2-history`** *(НОВИЙ view-type, singleton)* = для ОДНОГО обраного файлу —
   список його **закомічених на сервер** версій + toolbar-фільтр (**період**:
   тиждень/місяць/рік, налаштовується + **пошукова фраза**) + **`[←]`**, що повертає в
   дерево History **з фокусом на цьому файлі** (щоб продовжити рух по дереву, в т.ч.
   клавіатурою).
3. Клік по версії → знайомий **`diff2-editor`** таб, де **base = історична версія**,
   **sibling = поточний файл**.

**`[←]` крокує назад по ланцюжку:** `diff2-editor` → `diff2-history` (список версій
того ж файлу) → дерево History (фокус на файлі).

**🔑 base/sibling-семантика (і чому `[←]`-якір різний).** Поточний (vault) файл грає
РІЗНІ ролі в конфлікті та в історії:

| Режим      | `base` = ver1, «−» (видалене/старіше)        | `sibling` = ver2, «+» (додане/новіше)      | пишемо (vault)      | `[←]`-якір → |
|------------|----------------------------------------------|--------------------------------------------|---------------------|--------------|
| `conflict` | поточний vault-файл (`note.md`)              | remote `.conflict-from-*` (theirs)         | base **і** sibling  | **base** → panel:Conflicts |
| `history`  | історична версія (нема у Vault, read-only)   | **поточний файл** (current)                | тільки **sibling**  | **sibling** → `diff2-history` |
| `deleted`  | порожньо = поточний відсутній стан (`originalPath`) | вміст із `.trash` (read-only) | тільки **base**     | **base** → panel:Deleted |
| `compare`  | файл A                                        | файл B                                     | редагований файл (editable; write-set за edit-target) | base-файл (звич. таб) |

«+» (sibling/ver2) = що ДОДАНО з останньої версії; «−» (base/ver1) = що ВИДАЛЕНО.
`[←]`-якір = **той самий «поточний vault-файл»**, лише зветься по-різному: `conflict`/
`deleted` → `base`, `history` → `sibling`. Зверни увагу на **дзеркальність history↔deleted**:
в history read-only — base (історія), пишемо sibling; у deleted read-only — sibling
(trash), пишемо base.

- Entry-point: контекст-меню на звичайному дереві Obsidian → **«GitHub History»** →
  відкриває одразу крок 2 (`diff2-history`) для цього файлу (а дерево History в панелі —
  з фокусом на ньому).
- **✅ РІШЕННЯ (2026-06-29): крок 2 — ОКРЕМИЙ view-type `diff2-history`, НЕ detail-mode
  в panel:History.** Причина: треба прямий вхід із context-menu на файлі в Obsidian-дереві
  (detail-mode вимагав би спершу пройти дерево History до цього файлу; окремий view-type
  відкривається для файлу напряму). `diff2-history` — singleton, перевикористовується на
  кожен обраний файл; `[←]` повертає у дерево panel:History з фокусом на файлі.

**🔴 Архітектурні рішення, які варто закласти ЗАРАЗ (поки дешево):**

1. **COMMIT — ✅ reuse §5.0.e; RECOVERY — 🔴 НОВИЙ код (advisor 2026-06-29).**

   **(a) Commit reuse ✅.** base (історична версія) НІКОЛИ не пишеться: підвантажується з
   GitHub/push-queue у `base.snapshot` при КОЖНОМУ відкритті. `commitUnchangedSide(
   changedSide:"base")` (exit-commit.ts) пише `resolved.sibling` → `meta.siblingPath`,
   base не торкає — оголошуємо base ЗАВЖДИ «зміненим». Один `atomicWriteFile`, `guardEmpty`
   (emptied→`"\n"`); НЕ `commit7Step`. *(History ніколи не видаляє поточний файл — `"\n"`
   guard тут доречний, на відміну від Deleted, §11.)*

   **(b) Recovery — replay ✅ reuse, detection — мала параметризація.** REPLAY уже зі
   `*.snapshot` (`readResumeSession`) → works as-is. Лише DETECTION (`classifyReopen`)
   читає live vault; для history read-only base брати теж зі `base.snapshot` (immutable)
   → перевіряти лише чи змінився `currentFile` (sibling). **One-sided** — прапорець «яка
   сторона read-only», НЕ нова підсистема (R-F-нота вище).

   **(c) НЕМА read-only mode** (рішення користувача 2026-06-29) — редактор editable
   (тільки touch-mode toggle). Тож History-редактор бере lock на `currentFile` весь час.
   - **open-guard write-set = `{currentFile}`** (база — історія, нікуди не пишеться).
   - Наслідок: не можна тримати відкритим History `note.md` І конфлікт `note.md` одночасно
     (R-B Notice) — узгоджений наслідок write-set-правила.
   - autosave-id включає **sha версії**: `deriveAutosaveId("history", currentPath, versionSha)`.

2. **✅ Мобільний конфлікт ЗНЯТО (back-stack замість 2-panel).** Раніше 2-panel
   (дерево | список) реінтродукував би R2.0-проблему (бічна колонка з'їдає 30–50% на
   мобільному). Переглянутий 3-крок-back-stack (tree → `diff2-history` → editor, `[←]`
   крокує назад) — кожен крок single-pane, повна ширина, mobile-native — повністю
   узгоджений з R2.0. `diff2-history` — singleton (як панель), перевикористовується на
   кожен обраний файл.

3. **push-queue-first (R2.3 lazy-load) лишається.** Якщо в `.push-queue/` є коміти й
   кеш GitHub порожній — показуємо тільки push-queue + кнопка `[Show GitHub history…]`;
   не б'ємо GitHub автоматично (R2.3). Time-filter → `listCommitsForPath({since})`.

4. **Пошук по історії (dream / backlog).** Авто-підвантаження історичних версій для
   grep-у = **N GitHub-викликів + кеш на диску** — треба обмежити: лише в межах обраного
   періоду, lazy/on-demand, з кешем у `.diff2`. Per-file scope. Це ІНШИЙ звір, ніж
   §2.2.17 in-editor `@codemirror/search` (той — у відкритому документі; цей — крос-версійний
   крос-remote). Мітка: окрема фаза, оцінити вартість API/сторінкування перед стартом.

5. **✅ РІШЕННЯ (2026-06-29): History = ПОВНА машинерія, ЄДИНИЙ diff-editor для всіх
   випадків.** (Знімає scoping-нудж advisor-а — легший «re-fetch + re-resolve» шлях
   ВІДХИЛЕНО.) Причина користувача: можна захотіти «попрацювати» зі старою версією довго —
   вибрати лише окремі шматки старих версій І дописати/закомітити щось **зовсім нове**.
   Тобто потрібні повний edit + autosave + history.jsonl + replay + recovery так само, як
   у конфліктах. diff-editor однаковий для conflict/history/deleted/compare — жодного
   спрощеного варіанту.

6. **Backlog-ідея: Obsidian tab ← / → для History-навігації.** Вбудовані стрілки таба =
   нав-історія leaf-а (працюють, якщо пушити view-state з `history:true`). НЕ для нашого
   `[←]` (той КОМІТИТЬ, а стрілки — pure-nav) і НЕ всередині diff2-editor (одна пара=один
   таб; `←` відкотив би на іншу пару). Можлива вторинна зручність у `diff2-history`:
   open-версії як history-push → стрілки = «назад до версії, яку щойно глянув» (але
   ОСНОВНИЙ стрибок по версіях = явний prev/next у toolbar, бо стрілки = «що дивився», не
   «хронологічно сусіднє»). Вирішити на History-фазі.

7. **`deriveAutosaveId` kind-union.** Розширити тип `kind` на `"history"|"deleted"`
   (зараз `"synthetic"|"compare"`). Тіло (sort+`\0`+FNV-1a) **не валідує path** → bare-sha
   / trashId як 2-й арг проходить без проблем (verified autosave-store.ts:98-105).

**Узгодження зі spec:** R2.3 наразі описує «active file, single-pane, push-queue-first».
Ця візія = дерево-навігація + `diff2-history` view-type + time-filter + пошук. На етапі
плану — ОНОВИТИ R2.3/R7.9b/Phase 7 під цю модель (а не форкати): R2.3 лишається data-шаром
(`listCommitsForPath` + push-queue fallback), History — його новий UI.

## 11. VISION — Deleted sub-tab (розширює R2.4 / R3.6; ЧАСТКОВИЙ reuse absent-base)

> Vision-нотатка (2026-06-29, advisor-reviewed). `diff2-panel:Deleted` — це **sub-tab у
> панелі** (як Conflicts/History), НЕ окремий view-type. Плоский список → клік →
> `diff2-editor` (origin `deleted`), `[←]` → назад у `panel:Deleted` (1 крок).

**Модель (дзеркало History):**
- **`base` = порожньо** = поточний відсутній стан за `originalPath` (= «наш» бік, WRITABLE).
- **`sibling` = вміст видаленого файлу** з `.trash/<id>/vault/<originalPath>` (read-only).
- Resolve у бік **sibling** (взяти вміст) → **відновлює** файл (пишемо `originalPath`).
- Resolve у бік **base** (порожньо) → лишаємо **видаленим**.

**Як лягає на код — ЩО reuse, ЩО нове (advisor):**
- 🔴 **Commit ≠ History — спільне ядро через factoring (пропозиція користувача).**
  Deleted МУСИТЬ вміти видаляти (resolve→порожньо = лишити видаленим), а
  `commitUnchangedSide` робить `guardEmpty`→`"\n"` (1-байтовий файл, НЕ видалення).
  Рішення: виділити **delete-capable ядро** (напр. `resolveOrDeleteUnchangedSide` —
  параметр `allowDelete`), а наявний `commitUnchangedSide` стає тонкою обгорткою, що
  кличе ядро з `allowDelete:false` (тобто `guardEmpty`→`"\n"`, delete НІКОЛИ). History →
  обгортка; Deleted → ядро з `allowDelete:true`. Delete-семантику взяти з
  `commit7Step.baseCommitAction` (absent→delete / write-content + `EmptyDeleteModal`,
  milestone 2026-06-19). ⚠️ Sibling тут = trash (read-only) → vault-файл для нього НЕ
  створюється: ядро пише ТІЛЬКИ writable-сторону (base=`originalPath`), без pair-atomic.
  ⚠️ **VERIFY-before-estimate (advisor):** перед тим як назвати base-only «дешевим»,
  прочитати тіло `commit7Step` — `done.json` хешує **обидві** staged-сторони + step-6.5
  unify; degrade до однієї сторони може бути НЕтривіальним. Не оцінювати наосліп.
- 🔴 **Recovery — one-sided, як History** (sibling=trash immutable → detection бере зі
  snapshot; replay уже snapshot-based). R-F-нота вище.
- 🔴 **Variant B — зайнятий `originalPath`** (файл видалено→перестворено): restore НЕ
  має затирати live-файл → **collision-rename** `<stem>.restored-<iso-ts>` (R2.4 уже це
  специфікує). Без цього — тихе data-loss.
- **НЕМА read-only mode** (тільки touch-mode) → Deleted-редактор editable, бере lock на
  `originalPath` весь час. **open-guard write-set = `{originalPath}`** (sibling=trash
  нікуди не пишеться).
- autosave-id: `deriveAutosaveId("deleted", originalPath, trashId)`.
- R3.7 compare-lift: під час deleted-edit trash-запис «lifted» (`liftedAsSessionId`), щоб
  drain його не змів.

> **📝 Naming debt (зауваження користувача 2026-06-29).** Префікс `commit*`
> (`commit7Step`, `commitUnchangedSide`, `commitToAlt`, `commitOrDiscardExit`,
> `recoverCommit`) у diff2 означає «фіналізувати резолв на диск», а НЕ git-commit — але
> плагін РЕАЛЬНО робить GitHub-commit-и (sync2 push), тож префікс перевантажений і
> вводить в оману (diff2 пише vault-файли; коміт+push на сервер — це вже sync2 пізніше).
> Чесніша назва — `resolve*` / `write*` / `finalize*` (напр. ядро з factoring →
> `resolveOrDeleteUnchangedSide`). Це окремий cleanup (зачіпає DIFF-EDITOR.md §5.0 +
> усі call-site-и + тести) — НЕ робити мимохідь; рішення на етапі плану.

## 12. PHASE-1 IMPLEMENTATION PLAN (план + 1 advisor-раунд, 2026-06-30)

> Розрізаємо поточний `DiffEditView` (один view зі state-machine list↔detail) на
> singleton-панель + multi-tab editor. **Поділ 1A/1B advisor-ратифікований.** Кожен
> стейдж лишає build зеленим; pure-логіка unit-тестується (call-site, не лише чиста fn —
> [[feedback-doc-code-discipline]]), UI-вайринг — manual checklist.

### 🔑 Ключові уточнення advisor (тримати перед очима всю Фазу 1)

- **Шов S2 = post-commit НАВІГАЦІЯ, і тільки вона.** `exitDetailView` робить
  drainHistory → assessHistory → getResolved → `commitOrDiscardExit` → outcome/TOCTOU,
  а ХВІСТ (`viewState=list; render()`) — це єдине, що змінюється. Двигун має кликати
  host-callback **`onExitComplete(outcome)`**: старий host → `render(list)`; новий host →
  `detach() + reveal panel`. Шов саме тут = поведінка ІДЕНТИЧНА; будь-де інде — змінюєш
  поведінку посеред екстракції.
- **Двигун ПЕРЕНОСИТЬСЯ, не шериться.** Після S6 detail-mode у панелі нема — двигун
  юзає лише editor. Під час S2–S5 транзитивно два caller-и; після S6 — один. **НЕ
  золотити generic-API** — мінімальний host-callback surface (`onExitComplete`,
  `committing`, `escScope`, `toggleSearch` → deps/callbacks) і стоп. `renderDetail`/
  `mountDiffPane` уже беруть `parent:HTMLElement` → вже leaf-agnostic для рендеру.
- **1A вже дає БІЛЬШЕ за «ephemeral».** `mountDiffPane` уже ганяє повний recovery-flow
  (`classifyReopen`→`dryRunRecoverableEdits`→`ResumeRecoveryModal`), тож **close-x →
  reopen → resume-modal працює в 1A задарма**; `disposeOwner` §4.1 abandon-wipe = «clean
  0-edit close → wiped → fresh». 1A = multi-tab + guard + `[←]` + close-x-edits-reprompt +
  clean-close-wiped. **1B додає ЛИШЕ виживання рестарту Obsidian** (getState/setState).
  При переносі `mountDiffPane` recovery-блок переносити ВЕРБАТИМ, не рефакторити.
- **openMode silent-vs-modal — суто 1B.** У 1A кожне відкриття user-initiated → «завжди
  modal на recovery» коректно, openMode НЕ вайримо.
- **Unload:** Obsidian переписує `workspace.json` на КОЖНУ зміну layout (не лише на quit),
  тож `detachLeavesOfType` в `onunload` прибирає leaf-и зі збереженого стану — тому ніщо
  й не відновлюється. 1A — детачимо обидва типи (коректно; ще й не дає stateless-editor
  відновитись порожнім на `pnpm dev` hot-reload). 1B — прибрати детач + getState + register.
- **View-type STRINGS:** **панель лишає СТАЛИЙ рядок `diff2-edit-view`** (клас →
  `DiffPanelView`), щоб уже збережені panel-leaf-и користувача відновились, а НЕ
  орфанились у «no view of type». Editor отримує НОВИЙ рядок `diff2-editor-view`.

### Phase 1A — multi-tab механіка (editors ephemeral)

- **S1 — pure helpers (unit-tested). ✅ DONE (2026-06-30).** `src/diff2/editor-tabs.ts`:
  `DiffEditorOrigin`; `writeSetFor(origin, base, sibling)` (нормалізує шляхи); `openGuard(
  open, req) → open | focus(which) | dialog(busyFile, which)` (same-pair key = autosaveId,
  write-set перетин = safety net). `entryFromSibling(store, siblingPath)` винесено в
  `synthetic-detector.ts` (тіло `findAllConflicts`, parity). `EditorTabState` ВИКИНУТО
  (кристалізується в S3). Тести: `tests/diff2/editor-tabs.test.ts` (writeSetFor×5 +
  openGuard×6: empty/same-id/partial-overlap/no-overlap/same-pair-precedence/first-offender)
  + entryFromSibling×3 у synthetic-detector.test. Повний сьют 1613 green, tsc clean.
  > 🔴 **Forward-флаг у S4 (advisor):** `openGuard` ДОВІРЯЄ, що `OpenEditorDesc.writeSet`
  > уже нормалізований. S4-адаптер МУСИТЬ будувати кожен writeSet через `writeSetFor` (не
  > сирі шляхи з getState/title) — інакше overlap-compare мовчки промахнеться (2 редактори
  > на 1 файл, усі S1-тести зелені). Якщо не гарантуєш єдиний chokepoint — нормалізувати
  > оборонно в `openGuard`.
- **S2 — екстракція detail-двигуна (build-green, parity). ✅ DONE (2026-06-30).**
  `src/diff2/diff-detail-controller.ts` — `DiffDetailController` володіє двигуном
  (owner-lifecycle + `mount` (= старий `mountDiffPane`, recovery-блок ВЕРБАТИМ) + toolbar +
  `exit` (= старий `exitDetailView`) + `resolveToctou` + exit-commit); `DiffEditView`
  тепер ЛИШЕ host (`implements DiffDetailHost`): list↔detail state-machine, sub-tab header,
  conflicts-list, escScope, Mod+F (через `controller.getView()`), ConflictCounter-subscribe.
  Контролер створюється per-view в `onOpen`; `render()`-top + `onClose` кличуть `dispose()`.
  **Swap-inventory (advisor-pinned, verified): РІВНО 4 host-виклики** (3×`onLeaveDetail`:
  restore-cancel / resume-cancel / no-session + 1×`onCommitExit`: success-tail) **+ 3
  guard-rewrites** (`!isStillTargeting(entry) || !body.isConnected` — after-read /
  after-restore-modal / after-resume-modal). `mount` створює toolbar+body divs сам (S3
  reuse — один виклик дає ідентичний DOM). `committing`/toctou-cancel/commit-fail лишаються
  bare-`return` (Gap-4, без навігації). main.ts НЕ чіпано; `diff-edit-view-v2-glue.test.ts`
  не торкається view-internals → зелений. tsc clean + повний сьют **1613 green**.
  > **Verify-стан:** автоматика зелена (build + 1613 unit). Manual parity-checklist 1–4
  > (open→resolve→`[←]`→list; правка→close-x→reopen→ResumeModal; 0-edit close→fresh;
  > commit-fail→лишається) — **DEFERRED на device/harness** (потребують живого ItemView-host;
  > happy-dom не монтує). Прогнати при наступній device-сесії ПЕРЕД S5.
  > **TITLE-СПРОЩЕННЯ лишилось S3/S6** (динамічний `getDisplayText`+`refreshHeader` НЕ чіпано
  > в S2, як і ратифіковано нижче).
  > **🔒 LOCKED S2-КОНТРАКТ (design+advisor 2026-06-30; імплементувати у СВІЖІЙ сесії —
  > ~500-рядковий behavior-preserving extract + manual-only verify + довгий контекст = відкласти).**
  > **`src/diff2/diff-detail-controller.ts` — `DiffDetailController`** володіє двигуном:
  > поля `owner / activeSession / toolbarHandle / autoFocus / prevConflictCount / committing`;
  > методи `mount(body, entry)` / `exit(entry)` / `resolveToctou` / `refreshToolbar` /
  > `autoFocusFirst` / `toggleSearch` / `dryRunRecoverableEdits` / `renderToolbar(body, entry)` /
  > `dispose()` / **`getView(): EditorView|null`** (gap-1: view-host Mod+F читає owner-view через
  > контролер — інакше hotkey тихо ламається, tsc не ловить).
  > **Host-інтерфейс (composition, НЕ base-class):**
  > ```ts
  > interface DiffDetailHost {
  >   isStillTargeting(entry): boolean; // stale-guard після await/модалок: old→viewState match; new→true
  >   onLeaveDetail(): void;            // cancel / no-session: old→render(list); new→leaf.detach()
  >   onCommitExit(entry): void;        // [←] committed: old→render(list); new→detach+reveal+scroll (S5)
  > }
  > ```
  > Контролер сам перевіряє `!body.isConnected`; host додає лише viewState-частину. **Gap-2:**
  > `dispose()` ІДЕМПОТЕНТНИЙ (old host кличе з `render()` І з `onClose()`) — §4.1 abandon-wipe не
  > двоїться. **Gap-3:** `entry` — ПАРАМЕТР кожного `mount`-виклику (не мутабельне поле): concurrent
  > re-mount (клік іншого рядка поки відкрита resume-модалка) інакше порівнює stale-guard з НЕ тим
  > entry → guard fails open. **Gap-4:** РІВНО два nav-callback-и (commit-fail + toctou-cancel
  > коректно ЛИШАЮТЬСЯ змонтованими, без навігації) — тримати `onLeaveDetail`/`onCommitExit`
  > роздільними з самого початку (S5 спеціалізує лише new-host).
  > **Lifetime:** контролер — per-VIEW (створюється в `onOpen`, не per-mount); `mount/dispose` цикл
  > усередині. **View-level лишається в `onOpen`/`onClose` кожного host:** `escScope`, Mod+F
  > window-keydown, ConflictCounter-subscribe (editor НІКОЛИ не підписується — list-only).
  > **🆕 TITLE-СПРОЩЕННЯ (користувач 2026-06-30):** динамічний `getDisplayText` flip +
  > `refreshHeader()`/`updateHeader()`-хак ВИКИНУТИ — кожен view має СТАТИЧНИЙ title (панель =
  > "Diff Panel"; editor = свій `base · device @ date`, фіксований на час життя). Це робиться в
  > S3 (editor getDisplayText) + S6 (panel getDisplayText, прибрати refreshHeader).
- **S3 — `DiffEditorView` (multi-tab). ✅ DONE (2026-06-30).** Новий `src/diff2/diff-editor-view.ts`
  `DiffEditorView extends ItemView implements DiffDetailHost` (view-type `diff2-editor-view`),
  тримає власний `DiffDetailController` — **контролер НЕ змінено** (advisor-guardrail = доказ
  правильного S2-шва; S2 seam-тест лишився зеленим). Host-callbacks: `onLeaveDetail`/`onCommitExit`
  → `this.leaf.detach()` (S5 спеціалізує commit-exit на detach+reveal+scroll); `isStillTargeting`
  → match по одному entry. `EditorTabState {origin,basePath,siblingPath}` (editor-tabs.ts) —
  siblingPath = identity, повний entry RE-DERIVED через `entryFromSibling` (R-C minimal, drift-free).
  `setState`+`onOpen` → `tryMount` (both-ready guard; **untrusted-state guard** `typeof siblingPath
  === "string"` — `parseSiblingFilename` THROWS на не-string при leaf-move-rebuild `setState({})`,
  advisor-caught); `getState()` РЕАЛІЗОВАНО (in-session leaf-move зберігає пару — окрема дрібніша
  потреба, НЕ 1B-restart-restore). **СТАТИЧНИЙ** `getDisplayText` (title-спрощення стартує тут, без
  refreshHeader-хака). escScope + Mod+F дубльовані per-host (ратифіковано — НЕ shared chrome
  helper), БЕЗ ConflictCounter (editor не list). main.ts: deps зведено в `diffViewDeps()` (спільне
  для обох hosts), register `diff2-editor-view`, unload детачить ОБИДВА типи (1A ephemeral), TEMP
  smoke-команда «Open first conflict in editor (S3 smoke)» → `openEditorForPair(entry)` (БЕЗ guard
  — guard у S4; команда видаляється/замінюється row-click у S4). tsc clean + повний unit **1617
  green** (новий surface = Obsidian ItemView-glue, не unit-testable без ItemView-harness, якого в
  проєкті нема — як і `DiffEditView`; покриття = host-agnostic controller seam-тест).
  > **DEVICE-SMOKE (deferred, у S5-checklist; вхід тепер = panel row-click, НЕ команда):**
  > (1) row-click → resolve → `[←]` закриває таб; (2) **multi-tab:** 2 editor-tabs, фокус →
  > ESC-swallow + Mod+F діють лише на сфокусований; (3) leaf-move (drag у split) зберігає пару
  > (getState); (4) tab-title може показати "Diff editor" замість файлу = косметичний S6-фікс.
- **S4 — wire + open-guard. ✅ DONE (2026-06-30).** main.ts `openEditorForPair(entry)` за
  open-guard: `alignOpenDescs(leaves.map(openDesc))` (index-aligned, **НІКОЛИ `.filter`** — інакше
  `which`→wrong-tab) → `req = openDescFor("conflict",base,sibling,autosaveIdForEntry)` → `openGuard`:
  focus→`revealLeaf` | dialog→`EditorBusyModal` [Switch]/[Cancel]→reveal-or-noop | open→новий leaf
  `setViewState(EditorTabState)`. **🔴 carry-flag closed:** ОБИДВА site-и (req + кожен open `openDesc`)
  будують write-set через `openDescFor`→`writeSetFor` (нормалізовано) — новий pure chokepoint у
  editor-tabs.ts. `DiffEditorView.openDesc()` (зі state, доступний до async-mount). `conflicts-list`
  row-click → `deps.openEditor(entry)` (**єдиний роутинг**, panel detail-mode обходиться, fallback
  ВИКИНУТО — viewState ніколи не "detail"; renderDetail/mountDiffPane лишаються мертві до S6).
  `EditorBusyModal` (recovery-dialog.ts, prompt→"switch"|"cancel"). TEMP smoke-команда ВИДАЛЕНА.
  Tests: `editor-tabs.test.ts` +4 (openDescFor normalize/per-origin; alignOpenDescs length+index-no-drop;
  + guard-which-on-aligned-array). tsc + повний unit **1621 green**. Controller байт-у-байт незмінний
  (guardrail held). Adapter-dispatch (map→guard→reveal/modal/leaf) = workspace-glue → device-smoke.
  > **2 FIXUP-и (S4-correctness, той самий комміт-блок):** (a) 🔴 **TOCTOU re-entrancy** (advisor
  > done-check) — `getLeavesOfType` НЕ бачить in-flight leaf поки `setViewState` не зарезолвиться, тож
  > швидкий double-click на рядку проходив guard двічі → 2 editors на 1 autosave-dir (§3 write-race);
  > closed синхронним `openingPairs:Set<autosaveId>` навколо всього async-тіла. (b) **focus-on-reveal**
  > (user device-bug 2026-06-30) — `revealLeaf` на вже-відкритий таб активує таб, але НЕ ставить
  > caret у текст (треба було клікати мишкою); `DiffEditorView.focusEditor()` (rAF-deferred
  > `getView().focus()`) + `revealAndFocusEditor` у focus+switch гілках.
- **S5 — `[←]` close+navigate. ✅ DONE (2026-06-30).** Pure `planBackNav(origin,anchorPath,
  baseHasConflicts)` (editor-tabs.ts, +3 tests): conflict→`{panel,conflicts,scrollToBase:
  hasConflicts?anchor:null}`, deleted→`{panel,deleted,null}` (history/compare = TODO-гілка, fallback
  WRONG для них, safe бо Phase-1 не конструює). Editor `onCommitExit(entry)`: capture origin зі state
  → `leaf.detach()` → `deps.onEditorCommitted(origin, entry.basePath)`. activeSession контролер УЖЕ
  нулить перед host-callback (S2) → detach→dispose пропускає abandon-wipe (verified, не дублюю null).
  Panel `applyBackNav(nav)` → set list+tab + render + `scrollToBase` (**rAF-deferred** — panel щойно
  revealed/re-rendered, sync scrollIntoView no-op/mis-target; `row?.`=last-sibling-gone no-op).
  main.ts: `activateDiffEditView` повертає leaf; `onEditorCommitted` рахує baseHasConflicts через
  `findAllConflicts.byBasePath` → planBackNav → reveal panel → applyBackNav. Controller байт-незмінний.
  tsc + **1624 green**.
  > **🔴 DUP-GUARDS (device-bug, той самий блок) — split/clone дублювання НЕДОПУСТИМЕ:**
  > (1) **editor:** `getState` override ВИКИНУТО (вертає Obsidian-default `{}`) → Obsidian "Split"/
  > "Open in new window" серіалізує порожній стан у клон → `tryMount` unusable-state гілка тепер
  > **DETACH+Notice** (а не silent return) → клон закривається, оригінал працює. Наслідок: leaf-MOVE
  > теж втрачає пару (reopen з панелі) — прийнятно (no-dup = hard вимога, move-preservation = nicety).
  > (2) **panel:** singleton guard у `onOpen` (scan `getLeavesOfType` → інший leaf → reveal original +
  > detach self), `onClose` `controller?.dispose()` null-safe. User-ствердив: panel ОБОВ'ЯЗКОВО
  > singleton (інакше `[←]` не знає куди вертатись) — docs коректні, поведінка була ні.
  > **OPEN (user-ask):** «split → закривати ПОПЕРЕДНІЙ (=move editor у новий stack)?» — бажано, але
  > безпечний move потребує session-handoff (2 owners на 1 autosave-dir = write-race); зараз = safe
  > refuse. **РІШЕННЯ (user 2026-06-30): handoff-move робимо через (a) replay-з-диску** (shutdown
  > старого: drainHistory+dispose; startup нового: silent resume-mount, БЕЗ модалки) — надійно, хай і
  > повільно; рідко використовується; при переносі показувати модалку **"moving…"**. memory→memory
  > (перенос живого `EditorState` doc+Ranges+undo через reconfigure) = майбутня оптимізація (заодно
  > закриє recovery-replay perf із TODO), АЛЕ ризик тихого псування undo → не зараз. relocate-API (B1)
  > ВІДКИНУТО: Obsidian 1.7.2 не має `moveLeaf`/`setParent` (тільки `moveLeafToPopout`). **Handoff =
  > ОКРЕМА сесія ПІСЛЯ S6** (/advisor + device-тести; failure-mode = втрата даних).
- **S6 — slim panel + cleanup. ✅ DONE (2026-06-30).** Клас `DiffEditView`→**`DiffPanelView`** (рядок
  `diff2-edit-view` СТАЛИЙ; main.ts import/registerView/instanceof оновлено). Панель тепер ЧИСТО
  list-view: видалено мертвий detail-код — `DiffDetailController` поле + усі 3 `DiffDetailHost`-
  callback-и (isStillTargeting/onLeaveDetail/onCommitExit) + Mod+F-hook + escScope/syncEscScope +
  dynamic `getDisplayText`-flip + `refreshHeader`-hack + detail-гілка `render()` + detail-варіант
  viewState (тепер `PanelViewState{tab}`). Лишилось: singleton-guard, ConflictCounter-subscribe,
  renderHeader/renderListBody (row-click→`openEditor`), `applyBackNav`+`scrollToBase` (S5). Static
  `getDisplayText`="Diff Panel" (title-спрощення завершено). Контролер живе далі (юзає лише editor) —
  байт-незмінний через УСІ 5 стейджів. Stale comment-refs `DiffEditView`→`DiffPanelView` (current-
  tense) виправлено; historical лишені. tsc + **1624 green**, mobile-safe. Acceptance manual-checklist
  = device (deferred). **🎉 PHASE-1A split COMPLETE (S1–S6).** Лишилось: 1B (persistence), handoff-move
  (окремо), History/Compare/Deleted фази.

**Manual parity-checklist (писати в S2, ганяти на S2 ДО/ПІСЛЯ + як S6-acceptance):**
1. open → resolve групи → `[←]` → повертає в список (S2: у той самий таб; S5+: detach+панель).
2. open → правка → close-x → reopen тієї ж пари → `ResumeRecoveryModal` («N edits saved»).
3. open → нічого не змінив → close-x → reopen → fresh (0-edit wipe).
4. commit-fail (підкинути помилку) → лишається в editor, робота не втрачена.
5. (S4+) та сама пара вже відкрита → focus; частковий перетин → діалог; різні пари → N табів.

### Phase 1B — persistence (окремо, після зеленої 1A)

getState/setState (`{origin, anchorPath, base, sibling, kind}`); silent-vs-modal через
openMode (restored=тихо / user-open=modal); **прибрати детач editors на unload + 1 швидкий
тест timing workspace-серіалізації**; register `diff2-editor-view` для restore; recovery
(`recoverAutosaveDirs` до `layoutReady`) завершується ДО відновлення табів (assert тестом);
restore обходить open-guard; R3.7 last-editor-leaf-close→`resetLifts`. Manual: відкрити N,
рестарт → тихий replay; close-x+reopen → modal.

### Forward-design ЗАРАЗ (коштує нуль, не вимагає History/Deleted)
`origin`-enum включає `history|deleted`; `openGuard`/write-set узагальнені; `onExitComplete`
вже приймає origin-routed навігацію (Фаза 1 реалізує лише гілку `conflict`).
