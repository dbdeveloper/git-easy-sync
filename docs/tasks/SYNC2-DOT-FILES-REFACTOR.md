# SYNC2-DOT-FILES-REFACTOR.md

**Статус:** DESIGN (спроєктовано й **емпірично валідовано**; НЕ реалізовано).
**Дата дизайну:** 2026-08-01.
**Замінює:** Model-B / «dot-scan depth» з [`SYNC2-METAFILE-REFACTOR.md`](./SYNC2-METAFILE-REFACTOR.md)
§2.0–§2.1 (той підхід ВІДХИЛено — див. §11 нижче).

Канонічна специфікація того, **які dot-файли й dot-каталоги Obsidian Vault потрапляють
у синхронізацію**, за яким механізмом, і чому. Написано академічно: спершу означення й
інваріанти, тоді механізм, тоді емпіричні докази, тоді план реалізації.

---

## 0. Ціль і мотивація

`vault.getFiles()` (RAM-індекс Obsidian) **сліпий до всього dot-простору** — не бачить
жодного шляху, будь-який сегмент якого починається з `.` (root-dotfiles,
`<configDir>/`, `notes/.hidden/…`). Історично плагін латав це двома ad-hoc walk-ами
(`walkRootDotfiles` — root-dotfiles; `walkConfigDir` — `.obsidian/`, per-device gate).

Спроба (SYNC2-METAFILE-REFACTOR §2.1) узагальнити це до **параметра «глибина
сканування dot-простору»** (Model-B) виявила **фатальний ґандж** — див. §1. Ця
специфікація замінює depth-підхід на **явний opt-in через `.gitignore`**: увесь
dot-простір **невидимий за замовчуванням**, а користувач вмикає потрібне явними
`!`-правилами в root `.gitignore`. Це зводить керування всім простором Vault до **одного
звичного git-механізму**, симетрично й без per-device розсинху.

---

## 1. Проблема, що вбила depth-підхід (чому Model-B ВІДХИЛено)

Параметр «глибина сканування» задумувався **per-device** (жив би в `data.json`, як
`syncConfigDir`). Це створює **асиметрію scope** між машинами:

> Машина A має depth 0, машина B — depth 1. B бачить і пушить `notes/.hidden/foo.md`.
> Файл лягає в repo. Якби pull ігнорував scope — drain записав би `foo.md` на A, де його
> НЕ засканує жоден прохід (depth 0) і НЕ буде запису в снапшоті → **тихий розсинх**:
> файл-сирота на диску, невидимий для sync у власному домі.

**Висновок:** будь-який per-device параметр, що визначає **scope** (набір версіонованих
файлів), небезпечний, якщо scope несиметричний між push і pull. Depth як scope-нож —
хибний за побудовою.

**Ключове спостереження, що врятувало дизайн:** архітектура **вже** розв'язала цей
клас бага для `syncConfigDir` (теж per-device!) — **симетричним застосуванням одного
предиката `isSyncable` на push І pull** (див. §3.3). Тому правильний шлях — не depth, а
**спільний, симетричний scope**, керований `.gitignore` (спільним, у repo) + явним
opt-in. Depth не потрібен узагалі.

**Що тепер обмежує вартість (замість depth).** SYNC2-METAFILE-REFACTOR існує, бо
сканування dot-простору коштувало ~22 с на Android; depth був cost-ножем. Прибравши
depth з міркувань коректності, ми **не втратили обмеження вартості — воно тепер інше**:
повільний walk (§4) виконується **лише** над `<configDir>/` (обмежене, як зараз) та над
явно опт-іненими анкорованими dot-теками. Тобто **вартість ∝ тому, що користувач явно
ввімкнув** — за замовчуванням (нічого не опт-інено) це просто `getFiles()` +
`walkRootDotfiles` (root) + опційно `.obsidian/`. Це «unbounded by design», але кожен
приріст вартості — **свідома дія користувача** (додав `!`-правило), а не прихований
глобальний скан. Прийнятний обмін.

---

## 2. Модель dot-простору — закон і інваріанти

**Означення.** *Dot-шлях* — будь-який vault-відносний шлях, у якому ≥1 сегмент
починається з `.` (напр. `.editorconfig`, `.obsidian/app.json`, `notes/.hidden/x.md`).
*Ordinal-шлях* — усі інші.

**Інваріант D1 (default-invisible).** Кожен dot-шлях **невидимий** для синхронізації
(ані push, ані pull), ОКРІМ явно дозволених нижче. Ordinal-шляхи видимі за
замовчуванням (модуль root `.gitignore`).

**Інваріант D2 (три джерела дозволу).** Dot-шлях стає видимим лише через одне з:
1. це рівно root `/.gitignore` (керуючий файл — завжди видимий);
2. він під `<configDir>/` (напр. `.obsidian/`) **і** `syncConfigDir=true` у
   per-device `data.json`;
3. його опт-інить `!`-правило в root `.gitignore` (напр. `!.editorconfig`,
   `!.myconfig/`).

**Інваріант D3 (рекурсивний dot-hide).** Opt-in dot-**каталогу** (`!.myconfig/`)
вносить лише його **ordinal**-вміст на всіх глибинах. **Вкладені dot**-файли/каталоги
всередині (`.myconfig/.hidden`, `.myconfig/.sub/`) лишаються невидимими, доки НЕ
опт-інені **власним** `!`-правилом. (Емпірично — §10, probe 2.)

**Інваріант D4 (симетрія scope).** Один предикат `isSyncable` визначає видимість і на
push, і на pull. Наслідок: шлях поза scope машини **не пушиться І не тягнеться** цією
машиною → жодних сиріт, жодного тихого розсинху. Різні машини можуть мати різний scope
(як `syncConfigDir` сьогодні) — це **фіча**, не баг; безпеку гарантує симетрія, а не
однаковість.

