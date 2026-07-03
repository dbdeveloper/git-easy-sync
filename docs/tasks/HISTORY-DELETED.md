# HISTORY-DELETED — канонічна специфікація режимів History та Deleted

> **Статус документа.** Це **єдина канонічна специфікація** для двох ще-не-збудованих
> diff2-режимів: **History** (перегляд/відновлення історичних версій файлу) і
> **Deleted** (перегляд/відновлення нещодавно видалених файлів). Документ **зводить
> докупи** розкидані першоджерела:
> - `docs/tasks/done/SPLIT-PANEL-EDITOR-FEASIBILITY.md` §10 (History) + §11 (Deleted) —
>   ратифікована візія (user + 2 advisor-раунди, 2026-06-29/30);
> - `docs/DIFF2_IMPLEMENTATION_PLAN.md` R2.3 (History), R2.4 (Deleted), R2.5
>   (delete-vs-modify), R2.7.2 (entry-points), **R3** (TrashStore data-шар),
>   R3.13 (Phase 9b items), R6 (external tool).
>
> **Superseded-контракт.** Розділи-першоджерела вважаються **заміщеними** цим
> документом у частині, що стосується History/Deleted: за розбіжностей істина —
> **тут**. Першоджерела лишаються як (a) data-шар-специфікації (R3 — жива, реалізована),
> (b) історичний контекст. У §10/§11/R2.3/R2.4 варто додати one-line pointer «superseded
> by → HISTORY-DELETED.md» (окремий дрібний правочин, див. кінець документа).
>
> **Дата зведення:** 2026-07-02. **Гілка:** `diff2`.
> **Мова:** українська (робоча специфікація; код/коментарі/commit-и — англійською).

---

## 0. TL;DR — що це і чому було важко знайти

Два режими дозволяють користувачу відкрити diff2-редактор не лише для **конфлікту**, а й
для:

- **History** — «поточний файл vs його стара версія» (з GitHub або з локальної
  push-queue), і за бажання **витягнути шматки** старої версії у поточний файл, аж до
  написання чогось **зовсім нового** поверх.
- **Deleted** — «порожньо (файл зараз відсутній) vs вміст видаленого файлу» (з локального
  `.trash` або з GitHub-history), і за бажання **відновити** файл.

Матеріал було важко знайти, бо головний файл-візія переїхав у `docs/tasks/**done**/`
(2026-07-02), а решта — розсіяна між планом і пам'яттю. Цей документ це виправляє.

**Головна ідея, яку треба тримати перед очима: History і Deleted — ДЗЕРКАЛА одне одного**
(див. §2). Не дві паралельні фічі, а один механізм із дзеркальним призначенням
read-only-сторони. Тому спільну машинерію описуємо **раз**, а далі — лише де вони
розходяться.

---

## 1. Data-source модель (3 джерела × 2 режими)

Це — пряма відповідь на питання користувача «звідки беруться версії». Є **три** фізичних
джерела байтів; кожен режим тягне з двох.

| Джерело | Фізичне розташування | Хто пише | History | Deleted |
|---|---|---|---|---|
| **Push-queue** (локальні pending-коміти) | `.obsidian/plugins/<id>/.push-queue/<batchId>/vault/<path>` | sync2-рушій (батч ще не запушений) | ✅ версії, **новіші** за GitHub (ще не залиті) | — |
| **Local trash** | `.obsidian/plugins/<id>/.trash/<id>/vault/<originalPath>` | TrashStore (перехоплення delete) — **лише поточна sync-сесія** | — | ✅ свіжо-видалені (до наступного sync) |
| **GitHub repo** | remote commit-history | sync2 push | ✅ commit-list через `listCommitsForPath` + contents-at-ref | ✅ `status:"removed"` у commit-diff |

Ключові властивості кожного джерела:

### 1.1 Push-queue (History-only, локальне, «свіже»)
- `.push-queue/<batchId>/vault/<path>` = байтовий снапшот файлу в межах **незапушеного**
  батча (та сама структура `vault/<повний-path>`, що й trash).
- **Показ (нова модель, §4.3):** push-queue-версії (що відповідають фільтру) показуються
  **миттєво** й локально, а GitHub довантажується **фоново завжди** (worker + progress-bar).
  Кнопки `[Show GitHub history…]` **НЕМА** — стара «push-queue-first: не чіпати GitHub»-політика
  (R2.3 п.1 / feasibility §10 п.3) **скасована** (user 2026-07-03, деталі §4.3).

### 1.2 Local trash (Deleted-only, локальне, session-scoped)
- `.trash/<id>/vault/<originalPath>` = **переміщений** (move, не copy — R3.2) видалений
  файл. `<id>` — 17-цифровий timestamp (як `.conflicts/`, `.push-queue/`).
- **Session-scoped (R2.4):** запис живе **тільки до наступного Sync**. Після того як sync
  підтвердив видалення на GitHub, запис вичищається (TTL, R3.5). Далі відновити можна лише
  з GitHub. Файл, створений і видалений **в одному** sync-циклі, втрачається незворотно.
  Файл, який знаходиться в `.gitignore` потрапляє в `.trash/` при видаленні, і буде остаточно
  вичищатись після наступного Sync (TTL, R3.5), як і інші файли, після чого втрачається 
  незворотно, бо не має збережених версій в GitHub repo.
- **Data-шар вже реалізований** (R3.8 — детально §5.2 + §7).

### 1.3 GitHub repo (обидва режими, віддалене, «глибоке»)
- Потрібна нова обгортка `GithubClient.listCommitsForPath(path, branch, {since?, perPage?,
  page?})` навколо `GET /repos/{owner}/{repo}/commits?path={path}&sha={branch}` (R2.3).
- Для Deleted: `listCommitsForPath` + `compare()` для виявлення `status:"removed"` (R3.6
  п.2).
- Кешується на диск у `.diff2` (щоб не бити GitHub повторно). Time-filter → `{since}`.

---

## 2. 🔑 Дзеркало History ↔ Deleted (crown-jewel таблиця)

Джерело: feasibility §10 (`:447-458`). Поточний (vault) файл грає **різні ролі** в кожному
режимі. `base` = ver1 = «−» (видалене/старіше), `sibling` = ver2 = «+»
(додане/новіше).

| Режим | `base` (ver1, «−») | `sibling` (ver2, «+») | пишемо у vault                                                               | read-only сторона | `[←]`-якір веде в |
|---|---|---|------------------------------------------------------------------------------|---|---|
| `conflict` | поточний vault-файл (`note.md`) | remote `.conflict-from-*` (theirs) | base **і** sibling (pair-atomic)                                             | — (обидві editable) | **base** → `panel:Conflicts` |
| `history` | **історична версія** (нема у vault, read-only) | **поточний файл** (current) | тільки **sibling**                                                           | **base** (історія) | **sibling** → `diff2-history` |
| `deleted` | **порожньо** = поточний відсутній стан (`originalPath`) | **вміст із `.trash`** (read-only) | тільки **base**                                                              | **sibling** (trash) | **base** → `panel:Deleted` |
| `compare` | файл A | файл B | файл A **i** файл B (pair-atomic) |  — (обидві editable)  | base-файл (звич. таб) |

**Дзеркальність History ↔ Deleted (найважливіше):**
- **History:** read-only = **base** (стара версія); пишемо **sibling** (поточний файл).
  Ніколи не видаляє поточний файл.
