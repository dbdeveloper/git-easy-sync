1. Додати інтеграційний тест: підряд, через 300 мсек — робити 3–5 sync (створюється новий файл з тестовими даними й 
   робиться sync, але так швидко, щоб нові BATCHES з'являлися швидше, ніж відпрацьовує sync на одному BATCH. Має з'явитися 
   кілька записів в .push-queue, і вони всі до кінця Драін повинні зникнути, а на тестовому GitHub має з'явитись усі ці 
   файли, які передавались у цих sync-ах.

2. Такий самий тест, але зміни (одна зміна — один рядок) уносяться в один і той самий файл — має з'явитись 3–5 комітів,  
   де ПОСЛІДОВНО буде збільшуватися число рядків у цьому файлі на GitHub. Перевірити останні 3–5 комітів цього файлу 
   на GitHub і переконатись, що нічого не пропало.

3. Розфарбовувати назви файлів у дереві Obsidian нашим plugin-ом (це можливо?) — наприклад, `.gitignore` файли фарбувати
   світло-сірим кольором, а всі conflict-sibling-файли — червоним кольором.

4. Додати в контекстне меню каталогів Obsidian пунк меню: ".gitignore" — відкривати й редагувати `.gitignore` 
   для цього каталогу (потрібно робити свій текстовий редактор на CB6 для цього, чи Obsidian може і сам такі файли 
   відкривати?) Якщо `.gitignore` не існує — створювати його порожнім, або з шаблонним коментарем з поясненням як його
   правильно заповнювати. Якщо користувач закриває його без змін (порожній, чи тільки шаблон) — не зберігати зміни 
   (тобто не зберігати сам файл, тобто — видаляти). Якось так... 
   Не зрозуміло, як видаляти `.gitignore` з каталогу. Можливо, якщо користувач видалив з нього УСІ 
   записи (він порожній, хіба що пробіли та LF є) — тоді його автоматично видаляти? Але, через те що
   `.gitignore` за цим сценаріє видаляється автоматично, коли спорожніє — його немає змісту класти 
   в `.runtime/trash/` (він і так уже порожній), і головна надія на його відновлення — тільки з GitHub 
   repo (бо `.gitignore` потрапляють в repo, а отже потраплять в deleted list нашого plugin)? 
   Напевне, було б добре управляти додаванням ".gitignore" пункту меню в контекст-меню тек Obsidian в Settings 
   плагіну (OFF by default!) — objection: більшості людей це взагалі не потрібно, а "бувалі" користувачі можуть 
   відкрити `.gitignore` на файловій системі використовуючи інші засоби операційної системи, фактично пункт меню 
   ".gitignore" може бути корисний тільки на мобільній платформі, де інші засоби редагування `.gitignore` обмежені, 
   а сам Obsidian приховує dot-файли/каталоги взагалі. До речі, з того факту, що Obsidian приховує dot-файли/теки
   випливає, що цей механізм редагування `.gitignore` обмежений тільки `<root>` та іншими доступними користувачу 
   каталогами, а редагування `.gitignore` наприклад в каталозі `.obsidian` через цей механізм — неможливе.
   Користувач (просунутий) повинен сам розв'язувати цю проблему, якщо вона в нього колись виникне!

5. DONE. Зберігати persistent ознаку "token expired" у вигляді файлу-мітки `token_expired` в каталозі
   `.obsidian/plugins/github-easy-sync/.runtime/`, який витирати після відновлення зв'язку. Ми точно знаємо точки, де виникає
   ця помилка (або пропадає, бо зв'язок установлено успішно) тому можемо абсолютно точно встановлювати цей файл чи
   видаляти його. А потім цей файл можна читати і використовувати в Settings для показу відповідних повідомлень навіть
   без будь-яких перевірок, а також в statusbar menu (див. п.7 далі).

6. DONE. в statusbar зберігати рядок від нашого plugin в одному із цих виглядів: 
   1. "GitHub" — нема COMMIT-BATCHES на надсилання на GitHub і нема конфліктів 
   2. "GitHub (↑ 3)" — є три COMMIT-BATCHES на надсилання на GitHub і нема конфліктів
   3. "GitHub (↑ 3 | 20 ??)" — є три COMMIT-BATCHES на надсилання на GitHub і 20 конфліктів
   4. "GitHub (20 ??)" — нема COMMIT-BATCHES на надсилання на GitHub і 20 конфліктів

   NOTE: The conflict counter (🔀) забирається з status-bar — залишаємо тільки ({N} ??) template. Однак в ribbon має 
         бути можливість додати іконку для відкривання diff-panel. В status-bar відкрити diff-panel можна буде з 
         status-bar меню (п.7).
   NOTE2: "↑ 3" — зеленим кольором, "20 ??" — червоним кольором саме слово GitHub — звичайний колір (чорний), якщо 
          нічого не відбувається, і зелений, коли виконується drain.

7. DONE: рядок "GitHub*" в statusbar повинен бути "клікабельним" і показувати statusbar меню, яке для неініціалізованого 
   github-easy-sync plugin повине мати два рядки (схоже як стандартний неініціалізований плагін Sync). Назва 
   "GitHub Easy Sync" береться з manifest.json, не констатна назва):
   ```
   GitHub Easy Sync: Uninitialized  # сірим кольором (перевірка settings GitHub token/Owner/Repository/Repository branch на поржні значення)
   -------------------------------
   Settings
   ```

   також тут може бути повідомлення про expired token
   ```
   GitHub Easy Sync: Token expired              # сірим кольором (якщо існу єфайл .token_expired десь в plugin/github-easy-sync)
   -------------------------------
   Sync All                                     # завжди commit + drain незалежно від значення в Settings
   Commit all changed files
   Commit current file
   Pull from repo and push stored (3) commits   # додавати рядок "({N})" тільки якщо є stored COMMIT-BATCHeS
   Open diff-panel (2 open conflicts)           # додавати рядок "(1 open conflict)" коли N==1, а "({N} open conflicts)" тільки якщо N>1
   -------------------------------
   Settings
   ```
   
   Якщо помилок нема, першого рядка меню не буде, як і розділювача після нього:
   ```
   Sync All
   Commit all changed files
   Commit active file
   Pull from repo and push stored commits
   Open diff-panel
   -------------------------------
   Settings
   ```
   
8. DONE: Якщо навести курсор мишки на Sync-іконку на ribbon, то побачимо alt-текст-підказку "Sync with GitHub".
   Пропоную, якщо в черзі є коміти (на іконці зображене число, нехай (3)), цей текст писати тоді так: 
   "Sync (3 commits) with GitHub". Тоді ця підказка ще й допоможе користувачу зрозуміти значення числа на іконці.
   Він побачить однакове число і на іконці, і в alt-підказці і зрозуміє, що "3" — це не число файлів, а число комітів.

9. DONE: Схожа на (п.8) ситуація з іконкою "diff-panel", на якій також може показуватись число, і це число незакритих 
   конфліктів. alt-текст-підказки має для неї зображати "Diff-Panel" чи "Diff-Panel ({N} open conflicts)".

10. DONE: 
    видно чиї це Settings, і версію. Може ще бути посилання на GitHub repo десь маленьким лінком типу "(repo)"
    Брати такі значення з manifest.json:
    ```
      "name": "GitHub Easy Sync",
      "version": "2.0.2-beta",
      "authorUrl": "https://github.com/dbdeveloper/github-easy-sync",
    ```
    "{name} {version} ([repo]({authorUrl}))"
    буде щось таке:
    "GitHub Easy Sync 2.0.2-beta (repo)"

11. DONE: До речі, а diff-editor толерує файли з `\r\n`, а не тільки `\n`? Що станеться, якщо користувач відключить 
    auto-canonicalize і в файлах будуть такі закінчення рядків?

12. Internationalization. Переклад повідомлень plugin на різні мови (мінімум: Українська, Німецька, Єврит, НІКОЛИ НЕ
    РОСІЙСЬКА!)

13. RTL (Right-To-Left) — для природної підтримки Івриту та інших мов, де написання іде з права-на-ліво.

14. DONE: Ідея від Obsidian sync: Removed spinning from the status bar icon because it impacted battery life when the app 
    idles.
    Думаю, що варто додати в Settings таке налаштування, щоб вмикати/вимикати це крутіння. Воно гарне і наочне, але 
    справді не обов'язкове. Хоча на mobile його і так нема (принаймні я не ба. А від батареї я працюю дуже рідко. 
    Однак не я один користувач свого plugin, тому я б додав цю зупинку в Settings.

15. DONE: F3 / Shift+F3 у diff-editor search. Зараз `diff-pane-v2.ts:787` вішає лише дефолтний
    `searchKeymap` (`Mod+G`/`Shift+Mod+G` next/prev, `Mod+F`, `Esc`) — F3/Shift+F3 не прив'язані.
    Додати `{key:"F3", run:findNext}` + `{key:"Shift-F3", run:findPrevious}`. Загальна фіча (усюди в
    diff-editor); заодно потрібна для History-проброса пошукової фрази (див.
    `docs/tasks/HISTORY-DELETED.md` §4.6).

16. Протестувати Settings->Reset Plugin. Він, зокрема, повинен закривати УСІ ВІКНА, відкриті нашим плагіном і 
    повністю очищати каталог `.obsidian/plugins/<plugin-id>/.runtime/` перед повторною ініціалізацією.

17. DONE: В diff-editor сторону, яка представляє Vault-file (в conflict mode це - `base-file`) підписувати 
    (ver-blocks, hints кнопок) не <local deviceLabel>, а просто словом — "Local" ("Actual" для режимів history/deleted).
    Так значно зрозуміліше. Особливо, якщо користувач не змінить deviceLabel на різних машинах і залишить "Obsidian". 
    В цьому випадку буде порівняння типу: "Obsidian" vs "Obsidian" — що абсолютно не зрозуміло. Краще вже так: 
    "Obsidian" vs "Local".
    Тут є нюанс: для conflict mode "Local" — це ver1-block (тобто "старі зміни, "-', ми ніби кажимо: "ми щось змінили 
    локально, на цій машині ("Local"), але на сервері є "новіші" дані ("+"))!
    А для history/delete парадигма трохи змінюється. "Local" тут стає "Actual" і тепер вона знаходиться не в ver1-block,
    а в ver2-block — тобто ми ніби кажемо: "Actual — це найновіші дані, які ми додали у файл!" ("+"), тоді як 
    "history чи deleted" — це "старі" дані ("-"). 

    Відповідно, diff-editor запускається в 2-х режимах: **Conflict** та **History/Delete**. І в цих режимах навіть 
    написи на кнопках має бути різна! 

    A. Для **Conflict**-режиму це кнопки:

       На toolbar ("Keep all", "Apply all", "> Join all"):
       ```
       [<-] [Keep all] [Apply all] [> Join all] <-(вирівняно вліво)|(вирівняно в право)->         Touch-mode [x]
       Conflicts: [ ↑ ] [Undo]                  <-(вирівняно вліво)|(вирівняно в право)->        Auto-focus: [x]
          NNN     [ ↓ ] [Redo]                  <-(вирівняно вліво)|(вирівняно в право)-> Diff-mode: [Character]
       ```
       
       diff-group в тілі документу ("Keep", "Remove" для ver1-block (BASE-FILE, "Local"), "Apply", "Remove" для 
       ver2-block (CONFLICT-SIBLING-FILE, "remote")):
       ```
           | <<<<< [Keep ↓][Remove ↓] (Local)
        1 -| <ours line 1>
        2 -| <ours line 2>
           | ===== [Apply ↓↑][Remove ↓↑][> Join ↓]
        1 +| <theirs line 1>
        2 +| <theirs very-long long very-long long very-long longvery-long long
           | very-long long very-long long very-long longvery-long long loooong
           | long line 2>
        3 +| <theirs line 3>
           | >>>>> [Apply ↑][Remove ↑] ({remote deviceLabel}) 
       ```
    
    B. Для history/deleted modes:

       На toolbar ("Restore all", "Keep all". NOTE: "> Join all" не показується навіть для markdown файлів!):
       ```
       [<-] [Restore all] [Keep all]            <-(вирівняно вліво)|(вирівняно в право)->         Touch-mode [x]
       Conflicts: [ ↑ ] [Undo]                  <-(вирівняно вліво)|(вирівняно в право)->        Auto-focus: [x]
          NNN     [ ↓ ] [Redo]                  <-(вирівняно вліво)|(вирівняно в право)-> Diff-mode: [Character]
       ```

       diff-group в тілі документу ("Restore", "Remove" для ver1-block (History/Deleted), "Keep", "Remove" для ver2-block (Actual)):
       ```
           | <<<<< [Restore ↓][Remove ↓] (<YYYY-MM-DD hh:mm:ss>)
        1 -| <ours line 1>
        2 -| <ours line 2>
           | ===== [Apply ↓↑][Remove ↓↑]      # NOTE! [> Join ↓] removed even for markdown files!
        1 +| <theirs line 1>
        2 +| <theirs very-long long very-long long very-long longvery-long long
           | very-long long very-long long very-long longvery-long long loooong
           | long line 2>
        3 +| <theirs line 3>
           | >>>>> [Keep ↑][Remove ↑] (Actual) 
       ```

18. 'Use Disk-cache for files's history' property в Settings при переході з режиму "On" в режим "OFF" має видаляти
    весь кеш з диску. Так само перевірка цього режиму має відбуватись при старті plugin з такою ж дією. Таким чином
    перемикання цього параметру: ON->OFF->ON працює як скидання кешу.

19. Додати коментар (див коментар "HERE:") в `.obsidian/.gitignore` :
    ```
    # ===== github-easy-sync invariants — DO NOT EDIT =====
    # Editing this block triggers a rewrite to canonical on next load.
    
    # Per-device state — never propagate between machines.
    github-easy-sync-metadata.json
    workspace.json
    workspace-mobile.json
    community-plugins.json
    
    # HERE: це не "never propagate between machines" значення, це навпаки - дозвіл на збереження plugins/*/data.json на сервері!
    #       і цей параметр можна змінити в Settings, хоча він насправді буде змінений тут! Саме це потрібно тут в коментарі
    #       і написати! Цей параметр особливий - хоч він і знаходиться в Settings, але він не зберігається в data.json
    #       тому встановлений в Settings на одній машині, він одразу (після SYNC) стає таким самим на всіх Obsidian Vault,
    #       підключених до цього ж GitHub repo!
    !plugins/*/data.json
    # ===== end of invariants =====
    ```

20. Придумав ще "інверсію" пошуку у файлах історії файлу! — шукати не ті файли, де знайшлась певна фраза, а навпаки — 
    ті версії файлу, де цієї фрази ще не було! Таким чином ми можемо знаходити файли, де певних термінів ще не 
    зустрічалось!    

21. DONE: Для швидкості перегляду history (і можливо deleted, і навіть можливо — conflicts!) — дозволити перевантажувати
    вже відкритий таб іншим вмістом без показу модального вікна "файл вже відкрито" (перевантажити відкритий
    таб з diff-editor з даними, які стосуються цього ж файлу) ЯКЩО ще не було у diff-файл, що показується в diff-editor, 
    внесено жодних змін! Тобто, якщо спробувати відкрити інший diff-file для файла, який вже відкритий в іншому табі, 
    то замість модального вікна "File already open in a diff-editor\n"<filename>" is being resolved in another 
    diff-editor tab. Finish there first, or switch to it now", перевідкривати це вікно новим вмістом ЯКЩО і ТІЛЬКИ ЯКЩО
    у відкритому diff-editor ще не було змін. Якщо ж зміни вже були, тоді показувати модальне вікно:
    ```
    File already modified in a different diff-editor

    "<file>" is already being edited in another diff editor tab.
    Finish or revoke  your changes to open it in another conflict.
    
                                        [Go to that tab] [Cancel] 
    ```

22. Зараз контекстне меню "Open GitHub history" показує історію не тільки текстових файлів, але й бінарних. 
    Це похвально, але для таких файлів варто придумати щось простіше, ніж відкривати бінарний файл в diff-editor.
    Може, для них варто показувати просто повідомлення про те, що це бінарний файл, і пропонувати зберігати його поруч з 
    оригінальним файлом (з додатковими змінами в назві) і відкрити його в окремому табі, а його видалення залишати 
    користувачу чи як інакше можна слідкувати за його livecycle?

23. DIFF-EDITOR for History/Deleted:
    До речі, продумай як будеш ще параметризувати diff-editor для history, щоб прокидати в нього параметри пошуку 
    (пошукову фразу та значення checkboxes - []Aa, [].*, [] word). Почитай HISTORY-DELETED.md там про це сказано 24. 
    Одночасно продумай момент, що якщо передано пошукову фразу, то в редакторі потрібно буде при запуску одразу 
    ж шукати перше входження і скрлолити текст на це місце незалежно від того чи встановлено Auto-focus чи ні. Тобто в   
    history пошук по зовнішньій пошуковій фразі має вищий приорітет
    І взагалі - дискусійно що для history/deleted auto-focus буде зчитуватись з Settings. З великою ймовірністю він 
    буде false by default, а користувач повинен вмикати його руками кожний раз, як йому це знадобиться
    Або ж (можливо) auto-focus для різних режимів буде в Settings прописано окремо (autofocus для conflicts, 
    autofocus для history, autofocus для deleted)   

24. ✅ DONE (2026-07-05). РЕАЛІЗОВАНО: `pendingConflictSummary` фільтрує → лише tracked base-шляхи; synthetic-only →
    null → sync без модалки; список tracked cap-5+"…"; `[Resolve]` → `activateDiffEditView()` (панель, не sibling.md);
    текст plural за 2 осями (файли × tracked-конфлікти на файл); NOTE-глосарій tracked vs synthetic. Лічильники (badge)
    не зачеплено. Деталі — DIFF2_IMPLEMENTATION_PLAN.md §R2.6 (блок §24).
    При sync, якщо є файли в конфлікті, видається повідомленян про ці файли й вказується їх число і навіть їх перелік
    (спитати що буде, як перелік буде на 100 файлів). Так-от — тут підраховуються і синтетичні і tracked конфлікти,
    АЛЕ насправді повідомлення "Files in conflict are not visible on other device until you resolve them." стосується
    ТІЛЬКИ tracked конфліктів! Синтетичні конфлікти ніяк не впливають на процес розв'язання конфліктів, ініційованих
    git. Синтетичні конфлікти — це може бути "відголос" вже закритих конфліктів (перенесли файл в інший каталог, 
    конфлікт "завершився" типу видаленням файлу, а "синтетичний" конфлікт насправді ще тягнеться, хоча сам GitHub repo
    про це нічого не знає).

25. Зараз перенесення diff-editor з одного split в інший іде через перевідкриття і restore з диску. Можливо краще
    зробити перенесення в пам'яті. Там, схоже, є проблеми з UNDO-stack та іншими механізмами. Це так, хотілка на далеке
    майбутнє.
26. Є ще один неоднозначний момент - файл в tracked conflict постійно показується як модифікований і намагається 
    всунутись в усі коміти (навіть якщо не змінюється), але при sync відсікається. base-file в tracked conflict 
    також абсолютно легітимно може потрапити в коміт і закомітитись в merge-бранч, а не в основну гілку, тому якщо
    в нього внести зміни він повинен показатись як додатковий коміт, але тільки якщо є зміни. Якщо нема, про його
    присутність тільки вказує нагадування при кожному sync, що в Vault ще є tracked конфлікти, які варто розв'язати,
    інакше на інших devices ці зміни не відображаються.


Оновлюй свої знання про останній статус, і продовжуємо працювати далі. Після останнього push ми виконали три великі дії:
1. перенесли всі каталоги і файли, необхідні для роботи плагіну github-easy-sync з .obsidian/plugins/<plugin-id>/ в 
   підкаталог .obsidian/plugins/<plugin-id>/.runtime що зменшило безлад і покращило контроль над локальними
   даними, які ніколи не мають потрапити на сервер github в repo, щоб не спричинити збою
2. покращили механізм рестарту плагіну через API функції: `app.plugins.disablePlugin("github-easy-sync"); app.plugins.enablePlugin("github-easy-sync")`, тепер такий рестарт (якщо між цими командами не більше 3сек)
   переживають всі відкриті вікна, створені плагіном, що дуже важливо при оновленні плагіну через BRAT або через Sync в самому плагіні
3. почали імплементувати великий підпроект HISTORY-DELETED.md p.4 "History mode (Phase 7)", вже імплементовано (перевір!) етап 7a

---

## Оптимізація recovery-replay у diff-editor-v2 (perf) — на майбутнє

### Вступ у проблему
Коли користувач відкриває конфлікт у diff-editor-v2, а для нього є **збережена сесія
редагування** (`history.jsonl` у `.runtime/diff2-autosave/<id>/`), ми пропонуємо її відновити
(модалка «Resume previous edit session? · NNN edits saved»). Щоб модалка показала ЧЕСНЕ число
edits (і щоб не показувати її даремно на «битій» сесії), ми РОБИМО replay ДВІЧІ:
1. **dry-run** ПЕРЕД модалкою (у throwaway-view) — щоб дізнатись, скільки edits реально
   відновиться (replay зупиняється на першому непридатному блоці) + чи взагалі є що відновлювати;
2. **справжній** replay ПІСЛЯ «Continue» — у реальний редактор.

На тестовому файлі (кількасот байт, ~114 блоків) dry-run уже **помітно тормозить ПЕРЕД
модалкою**. Питання: що буде на файлі 2МБ? Чи реально це взагалі?

### Що НАСПРАВДІ тормозить (це НЕ DOM)
Replay (`replayHistoryV2`) ганяє `view.dispatch` по КОЖНОМУ записаному блоку. На кожній
транзакції спрацьовує `decorationsField` (StateField) → `buildDecorations(tr.state)`, який
**перебудовує ВЕСЬ набір decorations**:
- `computeWordDiff` (jsdiff, char/word-level) **на кожну diff-group**,
- marker-widgets, line-numbers, line-decorations, `↵`-glyph, glyph-diff — по всьому doc.

Тобто кожен блок коштує **O(довжина_doc + кількість_груп)**, а N блоків → **O(N × doc)**.
Це **state-рівневий** кост (біжить навіть для detached-view без видимого DOM). На 2МБ кожен з
N dispatch'ів молотить `computeWordDiff` по великому документу. Сам DOM-рендер — другорядний.
**І все це робиться двічі** (dry-run + реальний replay).

### Ключовий факт: replay'у НЕ потрібні decorations
Для коректного replay потрібні лише: **doc + `structureField` + `history()` (undo/redo) +
structure/cursor-ефекти** (`setStructure`/`resolveCaret`). НЕ потрібні: `decorationsField`,
рендер, keymaps, mouse. А transactionFilters (autoResolve/autoNewline/…) і так пропускаються
по анотації `replayDispatch`. Отже replay можна зробити суттєво дешевшим.

### Можливі рішення (по зростанню інвазивності)
- **A. `decorationsField` пропускає rebuild ПОКИ replaying** (тримає старі decorations) + ОДИН
  rebuild у кінці. Прискорює і dry-run, і реальний recovery: **O(doc) раз замість O(N×doc)**.
  Тонкість: undo/redo-блоки не несуть `replayDispatch` (це `undo(view)`/`redo(view)`), тож
  «replaying» треба визначати спільним прапором (`ReplayFlag`), а StateField до JS-прапора
  доступу не має напряму → треба продумати (напр. окремий StateField-прапор, що
  вмикається/вимикається ефектом на час replay). **Найбільший виграш за найменшої зміни логіки.**
- **B. Stripped in-memory dry-run.** dry-run монтувати на «голому» `EditorState` (тільки
  doc+structureField+history+ефекти, БЕЗ decorationsField/рендера) + мінімальний `{state,
  dispatch}` для `undo()/redo()` (без `EditorView`/DOM). Replay ідентичний (той самий
  doc/structure/stop-point), але без per-tx decoration-rebuild → **в рази швидше**. Вбиває саме
  pre-modal лаг. Реальний recovery лишається повним (йому потрібен справжній editable-view).
- **C. Reorder (replay ОДИН раз).** Replay у РЕАЛЬНИЙ view → ПОТІМ модалка (Continue лишає view;
  Cancel/Start-over — dispose). Прибирає dry-run цілком (вдвічі менше replay) + count точний
  by construction. АЛЕ чіпає загартований modal-recovery-flow (§3.2/§3.2.a) — обережно. НЕ
  прибирає per-tx decoration-кост (його прибирає лише A).

Найкраще, ймовірно, **A + B разом** (або A окремо — він універсальний). C — ортогональний;
прибирає подвоєння, але не основний кост.

### Як виміряти (логи вже стоять)
У `~/Obsidian-test/github-easy-sync.log`:
- `diff2 dry-run {recoverable, replayedBlocks, docBytes, ms}` — pre-modal лаг;
- `diff2 recovered {replayedBlocks, docBytes, ms}` — час реального recovery після Continue;
- `diff2 fresh-mount {docBytes, ms}` — час відкриття без history (для порівняння).
Відкрити кілька файлів різного розміру → подивитись `ms` vs `docBytes`/`blocks` → вирішити,
котрий шлях (A / B / C) і чи взагалі це проблема на реальних розмірах.

### Суміжне: агресивніша compaction (менший лог → коротший replay)
Зараз `compactSessionLog` (§0.5.5) **консервативна**: викидає ЛИШЕ мертві групи (undone +
truncated-by-edit), а ЖИВІ undo/redo тримає (щоб після recovery зберегти undo/redo-здатність).
Тому на «майже-весь-живий» сесії вона ледь стискає (вимір на bug56: **115 → 111 блоків**,
22835 → 21889 байт; 81 net-edit + ~34 undo/redo, викинуто лише 4).

**Missed opportunity:** повний undo/redo **round-trip** (undo N → redo N назад на верх, у кінці
`redoDepth == 0`) — чиста надлишковість: edits лишаються в undo-стеку, тож команди round-trip'у
можна викинути БЕЗ втрати undo-здатності (replay тих самих edits дає той самий `undoDepth`).
Консервативна compaction round-trip'и НЕ детектить → не стискає. Якщо додати детекцію
повних round-trip'ів (обережно: ЧАСТКОВИЙ round-trip, `redoDepth > 0` у кінці, треба зберегти —
redo-стек реконструюється лише реальним undo), лог стане меншим → replay коротший. Це
підсилює рішення A/B вище. Окрема обережна сесія (це той самий загартований history-шар).