**Інваріант D5 (плаский `.gitignore`).** `.gitignore` **читається/шанується** лише на
whitelisted-локаціях: root `""`, `<configDir>`, `<configDir>/plugins/*`. Вкладений
`.gitignore` деінде — **не читається** (ієрархічна підтримка прибрана — §11).

**Інваріант D6 (`.gitignore` синкається лише де шанується).** `.gitignore`-файл
пушиться лише на whitelisted-локації (D5). Вкладений `.gitignore` у звичайній опт-ін
dot-теці (`.myconfig/.gitignore`) — **не пушиться й не шанується**, навіть якщо
`!mydir/.gitignore` чи `!.myconfig/.gitignore` формально робить його видимим. 
(Не синкати control-файл, який ми не видконуємо — інакше він оманливий.)

**Інваріант D7 (немає дозволу без discoverability — scope == discoverable set).**
*Найважливіший інваріант.* `isSyncable` НЕ СМІЄ дозволяти dot-шлях, якого push-discovery
(§4) не може досягти. Discoverable dot-простір — рівно:
- root dot-**файли** (їх лістить `walkRootDotfiles`), і
- усе під `<configDir>/` (per-device gate), і
- усе під **анкорованим конкретним** walk-target-dir-префіксом (§4.2).

**Чому це критично (деструктивний сценарій, що його D7 закриває):** якщо дозволити
шлях, недосяжний для walk (напр. неанкороване `!.myconfig/` або dot-файл у звичайній
підтеці `!notes/.secret`), то файл є у снапшоті, `checkSyncable` каже `true`, але walk
його не знайшов → Pass 2 (`change-detector.ts:358-371`) падає у гілку
`out.push({kind:"deleted"})` → **видалення з remote, що поширюється на всі пристрої**.
Зміна одного символу `!/.myconfig/`→`!.myconfig/` (втрата anchor) масово видалила б
`.myconfig/`. D7 робить втрату anchor «виходом зі scope» → тиха гілка Pass 2
(`store.remove`, БЕЗ видалення). Тому дозвіл для dot-dir мусить вимагати членства у
walk-target-множині, а не лише `!gi.ignored`.

---

## 3. Механізм дозволу (permission layer)

### 3.1 dot-hide — ФІЗИЧНИЙ керований блок у root `.gitignore` (не in-memory)

Неявну заборону D1 роблять **явним правилом у незмінному блоці** root `.gitignore`
(`ROOT_INVARIANT_BLOCK`, `gitignore-invariants.ts`) — НЕ in-memory-ін'єкцією. Блок уже
стоїть **зверху** файлу (юзерський вміст — нижче), тож splice-on-load просто додає рядки:

```
### BEGIN <plugin> invariants — do not edit ###
.*
.*/
!/.gitignore
!<configDir>/
...(наявні: *.conflict-from-*, *.sync-tmp*, *.sync-bak*)...
### END <plugin> invariants ###
...(юзерський вміст root .gitignore, зокрема !-опт-іни — ПІСЛЯ блоку)...
```

- `.*` ховає будь-який dot-**basename** на **будь-якій** глибині; `.*/` — dot-**теки**;
- **`!/.gitignore`** (АНКЕРОВАНЕ до root!) лишає лише root керуючий файл (D2.1). НЕ
  `!.gitignore` і НЕ `!./.gitignore` — обидва хибні (§10 probe 4);
- `!<configDir>/` повертає configDir-піддерево, далі ним керують його **власні**
  whitelisted `.gitignore` (D5).

**Чому фізичний блок, а не in-memory (рішення власника):** служить меті §8.1 —
**консистентність плагін↔git**: звичайний `git` (якщо юзер його запустить/склонить repo)
бачить ТІ САМІ правила й ховає нові dotfiles так само. Реюзає наявну машинерію
`GitignoreInvariants` (керований блок зверху, splice-on-load). Юзерські `!`-правила —
нижче блоку → перекривають (D2.3, §10 probe 4-C).

**Що дає анкероване `!/.gitignore` (§10 probe 4-A, реальний `GI`):**
- root `.gitignore` синкається; **вкладений `notes/.gitignore` — схований** → **D6
  забезпечується САМИМ gitignore** (isSyncable-крок D6 стає лише backstop);
- **per-plugin `.gitignore` (`.obsidian/plugins/*/.gitignore`) синкається** — його
  ВЛАСНИЙ whitelisted-вузол (`!.gitignore` у self-seed) перекриває root `.*` у
  multi-node оцінці. **Поточна поведінка `.obsidian/` збережена точно.**
- Рекурсивність D3 — безкоштовно (`.*` глибше за dir-level `!.myconfig/`, §10 probe 2);
  configDir-композиція складається (probe 3): `main.js` видимий, `other.js` схований,
  seed-invariants НЕ інвертовані.

**Наслідок для існуючих інсталів:** `enforce()` допише `.*` у блок на наступному
завантаженні → раніше-синковані root-dotfiles (напр. `.editorconfig` через старий
`walkRootDotfiles`) стануть невидимими, доки юзер не додасть `!.editorconfig`. Це — та
сама зміна поведінки, що в §8; покрити в CHANGELOG.

### 3.2 `isSyncable` (єдиний предикат)

Форма (доповнює наявний `src/sync2/change-detector.ts:isSyncable`; приймає поточний
walk-target-набір, обчислений на старті commit — §5):