- **Deleted:** read-only = **sibling** (trash); пишемо **base** (`originalPath`).
  resolve→порожньо = лишити відсутнім = **skip-write** (НІКОЛИ не видаляємо vault-файл — §3.2).

`[←]`-якір = **той самий «поточний vault-файл»**, лише зветься по-різному: `conflict`/
`deleted` → `base`, `history` → `sibling`.

**Наслідок для commit-логіки** (детально §3.2, ✅ SETTLED):
- History → пишемо sibling, `guardEmpty`→`"\n"` доречний (History НІКОЛИ не видаляє
  файл).
- Deleted → пишемо base, **write-OR-SKIP** (порожньо ⇒ skip, лишити відсутнім; НІКОЛИ не
  видаляємо vault-файл). НЕ delete-capable.

---

## 3. Спільна машинерія (reuse) — і де режими розходяться

**Рішення (feasibility §10 п.5, 2026-06-29): History/Deleted = ПОВНА машинерія, ЄДИНИЙ
diff-editor для всіх випадків.** Жодного «спрощеного» re-fetch+re-resolve шляху. Причина:
користувач може захотіти довго працювати зі старою/видаленою версією — вибрати окремі
шматки І дописати/закомітити щось **зовсім нове**. Тобто потрібні повний edit + autosave +
`history.jsonl` + replay + recovery — так само, як у конфліктах.

### 3.1 Recovery — one-sided (спільне ядро, мала параметризація)
- **REPLAY уже готовий:** replay завжди зі `*.snapshot` (`readResumeSession`) → works
  as-is для обох режимів.
- **DETECTION — мала параметризація:** `classifyReopen` наразі читає **live vault** для
  порівняння. Для History/Deleted read-only сторона **immutable** → брати її теж зі
  `*.snapshot`, а перевіряти лише **writable** сторону:
  - History: read-only = base (версія); перевіряємо лише чи змінився `currentFile`
    (sibling).
  - Deleted: read-only = sibling (trash); перевіряємо лише base (`originalPath`).
- Це **прапорець «яка сторона read-only»**, НЕ нова підсистема (R-F-нота feasibility).

### 3.2 Commit — ✅ SETTLED: single-write, write-OR-SKIP (НЕ delete-capable)

> **Вердикт (2026-07-02 — прочитано тіло `src/diff2/exit-commit.ts` + advisor-раунд).**
> Пересторога feasibility §11 («`done.json` хешує обидві сторони + step-6.5 unify → base-only
> НЕтривіально») **ЗНЯТА — не справджується.** **✅ Модель write-or-skip РАТИФІКОВАНА
> користувачем (2026-07-02)** — Deleted ніколи не видаляє vault-файл.

**Чому пересторога не спрацьовує.** `commit7Step` (`exit-commit.ts:209`) з усім
done.json-барьєром + step-6.5 unify (`:283`) + `recoverCommit`/A–K-матрицею існує ВИКЛЮЧНО
для **pair-atomicity** (коментар `:6-13`: щоб onload sync-pulse не запушив піврозв'язану
пару). §5.0.e single-write шляхи НАВМИСНО не торкаються цієї машинерії:
- `commitUnchangedSide` (`:440`) = один `atomicWriteFile` + `rmdir`; коментар `:437-439`:
  «No done.json barrier: a single atomicWriteFile is already crash-safe».
- `commitToAlt` (`:491`) — так само; коментар `:427-432`: «there is no pair to keep atomic».

History і Deleted пишуть ОДНУ сторону → **немає пари → не потрібен done.json → нема чого
degrade-ити.** `commit7Step`/`recoverCommit`/step-6.5/матриця — **0 змін.**

**History (пише sibling=currentFile, НІКОЛИ не видаляє):** reuse `commitUnchangedSide` як є
(base=історія читається з `base.snapshot`, ніколи не пишеться). empty→`"\n"` stub доречний
(History не видаляє файл). ✅ безкоштовно — feasibility §10(a) підтверджено кодом.

**Deleted (пише base=`originalPath`) = write-OR-SKIP, НІКОЛИ не `remove`:**
- base відсутній на старті **ЗАВЖДИ** (`baseExistedAtStart:false`, див. §5.1).
- resolve→вміст ⇒ **WRITE** `originalPath` (Variant A) або `<stem>.restored-<iso-ts>`
  (Variant B collision, fail-closed як `commitToAlt`).
- resolve→порожньо ⇒ **SKIP** (нічого не писати) + `rmdir`. НЕ створювати `"\n"`-файл на
  path-і, що має лишитись відсутнім; НЕ торкатись чужого live-файлу.

**🔴 Load-bearing MUST — Deleted придушує empty-write (skip), а НЕ `removeIfExists`.** Наївний
`baseCommitAction` (`:87`) + `removeIfExists` дав би `delete:true` для empty base
(`:96` `!baseExistedAtStart→delete`) → у Variant B (`originalPath` пере-зайнятий новим
live-файлом) це **ЗІТЕРЛО Б ЧУЖИЙ ФАЙЛ = data-loss**. Skip-write робить clobber неможливим
*by construction* — інакція безпечніша за guard.

**⚠️ Deleted ≠ delete-vs-modify conflict (§6/R2.5) — НЕ плутати commit-шляхи.** Delete-семантика
`baseCommitAction`/`removeIfExists`/`done.deleteBase` належить delete-vs-modify **конфлікту**
(де resolve-to-empty ПІДТВЕРДЖУЄ реальне видалення; на absent-base `removeIfExists` = no-op,
`:269-270`; реальний remove лише в case-4 had-content+confirmedDelete). Deleted-mode
(«trash restore») цим шляхом НЕ проходить.

**Naming:** запропонована `resolveOrDeleteUnchangedSide` — **misnomer** (немає delete; це
resolve-or-**SKIP**). Чесніше `finalizeUnchangedSide(…, emptyPolicy:"stub"|"skip")`. Узгодити
з §9 п.2 naming-debt.

**Форма ядра:**
```ts
finalizeUnchangedSide(vault, autosaveId, meta, resolved,
    writableSide: "base"|"sibling", emptyPolicy: "stub"|"skip")
// stub → guardEmpty→"\n" (History; = поточний commitUnchangedSide)
// skip → empty ⇒ НЕ писати нічого (Deleted)
```
`commitUnchangedSide(changedSide)` → тонка обгортка з `emptyPolicy:"stub"`; усі §5.0.e
call-site-и/тести лишаються зеленими.

### 3.3 Одне правило: два редактори не можуть писати в один vault-файл

**Просте правило:** не можна тримати відкритими **два diff-editor-и, що пишуть у той самий
vault-файл** — інакше вони затруть правки одне одного (write-race).

**Як це працює (механізм уже збудований для конфліктів, `editor-tabs.ts`).** Кожен редактор
оголошує список файлів, у які **може записати** при commit-і («write-set»). При відкритті нового
таба перевіряємо перетин: якщо новий редактор писав би у файл, уже «зайнятий» відкритим
редактором → **не відкриваємо другий** (фокусуємо наявний або показуємо діалог «вже редагується,
перейти?»).

У цей список потрапляють **лише vault-файли**, у які редактор пише. Read-only-сторона
(історична версія, вміст із trash) — **це взагалі не vault-файл**: вона одразу лягає у
`*.snapshot` і у vault ніколи не потрапляє. Тож у правилі її немає **не як винятку, а за
визначенням** — їй там нема місця.

Що пишемо в кожному режимі (з §2):
- **conflict** — обидва боки (`{base, sibling}`, pair-atomic).
- **history** — тільки поточний файл (`{currentFile}`); історія (base) read-only.
- **deleted** — тільки `{originalPath}`; trash (sibling) read-only.

