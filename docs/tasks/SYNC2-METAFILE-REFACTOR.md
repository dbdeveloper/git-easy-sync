# SYNC2-METAFILE-REFACTOR — сховище метаданих для великих vault-ів

> **Статус:** дизайн-документ. ТІЛЬКИ про **сховище** метаданих для vault-ів масштабу
> 2k–20k+ файлів: **hot-файл** (кілька глобальних sync-параметрів, atomic) + **cold-кошики**
> (per-file baseline; hash-buckets + MRU-кеш) проти **write-amplification**, crash-safe через
> наявний `atomic-write.ts`. Реалізація — ІНКРЕМЕНТАЛЬНО, кожен шар gated виміром (§4).
>
> **Область — вузька (ЯК ЗБЕРІГАТИ), не сканування й не алгоритм:**
> - **Двигун** (commit change-detection + drain/pull/push + конфлікти + diff3) → [`SYNC-FIX.md`](./SYNC-FIX.md).
> - **Dot-простір** (ЯКІ dot-файли/теки синкати + `readRootGitignore`/`walkDotDir` + on-device
>   виміри) → [`SYNC2-DOT-FILES-REFACTOR.md`](./SYNC2-DOT-FILES-REFACTOR.md).
> - **Цей файл** — лише як зберігати на диску (a) кілька глобальних параметрів і (b) per-file
>   baseline-мапу, щоб зміна одного файлу не переписувала все й переживала краш.

---

## 1. Що це за дані й чому їх складно зберігати

Плагін тримає `Sync2Metadata` (`src/sync2/snapshot-store.ts`). Це **дві РІЗНОРІДНІ породи**
даних — саме тому потрібне розділення.

### A. Глобальні sync-параметри («hot») — кілька крихітних, критичних

`lastSyncCommitSha`, `lastSyncTreeSha`, `lastCommitMtime` (watermark), `remoteIdentity`
(owner/repo/branch), `conflictBranch`. Разом — кількасот байт. **Незамінні:** втрата =
плагін «забув, де він» відносно GitHub → перезалив увесь vault / насипав фальш-конфліктів.
Окремо: **`lastSyncTreeSha` — це ще й ЯКІР до merge-баз** (див. B).

`invariantState` (freshness-маркери 3 whitelisted `.gitignore`) — **provisional/виняток:**
мале, і **не просто disposable — сьогодні його взагалі ніхто не читає.**
`GitignoreInvariants.enforce()` перечитує ці файли **безумовно, не заглядаючи в кеш**
(short-circuit знято: `void recorded;` — деталі й причина в §5) → втрата поля не коштує
навіть одного зайвого перезапису. Отже «незамінної» властивості, що є критерієм hot, у
нього НЕМА взагалі. Куди його класти — §5-питання, і там же третій варіант: **викинути**;
у hot воно в будь-якому разі НЕ через критичність.

### B. Per-file baseline-мапа `files{}` («cold») — багато, per-file, і ЗОВСІМ не disposable

`{ path → { remoteSha, mtime, size } }` — стан кожного файлу **на момент останнього синку**
(НЕ поточний стан файлу в local Vault!). ~2.6 МБ на 20k, і **зростатиме** (dot-простір тепер
теж сюди — §3; rewrite drain додасть). Ключове:
- **`remoteSha` — це BASE для diff3.** Спільний предок у `mergeText(ours, BASE, theirs)`
  (pull-side, `pullIfNeeded` Case 3, `sync2-manager.ts:2081`, `base`←`previousRemoteSha`
  ←`files.remoteSha`). Тобто `files{}` — **сховище merge-баз**, а НЕ «дешевий кеш».
  ⚠️ **Кваліфікація:** `files.remoteSha` — це база для **pull-merge** і для **ПЕРШОГО**
  reconcile шляху; для **послідовних batch-ів того самого файлу** база НЕ `snap.remoteSha`,
  а **rolling** (SYNC-FIX П3/П4-refutation — саме тому snapshot тут — хибна база). Тобто
  «files.remoteSha IS the diff3 base» — не безумовно; деталі rolling-бази — у SYNC-FIX.
- **`mtime`/`size` — captured-AT-SYNC**, не поточні. `getFiles()` дає ПОТОЧНІ — інші для
  будь-якого редагованого-після-синку файлу (на цьому й тримається детекція змін).

**Два споживачі `files{}`:**
1. **commit** (детекція змін, `change-detector.ts` §40): reference «чи змінився?» = остання
   закомічена версія шляху = найновіший queued batch (`peekLatestPathSha`) **?? `files.remoteSha`**
   (fallback, коли файлу нема в жодному batch у `.runtime/push-queue/`). `getFiles()` тут —
   лише вхід Pass 1 (поточний mtime vs watermark), а НЕ джерело збережених значень.