```
isSyncable(path, walkTargets):
  # 1. hardcoded blocklist (без змін): manifest, self data.json, .runtime/, .git, siblings
  # 2. D2.1: path == "<root>/.gitignore"  → TRUE  (керуючий файл ЗАВЖДИ; hardcoded,
  #          НЕ через порядок правил — юзерський рядок `.gitignore` у власному root-файлі
  #          інакше переміг би за last-match і тихо вимкнув би контроль-файл)
  # 3. configDir gate (без змін): !syncConfigDir && path під <configDir>/  → false
  # 4. D6: basename == ".gitignore" && локація НЕ whitelisted             → false
  # 5. D7 (discoverability gate): якщо isDotPath(path) І НЕ під <configDir>/:
  #        discoverable = isRootDotFile(path)                       # single-segment dot
  #                       || underAnchoredWalkTarget(path, walkTargets)
  #        якщо !discoverable → return false        # немає дозволу без discovery
  # 6. дозвіл: return !gi.ignored(path)   # gi має синтетичний dot-hide (3.1) →
  #            рекурсивний hide D3 + within-target re-hides
```

Кроки 1, 3 — уже в коді. Крок 2 — hardcode `.gitignore` (менший фікс: не покладатись на
порядок правил). Крок 4 — нове (D6). **Крок 5 — нове й load-bearing (D7):** для
non-configDir dot-шляхів дозвіл вимагає членства у discoverable-множині, інакше Pass 2
може фантомно видалити (§2 D7). Крок 6 — наявний, але `gi` тепер несе синтетичний
префікс (3.1). Наслідок: неанкороване `!.myconfig/` і glob-и **не дають дозволу**
(не walk-target, не root-dotfile) — а не «pull-only» (див. виправлений §4.2).

### 3.3 Симетрія — уже в коді (доказ)

- **push:** `change-detector` Pass 1 фільтрує кандидатів через `checkSyncable`
  (`change-detector.ts:223,234`).
- **pull:** `pullIfNeeded` пре-фільтрує **кожну** вхідну зміну через
  `this.detector.checkSyncable(f.filename)` (`sync2-manager.ts:1220-1222`) — поза-scope
  remote-файл відкидається ДО запису у vault.
- **звуження scope:** якщо шлях вийшов зі scope (прибрали `!`-правило або втратили
  anchor — D7), Pass 2 (`change-detector.ts:358-371`) робить `store.remove()` **тихо** —
  **без** фантомного push-видалення на remote.

**Пасок Pass 2 (захисний, окремо від D7).** Навіть із D7 — якщо walk-target
**налаштований**, але його walk цього проходу **не відпрацював** (виняток, зникла тека
під час listing), його снапшот-шляхи «в scope» (isSyncable=true), але не в
`seenSyncable` → Pass 2 видалив би. Тому: якщо снапшот-шлях під **налаштованим**
walk-target-префіксом, walk якого **не завершився успішно цього проходу** → **drop
(skip), а не delete**. Захищає від будь-якого збою walk-у, не лише від втрати anchor.

Тобто D4 забезпечується наявною архітектурою + кроком D7 (§3.2 крок 5) + цим паском;
нова робота — вкласти dot-hide у `gi`, додати кроки D6/D7, і пасок Pass 2.

---

## 4. Discovery (push side) — як знаходимо локальні файли

`vault.getFiles()` сліпий до dots, тож видимий dot-простір треба **фізично walk-ати**
(повільний `adapter.list`+`stat`). Форма `findChanges` на `[commit]`:

```
ПАС 0 (старт commit): інвалідувати whitelisted-gitignore (§5); з root .gitignore
        витягти walk-targets (§4.2) ДО скану.
ПАС 1 (миттєвий):  ordinal-файли через getFiles() → mtime/sha vs снапшот.
ПАС 2 (root-dots): walkRootDotfiles() лістить root; isSyncable фільтрує
        (лишає .gitignore + !-опт-інені root-dotfiles). Без змін у walkRootDotfiles.
ПАС 3 (dot-dirs):  для кожного walk-target-префікса → walkDotDir(prefix); isSyncable
        фільтрує кожен файл.
ПАС 4 (deletions): set-diff (getFiles ∪ walks) vs снапшот.
```

### 4.1 `walkDotDir(prefix)` — уніфікований `walkConfigDir`

Наявний `walkConfigDir` (`change-detector.ts:535`, рекурсивний `adapter.list`+`stat`
піддерева `.obsidian/`) **узагальнюється** до `walkDotDir(prefix)`. Викликається для
кожного префікса з множини:

```
walk-targets = { <configDir>  якщо syncConfigDir }
             ∪ { анкоровані конкретні !-dir-префікси з root .gitignore }
```

**Прун (D3):** у reg-підтеки спускаємось вільно; у dot-підтеку — лише якщо вона
опт-інена (`!gi.ignored(subdir)`). Так повільний walk строго в межах явно дозволеного
dot-простору.

### 4.2 Витяг walk-targets із `!`-правил — і чому «pull-only» НЕ існує

Щоб walk-нути dot-**теку**, потрібен **конкретний шлях**. Класифікація `!`-правил, що
опт-інять dot-**теку**:

| `!`-правило | Тип | Наслідок |
|---|---|---|
| `!/.myconfig/`, `!notes/.hidden/` | анкорований конкретний dir-префікс | **walk-target** — дозвіл push+pull |
| `!.myconfig/` (без слеша) | матчить на будь-якій глибині — неоднозначно | **дозволу НЕ дає** (D7) |
| `!**/.foo`, `!*.x` | glob | **дозволу НЕ дає** (D7) |