**Наслідок (нічого спеціального, просто випливає з правила):** якщо `note.md` водночас має
конфлікт (пише `note.md`) і ти хочеш відкрити для нього History (теж пише `note.md`) — обидва
писали б у `note.md`, тож open-guard **не дасть** тримати обидва таби разом (діалог/Notice). Так
само 2 siblings одного base → один writable-`note.md` → лише один таб.

### 3.4 `deriveAutosaveId` — розширення `kind`-union
- Розширити тип `kind` на `"history" | "deleted"` (зараз `"synthetic" | "compare"`).
- Тіло (sort + `\0` + FNV-1a) **не валідує path** → bare-sha / trashId як 2-й арг
  проходить без проблем (verified autosave-store.ts).
- History autosave-id: `deriveAutosaveId("history", currentPath, versionSha)` — версійна
  sha в id (щоб різні версії того ж файлу = різні сесії).
- Deleted autosave-id: `deriveAutosaveId("deleted", originalPath, trashId)`.

---

## 4. History mode (Phase 7)

### 4.1 Вхід (entry-points, R2.7.2 — уточнено 2026-07-03)
- **Контекст-меню файлу** в Obsidian file-explorer → **`Show history`** / «GitHub History»
  → відкриває `diff2-history` **одразу** для цього файлу.
- **Command palette:** `Show history of active file`.
- **Status-bar меню:** пункт **`Show history of current file`** (поряд із `Commit current
  file`, R2.7.3) — той самий command-palette-запис, винесений у меню; відкриває `diff2-history`
  для активного файлу.

**Уточнення до R2.7.2 «History file-bound → жодних глобальних поверхонь».** Правильна межа:
нема глобального **списку/badge** для History (на відміну від Conflicts/Deleted, у History
**нема що рахувати** — жодного числа на ribbon-іконці чи в тексті status-bar). **АЛЕ**
current-file-bound **пункт меню** легітимний — він resolve-иться з активного файлу
(`activeFilePath()` через `getActiveViewOfType(MarkdownView)`, `main.ts:2020`), як `Commit
current file`. Нема empty-state «виберіть файл».

**Гейт `hasActiveFile` (пункт меню сіріє, не ховається)** — ✅ реалізовано (`85c782e`):
- додано в `StatusMenuInput` прапорець `hasActiveFile` (= `activeFilePath() !== null`,
  обчислюється в main.ts перед `buildStatusMenu`; меню будується заново на кожен клік → стан
  свіжий);
- у `buildStatusMenu` гейтимо **обидва** file-bound пункти (`commit-current` **і** майбутній
  `show-history`) цим прапорцем → **сірий/disabled** (як наявний greyed-heading `key:null`), НЕ
  ховати, без імені файлу в лейблі.

### 4.2 View-types і навігація (2-рівнева модель)

**2 рівні / back-stack:**

1. **`diff2-history`** *(НОВИЙ view-type, per-file: 1 таб на файл)* — для ОДНОГО обраного файлу:
   список його **закомічених** версій + toolbar: `[←]` + **фільтр** (деталі §4.4) — дві осі:
   **період** (`1 день | тиждень | місяць | рік | все`) і **текстова фраза** (форма як
   CM6-search, без replace-рядка: `[search…] [Aa] [.*] [word]` = case / regexp / whole-word).
2. Клік по версії → активація **`diff2-editor`** таб: **base = історична версія**, **sibling
   = поточний файл**.

`[←]` крокує назад по ланцюжку: `diff2-editor` → `diff2-history` (список версій того ж
файлу, з фокусом) → `[←]` в `diff2-history` - перехід в tab файлу (відкриває, якщо не відкритий).
Close `diff2-history` tab (`[x]`) - просто закриває цей таб.

**Чому окремий view-type `diff2-history`, а не detail-mode у панелі** (рішення
2026-06-29): треба **прямий** вхід із context-menu на файлі; detail-mode вимагав би спершу
пройти дерево. `diff2-history` — **per-file** (1 таб на файл, ратифікований uniqueness-invariant
«history = 1/file»): різні файли = різні таби, повторне відкриття того самого файлу **фокусує**
наявний таб. **НЕ vault-singleton** (це виправляє раннє формулювання «singleton, перевикористовується
на кожен файл» у feasibility §10).

Панель (`diff2-panel`) лишається з **тільки** Conflicts/Deleted sub-tabs (History там
НЕМАЄ!).

### 4.3 Data-flow (instant push-queue + фонове GitHub-завантаження)

> **🔴 Змінює R2.3 п.1 / feasibility §10 п.3** (стара «push-queue-first: якщо є push-queue —
> GitHub не чіпати автоматично»). Нова модель (user 2026-07-03): push-queue показуємо **миттєво**,
> а GitHub довантажуємо **ФОНОВО завжди** (у worker-і) — instant + повний список ціною
> GitHub-викликів на кожне відкриття History.

1. **Миттєво** рендеримо `.push-queue`-версії (локально, `readFile`), що відповідають фільтру
   (§4.4). Мережі не чекаємо.
2. **Одразу фоново** стартуємо GitHub-завантаження наступної сторінки — якщо кеш `.diff2`
   порожній **АБО** діє текстовий фільтр — із **skeleton-плейсхолдерами** (індикатор прогресу,
   нижче). Завантаження + пошук — у **worker** (§4.4).
3. **Клік по вже-наявному запису** → одразу `diff2-editor` для тієї версії; фонове завантаження
   **триває далі**.
4. **Infinite-scroll:** скрол вниз за межі списку → підвантажує наступну порцію (page ≥ кількість
   записів на екрані, але не менше ~20 — число уточнимо).
5. **Refresh-on-top:** скрол вгору, коли вже показано початок → перечитати список з GitHub заново
   (= команда «refresh list from GitHub»).
6. **Скасування:** зміна фільтра **АБО** закриття `diff2-history`-таба → скасувати незавершене
   фонове завантаження (новий фільтр = новий пошук з нуля).

Кожен елемент списку клікабельний → `diff2-editor` (selected-version = base read-only vs
current-file = sibling).

**Loading-UX — skeleton placeholder-рядки (замість класичного progress-bar).** Плейсхолдери
супроводжують **КОЖНЕ** завантаження й до-вантаження записів. Це **фантомні рядки-плейсхолдери**
(сірі смужки у формі рядка-запису), що **«дихають»** — циклічно трохи темніють/світлішають
(чиста CSS-анімація, без JS). Це і є індикатор прогресу.
- **Перше завантаження:** одразу реальні push-queue-рядки (напр. 2), а нижче — плейсхолдери **до
  кінця видимого вікна**; вони НЕ скролляться (це «малюнок», а не справжні записи).
- **Прихід даних:** кожен завантажений/знайдений запис **замінює** плейсхолдер на реальний рядок
  (по одному або пачкою).
- **До-вантаження (пагінація, §4.3 п.4):** при скролі вниз наступну порцію так само супроводжують
  кілька плейсхолдер-рядків **унизу**, доки прийде page.
- **Зміна або видалення фільтра:** усе починається **з початку** — список скидається, знову
  показуються плейсхолдери, завантаження/пошук стартують з нуля.