> 
> Тепер займемось оптимізацією recovery-replay (perf)   
> 

## Оптимізація intra-group word-diff на великих diff-groups (perf) — частково зроблено + worker-ідея

### Проблема (знайдено + виміряно 2026-07-04)
У diff-editor-v2 працюють ДВА різні diff-алгоритми, і плутати їх не можна:
- **структурний** `diffLines` (`diff-model.ts`, `buildModel`) — ділить base vs sibling на
  diff-groups ПО РЯДКАХ. На 2МБ з малою кількістю змін → мало маленьких груп → **швидко**
  (це чому «відкрити 2МБ-файл з 3-4 групами» ~1с).
- **intra-group** `computeWordDiff` (`word-level-diff.ts`, jsdiff `diffChars`/`diffWords`) —
  ВСЕРЕДИНІ кожної групи порівнює ver1-block vs ver2-block по символах/словах для підсвітки
  змінених фрагментів. Викликається **per-group** (`diff-pane-v2.ts` `buildDecorations`, цикл
  `for (const g of groupsOf(ranges))`), тож рішення char/word/skip незалежне для кожної групи.

`computeWordDiff` — Myers **O(n·d)** → на ВЕЛИКОМУ РІЗНОМУ вмісті групи це **O(n²)**. Заміри
jsdiff на двох різних боках (одна велика diff-group):