**Правило (виправлене — Блокер 1):** лише **анкоровані конкретні dir-префікси** стають
walk-targets, і `isSyncable` (крок 5, D7) дозволяє dot-dir шлях **тільки** якщо він під
таким walk-target. Неанкоровані `!name/` і glob-и для dot-**тек** — **не дають нічого**
(ані push, ані pull). НЕ «pull-only».

**Чому не «pull-only»:** якби неанкороване правило давало pull-дозвіл без
push-discovery, `isSyncable` вертав би `true` для шляху, якого walk не знаходить → Pass 2
фантомно видаляє його з remote (§2 D7). Тому «дозвіл без discoverability» заборонено —
краще правило, що нічого не робить, ніж таке, що напів-працює й видаляє дані.

**Наслідок для UX:** щоб опт-інити dot-теку, юзер має писати **анкоровано**:
`!/.myconfig/` (а не `!.myconfig/`). Документується в README (пастка §7). Root
dot-**файли** (`!.editorconfig`) — досяжні завжди (`walkRootDotfiles` лістить root), тож
для них anchor не потрібен; але dot-файл у **звичайній** підтеці (`!notes/.secret`)
теж дозволу не дає (не досяжний жодним walk — §2 D7).

---

## 5. Плаский `.gitignore` (whitelist) і таймінг

**D5.** `gi.ts` консультує `.gitignore` лише на whitelisted-каталогах: root `""`,
`<configDir>`, `<configDir>/plugins/<seg>`. (Наразі `gi.ts` walk-ає **кожен** рівень
шляху — це прибирається.) Технічно — ін'єкція предиката `isGitignoreDir(relDir)`,
default `relDir === ""`; спільний хелпер фільтрує список каталогів і в `ignored()`, і в
`preloadAsync()` (обидва — інакше синхронний `ensureLoaded` тихо розійдеться з
прод-поведінкою).

**Anchoring (критично, silent-destructive risk).** `<configDir>/.gitignore` містить
`plugins/*/*` + `!plugins/*/main.js`; `<configDir>/plugins/<self>/.gitignore` — `*` +
`!main.js`. Обидва анкоровані до **власної** теки (`sub = rel.slice(dir.length+1)`).
Whitelist-фільтр зберігає це, бо кожен дозволений рівень рахує власний `sub`. **Gate-тест
обов'язковий:** після зміни `<configDir>/plugins/foo/main.js` → NOT ignored,
`.../foo/other.js` → ignored. Інакше seeded-invariants інвертуються (запушимо цілі теки
плагінів або перестанемо пушити `main.js`).

**Таймінг — precondition БУДЬ-ЯКОЇ sync-операції, не лише commit (advisor).**
`isSyncable`/`checkSyncable` викликається не тільки на commit: `pullIfNeeded` (з `drain`,
який при `syncStartsWithCommit:false` біжить standalone — `sync2-manager.ts:3151`) і
`bootstrapFromRemote` (`~1783`) бігають **без** commit. Тому витяг walk-targets +
інвалідація whitelisted-gitignore — precondition **commit, drain/pull І bootstrap**.
Якби walk-targets лишались порожні на pull-шляху → `.myconfig/`-вміст **тихо не
стягувався б** (configDir виживає, бо крок 3 short-circuit-ить до D7; а опт-інені
dot-теки провалюють крок 5) → D4 зламано в pull-бік (silent under-pull, вилазить лише на
другому пристрої).

На старті кожної sync-операції — інвалідація whitelisted-gitignore-вузлів
(`gi.invalidate`), щоб перший консалт читав свіже:
- **root `.gitignore`** — одразу (з нього walk-targets §4.2, ДО скану/pull-фільтра);
- **`<configDir>` / per-plugin** — лінива, але свіжа цього-разу перевірка під час walk-у.

**Fail-loud guard:** структура walk-targets несе прапорець «чи набір взагалі заповнений
цього прогону». Якщо `isSyncable` викликано з незаповненим набором (баг lifecycle) —
**падати гучно**, а не тихо відкидати dot-dir шляхи. (Той самий стан, що й пасок Pass 2
§3.3 несе для walk-completion.)

Наслідок: якщо юзер у цьому ж сеансі додав `!/.myconfig/`, уже **ця** операція це побачить.

---

## 6. `configDir` (`.obsidian/`) — особливий статус (незмінно)

Дозвіл синкати `.obsidian/` — **per-device** рішення в `data.json` (`syncConfigDir`), а
НЕ рядок у `.gitignore`. Причина: `.gitignore` **спільний** (у repo, нав'язав би рішення
всім машинам), а «ділитися своїм конфігом» — рішення **кожної машини окремо**. Це
фіча. Механізм: `!<configDir>/` у синтетичному префіксі повертає піддерево, далі ним
керують whitelisted `.obsidian/.gitignore` + `.obsidian/plugins/*/.gitignore` (D5). У
`walkDotDir` configDir — просто один префікс walk-targets з per-device gate.
**Поточна поведінка `.obsidian/` (зокрема синк його вкладених `.gitignore`) —
зберігається точно.**

---

## 7. Git-семантика — пастки для користувача (у README)

1. **`!.myconfig/foo.md` НЕ працює.** Git не може re-include файл під схованою текою.
   Вмикати саму **теку**: `!.myconfig/`. (probe D.)
2. **`!.editorconfig` без слеша матчить на ВСІХ рівнях** (`sub/.editorconfig` теж). Для
   «тільки root» — `!/.editorconfig`. (probe B.)
3. **Вкладені dots потребують власного `!`** (D3): `!.myconfig/` не вносить
   `.myconfig/.hidden` — треба `!.myconfig/.hidden`. (probe 2.)

---

## 8. Міграція й наслідки