- **Кінець завантаження:** якщо реальних записів менше за екран → плейсхолдери **зникають**,
  лишаються лише реальні рядки. Якщо список у результаті **абсолютно порожній** → замість списку
  показуємо напис (англ.) залежно від **причини**:
  - задано текстову фразу, 0 збігів → **`No matches found`**;
  - фрази нема, період нічого не охопив → **`No history in the selected period`**;
  - фрази нема, період = `all`, усе одно порожньо (файл без серверної історії) →
    **`No history for this file`**.

### 4.4 GitHub API + worker + фільтр (нове — Phase 7)

**GitHub API.**
- **`GithubClient.listCommitsForPath(path, branch, {since?, perPage?, page?})`** — обгортка
  навколо `GET /repos/{owner}/{repo}/commits?path=&sha=` (R2.3). **Ще не існує.** `since` ←
  період-фільтр; `page`/`perPage` ← infinite-scroll (§4.3 п.4).
- Байти конкретної версії — через `getContentsAtRef` (вже є; Blobs-API fallback >1MB, SYNC2
  §7.6) за commit-SHA.
- ⚠️ **Серверного пошуку по історичних версіях GitHub НЕ має** (перевірено 2026-07-03):
  Code Search (`/search/code`) індексує **лише default-branch HEAD** (+ файли <384 КБ, потрібна
  індексація); commit-search — лише **повідомлення**, не вміст; довільний commit-SHA не шукається.
  Локальний `git log -S` нам недоступний (немає git-бінарника, лише REST). **⇒ пошук фрази МУСИТЬ
  завантажити вміст кожної версії й шукати локально — оминути це API-ом неможливо.** Дрібна
  економія: **поточну (HEAD) версію з мережі не тягнемо** — це і є локальний vault-файл (sibling).

**Worker (наявна оркестра `src/worker/`).** `listCommitsForPath`/`getContentsAtRef` →
**network-worker** (як весь engine, через `WorkerClient.httpRequest`); пошук фрази → **cpu-worker**.
**Послідовно, один потік — БЕЗ конкурентності** (user 2026-07-03: рідкісний важкий кейс, не
паралелимо) → порядок зберігається сам, пік RAM ≈ **одна версія**. ⚠️ **Межа:** worker не має
доступу до Obsidian API → лише fetch-ить+шукає й **повертає дані**; кеш `.diff2` (adapter) і рендер
— на main.

**Два режими завантажувача (за наявністю текстового фільтра).**
- **без фільтра** — лише **метадані комітів** (`listCommitsForPath`, легко, посторінково) → список
  = усі версії в межах періоду.
- **з фільтром** — **вміст кожної версії** (`getContentsAtRef`, важко): **стрімінг** — worker
  послідовно fetch→search→**одразу рендерить кожен збіг** замість placeholder-а (§4.3), пошук
  триває далі, знайдений рядок **клікабельний під час пошуку** (клік → `diff2-editor`, фон триває).

**Кеш вмісту версій — Settings-перемикач (disk ↔ frugal), platform-aware дефолт.**
Нове налаштування у групі **«Diff Editor»**: *History version cache* = `Disk` / `None (re-fetch)`.
Дефолт **platform-aware** (`Platform.isMobile`): **mobile → None (Frugal)**, **desktop → Disk**.
**Формула (для settings-tooltip):** *Disk — більше диску, менше трафіку; None — менше диску, більше
трафіку (повторні завантаження).* Перший пошук коштує **однаково** в обох (обидва мусять завантажити
всі версії — серверного пошуку нема); різниця — на **повторах**: кліки по версії + кожен новий пошук.
Обидва режими ділять **той самий** послідовний streaming/skeleton-пайплайн; різниця — **лише доля
байтів після пошуку**:
- **Disk:** завантажений вміст → на диск у `.history-cache/` (**сесійний** кеш, layout нижче).
  Далі пошук — **локальний** (без мережі). Кеш **росте монотонно в межах сесії**: **звуження**
  періоду (місяць→тиждень) записів **НЕ видаляє**; **розширення** (тиждень→місяць) при пошуку
  **до-вантажує лише брак** (версії, яких ще нема в кеші). Клік по знайденому → читаємо **з диска**
  (без fetch). **Cleanup:** вихід із History-таба для файлу F → видаляємо **лише**
  `.history-cache/<F>/`; onload плагіна (рестарт/крах) → `.history-cache/` **повністю** (backstop;
  сесійний, ніколи не переживає рестарт — як trash-recovery / atomic-write onload-sweep-и).
- **Frugal / None:** fetch→search→**одразу забуваємо байти** (на диск не пишемо); у списку — лише
  рядок (метадані). Клік → **ре-fetch** тієї версії. **Нуль диска**, більше мережі. НЕ in-memory
  (на mobile 30×2 МБ у RAM = OOM-kill Capacitor-WebView).

**Layout дискового кешу (Disk-режим).** Окремий каталог **`.history-cache/`** у
`.obsidian/plugins/<id>/`, **gitignored** (як `.push-queue`/`.trash`; додати у `CONFIG_DIR_SEED`
`gitignore-invariants.ts`). Структура **дзеркалить vault-шлях**, **ім'я файлу стає каталогом**,
усередині — версії, названі за **commit-SHA**:
```
.history-cache/
  Folder1/
    note.md/              ← ім'я файлу = каталог
      <commitSha1>        ← байти версії 1 (raw; тип/EOL — за розширенням каталогу-файлу)
      <commitSha2>
```
Self-documenting (одразу видно, чиї версії кешовані — та сама логіка, що `.trash/<id>/vault/<path>`).
Колізій із vault немає (окреме дерево).

**⚠️ Диск під навантаженням.** `diff2-history` — **per-file** (1 таб на файл, §4.2); користувач
може тримати відкритими **десятки** таких табів паралельно — **кожен для ІНШОГО файлу** (двох на той
самий файл не буде — 1/file). У Disk-режимі кожен **накопичує свій** `.history-cache/<F>/` → сумарний
диск може вирости **суттєво** (десятки файлів × вміст їхніх версій). Тому **наголошувати користувачу**
(tooltip/Notice), що одночасний пошук по історії багатьох (тим паче важких) файлів відчутно збільшує
використаний диск — саме тут доречний Frugal-режим. (Кожен таб чистить свій `<F>/` при закритті;
повне очищення — onload.)

**Текстовий фільтр = reuse §2.2.17.** Модель запиту = `SearchQuery {search, caseSensitive, regexp,
wholeWord}` (та сама, що вже у проєкті для in-editor Ctrl+F, `@codemirror/search`); тумблери UI =
дзеркало CM6-search-панелі, без replace-рядка. Reuse = **query-модель + UI-тумблери**; сам пошук іде
не по відкритому документу, а по вмісту версій у worker-і (cpu-worker будує matcher із цих параметрів).

### 4.5 Commit / Recovery
- Commit: `commitUnchangedSide("base")` (§3.2) — пише лише sibling (поточний файл), base не
  торкає. `guardEmpty`→`"\n"` доречний (History не видаляє файл).
- Recovery: one-sided (§3.1) — base зі snapshot immutable; detection перевіряє лише sibling.

### 4.6 Backlog (окремі фази)
- **Крос-версійний пошук БІЛЬШЕ НЕ backlog** — він тепер **частина фільтра** (§4.4:
  worker-fetch вмісту версій + `SearchQuery`-matcher). Раніше (feasibility §10 п.4) був
  «окремою фазою»; тепер у скоупі Phase 7. Лишається **оцінити вартість API/worker** (N викликів
  `getContentsAtRef` у межах періоду) перед реалізацією — але це під-задача §4.4, не окрема фаза.

---

## 5. Deleted mode (Phase 9b)

