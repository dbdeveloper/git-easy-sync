# RESET-PLUGIN — що саме знищує «Reset plugin»

> **Статус:** ✅ ОБГОВОРЕНО І ВИРІШЕНО (2026-08-30) — D1-D3 чинні, **D4 СКАСОВАНО
> власником** (див. §3), O1-O6 закриті (див. §4). Реалізується у Фазі 1.6
> (MASTER-PLAN §8.2).
>
> **Область — поведінка reset, НЕ сховище:**
> - `resetPluginState()` (`main.ts:765-799`) і текст `ResetConfirmModal` (`tab.ts:1008-1067`).
> - Як зберігати метадані → [`SYNC2-METAFILE-REFACTOR.md`](./SYNC2-METAFILE-REFACTOR.md).

---

## 1. Звідки взявся цей документ

Питання виринуло збоку, при дизайні сховища hot-параметрів
([`SYNC2-METAFILE-REFACTOR.md`](./SYNC2-METAFILE-REFACTOR.md) §2). Обрана там 2-слотова
ping-pong схема з монотонним `seq` вимагає, щоб reset **реально прибирав слоти з диска**, а
не переписував їх свіжим станом: інакше порожній стан із `seq: 0` ляже в один слот, а в
сусідньому лишиться старий стан із високим seq — і виграє він. Reset тихо не спрацює.

Звідси — ширше питання, яке варте власного обговорення: **що взагалі має знищувати reset.**

---

## 2. Що reset робить СЬОГОДНІ (перевірено в коді)

| крок | код | що фактично відбувається |
|---|---|---|
| `store.clear()` + `store.save()` | `main.ts:771-772` | **переписує** `<configDir>/git-easy-sync-metadata.json` порожнім станом; файл НЕ видаляється |
| `queue.clearAll()` | `main.ts:773` → `push-queue.ts:374-377` | `rmdir(.runtime/push-queue, true)` |
| `renameVaultSiblingsToUnresolved()` | `main.ts:779` → `conflict-store.ts:457-479` | обходить **vault** і перейменовує кожен `*.conflict-from-*` на `*.unresolved-<ts>.*` |
| `conflictStore.clearAll()` | `main.ts:780` → `conflict-store.ts:439-446` | `rmdir(.runtime/conflicts, true)` |
| `pendingDeletions.clear()` | `main.ts:788` → `pending-deletions-store.ts:197-201` | `rmdir(.runtime/pending-deletions, true)` |
| `trashStore.clearAll()` | `main.ts:795` → `trash-store.ts:91-97` | `rmrf(.runtime/trash)` **і одразу `mkdir` назад** |
| `settings = DEFAULT_SETTINGS` + `saveSettings()` | `main.ts:797-798` | перезаписує `data.json` дефолтами (токен, репо, всі тумблери) |

**Не зачіпається нічого з цього:**

| що лишається | де |
|---|---|
| `.runtime/push-inflight.json` | `push-inflight.ts:33` |
| `.runtime/token_expired` | `token-expired-flag.ts:82` |
| `.runtime/diff2-autosave/` | `autosave-store.ts:47` |
| `.runtime/diff2-layout-restore.json` | `main.ts:2365-2366` |

### 2.1 ⚠️ Дефект у чинному коді: модалка суперечить поведінці

Текст підтвердження (`tab.ts:1026-1028`):

> «This will wipe the GitHub token, repository settings, sync history, pending push queue,
> and pending conflicts. **Local vault files are NOT touched.** This cannot be undone.»

Але `resetPluginState()` викликає `renameVaultSiblingsToUnresolved()` (`main.ts:779`), яка
обходить весь vault і **перейменовує** кожен `*.conflict-from-*` файл
(`conflict-store.ts:457-479`). Це саме файли у vault, і користувач побачить, що вони
змінили назву.

Це не наслідок жодного з рішень §3 — **помилка вже сьогодні**. ✅ **Розв'язано
2026-08-30 скасуванням D4: правиться ПОВЕДІНКА** — reset більше не торкається vault,
і текст модалки (O5) стає правдою буквально.

---

## 3. Рішення власника (2026-08-05)

**D1. Reset знищує теку `.runtime/` цілком** — не почергове чищення через API кожного
стора, як зараз. Дві причини: (а) масштабується — кожен новий файл під `.runtime/` більше
не треба окремо пам'ятати в `resetPluginState()`; (б) закриває чотири наявні хвости з
таблиці §2, які сьогодні переживають reset без жодної на те причини.