- **Regular-файли:** прибирання вкладеного `.gitignore` означає, що файли, які раніше
  виключав subdir-`.gitignore` (напр. `notes/private/.gitignore` = `*`), **почнуть
  синкатись**, доки юзер не перенесе правила в root `.gitignore` з префіксом шляху
  (`notes/private/`). **Ризик приватності** — виділити в CHANGELOG/README.
- **Root-dotfiles, що не `.gitignore`** (`.gitattributes`, `.editorconfig`, `.foo.md`):
  за замовчуванням стають **невидимими** (D1). Хто хоче їх синкати — додає `!.gitattributes`
  тощо в root `.gitignore`. (Зміна поведінки — раніше `walkRootDotfiles` синкав усі.)
- **Тихе прибирання снапшот-рядків:** новоневидимі шляхи Pass 2 (`change-detector.ts:368`)
  викидає зі снапшота **тихо**, **без** фантомного видалення на remote. Пришпилити тестом.
- **Orphaned на remote:** файли, що стали невидимими, лишаються на remote inert — плагін
  просто перестає їх торкатись в обидві сторони. Так само вже-стягнутий вкладений
  `.gitignore` лишається на диску inert.

### 8.1 Одноразова консолідація вкладених `.gitignore` (bootstrap-міграція) — ОКРЕМИЙ ВОРКСТРІМ

**Статус: OPEN / окрема процедура, НЕ частина Кроків A–D.** Ядро рефактора працює й без
неї (тоді міграція — ручна, §8). Це **auto**-варіант тієї ж міграції; руйнівний, тож
проєктується й тестується окремо.

**Мета (за власником).** Прибрати «нелегітимні» вкладені `.gitignore`, щоб поведінка
максимально збігалась між (а) нашим плагіном, який знає лише root `.gitignore`, і (б)
звичайним git, що дозволяє багато `.gitignore`. У нашому repo вся ієрархія **імітується
одним root `.gitignore`** — тож консолідуємо правила туди й видаляємо джерела. «Легітимні»
(whitelisted D5: root, `<configDir>`, `<configDir>/plugins/*`) — НЕ чіпаємо.

**Коли (одноразово, на bootstrap).** З обох боків:
- **local-side** (adoption локального vault): скан локального дерева;
- **remote-side** (clone repo на новий пристрій): скан дерева repo.
Ідемпотентно: після успіху вкладених `.gitignore` немає → повторний запуск = no-op.

**Ескіз процедури:**
```
1. one-time ПОВНИЙ walk (тут допустимо — раз): зібрати всі НЕ-whitelisted .gitignore.
2. для кожного <dir>/.gitignore: транслювати кожне правило в root-анкероване з
   повним шляхом (див. трансляцію нижче), зберігаючи depth-порядок (глибші — пізніше).
3. дописати транслювані правила в root .gitignore (у керований блок).
4. ВЕРИФІКАЦІЯ еквівалентності (safety-net) перед видаленням.
5. видалити вкладені .gitignore локально І на remote.
6. позначити міграцію виконаною (маркер — див. відкриті питання).
```

**Трансляція правил `<dir>/.gitignore` → root (ескіз; тут — головна складність):**

| у `<dir>/.gitignore` | у root `.gitignore` |
|---|---|
| `pattern` (без слеша) | `<dir>/**/pattern` |
| `/pattern` (анкероване) | `/<dir>/pattern` |
| `pattern/` (лише тека) | `<dir>/**/pattern/` |
| `!pattern` | `!<dir>/**/pattern` (порядок across-files критичний) |

**Відкриті питання (треба вирішити в окремому дизайні):**
1. **Лоследність трансляції.** Не кожна ієрархічна конфігурація має точний
   single-file еквівалент (cross-file last-match precedence при лінеаризації, крайові
   випадки `**`/anchoring/dir-only). Рішення: best-effort + **обов'язкова верифікація
   еквівалентності** (крок 4) — для набору відомих шляхів прогнати старий ієрархічний vs
   новий плаский verdict; **розбіжність → abort + попередити юзера**, не видаляти.
2. **Ідемпотентність-маркер.** Де? Стан — у repo (root `.gitignore` + видалені файли),
   тож per-repo. Маркер у керованому блоці root `.gitignore` (версія міграції)? Чи в
   snapshot-маніфесті? Уникнути повторного запуску та гонки двох пристроїв.
3. **Гонка двох bootstrap-ів.** Серіалізувати через звичайну push/conflict-машинерію.
4. **Руйнівність.** Видалення `.gitignore` (local+remote) незворотне; крок 4 —
   обов'язковий gate. Розглянути dry-run / бекап.
5. **Взаємодія з наявним bootstrap** (`bootstrapFromRemote`, adoption B-series) — де
   саме вклинюється, до чи після pull-фільтра.

---

## 9. Що ЗБЕРІГАЄТЬСЯ / ПРИБИРАЄТЬСЯ / ДОДАЄТЬСЯ

**Зберігається:** симетрія push/pull (`isSyncable` на обох боках); тихий drop
поза-scope (Pass 2); per-device `syncConfigDir`; anchoring seeded-invariants;
`walkRootDotfiles` (**сам код лістингу root — без змін**); поведінка `.obsidian/`.

> **Уточнення про `walkRootDotfiles` (звірка з рішенням власника).** Записане рішення
> звучало як «звузити `walkRootDotfiles` до одного `.gitignore`». Кінцевий стан той самий
> (синкаються лише `.gitignore` + `!`-опт-інені root-dotfiles), але **звуження досягається
> у permission-шарі** (`isSyncable` крок 6 із синтетичним dot-hide), а НЕ вирізанням коду
> walk-у. `walkRootDotfiles` і далі лістить усі root-dotfiles як кандидатів; `isSyncable`
> відкидає неопт-інені. Так менше змін коду й один консистентний фільтр.