### 5.1 Модель (дзеркало History)
- **`base` = порожньо** = поточний відсутній стан за `originalPath` (= «наш» бік, WRITABLE).
- **`sibling` = вміст видаленого файлу** з `.trash/<id>/vault/<originalPath>` (read-only).
- Resolve у бік **sibling** (взяти вміст) → **відновлює** файл (пишемо `originalPath`).
- Resolve у бік **base** (порожньо) → лишаємо **видаленим**.

`diff2-panel:Deleted` — це **sub-tab у панелі** (як Conflicts), НЕ окремий view-type.
Плоский список → клік → `diff2-editor` (origin `deleted`) → `[←]` → назад у `panel:Deleted`
(1 крок).

### 5.2 TrashStore data-шар (R3) — ✅ вже реалізований
Повна специфікація — `docs/DIFF2_IMPLEMENTATION_PLAN.md` R3 (R3.1–R3.12). Коротко:
- **Layout:** `.trash/<id>/meta.json` (`TrashRecord`) + `.trash/<id>/vault/<originalPath>`
  (move, не copy).
- **Захоплення (R3.2, R3.4):** monkey-patch `vault.delete`/`vault.trash` (user-driven) +
  explicit `trashHooks.captureForDelete(path)` з `applyRemoteDeletion` (pull-delete,
  one-drain recovery window). Conflict-sibling — НЕ виняток (теж у trash).
- **Design boundary (R3.4/R3.12):** реагує ТІЛЬКИ на (a) monkey-patched vault.delete/trash,
  (b) sync2 explicit hook. Прямі `adapter.remove` сторонніх плагінів — навмисно НЕ protected
  (permanent contract, не gap).
- **Three-layer TTL (R3.5):** 1a `confirmDeleted` (base-delete у batch) / 1b
  `confirmResolved` (Phase B side-batch, siblings basePath-у) / 2 `sweepOlderThan(
  drain.startedAt)` (backstop: synthetic, gitignored, orphan).
- **Compare-lift (R3.7):** metadata-only `liftedAsSessionId` marker у meta.json — **shield**
  проти cleanup під час перегляду (load-bearing, не косметика). `liftForCompare` /
  `returnFromCompare` / `resetLifts` (defensive).
- **Recovery sweep onload (R3.11):** orphan-dir / stale-lift-marker / meta-valid-but-file-gone.
- **API surface (R3.9):** `TrashStore` (intercept/list/get/subscribe/lift/return/
  resetLifts/confirm*/sweep*/asHooks). `TrashHooks` живе у `src/sync2/trash-hooks.ts`
  (sync2-owned, зберігає dep-напрям: sync2 НІКОЛИ не імпортує diff2).
- **Модулі:** `src/diff2/trash-store.ts`, `trash-watcher.ts`, `trash-recovery.ts`,
  `strip-conflict-suffix.ts`, `trash-disk-helpers.ts`, `types.ts`.

### 5.3 Variant A / B (за live-станом path-у) — R2.4
Вибір робиться в момент відкриття detail через `getAbstractFileByPath(originalPath)` (без
збереженого стану):
- **Variant A — path ВІЛЬНИЙ** (нема live-файлу): read-only single-side прев'ю (одна
  версія — deleted content), plain markdown + line numbers, без маркерів/word-diff/per-chunk.
  Заголовок: `<vaultPath> · deleted <ts> from <local trash>|<GitHub history>`.
- **Variant B — path ЗАЙНЯТИЙ** (delete→recreate): detail відкривається у **Compare mode**
  (R2.1): ours = live-файл, theirs = trash-bytes, read-only default (toggle ✏️/🔒).
  `[Restore]` → collision-rename `<stem>.restored-<iso-ts><ext>`.