| розмір/бік | `diffWords` | `diffChars` |
|---|---|---|
| 4 KB | 196 ms | 1183 ms |
| 8 KB | 710 ms | 4411 ms |
| 16 KB | 2723 ms | 19170 ms |
| 32 KB | 11600 ms | 91417 ms |

Чистий квадрат (×2 розмір → ~×4 час). 2МБ-група → **хвилини фрізу головного потоку**
(user-repro: history-«Restore» ~2МБ версії → UI завмер на 1-2 хв). Старий «fallback char→word
для великих блоків» НЕ рятував: word-diff теж квадратичний. **Важливо:** сам `[←]`-commit
diff-free і швидкий (splitModel = O(n) нарізка; в `exit-commit.ts` немає diff) — фріз був суто
на РЕНДЕРІ (mount великої-різної групи / re-render після resolve), не на збереженні.

### Зроблено (SHIPPED) — size-cap
`word-level-diff.ts`: `product = oursLen × theirsLen`, три яруси per-group:
- `product ≤ 200k` (CHAR_DIFF_BUDGET) → `diffChars` (точно, ~14 ms на межі);
- `product ≤ 2M` (WORD_DIFF_BUDGET) → `diffWords` (грубіше, ~24 ms на межі);
- `product > 2M` → **SKIP**: жодної intra-chunk-підсвітки (лінійна заливка групи лишається).
Skip **перекриває** `wordLevel`-налаштування (форсований word-diff на 2МБ завис би так само).
Repro-тест `tests/diff2/large-file-perf.test.ts` (був хвилини → тепер mount 28 ms / resolve
36 ms на 4МБ-документі). Як VS Code / GitHub — вони теж кепують intra-line diff за розміром.