**Прибирається:** ієрархічний вкладений `.gitignore` (`gi.ts` walk кожного рівня);
Model-B / «dot-scan depth» (не існував у коді — лише проєкт).

**Додається:** dot-hide як **фізичний блок** у `ROOT_INVARIANT_BLOCK` (3.1); whitelist у
`gi.ts` (D5); `walkDotDir(prefix)` + витяг walk-targets (4); кроки D6/D7 в `isSyncable`
(D6 тепер backstop — gitignore ховає вкладені `.gitignore` сам); інвалідація gitignore на
старті sync-операції (§5).

**Змінюється:** `GitignoreInvariants` ROOT-блок отримує рядки `.*`/`.*/`/`!/.gitignore`/
`!<configDir>/` (раніше «без змін» — тепер це носій dot-hide).

---

## 10. Емпірична валідація

> **Відтворюваність (менший фікс advisor).** Ці probe прогнані як throwaway-скрипти й
> видалені. Перш ніж §10 стане «доказом», probe 1–3 треба **закомітити як чистий
> юніт-тест** (без vault/мережі, ~40 рядків) — інакше це лог прогону, який ніхто не
> повторить. Це частина Кроку A/B (§12).

Probe 1–2 — на бібліотеці `ignore` (тій, що в `gi.ts`), синтетичний
префікс `SYNTH = ".*\n.*/\n!.gitignore\n"`:

**Probe 1 — базовий dot-hide + opt-in:**
```
SYNTH сам:   .editorconfig ignored;  .gitignore kept;  notes/.hidden/foo.md ignored;
             .obsidian/app.json ignored;  notes/regular.md NOT ignored
+!.editorconfig:  .editorconfig VISIBLE;  .other HIDDEN
+!.myconfig/:     .myconfig/foo.md VISIBLE;  .myconfig/deep/bar.md VISIBLE
+!.myconfig/foo.md (file під схованою дир):  HIDDEN  → підтверджує пастку §7.1
+!notes/.hidden/ (вкладена):  notes/.hidden/foo.md VISIBLE
```

**Probe 2 — рекурсивний dot-hide (D3):**
```
!.myconfig/ :
  .myconfig/foo.md       VISIBLE  (ordinal)
  .myconfig/sub/baz.md   VISIBLE  (ordinal у reg-дир)
  .myconfig/.hidden      HIDDEN   (вкладений dot-FILE)
  .myconfig/.sub/bar.md  HIDDEN   (під вкладеною dot-дир)
!.myconfig/ + !.myconfig/.sub/ :
  .myconfig/.sub/bar.md  VISIBLE  (явний вкладений opt-in);  .myconfig/.hidden HIDDEN
!.myconfig/ + !.myconfig/.hidden :
  .myconfig/.hidden      VISIBLE
```

**Probe 3 — композиція `!<configDir>/` на РЕАЛЬНОМУ `GI` (multi-node, §3.1):**
root=`SYNTH+!.obsidian/`, `.obsidian/.gitignore`=CONFIG_SEED,
`.obsidian/plugins/foo/.gitignore`=SELF_SEED:
```
.obsidian/app.json                → visible ✓
.obsidian/plugins/foo/main.js     → visible ✓
.obsidian/plugins/foo/other.js    → ignored ✓   (seed-invariants НЕ інвертовані)
.obsidian/plugins/foo/manifest    → visible ✓
notes/.hidden/x.md, .editorconfig → hidden  ✓
```

**Probe 4 — ФІЗИЧНИЙ блок + вибір `!/.gitignore` vs `!.gitignore` (реальний `GI`, §3.1):**
блок=`.*`+`.*/`+`<variant>`+`!.obsidian/` + ті самі seed-и:
```
A: !/.gitignore (анкероване) — ВСЕ правильно:
   .gitignore synced; notes/.gitignore HIDDEN (D6 нативно!);
   .obsidian/plugins/foo/.gitignore SYNCED (per-plugin, поточна поведінка);
   plugin main.js + app.json synced; .editorconfig hidden
B: !.gitignore (без /) — ХИБНО: notes/.gitignore НЕ схований → D6 зламано
C: user !.editorconfig ПІСЛЯ блоку → VISIBLE (порядок працює)
D: user-літерал !./.gitignore → .gitignore ЛИШИВСЯ ignored → './' НЕ працює
```

Усі очікування збіглися → D1–D3, configDir-композиція і **вибір анкорованого
`!/.gitignore`** обґрунтовані емпірично. Фізичний блок безпечно зберігає поточну
поведінку `.obsidian/` і забезпечує D6 самим движком.

---

## 11. Відхилені альтернативи

- **Model-B / «dot-scan depth» (per-device param).** ВІДХИЛено — §1 (несиметричний
  scope → тихий розсинх). Замінено явним opt-in через спільний `.gitignore`.
- **Depth як SPILNYY параметр (у repo).** Гарантує однаковий scope, але вводить нове
  тертя й суперечить per-device природі `.obsidian/`. Не потрібен: симетрія (D4) робить
  per-device scope безпечним і без однаковості.
- **Кастомний детектор `unignored`** (замість gitignore-правил). Відхилено на користь
  3.1: нативна git-семантика, один консистентний прохід, D3 безкоштовно.
- **In-memory ін'єкція dot-hide** (замість фізичного блоку). Відхилено на користь
  фізичного (§3.1): фізичний служить консистентності плагін↔git (§8.1) — звичайний git
  бачить ті самі правила; in-memory лишив би repo без `.*`, і git не ховав би dotfiles.