> **⚠️ Неузгодженість двох першоджерел (НЕ вирішено тут — див. §9 п.4):** є два трактування.
> (a) **Рання R2.4** — окремі варіанти: Variant A = read-only single-side прев'ю, Variant B =
> Compare-mode. (b) **Пізніша feasibility §11 (§5.1)** — звичайна diff-пара base=порожньо /
> sibling=trash з ЄДИНИМ diff-editor (§3, п.5), а «base зайнятий» — це просто колізія на
> restore (§5.4). Цей документ **не обирає** між ними (це design-рішення користувача); §9 п.4
> фіксує рекомендацію (єдиний editor + опційне read-only-прев'ю «глянути»), але лишає відкритим.

### 5.4 Commit + collision-rename
- Commit: **write-OR-SKIP** (§3.2 SETTLED), НЕ delete-capable. resolve→вміст ⇒ записати
  `originalPath` (Variant A) / `<stem>.restored-<iso-ts>` (Variant B); resolve→порожньо ⇒
  **skip** (нічого не писати, live-файл не чіпати). **НІКОЛИ `removeIfExists`** (§3.2 MUST —
  інакше Variant-B clobber = data-loss).
- **Variant B — зайнятий `originalPath`** (файл видалено→перестворено): restore НЕ має
  затирати live-файл → **collision-rename** `<stem>.restored-<iso-ts>` (R2.4, mirror
  `.recovered-<ts>` з R8.1). Без цього — тихе data-loss.
- **R3.7 compare-lift** під час deleted-edit: trash-запис «lifted» (`liftedAsSessionId`),
  щоб drain його не змів.

### 5.5 Recovery — one-sided (як History)
sibling = trash immutable → detection бере зі snapshot; replay уже snapshot-based (§3.1).

### 5.6 Restore (уніфікований UX — R3.6)
Список Recently deleted зливає `.trash/` entries + GitHub-history removals (per-path
dedup: GitHub-версії лише якщо trash порожній по цьому path):
- **trash entry** → `TrashStore.restore(id)`: `adapter.rename` назад до `originalPath` (+
  collision-rename якщо зайнято) → drop `.trash/<id>/` → notify. **Ще не реалізовано** (Phase
  9b, R3.13 п.1).
- **GitHub-only** → завантажити байти з GitHub repo → відновити. Залежить від **Phase 7**
  (`listCommitsForPath`); без нього — scope-cut на local-trash-only (R3.13 п.3).

### 5.7 Deleted-mode UI (R3.13 Phase 9b items — ще не збудовано)
1. **`TrashStore.restore(id)`** (§5.6) + recovery-row у R8.1 (partial state «moved back,
   dir not wiped» → sweep завершує rmrf).
2. **`src/diff2/deleted-list.ts`** — list view, path-only-when-empty filter (`
   getAbstractFileByPath(path) === null`); subscribe `trashStore.subscribe` +
   `vault.on('create')` для live-reactive filter.
3. **Detail** — reuse CM6 у `mode:"preview"` (read-only render deleted-bytes) АБО повний
   editor (§5.1). Toolbar `src/diff2/toolbar-deleted.ts` (R7.9d): `[←]` / `[Restore]` /
   `[Open in external tool]` (desktop).
4. **`[Restore from GitHub]`** — залежить від Phase 7.
5. **Last-detail-tab-close hook** → `trashStore.resetLifts()` (R3.7 invariant; метод уже є).
6. Жодної кнопки масової очистки (`Empty trash`) — TTL чистить сам (R2.4).

### 5.8 Deleted × Conflict — redirect, навігація, що показуємо (✅ SETTLED 2026-07-03)

> Повний тред (2 advisor-раунди + code-audit + grep, `diff2@a0b14d0`). **Engine-коду НЕ додаємо** —
> це наявні властивості рушія (§6) + ОДНЕ нове UI-правило (redirect у `deleted-list`).

**Правило redirect (ключуємо на `findAllConflicts`, НЕ на ConflictStore-record).** І
Conflicts-список, і лічильник будуються зі скану vault-siblings (`findAllConflicts`,
`synthetic-detector.ts:104`; `conflict-counter.ts:49-50`), а не з `ConflictStore.list()`. Тож для
рядка Deleted-списку з відсутнім path P:

| Стан P | Дія кліку |
|---|---|
| є live `*.conflict-from-*` sibling (findAllConflicts бачить P) | **redirect у conflict-editor** (origin `conflict`; base=`""`/sibling=remote). Restore-з-trash окремо НЕ пропонуємо — розв'язуй конфлікт (`[Apply remote]`=restore, `[Keep local]`=лишити видаленим). |
| sibling відсутній | **plain trash-restore** (звичайне видалення АБО обидва файли видалені). Застарілий ConflictStore-record (якщо є) self-heal-иться на Phase A — phantom-а нема, бо списки скануть siblings, не store. |

Чиста лінія: локальний trash-вміст як «третій варіант» доступний **саме коли sibling зник**; поки
sibling живий — редиректимо в конфлікт (виправдовує вибір (a)).

**Навігація `[←]` — origin (семантика) ≠ returnTab (навігація).** Редиректований редактор має
**origin `conflict`** (commit = pair-atomic `commit7Step`, **НЕ** write-or-skip!), але повертати
його треба у **вкладку, звідки клікнули**. Тож редактор несе явний `returnTo` (виставлений на
запуску; персиститься в `getState`): Deleted-launched конфлікт → `[←]` → `panel:Deleted`;
Conflicts-launched → `panel:Conflicts`; file-menu/ribbon/status → природний дім (Conflicts);
History → `diff2-history`. `planBackNav` читає `returnTo`, не виводить із origin.

**Що показуємо в Deleted-списку: ✅ ВСІ записи, включно з sibling-ами** (`*.conflict-from-*`)
(рішення користувача 2026-07-03: їх небагато + вони все одно зникають при Sync). Тобто
path-only-when-empty фільтр sibling-и НЕ відсіює. Наслідок: restore sibling із trash = «передумати»
(R3.2) — повертає **сторону розв'язку**, не base; семантика — див. §6 tracked-інваріант.

**Повний перелік варіантів (вісь = джерело restore):**

| # | Стан | Джерело / дія |
|---|---|---|
| 1 | видалено, до sync, без конфлікту | `.trash` |
| 2 | видалено, sync зроблено, без конфлікту | GitHub (trash змело) |
| 3 | base видалено, **sibling присутній** (конфлікт) | **redirect у конфлікт** → restore з sibling (`[Apply remote]`) |
| 4 | base+sibling видалено (resolve→delete файл-оп.), до sync | sibling зник → **plain `.trash`-restore**; engine-safe (§6) |
| 5 | **gitignored** файл | `.trash`-only → після sweep зникає **назавжди**, конфлікт неможливий |
| 6 | **Variant-B** (path пере-зайнятий) | Deleted-фільтр (path present) **ховає**; restore = collision-rename |
| 7 | **multi-entry** (delete→recreate→delete) | кілька trash-записів, restore обирає конкретний |
| 8 | видалене **БУЛО sibling-ом** | restore повертає **сторону розв'язку**, не base (§6 tracked-інваріант) |
| 9 | **delete-vs-delete** (обидва видалили) | конфлікту нема; лише GitHub |

---

## 6. Суміжне: delete-vs-modify (R2.5) — уже working, не плутати

Це **конфлікт** (origin `conflict`), НЕ Deleted-режим, але має спільну «порожній base»
візуалізацію:
- Сценарій: локально видалено `note.md`, на іншому пристрої — модифіковано. sync2 бачить
  delete-vs-modify → `onConflict(ours="", theirs=<remote>)` → sibling
  `note.conflict-from-*.md`.
- **`vaultPath` відсутній** у vault, `siblingPath` присутній — єдиний випадок, коли
  ConflictStore вказує на неіснуючий vault-path.
- DiffPane рендерить ours порожньою (0 рядків) — **природно** для розмітки, без спецкоду.
- Absent-base siblings **показуються** в list view (зміна 2026-06-18) — і tracked, і
  synthetic (`synthetic-detector.ts` більше не має orphan-skip). Це вже **реалізовано**
  (milestone 2026-06-19, absent-base + empty-resolution).
- Toolbar: `[Keep all local]`=лишити видалення / `[Apply all remote]`=відновити з theirs;
  `[Join all]` **сховано** (нема ours).

Deleted-режим (§5) від цього відрізняється: там sibling = trash (локальне, read-only), а не
remote conflict-from; і writable = base, а не pair.

### 6.1 Restore-while-conflict-pending = engine-safe (наявна властивість, нуль нового коду)

Якщо path у стані «resolved-toward-delete» (base+sibling видалено файл-операціями), а користувач
відновлює його **до** розв'язувального Sync:

- **restore ДО будь-якого Sync** (нормальний випадок): Phase B на drain-і читає **живий** стан
  vault → base присутній → `enqueueSynthetic` несе **вміст** (не `null`), merge-tree
  (`finalizeConflictBranchIfReady`) включає його. Batch-видалення з `content:null` не постає;
  merge-commit, коли постане в кінці drain-у, кодує **відновлення**. `sync2-manager.ts:2505-2526`/`:2562-2600`.
- **restore ПІСЛЯ того, як side-batch-видалення вже в черзі** (рідше): re-target
  (`sync2-manager.ts:3252-3260`) — видалення пушиться, P пере-додається на новий HEAD (той самий
  кінцевий стан, через delete-then-re-add churn).
- Обидва проходять `validateDeletionsAgainstHead`/SHA-reconcile, як будь-який push. **«Що робити з
  merge-commit?» → нічого** — рушій обробляє коректно.

### 6.2 🔑 Tracked-record інваріант (видалення файлів ≠ закриття tracked-конфлікту)

`ConflictWatcher` — **READ-ONLY** (`conflict-watcher.ts:15-17`): record дропається **лише** на
Phase A при drain (`conflict-classifier.ts:235`, `!siblingExists → store.delete`). Тому:

- **restore sibling до розв'язувального Sync → конфлікт лишається TRACKED** (record ніколи не
  дропався; «повертати» нічого не треба — він не зникав).
- **Co-terminous:** record (Phase A, drain-start) і sibling-trash (layer 1b `confirmResolved`,
  `trash-store.ts:194`) вмирають в ОДНОМУ розв'язувальному drain-і → до нього обидва є (restore =
  tracked), після — обох нема (restore з trash неможливий). Тож «restore → synthetic» у нормі
  **недосяжний**.
- **Edge (чесно):** aborted drain — Phase A дропнув record, push впав **до** layer 1b → record нема,
  trash є → restore = **synthetic** (все ще повністю розв'язується diff2; втрати даних нема —
  conflict-branch коміти вже на remote через `pushConflictPathsToBranch` при реєстрації).
- ⚠️ **UX-наслідок:** після видалення ОБОХ файлів (до Sync) tracked-record живий, але **невидимий
  в обох вкладках** (обидві скануть vault-siblings, яких у vault нема) — «передумати» доступне ЛИШЕ
  через restore з `.trash`. Це і є причина показувати sibling-и в Deleted-списку (§5.8, вибір (i)).

---

## 7. Реальний стан коду — що є / чого нема