2. **drain** (3-way merge): `files.remoteSha` → **BASE** у `diff3(BASE, local, remote)`.

### Проблема сховища — write-amplification

Сьогодні все лежить в ОДНОМУ `<configDir>/github-easy-sync-metadata.json`, повністю в RAM,
переписується **ЦІЛКОМ** (сирий `adapter.write`, не atomic) ~щобатч → **~2.6 МБ перезапис на
КОЖНУ зміну ОДНОГО файлу**, росте з розміром vault (виміри — DOT-FILES §14).

### Recovery — НЕ локальний рескан (виправлення попередньої тези)

Оскільки `files{}` — це baseline + merge-бази, чиє **джерело істини — GitHub**, втрата мапи
відновлюється НЕ пересканом vault, а **ре-деривацією з remote**: дерево@`lastSyncTreeSha`
→ per-file base-sha (+ `getBlob` за вмістом бази) + локальний скан для НОВОГО mtime/size.
Наслідок: **hot священний** — він і незамінний, і **ключ до відновлення cold**. Втрата hot
(`lastSyncTreeSha`/`lastSyncCommitSha`) → нема якоря до merge-баз → 3-way merge неможливий
→ **шторм фальш-конфліктів** (дані цілі, I2 тримає, але UX руйнується).

⚠️ **Precondition:** ре-деривація можлива, ЛИШЕ доки коміт `lastSyncTreeSha` ще досяжний на
remote. Після force-push / history-rewrite / GC його нема — і `pullIfNeeded` уже це ловить
(гілка 404-on-compare, `sync2-manager.ts:~1188`, просуває `lastSync` на живий head). Тоді
cold з СТАРОГО дерева не ре-деривується взагалі: падаємо в повний adoption проти поточного
head **без бази** — тобто саме випадок, коли теза «cold recoverable» не виконується.

---

## 2. Дизайн сховища

> **«hot/cold» — про ФОРМУ даних** (кілька-глобальних-разом vs багато-per-file), обране
> заради crash-ізоляції + write-amplification. **НЕ про важливість:** cold так само
> критичний (merge-бази §1.B) — просто його багато й воно per-file.

### Hot — окремий малий файл, atomic + crash-recovery

Глобальні sync-параметри (§1.A) → **ОКРЕМИЙ малий файл**. Пишеться через наявний
`atomicWriteFile` (`src/sync2/atomic-write.ts`): staging `.sync-tmp.` → marker →
rename/modify → cleanup. При старті плагіна `AtomicWriteRecovery.sweep` (onload) **довершує
(forward-complete) або відкочує** торн-запис. Малий файл → запис миттєвий, атомарність
дешева, псується вкрай рідко.

**Write-rate (для виміру §4 крок 2):** hot-файл пишеться **на КОЖЕН запушений batch**
(`setLastSync`+`setLastCommitMtime`, `sync2-manager.ts:3822-3823`) + на pull / зміну
conflict-branch. Тобто 10-batch drain = **~10 записів hot-файлу** — але кількасот байт
кожен, тож дешево; §4 крок 2 міряє саме проти цієї частоти.

### Cold — hash-кошики + MRU-кеш

- **Hash-кошики.** `files{}` розбита на **N кошиків** за `hash(path)`; ім'я файлу кошика =
  `<hash>.json`. N — TBD (32 / 64 / …).
- **In-memory MRU-кеш ≤ ~5 кошиків.** Потрібен новий кошик → **найстаріший (LRU)
  витісняється** з кешу.
- **Write-through:** щойно кошик змінено — flush на диск **якнайшвидше** → у кеші dirty
  кошиків бути НЕ повинно → витіснення старішого = просто **викид з кешу** (нічого писати).
- **Fallback (усі кошики в кеші виявились dirty):** перед витісненням найстаріший
  **пишеться на диск** тим самим `atomicWriteFile` (`.sync-tmp`/`.sync-bak` staging +
  recovery/rollback на рестарті), і лише тоді викидається.
- Зміна метаданих 1 файлу = atomic-write **ЛИШЕ його кошика** → write-amplification
  O(vault)→O(bucket); торн зачіпає 1 кошик, не всю мапу.

### Dot-простір — теж у ці кошики (§3)

Per DOT-FILES: dot-файли + normal-файли в дозволених dot-теках отримують записи в `files{}`
(тобто в кошики) → відслідковуються при commit і merge-аться в drain **як ordinary-файли**.
Зараз цього нема (dot-простір поза `files{}` → ні change-tracking, ні коректний diff3 для них).

### Розташування на диску (поточне → майбутнє)

**Зараз:** усе (hot + cold) в ОДНОМУ файлі `<configDir>/github-easy-sync-metadata.json`
(`SYNC2_MANIFEST_FILE_NAME`; виключений із синку в `isSyncable`).