- **Збереження ієрархічного `.gitignore`.** Відхилено — джерело складності й per-file
  вартості; єдиний контроль через root простіший і передбачуваніший (ціна — міграція §8).

---

## 12. План реалізації (test-first, малими комітами)

- **Крок 0 — закомітити probe як юніт-тест** (§10, відтворюваність). Probe 1–2
  (`ignore`-lib semantics) + probe 3 (реальний `GI` composition) → чистий тест без
  vault/мережі. Це RED-baseline для решти й «пришпилений доказ» §10.
- **Крок A — permission.** dot-hide як **фізичний блок** у `ROOT_INVARIANT_BLOCK`
  (`gitignore-invariants.ts`): додати `.*`/`.*/`/`!/.gitignore`/`!<configDir>/` у
  `ROOT_INVARIANT_BLOCK` (зверху, юзер нижче) + кроки D6 **і D7** у `isSyncable` (D7
  приймає walk-target-набір — крок 5 §3.2) + hardcode `.gitignore` (крок 2 §3.2).
  Юніт-тести: push- і pull-дозвіл для dot-file / dot-dir / вкладених; opt-in через
  анкороване `!`; **D7: неанкороване/glob → дозволу НЕ дає**; configDir незмінний
  (per-plugin `.gitignore` синкається — probe 4-A); D6 (вкладений `.gitignore` схований);
  hardcoded root `.gitignore` перемагає юзерський рядок `.gitignore`.
- **Крок B — `gi.ts` whitelist (D5).** Предикат `isGitignoreDir`; спільний хелпер
  фільтрації в `ignored()`+`preloadAsync()`; **anchoring gate-тест** (§5, probe 3
  розширити на реальні seed-и); ~10 ієрархічних тестів `gi.test.ts` **інвертувати**
  (nested НЕ шанується, root перемагає), пришпилити whitelist через наявний
  read-instrumentation (`gi.test.ts:126-140`).
- **Крок B2 — discovery.** Узагальнити `walkConfigDir` → `walkDotDir(prefix)` з пруном
  (4.1); витяг **анкорованих** walk-targets із root `.gitignore` (4.2); інвалідація на
  старті commit (§5); **пасок Pass 2** (§3.3 — walk-target налаштований, але walk не
  відпрацював → drop, не delete). Тести: прун вкладених dots; **втрата anchor
  `!/.myconfig/`→`!.myconfig/` → тихий drop, НЕ mass-delete** (регресія Блокера 1);
  збій walk-у → drop не delete.
- **Крок D — доки.**
  - **README.md** — окремий параграф «Як плагін обробляє dot-файли (і `.gitignore`
    зокрема)»: default-invisible (D1), три джерела дозволу (D2), рекурсивність (D3),
    пастки §7, обмеження walk-targets §4.2, міграція §8.
  - **SYNC2.md** — окремий параграф-контракт для інженерної частини: інваріанти D1–D6,
    синтетичний dot-hide (3.1), whitelist (D5), `walkDotDir`+walk-targets (§4), симетрія
    push/pull (3.3). Код посилатиметься на нього за номером секції (як на решту SYNC2.md).
  - **CHANGELOG.md** — міграція + ризик приватності (§8).
  - Прибрати Model-B/depth із SYNC2-METAFILE-REFACTOR §2.0+§2.1 (крос-лінк сюди).
- **Крок E — auto-міграція вкладених `.gitignore` (§8.1) — ОКРЕМО, НЕ блокер.** Власний
  дизайн-пас (трансляція + верифікація еквівалентності + руйнівне видалення local+remote
  + маркер). Робиться ПІСЛЯ ядра (A–D); до того міграція ручна (§8).

**Зачеплений код:** `src/gi.ts` (whitelist), `src/sync2/change-detector.ts`
(`isSyncable`, `walkConfigDir`→`walkDotDir`, `findChanges`, Pass 2 belt),
`src/sync2/gitignore-invariants.ts` (**`ROOT_INVARIANT_BLOCK` отримує dot-hide** — §3.1),
можливо `src/main.ts:876` (конструкція `GI`).

**Pre-flight (перевірено 2026-08-01):** у `src/` нема напів-вшитого depth-параметра
(Крок D суто доковий); integration `gitignore/`+`rename/` suite використовує ЛИШЕ root
`.gitignore` → прибирання ієрархії їх не червонить.

---

## 13. Тести відповідності правилам (contract-tests) — карта «правило → тест»

Систематичний доказ, що плагін дотримується D1–D7 і решти §3–§8. Рівні:
**[gi]** юніт `gi.ts` (чистий рушій правил); **[syn]** юніт `isSyncable`/`checkSyncable`
(stub `gi` + walk-target-набір); **[cd]** юніт `change-detector.findChanges` (mock vault:
push-candidati + Pass 2); **[int]** інтеграція (реальний GitHub, симетрія й міграція).
Кожен тест — implementation-independent (перевіряє ПОВЕДІНКУ/інваріант, не структуру).

### D1 — default-invisible
- **TD1.1 [syn]** `.foo`, `notes/.bar` без opt-in → `isSyncable=false` (і push-, і pull-бік).
- **TD1.2 [syn]** ordinal `notes/x.md` → `true` (модуль root `.gitignore`).

### D2 — три джерела дозволу
- **TD2.1 [syn]** root `.gitignore` → `true` ЗАВЖДИ (навіть коли юзер дописав рядок
  `.gitignore` у власну секцію — hardcoded, крок 2 §3.2).
- **TD2.2 [syn]** `.obsidian/app.json`: `syncConfigDir=true`→`true`; `false`→`false`.
- **TD2.3 [gi]** `!/.editorconfig` → `.editorconfig` visible; `.other` hidden.