> ✅ **Звірено з кодом** (audit `diff2` @ `a0b14d0`, 2026-07-02). Код = істина для ПОТОЧНОГО
> статусу; за розбіжності з доками-намірами вище — істина тут.

### 7.0 Зведена таблиця

| Область | Verdict | Що Є | Чого НЕМА (треба збудувати) |
|---|---|---|---|
| **1. GitHub commit-history API** | 🟡 PARTIAL | `getLatestCommitDateForPath` (1 коміт, без пагінації), `getContentsAtRef` (байти за SHA, Blobs-fallback >1MB), `getCommit(sha)` | **`listCommitsForPath(path, ref, {since?,perPage?,page?})`** з пагінацією; helper «commits between two refs» для Deleted removals |
| **2. Push-queue reader** | 🟢 FUNCTIONAL | layout `.push-queue/<id>/vault/`; `list()`, `read(id)`, **`readFile(id, path)`**, `peekPathSha(path)`, `collectAllPaths()` | нічого нового — staging-area вистачає для History-локального шару; це НЕ history-log (лише pending-батчі) |
| **3. TrashStore (`.trash`)** | 🟢 **COMPLETE** | повний клас + `intercept/list/get/subscribe/lift/return/resetLifts/confirm*/sweep*/asHooks`; 3-layer TTL; R3.7 shield; recovery-sweep; sync2-wire | — (data-шар готовий; лишилось `restore(id)` — це UI-фаза 9b, не data) |
| **4. View-types / origin** | 🟡 PARTIAL | `diff2-edit-view` (панель), `diff2-editor-view` (editor); **`DiffEditorOrigin` = `conflict\|compare\|history\|deleted`** (всі 4!); `DiffEditSubTab = conflicts\|deleted`; write-set routing для всіх origin-ів | `diff2-history` view-type; History/Compare entry-points |
| **5. Commit / autosave-meta** | 🟡 PARTIAL | `baseCommitAction` (4 empty-кейси + delete), `commitUnchangedSide`, `commitToAlt`, `classifyToctou`, `commit7Step`, `AutosaveMeta.baseExistedAtStart`, `GIT_EMPTY_BLOB_SHA` | **write-or-skip factoring** `finalizeUnchangedSide` (0 входжень у `src/` — settled §3.2, назва замінила misnomer `resolveOrDeleteUnchangedSide`); `deriveAutosaveId` НЕ приймає `history\|deleted` (тільки `synthetic\|compare`, `autosave-store.ts:100`); meta без version-SHA (History) / trashId (Deleted) |
| **6. UI** | 🔴 MINIMAL | Deleted sub-tab = **placeholder-текст** «Deleted-mode UI lands in Phase 9b»; forward-design (`planBackNav` deleted-гілка, `persistedEditorState`) | Deleted list/detail/restore; вся History UI; Compare picker |

### 7.1 Data-джерела — стан по кожному (пряма відповідь на питання користувача)

**`listCommitsForPath` (GitHub History) — 🟡 ЗАГЛУШКА/ЧАСТКОВО, не готове.**
- `src/github/client.ts`: **немає** `listCommitsForPath`. Є суміжні будівельні блоки:
  - `getLatestCommitDateForPath(path, ref)` (`client.ts:418`) — `GET …/commits?path=&sha=&per_page=1`,
    вертає лише **дату останнього** коміту (epoch-ms), **без пагінації, лише 1 коміт**.
  - `getContentsAtRef(path, ref)` (`client.ts:499`) — **байти файлу за commit-SHA** (з
    Blobs-API fallback >1MB). ✅ Це те, що потрібно для завантаження вмісту обраної версії —
    вже готове.
  - `getCommit(sha)` (`client.ts:348`) — метадані коміту (tree/date/message).
- **Треба:** нова обгортка `listCommitsForPath(path, ref, {since?, perPage?, page?})` з
  пагінацією (перелік ВСІХ версій), + для Deleted-GitHub — виявлення `status:"removed"`
  (`compare()` / commit-diff). **Це Phase-7-deliverable** (R3.13 п.3), і від нього залежить
  GitHub-restore у Deleted.

**Push-queue (History-локальне) — 🟢 ГОТОВЕ до читання.**
- `src/sync2/push-queue.ts`: `readFile(id, vaultPath)` (`push-queue.ts:493`) читає байти
  файлу з `vault/<path>` конкретного батча; `list()` (`:211`) вертає id-и черги (oldest
  first); `read(id)` (`:221`) — повний `QueueBatch`; `peekPathSha` (`:283`).
- ⚠️ **Нюанс:** push-queue — це **staging-area для PENDING-батчів**, НЕ history-log. Тобто
  History-локальний шар покаже лише **незапушені** версії (їх зазвичай 0–кілька). Глибша
  історія — тільки GitHub. Commit-message у батчі **не персиститься** (`processBatch` виводить
  його inline). Для History-списку локальних версій цього достатньо (показуємо
  `.meta.json.createdAt` + вміст); для «повної історії» — GitHub.

**TrashStore (Deleted-локальне) — 🟢 ПОВНІСТЮ ГОТОВЕ.**
- `src/diff2/trash-store.ts` — весь клас реалізовано й wired у sync2 (`asHooks()` →
  `Sync2ManagerDeps.trashHooks`; `applyRemoteDeletion`/`processBatch`/`drain`-end виклики).
  `intercept` (`:114`), `list` (`:156`) — desc за `originalDeletedAt`, `liftForCompare`
  (`:270`), `resetLifts` (`:348`). `TrashRecord` (`src/diff2/types.ts:27`),
  `TrashHooks` (`src/sync2/trash-hooks.ts`). **Deleted-режим тягне `list()` напряму — нуль
  data-роботи.**

### 7.2 Що ще НЕ заглушка, а вже forward-design (коштувало нуль, готове приймати нове)
- `DiffEditorOrigin` (`editor-tabs.ts:16`) вже = `conflict|compare|history|deleted` — тип
  готовий; лише гілка `conflict` реалізована.
- Write-set routing (`editor-tabs.ts:62-79`) уже має правила для history (base RO, sibling
  RW) / deleted (sibling RO, base RW) / compare (provisional lock-both).
- `planBackNav` (`editor-tabs.ts`) уже має гілку `deleted`; коментар попереджає, що
  history/compare мусять додати свої гілки.
- Deleted sub-tab (`events.ts:20`, `diff-edit-view.ts:186`) відрендерено як placeholder.

### 7.3 Точний список «збудувати» для кожного режиму

**History (Phase 7) — greenfield:**
1. `GithubClient.listCommitsForPath(...)` з пагінацією (+ кеш у `.diff2`). 🔴 нове.
2. `diff2-history` view-type (**per-file**, 1/file — можуть бути **десятки** паралельно; список
   версій + time-filter). 🔴 нове.
3. push-queue-first формування списку (readFile уже є). 🟡 wiring.
4. `deriveAutosaveId` +`"history"` kind + version-SHA у `AutosaveMeta`. 🟡 мала правка.
5. Commit — reuse `commitUnchangedSide("base")` (уже є). 🟢.
6. One-sided recovery detection (параметризація `classifyReopen`). 🟡 мала правка.
7. Entry-points: file-menu `Show history` + command palette. 🔴 wiring.