**Майбутнє — у per-device `.runtime/`** (`<configDir>/plugins/<plugin-id>/.runtime/` — уже
hardcoded-excluded зі синку як per-device runtime-стан, `change-detector.ts:45`):
- **hot** → `.runtime/metadata.json` (один малий atomic-файл);
- **cold** → каталог `.runtime/file-baselines/` з файлами-кошиками `<hash>.json`.

> **Назва cold-каталогу** (власник просив «кращу для розуміння»): пропоную **`file-baselines/`**
> — точно описує вміст (per-file baseline = diff3-база), і уникає плутанини `metadata.json`
> (файл) vs `metadata/` (каталог) з однаковим стемом. Прийнятна альтернатива-пара —
> `files-metadata/`. Фінальна назва — за власником.

---

## 3. Сильні боки

- **Bucketing** — write-amplification O(vault)→O(bucket); RAM-ощадно (у пам'яті ≤~5 кошиків,
  не вся 2.6 МБ+ мапа).
- **Crash-ізоляція:** торн зачіпає 1 кошик; його baseline ре-деривується з remote
  (дерево@`lastSyncTreeSha`) — не глобальна втрата.
- **Hot окремо + atomic:** якір до merge-баз (`lastSyncTreeSha`) пуленепробивний і НЕ їде
  в одній «фурі» з великою мапою → торн cold ніколи не вбиває `lastSync`.
- **Єдиний crash-safe запис:** і hot-файл, і dirty-кошик пишуться наявним
  `atomicWriteFile` + `AtomicWriteRecovery` (sync-tmp/sync-bak, sweep на onload) — жодного
  нового crash-протоколу.

---

## 4. Рекомендований порядок (інкрементально, gated виміром)

НЕ будувати все одразу; кожен шар — коли попередній виміряно недостатнім:
1. **Зараз (KISS):** atomic (`atomicWriteFile`) для поточного суцільного маніфесту; прибрати
   no-op idle save; коалесувати не-crash save.
2. **Hot/cold split:** винести глобальні параметри (§1.A) в окремий малий atomic hot-файл.
   → міряти.
3. **Bucketing + MRU:** якщо cold-мапа janks на 20k (а з dot-простором — тим паче) → кошики
   + MRU-кеш (§2). → міряти.

---

## 5. Відкриті питання (рішення власника)

- **N кошиків** (32 / 64 / …) + **розмір MRU** (~5) + hash-функція шляху — тюнити виміром.
- **Частота flush** cold-кошика (write-through «якнайшвидше» — по кожній зміні? debounce на
  кілька мс, щоб batch кількох правок в один кошик дав один запис?).
- Точна межа hot/cold (що саме в hot-файлі).
- **`invariantState` — три варіанти, і третій зараз найсильніший:**
  1. **у hot-файлі** — заради дрібності (кількадесят байт), не заради критичності (§1.A).
  2. **окремо** — власний крихітний файл, щоб не змішувати disposable-кеш із незамінними
     параметрами.
  3. **ВИКИНУТИ ПОВНІСТЮ** — його вже ніхто не читає. Кеш задумувався як short-circuit для
     `enforce()` (mtime збігся → не читати файл; хеш збігся → не переписувати), але цей
     short-circuit **свідомо прибрано**: у всіх трьох `enforce*` методах `recorded`
     гаситься через `void recorded;` (`gitignore-invariants.ts:271→302`, `338→357`,
     `372→386`). Причина в коментарі там же: при апгрейді плагіна змінюється **константа**
     канонічного блоку, а файл на диску не рухається → mtime І hash збігаються із
     записаними → `enforce()` вийшов би достроково і **ніколи не доставив би нові канонічні
     рядки**. Замість кешу — безумовне `read + splice + compare`, а короткий вихід тепер
     `fixed === content`, тобто порівняння з РЕАЛЬНИМ вмістом диска (воно не може збрехати
     про зміну константи). Чому stat-short-circuit тут не варіант у принципі (навіть із
     додаванням `size`) — [`SYNC-FIX.md`](./SYNC-FIX.md) §5.4, останній абзац.

     Наслідки, якщо викидати:
     - Втрата поля не коштує нічого — навіть одного зайвого перезапису: рішення про
       перезапис content-based, а не кеш-based (це й зафіксовано в §1.A).
     - Схема-safe: `migrate()` уже толерує відсутність (`freshMetadata()` дає `{}`,
       coerce-блок просто пропускається) → жодної міграції не треба.
     - Зникає й ЗАЙВЕ I/O: `notePathSelfWritten` (живі виклики — `sync2-manager.ts:3799`,
       `:3892`) робить `stat` + `read` + SHA на кожен self-push цих файлів, щоб оновити
       поле, яке ніхто не спитає.
     - Ціна: `tests/sync2/gitignore-invariants.test.ts:198/233/295` пінять саме запис кешу —
       поїдуть разом із полем.
- Windows/Linux baseline — ще не міряно.