### D3 — рекурсивний dot-hide (probe 2 як тест)
- **TD3.1 [gi]** `!/.myconfig/`: `foo.md` visible; `.hidden` HIDDEN; `.sub/bar.md` HIDDEN.
- **TD3.2 [gi]** `+!/.myconfig/.sub/` → `.sub/bar.md` visible; `.hidden` досі HIDDEN.
- **TD3.3 [cd]** walkDotDir **прунить** не-опт-інену вкладену `.sub/` (не спускається).

### D4 — симетрія + БЛОКЕР-1-регресія (найкритичніше)
- **TD4.1 [syn]** для набору шляхів push-verdict == pull-verdict (parametrized).
- **TD4.2 [cd] ⚠️ РЕГРЕСІЯ Блокера 1:** `!/.myconfig/` синкнуто → змінити на `!.myconfig/`
  (втрата anchor) → шлях виходить зі scope → Pass 2 **тихий `store.remove`, ЖОДНОГО
  `deleted` у out** (жодного mass-delete на remote).
- **TD4.3 [cd]** прибрати `!`-правило → тихий drop снапшот-рядка, без фантомного видалення.
- **TD4.4 [int]** пристрій A `!/.myconfig/` push; B з тим самим правилом — pull; B БЕЗ
  правила — НЕ тягне (поза scope), жодної сироти на диску.

### D5 — плаский whitelist + anchoring-gate
- **TD5.1 [gi]** `notes/private/.gitignore=*` НЕ шанується → `notes/private/x.md` visible.
- **TD5.2 [gi]** root / `<configDir>` / `<configDir>/plugins/*` `.gitignore` — шануються.
- **TD5.3 [gi] ⚠️ SILENT-DESTRUCTIVE gate (probe 3/4):** `<configDir>/plugins/foo/main.js`
  → NOT ignored; `.../foo/other.js` → ignored (seed-invariants НЕ інвертовані).
- **TD5.4 [gi]** read-instrumentation: читаються ЛИШЕ whitelisted `.gitignore` (не `a/.gitignore`).
- **TD5.5 [gi]** інвертовані ~10 колишніх ієрархічних кейсів: nested НЕ шанується, root перемагає.

### D6 — `.gitignore` синкається лише де шанується
- **TD6.1 [gi]** `notes/.gitignore` → HIDDEN (не синкається; `.*` + анкероване `!/.gitignore`).
- **TD6.2 [gi]** root `.gitignore` + per-plugin `.gitignore` → synced (probe 4-A).
- **TD6.3 [syn]** `!/.myconfig/` + наявний `.myconfig/.gitignore` → цей `.gitignore` НЕ
  синкається (backstop-крок D6, навіть якщо `!` формально включив би).

### D7 — немає дозволу без discoverability (load-bearing)
- **TD7.1 [syn]** неанкороване `!.myconfig/` → `.myconfig/foo.md` `isSyncable=false`.
- **TD7.2 [syn]** glob `!**/.foo`, `!*.x` → дозволу НЕ дає.
- **TD7.3 [syn]** dot-файл у звичайній підтеці `!notes/.secret` → `false` (недосяжний walk-ом).
- **TD7.4 [syn]** анкероване `!/.myconfig/` → `.myconfig/foo.md` `true` (walk-target).
- **TD7.5 [syn] fail-loud:** `isSyncable` з незаповненим walk-target-набором → **кидає**,
  не тихо-false (lifecycle-guard §5).

### §3.1 — фізичний блок (probe 4 як тест)
- **T31.1 [gi]** блок `!/.gitignore` коректний; `!.gitignore` (без `/`) — ламає TD6.1;
  `!./.gitignore` — не працює. Пришпилити всі три варіанти.
- **T31.2 [gi]** юзерські `!`-правила ПІСЛЯ блоку перекривають `.*`.
- **T31.3 [int/cd]** upgrade наявного інсталу: `enforce()` дописує `.*` → раніше-синкнутий
  root-dotfile (`.editorconfig`) стає невидимим (тихий drop, TD4.3), доки нема `!.editorconfig`.

### §4/§5 — discovery, walk-targets, lifecycle, Pass 2 belt
- **T4.1 [cd]** walk-targets = configDir ∪ анкоровані `!`-dir-префікси з root `.gitignore`.
- **T4.2 [cd]** неанкоровані/glob НЕ стають walk-targets (парний до TD7.1/7.2).
- **T4.3 [cd] Pass 2 belt:** walk-target налаштований, але walk впав/тека зникла →
  снапшот-шляхи під ним **drop, НЕ delete**.
- **T5.1 [cd/int] lifecycle:** walk-targets обчислюються на старті **drain/pull і
  bootstrap**, не лише commit → на свіжому пристрої pull `.myconfig/` НЕ пропускається
  (пара до §5 silent-under-pull).
- **T5.2 [gi]** інвалідація на старті операції: доданий цього-сеансу `!/.myconfig/`
  видно вже цією операцією.

### §7 — git-пастки (документовані як тести-застереження)
- **T7.1 [gi]** `!/.myconfig/foo.md` → HIDDEN (re-include файлу під схованою текою не працює).
- **T7.2 [gi]** `!.editorconfig` матчить `sub/.editorconfig`; `!/.editorconfig` — лише root.

> Крок 0 (§12) комітить probe 1–4 як [gi]-фундамент; решта [gi]/[syn]/[cd] додаються
> у Кроках A/B/B2; [int] — у наявні `tests/integration/scenarios/sync2/` (нова корзина
> `dot-files/` або розширення `gitignore/`). Пріоритет-guard: **TD4.2, TD5.3, TD7.5** —
> три найдеструктивніші; мають бути GREEN перед мержем.