**Deleted (Phase 9b) — data готове, треба UI + commit-factoring:**
1. `TrashStore.restore(id)` (move-back + collision-rename + drop + notify + recovery-row). 🔴 нове.
2. `finalizeUnchangedSide(…, emptyPolicy:"skip")` — write-or-skip ядро (extend
   `commitUnchangedSide`, БЕЗ delete / `baseCommitAction`); `commitUnchangedSide` → обгортка
   `"stub"`. ✅ VERIFY ЗРОБЛЕНО (§3.2, §9 п.1): commit7Step-coupling НЕ застосовна. 🟡 помірне,
   low-risk. + Variant-B collision-target для write-напрямку (commitToAlt-shape).
3. `deriveAutosaveId` +`"deleted"` kind + trashId у `AutosaveMeta`. 🟡 мала правка.
4. `deleted-list.ts` (path-only-when-empty filter, subscribe trash+`create`). 🔴 нове.
5. `toolbar-deleted.ts` (`[←]`/`[Restore]`/external). 🔴 нове.
6. `renderListBody("deleted")` гілка (зараз лише placeholder). 🔴 нове.
7. One-sided recovery detection (sibling=trash immutable). 🟡 мала правка.
8. `resetLifts` на last-detail-tab-close. 🟡 wiring (метод уже є).
9. GitHub-restore — залежить від Phase-7 `listCommitsForPath`; **scope-cut** на
   local-trash-only можливий (R3.13 п.3).

---

## 8. Sequencing (Phase 7 / 8 / 9b)

- **Phase 7 — History.** Greenfield: `listCommitsForPath` (нове), `diff2-history` view-type
  (новий), push-queue-reader для History, time-filter. Commit reuse `commitUnchangedSide`.
- **Phase 8 — Compare.** `liftForCompare`/`returnFromCompare` (API вже є з Phase 9a, PR-6) +
  UI hook (compare-with-trashed).
- **Phase 9b — Deleted UI + restore.** Data-шар (R3) вже є. Лишилось: `TrashStore.restore`,
  `deleted-list.ts` (+ **redirect-правило** §5.8), `toolbar-deleted.ts`, **write-or-skip** commit
  factoring `finalizeUnchangedSide(…, emptyPolicy)` (§3.2 SETTLED; НЕ delete-capable), one-sided
  recovery detection, `resetLifts`-hook, `returnTo`-навігація (§5.8).
- **Залежність:** Phase 9b GitHub-restore залежить від Phase 7 (`listCommitsForPath`).
  **Scope-cut:** 9b можна ship-нути **local-trash-only** до Phase 7 (GitHub-restore —
  post-7 patch, R3.13).
- **Forward-design уже закладено (коштує нуль):** `origin`-enum готовий приймати
  `history|deleted`; `openGuard`/write-set узагальнені; `onExitComplete` origin-routed
  (Phase 1 реалізує лише гілку `conflict`).

Рекомендований порядок (advisor): **9b local-trash-only** дає видиму цінність найдешевше
(data-шар готовий) — але потребує commit-factoring + one-sided recovery. **Phase 7**
розблоковує GitHub-restore для 9b і сам по собі найбільший (новий API + новий view-type).

---

## 9. Відкриті рішення (записано, НЕ вирішено — «на етапі плану»)

1. **✅ SETTLED (2026-07-02) + load-bearing MUST — commit-модель History/Deleted** (було:
   «VERIFY commit7Step coupling»). Прочитано `exit-commit.ts`; пересторога ЗНЯТА (§3.2 —
   single-write шляхи не мають done.json/step-6.5/recoverCommit-зв'язку; докази
   `exit-commit.ts:437-439`/`:427-432`; `commit7Step`/`:209`/`:283` не чіпаємо).
   **MUST для implementer:** Deleted commit = **write-or-SKIP, НІКОЛИ `remove`** — empty
   resolution МУСИТЬ придушити запис (не матеріалізувати `"\n"` на absent-path; не торкатись
   чужого live-файлу у Variant B). НЕ wire-ити Deleted через `baseCommitAction`/`removeIfExists`
   (то шлях delete-vs-modify-конфлікту §6, `:87-99`/`:269-270`). **✅ РАТИФІКОВАНО користувачем
   2026-07-02.**
2. **Naming-debt `commit*` → `resolve*`/`finalize*`/`write*`** (feasibility §11): префікс
   `commit7Step`/`commitUnchangedSide`/`commitToAlt`/`commitOrDiscardExit`/`recoverCommit`
   означає «фіналізувати резолв на диск», а НЕ git-commit — але плагін РЕАЛЬНО робить
   GitHub-commit-и (sync2 push). Оманливо. Окремий cleanup (зачіпає DIFF-EDITOR.md §5.0 +
   усі call-site-и + тести) — НЕ робити мимохідь.
3. **Search-across-versions** (§4.6) — окрема фаза; оцінити вартість GitHub-API/пагінації.
4. **Variant A/B vs єдиний editor** (§5.3) — узгодити рання R2.4-візуалізація ↔ канонічна
   §5.1 (єдиний editor). Рекомендація: єдиний editor канонічний, read-only-прев'ю Variant A
   = опційний «глянути» UX.
5. **Obsidian tab ←/→ для History** (§4.6 backlog) — вирішити на History-фазі.

---

## 10. External diff-tool (R6) — desktop-only доповнення

Ортогональне до History/Deleted, але може застосовуватись у Deleted («Open in external
tool»). Desktop-only (`Platform.isMobile==false` ховає секцію). Settings: «External diff
tool» — command template з `{ours}`/`{theirs}` + toggle «use external as default». Деталі —
`docs/DIFF2_IMPLEMENTATION_PLAN.md` R6.

---

## Джерела (file:line map)

**Feasibility (ратифікована візія):** `docs/tasks/done/SPLIT-PANEL-EDITOR-FEASIBILITY.md`
- §10 History → `:414`; base/sibling-таблиця → `:447-458`; push-queue-first → `:500-508`.
- §11 Deleted → `:535`; delete-capable factoring → `:548-560`.
- §12 Phase-1 impl plan (split, уже зроблено) → `:582`.
- Forward-design (origin-enum) → `:870`.

**Implementation plan:** `docs/DIFF2_IMPLEMENTATION_PLAN.md`
- R2.3 File history (джерела) → `:377-396`.
- R2.4 Deleted files (Variant A/B) → `:398-481`.
- R2.5 delete-vs-modify → `:483-529`.
- R2.7.1 Conflicts entry-points → `:585`; R2.7.2 Compare/History entry-points → `:615-628`.
- R3 Recently deleted / Local trash → `:843`; R3.5 TTL → `:1019`; R3.6 unified restore →
  `:1061`; R3.7 lift/resetLifts → `:1079`; R3.9 API surface → `:1220`; R3.11 recovery sweep
  → `:1356`; R3.13 Phase 9b items → `:1440`.
- R6 external tool → `:1523`.

**Пам'ять:** `project-diff2-split-panel-editor.md` (3 view-types), `project-diff2-resume-point.md`
(live-pointer — REMAINING History/Deleted/Compare).

**Суміжні специфікації:** `docs/tasks/done/TASK_9A_TRASH_CORE.md` (trash core),
`docs/PSEUDO-MERGE-MODE.md` (§4.4 preserve-all-commits, §7 edit-while-in-conflict),
`docs/SYNC2.md` (§7.6 Blobs-API fallback, §7.8/§7.9 engine).

---

## Follow-up
✅ **Зроблено (2026-07-02, user-approved):** цей файл — **офіційно канонічний** для
History/Deleted; one-line superseded-pointer додано у feasibility §10/§11
(`../HISTORY-DELETED.md`) та PLAN R2.3/R2.4 (`./tasks/HISTORY-DELETED.md`).