**D2. `diff2-autosave/` гине разом з усім.** Це незбережені правки у відкритих
conflict-редакторах, і сьогодні reset їх НЕ чіпає — тобто це нова втрата даних, ухвалена
свідомо. Обґрунтування власника: reset — навмисна дія, у людини є на неї причини; а за
наслідками він і так дорівнює видаленню плагіна, бо і `.runtime/`, і `data.json` лежать
усередині теки плагіна й зникають разом із нею.

**D3. `data.json` — уже чиститься, змін не потрібно** (`main.ts:797-798`). Вимога «reset
має чистити `data.json`» виконана в чинному коді.

~~**D4. `renameVaultSiblingsToUnresolved()` лишається як є.**~~ ⚠️ **СКАСОВАНО
власником 2026-08-30:** *«чи справді нам потрібно перейменовувати? Я б їх залишав
"як є". Якщо колись користувач знову запустить наш плагін, то отримає синтетичні
конфлікти, що не те що треба, але все ж щось»*. **Reset НЕ торкається vault узагалі:**
`*.conflict-from-*` файли лишаються на місці; повторне вмикання плагіна підхопить їх
як синтетичні конфлікти (шлях, що вже існує — synthetic-detector). Наслідок:
`renameVaultSiblingsToUnresolved()` втрачає єдиного виробничого викликача і
видаляється разом зі своїми юніт-тестами (D-запис у реєстрі; store v1 однаково
зникає у Фазі 5).

---

## 4. Відкриті питання — УСІ ЗАКРИТІ (2026-08-30)

**O1. ✅ Закрито Фазою 1.** Метадані переїхали в `.runtime/` (hot-пара + file-baselines
+ gitignore-invariants); legacy-шлях за «білим листом» не читається і не прибирається
(залишковий файл на старому vault синкнеться раз як звичайний файл — санкціоновано).

**O2. ✅ Порядок операцій:** `стоп scheduler → cancel drain + дочекатись idle (O3) →
rm -rf .runtime/ → ре-ініт памʼяті сторів (hotMeta.load / baselines.clear /
invariantState.load / conflictStore.load / pendingDeletions.load / counter flush) →
token-latch clear + UI → settings = DEFAULTS ОСТАННІМ → рестарт scheduler`. Settings
останніми навмисно: крах посеред reset лишає налаштування «сконфігурованими» —
користувач бачить, що reset не доїхав, і повторює (див. O6).

**O3. ✅ Рішення власника: НЕ чекати і НЕ блокувати — СКАСОВУВАТИ.** *«Користувач вже
і так підтвердив зупинку»*: reset викликає `cancelDrain()` і чекає фактичного `idle`
(drain виходить на найближчій межі файлу). Стеля очікування ~60 с (drain може висіти
в мережевому ретраї): не дочекались — Notice + ВІДМОВА від reset; зносити `.runtime/`
під живим drain не можна ніколи. Залишкова TOCTOU-щілина (Sync, натиснутий поки
відкрита модалка) — O6-клас: повторний reset дочищає.

**O4. ✅ ОДИН контракт: кожен стор створює свої теки ЛІНИВО при першому записі;
reset не створює НІЧОГО.** Перевірено 2026-08-30: усі write-шляхи вже так працюють
(hot/baselines/push-inflight — ensureDir; trash — `ensureParentDirs` у intercept).
Eager `mkdir` у `trash.clearAllImpl` стає нерелевантним (reset його більше не кличе).

**O5. ✅ Текст модалки (чернетку ратифіковано, з поправкою D4-скасування):**
«This resets the plugin to a clean state. It will permanently erase: the GitHub token
and repository settings; the sync history; local commits that have not reached GitHub
yet; pending conflicts; unsaved edits in open conflict editors; and the plugin's trash
(one-cycle recovery copies of recently deleted files). Your notes are not touched.
Conflict-copy files in the vault stay in place; if you re-enable the plugin later, it
will pick them up as conflicts again. This cannot be undone.»

**O6. ✅ Ідемпотентність повторним запуском.** Недочищена `.runtime/` — стан не гірший
за K1-K5 (самозцілення); settings-останніми робить недороблений reset ВИДИМИМ; жодного
окремого crash-механізму не потрібно.