Діагностичні логи (для device-repro, `github-easy-sync.log`):
- `diff2 wordDiff {oursLen, theirsLen, mode: char|word|skip, ms}` — per notable-group
  (skip-cap спрацював, або char/word ≥15 ms). Sink у `word-level-diff.ts`, дротований у
  `main.ts` onload (render-шар чистий, без logger).
- `diff2 [←] …` / `diff2 history [←] …` — покрокові таймінги commit-ланцюга (drain / read /
  assess / getResolved / commit) — підтверджують, що збереження мс-масштабу.

### Наступний крок (idea, NOT built) — outsource середніх груп у web-workers
Size-cap лишається ПІДЛОГОЮ і запобіжником; worker піднімає СТЕЛЮ точності без фрізу.
**Три яруси:** inline (малі, main-thread) → **worker** (середні, off-main) → **skip** (великі).
- Рендеримо велику групу одразу БЕЗ word-highlight (як зараз), а паралельно `cpu-worker`
  рахує char/word-diff і повертає spans; вони «з'являються на місцях» через StateEffect →
  декорацію.
- **Skip лишається верхньою межею навіть із воркерами** (узгоджено з user): воркер теж
  O(n²), тож вище WORKER_BUDGET навіть його НЕ запускаємо — інакше молотитиме 11-30 с+ намарно.
- **Чому безпечно:** декорації — суто ВІЗУАЛЬНИЙ шар, похідний від `(doc, structure)`, НЕ в
  «text + Ranges» моделі, НЕ в history/undo/replay. Асинхронне оновлення підсвітки фізично не
  може зіпсувати модель/undo-баланс/детермінізм replay. Найгірше від бага — неправильна/відсутня
  підсвітка, ніколи не втрата даних.
- **Підводні камені:** (1) staleness/скасування — поки воркер рахує, група могла змінитись;
  тегувати запит хешем вмісту групи, застосовувати spans лише якщо вміст ще той самий, інакше
  відкинути (per-group in-flight + cancel-on-change); (2) worker-side timeout — не встиг за N мс
  → лишаємось на грубому tint. Нова `cpu-worker` операція `word-diff` (поряд з merge/sha/decode;
  бандлить jsdiff). Окрема фіча середньої складності.

