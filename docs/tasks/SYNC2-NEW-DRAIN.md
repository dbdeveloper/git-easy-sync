## 9. Новий drain. Принципи побудови та основні кроки алгоритму

## I. Base info

1. Маємо metadata.files[A]={baselineSha, size, mtime} — тут зберігається інформація про файл на момент, коли цей файл
   останній раз збігся з файлом в REPO: тобто або тоді, коли цей файл було pull з REPO і збережено в Vault, або
   коли файл з Vault було push в REPO. Metadata.files зберігає SHA+size+mtime усіх файлів у Vault, включно з тими, які
   знаходяться в дозволених "dot"-каталогах (тих, яких нема в `.gitignore`). Цей список (в основному, але є винятки)
   використовується для виявлення змінених файлів після останнього commit. Фактично тут ми маємо SHA+size+mtime кожного
   файлу на момент останнього створення commit на сервері, і в metadata.files зберігається саме baselineSha цього файлу
   з цього коміту. Це значення потрібно для коректного виявлення змін на сервері в порівнянні з локальними змінами:
   порівняння (a) REMOTE vs BASE i (в основному, але є винятки) (b) LOCAL vs BASE.
   Таким чином SHA(REMOTE) == SHA(BASE) означає, що змін в REPO нема, a SHA(LOCAL) == SHA(BASE) означає, що локальних
   змін нема. Насправді під LOCAL потрібно розуміти не файли з Vault, а файли з batches, збережені в `push_queue/`
   під час команди `[commit local]`.
2. Для виявлення змін серед файлів Vault відбувається трохи інший порядок кроків:
    1. в metadata зберігається остання дата local commit `lastCommitMtime` (watermark). Шукаємо в Vault всі файли, 
       для яких mtime відрізняється від lastCommitMtime. Зауваження — звичайні файли й dot-файли, чи файли з dot-тек
       обробляються по різному!
    2. далі порівнюється size виявлених файлів з size цього ж файлу в останньому батчі (де виявився цей файл). Якщо файл
       ще не було збережено в batches, порівнюємо його size з size з metadata.files. Якщо вони різні — файл одразу ж
       додається в batch,
    3. якщо size файлів однакові, додатково розраховується SHA файлу з Vault і порівнюється з (в першому випадку з SHA
       попереднього збереженого цього ж файлу в batches (але тільки останнього!), інакше в metadata.files). Це і є той
       виняток, про який я говорив! Правило таке: порівнювати файл з Vault з останнім файлом, який вже додано в чергу на
       коміт (push_queue's batches), і тільки якщо файлу там не знайшли, тоді порівнюємо з size/baselineSha з
       metadata.files

   **Примітка (2026-08-23): це сканування — сторона `[commit]`/`findChanges`, НЕ `drain()`.** П.2
   описує, як формуються batches, які ЗГОДОМ бачить drain — сам `drain()` (§III) ніколи не сканує
   Vault на предмет "що змінилось", він лише читає вже готові `{path,sha,size}` з batches у
   `push_queue/` (§II.8). Тому це правило свідомо відсутнє в псевдокоді §III — не пропуск, а межа
   відповідальності: commit і drain — окремі процеси (`.claude/rules/sync2-engine.md`).

   **Правило size-перед-SHA — ЗАГАЛЬНЕ, не лише для цього сканування.** П.2-3 — один з проявів
   принципу, вже зафіксованого системно в SYNC2-FIX.md §12.9 ("Двоступеневе порівняння — спершу size,
   потім SHA"): розбіжність розміру ДОВОДИТЬ відмінність (можна пропустити хешування), а збіг розміру
   НЕ доводить нічого (це лише запрошення хешувати, а не привід пропустити SHA). Принцип застосовний
   скрізь, де вже є дешевий `size` і питання суто бінарне "чи змінилось" — без потреби в самому
   значенні SHA. Конкретне місце в цьому документі, де це варто застосувати: R3b crash-recovery
   ремонт `sync_store/` (§II.8) — там `size` уже є в метафайлі батчу, тож перевірку варто розбити на
   дешевий `size`-крок (відкидає ремонт одразу при розбіжності) і лише потім, якщо розміри збіглись,
   дорожчий SHA-крок.
3. Зараз вважаємо, що `[Local Commit]` вже відбувся N раз, і в `.runtime/push_queue/` вже знаходяться 0..N batches,
   кожний з яких вміщує 1..M файлів. Відповідно, SHA всіх файлів в push_queue/ збережені пермаментно (у файлах кожного
   bathes) так, що кожний наступний коміт здатний виявити зміни в файлі в local Vault відносно останнього коміту, де
   вже збережена попередня версія цього файлу (п.2).

## II. drain

Базовим компонентом нового drain є TrackedFile — це об'єкт, який "веде" окремий змінений файл через увесь drain, який
може складатись з багатьох batches, pushes і навіть pulls, особливо, якщо зв'язок був нестабільний і перезапуск
drain відбувся через години чи дні від його початкового старту, і за цей час ситуація на сервері змінилась.

Спочатку пригадаймо, як починається "класичний" drain:

1. Drain починається з перевірки файла-мітки `token_expired`. Якщо token справді expired — виводяться відповідні
   повідомлення і drain завершується.
2. Наступний крок — це отримання поточного значення `remote_head_hash = client.getBranchHeadSha()` з GitHub repo.
   Якщо це значення дорівнює base_hash (`base_hash = metadata.getLastSyncCommitSha()`), тоді одразу перестрибуємо на
   обробку (push) локальних комітів.
3. Якщо `remote_head_hash != base_hash`, тоді зчитуємо список змінених за період з base_hash по head_hash файлів на
   сервері у форматі приблизно `{path, sha, size, mtime, mode}`
4. Скануємо чергу комітів (`push_queue/`), порівнюємо SHA файлів з batches з SHA їх REMOTE і BASE версій, і вирішуємо
   що і куди зберігаємо (Vault) чи відправляємо (repo).

Новий алгоритм drain побудовано на таких принципах:

1. push-chaining. Через те що найкраща атомарність, конкурентність, консистентність і надійсність процесу
   pull-push досягається через push-chaining, ми прагнемо використати саме її. Отже, основний сценарій такий:

   a. з сервера зчитуємо значення останнього BranchHead (`last_head_hash = client.getBranchHeadSha()`), отримавши його
      успішно (SUCCESS), використовуємо як базу наших комітів

   b. commit_push йдуть ланцюжком — next_head = commit_push(last_head_hash); if OK: last_head_hash := next_head;
      next_head = commit_push...

   c. якщо якийсь commit_push закінчився невдачею (422 на ref-update, ЗАСТЕРЕЖЕННЯ: tree-422 не сигнал про рух head!),
      це говорить, що хтось інший за час нашої відсутності УСПІШНО змінив last_head. Тоді ми знову зчитуємо значення
      останнього branchHead, знову отримуємо список змін з нашого останнього успішного last_head_hash і намагаємось
      повторити обробку останнього перерваного batch з врахуванням нових отриманих даних, і знову виконати commit_push.

   d. робимо це аж поки в нас не закінчаться batches.

2. під час drain створюємо "поле файлів", що змінюються. Ці файли проходять послідовно через усі commit_push, за потреби,
   трансформуються (успішні diff3, чи обростають конфліктами). І тільки в самому кінці drain, коли ми вже отримали
   остаточну версію кожного файлу, ми знаємо, що з ними робити: зберегти в Vault, видалити з Vault, ігнорувати
   (переважно це локальні зміни), чи зберегти відповідний конфлікт-файл.

3. весь drain вважається одним транзакційним процесом, який повинен завершитись за будь-який кошт, особливо, якщо
   врахувати, що зміни на сервері (і видалення batches з `push_queue/`) відбуваються після кожної обробки окремого
   batch.

Як можна зрозуміти, що в нас має існувати список tracked_files = hashtable<string, TpackedFile>(), щоб ми змогли
обробляти всі файли, які потраплять в наш drain як зі сторони batches (local), та і зі сторони repo (remote).
Однак, тепер розглянемо на прикладі одного файлу весь процес drain з використанням TrackedFile.

TrackedFile зберігає тільки remote/transformed_after_successfull_diff3/conflict files. local files в нього не
потрапляють: вони або одразу ж передаються на сервер (якщо не зустрічають remote конкурентів), або разом з
remote файлом утворюють модифікований diff3-файл, який вже зберігається в TrackedFiles і продовжує проходити по нашому
процесу як самостійний файл, або ініціюють конфлікт, і пушаться в conflict branch замість main, після чого втрачають 
свою важливість.

Отже, все починається зі створення TrackedFile:

a. Знаючи `base_head_hash` і `the_newest_remote_head_hash`, ми можемо отримати список змінених в remote repo файлів. 

b. Саме ці файли й стають нашим списком TrackedFiles на початку drain. TrackedFile створюється з meta-info remote file 
   (файлу, зміненого на сервері) чи з вже існуючого tracked manual conflict sibling файлу (до уваги береться тільки 
   останній файл конлфікту, якщо їх є декілька). 

c. Важливо! TrackedFiles переживають збій (зберігаються після кожного успішно обробленого batch), тому при наповненні
   TrackedFiles meta-info remote files з repo, як вказано в абзаці вище, після відновлення може виявитись, що ці файли
   (з старими, отриманими з repo даними) вже присутні в TrackedFiles. Тоді ці файли замінюються (в відновленому з диску) 
   TrackedFiles залежно від стану, в якому перебуває файл (нормальний чи файл у конфлікті).

d. Наступною особливістю є те, що далі ми скануємо всі файли кожного batches і порівнюємо ці локальні файли з файлами в
   TrackedFiles. Якщо під час обробки окремого batches жодної пари local/remote не було виявлено, TrackedFiles
   залишаються не зміненими й передаються, як по естафеті, на вхід оборобки наступного batch.

e. І так відбувається, аж поки всі бatches не будуть оброблені. Ті файли, які після усіх обробок, залищились в 
   TrackedFiles, накладаються на відповідні файли з Vault, замінюючи їх, або додаючи поруч з ними відповідні 
   conflict-sibling-files.

f. Після закінчення всіх обробок, актуальні дані з TrackedFiles переносяться в metadata.files (§I), а сам TrackedFiles
   видаляється. При цьому незавершені manual conflicts, які були в ньому прописані - переживають завершення drain, і 
   зберігаються на файловій системі, щоб стати базою TrackedFiles на початку наступного drain (b). 


## II.1 _diff3

Насамперед вважаємо, що _diff3() автоматично вирішує такі конфлікти:

1. якщо base=NULL:
   a. _diff3(base=NULL, local=A, remote=NULL) ⇒ A
   b. _diff3(base=NULL, local=NULL, remote=A) ⇒ A
   c. _diff3(base=NULL, local=A, remote=deleted) ⇒ A
   d. _diff3(base=NULL, local=deleted, remote=A) ⇒ A
   e. _diff3(base=NULL, local=A, remote=A) ⇒ A; цей же випадок спрацьовує, коли A і B – deleted одночасно: 
      _diff3(base=NULL, local=deleted, remote=deleted) ⇒ deleted
2. _diff3(base=NULL, local=A, remote=B) ⇒ manual_conflict — справжня колізія: обидва пристрої незалежно створили файл 
   із тим самим шляхом, але різним вмістом, а перевірити, які рядки змінились без base нема можливості.
3. _diff3(base=A, local=A, remote=A) ⇒ A
4. _diff3(base=A, local=A, remote=B) ⇒ B
5. _diff3(base=A, local=B, remote=A) ⇒ B
6. _diff3(base=A, local=B, remote=B) ⇒ B
7. NULL в позиції local чи remote при base!=NULL сприймається, як base:
   a. _diff3(base=A, local=null, remote=null) ⇒ A
   b. _diff3(base=A, local=B, remote=null) ⇒ B
   c. _diff3(base=A, local=null, remote=B) ⇒ B
8. Також в нас діє правило: якщо локальний файл змінився, а віддалений — видалили, тоді перемагає локальний файл. А ось
   навпаки не працює — якщо локальниий файл видалили, а віддалений за цей час змінився — це буде конфлікт, який можна
   вирішити тільки вручну (через conflict-sibling-file та diff2 diff-editor):
   a. _diff3(base=A, local=B, remote=deleted) ⇒ B
   b. _diff3(base=A, local=deleted, remote=B) ⇒ manual conflict
9. виклик diff3 всередині _diff3() залежить також від значення параметра в Settings: maximum_auto_merge_file_size. Якщо
   цей параметр менший за max(filesize) файлів, які порівнюються, тоді diff3 не використовується, а файли одразу ж
   вважаються такими, що знаходяться в manual conflict mode, якщо вони не однакові. Таким чином, фактично,
   `maximum_auto_merge_file_size=0` — вимикає diff3-трансформації взагалі для всіх файлів для тих користувачів, які
   не хочуть автоматичного diff3-merge взагалі, бо хочуть самі контролювати всі зміни файлів.

   **Уточнення (виправляє два TODO з чорнового псевдокоду):** на момент перевірки правила 9 жодна зі сторін НЕ може
   бути DELETED — усі DELETED-комбінації вже повернулись раніше, у правилах 3-8: `remote=DELETED` при
   `local≠base` ловить 8.a, при `local==base` ловить 4 (сентинел `DELETED_SHA_HASH != base.sha`); дзеркально
   `local=DELETED` ловить 8.b або 5; одночасне видалення обох сторін дає рівність сентинелів → правило 3 або 6.
   Отже `local.size`/`remote.size` у правилі 9 завжди визначені, і те саме стосується `local.blob`/`remote.blob`
   нижче за текстом _diff3() — жоден DELETED-файл ніколи не доходить до спроби завантажити його blob.


## II.2 Існує чотири сценарія drain:

1. є remote-зміни, але нема жодних локальних змін (`push_queue/` порожній під час drain, файл у Vault не змінювався з
   попереднього drain). Тоді remote-зміни зберігаються в Vault (замінюють поточний файл) (див. II.5).
2. є локальні зміни (`push_queue/` зберігає N batches). Ці зміни послідовно push в repo, останній push стає бase.
   Vault файл не торкається, незалежно від того, чи змінювався він з попереднього drain чи ні (див. II.4).
3. під час drain є зміни як локальні, так і глобальні. Цей сценарій описано нижче в "II.3 Base Conflict resolving mode".
4. файл на початок drain перебував в конфлікті. Можливо, conflict-sibling-file було вже частково узгоджено з base-file.
   Якщо є кілька tracked conflict-sibling-files, працюємо тільки з останнім з них ("II.6 Manual Conflict resolving
   mode").

Для merge локальних змін з віддаленими використовується 2 алгоритми: один для звичайних файлів, інший для конфліктів.

Для файлів не в конфлікті діє такий алгоритм:


## II.3 Base Conflict resolving mode

```
Якщо при drain маємо один віддалений змінений файл, але в черзі вже накопились кілька локальних змін. Тоді 
merge відібувається за схемою, де "remote" це результат diff3 з попереднього кроку. Коли ж при push отримуємо ERROR422
тоді перезапускаємо осотанній крок, де "remote" знову береться з repo, а не з попереднього кроку:

BASE                      R1
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
C1 ---- (_diff3 OK) ===> D1; push D1 - OK; base=C1; 
   \   (base, C1, R1)    / 
    \                   /
     \                 /
  base\      "remote" / 
       \             /
        \           /
   local \         /
C2 ---- (_diff3 OK) ===> D2; push D2 - OK; base=C2 
   \    (C1, C2, D1)     / 
    \                   /
     \                 /
  base\       "remote"/ 
       \             /
        \           /
   local \         /
C3 ---- (_diff3 OK) ===> D3; push D3 - OK; base=C3; 
   \    (C2, C3, D2)     / 
    \                   /
     \                 /
  base\       "remote"/ 
       \             /
        \           /
   local \         /
C4 ---- (_diff3 OK) ===> D4; push D4 - ERROR422; base залишається C3: перезапуск цього кроку! Забуваємо D4
        (C3, C4, D3)
> 1. спочатку робимо pull і отримуємо нову remote версію файлу - R2;
> 2. перезапуск кроку C4, але замість D4 підставляємо справжній remote file R2:
C3                        R2
   \                     / 
    \                   /
     \                 /
  base\       "remote"/ 
       \             /
        \           /
   local \         /
C4 ---- (_diff3 OK) ===> D4; push D4 - OK; base=C4   <== The LAST BATCH in the drain
   \    (C3, C4, R2)     / 
    \                   /
     \                 /
  base\       "remote"/ 
       \             /
        \           /
         \         /
   
Oстання операція це перенесення змін в Vault. Зміни не переносяться, якщо не було remote змін, або були, але в режимі
manual-conflict mode. Якщо зміни були в режимі manual-conflict mode, тоді в Vault створюється (переноситься з 
TrackedFiles) conflict-sibling-file: 

Vault -- (_diff3 OK) ===> D5; - якщо C4(base) != D4(remote) => Vault = D5; base = D4 (це те що було останнє push)
       (C4, Vault, D4)        - якщо C4(base) == D4(remote) => no changes
                              - якщо файл в manual-conflict mode (_diff3(C4, Vault, D4) = ERROR), тоді 
                                _diff3(C4, Vault, D4) взагалі не робирться, а одразу D4 зберігається як 
                                conflict-sibling-file. 
       
NOTE: Зміни в Vault ідуть, тільки якщо C4 != D4! Бо коли C4==D4, це означає, що remote files не 
було, і ми робили тільки push local (II.2.2) - приклад, чому C4==D4 коли не було remote змін дивись нижче) і файл не в 
manual-conflict mode (тоді зміни торкаються conflict-sibling-file, а не base-file в Vault.
```

Якщо збій відбувся після успішного push (після успішної обробки batch, який складається з однієї операції):
```
BASE                      R1
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
C1 ---- (_diff3 OK) ===> D1; push D1 - OK; base=C1;
<<< ЗБІЙ >>>
```
Ми не встигли записати нові значення, отже BASE залишився той самий, і C1 — також, але
при повтоному PULL ми отримаємо не R1, а D1. То що ми отримаємо?:
```
ПОВТОРНИЙ ЗАПУСК:
BASE                      D1 = _diff3(BASE, C1, R1)
    \                   /   (в D1 вже є C1 і R1 )
     \                 /    
  base\        remote /      
       \             /
        \           /
   local \         /
C1 ---- (_diff3 OK) ===> D1; push D1 робити не потрібно, бо D1 вже в remote; base=C1;
       (base, C1, R1)
``` 
Таким чимон, повторний перезапуск batch тут не приведе до жодних змінн і є допустимим! 



## II.4 Якщо не було remote змін:

```
BASE                      null
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
C1 ---- (_diff3 OK) ===> D1=C1 (він же в даному випадку = C1); push D1 - OK; base=C1; # зауваж: "C1 на вході і C1 на виході"
   \(base,C1,null==base) / 
    \                   /
     \                 /
  base\      "remote" / 
       \             /
        \           /
   local \         /
C2 ---- (_diff3 OK) ===> D2=C2); push D2 - OK; base=C2; # зауваж: "C1 на вході і C1 на виході" 
   \    (C1, C2, C1)     / 
    \                   /
     \                 /
  base\       "remote"/ 
       \             /
        \           /
         \         /
            ...
     local
C_{n} --- (_diff3 OK) ===> D_{n}=C_{n}; push D_{n} - OK; base=C_{n}; # зауваж: "C_{n} на вході і C_{n} на виході"! 
   \(C_{n-1},C_{n},C_{n-1})/ 
    \                     /
     \                   /
  base\         "remote"/ 
       \               /
        \             /
         \           /
Vault - (base==remote) - no changes if C_{n} == D_{n} - (саме через "C_{n} на вході і C_{n} на виході")        

(C_{n}(base)==D_{n}(remote), це означає, що remote files не було, і ми робили тільки push local (II.2.2)
```

Якщо збій відбувся після успішного push (після успішної обробки batch, який складається з однієї операції):
```
BASE                      null
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
C1 ---- (_diff3 OK) ===> D1=C1 (він же в даному випадку = C1); push C1 - OK; base=C1; # зауваж: "C1 на вході і C1 на виході"
    (BASE,C1,null==BASE)
<<< ЗБІЙ >>>
```
Ми не встигли записати нові значення, отже BASE залишився той самий, і C1 — також, але
при повтоному PULL ми отримаємо не null, а C1 з repo. То що ми отримаємо?:
```
ПОВТОРНИЙ ЗАПУСК:
BASE                      C1
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
C1 ---- (_diff3 OK) ===> C1 (він же в даному випадку = C1); push C1 НЕ ПОТРІБНИЙ, бо C1 вже в REPO; base=C1;
        (BASE,C1,C1)
```
Таким чимон, повторний перезапуск batch тут не приведе до жодних змінн і є допустимим!


## II.5 Якщо були тільки remote зміна

Тут не може бути кількох remote змін в одному drain, тому що pull буде тільки один, на початку, а отже нема push і 
нема перезапуску після push по помилці ERROR422. Якщо операція була перервана — починаємо з початку (BASE, pull) 
знову і так, поки не закінчимо цей drain, або поки не з'являться локальні batches, але тоді режим drain зміниться 
на II.3 ("Base Conflict resolving mode") і піде по іншій гілці:

(`push_queue/` порожня):

```
BASE                      R_1
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
null --- (_diff3 OK) ===> D_1 = R_1; (push робити нема потреби, на сервері вже є R_1); base=R_1; 
   \ (base,null=base,R_1)/ 
    \                   /
     \                 /
 base \ BASE   remote / R_1
       \             /
        \           /
 no local\         /
            ... 
 # якщо в результаті повторних пулл, спричинених ERROR422 при обробці інших файлів в commit-batches, з'являться нові 
 # remote версії даного файлу з repo, тоді вони просто безумовно замінюють файл R_1 в TrackedFile
    \                   /
     \                 /
 base \ BASE   remote / R_n
       \             /
        \           /
    local\         /
 null -- (_diff3 OK) ==> D_n = R_n;(push робити нема потреби, на сервері вже є R_n); base=R_n;
   \ (base,null=base,R_n)/
    \                   /
     \                 /
 base \ BASE   remote / R_n
       \             /
        \           /
         \         /
Vault ---  (diff3) ---- якщо Vault == base, тоді перемагає R_n: Vault = R_n;
      (BASE,Vault,R_n)  якщо Vault != base, але diff3 - OK, тоді Vault = diff3(BASE,Vault,R_n);
                        якщо Vault != base, але diff3 - Conflict, тоді:
                          - base = R_n
                          - Vault conflict-sibling-file = R_n з додаванням в список tracked конфліктів цього конфлікту. 
                            conflict branch (на цьому кроці!) створювати не потрібно, і комітити VAULT в нього - також
                            (Vault-файл це не частита batch!). Якщо конфлікт було виявлено тільки при порівнянні з Vault 
                            файлом, а не файлу в batches, тобто, з файлом, який зараз редагується, тоді наявність вже
                            зареєстрованого tracked конфлікту, вже спричинить особливий режим обробки цього файлу в 
                            наступному drain, і тоді ж буде створено conflict_branch, якщо його ще не було створено 
                            раніше.
```

Якщо збій відбувся після успішного push (після успішної обробки batch, який складається з однієї операції):
```
BASE                      R_1
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
null --- (_diff3 OK) ===> D_1 = R_1; (push робити нема потреби, на сервері вже є R_1); base=R_1; 
     (base,null=base,R_1)
<<< ЗБІЙ >>>
```
Ми не встигли записати нові значення, отже BASE залишився той самий, і local null далі (ми перезапускаємо), і
при повтоному PULL ми отримаємо той самий R_1 з repo. То що ми отримаємо?:
```
ПОВТОРНИЙ ЗАПУСК:
BASE                      R_1
    \                   /
     \                 /
  base\        remote / 
       \             /
        \           /
   local \         /
null --- (_diff3 OK) ===> R_1; (push робити нема потреби, на сервері вже є R_1); base=R_1; 
     (base,null=base,R_1)
```
Отримаємо той самий результат, як і звичайно.


## II.6 Manual Conflict resolving mode

Тут є два випадки:

1. manual conflict виникає всередині інших сценарію II.3 ("Base Conflict resolving mode")
2. drain для даного файлу вже починається з manual conflict. Другий режим відрізняється тільки тим, що вже на початок
   drain ми знаємо, в якому режимі знаходиться файл і продовжуємо підтримувати цей режим аж до кроку "Vault step"

```
# що відібувається, якщо _diff3 закінчується помилкою, а не OK?
# Зауваження: для випадку 2 вже на початку drain ми знаємо режим файлу і обробляємо його одразу з STEP2. 
  base, conflict_base беремо з persistence metadata, факт що файл в tracked manual conflict mode - з persistance 
  tracked conflicts list:

*STEP1*. Як виникає manual conflict: 

 C_{n-1}                      R_{m}
      \                       /
       \                     /
    base\           "remote"/ 
         \                 /
          \               /
     local \             /
C_{n} ---- (_diff3 ERROR) ===> Manual conflict: 1. conflicts.set(path, {conflictBase: C_{n}, siblings: []}) — перший
      (C_{n-1}, C_{n}, R_{m})                      запис для цього шляху, siblings — ПОРОЖНІЙ список (§II.6, STEP3 нижче,
                                                     виправлено 2026-08-24): перший елемент з'явиться щойно в
                                                     STEP3 (нижче). `siblings` — це список УСІХ tracked
                                                     conflict-sibling-файлів для цього шляху, а не одне поле —
                                                     drain може лишати на диску кілька (§II.6, STEP3 нижче);
                |                               2. push C_{n} to conflict branch;
                V                               3. base = R_{m};
                                                4. remote залишається R_{m}  
                                                
*STEP2*. Якщо файл вже знаходиться в manual conflict mode:
# тепер до кінця drain, незалежно скільки ще буде C_{n} і R_{m}:
# 0. current_conflict = conflicts.get(path) - читаємо існуючий запис: STEP1 вже створив його раніше (щойно в цьому drain, або в 
#    попередньому — тоді прийшов через durable conflict-store, §III "restoreTrackedFilesFromDiskOrCreateNewOne"); 
#    саме звідси нижче береться `current_conflict.siblings` (п.2) — сам siblings-список (§II.6, STEP3) тут НЕ читається
#    наново, лише переноситься далі без змін.
# 1. push C_{n} to conflict_branch - всі C_{n} ідуть в confict_branch (якщо тільки послідовно вони не однакові: 
#    тобто C_{n-1} != C_{n}, в цьому випадку C_{n} - ігнорується (пропускається))
# 2. conflicts.set(filepath, {conflictBase: C_{n}, siblings: current_conflict.siblings}) - заміна попередньої conflictBase на нову;
#    siblings-список переноситься БЕЗ ЗМІН (STEP2 його не чіпає — це Vault-half, її оновлює лише STEP3)
# 3. "remote" файл в TrackedFile (D_{*}) безумовно замінюється на найсвіжіший файл з REPO (R_{m}) до кінця drain
# 4. base = R_{m} - якщо був remote, зберігаємо base (в main) рівний йому

 D_{n}                    R_{m+1} 
      \                      / 
       \                    /
    base\          "remote"/ 
         \                /
     local\              /
C_{n} ---- (without _diff3) ===> Manual conflict mode: 1. C_{n} вже в conflict list, тому цей крок пропускаємо;
               |                                       2. push C_{n} to conflict branch;
               |                                       3. base = R_{m}; (так як ми ні з чим не порівнюємо, отже blob(R_{m}) не тягнемо з repo
               |                                          аж до Vault-step (де будемо зберігати конфлікт). Там і будемо тягнути blob!
              ...                                      4. conflicts.set(filepath, {conflictBase: C_{n}, siblings: current_conflict.siblings});  
               |  base (він же R_{last})
               V 
*STEP3* (Vault-step):
0. current_conflict = conflicts.get(path) - той самий запис, що STEP1/STEP2 підтримували для цього
   шляху увесь drain (conflictBase-половина); siblings-список звідси й читає п.1/п.2 нижче.

   **⚠️ ВИПРАВЛЕНО (2026-08-24, критичний перегляд моделі, власник):** `current_conflict.siblings` —
   це СПИСОК (не одне поле) УСІХ tracked conflict-sibling-файлів для цього шляху, які drain
   коли-небудь створив і не видалив. STEP3 щоразу працює лише з ОСТАННІМ (найновішим)
   елементом цього списку; попередні елементи (якщо є) лишаються в списку недоторканими, поки
   користувач не розв'яже їх окремо (§III `process_conflicts()`).
1. цей файл ще не був в конфлікті до початку drain (len(current_conflict.siblings) == 0):
Vault ------- [] -> зберігаємо base (R_{last})) як conflict-sibling-file до C_{*}, 
                    base-file в Vault - НЕ чіпаємо!
                    conflicts.set(file, {conflictBase: current_conflict.conflictBase, siblings: [base]})  
                                                                                    # ЯКЩО список siblinbs БУВ ПОРОЖНІЙ!
2. якщо цей файл вже був в режимі "manual conflict" до початку drain (тобто на момент "Vault step" в локальній файловій
   системі вже присутній previous tracked manual conflict, len(current_conflict.siblings) > 0):
   prev_conflict_sibling_file = last(current_conflict.siblings) - НАЙНОВІШИЙ (останній) елемент списку; як і
   для §III (`previous_sibling = last(current_conflict.siblings)`), тут МУСИТЬ бути вже заповнений `.blob`
   (прочитаний зі sibling-файлу на диску) — інакше _diff3() нижче впаде на LOCAL_FILE_IS_NOT_FOUND_ERROR.
Vault ------- (_diff3(current_conflict.conflictBase, prev_conflict_sibling_file, base) -> D_{conflict}:
                         - OK: 1. видаляємо previous conflict-sibling-file з Vault;
                               2. зберігаємо D_{conflict} як нoвий conflict-sibling-file (timestamp у назві —
                                  R_m.mtime, дата ОСТАННЬОГО remote-коміту, що увійшов у D_{conflict}; див.
                                  примітку нижче), base-file в Vault - НЕ чіпаємо!
                               3. conflicts.set(file, {conflictBase: current_conflict.conflictBase,
                                  siblings: replaceLast(current_conflict.siblings, D_{conflict})})  # ЗАМІНЮЄМО
                                  останній елемент списку — довжина списку та сама
                         - ERROR: 1. залишаємо на файловій системі previous conflict-sibling-file — це
                                     і далі TRACKED елемент списку (НЕ synthetic — за визначенням,
                                     synthetic це файл, якого drain НІКОЛИ не створював; цей — створив):
                                     process_conflicts() зможе дедублікувати його з іншим tracked
                                     елементом пізніше, якщо їхні SHA колись зійдуться (§III прим.);
                                  2. зберігаємо D_{last} як новий conflict-sibling-file (timestamp у назві —
                                     R_m.mtime, ТА САМА дата, що й вище) в Vault, 
                                     base-file в Vault - НЕ чіпаємо;
                                  3. conflicts.set(file, {conflictBase: current_conflict.conflictBase,
                                     siblings: append(current_conflict.siblings, D_{last})})  # ДОДАЄМО новий
                                     елемент у кінець — список росте на один
NOTE! Якщо в Vault-step при спробі витягнути base (R_{last}) blob закінчується з помилкою NOT_FOUND, тоді просто цей
      конфліктний файл не зберігаємо, і скасовуємо manual conflict mode, якщо для даного файлу більше нема інших tracked
      конфліктів. Це дозволить нам при наступному commit+drain знову закомітити цей файл з Vault і він (вірогідно) знову
      стикнеться з змінами на сервері, які призведуть до появи наступного, вже існуючого, conflict-sibling-file!                                     
```

> **Рішення власника (2026-08-23): timestamp у назві sibling-файлу — це ЗАВЖДИ дата remote-файлу
> (`tracked.remote.mtime`, тобто дата коміту на GitHub), НІКОЛИ не "власний"/поточний момент запису
> на диск.** Це стосується ОБОХ гілок STEP3 (OK і ERROR) так само, як і першого виявлення конфлікту
> в не-конфліктній гілці Vault-step (§III) — раніше текст тут (і нижче, у пп.4-6) казав "з власним
> timestamp", що суперечило другому шляху й було виправлено як реальна розбіжність, не стилістика.
> Наслідок для STEP3 "OK": `_diff3()` повертає `D_{conflict}.mtime = null` (§III, `_diff3()` завжди
> ставить `mtime=null` для свіжозлитого результату — "файл не закомічено") — той, хто зберігає
> sibling, мусить явно проставити `tracked.remote.mtime` при записі, а не покладатись на поле D.
Якщо збій відбувся після успішного push (після успішної обробки batch, який складається з однієї операції):
```
*STEP1*. Як виникає manual conflict: 

 C_{n-1}                      R_{m}
      \                       /
       \                     /
    base\           "remote"/ 
         \                 /
          \               /
     local \             /
C_{n} ---- (_diff3 ERROR) ===> Manual conflict: 1. conflicts.set(file, {conflictBase: C_{n}, siblings: []})
      (C_{n-1}, C_{n}, R_{m})                   2. push C_{n} to conflict branch;
                |                               3. base = R_{m};
                V                               4. remote залишається R_{m}  
<<ЗБІЙ>>>
```
Ми не встигли записати нові значення, отже BASE (C_{n-1}) залишився той самий, і local (C_{n}) той самий, і 
при повтоному PULL ми отримаємо той самий R_{m} з repo. То що ми отримаємо? Ми отримаємо той самий конфлікт, який
ми все отримали і запушили в conflict_branch:
```
ПОВТОРНИЙ ЗАПУСК:
STEP1:
 C_{n-1}                      R_{m}
      \                       /
       \                     /
    base\           "remote"/ 
         \                 /
          \               /
     local \             /
C_{n} ---- (_diff3 ERROR) ===> Manual conflict: 1. conflicts.set(file, {conflictBase: C_{n}, siblings: []})  (це в
      (C_{n-1}, C_{n}, R_{m})                      пам'яті, тому так, це потрібно)
                |                               2. push C_{n} to conflict branch;  (ми перевіряємо останній файл в repo 
                |                                   в conflict branch, тому ця дія просто пропускається)
                V                               3. base = R_{m};   (так, це робиться в пам'яті)
                                                4. remote залишається R_{m}  - також
```
Отже, повторний запуск branch в цій ситуації не приводить до інших результатів. STEP2 також дає такий самий висновок.



ВАЖЛИВО! Таким чином, з одного drain може вийти тільки ОДИН НОВИЙ/ЗМІНЕНИЙ conflict-sibling-file (останній
завантажений з repo remote file) для окремого base-file! **Уточнення (2026-08-24):** це НЕ означає, що
sibling для шляху завжди один — `current_conflict.siblings` це список, і старіші елементи, лишені попередніми
drain-ами (§II.6, STEP3, гілка ERROR), фізично лишаються на диску й у списку, доки користувач не
розв'яже кожен окремо. "Один за drain" стосується ЗМІНИ за один прохід (заміна останнього ЧИ додавання
нового), не сукупного розміру списку.
ВАЖЛИВО! поки файл знаходиться в tracked conflict mode, його зміни йдуть не в main-branch, а в conflict-branch,
а main-branch base вказує на останній завантажений conflict-sibling-file. Зміни, внесені в
conflict-sibling-file на сервер НЕ ЙДУТЬ. Вони використовуються тільки для узгодоження base-file з
sibling-file в diff-editor
ВАЖЛИВО! вирішення, яким буде conflict-sibling-file визначається в момент запису в Vault. Ця особливість витікає з того,
що конфлікт-файли ніколи не потрапляють в commit-batches і в push/pull. А отже, під час drain приймаємо (pull)
нові версії remote-file і тільк в самому кінці drain вирішуємо що з ними робити: чи об'єднувати з останнім
(за timestamp) tracked conflict-sibling-file через diff3, видаляємо старий і пишемо новий з датою нового remote-коміту,
чи додаємо ще один conflict-sibling-file до вже існуючого (розрізняються за timestamp). В будь-якому випадку,
після одного drain може з'являтись тільки один conflict-sibling-file для конкретного base-file.

Як реалізовано обробка цього режиму:

1. при вмиканні цього режиму в TrackedFile цей файл помічається як "is_manual_conflict". При цьому сам
   conflict-sibling-file до уваги не береться. Беремо тільки сам режим та файлові BASE.
2. Після чого перший pull додає вміст нового remote файлу в TrackedFile, а всі pull просто ЗАМІЩАЮТЬ безумовно вміст
   цього файлу на нове значення з наступних pull з repo. **Важливо (2026-08-25):** сам `blob` цього вмісту при цьому
   НЕ довантажується — pull-folding несе лише метадані (`sha/size/mtime/mode`). Завантаження відкладене аж до
   Vault-step (п.3-4 нижче) — навіщо якщо файл, можливо, і не дійде до збереження цього drain-у.
3. В останній фазі (Vault) перебираються (for each) всі файли в TrackedFiles, і ті з них, які є в manual conflict
   mode:
   - **якщо `tracked.remote.sha` — `null`** (нема ні свіжого pull цього drain-у, ні щойно народженого конфлікту —
     "простоюючий" лінгеруючий конфлікт), файл цього drain-у просто ПРОПУСКАЄТЬСЯ: нема нового remote-вмісту, який
     можна було б відобразити. Запис лишається як є, наступний drain спробує знову.
   - інакше — довантажуємо `blob` цього remote-вмісту (спершу `.runtime/sync_store/`, якщо нема — з GitHub) і
     зберігаємо як conflict-sibling-file.
4. Якщо conflict-sibling-file вже існує в Vault (`prev_conflict_sibling_file = last(current_conflict.siblings)`, тобто
   `len(current_conflict.siblings) > 0`), тоді робиться `_diff3(conflict_base, prev_conflict_sibling_file, tracked.remote)`
   (спроба замінити останній елемент списку). `conflict_base` тут — те саме, що `current_conflict.conflictBase`;
   довантажується так само (sync_store → GitHub), якщо `blob` ще не на руках, — але, на відміну від
   `tracked.remote`, зазвичай уже локально: поки конфлікт живий, sweep НЕ прибирає його `conflictBase`-blob із
   `.runtime/sync_store/` (SYNC2-FIX.md §12.5.D, рішення 2026-08-25).
5. Якщо спроба п.4 - вдала, тоді новий conflict-sibling-file (timestamp у назві — `tracked.remote.mtime`,
   дата remote-коміту, НЕ момент запису на диск) ЗАМІНЮЄ останній елемент `current_conflict.siblings` (зберігається
   з результатом _diff3 на файловій системі, а старий — видаляється(!); довжина списку не змінюється).
   **⚠️ ВИПРАВЛЕНО (2026-08-26, §II.11):** старий файл видаляється ОСТАННІМ, після того, як новий sibling-файл
   і довговічний (durable) запис про конфлікт уже надійно на диску — не навпаки. Це не стилістична деталь:
   видалення старого файлу ДО durable-запису — і є Finding 1 (крах/мережевий збій між ними лишав durable-запис
   застарілим, а старий доказ уже знищеним, що могло тихо закрити живий конфлікт). Захищено mark-транзакцією
   (§II.11) — оскільки на Obsidian Mobile немає жодного способу примусити fsync (перевірено по реальному коду
   `@capacitor/filesystem`, не за здогадом), надійність тут — не запобігання, а виявлення на наступному читанні
   (size+SHA, той самий принцип, що й `sync_store/`, §II.9) плюс детермінований redo.
6. Якщо спроба п.4 - не вдала (`_diff3` повернув MANUAL_CONFLICT — не вдалось автоматично злити), тоді на файловій
   системі просто зберігається ще один conflict-sibling-file (той самий `tracked.remote.mtime`), який ДОДАЄТЬСЯ
   новим елементом у кінець `current_conflict.siblings` (список росте на один; старий елемент лишається tracked, не
   стає synthetic — §III `process_conflicts()`). Ця гілка (append) НІЧОГО старого не знищує — mark-транзакції
   (§II.11) не потребує, самолікується звичайним redo при повторі (детерміноване ім'я файлу).
7. І після п.5 і в п.6 оновлюємо conflict metadata list (`current_conflict.siblings`) і зберігаємо на файловій
   системі — для п.5 (replace) це durable-персист усередині самої mark-транзакції (§II.11, крок 3), не окрема дія.
8. **Якщо довантаження `blob` (п.3 чи п.4) провалюється мережевою помилкою — увесь drain АБОРТУЄТЬСЯ**
   (2026-08-25, рішення власника, той самий шлях, що й TOKEN_EXPIRED): журнал НЕ видаляється, наступний drain
   повторює весь Vault-step з нуля. Це навмисно НЕ per-file skip — інакше журнал зникав би (кінець епілогу)
   раніше, ніж контент справді потрапив у Vault, і повтор не гарантувався б (Finding #2). **Якщо ж довантаження
   провалюється НЕ мережею, а СПРАВЖНІМ NOT_FOUND** (контенту, на який посилається коміт у conflict-branch, не
   існує на GitHub — за побудовою це майже завжди ознака пошкодження repo, не штатна ситуація) — це відмінна
   від мережевої помилка (retry тут не допоможе), і тому єдина, для якої лишається per-file skip:
   - якщо `current_conflict.siblings` був порожній (п.3, конфлікт ще без жодного sibling-файлу) — це БУВ єдиний
     tracked-запис для цього шляху: файл НЕ зберігаємо, is_manual_conflict СКАСОВУЄМО, запис прибираємо з
     `conflicts`. Наступний `[commit]`/drain перекомітить файл з Vault наново — і, ймовірно, знову зіткнеться зі
     змінами на сервері, породивши новий, вже справний конфлікт.
   - якщо `current_conflict.siblings` НЕ був порожній (п.4) — інших tracked sibling-файлів для цього шляху й так
     вистачає, скасування режиму НЕ відбувається: просто пропускаємо збереження цього drain-у (як і при мережевій
     помилці), попередній sibling-файл лишається недоторканим.

## II.7 Crash-safe запис у conflict-branch — ім'я ПЕРЕД мережею, жива перевірка ЗАМІСТЬ bulk-diff

Чорновий псевдокод (§III) мав дві дірки, обидві навколо того самого: як не створити дублікат-коміт у
conflict-branch після краху.

**Діра 1 — STEP1 (новий конфлікт) не мав перевірки взагалі.** STEP2 (файл, що вже в конфлікті) звіряв
`local.sha` з `conflict_files.get(local.path)` перед пушем; гілка "новий конфлікт" пушила безумовно. Якщо
push уже вдався, а крах стався до запису на диск — рестарт пушить той самий вміст ВДРУГЕ.

**Діра 2 — сама перевірка STEP2 не працює, коли `conflict_hash` на диску ще `null`.** Блоки, що
завантажують `conflict_head_hash`/`conflict_files`, обидва огорнуті в `while conflict_hash != null` —
тобто якщо крах стався ДО того, як `conflict_hash` вперше записали на диск (перший конфлікт цього
пристрою за весь час, або перший після попереднього merge), ці блоки взагалі не виконуються.
`conflict_files` лишається невизначеним, і порівнювати нема з чим — перевірка структурно неможлива, а не
просто пропущена.

**Корінь обох дір один: `conflict_hash`, що лежить на диску, описує СТАН журналу, а не стан GitHub.**
Після краху ці двоє можуть розійтися в обидва боки. Bulk-diff (`getChangedFilesFromGitHubRepo(base=…,
head=…)`) працює тільки коли `base` — це справжня, підтверджена точка в історії гілки; коли
`conflict_hash` ще `null`, такої точки просто нема.

**Рішення — двоскладове:**

1. **Ім'я гілки персистується ДО першого мережевого виклику, що її торкається — не після.** Ім'я
   формується за канонічним шаблоном (`PSEUDO-MERGE-MODE.md §4.3`):
   `github-easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>`. Момент вибору імені й персист
   `conflictBranchName` у drain-журнал (§V, `persistDrainState()`) — ПЕРШИЙ крок, ще ДО спроби
   створити чи запушити гілку. Тоді після краху це ім'я завжди відоме, незалежно від того, чи встиг
   сам push відбутись:
   ```
   # conflictBranchName відновлюється разом із TrackedFiles (§III, restoreTrackedFilesFromDiskOrCreateNewOne)
   if conflictBranchName is null:
       conflictBranchName = buildConflictBranchName(deviceLabel, now())
       persistDrainState()   # ПЕРШИЙ крок, до мережі — журнал (§V), НЕ hot-пара (§2.1 METAFILE-REFACTOR)
   conflict_head_hash = getBranchHeadSha(conflictBranchName)  # null, якщо 404 (ще не створена)
   ```
   Персистований SHA-pointer (`conflict_hash`) на цьому й закінчується — його більше НЕ зберігаємо
   взагалі: `conflictBranchName` повністю його замінює, а `conflict_head_hash` завжди читається
   живим (`getBranchHeadSha`), ніколи з диска. Для ВІДКРИТТЯ гілки після краху достатньо самого
   ІМЕНІ — воно discoverable незалежно від того, чи був колись відомий SHA.

2. **Guard на push у conflict-branch — журнал як швидкий шлях, жива перевірка як crash-safe fallback,
   ЄДИНА функція для STEP1 і STEP2:**
   ```
   def shouldPushToConflictBranch(path, sha, conflicts, conflict_head_hash):
       current_conflict = conflicts.get(path)  # {conflictBase, siblings} — тут читаємо тільки conflictBase-половину
       if current_conflict is not null and current_conflict.conflictBase.sha == sha:
           return false   # журнал ПІДТВЕРДЖУЄ, що це вже там - без мережі
       # журнал не підтверджує: або справді новий вміст, або crash-gap (push відбувся,
       # запис у журнал - ні). Перевіряємо живо, без залежності від conflict_hash:
       if conflict_head_hash is null:
           return true    # гілки ще нема - точно новий push
       live = getContentsMetadataAtRef(path, conflict_head_hash)  # {sha,size} або null (404)
       return live is null or live.sha != sha
   ```
   Дорога (мережевий виклик) гілка спрацьовує лише в рідкісному випадку (перший push шляху АБО
   crash-recovery) — на щасливому шляху журнал відповідає без мережі. Це замінює `conflict_files`
   bulk-diff в обох місцях §III, де він використовувався (STEP1 і STEP2) — окремого механізму для
   "перший конфлікт цього пристрою" більше не треба, `conflict_head_hash is null` покриває його як
   звичайний case, а не спецвипадок.

## II.8 `getBatch()` мусить реалізувати R3b (claim-протокол commit↔drain) — це вже вирішено, не заново

`push_queue/` — спільний ресурс commit і drain: `[commit]` дописує нові батчі в хвіст, поки `getBatch()`
бере найстаріший з голови. Без координації є вікно, де drain читає каталог, який commit ще дописує
(TOCTOU) — це вже було знайдено й розв'язано раніше (SYNC2-FIX.md §6, "R3b"), і новий `getBatch()`
зобов'язаний реалізувати ТОЙ САМИЙ протокол, а не винаходити новий.

**Дві мітки, двофлаговий mutex у стилі Пітерсона:** `.attempted-commit` (ставить commit) і
`.attempted` (ставить drain, наявний `markAttempted`).

```
getBatch():
    dir = oldestBatchDir(push_queue/)     # найстаріший каталог; null, якщо черга порожня
    if dir is null:
        return null

    if exists(dir/.attempted-commit):
        # commit саме зараз консолідує (пише повторно) в цей каталог. Чекаємо, а не пропускаємо —
        # пропуск порушив би I1 (черга не FIFO, якщо перескакувати непорожні каталоги).
        waitWithTimeout(dir, marker=".attempted-commit", pollMs=300, warnAfterMs=5000)
        # після warnAfterMs логуємо попередження "commit не може бути таким довгим" — можлива
        # причина: crash commit-а, лишив мітку. Recovery на старті плагіна вже це лагодить
        # (crash-recovery нижче), тож тут просто чекаємо або виходимо по більшому таймауту.

    markAttempted(dir)                     # ставимо СВІЙ прапорець ПЕРЕД вирішальною перевіркою
    if exists(dir/.attempted-commit):
        # TOCTOU-вікно: commit встиг заклеймити МІЖ нашою першою перевіркою і markAttempted.
        # Пітерсон: обидва прапорці стоять → чекаємо, поки commit звільнить (крок 2/3 його
        # протоколу — консолідувати й зняти, або відступити в НОВИЙ каталог і зняти тут).
        waitWithTimeout(dir, marker=".attempted-commit", pollMs=300, warnAfterMs=5000)

    # Тепер безпечно читати — commit або ще не торкався dir, або вже завершив консолідацію.
    batch = readBatchMetafile(dir)
    if batch is null or batch.corrupted:
        return CRASH_RECOVERY(dir)         # див. нижче — лишений `.attempted-commit` після краху

    return batch
```

**Crash-recovery (лишений `.attempted-commit` після краху commit-а)** — адаптовано з SYNC2-FIX.md §6
(рядки 569-574) під термінологію §12 (`.runtime/sync_store/{sha}`, не старий "cache-dir"):

```
CRASH_RECOVERY(dir):
    if not metafileComplete(dir):
        # metafile взагалі не дописано (крах ДО завершення запису) — консолідація не відбулась
        # атомарно, нема довіри жодному вмісту каталогу.
        rmdir(dir)
        return getBatch()   # наступний каталог (якщо є) або null

    for (path, sha, size) in batch.entries:
        if not existInSyncStore(sha, size):  # §II.9: та сама функція, той самий (sha, size)
                                              # контракт — обрізаний після краху batch-blob тепер
                                              # ловиться тут само (розмір не збігається), а не
                                              # мовчки трактується як "уже на місці"
            # спробувати долатати з живого Vault (той самий принцип, що й §12.6). Size-перед-SHA
            # (§I.2 примітка, SYNC2-FIX.md §12.9): stat дешевий, hash — ні (2 МБ → 6.3 мс,
            # 50 МБ → 107 мс). Розбіжність розміру ОДРАЗУ доводить "ремонт неможливий" — нема
            # сенсу хешувати файл, який і так не підходить за розміром.
            vault_stat = statVaultFile(path)   # {exists, size} — БЕЗ хешування
            if not vault_stat.exists or vault_stat.size != size:
                # розмір розійшовся (або файла нема) — ремонт неможливий, SHA рахувати не треба
                vault_entry = FileInfo(exists=false)
            else:
                # розміри збіглись — це нічого не доводить (§12.9), лише запрошення хешувати:
                vault_entry = readVaultFileInfo(path)   # тепер рахує SHA, бо є сенс
            if vault_entry.exists and vault_entry.sha == sha and vault_entry.size == size:
                copyFileToSyncStore(vault_entry, sha)   # полагоджено
            else:
                # файл з тих пір змінився у Vault, або видалений — ремонт неможливий.
                # detection на наступному commit-циклі підхопить поточний стан САМ (§12.6,
                # та сама еквівалентність "ремонт неможливий ⟺ детекція обов'язково спрацює").
                batch.entries.remove(path)
                atomicWrite(dir/metafile, batch)   # переписуємо БЕЗ цього шляху

    removeMarker(dir/.attempted-commit)
    return batch   # (може бути й порожнім, якщо всі шляхи випали — §11 П11, empty-batch skip)
```

**Чому "drain теж appender" (відкрита прогалина R3b, SYNC2-FIX §6, "≥2 appender-и + 1 claimer") тут НЕ
застосовна.** Та прогалина виникала через Phase B (`synthesizeResolutionSideBatches` — drain сам
дописував синтетичні side-batch-і в `push_queue/` ПОСЕРЕД своєї роботи, ламаючи Пітерсонове
припущення "рівно один appender"). У новому дизайні (§II.6-II.7) конфлікти йдуть напряму в
`conflict_commit` і `conflictBranchName`, НІКОЛИ не через `push_queue/` — drain більше не є
appender-ом ні за яких обставин. Прогалина закрита структурно, не патчем (це саме те, що SYNC2-FIX.md
§12 вже передбачив: "Синтетичні батчі… скасовано, тож відкрита прогалина… закривається окремо").

## II.9 sync_store читання — hash-on-load, а не ім'я-як-доказ

⚠️ §12.1 SYNC2-FIX.md стверджує: "ім'я саме себе доводить: SHA(вміст) == назва файлу. Жодних
додаткових метаданих для перевірки цілісності." Це правда лише ЗА УМОВИ, що запис завжди
завершується повністю — а на мобільній файловій системі це не гарантовано навіть із
temp+rename: метадані (розмір, факт rename) можуть журналюватись РАНІШЕ за самі байти даних,
тож після раптового power-loss файл здатен мати **правильний розмір і сміттєвий вміст
усередині**. Через Obsidian vault-adapter fsync ми не контролюємо — отже єдина жорстка
гарантія: хешувати САМІ байти, які підуть у diff3/push, у момент, коли вони й так завантажуються
в пам'ять (blob уже читається цілком для `_diff3()` — стрімінгу тут ніде немає).

**Триступенева перевірка, найдешевша спочатку:**

```
getBlobFromSyncStore(sha, size):
    if sha in verified_shas:             # per-drain in-memory Set — уже пройшов hash цього
                                          # запуску (типовий випадок "ours став theirs", §12.2:
                                          # той самий blob читається десятки разів за один drain)
        return readBytes(sync_store/{sha})   # довіряємо: вміст за цим іменем не змінюється
                                              # заднім числом (content-addressed)
    
    stat = statFile(sync_store/{sha})
    if stat is null:
        return null                      # немає взагалі — не помилка, звичайний cache miss
    if stat.size != size:
        # §12.9 fast-fail: НЕ тягнемо у RAM файл, довжина якого вже суперечить очікуваній.
        # Побитий (обрізаний після краху посеред запису) — найімовірніша причина.
        logWarning("sync_store: розмір не збігається з очікуваним — вважаємо биту копію", sha, stat.size, size)
        return null
    
    bytes = readBytes(sync_store/{sha})    # читаємо — розмір уже дешево підтверджено
    if getSha(bytes) != sha:               # у cpu-worker, як і всі SHA в цьому проєкті
        # Розмір міг збігтись випадково (power-loss без fsync лишає ПРАВИЛЬНУ довжину і
        # сміттєвий вміст — саме той випадок, який крок вище пропускає, а цей ловить).
        logWarning("sync_store: SHA не збігається після зчитування — бита копія", sha)
        return null
    
    verified_shas.add(sha)                 # хешувати цей SHA цього drain більше не треба
    return bytes
```

`verified_shas = new Set()` оголошується там само, де інший drain-scoped стан (поруч із
`TrackedFiles`, на самому старті `drain()`) — живе рівно один запуск drain, не персистується
(наступний запуск перевіряє наново — дешево, бо стосується лише файлів, які реально читаються).

**Виявлення уніфіковане, ВІДНОВЛЕННЯ — ні (§12.3, дві породи):**

- **`remote`/`base` (recoverable мережею):** `getBlobFromSyncStore` повертає `null` однаково і на
  "нема файлу", і на "є, але битий" — виклику навколо (§II.1, рядки ~845-885) це вже байдуже,
  обидва випадки однаково падають у `getBlobFromRepo()`. Жодної зміни в логіці виклику не
  потрібно — вона вже так написана.
- **`local` (unrecoverable з мережі):** той самий `null` підхоплюється вже наявним vault-repair
  (§III, "спробуємо його відновити з Vault" — той самий §12.6 рецепт: `SHA(Vault[path]) == sha`
  ⇒ полагоджено, інакше — шлях просто не їде цього разу). Якщо колись хтось спробує "просто
  перекачати" і для цієї породи — це мовчазна дірка: локальний вміст існує ЛИШЕ тут, з мережі
  його нема звідки взяти (§12.3). Записано тут явно, щоб не переплутати породи при реалізації.

**`existInSyncStore(sha, size)` — НАВМИСНО лишається дешевим (лише stat+size, без хешу).**
Викликається лише там, де ми ВЖЕ тримаємо в пам'яті підтверджено правильні байти (щойно
скачані з repo, або щойно змерджені diff3) і вирішуємо, чи писати їх у сховище вдруге (дедуп,
§12.2). Якщо існуюча копія там насправді бита з тим самим розміром — не біда: НАСТУПНЕ читання
цього SHA (`getBlobFromSyncStore`) все одно проганяє повний hash-on-load і саме тоді виявить і
повідомить биту копію. Повна перевірка тут нічого б не змінила (ми й так уже маємо правильні
байти в руках) — лише витратила б CPU на хеш, чий результат ніхто не використає.

**`saveBlobToSyncStore` пише напряму (`open` → `write` → `close`), БЕЗ temp+rename.**
Content-addressed сховище ніколи не переписує ІНШИЙ вміст під тим самим іменем (колізія SHA —
окрема, криптографічно нехтувана, проблема) — отже "хто записав останнім" завжди нешкідливо, з
rename-атомарністю чи без. ⚠️ Паралельна SHA-колізія (два шляхи одного batch з ідентичним
вмістом, обидва не знаходять blob і обидва вантажать) — сценарій із ранішої чернетки паралелізму;
per-file обробка тепер послідовна (§VI.2, рішення власника 2026-08-23), тому цей сценарій
структурно неможливий: другий шлях з тим самим SHA застає результат першого вже в сховищі.

## II.10 Мережеві ретраї — один хелпер, не п'ять різних `continue then return e`

⚠️ Чорновий псевдокод у п'яти місцях (§III: MAIN head, Compare API, CONFLICT head, MAIN push,
CONFLICT push) писав `continue then return e` у `catch e: NETWORK_ERROR` — це не виконувана
конструкція (не може одночасно й `continue`, й `return`), а нерозгорнутий коментар "повторити
кілька разів зі збільшенням інтервалу, а потім повернути помилку" — без лічильника, без
backoff-формули, без межі повторів. Той самий клас бага, що й нещодавно закритий unbounded
422-retry (§III, "422-CAP"), тільки для NETWORK_ERROR він досі відкритий, і відкритий у п'яти
місцях одразу, а не в одному.

**Один хелпер замість п'яти копій:**

```
def retryOnNetworkError(op):  # op: () -> result; може кинути TOKEN_EXPIRED / NETWORK_ERROR / ERROR422 / ...
                              # Повертає (result, error) — error=null при успіху.
                              # Ретраїть З BACKOFF ЛИШЕ NETWORK_ERROR. Будь-яка ІНША помилка
                              # (TOKEN_EXPIRED, ERROR422, ...) повертається одразу, без спроби
                              # повтору — шар, що відповідає за конкретно ЦЮ помилку (422-CAP,
                              # TOKEN_EXPIRED-мітка), лишається зовнішнім і незмінним.
    MAX_ATTEMPTS = 5      # рішення власника (2026-08-23) — той самий порядок величини, що й
                          # error422_count cap
    BASE_DELAY_MS = 1000  # backoff: 1s, 2s, 4s, 8s (2^(спроба-1) × BASE_DELAY_MS); макс ~15с
                          # мовчазного очікування на одну мережеву операцію перед відмовою
    attempt = 0
    while true:
        try:
            result = op()
            markNetworkRecoveredIfNeeded()  # знімає `.runtime/sync_network_error` ОДИН РАЗ за
                                            # весь drain, на ПЕРШОМУ успішному мережевому виклику
                                            # (не на кожному — зайві FS-записи), і НЕ на самому
                                            # старті drain (це збрехало б користувачу "мережа є",
                                            # поки перша ж реальна спроба ще може провалитись)
            return (result, null)
        catch e: NETWORK_ERROR:
            attempt += 1
            if attempt >= MAX_ATTEMPTS:
                writeNetworkErrorMark(e)   # `.runtime/sync_network_error` — причина збою; ribbon-
                                           # іконка sync червона, hint показує причину; в settings,
                                           # секція "GitHub Sync Status" — та сама помилка з
                                           # рекомендацією повторити Sync, коли з'явиться мережа
                return (null, e)
            sleep(BASE_DELAY_MS * 2^(attempt - 1))
        catch e:
            return (null, e)   # TOKEN_EXPIRED, ERROR422 та інше — не турбота цього хелпера
```

**Два стилі виклику на межі (з прикладом кожного):**

- **drain()-стиль** (`return e` до самого drain): 
  ```
  (head_hash, error) = retryOnNetworkError(() => getBranchHeadSha(MAIN))
  if error == TOKEN_EXPIRED:
      saveTokenExpiredMark()
      return error
  if error == NETWORK_ERROR:
      return error   # спроби вичерпано, маркер уже виставлено всередині хелпера
  ```
- **`_diff3()`-стиль** (`(null, error)` — сам _diff3 нічого не пише на диск, лише повертає
  помилку викликачу, який сам вирішує saveTokenExpiredMark()):
  ```
  (remote.blob, error) = retryOnNetworkError(() => getBlobFromRepo(remote.sha))
  if error == TOKEN_EXPIRED:
      return (null, error)
  if error == NETWORK_ERROR:
      return (null, error)
  ```

Усі мережеві сайти у §III (число зростало по ходу цієї сесії — не фіксуємо тут точну кількість,
щоб коментар знову не застарів; перевірка — `grep -c "retryOnNetworkError(()" ` по файлу) і обидва
`getBlobFromRepo` у `_diff3()` (раніше — без жодного ретраю взагалі, перша ж мережева гикавка
одразу падала до викликача) переписані на цей хелпер нижче.

## II.11 Crash-safe заміна conflict-sibling-файлу (STEP3 "replace") — mark-транзакція без fsync

**Знахідка (2026-08-25/26, критичний перегляд разом з advisor і власником).** У STEP3, коли
`_diff3()` успішно змержив попередній sibling-файл із новим remote-вмістом ("replace"-гілка), старий
порядок дій був: `removeFromVault(previous_sibling)` → `saveConflictSiblingFile(merged_sibling)` →
`conflicts.set(..., replaceLast(...))` — де останній крок оновлює **лише пам'ять процесу**;
довговічний (durable) запис про конфлікт пишеться на диск лише в епілозі (§III, крок 2). Якщо
ПІЗНІШЕ, обробляючи ІНШИЙ, непов'язаний tracked-файл у тому самому Vault-step циклі, стається
`NETWORK_ERROR` — весь `drain()` тепер (§II.6 п.8) одразу абортує, епілог не виконується. Диск лишається
в суперечливому стані: старий sibling-файл УЖЕ видалено, новий — записано, а durable-запис про
конфлікт про це нічого не знає. Наступний drain бачить: старого файлу нема → "конфлікт вирішено"
→ якщо це був останній конфлікт — `conflict_branch` тихо мержиться в `main` БЕЗ участі користувача
(I2-клас дефект — саме той, заради недопущення якого й переписується `drain()`).

**Чому це не можна закрити банальним `fsync`.** Перевірено проти реального коду плагінів, якими
Obsidian Mobile фактично пише файли (не за здогадом):
- **Android** (`ionic-team/capacitor-filesystem`, `LegacyFilesystemImplementation.kt`, `writeFile`):
  звичайний `FileOutputStream.write()` + `.close()`, без жодного `fsync`/`getFD().sync()`.
- **iOS** (`ionic-team/ion-ios-filesystem`, `IONFILEManager.swift`, `saveFile`): `Data.write(to:)` /
  `String.write(to:atomically:encoding:)`, без `FileHandle.synchronizeFile()`/`F_FULLFSYNC`.
- **Публічний API `@capacitor/filesystem`** (повний список методів: `checkPermissions`,
  `requestPermissions`, `readFile`, `readFileInChunks`, `writeFile`, `appendFile`, `deleteFile`,
  `mkdir`, `rmdir`, `readdir`, `getUri`, `stat`, `rename`, `copy`, `downloadFile`, listeners) —
  жодного sync/flush-методу чи прапорця немає. Community-плагін Obsidian не може написати власний
  нативний код і не має доступу нижче за цей API — це не забудькуватість, а платформна стеля.
- **Desktop (Node.js)** так само: `fs.writeFile`/`writeFileSync` без явного `fileHandle.sync()` не
  гарантують фізичний запис на диск.
- Наш власний `atomicWriteFile` (`src/sync2/atomic-write.ts`), яким уже написано пів документа
  (hot-metadata, `TrackedFiles`-журнал, `saveConflictSiblingFile`), робить temp+rename — це дає
  **атомарність** (ніколи не побачите "розірваний" вміст файлу), але **не durability**: fsync там
  теж немає. Ризик "правильний розмір, сміттєвий вміст" (уже описаний §II.9 для `sync_store/`)
  теоретично стосується й тут.

**Отже надійність — не через запобігання, а через ВИЯВЛЕННЯ на наступному читанні** (той самий
принцип, що вже прийнятий для `.runtime/sync_store/`, §II.9) **+ явний, детермінований redo**, а не
намагання гарантувати запис. Два незалежні чеки, для двох різних ризиків:

1. **"Чи взагалі відбувся крок 3 (запис metadata)?"** — питання ЧАСУ, не пошкодження, і НЕ рішення
   напрямку відновлення (§II.11, "Рішення власника" нижче — за sibling-driven контрактом воно лише
   підказує, з якого кроку продовжувати). `atomicWriteFile` (temp+rename) структурно не дає
   "розірваного" JSON НАВІТЬ без fsync (rename атомарний на рівні видимості) — тому тут досить
   порівняти GUID-токен мітки з GUID, збереженим У durable conflicts-store
   (`conflicts.lastSiblingTxGuid`), а не годинники (mtime-порівняння цей проєкт уже відкинув для
   схожої задачі — `TrackedFiles`-журнал, SYNC2-METAFILE-REFACTOR.md §2 — ключування на монотонний
   `seq`, не на час, саме через недостатню точність mtime на частині файлових систем).
2. **"Чи вміст нового sibling-файлу справжній, чи сміття?"** — реальний corruption-ризик, той самий
   клас, що вже описаний §II.9. Тут — точно той самий triple-check, що й `getBlobFromSyncStore`:
   `size` спершу (дешево), потім SHA (якщо розмір збігся).

**⚠️ Важлива відмінність від `sync_store/`: sibling-контент НЕ відновлюваний з мережі** (§II.6 —
"на сервер НЕ ЙДУТЬ"). Тому hash-on-load тут може лише ВИЯВИТИ пошкодження, не полагодити.

**Рішення власника (2026-08-26, друга ревізія — sibling-driven контракт, заміняє першу версію
того ж дня, бінарний "metadataOk && newFileOk").** Напрямок відновлення визначає ЛИШЕ цілісність нового sibling-файлу (перевірка 2), НЕ
поточний стан metadata (перевірка 1). Мітка — це інвертована дельта: несе ОБИДВА FileInfo
(`oldSibling` і `newSibling`), тому з неї однаково реконструюється рух в БУДЬ-ЯКИЙ бік — "де зараз
metadata" лише підказує, з якого кроку продовжувати, а не є окремим рішенням:

- **новий sibling-файл валідний (перевірка 2 пройшла)** → накатуємо ВПЕРЕД, продовжуючи транзакцію
  з першого недовершеного кроку (3-5) — байдуже, чи metadata вже нова, чи ще стара. Повний redo
  Vault-step тут НЕ потрібен узагалі.
- **новий sibling-файл битий/відсутній (перевірка 2 провалилась)** → відкочуємось до
  перед-транзакційного стану (реверс кроку 3, прибрати новий файл, unmark). Це відновлює
  КОНСИСТЕНТНІСТЬ, але НЕ саму злуку (fold) свіжої remote-зміни, заради якої STEP3 запускався — той
  fold доллється сам: журнал (`TrackedFiles`) лишається живим (епілог не був досягнутий), тому
  наступний drain природно повторить Vault-step і сам домержить fold для цього шляху. Спеціального
  redo-коду тут не потрібно — це вже наявний механізм, не окрема будова.
  - Якщо старий sibling-файл ФІЗИЧНО ще на диску (звичайний випадок — крок 4 транзакції або не
    виконувався, або щойно був довершений відкатом) — саме так і відбувається.
  - Якщо старого ТЕЖ немає (крах ПІСЛЯ видалення старого, крок 4, + torn новий — без fsync немає
    гарантії порядку durability МІЖ різними файлами) — обидва sibling-файли для цього шляху
    втрачені; `process_conflicts()` (§III, дедуп, сценарій "tracked sibling фізично видалений")
    prune-ить запис із порожнім `siblings`, а наступний STEP3 відбудовує ланцюжок з нуля, з першого
    sibling (`sync_store/`) — деградація (втрата ОДНОГО проміжного sibling-запису), не корупція.

(Детермінований redo — той самий принцип, що вже й так рятує append/first-sibling гілки — обидві
навмисно ЛИШАЮТЬСЯ без цієї транзакції, бо не знищують жодного доказу, самолікуються редо самі по
собі.)

**Мітка — per-подія, самодостатня, не на весь Vault-step-цикл:**

```
mark = {
    guid,                # унікальний токен цієї конкретної спроби (не mtime!)
    path,                 # шлях base-файлу (P)
    oldSibling,           # ПОВНИЙ FileInfo {path, sha, size, mtime, device_label} — потрібен
                          # цілком, не лише ім'я: якщо новий sibling-файл виявиться битим
                          # (перевірка 2 провалилась) — єдина умова відкату за sibling-driven
                          # контрактом — відкат відновлює САМЕ цей об'єкт
    newSibling            # ПОВНИЙ FileInfo щойно змерджованого результату — і для обчислення
                          # імені файлу (buildSiblingFilePath), і для перевірки (2) на відновленні
}
```

Послідовність (лише "replace"-гілка STEP3 — "append" і "перший sibling" НЕ чіпаються, вони й так
безпечні):

```
1. atomicWrite(SIBLING_TX_MARK_PATH, mark)              # ще ДО будь-якого запису sibling-файлу
2. saveConflictSiblingFile(merged_sibling)              # як і зараз, З AtomicWrite (та сама
                                                         # функція, той самий захист, що й для
                                                         # трьох НЕ-транзакційних сайтів — не
                                                         # чіпаємо спільний helper заради economії,
                                                         # яку тут ніхто не просив)
3. conflicts.set(path, {conflictBase, siblings: replaceLast(...)})
   conflicts.lastSiblingTxGuid = guid                    # ОДНЕ нове поле в durable-структурі
   saveConflictsToStore(conflicts)                        # ⚠️ ДУРАБЕЛЬНИЙ КОМІТ ТУТ, не в епілозі —
                                                           # це і закриває саму діру
4. removeFromVault(oldSibling-файл)                      # 404-tolerant
5. deleteSiblingTransactionMark()                         # 404-tolerant
```

**Відновлення — крок 0 самого `process_conflicts()`** (§III), не крок 0 `drain()` — `process_conflicts()`
викликається з 4 різних місць (onload, відкриття diff-panel, вихід з diff-editor, старт drain-у,
§III категорія I сценарій 9), і недокомічений/битий sibling-файл мусить бути прибраний чи підтверджений
ДО того, як БУДЬ-ЯКИЙ з цих 4 сайтів просканує Vault — інакше він протече у скан як synthetic (чи
tracked-на-биту-адресу) для трьох сайтів з чотирьох, які раніше не викликали цю функцію взагалі:

```
mark = readSiblingTransactionMark()
if mark is not null:
    conflicts = loadConflictsFromStore()       # свіжий durable-скан. `AtomicWriteRecovery.sweep()`
                                                # (onload, СТРОГО ДО першого виклику process_conflicts()
                                                # — див. "Залежність від sweep" нижче) уже привів цей
                                                # файл до ОДНОГО консистентного стану (старого або
                                                # нового) — bak/tmp сюди ніколи не долітають
    guidMatches = (conflicts.lastSiblingTxGuid == mark.guid)
    newFileOk = verifySiblingFileIntegrity(mark.newSibling)  # §II.9-стиль: size спершу, потім SHA;
                                                # без мережевого fallback-у. ЄДИНИЙ дискримінатор
                                                # напрямку (рішення власника вище) — guidMatches лише
                                                # підказує, з якого кроку продовжувати
    current = conflicts.get(mark.path)

    if newFileOk:
        # ВПЕРЕД — продовжуємо транзакцію з першого недовершеного кроку:
        if not guidMatches:
            conflicts.set(mark.path, {conflictBase: current.conflictBase,
                siblings: replaceLast(current.siblings, mark.newSibling)})
            conflicts.lastSiblingTxGuid = mark.guid
            saveConflictsToStore(conflicts)    # крок 3 (реконструкція old+мітка→new; НЕ потребує
                                                # tmp-байтів — sweep міг їх уже відкинути, це нормально)
        removeFromVaultIfExists(buildSiblingFilePath(mark.oldSibling.path, mark.oldSibling.mtime,
            mark.oldSibling.device_label))     # крок 4, 404-tolerant — no-op, якщо вже виконано
    else:
        # НАЗАД — відкат до перед-транзакційного стану:
        if guidMatches:
            conflicts.set(mark.path, {conflictBase: current.conflictBase,
                siblings: replaceLast(current.siblings, mark.oldSibling)})
            conflicts.lastSiblingTxGuid = null # ⚠️ ОБОВ'ЯЗКОВО (не опціонально): bak переживає лише
                                                # крахи ВСЕРЕДИНІ самого виклику saveConflictsToStore
                                                # (sweep його не зачищає до return); будь-який крах
                                                # ПІСЛЯ повернення цього виклику — знову НАША
                                                # реконструкція, без цього повторний recovery по тій
                                                # самій мітці тримався б лише на випадковому
                                                # no-op-повторі replaceLast(old→old) — семантика поля
                                                # стає чесною: "guid останньої УСПІШНО закомміченої
                                                # транзакції", а не "останньої спроби"
            saveConflictsToStore(conflicts)    # реверс кроку 3
        removeFromVaultIfExists(buildSiblingFilePath(mark.newSibling.path, mark.newSibling.mtime,
            mark.newSibling.device_label))     # прибрати биту/часткову спробу
        # Старий sibling-файл тут НІЧИМ не займаємо — журнал живий, наступний Vault-step сам
        # домержить fold (чи, якщо старого теж немає, process_conflicts() prune-ить порожній
        # запис і STEP3 відбудує ланцюжок з нуля) — див. "Рішення власника" вище.
    deleteSiblingTransactionMark()
```

`verifySiblingFileIntegrity(fileInfo)` — та сама триступенева перевірка, що й `getBlobFromSyncStore`
(§II.9), застосована до файлу у Vault замість `sync_store/`: `stat` → якщо розмір не збігається,
одразу `false` (дешево); інакше читаємо байти й рахуємо SHA → порівнюємо. Без мережевого fallback-у
(sibling-контент з мережі невідновний) і без `verified_shas`-кешу (ця перевірка виконується щонайбільше
раз на крах, не десятки разів за drain, як для `sync_store/`).

**⚠️ Інваріант форми запису (для ОБОХ напрямків реконструкції).** І накат вперед, і відкат назад
конструюють `conflicts.get(mark.path)` заново лише з двох полів — `{conflictBase, siblings}`. Якщо
schema запису колись виросте (нове поле), ОБИДВА місця (тут і mainline-код STEP3, §III) мовчки
загублять його при будь-якій replace-транзакції — нове поле в схемі є ОБОВ'ЯЗКОВИМ приводом оновити
обидва сайти одночасно, не лише один.

**Залежність від `AtomicWriteRecovery.sweep()` — навмисна, не випадкова.** `saveConflictsToStore`
пише файл під `.runtime/...`, тобто фізично під `<configDir>/plugins/<selfPluginId>/.runtime/...`
(`conflict-store.ts` уже так робить для наявного ConflictStore) — ПОЗА Obsidian-івським
vault-контент-індексом (`getAbstractFileByPath` для такого шляху ніколи не поверне `TFile`).
Це означає `atomicWriteFile` (`src/sync2/atomic-write.ts`) для цього файлу ЗАВЖДИ бере
rename-стратегію (`.sync-tmp`/`.sync-bak`+rename), НІКОЛИ modify-in-place-гілку — **явне припущення,
яке `saveConflictsToStore` мусить зберігати**: один JSON-файл, шлях під `.runtime/`, без TFile.
`AtomicWriteRecovery.sweep()` (генерик, той самий код, що обслуговує всі atomicWriteFile-записи в
проєкті) нормалізує будь-яку осиротілу `.sync-tmp`/`.sync-bak`-пару для ЦЬОГО файлу до ОДНОГО
консистентного стану ще на onload — sweep не знає нічого про нашу транзакцію (не має оракула, щоб
довіряти tmp-байтам без окремого SHA-запису, якого для generic-файлів нема), тому завжди або
довершує (коли live уже присутній) або відкочує на bak (коли live відсутній); ніколи не лишає файл
відсутнім. Наш recovery (вище) після sweep бачить рівно один metadata-файл + мітку + sibling-файли —
bak/tmp самому recovery-коду читати не треба. Це тримається СТРОГО за умови: **sweep запускається
РАНІШЕ, ніж БУДЬ-ЯКИЙ виклик `process_conflicts()` цього сеансу** (onload, до `workspace.onLayoutReady`
— той самий порядок, що вже прийнятий для інших `atomicWriteFile`-споживачів, §sync2-engine.md).

## III. Приблизна реалізація алгоритму

То як це відбувається? Приблизно так:

```pseudocode

# Приблизна структура TrackedFile:
#   FileInfo: {
#      path: string,
#      size: integer,
#      mtime: imteger,  # час коміту, чи останньої модифікації файлу. Використовується для запису timestamp в 
#                       # conflict-sibling-files
#      sha:  string,
#      mode: string (e.g. "deleted"),
#      device_label: string,
#      blob: null|file-from-sync-store  # якщо є blob - беремо його, якщо нема - вантажимо з `sync_store/`,
#                                       # якщо нема в `sync_store/` - вантажимо з repo і зберігаємо тут і в `sync_store/`
#   }
#
#   TrackedFile: {
#      is_manual_conflict: boolean,
#      base: FileInfo, # type:"remote"
#      remote: FileInfo  # type:"remote"        
#   } 

def _diff3(tracked: FileInfo, local: FileInfo):  # return (FileInfo, error) - переможець, чи модифікований файл або помилка 
                                                 #        (error=NETWORK_ERROR | error=TOKEN_EXPIRED | error=MANUAL_CONFLICT)
                                                 
    # 1. якщо base=NULL:
    #    a. _diff3(base=NULL, local=A, remote=NULL) ⇒ A
    #    b. _diff3(base=NULL, local=NULL, remote=A) ⇒ A
    #    c. _diff3(base=NULL, local=A, remote=deleted) ⇒ A
    #    d. _diff3(base=NULL, local=deleted, remote=A) ⇒ A
    #    e. _diff3(base=NULL, local=A, remote=A) ⇒ A; _diff3(base=NULL, local=deleted, remote=deleted) ⇒ deleted
    # 2. _diff3(base=NULL, local=A, remote=B) => MANUAL_CONFLICT
    # 3. _diff3(base=A, local=A, remote=A) => A
    # 4. _diff3(base=A, local=A, remote=B) ⇒ B
    # 5. _diff3(base=A, local=B, remote=A) ⇒ B
    # 6. _diff3(base=A, local=B, remote=B) ⇒ B
    # 7. А також NULL сприймається, як base: 
    #    a. _diff3(base=A, local=null, remote=null) ⇒  A
    #    b. _diff3(base=A, local=B, remote=null) ⇒  B
    #    c. _diff3(base=A, local=null, remote=B) ⇒  B
    # 8. Також в нас діє правило: якщо локальний файл змінився, а віддалений — видалили, тоді перемагає локальний файл. А ось
    #    навпаки не працює — якщо локальниий файл видалили, а віддалений за цей час змінився — це буде конфлікт, який можна
    #    вирішити тільки вручну (через conflict-sibling-file та diff2 diff-editor):
    #    a. _diff3(base=A, local=B, remote=deleted) ⇒ B
    #    b. _diff3(base=A, local=deleted, remote=B) ⇒ MANUAL_CONFLICT
    # 9. виклик diff3 всередині _diff3() залежить також від значення параметра в Settings: maximum_auto_merge_file_size. Якщо
    #    цей параметр менший за max(filesize) файлів, які порівнюються, тоді diff3 не використовується, а файли одразу ж 
    #    вважаються в manual conflict mode, якщо вони не однакові. Таким чином, фактично, 
    #    `maximum_auto_merge_file_size=0` — вимикає diff3-трансформації взагалі для всіх файлів для тих користувачів, які
    #    не хочуть автоматичного merge взагалі, бо хочуть самі контролювати всі зміни файлів.
    if tracked is null:
       base = FileInfo()   # equal to: {path: null, size: null, mtime: null, sha: null, blob: null, mode: null,
                            # device_label: null}. device_label — ⚠️ ДОДАНО (2026-08-25, власник): device, що
                            # породив ЦЕЙ конкретний вміст. Populated LAZILY, не для кожного FileInfo — див.
                            # `getCommitDeviceLabelForPath` нижче й місця виклику (STEP1 нового конфлікту,
                            # pull-folding для ВЖЕ конфліктних шляхів). base/local тут device_label не
                            # використовують узагалі (лише remote-похідні siblings його читають) — лишається
                            # null, нешкідливо.
       remote = FileInfo()
    else:
       base = tracked.base
       remote = tracked.remote   
       
    if local is null:
       local = FileInfo()
       
    if (base.path is not null and local.path is not null and base.path != local.path) or 
       (base.path is not null and remote.path is not null and base.path != remote.path) or
       (local.path is not null and remote.path is not null and local.path != remote.path):
        # path can be or equal or null
        return (null, COMPARE_WRONG_FILES)   
     
    if local.mode == DELETED:
       local.sha = DELETED_SHA_HASH  # усе constant SHA for deleted files if needed
       
    if remote.mode == DELETED:
       remote.sha = DELETED_SHA_HASH # усе constant SHA for deleted files if needed  
       
    if base.sha is null:
       if local.sha is not null and remote.sha is null:                                                   # 1.a
             return (local, null)       
       if local.sha is null and remote.sha is not null:                                                   # 1.b
             return (remote, null)       
       if local.sha is not null and remote.sha is not null and remote.mode == DELETED:                    # 1.c
             return (local, null)       
       if local.sha is not null and local.mode == DELETED and remote.sha is not null:                     # 1.d
             return (remote, null)       
       if local.sha is not null and remote.sha == local.sha:                                              # 1.e
             return (local, null)       
             
       if local.sha is not null and remote.sha is not null and remote.sha != local.sha:                   # 2
             return (null, MANUAL_CONFLICT)   # справжня колізія: обидва створили файл незалежно
    else:   
       if local.sha == base.sha and remote.sha == base.sha:                                               # 3 
             return (base, null)
             
       if remote.sha is not null and local.sha == base.sha and remote.sha != base.sha:                    # 4
             return (remote, null)
             
       if local.sha is not null and base.sha == remote.sha and base.sha != local.sha:                     # 5
             return (local, null)
             
       if local.sha is not null and base.sha != local.sha and remote.sha == local.sha:                    # 6
             # NOTE: припускаємо що remote_mode==DELETED і local_mode==DELETED 
             # дають remote_sha==local_sha. Якщо це не так, тоді потрібно усюди враховувати mode!
             return (local, null)
             
       if local.sha is null and remote.sha is null:                                                       # 7.a
              return (base, null)
       
       if local.sha is not null and local.sha != base.sha and remote.sha is null:                         # 7.b
              return (local, null)    
       
       if local.sha is null and remote.sha is not null and remote.sha != base.sha:                        # 7.c
              return (remote, null)   
       
       if local.sha != base.sha and remote.mode == DELETED:                                               # 8.a
              return (local, null)
              
       if remote.sha != base.sha and local.mode == DELETED:                                               # 8.b
              return (null, MANUAL_CONFLICT)
       
       # ДОВЕДЕННЯ (закриває обидва TODO нижче, рядки з getBlobFromRepo): жодна сторона
       # не може бути DELETED у точці, де ми дісталися правила 9. Вичерпний розбір усіх
       # DELETED-комбінацій, кожна вже повернулась РАНІШЕ:
       #   remote=DELETED, local.sha != base.sha  → зловлено правилом 8.a (return local)
       #   remote=DELETED, local.sha == base.sha  → правило 4 (remote.sha=DELETED_SHA_HASH
       #                                            != base.sha за визначенням сентинела) 
       #   local=DELETED,  remote.sha != base.sha → зловлено правилом 8.b (MANUAL_CONFLICT)
       #   local=DELETED,  remote.sha == base.sha → правило 5 (local.sha=DELETED_SHA_HASH
       #                                            != base.sha, симетрично до 4)
       #   local=DELETED і remote=DELETED одночасно → DELETED_SHA_HASH є однаковим
       #                                            константним сентинелом для обох →
       #                                            local.sha==remote.sha → правило 3 (якщо
       #                                            і base теж DELETED) або правило 6
       # Тому тут local.size і remote.size ГАРАНТОВАНО визначені — жодна сторона не DELETED,
       # а звичайний файл завжди має size. Це не перевірка «про всяк випадок», а assert:
       # порушення цієї умови означає баг у правилах 1-8 вище, не у вхідних даних.
       assert local.size is not null and remote.size is not null
       if settings.maximum_auto_merge_file_size < max(local.size, remote.size):                           # 9
           return (null, MANUAL_CONFLICT)

    if local.blob is null: # вже на цьому рівні local.blob має бути not null, бо він вантажиться в local.blob ще перед
                           # викликом _diff3(), однак, якщо його нема - можемо спробувати знайти в `sync_store/`
                           # (не обов'язково)
        # local.mode=DELETED НЕ МОЖЕ потрапити на цей рівень — доведено вище (правило 9,
        # коментар "ДОВЕДЕННЯ"): усі DELETED-комбінації повертаються ще в правилах 3-8.
        local.blob = getBlobFromSyncStore(local.sha, local.size) # §II.9: null і на "нема файлу",
                                                     # і на "є, але не пройшов hash-on-load" —
                                                     # звідси нижче різниці не видно, і не треба
        if local.blob is null:
           return (null, LOCAL_FILE_IS_NOT_FOUND_ERROR(local.path))
                                                      
    if remote.blob is null:        
        # remote.mode=DELETED НЕ МОЖЕ потрапити на цей рівень — те саме доведення, що й для local вище.
        remote.blob = getBlobFromSyncStore(remote.sha, remote.size) # §II.9 — biту копію (як і
                                                       # відсутню) нижче однаково перекачуємо з repo
        if remote.blob is null:
           # вантажаимо цей блоб з repo i зберігаємо його в `.runtime/sync_store`:
           (remote.blob, error) = retryOnNetworkError(() => getBlobFromRepo(remote.sha)) # §II.10;
                                                              # TODO про параметри закрито: sha
                                                              # достатньо — Git Blobs API
                                                              # content-addressed, шлях не потрібен;
                                                              # owner/repo/token — з конфігурації
           if error == TOKEN_EXPIRED:
               return (null, error)  
               
           if error == NETWORK_ERROR
               return (null, error)                                                
              
           if remote.blob is null:
               return (null, REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR(remote.path))   
              
           if not existInSyncStore(remote.sha, remote.size): # §II.9: дешевий stat+size, без хешу —
                                                              # ми вже тримаємо перевірені байти
               saveBlobToSyncStore(remote)

    if base.blob is null:
        base.blob = getBlobFromSyncStore(base.sha, base.size) # §II.9 — та сама семантика, що й вище
        if base.blob is null:
            # вантажаимо цей блоб з repo i зберігаємо його в `.runtime/sync_store`:
            (base.blob, error) = retryOnNetworkError(() => getBlobFromRepo(base.sha)) # §II.10;
                                                           # той самий TODO, що й для remote.blob
                                                           # вище — закрито: sha достатньо
            if error == TOKEN_EXPIRED:  # той самий контракт, що й вище для remote.blob — без цього
                                        # протухлий токен тут помилково впав би в
                                        # BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR нижче
                return (null, error)
            if error == NETWORK_ERROR:
                return (null, error)                                                
               
            if base.blob is null:
               return (null, BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR(base.path))   
    
            if not existInSyncStore(base.sha, base.size): # §II.9: дешевий stat+size
                saveBlobToSyncStore(base)
                                                                   
    d = diff3(base.blob, local.blob, remote.blob) # call the original diff3()
    if d == ANY_DIFF3_ERROR: 
         return (null, MANUAL_CONFLICT)
    
    # в d знаходиться результат diff3 (blob). Рахуємо його SHA і зберігаємо в кеш, якщо це новий файл:
    d_sha = getSha(d)
    d_file =  FileInfo(
                   path= base.path,  # filename
                   size= len(d),  # filesize — довжина фактичного вмісту diff3-результату
                   mtime= null,      # файл не закомічено і не збережено в Vault
                   sha=  d_sha,
                   mode= ""
                   blob= d )                
    if not existInSyncStore(d_sha, d_file.size): # §II.9: дешевий stat+size — d_file.blob уже в руках
        saveBlobToSyncStore(d_file)
        
    return (d_file, null)


# ==============================================================================================
# Допоміжні функції для sibling-файлів (2026-08-25, розгорнуто з "чорних скриньок" на прохання
# власника — їхній реальний алгоритм НЕ читається з назви: питання не "як прочитати/записати
# файл", а ЯК визначається ІМ'Я/ІДЕНТИЧНІСТЬ sibling-файлу на диску, включно з device_label —
# §III `process_conflicts()`, "TRACKED vs SYNTHETIC" нижче спирається на це визначення).
# ==============================================================================================

def getCommitDeviceLabelForPath(path, atSha):
    # ⚠️ НОВА функція, якої раніше не було в жодному §II — власник підтвердив (2026-08-25) LAZY-
    # стратегію: викликається ЛИШЕ (а) коли файл ЩОЙНО стає manual conflict (STEP1, §III main-
    # loop) і (б) коли pull освіжає remote для шляху, що ВЖЕ manual conflict (§III pull-folding).
    # НІКОЛИ для звичайного (не-конфліктного) remote-файлу — саме так тримається дешевизна
    # (розрахунок витрат — розмова з власником, 2026-08-25): платимо мережею рівно за фактичні
    # конфлікти, не за кожен змінений remote-файл.
    #
    # Contract: "останній коміт, що торкався `path` не пізніше `atSha`" — REST-виклик виду
    # `GET /repos/{owner}/{repo}/commits?path={path}&sha={atSha}&per_page=1` (аналог до вже
    # реального `client.compare()`, src/github/client.ts:708 — того самого класу, просто інший
    # endpoint; Compare API САМ по собі per-file commit не дає, звідси окремий виклик, не
    # розширення `getChangedFilesFromGitHubRepo()`). Повертає масив з ОДНІЄЮ (найновішою) записом
    # {sha, commit: {message, ...}}, або порожній масив, якщо path не існує на atSha (не повинно
    # траплятись тут — викликається лише для path, який щойно підтверджено існуючим на remote).
    (commits, error) = getCommitsForPath(path, atSha, limit=1)
    if error == TOKEN_EXPIRED:
        return (null, TOKEN_EXPIRED)
    if error == NETWORK_ERROR:
        return (null, NETWORK_ERROR)
    if len(commits) == 0:
        return (UNKNOWN_DEVICE_LABEL, null)  # той самий сентинел, що й parseDeviceSuffix
                                              # (src/sync2/commit-message.ts) для комітів без
                                              # розпізнаваного суфіксу — не помилка, просто
                                              # невідомий автор (напр., коміт зроблено НЕ цим
                                              # плагіном, руками на GitHub)
    return (parseDeviceSuffix(commits[0].commit.message), null)  # РЕАЛЬНА, вже написана функція
                                              # (src/sync2/commit-message.ts:157) — той самий
                                              # парсер, що й history-versions.ts вже використовує
                                              # для GithubCommit.message; тут лише нове місце
                                              # виклику, не нова логіка парсингу


def buildSiblingFilePath(basePath, mtime, device_label):
    # Чиста функція — ЄДИНЕ джерело істини для імені sibling-файлу на диску. Викликається і при
    # записі (`saveConflictSiblingFile`), і при читанні (`readSiblingFileFromVault`), і при
    # скануванні (`findConflictSiblingFilesInVault`) — тому зміна формату в одному місці
    # автоматично узгоджена всюди.
    #
    # Конвенція — PSEUDO-MERGE-MODE.md (§4.3, наприклад `idea.conflict-from-Phone-
    # 2026-05-08T15-30-00Z.md`): `<basename>.conflict-from-<device>-<timestamp><ext>`, з тим самим
    # ISO-подібним, filesystem-safe форматом timestamp (двокрапки → дефіси).
    (dir, base, ext) = splitPath(basePath)
    ts = formatTimestampForFilename(mtime)  # "YYYY-MM-DDTHH-mm-ssZ" — той самий формат, що
                                             # PSEUDO-MERGE-MODE.md уже використовує
    label = device_label if device_label is not null else UNKNOWN_DEVICE_LABEL  # захист:
                                             # buildSiblingFilePath НЕ падає на null device_label —
                                             # хоча виклики нижче завжди мають його заповненим
                                             # (STEP1/pull-folding-refresh/Vault-step-born-conflict,
                                             # §III гарантують це ще ДО виклику
                                             # `saveConflictSiblingFile` — усі три сайти народження
                                             # конфлікту мають lazy device_label-fetch), цей fallback
                                             # лишається чистою обороною глибокого рівня, не робочим
                                             # шляхом
    return join(dir, f"{base}.conflict-from-{label}-{ts}{ext}")


def siblingGlobPattern(basePath):
    # Той самий naming-шаблон, що й buildSiblingFilePath вище, але БУДЬ-ЯКИЙ device/timestamp —
    # для сканування (`findConflictSiblingFilesInVault`, крок "synthetic"), а не для конкретного
    # елемента списку.
    (dir, base, ext) = splitPath(basePath)
    return join(dir, f"{base}.conflict-from-*{ext}")


def saveConflictSiblingFile(fileInfo):
    # fileInfo.path — ШЛЯХ BASE-ФАЙЛУ (P), НЕ sibling-файлу (власник, 2026-08-25: "в sibling.path
    # писав би саме path до base.file" — підтверджено; усі виклики нижче в §III передають сюди
    # FileInfo з `.path == P`, включно з `merged_sibling`, що успадковує `.path` від `tracked`
    # через _diff3()). fileInfo.mtime / fileInfo.device_label — те, що йде в ім'я (§II.6 п.5:
    # mtime ЗАВЖДИ tracked.remote.mtime; device_label — той самий принцип, вище). fileInfo.blob —
    # байти вмісту.
    siblingPath = buildSiblingFilePath(fileInfo.path, fileInfo.mtime, fileInfo.device_label)
    atomicWrite(siblingPath, fileInfo.blob)
    # Повертане значення викликачі ІГНОРУЮТЬ — сирий fileInfo (`.path == P`) іде в `siblings`-
    # список без змін (§III, усюди); фактичне ім'я на диску похідне (path+mtime+device_label),
    # рушій ніколи не тримає його окремим полем структури.


def readSiblingFileFromVault(fileInfo):
    # ⚠️ ВИПРАВЛЕНО ЗАРАЗОМ виклик у STEP3 (§III, `previous_sibling.blob = ...`): раніше передавав
    # лише `.path` (== P, вироджено — усі елементи `siblings` мають ОДНАКОВИЙ `.path`, §III
    # `process_conflicts()` "TRACKED vs SYNTHETIC") — функція не могла б визначити, ЯКИЙ саме
    # sibling читати без mtime+device_label. Потрібен ВЕСЬ FileInfo, не сам path.
    siblingPath = buildSiblingFilePath(fileInfo.path, fileInfo.mtime, fileInfo.device_label)
    if not vaultFileExists(siblingPath):
        return null   # той самий клас, що LOCAL_FILE_IS_NOT_FOUND_ERROR нижче за течією —
                       # викликач (STEP3) сам вирішує, що робити
    return readBytes(siblingPath)


def findConflictSiblingFilesInVault(path, siblings):
    # path — шлях BASE-файлу (P). siblings — `current_conflict.siblings`, список ВЖЕ ВІДОМИХ
    # tracked-елементів для цього path (§III `process_conflicts()`, крок 2.1).
    trackedOnDisk = []
    expectedPaths = Set()
    for s in siblings:
        siblingPath = buildSiblingFilePath(path, s.mtime, s.device_label)
        expectedPaths.add(siblingPath)
        if vaultFileExists(siblingPath):
            trackedOnDisk.add(s)  # blob НЕ читаємо тут — лише перевіряємо присутність; SHA-звірка
                                  # (2.2/2.3, §III `process_conflicts()`) читає, коли реально
                                  # потрібно, через readSiblingFileFromVault вище
    # synthetic — ВСІ файли у Vault, що ВИГЛЯДАЮТЬ як sibling для цього path (той самий naming-
    # шаблон, будь-який device/timestamp), але яких нема серед `expectedPaths`:
    synthetic = []
    for candidatePath in globVault(siblingGlobPattern(path)):
        if candidatePath not in expectedPaths:
            synthetic.add(readVaultFileInfo(candidatePath))  # {path, sha, size, mtime} — sha тут
                                              # ПОТРІБЕН одразу (на відміну від trackedOnDisk
                                              # вище): synthetic-елементи звіряються за SHA у
                                              # 2.2/2.3, не мають окремого "довіреного" списку,
                                              # з яким звірятись спершу
    return {trackedOnDisk: trackedOnDisk, synthetic: synthetic}


# ==============================================================================================
# STEP3 "replace"-транзакція — mark-based crash recovery без fsync (§II.11). Захищає ЛИШЕ
# replace-гілку (diff3 OK): вона єдина знищує доказ (видаляє старий sibling-файл) ДО durable-
# запису нового стану. "append"/"перший sibling" тут НЕ проходять — самолікуються редо.
# ==============================================================================================

SIBLING_TX_MARK_PATH = ".runtime/sibling-tx-mark.json"  # один слот — replace-транзакції по
                                                          # конструкції не бувають конкурентними
                                                          # (§VI.2: per-file обробка послідовна)

def writeSiblingTransactionMark(guid, path, oldSibling, newSibling):
    # oldSibling/newSibling — ПОВНІ FileInfo {path, sha, size, mtime, device_label}, не самі
    # імена: відновлення (нижче) або верифікує newSibling за SHA, або відкочує durable-запис на
    # oldSibling цілком — для обох потрібен весь об'єкт, не рядок.
    atomicWrite(SIBLING_TX_MARK_PATH, {guid: guid, path: path, oldSibling: oldSibling, newSibling: newSibling})


def readSiblingTransactionMark():
    if not fileExists(SIBLING_TX_MARK_PATH):
        return null   # звичайний, безкрахів старт — нема що відновлювати
    return readJson(SIBLING_TX_MARK_PATH)


def deleteSiblingTransactionMark():
    removeFileIfExists(SIBLING_TX_MARK_PATH)  # 404-толерантно, той самий патерн, що й
                                               # deleteBranchIfExists/removeBatchDir


def verifySiblingFileIntegrity(fileInfo):
    # §II.9-стиль triple-check (`getBlobFromSyncStore`), застосований до Vault замість
    # `sync_store/` — БЕЗ мережевого fallback-у (sibling-контент з мережі невідновний, §II.6) і
    # БЕЗ verified_shas-кешу (виконується щонайбільше раз на крах, не десятки разів за drain):
    siblingPath = buildSiblingFilePath(fileInfo.path, fileInfo.mtime, fileInfo.device_label)
    stat = statVaultFile(siblingPath)
    if not stat.exists:
        return false
    if stat.size != fileInfo.size:
        return false   # дешевий fail — не читаємо й не хешуємо файл, чий розмір уже не той
    bytes = readBytes(siblingPath)
    return getSha(bytes) == fileInfo.sha


def recoverSiblingTransactionIfNeeded():
    # ⚠️ Викликається В КРОЦІ 0 самого process_conflicts() (§III нижче) — 2026-08-26, друга
    # ревізія: НЕ в drain(), бо process_conflicts() викликається з 4 місць (onload, diff-panel,
    # вихід з diff-editor, старт drain-у), і недокомічений новий sibling-файл мусить бути
    # підтверджений чи прибраний ДО скану БУДЬ-ЯКОГО з чотирьох, інакше протече як synthetic
    # (§II.11). Без параметра (не `conflicts`) — навмисно: `loadConflictsFromStore()` виконуємо
    # лише тоді, коли мітка СПРАВДІ є (рідкісний, крах-related випадок), не на кожному звичайному
    # виклику.
    mark = readSiblingTransactionMark()
    if mark is null:
        return
    conflicts = loadConflictsFromStore()   # свіжий durable-скан. AtomicWriteRecovery.sweep()
                                            # (onload, СТРОГО ДО першого виклику process_conflicts())
                                            # уже привів цей файл до ОДНОГО консистентного стану —
                                            # той самий, що process_conflicts() п.1 зараз же
                                            # довантажить сам
    guidMatches = (conflicts.lastSiblingTxGuid == mark.guid)
    newFileOk = verifySiblingFileIntegrity(mark.newSibling)   # ⚠️ ЄДИНИЙ дискримінатор напрямку
                                            # (§II.11, "рішення власника 2026-08-26, друга
                                            # ревізія") — guidMatches лише підказує, з якого кроку
                                            # продовжувати, НЕ вирішує вперед/назад
    current = conflicts.get(mark.path)

    if newFileOk:
        # ВПЕРЕД — продовжуємо транзакцію з першого недовершеного кроку, БАЙДУЖЕ чи metadata вже
        # нова: повний redo Vault-step тут не потрібен узагалі.
        if not guidMatches:
            conflicts.set(mark.path, {conflictBase: current.conflictBase,
                siblings: replaceLast(current.siblings, mark.newSibling)})
            conflicts.lastSiblingTxGuid = mark.guid
            saveConflictsToStore(conflicts)   # довершує крок 3 (реконструкція old+мітка→new)
        removeFromVaultIfExists(buildSiblingFilePath(mark.oldSibling.path, mark.oldSibling.mtime,
            mark.oldSibling.device_label))    # крок 4, 404-tolerant — no-op, якщо вже виконано
    else:
        # НАЗАД — відкат до перед-транзакційного стану:
        if guidMatches:
            # metadata вже стверджувала новий стан, але сам файл битий/відсутній — відкочуємо
            # durable-запис на старий sibling (undo replaceLast), інакше наступний STEP3 читав би
            # last(siblings) = биту версію й впав би на LOCAL_FILE_IS_NOT_FOUND_ERROR:
            conflicts.set(mark.path, {conflictBase: current.conflictBase,
                siblings: replaceLast(current.siblings, mark.oldSibling)})
            conflicts.lastSiblingTxGuid = null   # ⚠️ ОБОВ'ЯЗКОВО — без цього повторний recovery
                                                  # по тій самій мітці (крах ПОСЕРЕД самого
                                                  # recovery) тримався б лише на випадковому
                                                  # no-op-повторі replaceLast(old→old); з цим полем
                                                  # семантика чесна: "guid останньої УСПІШНО
                                                  # закомміченої транзакції"
            saveConflictsToStore(conflicts)      # реверс кроку 3
        removeFromVaultIfExists(buildSiblingFilePath(mark.newSibling.path, mark.newSibling.mtime,
            mark.newSibling.device_label))  # прибираємо незалежно від того, чи він взагалі
                                             # з'явився, і чи битий — однаково не довіряємо
        # Старий sibling-файл тут НІЧИМ не займаємо. Якщо він фізично ще на диску — журнал живий,
        # наступний Vault-step сам домержить свіжу remote-зміну (fold) для цього шляху; якщо його
        # ТЕЖ немає (крах ПІСЛЯ кроку 4 + torn новий) — process_conflicts() prune-ить порожній
        # запис, STEP3 відбудує ланцюжок з нуля (деградація, не корупція) — §II.11.
    deleteSiblingTransactionMark()


def process_conflicts():
   # ⚠️ КОНТРАКТ (2026-08-24, розширення §V-уніфікації; МОДЕЛЬ ВИПРАВЛЕНА 2026-08-24, критичний
   # перегляд, власник): `conflicts` — Map<path, {conflictBase, siblings: FileInfo[]}>. `siblings`
   # — СПИСОК усіх tracked conflict-sibling-файлів для цього шляху (усе, що коли-небудь створив
   # drain для path і ще не видалено), НЕ одне поле. Ця функція керує ЛИШЕ siblings-половиною
   # кожного запису (вона читається з локальної файлової системи — Vault). conflictBase-половина
   # (те, що запушено в conflict-branch, RECOVERABLE лише мережею — §III STEP1/STEP2) НІКОЛИ не
   # re-derive-иться звідси: FS-скан її фізично не бачить. Кожен запис, що виходить з
   # process_conflicts() з тим самим path, що й на вході, несе БУКВАЛЬНО той самий об'єкт
   # `conflictBase`, що прийшов на вхід у полі ambient `conflicts` — ця функція його лише читає,
   # ніколи не пише.
   # (Без цього контракту §II critical bug: STEP2 читав би сюди чужі дані — sibling FileInfo
   # замість справжнього conflictBase — `assert conflict_base is not null` мовчки ПРОХОДИТЬ
   # (sibling теж not null), а порівняння `conflict_base.sha != local.sha` звіряє не те.)
   #
   # ⚠️ TRACKED vs SYNTHETIC (уточнено 2026-08-24, власник — виправляє попередню, ХИБНУ
   # класифікацію "старий, недопущений elem списку = synthetic"): **tracked** — БУДЬ-ЯКИЙ
   # sibling-файл, який КОЛИ-НЕБУДЬ створив сам drain для цього шляху (є в `current_conflict.siblings`,
   # незалежно від того, найновіший він чи один зі старіших). **synthetic** — файл, схожий за
   # іменем на conflict-sibling-file, якого engine НІКОЛИ не створював (напр. переїхав у синтетик
   # через переміщення файлу поза сумом — §2.3, приклад нижче — а не обов'язково "користувач
   # зробив руками з нуля"). **Резолюція (2.3, SHA(base)==SHA(sibling) → видалити) застосовується
   # ОДНАКОВО до tracked і synthetic — обидва conflict-sibling-файли за формою.** Різниця — ЛИШЕ
   # в тому, що видалення synthetic НІЯК не впливає на закриття `conflict_branch`: той гейт
   # (§III FINALIZE, `len(conflicts) == 0`) зважає ЛИШЕ на tracked-множину (`current_conflict.siblings` для
   # ВСІХ шляхів) — бо тільки tracked коли-небудь пушився в conflict-branch, synthetic — ніколи.
   # Merge conflict_branch → main робиться, коли ДЛЯ ВСІХ шляхів їхні `siblings`-списки стали
   # порожніми — жодного tracked conflict-sibling-файлу не лишилось у системі взагалі.
   #
   # ⚠️ ПОРЯДОК СПИСКУ — НЕСУЧИЙ, не косметика (додано 2026-08-25, разом з advisor).
   # `current_conflict.siblings` — упорядкований за часом ДОДАВАННЯ список (append-order), НЕ множина:
   # `append`/`replaceLast` (§II.6 STEP3) зберігають цей порядок, і `last(current_conflict.siblings)` = "той
   # елемент, з яким STEP3 працює цього drain-у" — рівно ТОМУ, що він додався останнім. Реалізація
   # НЕ сміє замінити список на Set чи пересортувати його — STEP3 зламається мовчки (почне мерджити
   # не той елемент). "Найновіший за append-order" тут ЗАВЖДИ збігається з "найновіший за
   # `mtime`/timestamp" (§II.6, timestamp у назві — дата remote-коміту), бо append відбувається
   # рівно тоді, коли з'являється новіший `tracked.remote.mtime`, і ніколи заднім числом — окрема
   # `newestByTimestamp` у 2.2 (дедуп) це та сама, не РІЗНА концепція "найновішого", застосована
   # там, де append-order ще недоступний (dedup порівнює й synthetic-файли, яких у списку нема
   # взагалі, тож звірятись доводиться за timestamp, не за позицією).
   #
   # 1. ЯКЩО `conflicts` ЩЕ НЕ ЗАВАНТАЖЕНО цього drain-у (null — перший прохід), довантажуємо
   #    durable-копію (`loadConflictsFromStore()` — та сама домівка, куди епілог пише
   #    `saveConflictsToStore`, §epilogue крок 2).
   #
   # ⚠️ ВИПРАВЛЕНО (2026-08-25, разом з advisor, знайдено при перевірці §III "на щось пропущене"):
   # раніше тут була перевірка `if conflicts is empty:` — порожня Map і "ще не завантажено" були
   # НЕРОЗРІЗНЕННІ, той самий клас бага, що й Finding A (§2.4 нижче, "стан ≠ перехід"). Конкретний
   # провал: STEP3 (§III, NOT_FOUND-cancel) видаляє останній запис з ambient `conflicts` — мапа
   # стає `{}`. Якщо це БУВ останній конфлікт, епілог крок 2 (`conflicts = process_conflicts()`)
   # бачив би стару перевірку `is empty` → ІСТИНА → перезаписує щойно спорожнену ambient-мапу
   # СТАРОЮ durable-копією (яка ще МІСТИТЬ щойно скасований запис, бо диск ніхто не оновлював) —
   # скасування воскресає. Наслідок: `len(conflicts)` ніколи не сягає 0 → FINALIZE (гейт `len(conflicts)
   # == 0`, §III нижче) блокується НАЗАВЖДИ для цього шляху, conflict_branch ніколи не мерджиться.
   # Порожня Map тепер — ЛЕГАЛЬНЕ, відмінне від `null` значення ("нема нерозв'язаних конфліктів,
   # і ми це вже знаємо" — не привід перезавантажувати з диска):
   #
   # ⚠️ КРОК 0 (2026-08-26, §II.11, перенесено з drain()): відновлення незавершеної STEP3
   # "replace"-транзакції, якщо є — ДО будь-якого читання/запису `conflicts` нижче. Раніше цей
   # виклик жив лише в drain()'s "крок 0" — але process_conflicts() викликається з 4 місць
   # (onload, diff-panel, вихід з diff-editor, старт drain-у, сценарій 9 нижче), і три з них НЕ
   # проходили через drain() — недокомічений/битий sibling-файл міг протекти у скан цих трьох
   # сайтів як synthetic ДО першого-ж drain-у. Один виклик тут покриває всі 4. Дешево, коли мітки
   # нема (один fileExists, не повний durable-скан) — див. §II.11 для повного алгоритму:
   recoverSiblingTransactionIfNeeded()
   if conflicts is null:
       conflicts = loadConflictsFromStore()

   changed = false
   # 2. Для кожного base-file (кожного `path` в `conflicts`):
   for path, current_conflict in conflicts:
       # 2.1. Скануємо Vault: {trackedOnDisk, synthetic}. trackedOnDisk — підмножина
       #      `current_conflict.siblings`, чиї файли ще фізично є на диску. synthetic — решта файлів, що
       #      виглядають як conflict-sibling-file для цього шляху (той самий naming-шаблон), але
       #      яких НЕМА в `current_conflict.siblings` — справжні "чужі" файли, engine їх не створював.
       found = findConflictSiblingFilesInVault(path, current_conflict.siblings)  # {trackedOnDisk: FileInfo[],
                                                                        # synthetic: FileInfo[]}
       removedTracked = current_conflict.siblings - found.trackedOnDisk   # елементи списку, чийого файлу
                                                                 # вже физично нема (користувач
                                                                 # видалив сам) — прибираємо без
                                                                 # додаткових дій, нічого чистити
       allFound = found.trackedOnDisk + found.synthetic

       # 2.2. дедуп однакових SHA серед УСІХ знайдених sibling-файлів (tracked ∪ synthetic):
       for group in groupBySha(allFound):
           if len(group) > 1:
               # 2.2.1: якщо в групі є БУДЬ-ЯКИЙ tracked-файл — tracked завжди переважає
               #        synthetic (якщо tracked у групі кілька — виживає НАЙНОВІШИЙ tracked,
               #        решта tracked теж видаляються — і з диска, і зі списку);
               # 2.2.2: інакше (група — самі synthetic) — survivor це файл з НАЙНОВІШИМ
               #        timestamp, решту видаляємо з файлової системи (вони НЕ в
               #        current_conflict.siblings, тож зі списку прибирати нема чого):
               trackedInGroup = [f for f in group if f in found.trackedOnDisk]
               survivor = len(trackedInGroup) > 0 ? newestByTimestamp(trackedInGroup) : newestByTimestamp(group)
               for dup in group:
                   if dup != survivor:
                       removeFromVault(dup)
                       if dup in found.trackedOnDisk:
                           removedTracked.add(dup)

       # 2.3. По-елементна резолюція проти base-file — ОДНАКОВА для tracked і synthetic (уточнено
       #      2026-08-25, власник). Обидва — conflict-sibling-файли ЗА ФОРМОЮ; різниця (tracked
       #      vs synthetic) стосується ЛИШЕ гейта conflict_branch (§III FINALIZE дивиться тільки
       #      на current_conflict.siblings), НЕ права на резолюцію. Приклад, чому synthetic ТЕЖ реальний
       #      незакритий конфлікт: користувач переносить base-file РАЗОМ з його tracked
       #      sibling-файлом в інший каталог (звичайна файлова дія, поза сумом). За СТАРИМ шляхом
       #      конфлікт закривається (обидва файли зникли — §2.1, вони підуть у `removedTracked`
       #      як фізично відсутні). За НОВИМ шляхом з'являється пара "new base-file + sibling-файл
       #      до нього", яка вже НЕ прив'язана до жодного `conflicts`-запису (synthetic — просто
       #      тому, що шлях інший, `conflicts` ключується по path) — але це СЕМАНТИЧНО той самий,
       #      ще не розв'язаний конфлікт, і резолюція (SHA(base)==SHA(sibling) → видалити sibling)
       #      мусить спрацювати для нього так само, як і для tracked:
       base_exists = vaultFileExists(path)
       baseHash = base_exists ? hashOfVaultFile(path) : null
       if base_exists:
           for entry in found.trackedOnDisk:
               if entry in removedTracked: continue
               if baseHash == entry.sha:
                   removeFromVault(entry)
                   removedTracked.add(entry)
           for entry in found.synthetic:
               # synthetic НІКОЛИ не був у current_conflict.siblings — тут лише видаляємо файл з диска,
               # жодного бухгалтерського обліку в списку не потрібно (наступний скан Vault
               # просто більше його не знайде). НЕ впливає на len(newSiblings) нижче і, отже, НЕ
               # впливає на conflicts.delete(path)/гейт conflict_branch — так само, як і решта
               # дій над synthetic (контракт "TRACKED vs SYNTHETIC" вище).
               if baseHash == entry.sha:
                   removeFromVault(entry)

       # 2.4. новий siblings-список — старий мінус усе розв'язане цим проходом (2.1 фізична
       #      відсутність, 2.2 дедуп, 2.3 збіг з base). Запис видаляємо ЛИШЕ на ПЕРЕХОДІ
       #      непорожній→порожній ЦИМ проходом (`len(current_conflict.siblings) > 0`, а не просто
       #      `len(newSiblings) == 0`) — інакше свіжий запис від STEP1 (siblings=[], конфлікт
       #      щойно виник, STEP3 ще не дійшов до нього в ЦЬОМУ drain) видалявся б щоразу, коли
       #      process_conflicts() викликається на ambient `conflicts` mid-drain (кожен 422-рестарт,
       #      §III `drain()`, блок "restart_batch", коментар "перший крок") — REGRESSION (виправлено 2026-08-25,
       #      знайдено разом з advisor): порожній список при вході ЄДИНО можливий якраз як "STEP1
       #      уже спрацював, STEP3 ще ні" (STEP1 — ЄДИНИЙ writer `siblings: []`; і Vault-step-born
       #      конфлікт, і STEP3 п.1 пишуть список з ОДНОГО елемента, ніколи порожній) — це
       #      легітимний, транзиентний стан, який МУСИТЬ блокувати FINALIZE, а не занулюватись.
       #      Якщо список НЕ спорожнів — зберігаємо звужений; conflictBase торкатись не можна
       #      (контракт вище):
       newSiblings = current_conflict.siblings - removedTracked
       if len(current_conflict.siblings) > 0 and len(newSiblings) == 0:
           conflicts.delete(path)
           changed = true
       else if newSiblings != current_conflict.siblings:
           conflicts.set(path, {conflictBase: current_conflict.conflictBase, siblings: newSiblings})
           changed = true

   # 3. Якщо щось змінилось — зберігаємо на диск (AtomicWrite, §epilogue крок 2 викликає це
   #    ще раз явно; тут — тільки якщо процедуру запущено з ІНШОГО місця, п.a-c нижче):
   if changed:
       saveConflictsToStore(conflicts)

   # ЗАУВАЖЕННЯ: Ця функція запускається в кількох місцях:
   #              a. при старті plugin (щоб отримати актуальне значення tracked conflicts в ribbon conflict badge).
   #                 саме тут виконується п.1 - завантаження з файлу 
   #              b. на початку кожного виклику diff-panel, щоб отримати актуальний список всіх tracked conflict-files в
   #                 conflicts tab (synthenic до решти НЕ TRACKED(!) файлів, довантажаться ОКРЕМО в фоновому режимі!)
   #              c. після кожного виходу з diff-editor зі збереженням (<-back). Для оновлення списка конфліктів 
   #                 (можливо конфлікт вже вирішено, і це потрібно зафіксувати) та conflict badge в ribbon
   #              d. на початку drain для коректної обробки файлів в цьому drain, зокрема - tracked conflict files.
   #
   # ЗАУВАЖЕННЯ2: Ця функція не закриває conflict_branch (це робить тільки drain), навіть коли conflict list вже 
   #              порожній!
   return conflicts


def restoreTrackedFilesFromDiskOrCreateNewOne(conflicts):
    # ⚠️ Контракт раніше жив ЛИШЕ в коментарі виклику (§III `drain()`, "перший крок") — сама вимога
    # не змінюється, лише переноситься з прози в явний псевдокод (2026-08-25). Дві незалежні
    # відповідальності в одній функції:
    #   (а) crash-recovery: відновити ping-pong journal (§V), якщо він є;
    #   (б) seeding: для КОЖНОГО шляху з `conflicts` (не лише crash-зачеплених!) гарантувати запис
    #       у TrackedFiles з is_manual_conflict=true — інакше §II.6 п.3 ("для яких є завантажені
    #       remote file з репо") не тримається для lingering (багатоденних, без crash) конфліктів,
    #       чий шлях цього drain-у НЕ з'явився в `remote_files` (§III pull-folding).
    # `conflicts` — параметр, свіжий скан від щойно завершеного process_conflicts() (§III `drain()`,
    # "перший крок") — АВТОРИТЕТНИЙ, використовується як вхід і для (б), і для RECONCILE нижче.

    # --- (а) crash-recovery: ping-pong journal, SYNC2-METAFILE-REFACTOR.md §2 ---
    journal = readNewestValidJournalSlot("tracked-files")  # tracked-files-{a,b}.json, найбільший
                                                             # валідний `seq`; null, якщо обох
                                                             # нема/биті (звичайний, не-crash старт)
    if journal is not null:
        TrackedFiles = journal.trackedFiles
        conflictBranchName = journal.conflictBranchName   # §II.7: персистується в тому ж journal
    else:
        TrackedFiles = {}
        # ⚠️ ВИПРАВЛЕНО (2026-08-25, разом з advisor, знайдено при перевірці §III "на щось
        # пропущене"): раніше тут було безумовне `conflictBranchName = null`. Журнал (і його
        # `conflictBranchName`) видаляється в КІНЦІ КОЖНОГО успішно завершеного drain-у (§epilogue
        # крок 4) — для лінгеруючого конфлікту, що триває вже кілька drain-ів без жодного краху,
        # `journal is null` тут БУДЕ звичайним станом, не ознакою "гілки ще нема". Без цього фолбеку
        # кожен такий (не-crash) drain мінтив би НОВЕ ім'я гілки (§III нижче,
        # `buildConflictBranchName`), лишаючи попередню — вже з запушеним C_n — сиротою: ніхто її
        # більше не бачить, не мерджить, не видаляє. Носій імені МІЖ завершеними drain-ами — саме
        # hot metadata (§epilogue крок 3, `persistHotMetadata({conflictBranch: ...})`), не журнал:
        conflictBranchName = metadata.getConflictBranchName()  # той самий accessor-патерн, що й
                                                                # `metadata.getLastSyncCommitSha()`
                                                                # (§III `drain()`, "перший крок");
                                                                # null, якщо конфліктів справді
                                                                # нема (епілог крок 3 сам пише null
                                                                # за `len(conflicts) == 0`)

    # --- (б) seeding: КОЖЕН шлях з `conflicts` — journal НЕ вважається джерелом істини тут,
    #     навіть якщо він щойно відновив цей самий шлях (див. else-гілку нижче) ---
    for path, current_conflict in conflicts:
        if len(current_conflict.siblings) == 0:
            # ⚠️ ВИПРАВЛЕНО (2026-08-25, власник: "Ти неправомірно вирішив, що можеш вилучати
            # conflict, якщо в нього порожній siblings? Але це ж не так!"). Порожній siblings —
            # ЛЕГІТИМНИЙ, звичайний стан (щойно народжений конфлікт БЕЗ жодного sibling-файлу ще,
            # або лінгеруючий конфлікт, чий Vault-step жодного разу не встиг завершитись) — не
            # привід НЕ seed-ити `is_manual_conflict`. Раніша версія цього блоку помилково
            # прирівнювала "siblings порожній" до "нема з чим седитись" і пропускала seeding, коли
            # `TrackedFiles.get(path)` був null — це й було помилкою, не сам факт порожнього списку.
            #
            # `remote` тут — плейсхолдер (нема `last(siblings)`, з чого брати реальний sha/blob):
            seeded_remote = {path: path, sha: null, size: null, mtime: null, mode: null,
                              device_label: null, blob: null}
            if TrackedFiles.get(path) is null:
                # ⚠️ ВИПРАВЛЕНО (2026-08-25, разом з advisor): `base: seeded_remote`, НЕ `base: null`.
                # STEP2 (§III main-loop) читає `tracked.base.path` ПЕРШИМ рядком — якщо лінгеруючий
                # конфлікт саме такий (siblings=[], seed-нутий тут) отримає локальний edit цього
                # drain-у, STEP2 впаде на `null.path`. Інваріант конфлікт-моду (`tracked.base ==
                # tracked.remote`, §III STEP1, "ТЕРМІНОЛОГІЯ §II.6 ↔ §III") має тримається З
                # МОМЕНТУ SEED-у, не лише після першого проходу STEP3:
                TrackedFiles.set(path, {base: seeded_remote, remote: seeded_remote, is_manual_conflict: true})
            else:
                # Journal ВЖЕ має прогрес цього drain-у для цього шляху — не затираємо:
                TrackedFiles.get(path).is_manual_conflict = true
            # ⚠️ `tracked.remote.sha == null` тут — самолікувальне, НЕ дірка. Три незалежні
            # механізми покривають це:
            #   (1) якщо цей шлях ЦЬОГО drain-у з'явиться в `remote_files` (щось РЕАЛЬНО змінилось
            #       на remote) — pull-folding (§III, "вже tracked" гілка) спрацює безумовно
            #       (`null != file.sha` завжди `true`) і заповнить реальний sha+device_label;
            #   (2) якщо ні — STEP3 (§III, `previous_sibling is null` гілка) сам має явний guard
            #       `if tracked.remote.sha is null: continue` — не намагається зберегти
            #       порожній sibling, просто чекає наступного drain-у;
            #   (3) НЕ пов'язано з колишнім ⚠️ ВІДКРИТЕ ПИТАННЯ при епілозі крок 1 — те питання
            #       ЗАКРИТО (2026-08-25, Finding #2): NETWORK_ERROR у Vault-step тепер УСЮДИ
            #       `return` (як TOKEN_EXPIRED), а не skip, тож стан "R_m відомий, Vault не
            #       оновлено" структурно не виникає. Прапорець тут seed-иться завжди незалежно;
            #       guard (2) вище лишається самодостатньою мережею безпеки для idle-шляхів.
            continue
        last_sibling = last(current_conflict.siblings)
        seeded_remote = {
            path: path,   # ⚠️ ЯВНО `path` (P), а НЕ скопійований з `last_sibling.path` — навіть
                           # якщо вони зараз рівні за побудовою (§III `process_conflicts()`,
                           # "TRACKED vs SYNTHETIC": усі елементи `siblings` мають `.path == P`).
                           # Явна прив'язка тут — щоб дальший код (STEP3,
                           # `conflicts.get(tracked.remote.path)`) не залежав мовчки від цього
                           # збігу.
            sha: last_sibling.sha,
            size: last_sibling.size,
            mtime: last_sibling.mtime,
            mode: last_sibling.mode,
            device_label: last_sibling.device_label,   # ⚠️ ДОДАНО (2026-08-25) — без цього
                           # `buildSiblingFilePath` у STEP3 отримав би null device_label для
                           # lingering-конфлікту, що пережив рестарт/новий drain
            blob: null,
        }
        if TrackedFiles.get(path) is null:
            # Нема в journal (або journal взагалі не було) — свіжий засів. `base: seeded_remote`
            # (той самий фікс, що й вище для порожнього siblings) — STEP2 читає `tracked.base.path`
            # першим рядком, `null.path` там впав би для будь-якого лінгеруючого конфлікту, чий
            # base-файл отримав локальний edit цього drain-у:
            TrackedFiles.set(path, {base: seeded_remote, remote: seeded_remote, is_manual_conflict: true})
        else:
            # Journal ВЖЕ має прогрес цього drain-у для цього шляху (crash ПІСЛЯ STEP2/STEP3 встиг
            # записати щось нове) — journal новіший за durable `conflicts`, не затираємо його
            # base/remote, лише гарантуємо прапорець:
            TrackedFiles.get(path).is_manual_conflict = true

    # --- RECONCILE: конфлікт, розв'язаний користувачем МІЖ drain-ами (вручну, diff-editor) ---
    for path, tracked in TrackedFiles:
        if tracked.is_manual_conflict and conflicts.get(path) is null:
            # `conflicts` тут — вхідний параметр, ДО seeding вище (реальний, авторитетний скан
            # файлової системи) — шляху нема, значить усі tracked siblings зникли (§III
            # `process_conflicts()`, "Merge conflict_branch → main") — користувач вирішив конфлікт
            # сам. ЛЕГІТИМНИЙ випадок (PSEUDO-MERGE-MODE.md Scenario C), не збій:
            tracked.is_manual_conflict = false
            logWarning(f"RECONCILE: {path} conflict resolved externally between drains")

    return (TrackedFiles, conflictBranchName, conflicts)


def drain():
    rearangeSyncStore()   # чистимо `.runtime/sync_store/` від старих файлів (SYNC2-FIX.md, §12.5 (sweep))
                          # це робиться тільки при старті drain, а не в циклі, і ще раз в кінці (після обробки ВСІХ 
                          # batches)
                          
    # Починаємо цикл drain:
    # Один цикл drain приблизно складається з таких кроків:
    #  0. звіряємо tracked-конфлікти з поточним станом Vault (process_conflicts()) — ЩЕ ДО будь-
    #     якого звернення до repo. Це не деталь порядку заради деталі: кожен новий drain (і кожен
    #     restart_batch-рестарт, п.6 нижче) АВТОМАТИЧНО отримує НАЙСВІЖІШИЙ стан усіх TRACKED(!)
    #     conflict-sibling-files як вхідні дані — включно з тими конфліктами, які користувач
    #     розв'язав уручну (в diff-editor) МІЖ drain-ами, поки цей drain ще навіть не почався.
    #     Розв'язання таким чином завжди виграє над рештою кроків: is_manual_conflict скидається
    #     (reconcile, §III нижче) РАНІШЕ, ніж прийдуть будь-які зміни з repo, тому pull-крок (п.1)
    #     вже бачить цей файл як звичайний, не конфліктний.
    #  1. отримуємо змінені файли з repo.
    #  2. беремо перший batch і скануємо по файлам в цьому batch. Коли батчі закінчились ідемо на завершення п.7.
    #  3. порівнюємо файли, модифікуємо їх за потреби (diff3) і формуємо списки на коміти.
    #  4. після обробки всіх файлів з даного batch - пушимо коміти (чому в множині? Бо це можуть бути 2 коміти - в main 
    #     і в conflict branches). 
    #  5. якщо все OK, видаляємо це поточний (перший у списку) batch так, що другий стає першим і знову переходимо до п.2. 
    #  6. якщо push завершився зі збоєм (Error422, хтось інший вже закомітив зміни) переходимо до п.0
    #     (через restart_batch=true, поточний батч не видалено, тому його буде оброблено ще раз з новими даними з repo —
    #     і знову СПОЧАТКУ звірений з найсвіжішим станом Vault-конфліктів, той самий п.0).
    #  7. остаточне порівняння з файлами в Vault (vault step) і збереження змін в valult (base-files і(якщо є) - 
    #     conflict-sibling-files).

    restart_batch = true
    error422_count = 0   # I6: обмежуємо ланцюжок 422-рестартів (§III нижче, коментар "422-CAP")
    while true:                                                            
        if restart_batch:
            #==========================================================================================
            # перший крок - це обробка старих (з попередніх sync) tracked manual conflicts. Відновлення
            # незавершеної STEP3 "replace"-транзакції (§II.11) тепер живе ВСЕРЕДИНІ process_conflicts()
            # самого (2026-08-26, перенесено — покриває всі 4 виклики process_conflicts(), не лише
            # цей), тому окремого виклику тут більше немає.
            #==========================================================================================
            conflicts = process_conflicts() # `conflicts` тут ще не оголошена (перший прохід 
                                                   # цього drain()) → всередині process_conflicts()
                                                   # спрацьовує п.1 (довантаження з durable store) —
                                                   # звідти й приходить conflictBase-половина кожного
                                                   # запису, FS-скан її не чіпає (контракт функції).
                                                   # Може бути порожньою Map, якщо нема нерозв'язаних 
                                                   # tracked manual conflicts. Якщо в цей же час
                                                   # metadata.conflictBranchName != null, значить, що
                                                   # нерозв'язаних tracked manual conflicts вже нема, але
                                                   # conflict_branch ще не merged з main branch (FINALIZE,
                                                   # наприкінці drain, §III)

            #==========================================================================================
            # перевіряємо чи GitHub token expired (файл-мітка). Припиняємо drain з відповідними 
            # повідомленнями про цю ситуацію. - поточний алгоритм обробки даної ситуації повністю 
            # підходить, нічого нового вигадувати не потрібно.
            #==========================================================================================
            if file_mark.token_expired: return TOKEN_EXPIRED          
            
            #==========================================================================================
            # отримуємо commits head hash для MAIN. Для CONFLICT branch персистованого SHA-pointer
            # більше нема (§II.7) — conflictBranchName + жива getBranchHeadSha() замінюють його
            # повністю, читаються нижче, коли треба.
            #==========================================================================================
            base_hash = metadata.getLastSyncCommitSha() 
            if base_hash == null: return NEED_BOOTSTRAP              # треба bootstrap

            #==========================================================================================
            # завантажуємо попередній стабільний стан з файлової системи
            #==========================================================================================
            # ⚠️ `conflicts` тут ПЕРЕПРИСВОЮЄТЬСЯ: зліва — вхід (щойно повернутий свіжий скан ФС
            # від `process_conflicts()`), справа — вихід ТІЄЇ Ж restore-функції (той самий скан,
            # звірений і об'єднаний із відновленим журналом, RECONCILE нижче). Це не помилка й не
            # колізія імен — `conflict_list` і `manual_conflicts` було дві назви ОДНІЄЇ сутності
            # (рішення власника, 2026-08-23: уніфіковано в `conflicts`), і ця присвоєння — просто
            # уточнення значення, той самий патерн, що й `head_hash = new_head_hash` нижче.
            (TrackedFiles, conflictBranchName, conflicts) =
                restoreTrackedFilesFromDiskOrCreateNewOne(conflicts)
                                                                  # Відновлюємо ВЕСЬ drain-журнал з диску (§V, один
                                                                  # ping-pong блоб, persistDrainState()) якщо був
                                                                  # збій, або створюємо порожній стан. ⚠️ Контракт
                                                                  # розширено (2026-08-23): раніше повертав лише
                                                                  # TrackedFiles, тепер — усе, що бандлить
                                                                  # persistDrainState() (§III, "BATCH ОБРОБЛЕНО!").
                                                                  # ⚠️ ВИПРАВЛЕНО (2026-08-24, critical review): ні
                                                                  # head_hash, ні conflict_head_hash СЮДИ НЕ входять
                                                                  # — обидва завжди перечитуються живими нижче
                                                                  # (монотонний guard, SYNC2-FIX §7.10, а не заміна
                                                                  # fetch-у) — §II.7 прямо каже про conflict_head_hash
                                                                  # "більше НЕ зберігаємо взагалі". Раніша версія цього
                                                                  # рядка повертала conflict_head_hash у кортежі, але
                                                                  # жоден код між цим рядком і живим перечитом
                                                                  # (нижче, "Отримуємо SHA найновішої BranchHead для
                                                                  # CONFLICT BRANCH") це значення не використовував —
                                                                  # мертве поле, суперечило власному §II.7.
                                                                  # TrackedFile зберігає інформацію про remote файл
                                                                  # чи трансформований з допомогою diff3 файл: path,
                                                                  # sha, size, type, is_manual_conflict...
                                                                  # принагідно додаємо до них tracked conflicts, які
                                                                  # на файловій системі зберігаються окремо(!)
                                                                  # ⚠️ ДОПОВНЕНО (2026-08-25): для кожного шляху з
                                                                  # `conflicts` переноситься в TrackedFiles ЛИШЕ
                                                                  # ОСТАННІЙ (найновіший) елемент `current_conflict.siblings`
                                                                  # (§II.6 STEP3, `previous_sibling = last(...)`) —
                                                                  # решта (старіші) елементи списку лишаються тільки
                                                                  # в durable `conflicts`, у TrackedFiles не
                                                                  # потрапляють: STEP3 працює з ОДНИМ найновішим за
                                                                  # раз, старіші чекають окремого проходу
                                                                  # process_conflicts()/дій користувача.
                                                                  #
                                                                  # ⚠️ RECONCILE (закриває "ЦЕ НОРМАЛЬНО???" STEP2
                                                                  # і безгардовий сайт STEP3 — один фікс на джерелі,
                                                                  # не два патчі на споживачах): для кожного
                                                                  # tracked.is_manual_conflict==true, чийого шляху
                                                                  # НЕМА у свіжому скані (вхідний параметр цієї
                                                                  # функції, ДО reconciliation — реальний скан
                                                                  # файлової системи, авторитетний), скидаємо
                                                                  # is_manual_conflict=false тут, з гучним логом.
                                                                  # ⚠️ Ця рівність "шляху нема в conflicts ⟺
                                                                  # користувач розв'язав" ТРИМАЄТЬСЯ ЛИШЕ завдяки
                                                                  # фіксу `process_conflicts()` §2.4 (2026-08-25,
                                                                  # знайдено разом з advisor): запис видаляється
                                                                  # ЛИШЕ на переході непорожній→порожній, не просто
                                                                  # коли список порожній ЗАРАЗ — інакше свіжий
                                                                  # STEP1-запис (siblings=[], конфлікт ще не дійшов
                                                                  # до STEP3) мовчки зникав би тут теж, а RECONCILE
                                                                  # хибно скидав би is_manual_conflict для АКТИВНОГО
                                                                  # конфлікту.
                                                                  # Це ЛЕГІТИМНИЙ випадок — користувач вручну
                                                                  # вирішив конфлікт (видалив/змержив sibling) між
                                                                  # drain-ами; трактувати як критичний збій означало
                                                                  # б блокувати drain через штатну дію користувача
                                                                  # (порушення I6). Канон: PSEUDO-MERGE-MODE.md
                                                                  # Scenario C — "конфлікт закритий, коли зникли
                                                                  # ВСІ siblings". Після цього reconcile обидва
                                                                  # споживачі (§III main-loop STEP2 і Vault-step
                                                                  # STEP3, обидва — `if tracked.is_manual_conflict:`)
                                                                  # можуть покладатись на assert, а не на
                                                                  # захисний код: якщо tracked.is_manual_conflict,
                                                                  # то запис у `conflicts` ГАРАНТОВАНО є.
                                                                  
            #==========================================================================================
            # Отримуємо SHA найновішої BranchHead для MAIN BRANCH. `getGuardedHead()`, НЕ сирий
            # `getBranchHeadSha(MAIN)` — та сама функція, що й у FINALIZE нижче: застосовує
            # монотонний guard проти replica-lag (SYNC2-FIX §7.10). ⚠️ ВИПРАВЛЕНО (2026-08-24,
            # critical review): раніше тут була сира `getBranchHeadSha(MAIN)`, хоча коментар при
            # відновленні (вище, "монотонний guard, SYNC2-FIX §7.10") уже стверджував, що guard
            # застосовується саме до цього читання — назва функції суперечила власному коментарю.
            #==========================================================================================
            (head_hash, error) = retryOnNetworkError(() => getGuardedHead())  # §II.10
            if error == TOKEN_EXPIRED:
                saveTokenExpiredMark()
                return error
            if error == NETWORK_ERROR:
                return error   # спроби вичерпано, .runtime/sync_network_error уже виставлено

            #==========================================================================================
            # Отримуємо список змінених з останнього drain файлів в репо MAIN-BRANCH (path, sha, size, type, etc.)
            # §II, крок 2 класичного drain: якщо head_hash == base_hash — remote НЕ змінювався взагалі,
            # відповідь напевно порожня. Пропускаємо мережевий виклик — не лише "теж правильно", а
            # й уникає зайвого запиту (і зайвого шансу вхопити compare-API truncation, §VII.1) там,
            # де відповідь наперед відома.
            #==========================================================================================
            if head_hash == base_hash:
                remote_files = []
            else:
                (remote_files, error) = retryOnNetworkError(() => getChangedFilesFromGitHubRepo(base=base_hash, head=head_hash))  # §II.10
                if error == TOKEN_EXPIRED:
                    saveTokenExpiredMark()
                    return error
                if error == NETWORK_ERROR:
                    return error

            #==========================================================================================
            # Ім'я conflict-branch персистується ДО будь-якого мережевого виклику, що її торкається
            # (§II.7) — тому воно відоме навіть якщо drain ще ЖОДНОГО разу не пушив у цю гілку.
            #==========================================================================================
            # conflictBranchName уже відновлено разом із TrackedFiles вище (restore-крок) — тут
            # лише генеруємо, якщо це СПРАВДІ перший раз для цього drain (жоден попередній batch,
            # ні в цьому запуску, ні в перерваному попередньому, ще не обирав ім'я):
            if conflictBranchName is null:
                conflictBranchName = buildConflictBranchName(deviceLabel, now())
                persistDrainState()  # §III "BATCH ОБРОБЛЕНО!" нижче — ОДИН ping-pong блоб drain-
                                     # журналу (TrackedFiles + conflicts + conflictBranchName — НЕ
                                     # head_hash/conflict_head_hash, обидва завжди живі, §II.7).
                                     # ПЕРШИЙ крок, до мережі
                                     # (§II.7) — раніше тут був окремий atomicWrite ЛИШЕ цього поля,
                                     # що суперечило METAFILE-REFACTOR §1.A (conflictBranch — hot,
                                     # пишеться ping-pong-ом). Мід-drain це ще НЕ підтверджений
                                     # hot-стан (§1.C: хот фіксується лише раз, по завершенню
                                     # ВСЬОГО drain) — це drain-in-progress стан, тому журнал, не
                                     # hot-пара напряму

            #==========================================================================================
            # Отримуємо SHA найновішої BranchHead для CONFLICT BRANCH (null, якщо 404 — гілки ще нема)
            #==========================================================================================
            (conflict_head_hash, error) = retryOnNetworkError(() => getBranchHeadSha(conflictBranchName))  # §II.10
            if error == TOKEN_EXPIRED:
                saveTokenExpiredMark()
                return error
            if error == NETWORK_ERROR:
                return error
            # ПРИМІТКА: bulk-diff conflict_files БІЛЬШЕ НЕ ПОТРІБЕН (§II.7) — STEP1/STEP2 звіряються
            # напряму через shouldPushToConflictBranch(path, sha, conflicts, conflict_head_hash),
            # що падає на живий per-file запит лише коли журнал (conflicts) не підтверджує сам.
                                                            
            #=========================================================================================
            #  Додаємо змінені файли з repo (поки що додаємо тільки {path, sha, size, mode (deleted)}, ознаки 
            #  is_manual_conflict = false, blob = null
            for file in remote_files:
                tracked_file = TrackedFiles[file.path]
                if tracked_file is not null:
                    # На момент pull попередня версія remote file вже присутня в TrackedFiles 
                    # Згідно всіх сценаріїв (II.3-II.6) достатньо просто безумовно замінити remote file на інший:
                    if tracked_file.remote.sha != file.sha:
                        tracked_file.remote.sha=file.sha
                        tracked_file.remote.size=file.size
                        tracked_file.remote.mtime=file.mtime
                        tracked_file.remote.mode=file.mode
                        tracked_file.remote.blob=null  # старий blob залишається на диску, і буде видалений наступний
                                                       # раз при запуску rearangeSyncStore() 
                        if tracked_file.is_manual_conflict:
                            # ⚠️ ДОДАНО (2026-08-25, власник): LAZY device_label — платимо мережею лише за
                            # шляхи, що ВЖЕ в manual conflict mode (§II.6 п.2: "всі pull просто ЗАМІЩАЮТЬ
                            # безумовно" — кожен новий pull під час активного конфлікту міг прийти з ІНШОГО
                            # пристрою, тому освіжаємо разом з рештою remote-half). Для звичайних
                            # (не-конфліктних) файлів тут ЖОДНОГО зайвого запиту — вони взагалі не заходять
                            # у цю гілку `if`, `remote_files` типово містить десятки-сотні файлів, а
                            # конфліктних серед них — рідкісний виняток (порівняно з eager-варіантом:
                            # запит на КОЖЕН змінений remote-файл незалежно від того, чи стане він
                            # конфліктом узагалі).
                            (tracked_file.remote.device_label, error) = retryOnNetworkError(
                                () => getCommitDeviceLabelForPath(file.path, head_hash))  # §II.10
                            if error == TOKEN_EXPIRED:
                                saveTokenExpiredMark()
                                return error
                            if error == NETWORK_ERROR:
                                return error
                else:
                    # додаємо в tracked base-info для нашого remote FileInfo. Якщо цей файл вже є в tracked list, він може 
                    # мати інші, проміжні значення base_sha/base_size (див §II), тому їх завантажувати з metadata.files, 
                    # якщо вони вже існують НЕ МОЖНА:
                    base_path, base_sha, base_size, base_mtime = metadata.files.get(file.path) 
                                                                              # base_file це об'єкт, який тримає дані
                                                                              # про файл: (path, sha, size, mtime). 
                                                                              # Якщо файлу нема в metadata.files, тоді 
                                                                              # повертається (null, null, null, null)
                    TrackedFiles.add({
                        base: { 
                            path: base_path,
                            size: base_size,   # може бути null(!) якщо нема file.path в metadata.files
                            sha: base_sha,     # також може бути null 
                            mtime: base_mtime, # також може бути null 
                            blob: null,
                            mode: ""  # не може бути "deleted" ніколи, бо видалені файли видаляються з metadata.files
                        },
                        remote: {
                           path: file.path,
                           sha=file.sha,
                           size=file.size,
                           mtime=file.mtime
                           mode=file.mode,
                           blob: null
                        }
                        is_manual_conflict=false
                    })  
            #=========================================================================================
             
          
        #============================================================================================   
        # Основний цикл обробки batch
        #============================================================================================   
        restart_batch = false;                         # далі буде використано chaining-push, pull-завантаження не 
                                                       # потрібнe, воно знову буде увімкнено (set to true), тільки коли 
                                                       # push поверне ERROR422 (з'явились нові зміни на сервері)
                                                       
        batch = getBatch()                             # §II.8: реалізує R3b claim-протокол
                                                       # (`.attempted-commit`/`.attempted`) з
                                                       # commit-ом за найстаріший каталог у
                                                       # `push_queue/`, включно з crash-recovery.
                                                       # Метафайли батчів тримають лише {path,sha,
                                                       # size}; самі байти — у `.runtime/sync_store/{sha}`
                                                       # (SYNC2-FIX.md §12). Завжди беремо найстаріший
                                                       # каталог — він зникає з черги лише після
                                                       # повної обробки (позначено "БАТЧ ОБРОБЛЕНО!" нижче).
                                                       
        if batch is null:  # batches закінчились. завершуємо drain (виходимо з while true циклу)
           break                                                
    
        commit = createCommit();                       # створюємо порожній список файлів для коміту в main branch
        conflict_commit = createCommit();              # створюємо порожній список файлів для коміту в conflict branch 
        main_push_tracked = [];                        # tracked-записи, чий .remote щойно замінено на D цього
                                                        # batch і РЕАЛЬНО пушиться в MAIN — mtime їм проставляємо
                                                        # НЕ тут (під час цього for), а нижче, ОДИН РАЗ, одразу
                                                        # після підтвердженого успіху pushCommit() (§III, "mtime
                                                        # інваріант" нижче)
                                                       
        #=========================================================================================    
        # Обробляємо всі файли в поточному batch. Кожний batch обробляється як одна транзакція - або його обробляємо 
        # повністю і видаляємо з `push_queue/`, або наступний раз ми почнемо його обробляти з початку!
        # Саме тому вихід з циклу при помилкці це просто return ERROR, а не якийсь складний destructor.                                                 
        #=========================================================================================    
        for each local in batch:   # структура local (FileInfo): {path, size, sha, mode, device_label=null, blob=null}
            # перевіряємо чи існує в sync_store blob файлу з даного batch (див. SYNC2-FIX, §12)
            if local.mode != DELETED:
                local.blob = getBlobFromSyncStore(local.sha, local.size) # §II.9: null і на "нема
                                                             # файлу", і на "є, але битий" — в обох
                                                             # випадках нижче однаково пробуємо
                                                             # відновити з Vault
                if local.blob is null:
                    # намагаємось його відновити з Vault:
                    vault_file = vault.files.get(local.path)  # повертає {path, size, mtime} або null, якщо файл не  
                                                              # знайдено. Для отримання sha треба викликати getSha()
                                                              # кешується, тому другий виклик (повторний) - дешевий
                    if vault_file is not null and vault_file.size == local.size and vault_file.getSha() == local.sha:
                       local.blob = copyFileFromFSToSyncStore(vault_file.path, vault_file.getSha())
                    else:
                       # якщо цього файлу в Vault вже нема, або він змінився - ігноруємо (SYNC2-FIX.md, §12.5.B)
                       continue;
                   
            tracked = TrackedFiles.get(local.path)
            if tracked == null:
                # додаємо в tracked base-info для нашого local FileInfo. Якщо цей файл вже є в tracked list, він може мати
                # інші, проміжні значення base_sha/base_size (див §II), тому їх завантажувати з metadata.files, якщо вони 
                # вже існують НЕ МОЖНА:
                base_path, base_sha, base_size, base_mtime = metadata.files.get(local.path); 
                                                                            # base_file це об'єкт, який тримає дані про
                                                                            # файл: (path, sha, size, mtime). 
                                                                            # Якщо файлу нема в metadata.files, 
                                                                            # тоді повертається (null,null,null,null)
                tracked = TrackedFiles.add({
                    base: {
                        path=base_path,
                        sha: base_sha,
                        size: base_size,
                        mtime: base_mtime,
                        blob: null,
                    },
                    remote: {
                        path=local.path,
                        size: null,
                        mtime: null,
                        sha: null,
                        mode: null,
                        blob: null
                    },
                    is_manual_conflict=false
                })  
                
            if tracked.is_manual_conflict:   
                # згідно §II.6, STEP2. Reconcile при restoreTrackedFilesFromDiskOrCreateNewOne
                # (§III, блок "restart_batch", коментар "RECONCILE") гарантує: якщо
                # tracked.is_manual_conflict тут true, запис у
                # conflicts ІСНУЄ — випадок "конфлікт розв'язано між drain-ами" уже
                # відфільтровано на джерелі, тут лишається чистий assert, не захисна гілка.
                current_conflict = conflicts.get(tracked.base.path)  # {conflictBase, siblings}
                assert current_conflict is not null
                if current_conflict.conflictBase.sha != local.sha:
                    # §II.7: журнал (conflicts) як швидкий шлях, жива перевірка як
                    # crash-safe fallback — замінює колишній bulk-diff conflict_files.
                    if shouldPushToConflictBranch(local.path, local.sha, conflicts, conflict_head_hash):
                        local.mtime = now()  # час, коли файл покладено в список на конфлікт-коміт.
                                             # ⚠️ Локальний годинник тут НЕШКІДЛИВИЙ, не порушує
                                             # mtime-інваріант §VII.5 (timestamp у назві
                                             # sibling-файлу — ЗАВЖДИ tracked.remote.mtime, ніколи
                                             # conflictBase.mtime): це поле лише інформаційне, ніде
                                             # не читається як sibling-timestamp (§II.6).
                        (savedInRepoBlob, error) = retryOnNetworkError(() => saveBlobToGitHub(local))  # §II.10;
                                                                            # той самий (blob, error)
                                                                            # контракт, що й для MAIN push
                        if error == TOKEN_EXPIRED:
                            saveTokenExpiredMark()
                            return error
                        if error == NETWORK_ERROR:
                            return error
                        conflict_commit.add(savedInRepoBlob)

                    # оновлюємо ЛИШЕ conflictBase-половину запису — siblings-список (§II.6.STEP3
                    # тримає його окремо, він про Vault-контент, не про conflict-branch push)
                    # переносимо БЕЗ змін, інакше цей .set() тихо загубив би весь список:
                    conflicts.set(tracked.base.path, {conflictBase: local, siblings: current_conflict.siblings})

                tracked.base = tracked.remote
                continue # process next file
                
            #=====================================================================================================    
            # Not in manual conflict:
            #=====================================================================================================    
            if tracked.remote.sha is not null and tracked.remote.sha == local.sha: # змін не було: 
                                                                                   # D = (_diff(B, A, A)=A, II.4).
                                                                                   # set base=А; push не потрібний
               # Ще раз наголошую: якщо remote.sha == local.sha, це означає, що їх mode також однакові. якщо не так, 
               # постійно потрібно порівнювати ще й modes(!)
               tracked.base = local
               continue
                   
            (D, diff_error) = _diff3(tracked, local)  # tracked має всередині BASE і REMOTE FileInfo-структури
            if diff_error == TOKEN_EXPIRED:  # при спробі зчитати файли з repo для порівняння виникла помилка 
                                            # TOKEN_EXPIRED
                # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                saveTokenExpiredMark()
                return diff_error    
                
            if diff_error == NETWORK_ERROR:   # після всіх спроб завантажити реальні дані для порівняння з мережі 
                                              # не вдалось. Повертається мережева помилка
                return diff_error
            
            if diff_error != MANUAL_CONFLICT:
                # нормальний режим (не НОВИЙ manual conflict). Відпрацьовуємо p.II.3-5 
                if tracked.remote.sha != D.sha:  # потрібно робити push. (Трасування rolling base:
                                                 # перший push local-only файлу — tracked.remote.sha
                                                 # ще null (свіжий слот) ≠ D.sha → push, далі
                                                 # tracked.remote = D; наступний батч C2, якщо
                                                 # C2 != C1, не ловить short-circuit рядка 1217 →
                                                 # diff3(C1,C2,D1=C1) → rule 5 → знову push. Крах-
                                                 # рестарт: pull-folding (рядки ~1069+) оновлює
                                                 # tracked.remote власним щойно запушеним вмістом →
                                                 # short-circuit 1217 спрацьовує → skip. §II.3/II.4
                                                 # обидва приклади тримаються.)
                    # push D
                    if D.blob is null:  # він може бути null, якщо _diff3 приймав рішення тільки по sha, а отже не було 
                                        # завантажено blob взагалі
                        D.blob = getBlobFromSyncStore(D.sha, D.size) # §II.9: null і на "нема файлу",
                                                             # і на "є, але битий" — нижче однаково
                                                             # перекачуємо з repo
                        if D.blob is null: # blob може не бути ще в SyncStore, якщо це remote file. Local files вже всі
                                           # мають бути представлені в SyncStore, ми про це подбали вище
                            # вантажимо цей блоб з repo i зберігаємо його в `.runtime/sync_store`:
                            (D.blob, error) = retryOnNetworkError(() => getBlobFromRepo(D.sha))  # §II.10
                            if error == TOKEN_EXPIRED:
                                # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                                saveTokenExpiredMark()
                                return error
                            if error == NETWORK_ERROR
                                return error                                                
                               
                            if D.blob is null:
                                return REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR(D.path)   
                               
                            if not existInSyncStore(D.sha, D.size): # §II.9: дешевий stat+size
                                saveBlobToSyncStore(D)
                        
                    # D.mtime НЕ ставимо тут: TODO закрито (2026-08-23, за наводкою advisor) —
                    # tracked.remote.mtime мусить БУТИ точною датою remote-коміту в будь-якому
                    # випадку, а не лише коли контент прийшов з pull. Посеред цього for-циклу ми
                    # ще й не знаємо справжньої дати — GitHub призначає її лише в момент обробки
                    # pushCommit() нижче, і то ОДНУ на весь batch (commit атомарний). Замість
                    # локального здогаду — main_push_tracked: єдиний список, якому нижче
                    # проставляється АВТОРИТЕТНА дата з відповіді GitHub.
                    (savedInRepoBlob, error) = retryOnNetworkError(() => saveBlobToGitHub(D))  # §II.10; (blob,
                                                                    # error) — той самий контракт, що й
                                                                    # getBlobFromRepo вище, для однакової обробки
                    if error == TOKEN_EXPIRED:
                        saveTokenExpiredMark()
                        return error
                    if error == NETWORK_ERROR:
                        return error
                    commit.add(savedInRepoBlob)
                    main_push_tracked.add(tracked)  # tracked.remote (=D нижче) отримає mtime після push
                   
                # §II.3-II.4: безумовно. `local` тут — реальний запис з `batch`, а не placeholder;
                # sha завжди визначений (DELETED нормалізується в сентинел усередині _diff3(),
                # мутація видима викликачу; звичайний файл має sha за побудовою content-addressed
                # store). Умовна else-гілка "§II.5" з чорнового псевдокоду була недосяжна:
                # §II.5-файли (тільки remote, без жодного batch-запису) сюди взагалі не потрапляють
                # — їхнє просування бази відбувається окремо, у Vault-step (рядок 1483,
                # `tracked.base = tracked.remote`). Залишена умова суперечила сама собі (коментар
                # обіцяв "нічого не присвоювати", код у цій же гілці присвоював).
                assert local.sha is not null
                tracked.base = local
                tracked.remote = D
                   
            else: # NEW MANUAL CONFLICT: 
                # згідно §II.6, STEP1. §II.7: та сама ідемпотентна перевірка, що й STEP2 —
                # без неї рестарт після краху "push вдався, диск не встиг записати" дублює коміт.
                if shouldPushToConflictBranch(local.path, local.sha, conflicts, conflict_head_hash):
                    local.mtime = now()  # ⚠️ те саме застереження, що й у STEP2 вище: локальний
                                         # годинник тут нешкідливий, mtime-інваріант §VII.5 не
                                         # чіпає — поле інформаційне, ніколи не sibling-timestamp
                    (savedInRepoBlob, error) = retryOnNetworkError(() => saveBlobToGitHub(local))  # §II.10
                    if error == TOKEN_EXPIRED:
                        saveTokenExpiredMark()
                        return error
                    if error == NETWORK_ERROR:
                        return error
                    conflict_commit.add(savedInRepoBlob)
                # local це і є conflictBase для цього шляху; siblings-список ще порожній —
                # конфлікт щойно виник, Vault-step (STEP3, нижче) сам створить перший
                # sibling-файл (§II.6 випадок 1, "ще не був в конфлікті") і додасть його в список:
                conflicts.set(local.path, {conflictBase: local, siblings: []})
                # ⚠️ ВИПРАВЛЕНО (2026-08-25, знайдено разом з advisor): без цього прапорець
                # лишається false — наступний batch того самого шляху пішов би гілкою "Not in
                # manual conflict" (_diff3(base=R_m, local=C′, remote=R_m) → правило 5 → C′
                # пушиться в MAIN, затираючи R_m — I2/G9-клас), а Vault-step узагалі не дійшов би
                # до STEP3 випадку 1 (умова `tracked.is_manual_conflict` нижче не спрацювала б):
                tracked.is_manual_conflict = true
                tracked.base = tracked.remote
                # ⚠️ ТЕРМІНОЛОГІЯ §II.6 ↔ §III: прозовий опис (STEP1/STEP2/STEP3, §II.6) називає цю
                # відстежувану величину "base" ("3. base = R_{m}", "base (він же R_{last})") — те
                # саме поле, що тут і скрізь у §III зветься `tracked.remote` (утримується
                # ідентичним `tracked.base`-у щоразу цим рядком). Це один запис, дві назви в різних
                # шарах документа, не розбіжність — STEP3 (§III, нижче) читає саме `tracked.remote`.
                # ⚠️ ДОДАНО (2026-08-25, власник): LAZY device_label — саме ТУТ, у момент народження
                # конфлікту, а НЕ eager для кожного `remote_files`, і НЕ раніше (доки не знаємо, чи
                # `_diff3` взагалі поверне MANUAL_CONFLICT). `tracked.remote` — вміст, що стане першим
                # sibling-файлом у Vault-step нижче (§II.6, STEP3, `previous_sibling is null`) —
                # device_label має бути заповнений ДО того виклику:
                (tracked.remote.device_label, error) = retryOnNetworkError(
                    () => getCommitDeviceLabelForPath(tracked.remote.path, head_hash))  # §II.10
                if error == TOKEN_EXPIRED:
                    saveTokenExpiredMark()
                    return error
                if error == NETWORK_ERROR:
                    return error
        #=========================================================================================    
        # end for batch
        #=========================================================================================    
             
        #=========================================================================================    
        # оброблено всі файли даного batch. комітимо зміни
        #=========================================================================================    
        if len(commit)>0:  # якщо commit порожній (нема файів), коміт ігнорується
            while true:
                (pushResult, error) = retryOnNetworkError(() => pushCommit(commit, head_hash))  # §II.10;
                                        # pushResult = (new_head_hash, committed_at) — committed_at =
                                        # committer.date з відповіді GitHub Create-Commit API,
                                        # pushCommit() і так парсить цю відповідь заради sha
                if error == TOKEN_EXPIRED:
                    saveTokenExpiredMark()
                    return error
                if error == NETWORK_ERROR:
                    return error   # спроби вичерпано, маркер уже виставлено
                if error == ERROR422:
                    # упс. поки ми цей коміт намагались зберегти, хтось інший закомітив свої зміни. Тепер все
                    # потрібно повторити заново...
                    # 422-CAP (I6, рішення власника 2026-08-23): 3-5 підряд 422 без жодного успіху
                    # між ними означає або дуже інтенсивну конкуренцію з інших пристроїв, або збій
                    # GitHub API — крутитись вічно нема сенсу, користувач сам вирішить, коли
                    # повторити (клік / наступний interval tick). Поріг: 5.
                    error422_count += 1
                    if error422_count >= 5:
                        # Чистий вихід (I6): TrackedFiles/журнал УЖЕ персистовані з попереднього
                        # успішного batch (§IV recovery matrix) — нічого не втрачено, черга ціла.
                        persistDrainState()  # journal + push_queue лишаються як є
                        return TOO_MANY_CONCURRENT_PUSHES  # UI: "Дуже інтенсивна активність з інших
                                                           # пристроїв (або тимчасовий збій GitHub).
                                                           # Спробуйте синхронізувати пізніше."
                    restart_batch = true
                    break
                (new_head_hash, committed_at) = pushResult
                head_hash = new_head_hash   # ⚠️ ОБОВ'ЯЗКОВО: без цього наступний batch (якщо
                                            # restart_batch лишився false) пушить проти
                                            # ЗАСТАРІЛОГО head_hash → гарантований 422 на
                                            # кожному наступному batch
                # mtime-інваріант: tracked.remote.mtime ЗАВЖДИ дата remote-коміту цього
                # вмісту — і коли він прийшов з pull (Compare API, `file.mtime`, §III цикл
                # "for file in remote_files" — pull-folding),
                # і коли це наш власний push (тут, `committed_at`). Обидва джерела — дата, яку
                # ФАКТИЧНО призначив GitHub, ніколи не локальний годинник: якщо після
                # успішного push drain впаде ДО персисту TrackedFiles, рестарт підбере той
                # самий коміт через pull-folding і отримає БУКВАЛЬНО те саме значення з
                # Compare API — без цього (з локальним now()) шлях-без-краху і шлях-з-крахом
                # дали б різний mtime для того самого вмісту. Один timestamp на весь batch —
                # commit на GitHub атомарний, усі його файли мають одну спільну дату.
                for t in main_push_tracked:
                    t.remote.mtime = committed_at
                error422_count = 0          # 422-CAP: скидаємо лічильник на будь-якому успіху
                break

            if restart_batch:
                 continue;  # перезапускаємо drain з даного (першого) batch зпочатку
           
        # комітимо в conflict_branch, якщо є що комітити
        if len(conflict_commit) > 0:
            cnt = 0
            while cnt<3:
                (conflict_head_hash, error) = retryOnNetworkError(() => getBranchHeadSha(conflictBranchName))  # §II.10;
                                                                       # null, якщо гілки ще нема
                if error == TOKEN_EXPIRED:
                    saveTokenExpiredMark()
                    return error
                if error == NETWORK_ERROR:
                    return error
                (pushResult, error) = retryOnNetworkError(() => client.pushCommit(conflict_commit, conflict_head_hash, conflictBranchName))
                                                                       # §II.10; pushResult = (hash,
                                                                       # committed_at) — той самий контракт, що
                                                                       # й pushCommit() вище — тут committed_at
                                                                       # свідомо ігнорується: conflict-branch
                                                                       # вміст на sibling-timestamp не впливає
                                                                       # (§II.7 — conflicts звіряється лише по
                                                                       # sha, sibling-назви беруть tracked.remote.mtime,
                                                                       # не дату конфлікт-коміту)
                if error == TOKEN_EXPIRED:
                    saveTokenExpiredMark()
                    return error
                if error == NETWORK_ERROR:
                    return error
                if error == ERROR422:
                    # упс. поки ми цей коміт намагались зберегти, хтось інший закомітив свої зміни в conflict-бранч, але це
                    # АБСОЛЮТНО НЕМОЖЛИВО! Бо цей branch належить тільки нашому device! Тому отримуємо новий head і 
                    # пробуємо записати щє раз
                    cnt+=1
                    continue
                (conflict_head_hash, _) = pushResult
                error422_count = 0   # 422-CAP: успіх (у будь-якій з двох гілок) скидає лічильник
                break
            if cnt == 3:
                 return ERROR_COMMIT_TO_CONFLICT_BRANCH

        # ПРИМІТКА: злиття conflict-branch → main ("finalize") СВІДОМО не робиться тут, per-batch.
        # Причина руху — не стиль: злиття рухає main head, а наступний pushCommit() цього batch-циклу
        # все ще використовує СТАРИЙ head_hash → гарантований 422 на найближчому push і зайвий повний
        # restart. Finalize винесено після "end while true" (нижче), поруч із Vault-step — де вже
        # немає жодного push, якому потрібен би був актуальний head_hash. Див. §IV (recovery matrix)
        # для ідемпотентності самого merge+delete.

        # BATCH ОБРОБЛЕНО!
        persistDrainState()   # ОДИН ping-pong запис (§V, tracked-files-{a,b}.json) — бандлить
                              # TrackedFiles + conflicts + conflictBranchName РАЗОМ (рішення
                              # власника 2026-08-23). ⚠️ НЕ head_hash/conflict_head_hash — обидва
                              # завжди перечитуються живими (§II.7, виправлено 2026-08-24: раніші
                              # три згадки цього блоба суперечили одна одній, дві з трьох уже
                              # казали "завжди живе"). Це
                              # drain-in-progress стан, що має читатись КОНСИСТЕНТНО одним блобом
                              # при відновленні (§2.1.2 METAFILE-REFACTOR — групуємо те, що мусить
                              # бути взаємно узгодженим). НЕ hot-пара (metadata-{a,b}.json) — та
                              # тримає lastSyncCommitSha й пишеться лише в епілозі, ПІСЛЯ повного
                              # завершення drain (§1.C METAFILE-REFACTOR), а не на кожен batch.
        removeBatchDir(batch.dir)   # видаляємо оброблений batch з `push_queue/`. 404-толерантно —
                                    # "вже видалено" = success (той самий патерн, що й
                                    # deleteBranchIfExists) — крах МІЖ persistDrainState() і цим
                                    # рядком просто повторює видалення на рестарті (§IV.2)
        #
        # §IV відповідає на відкрите питання "що як push вдався, а збій — ДО запису на диск": завдяки
        # ідемпотентності кожного мережевого кроку (§IV, таблиця) ПОВНИЙ ПОВТОР batch-у з нуля — завжди
        # безпечна відповідь, тому двофазний протокол зводиться до "крок 1 успішний → крок 2 можна робити",
        # без проміжних станів, які треба окремо лагодити.
        # 
        # ПОВТОРНЕ ВИКОНАННЯ BATCH, якщо вже все було закомічено не приводить до змін ні в MAIN ні в CONFLICT BRANCHES
       
        
    #=========================================================================================    
    # end while true  # Вихід з цього циклу тільки тоді, коли черга batches закінчиться або виникла помилка          
    #=========================================================================================    

    #=========================================================================================
    # FINALIZE: злиття conflict-branch → main, ОДИН РАЗ, наприкінці drain (не per-batch — §III
    # вище, коментар "ПРИМІТКА"). Умова та сама: жодних НЕвирішених tracked-конфліктів не лишилось.
    #=========================================================================================
    # conflictBranchName — та сама змінна, що встановлена вище в цьому ж запуску drain()
    # (restore або щойно згенерована); перечитувати з диска тут не потрібно.
    # ⚠️ ВИПРАВЛЕНО (2026-08-24, critical review): усі чотири мережеві виклики нижче раніше були
    # НЕ обгорнуті в `retryOnNetworkError` — єдине місце в §III, де це так, попри те що §II.10
    # прямо каже "усі п'ять сайтів §III… переписані на цей хелпер". FINALIZE — шостий, і на
    # транзієнтну мережеву помилку тут раніше не було визначеної поведінки.
    if conflictBranchName is not null and len(conflicts) == 0:
        (head_hash, error) = retryOnNetworkError(() => getGuardedHead())  # §II.10; свіжий, а не
                                                                          # той, що лишився з
                                                                          # останнього batch-push
        if error == TOKEN_EXPIRED:
            saveTokenExpiredMark()
            return error
        if error == NETWORK_ERROR:
            return error
        (conflict_head_hash, error) = retryOnNetworkError(() => getBranchHeadSha(conflictBranchName))  # §II.10
        if error == TOKEN_EXPIRED:
            saveTokenExpiredMark()
            return error
        if error == NETWORK_ERROR:
            return error
        if conflict_head_hash is null:
            # 404: гілку вже видалено раніше (напр. crash ПІСЛЯ delete, ДО очищення журналу —
            # див. §IV) — трактуємо як "уже фіналізовано", просто чистимо і не падаємо.
            conflictBranchName = null; persistDrainState()  # чистимо ПОЛЕ В ЖУРНАЛІ (§II.7) — не
                                                            # окремий atomicWrite; нема що ще чистити
        else if isAncestorOf(conflict_head_hash, head_hash):
            # Ідемпотентність: якщо conflict-branch tip вже reachable з main (попередня спроба
            # merge удалась, крах стався ПІСЛЯ merge, ДО delete-branch чи ДО запису на диск) —
            # повторний merge НЕ РОБИМО (GitHub або відмовить "nothing to merge", або мовчки
            # прийме no-op — обидва варіанти зайві мережеві виклики без потреби). Одразу видаляємо.
            (_, error) = retryOnNetworkError(() => deleteBranchIfExists(conflictBranchName))  # §II.10;
                                                                    # 404 = вже видалено = success
            if error == TOKEN_EXPIRED:
                saveTokenExpiredMark()
                return error
            if error == NETWORK_ERROR:
                return error
            conflictBranchName = null; persistDrainState()
        else:
            (_, error) = retryOnNetworkError(() => client.mergeBranches(conflict_head_hash, head_hash))  # §II.10;
                                                                 # merge-commit, два parent (§4.3
                                                                 # PSEUDO-MERGE-MODE.md)
            if error == TOKEN_EXPIRED:
                saveTokenExpiredMark()
                return error
            if error == NETWORK_ERROR:
                return error
            (_, error) = retryOnNetworkError(() => deleteBranchIfExists(conflictBranchName))  # §II.10
            if error == TOKEN_EXPIRED:
                saveTokenExpiredMark()
                return error
            if error == NETWORK_ERROR:
                return error
            conflictBranchName = null; persistDrainState()
        # Жодних подальших push у цьому drain немає, тому "head_hash застарів після merge" —
        # структурно неможливо: нема наступного кроку, якому він був би потрібен.

    # всі batches оброблено, тепер порівнюємо файли з TrackedFiles з оригінальними файлами в Vault і замінюємо їх, 
    # видаляємо, зберігаємо conflict-siblings до них.     
    vault_step_errors = []   # ⚠️ ВИПРАВЛЕНО (2026-08-25, Finding #2 закрито): NETWORK_ERROR більше
                              # НЕ потрапляє сюди — усі мережеві збої в цьому циклі тепер `return`
                              # (той самий шлях, що й TOKEN_EXPIRED, §IV.1 "Vault-step запис"). Ця
                              # колекція лишається лише для підтверджено-відсутніх (NOT_FOUND,
                              # repo-corruption клас, §12.5.D) даних — вони НЕ мережеві збої, retry
                              # не допоможе, тому аборт для них не мав би сенсу.
    for tracked in TrackedFiles:
       if tracked.is_manual_conflict:
          # II.6.STEP3:
          current_conflict = conflicts.get(tracked.remote.path)  # {conflictBase, siblings: FileInfo[]} —
                                                        # той самий reconcile-гарант, що й STEP2
                                                        # (§III main-loop, `if tracked.is_manual_conflict:`):
                                                        # якщо ми тут, запис ІСНУЄ.
          assert current_conflict is not null
          tracked.base = current_conflict.conflictBase   # conflictBase — push у conflict-branch.
                                                # ⚠️ ВИРІШЕНО (2026-08-25, власник, SYNC2-FIX.md
                                                # §12.5.D): поки конфлікт живий, sweep НЕ прибирає
                                                # цей blob узагалі — durable conflicts store є
                                                # окремим (4-м) джерелом `referenced`. `getBlobFromRepo`
                                                # у `_diff3()` нижче лишається лише fallback-мережею
                                                # безпеки на катастрофічний, майже неможливий
                                                # випадок (§III STEP3, "NOT_FOUND", нижче), не
                                                # штатним шляхом.
          # ⚠️ ВИПРАВЛЕНО (2026-08-24, критичний перегляд моделі, власник): `current_conflict.siblings` —
          # СПИСОК УСІХ tracked sibling-файлів для цього шляху (§II.6), не одне поле. STEP3
          # працює лише з ОСТАННІМ (найновішим) елементом — попередні (якщо є) лишаються в
          # списку недоторканими, поки process_conflicts() чи сам користувач не розв'яже їх
          # окремо (§III `process_conflicts()`, "по-елементна резолюція").
          previous_sibling = len(current_conflict.siblings) > 0 ? last(current_conflict.siblings) : null
                                                # ⚠️ на відміну від conflictBase, sibling-контент
                                                # ІСНУЄ ТІЛЬКИ у Vault (§II.6, "на сервер НЕ
                                                # ЙДУТЬ") — з мережі невідновний. Коли не null,
                                                # МУСИТЬ мати вже заповнений `.blob` (прочитаний
                                                # зі sibling-файлу на диску) — інакше _diff3()
                                                # нижче впаде на LOCAL_FILE_IS_NOT_FOUND_ERROR,
                                                # той самий клас бага, що й readVaultFileInfo
                                                # нижче.

          if previous_sibling is null:
             # §II.6, випадок 1 ("файл ще не був в конфлікті до початку drain"): конфлікт щойно
             # виник цього ж drain (STEP1, вище) — жодного sibling-файлу в Vault ще нема, тому
             # й diff3 робити нема з чим. Перший sibling — просто щойно завантажений remote-вміст,
             # додається як ЄДИНИЙ елемент порожнього списку.
             #
             # ⚠️ ДОДАНО (2026-08-25, за наводкою власника, §II.6 STEP2 п.3: "blob(R_m) не тягнемо
             # з repo аж до Vault-step... Там і будемо тягнути blob!"): це і є ТЕ місце. Для
             # конфлікту, народженого STEP1 через SHA-коротке замикання (`_diff3` правила 2/8.b/9 —
             # найчастіший реальний тригер: обидва пристрої незалежно створили/змінили файл), blob
             # НІКОЛИ не завантажувався — ні в STEP1, ні pull-folding-ом (той несе лише метадані).
             # Якщо просто викликати `saveConflictSiblingFile(tracked.remote)` тут одразу, вона
             # запише `blob=null` на диск.
             #
             # Також: для конфлікту, що seed-нувся ЦЬОГО drain-у з durable `conflicts` (лінгеруючий,
             # §III `restoreTrackedFilesFromDiskOrCreateNewOne`) БЕЗ жодного sibling-файлу ще і БЕЗ
             # нового pull цього drain-у (idle) — `tracked.remote.sha` лишається null (плейсхолдер
             # seeding). §II.6 п.3 ("...і для яких є завантажені remote file з репо") — це саме ця
             # умова, не "гарантована конструкцією", як помилково вважалось раніше цієї сесії:
             if tracked.remote.sha is null:
                 continue  # нічого нового цього drain-у відображати нема — ні свіжого pull, ні
                           # щойно народженого (STEP1 завжди лишає sha заповненим) конфлікту.
                           # Запис лишається як є, наступний drain спробує знову.
             if tracked.remote.blob is null:
                 tracked.remote.blob = getBlobFromSyncStore(tracked.remote.sha, tracked.remote.size)  # §II.9
                 if tracked.remote.blob is null:
                     (tracked.remote.blob, error) = retryOnNetworkError(
                         () => getBlobFromRepo(tracked.remote.sha))  # §II.10
                     if error == TOKEN_EXPIRED:
                         saveTokenExpiredMark()
                         return error
                     if error == NETWORK_ERROR:
                         # ⚠️ ВИПРАВЛЕНО (2026-08-25, власник, разом з Finding #2): раніше — per-file
                         # skip-and-continue. Власник: "коли ми відновимо роботу з мережею, то
                         # отримаємо той самий результат, який отримали б, якби мережа взагалі не
                         # зникала" — це тримається лише при АБОРТІ, не при skip. Skip доходив до
                         # епілогу, який видаляє журнал (крок 4) БЕЗУМОВНО — і саме журнал є єдиним
                         # носієм "цей шлях чекає на повтор" для НЕ-крах сценарію. Після видалення
                         # журналу шлях стає невидимим, доки remote не зміниться ЩЕ РАЗ (Нотатка 2).
                         # Тепер — той самий `return`, що й TOKEN_EXPIRED вище: журнал НЕ видаляється
                         # (епілог не досягається), наступний drain іде journal-restore гілкою і
                         # повторює ВЕСЬ Vault-step з нуля — той самий, вже доведений безпечним
                         # crash-сценарій (§IV.2, рядки 7-8), не окрема "graceful"-гілка:
                         return error
                     if tracked.remote.blob is null:
                         # ⚠️ NOT_FOUND — семантика з НОВОГО NOTE власника (§II.6, кінець блоку
                         # STEP3): контент справді зник з repo (не транзієнтно). Ми в гілці
                         # `previous_sibling is null` ⟺ `len(current_conflict.siblings) == 0` ⟺
                         # "нема інших tracked конфліктів для цього шляху" — саме умова NOTE-у для
                         # скасування manual conflict mode. Не просто скидаємо прапорець — ЯВНО
                         # прибираємо запис з `conflicts` (не через сканування/дедуп
                         # process_conflicts(), а прямим викликом): без цього наступний
                         # `restoreTrackedFilesFromDiskOrCreateNewOne` знову побачить цей шлях у
                         # `conflicts` і воскресить is_manual_conflict=true.
                         #
                         # ⚠️ НАСЛІДОК, ПІДТВЕРДЖЕНО ПРИЙНЯТНИЙ (власник, 2026-08-25): якщо це БУВ
                         # єдиний tracked-конфлікт у всій системі, видалення цього запису може дати
                         # `len(conflicts) == 0`. ⚠️ ВИПРАВЛЕНО (2026-08-25, порядок): НЕ цього
                         # drain-у — FINALIZE (§III) виконується РАНІШЕ Vault-step (STEP3, де ми
                         # зараз) у тій самій `while true`-послідовності, тому вже перевірив старий
                         # (непорожній) `conflicts` і не мержив. Ефект настане на НАСТУПНОМУ drain-і:
                         # `saveConflictsToStore` (епілог крок 2, нижче) занесе спорожнений
                         # `conflicts` у durable store, і той наступний запуск FINALIZE (уже на
                         # своєму, ранньому місці) змерджить conflict_branch у main. Conflict-branch
                         # УЖЕ містить C_n цього шляху (STEP1/STEP2 його туди запушили) — локальний
                         # вміст потрапить у main БЕЗ sibling-файлу для порівняння. Прийнятно САМЕ
                         # ТОМУ, що NOT_FOUND тут — не побутова ситуація:
                         # blob, на який посилається коміт УЖЕ в conflict-branch, зникає з GitHub
                         # лише за катастрофічних обставин (repo corruption, force-push історії, що
                         # прибрав reachable об'єкт — GitHub не збирає сміття на досяжних blob'ах
                         # штатно). Це узгоджується й з мотивацією самого NOTE ("наступний
                         # commit+drain перекомітить файл з Vault і, ймовірно, знову зіткнеться") —
                         # для настільки рідкісного, по суті аварійного випадку "втрата
                         # sibling-порівняння цього разу" — прийнятна ціна, не системний дефект:
                         tracked.is_manual_conflict = false
                         conflicts.delete(tracked.remote.path)
                         continue
                     if not existInSyncStore(tracked.remote.sha, tracked.remote.size):  # §II.9
                         saveBlobToSyncStore(tracked.remote)
             saveConflictSiblingFile(tracked.remote)  # timestamp + device_label з tracked.remote
                                                       # (заповнені при STEP1, вище, того самого
                                                       # drain-у)
             conflicts.set(tracked.remote.path, {conflictBase: current_conflict.conflictBase, siblings: [tracked.remote]})
          else:
             # Vault step (II.6.STEP3, випадок 2):
             # ⚠️ ДОПОВНЕНО (2026-08-24, critical review): останній елемент `current_conflict.siblings` — це
             # запис, відновлений з durable conflict-store (persisted {path,sha,size,mtime,
             # device_label}, БЕЗ вмісту — те саме, чому «sibling-контент… з мережі невідновний»
             # вище), тому `.blob` тут ЩЕ не заповнений і мусить бути прочитаний з файлової системи
             # явно, за тим самим патерном, що й `readVaultFileInfo` для base-file нижче (§III,
             # "not manual conflict" гілка Vault-step):
             previous_sibling.blob = readSiblingFileFromVault(previous_sibling)  # {bytes} з диска;
                                                             # ⚠️ ВИПРАВЛЕНО (2026-08-25): раніше
                                                             # передавав лише `.path` — вироджено
                                                             # (усі елементи `siblings` мають
                                                             # ОДНАКОВИЙ `.path == P`, §III
                                                             # `findConflictSiblingFilesInVault`);
                                                             # функція без mtime+device_label не могла
                                                             # б визначити, ЯКИЙ саме sibling читати.
                                                             # Без цього _diff3() нижче впаде на
                                                             # LOCAL_FILE_IS_NOT_FOUND_ERROR (коментар
                                                             # вище при `previous_sibling = last(...)`)
             # Назва навмисно НЕ `D` — на відміну від main-loop D (§III, "Not in manual conflict"),
             # цей результат ніколи не пушиться на GitHub, він стає вмістом sibling-файлу. Різні D
             # в різних циклах з однаковою назвою раніше зчитувались як суперечність (власник,
             # 2026-08-23) — окремі імена усувають плутанину структурно, без коментаря, який треба
             # пам'ятати читати.
             (merged_sibling, diff_error) = _diff3(tracked, previous_sibling)
             if diff_error == TOKEN_EXPIRED:
                 # Термінально для ВСЬОГО drain (як і скрізь у §III) — токен не відновиться сам між
                 # файлами, продовжувати цикл лише витрачає марні виклики.
                 saveTokenExpiredMark()
                 return diff_error
             if diff_error == NETWORK_ERROR:
                 # ⚠️ ВИПРАВЛЕНО (2026-08-25, власник, Finding #2 — вирішено раз і назавжди): раніше
                 # — per-file skip-and-continue "інші файли можуть пройти". Але skip доходив до
                 # епілогу, який видаляє журнал (крок 4) БЕЗУМОВНО — а журнал єдиний носій "цей шлях
                 # чекає на повтор" у НЕ-крах сценарії. Власник: результат після відновлення мережі
                 # має бути ТОЙ САМИЙ, що й без збою — це тримається лише при АБОРТІ. Той самий
                 # `return`, що й TOKEN_EXPIRED вище: журнал лишається на диску, наступний drain іде
                 # journal-restore гілкою й повторює ВЕСЬ Vault-step — той самий, вже доведений
                 # безпечним crash-сценарій (§IV.2, рядки 7-8), не окрема "graceful"-гілка:
                 return diff_error
             if diff_error == REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR or diff_error == BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR:
                 # ⚠️ ДОДАНО (2026-08-25, NOTE власника §II.6 STEP3, обидва варіанти NOT_FOUND
                 # трактуються ОДНАКОВО тут): на відміну від гілки "previous_sibling is null" вище
                 # — тут siblings НЕ порожній (ми в `else`), тобто NOTE-ова умова "нема інших
                 # tracked конфліктів" ХИБНА за визначенням цієї гілки. Скасування manual conflict
                 # mode тут НЕ застосовується — попередній `previous_sibling` фізично лишається на
                 # диску й у списку без змін, просто немає з чим мержити цього drain-у.
                 # `BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR` (сам `conflictBase` недоступний) тепер
                 # практично недосяжний за конструкцією — SYNC2-FIX.md §12.5.D (2026-08-25): поки
                 # конфлікт живий, sweep НЕ прибирає його `conflictBase`-blob узагалі; спрацює лише
                 # якщо СВІЖИЙ (STEP1) push у sync_store чомусь так і не відбувся АБО сам
                 # GitHub-репозиторій пошкоджено — той самий "майже ніколи" клас, що й для
                 # sibling-блоба вище, тому й та сама, найпростіша, безпечна відповідь: skip, НЕ
                 # аборт (це вже НЕ мережевий збій, дані підтверджено відсутні — retry не допоможе).
                 # ⚠️ ЧЕСНО (2026-08-25): на відміну від NETWORK_ERROR вище (тепер аборт, журнал
                 # живий), ЦЕЙ skip і далі має ту саму природу, що Finding #2 — епілог видалить
                 # журнал, і повтор станеться лише коли для цього шляху прийде НОВА remote-зміна, не
                 # "наступний drain" сам по собі. Прийнятно САМЕ тому, що клас події —
                 # repo-corruption, а не звичайна мережева нестабільність (§12.5.D вище):
                 vault_step_errors.add({path: tracked.remote.path, error: diff_error})
                 continue
             if diff_error != MANUAL_CONFLICT:
                # ЗАМІНЮЄМО останній елемент списку на поточний — і в Vault, і в conflicts
                # (довжина списку не змінюється). ⚠️ ВИПРАВЛЕНО (2026-08-26, §II.11, Finding 1 —
                # "точнісінько той клас бага, заради якого весь цей редизайн"): раніше тут
                # `removeFromVault(previous_sibling)` виконувався ПЕРШИМ, до будь-якого durable-
                # запису — крах/NETWORK_ERROR-аборт ІНШОГО файлу пізніше в тому самому циклі міг
                # лишити durable conflicts store застарілим, а старий доказ уже знищеним. Тепер —
                # mark-транзакція (§II.11): спершу мітка + новий файл + durable-персист, і лише
                # ТОДІ видалення старого.
                merged_sibling.mtime = tracked.remote.mtime  # РІШЕННЯ ВЛАСНИКА (2026-08-23): дата
                                                # remote-коміту, НЕ момент запису. _diff3() завжди
                                                # повертає mtime=null для свіжозлитого результату —
                                                # без цього присвоєння timestamp у назві sibling-файлу
                                                # був би відсутній. tracked.remote.mtime тепер ЗАВЖДИ
                                                # точна дата remote-коміту (і для pull, і для власного
                                                # push — див. інваріант і фікс нижче, §III main-loop) —
                                                # це рішення тримається строго, не приблизно.
                merged_sibling.device_label = tracked.remote.device_label  # ⚠️ ДОДАНО (2026-08-25,
                                                # власник): той самий принцип, що й для mtime щойно
                                                # вище — merged_sibling завжди датований і
                                                # "приписаний" НАЙНОВІШОМУ remote-pull, а не
                                                # попередньому sibling-файлу чи _diff3()-результату
                                                # (який тут теж завжди повертає null — той самий
                                                # клас, що й mtime).
                txGuid = generateGuid()  # crypto.randomUUID() — НЕ Math.random()/Date.now() (заборонені
                                                # в проєкті як джерело унікальності; той самий принцип,
                                                # що монотонний seq у METAFILE §2)
                writeSiblingTransactionMark(txGuid, tracked.remote.path, previous_sibling, merged_sibling)  # §II.11,
                                                # крок 1 транзакції — ДО будь-якого запису sibling-файлу
                saveConflictSiblingFile(merged_sibling)  # крок 2 — З AtomicWrite, як і завжди
                conflicts.set(tracked.remote.path, {conflictBase: current_conflict.conflictBase,
                    siblings: replaceLast(current_conflict.siblings, merged_sibling)})
                conflicts.lastSiblingTxGuid = txGuid
                saveConflictsToStore(conflicts)  # крок 3 — ⚠️ ДУРАБЕЛЬНИЙ КОМІТ ТУТ, не в епілозі
                removeFromVault(previous_sibling)  # крок 4 — ЛИШЕ ТЕПЕР видаляємо старий sibling
                deleteSiblingTransactionMark()  # крок 5
             else:
                # Зберігаємо новий, старий НЕ чіпаємо на диску — старий лишається ЩЕ ОДНИМ tracked
                # елементом списку (§II.6 п.6), НЕ стає synthetic (§II.6/§III "TRACKED vs
                # SYNTHETIC" — synthetic означає "engine його ніколи не створював", а цей файл
                # engine якраз створив). process_conflicts() (епілог крок 2) зможе дедублікувати
                # його з іншим tracked елементом пізніше, якщо їхні SHA колись зійдуться. Список
                # ДОДАЄ новий елемент у кінець (росте на один) — саме він, за побудовою §II.6,
                # стає базою для diff3 наступного drain-у (last(current_conflict.siblings)):
                saveConflictSiblingFile(tracked.remote)  # tracked.remote.mtime і .device_label вже
                                                          # присутні (заповнюються при кожному
                                                          # pull-фолдингу для is_manual_conflict
                                                          # шляхів, §III)
                conflicts.set(tracked.remote.path, {conflictBase: current_conflict.conflictBase,
                    siblings: append(current_conflict.siblings, tracked.remote)})
       else: 
          if tracked.base.sha != tracked.remote.sha:   
              # Vault-step in II.3 and II.4
              # `local` тут — ЖИВИЙ файл з Vault, прочитаний ЗАРАЗ (в кінці drain), а не файл з
              # батча (той міг бути запушений і забутий десятки batches тому). Читаємо наостанок,
              # бо саме зараз вирішуємо, що йде у Vault.
              vault_entry = readVaultFileInfo(tracked.remote.path)  # {path, size, sha, mode, blob} або
                                                                    # {exists: false}, якщо файлу немає.
                                                                    # `.blob` ЗАПОВНЕНИЙ — байти вже
                                                                    # прочитані, щоб порахувати SHA,
                                                                    # тримати їх коштує нуль додаткового
                                                                    # I/O. Без цього _diff3() нижче не
                                                                    # знайшов би blob цього ЖИВОГО
                                                                    # vault-вмісту в sync_store/ (він
                                                                    # там ніколи не був застейджений) і
                                                                    # впав би на LOCAL_FILE_IS_NOT_FOUND.
              if vault_entry.exists:
                  local = FileInfo(path=vault_entry.path, size=vault_entry.size,
                                    sha=vault_entry.sha, mode="", blob=vault_entry.blob)
              else:
                  # РІШЕННЯ ВЛАСНИКА (2026-08-23): користувач міг видалити файл з Vault, ПОКИ
                  # цей drain ще тривав (файл потрапив у TrackedFiles ще до видалення). Трактуємо
                  # це як СПРАВЖНЄ видалення (local.mode=DELETED), а НЕ як null. Різниця важлива:
                  #   - null пройшов би через правило 7.c → remote content тихо ВОСКРЕСАЄ файл,
                  #     повністю ігноруючи намір користувача на видалення;
                  #   - DELETED дає: якщо remote не змінився за цей час — правило 5, видалення
                  #     перемагає (тихо, як завжди для "delete vs unchanged"); якщо remote ЗМІНИВСЯ
                  #     за цей час — правило 8.b, MANUAL_CONFLICT (delete-vs-modify — той самий
                  #     конфлікт, що й у звичайному, не-drain сценарії §5.2 PSEUDO-MERGE-MODE.md).
                  # Намір користувача на видалення має ту саму вагу, коли б він не стався.
                  local = FileInfo(path=tracked.remote.path, size=null, sha=null, mode=DELETED, blob=null)
              # Назва навмисно НЕ `D` — див. коментар біля _diff3(tracked, previous_sibling) вище:
              # цей результат теж ніколи не пушиться, він йде прямо у Vault.
              (vault_result, diff_error) = _diff3(tracked, local)  # tracked має всередині BASE і REMOTE FileInfo-структури
              if diff_error == TOKEN_EXPIRED:
                  saveTokenExpiredMark()
                  return diff_error
              if diff_error == NETWORK_ERROR:
                  # ⚠️ ВИПРАВЛЕНО (2026-08-25, власник, Finding #2 — вирішено раз і назавжди): раніше
                  # — per-file skip-and-continue "мережева помилка тепер мейнлайн". Але skip доходив
                  # до епілогу, який видаляє журнал (крок 4) БЕЗУМОВНО — журнал єдиний носій "цей
                  # шлях чекає на повтор" у НЕ-крах сценарії; без нього "§IV.2 рядок 7 покриває
                  # повтор" було хибним твердженням (рядок 7 — крах-сценарій, журнал живий). Власник:
                  # результат після відновлення мережі має бути ТОЙ САМИЙ, що й без збою — тримається
                  # лише при АБОРТІ. Той самий `return`, що й TOKEN_EXPIRED вище:
                  return diff_error
              if diff_error == MANUAL_CONFLICT:
                  # Новий конфлікт, народжений прямо на Vault-step (delete-vs-modify або
                  # edit-vs-modify колізія, виявлена ЩОЙНО — на відміну від STEP1, він НІКОЛИ
                  # не проходив через push у conflict-branch, тому conflictBase-половини
                  # запису ще не існує). Цей конфлікт з'являється одразу в Vault і не
                  # потрапляє в conflict-branch, але все ж це tracked конфлікт:
                  #
                  # ⚠️ ДОДАНО (2026-08-25, разом з advisor): третій сайт того самого класу бага, що
                  # й STEP3 гілка "previous_sibling is null" (§II.6). Правила 8.b/9 (`_diff3`) —
                  # SHA-коротке замикання, `tracked.remote.blob` НІКОЛИ не довантажувався (ні тут,
                  # ні pull-folding-ом). `saveConflictSiblingFile` нижче писала б `blob=null` на
                  # диск без цього. Той самий блок, що й STEP3 гілка 1 — sync_store → мережа:
                  if tracked.remote.blob is null:
                      tracked.remote.blob = getBlobFromSyncStore(tracked.remote.sha, tracked.remote.size)  # §II.9
                      if tracked.remote.blob is null:
                          (tracked.remote.blob, error) = retryOnNetworkError(
                              () => getBlobFromRepo(tracked.remote.sha))  # §II.10
                          if error == TOKEN_EXPIRED:
                              saveTokenExpiredMark()
                              return error
                          if error == NETWORK_ERROR:
                              # ⚠️ ВИПРАВЛЕНО (2026-08-25, той самий Finding #2 фікс, що й вище) —
                              # аборт, не skip: конфлікт ще НЕ створений (`conflicts.set` нижче не
                              # виконався), а `continue` тут ще й лишив би `tracked.remote.blob`
                              # частково заповненим, доки решта конфлікту (device_label, conflicts.set,
                              # saveConflictSiblingFile) чекає — проміжний, ніде не задокументований
                              # стан. Аборт відкидає ВЕСЬ batch/Vault-step цього drain-у одразу, без
                              # проміжних станів:
                              return error
                          if tracked.remote.blob is null:
                              # NOT_FOUND — на відміну від STEP3 гілки 1, тут СКАСОВУВАТИ нічого:
                              # запис у `conflicts`/`is_manual_conflict` ще НЕ створений (ми саме
                              # збирались це зробити нижче). Просто НЕ створюємо його — той самий
                              # ефект, що й "нема конфлікту цього drain-у", наступний drain спробує
                              # заново (tracked.base не просувається):
                              #
                              # ⚠️ ВИПРАВЛЕНО (2026-08-25, advisor): тут `error` — ВЖЕ `null`
                              # (retryOnNetworkError() завершився без помилки, просто blob
                              # відсутній) — записувати його в звіт означало б `error: null`.
                              # Явна константа, той самий клас, що й `_diff3` вживає для цього
                              # самого випадку (рядки 1122/2000):
                              vault_step_errors.add({path: tracked.remote.path,
                                  error: REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR(tracked.remote.path)})
                              continue
                          if not existInSyncStore(tracked.remote.sha, tracked.remote.size):  # §II.9
                              saveBlobToSyncStore(tracked.remote)
                  if tracked.remote.device_label is null:
                      # Третє (і останнє) місце народження конфлікту — STEP1 і pull-folding-refresh
                      # уже мають lazy device_label-fetch (§III), тут його не було ВЗАГАЛІ:
                      (tracked.remote.device_label, error) = retryOnNetworkError(
                          () => getCommitDeviceLabelForPath(tracked.remote.path, head_hash))  # §II.10
                      if error == TOKEN_EXPIRED:
                          saveTokenExpiredMark()
                          return error
                      if error == NETWORK_ERROR:
                          # ⚠️ ВИПРАВЛЕНО (2026-08-25, той самий Finding #2 фікс): аборт, не skip —
                          # той самий принцип, той самий `return`, що й вище в цій-таки гілці:
                          return error
                  #
                  # conflictBase ІНІЦІАЛІЗУЄМО як tracked.remote (=R_m, той самий вміст, що й
                  # стає sibling-файлом рядком нижче) — це коректний diff3-предок для STEP2/
                  # STEP3 НАСТУПНОГО drain-у: перший локальний edit звірятиметься проти нього
                  # (STEP2, §III), а Vault-merge next-drain піде як diff3(R_m, R_m[+user-edits],
                  # R_{m+1}) — саме той предок, що й мав би бути. Без цієї ініціалізації STEP2
                  # наступного drain читав би conflictBase=null і впав би на assert (§II.6):
                  conflicts.set(tracked.remote.path, {conflictBase: tracked.remote, siblings: [tracked.remote]})
                  saveConflictSiblingFile(tracked.remote) # timestamp в назві файлу беремо з tracked.remote.mtime
                  # ⚠️ ВИПРАВЛЕНО (2026-08-25, знайдено разом з advisor, той самий фікс, що й STEP1
                  # вище): без цього прапорець лишається false у TrackedFiles-журналі — якщо
                  # journal переживе цей drain (пізній крах ДО видалення журналу, епілог крок 4),
                  # стан на диску був би внутрішньо суперечливим (є conflictBase+siblings у
                  # `conflicts`, але is_manual_conflict=false в journal):
                  tracked.is_manual_conflict = true
              else: 
                  updateFileInVault(vault_result);  # замінити base-file в Vault на vault_result (атомарно,
                                                    # rename або, якщо файл відкритий - перезаписом). Якщо
                                                    # vault_result.mode == DELETED, тоді файл локально видаляється
              tracked.base = tracked.remote 
          else:
              # tracked.base.sha == tracked.remote.sha (змін в Vault не робимо взагалі). base залишається з tracked.base
              null         

    if len(vault_step_errors) > 0:
        # ⚠️ ВИПРАВЛЕНО (2026-08-25, Finding #2): тут лишились ЛИШЕ NOT_FOUND/repo-corruption-класу
        # записи (§12.5.D) — NETWORK_ERROR більше сюди не потрапляє (усі сайти вище тепер `return`).
        # Не критично для drain (batches вже успішно допушені) — але користувач має знати, що
        # частина remote-контенту не отримала sibling-порівняння через підтверджено відсутні дані.
        logWarning("Vault-step: N записів пропущено (дані підтверджено відсутні в repo)", vault_step_errors)
                
    #=============================================================================================
    # ЕПІЛОГ: усі batches оброблено, Vault-step завершено. Це "commit" усього drain-у як ОДНІЄЇ
    # транзакції (§I) — фіксуємо cold baseline, durable conflicts і hot-якір, тоді прибираємо
    # за собою.
    #
    # ⚠️ ЧОМУ conflicts і TrackedFiles ЖИВУТЬ ОКРЕМО (рішення власника, 2026-08-24): у них РІЗНИЙ
    # ЖИТТЄВИЙ ЦИКЛ. TrackedFiles — журнал ОДНОГО drain-запуску: народжується на його старті,
    # видаляється (крок 4) щойно цей самий drain повністю накладений на Vault. conflicts (разом з
    # conflictBase) — переживає ЦЕЙ drain: нерозв'язаний tracked-конфлікт лишається в силі, доки
    # користувач сам не зведе base-file зі sibling-файлом у diff-editor — а це можуть бути дні й
    # БАГАТО наступних drain-запусків. Якби conflicts жила лише в TrackedFiles-журналі, крок 4
    # (видалення журналу наприкінці КОЖНОГО drain) стирав би її разом з ним — тому durable
    # store для conflicts (крок 2 нижче) є ОКРЕМИМ, довгоживучим носієм, не похідним від журналу.
    # Бандлення `conflicts` У ЖУРНАЛ під час самого drain (§V, persistDrainState на кожен batch)
    # — це лише crash-recovery зручність ВСЕРЕДИНІ одного запуску (один blob замість двох записів
    # per batch); постійний дім лишається durable store, і саме тому крок 2 обов'язково
    # переносить туди фінальний стан ПЕРЕД тим, як журнал (разом зі своєю копією conflicts)
    # зникає в кроці 4.
    #
    # Порядок НЕ довільний: крок 2 (conflicts у durable store) МУСИТЬ передувати
    # кроку 4 (видалення журналу) — після видалення журналу store лишається ЄДИНИМ носієм
    # conflicts, і STEP2-assert НАСТУПНОГО drain (§II.6) впаде, якщо store не оновлено. Кроки
    # 1/3/5 між собою переставні під тією ж redo-парасолькою (кожен доведено ідемпотентний нижче,
    # §IV.1) — фіксуємо один порядок, щоб не тримати в голові N! еквівалентних варіантів.
    #=============================================================================================

    # 1. Переносимо base кожного tracked-файлу в cold `files{}` (bucket per path, atomicWriteFile,
    #    §2.2 METAFILE-REFACTOR). Джерело — TrackedFiles, який ще НЕ видалено (крок 4) — тому
    #    редагувати цей крок можна скільки завгодно разів поспіль з тим самим результатом:
    #
    # ⚠️ ВІДКРИТЕ ПИТАННЯ (2026-08-24) — ЗАКРИТО (2026-08-25, Finding #2, власник: "вирішити раз і
    # назавжди"). Оригінальний симптом: цей цикл писав baseline БЕЗУМОВНО для ВСІХ tracked-файлів,
    # включно з тими, що впали в NETWORK_ERROR під час Vault-step і так і НЕ потрапили у Vault —
    # `tracked.remote.sha` = R_m (щойно завантажений remote-вміст), але живий Vault-файл цей вміст
    # так і не отримав (Vault-step перервався на `continue` ДО `updateFileInVault`), тож тут
    # писався baseline, який бреше про реальний стан Vault. Наслідок був простежений: наступний
    # `[commit]`/`findChanges` бачить розбіжність живого вмісту з цим baseline, `_diff3(base=R_m,
    # local=старий_вміст, remote=R_m)` (правило 5, §II.1) віддає перемогу local — ТИХО затирає R_m
    # без жодного конфлікту (I2-порушення, той самий клас, що й G9/дефект A, інший тригер).
    #
    # **Корінь був структурний, не в цьому циклі:** graceful NETWORK_ERROR-skip у Vault-step
    # проходив одразу в епілог (замість того, щоб зупинити весь drain, як робить TOKEN_EXPIRED) —
    # тому цей baseline-запис ВЗАГАЛІ досягався зі стану "R_m відомий, Vault не оновлено". Фікс
    # (§III, усі `if diff_error == NETWORK_ERROR:`/`if error == NETWORK_ERROR:` у Vault-step, і в
    # STEP1/pull-folding-refresh для lazy device_label-fetch): NETWORK_ERROR тепер УСЮДИ `return`,
    # той самий шлях, що й TOKEN_EXPIRED — журнал НЕ видаляється, епілог НЕ виконується цього
    # drain-у, наступний запуск іде journal-restore гілкою й повторює ВЕСЬ Vault-step з нуля
    # (доведений безпечний крах-сценарій, §IV.2 рядки 7-8). Стан "R_m відомий, Vault не оновлено"
    # більше НЕ МОЖЕ дожити до цього циклу — не пом'якшено, а структурно неможливе. Кандидати (a)/(b)
    # з попередньої версії цього коментаря не знадобились — обидва намагались локально загатити
    # симптом; фактичний фікс прибрав саму розбіжність "graceful ≠ крах".
    #
    # (Той самий день, окремим фіксом, ще ДО цього закриття): другий симптом дефералу —
    # `saveConflictsToStore` (крок 2 нижче) міг persistувати `conflicts[path].siblings=[]`, доки
    # STEP3 не встиг додати перший sibling — закрито незалежно: `restoreTrackedFilesFromDiskOrCreateNewOne`
    # (§III, seeding) seed-ить `is_manual_conflict=true` БЕЗУМОВНО для кожного шляху з `conflicts`,
    # незалежно від того, чи siblings порожній.
    for tracked in TrackedFiles:
        if tracked.remote.sha is null:
            # ⚠️ ДОДАНО (2026-08-25, разом з advisor): placeholder-seed (§III
            # `restoreTrackedFilesFromDiskOrCreateNewOne`, idle лінгеруючий конфлікт БЕЗ свіжого
            # pull цього drain-у) — писати `{baselineSha: null, mtime: null, size: null}` тут
            # означало б ЗАТЕРТИ РЕАЛЬНИЙ попередній baseline цього шляху null-ами. Наслідок:
            # після розв'язання конфлікту наступний локальний edit читає `metadata.files.get`
            # → null-и → `_diff3(base=null, local=A, remote=B)` → правило 2 → ХИБНИЙ
            # MANUAL_CONFLICT на рівному місці. Той самий guard, що й STEP3 (`previous_sibling is
            # null` гілка) — нема свіжого вмісту цього drain-у, нема що переносити в baseline:
            continue
        writeFileBaseline(tracked.remote.path, {
            baselineSha: tracked.remote.sha,
            mtime: tracked.remote.mtime,
            size: tracked.remote.size,
        })   # atomicWriteFile ЛИШЕ зачепленого кошика (§2.2) — торн зачіпає 1 кошик, не всю мапу;
             # той самий шлях, записаний тим самим значенням двічі поспіль (redo після краху) —
             # байтово ідентичний результат, отже ІДЕМПОТЕНТНО (§IV.1, новий рядок нижче)

    # 2. Оптимізуємо conflict-sibling-файли (могли з'явитись дублікати SHA після Vault-step) і
    #    зберігаємо ОНОВЛЕНИЙ conflicts у ЙОГО durable dім (conflict-store-файл, окремий від
    #    журналу, §II.6) — МУСИТЬ відбутись ДО кроку 4:
    conflicts = process_conflicts()   # ambient `conflicts` тут ВЖЕ повна (накопичена за весь
                                       # drain, STEP1/STEP2/STEP3) — гілка "довантажити з
                                       # durable store" (§III прим., п.1) не спрацьовує.
                                       # conflictBase-половина кожного запису лишається
                                       # незмінною (контракт функції); дедуп/reconcile —
                                       # лише sibling-половина, за живим FS-сканом.
                                       # Ідемпотентно: незмінний стан Vault → незмінний
                                       # результат при повторному виклику.
    saveConflictsToStore(conflicts)   # atomicWrite — durable дім conflicts

    # 3. Записуємо hot-пару (§2.1 METAFILE-REFACTOR, ping-pong metadata-{a,b}.json) — ПІДТВЕРДЖЕНИЙ
    #    якір до merge-баз, фіксується РІВНО тут, не раніше (§1.C: "фіксація — один раз, після
    #    повного завершення drain"):
    persistHotMetadata({
        lastSyncCommitSha: head_hash,   # той самий head_hash, що просувався після кожного
                                        # успішного MAIN push (§III)
        conflictBranch: conflictBranchName,
                                        # ⚠️ ВИПРАВЛЕНО (2026-08-25, разом з advisor): раніше було
                                        # `(len(conflicts) > 0) ? conflictBranchName : null` — хибно
                                        # виводило "гілку злито" з "конфліктів зараз нема", а це
                                        # РІЗНІ речі. FINALIZE (§III) виконується РАНІШЕ Vault-step
                                        # у тій самій `while true`-послідовності — якщо на момент
                                        # FINALIZE `conflicts` ще НЕпорожній (типово: STEP3-cancel
                                        # або user-resolved-mid-drain спорожнюють його ПІЗНІШЕ, в
                                        # епілозі крок 2), FINALIZE НЕ мержить, `conflictBranchName`
                                        # лишається реальним іменем існуючої, ще не змердженої гілки
                                        # з уже запушеним C_n. Стара формула тут писала б `null` —
                                        # наступний drain (Фікс Б, `restoreTrackedFilesFromDiskOrCreateNewOne`,
                                        # journal теж видалено кроком 4) прочитав би `null`, замінив
                                        # би на СВІЖЕ ім'я — стара гілка стає сиротою НАЗАВЖДИ,
                                        # локальні правки в ній ніколи не досягнуть main. Правильне
                                        # джерело — сама `conflictBranchName`: її зануляє ЛИШЕ
                                        # FINALIZE, і ЛИШЕ ПІСЛЯ підтвердженого merge/видалення чи
                                        # 404 (гілки вже нема) — саме так має йти через ЦЕЙ ping-pong
                                        # запис, а не через окремий atomicWrite(metadata.conflictBranchName=...)
                                        # (той шорткат прибрано з §II.7/FINALIZE — persistDrainState()
                                        # бандлить conflictBranchName у drain-журнал МІЖ batches, а
                                        # тут воно ПРОМОУЄТЬСЯ у hot, підтверджений стан)
        # lastSyncTreeSha, lastCommitMtime, remoteIdentity, heldPluginUpdates — той самий виклик,
        # решта полів і формат — METAFILE-REFACTOR.md §1.A, поза скопом цього документа
    })

    # 4. Видаляємо TrackedFiles-журнал (ОБИДВА ping-pong слоти, §V) — з цього моменту єдиний
    #    носій conflicts є durable store (крок 2 вже відбувся), єдиний носій baseline —
    #    cold `files{}` (крок 1 вже відбувся):
    deleteTrackedFilesJournal()   # видалення обох слотів. 404-толерантно — "вже нема" = success

    # 5. sweep `.runtime/sync_store/` за посиланнями (НЕ "чистимо кеш" — SYNC2-FIX.md §12.3).
    #    ⚠️ ВИПРАВЛЕНО (2026-08-25, власник, SYNC2-FIX.md §12.5.D — 4-те джерело `referenced`):
    #    раніше тут стверджувалось "усі джерела `referenced` порожні → sweep забирає геть усе" —
    #    вірно ЛИШЕ якщо durable conflicts store (крок 2 вище) ТЕЖ порожній. Якщо лишився хоч
    #    один незавершений manual conflict — його `conflictBase`-blob саме ЦЕЙ sweep МУСИТЬ
    #    залишити (4-те джерело §12.5 непорожнє), не видаляти. "Завершено = видалити все" і
    #    далі не потребує окремого правила — просто тепер це наслідок ДВОХ умов (черга порожня
    #    ТА conflicts порожні), не однієї:
    rearangeSyncStore()

    # drain finished. І VAULT знову переходить в консистентний режим роботи.
```

---

## IV. Матриця відновлення після краху

> Мотивація: §I показав, що `TrackedFiles` тепер несе базу для diff3 (не просто кеш) — тому кожна
> точка краху в циклі "один batch" потребує явної відповіді, а не "має спрацювати". Але сама
> відповідь для майже всіх точок ОДНАКОВА: **redo batch-у з нуля, з живою головою** — і вона
> безпечна лише тому, що кожен мережевий побічний ефект, з яких складається batch, є доведено
> ідемпотентним. Тому матриця — це не список унікальних рецептів на кожен рядок, а (1) доведення
> ідемпотентності для кожного типу побічного ефекту й (2) короткий перелік точок краху, кожна з
> яких просто ЦИТУЄ потрібний рядок доведення.

### IV.1 Таблиця ідемпотентності побічних ефектів

| Побічний ефект | Ідемпотентний? | Чому |
|---|---|---|
| **R3b claim батча** (`getBatch()`, §II.8) | Так, за побудовою | Мітки `.attempted-commit`/`.attempted` — це Пітерсон-протокол: crash-recovery для лишеного `.attempted-commit` — знесення каталогу АБО ремонт з Vault (§II.8), обидва ідемпотентні для повторного виклику `getBatch()`. |
| **`POST /git/blobs` (blob upload)** | Так, вроджено | Content-addressed: ім'я блоба — SHA його вмісту. Повторний upload того самого вмісту — no-op на боці GitHub (те саме SHA повертається). Безпечно повторювати без перевірок. |
| **Push у MAIN** (`createTree`→`createCommit`→`updateRef`) | Так, через SHA-рівність на СВІЖІЙ голові | Рестарт завжди перечитує `head_hash` заново (`restart_batch=true` на початку кожного циклу). Якщо попередня спроба вже долетіла, свіжий remote-diff покаже наш власний вміст як "remote", і §11 П11 (per-file byte-identical drop, ЗБЕРЕЖЕНО) відкидає файл ДО спроби push. Доведено прикладом §II.4 "Якщо збій відбувся після успішного push". |
| **Push у CONFLICT-BRANCH** | Так, ПІСЛЯ фіксу §II.7 | `shouldPushToConflictBranch()` (§II.7) не залежить від персистованого `conflict_hash` — за потреби йде живою перевіркою `getContentsMetadataAtRef` проти поточної голови гілки. До фіксу STEP1 не мав цієї перевірки взагалі — саме це й лагодить §II.7. |
| **Merge conflict-branch → main** (finalize, §III) | Так, через ancestor-check | `isAncestorOf(conflict_head_hash, head_hash)` перед merge (§III, блок FINALIZE) — якщо гілка вже влита, merge не повторюється. |
| **Delete conflict-branch** | Так, 404-толерантно | `deleteBranchIfExists` трактує "гілки вже нема" як успіх, не помилку — крах МІЖ delete і записом на диск не відрізняється від "ще не видаляли" для наступної спроби. |
| **Vault-step запис** (`updateFileInVault`, `saveConflictSiblingFile`) | Так, через `atomicWriteFile`/rename | Запис того самого вмісту вдруге — той самий байтовий результат; крах-recovery для atomic write вже покритий існуючим `AtomicWriteRecovery.sweep` (SYNC2.md §10), новий механізм не потрібен. `readVaultFileInfo`/`last(current_conflict.siblings)` (conflicts, §III) тепер повертають `.blob` одразу — без цього `_diff3()` тут падав би на `LOCAL_FILE_IS_NOT_FOUND_ERROR` при КОЖНОМУ виклику, а не лише при краху. **⚠️ ВИПРАВЛЕНО (2026-08-25, Finding #2, власник — "вирішити раз і назавжди"):** попередня версія мала per-file NETWORK_ERROR-skip-and-continue, і твердження "рядок 7 нижче однаково коректний і для крах, і для мережева помилка" (2026-08-24) було ПОМИЛКОВИМ — graceful skip доходив до епілогу, писав cold baseline і видаляв journal, тому шлях НЕ повторювався наступним drain (відкрите питання, епілог крок 1). Фікс — НЕ латка, а усунення самої розбіжності: NETWORK_ERROR у Vault-step тепер УСЮДИ `return` (5 сайтів: STEP3-гілка-1 blob-fetch, STEP3-гілка-2 `_diff3`, non-manual-conflict `_diff3`, Vault-step-born-конфлікт blob-fetch і device_label-fetch), той самий шлях, що й TOKEN_EXPIRED. Journal тепер ЗАВЖДИ живий, коли epilogue не досягнуто — "graceful" і "крах" для NETWORK_ERROR стали буквально ОДНИМ шляхом, рядок 7 (IV.2) тепер коректний без застереження. Лишається CONFIRMED-lossy NOT_FOUND (repo-corruption клас, §12.5.D) — той skip-and-continue, оскільки retry там не допоміг би: `tracked.base` для такого шляху не просувається, повтор станеться лише коли для нього прийде НОВА remote-зміна (не сам факт "наступний drain") — прийнятно, бо клас події вже некоректний repo-стан, не мережева нестабільність. |
| **Cold baseline-transfer** (епілог крок 1, `writeFileBaseline`) | Так, per-path atomicWrite | Джерело (`TrackedFiles`) НЕ змінюється, доки крок 4 його не видалить — записати той самий шлях тим самим значенням двічі поспіль дає байтово ідентичний результат. Торн зачіпає 1 кошик (§2.2 METAFILE-REFACTOR), не всю мапу. **⚠️ ДОПОВНЕНО (2026-08-25):** крок тепер пропускає (`continue`) будь-який `tracked`, у якого `tracked.remote.sha is null` — плейсхолдер для idle, ще не оновленого цим drain-ом lingering-конфлікту (Seeding, рядок нижче). Без guard-у повтор писав би null поверх РЕАЛЬНОЇ попередньої baseline; сам guard так само ідемпотентний — той самий плейсхолдер при redo дає той самий skip. |
| **conflicts → durable store** (епілог крок 2, `saveConflictsToStore`) | Так, atomicWrite + reconcile обмежений siblings-половиною | `process_conflicts()` (§III прим., повний псевдокод) сканує ФС наново щоразу, але торкається ЛИШЕ `current_conflict.siblings` (по-елементно — §III "TRACKED vs SYNTHETIC") — `current_conflict.conflictBase` завжди переноситься з входу без змін (контракт функції). Повторний виклик при незмінному стані Vault дає той самий результат; сам запис — atomicWrite. Перевірка тепер `conflicts is null` (не `is empty`, §III) — порожня, але ЗАВАНТАЖЕНА мапа (напр. після STEP3 NOT_FOUND-cancel видалив останній запис) НЕ підміняється застарілою durable-копією при redo. ⚠️ Епілог — НЕ єдиний writer цього store: STEP3 replace-транзакція (§II.11, наступний рядок) теж пише `saveConflictsToStore` mid-drain, синхронно всередині Vault-step-циклу (§VI.2 — по-файлова обробка послідовна, гонки немає). |
| **Hot-пара** (епілог крок 3, `persistHotMetadata`) | Так, ping-pong (§2.1 METAFILE-REFACTOR) — АЛЕ ⚠️ семантика `conflictBranch`-поля змінилась, див. нижче | Той самий 2-слотовий протокол, що вже доведений для `cursor-store`/drain-журналу — seq-дискримінатор, читання = максимальний валідний слот. **⚠️ ВИПРАВЛЕНО (2026-08-25):** запис `conflictBranch` тепер = пряме значення локальної `conflictBranchName` (власник її життєвого циклу — виключно FINALIZE, §III), НЕ `(len(conflicts) > 0) ? conflictBranchName : null`. Стара тернарна форма зануляла поле, щойно `conflicts` порожніла ПІЗНІШЕ в тому самому епілозі (крок 2), навіть якщо FINALIZE (виконується РАНІШЕ в drain-і, до Vault-step) ще не підтвердив merge/delete — тихо скасовувало hot-фолбек `restoreTrackedFilesFromDiskOrCreateNewOne` (рядок "Seeding" нижче) для лінгеруючого конфлікту без журналу: `conflictBranchName` там присвоюється ЛИШЕ якщо FINALIZE сам занулив (merge підтверджено/гілки вже нема) — пряме значення тут і фолбек там тепер одне джерело істини, а не два, що можуть розійтись. |
| **Видалення TrackedFiles-журналу** (епілог крок 4) | Так, 404-толерантно | "Вже нема" = success, той самий патерн, що й `deleteBranchIfExists`. |
| **sweep sync_store** (епілог крок 5) | Так, за побудовою (§12.5) — тепер за ЧОТИРМА джерелами `referenced`, останнє — durable `conflicts`-store (SYNC2-FIX.md §12.5.D) | `referenced`-множина рахується заново з диска щоразу; повторний sweep при незмінному стані — той самий результат. Завершеність sweep-у тепер залежить від ДВОХ умов, не однієї: порожня черга (`push_queue/`) І порожній durable `conflicts` — поки живе хоч один manual conflict, його `conflictBase`-blob лишається в `referenced` і НЕ підмітається (§12.5.D) незалежно від того, скільки drain-ів минуло. |
| **STEP3 blob-fetch + NOT_FOUND-cancel** (Vault-step, §III, `previous_sibling is null` гілка) | Так, повним redo Vault-step | Крах ДО завершення епілогу (журнал ще на диску) → наступний запуск повторює Vault-step з нуля для ВСІХ tracked, включно з цим шляхом: те саме `sync_store`→мережа читання, той самий NOT_FOUND (природа помилки не залежить від того, скільки разів її перевіряли), той самий `conflicts.delete` + `is_manual_conflict=false`. Немає проміжного стану, який redo міг би застати "напівскасованим" — обидва присвоєння в ОДНІЙ, не розбитій навпіл ділянці коду, до будь-якого диск-запису цього кроку. |
| **Seeding** (`restoreTrackedFilesFromDiskOrCreateNewOne`, §III) | Так, чиста функція від входу | Вхід — `(журнал-з-диска, durable conflicts-з-диска)`, обидва не змінюються під час виконання функції; вихід — детермінована функція входу (журнал-гілка АБО reconcile-гілка від `conflicts`, без прихованого стану). Повторний виклик з тим самим входом (напр. після краху ДО першого запису епілогу) дає той самий `TrackedFiles`-масив, включно з `base: seeded_remote`-плейсхолдером для idle-шляхів і фолбеком `conflictBranchName = metadata.getConflictBranchName()`, коли журналу нема. |
| **Lazy device_label-fetch** (STEP1 / pull-folding-refresh / Vault-step-born-конфлікт, §III) | Так, read-only | `getCommitDeviceLabelForPath` — чисте GET, без побічних ефектів на repo. Крах ДО чи ПІСЛЯ виклику не залишає проміжного стану, що вимагав би відкату — гірше, що можливо: значення просто перезапитується вдруге при redo. |
| **STEP3 replace-транзакція** (§II.11, mark → новий файл → durable-персист → видалення старого → unmark) | Так, через GUID-звірку + hash-on-load, БЕЗ fsync | `recoverSiblingTransactionIfNeeded()` (§III, крок 0 самого `process_conflicts()` — 2026-08-26, друга ревізія: перенесено з drain()'s кроку 0, покриває всі 4 виклики `process_conflicts()`) відновлює з мітки. Дискримінатор напрямку — ЛИШЕ цілісність нового sibling-файлу (size+SHA, §II.9-стиль, без мережевого fallback-у): валідний → накат ВПЕРЕД з першого недовершеного кроку (3-5), БАЙДУЖЕ, чи metadata вже нова — повного redo Vault-step тут не потрібно взагалі; битий/відсутній → відкат до перед-транзакційного стану (undo `replaceLast`, якщо metadata встигла оновитись — з обов'язковим `lastSiblingTxGuid=null`), прибрати новий файл, unmark. Сама злука (fold) свіжої remote-зміни в цьому кейсі доллється НЕ спеціальним кодом, а вже наявним механізмом — журнал лишається живим, наступний Vault-step повторює fold сам. |

**Передумова, на якій тримаються рядки 1/2 нижче (не мережевий side-effect, а чиста in-memory
реконструкція): reconciliation `is_manual_conflict` при відновленні.** `restoreTrackedFilesFromDiskOrCreateNewOne`
(§III) скидає `is_manual_conflict` для будь-якого шляху, відсутнього у свіжому `conflicts`
(реальний скан ФС від `process_conflicts()`). Без цього STEP2/STEP3 могли б впасти в
неозначену поведінку не лише після краху, а й у ЗВИЧАЙНОМУ випадку "користувач розв'язав конфлікт
між drain-ами" — це не крах-сценарій, але й для нього потрібна явна відповідь, і вона та сама:
довіряти щойно відновленому стану, а не застарілому прапорцю.

**⚠️ ДОПОВНЕНО (2026-08-25): та сама функція seed-ить `is_manual_conflict=true` (не лише скидає
його) для КОЖНОГО шляху в `conflicts`, з placeholder-ним `base`/`remote` (`sha/size/mtime/
device_label/blob = null`, крім `.path`), коли ні журнал, ні свіжий pull цього drain-у не мають
свіжіших даних.** Власник явно виправив раннішу версію, яка пропускала seeding для
шляхів з порожнім `siblings` (§III, "Ти неправомірно вирішив, що можеш вилучати conflict, якщо в
нього порожній siblings?") — порожній `siblings` означає лише "жодного sibling-файлу на диску ще
нема", не "конфлікту нема". Плейсхолдер навмисно НЕ `null` цілком (`base: null` крашив би STEP2 на
першому ж читанні `tracked.base.path`) — обидва поля (`base`/`remote`) вказують на ОДИН і той же
seeded-об'єкт (навмисний alias, інваріант "base≡remote" у режимі конфлікту тримається завжди для
цього стану). Vault-step (STEP3, гілка `previous_sibling is null`) явно перевіряє
`tracked.remote.sha is null` і пропускає ідле-шлях без побічних ефектів — саме це унеможливлює
crash/redo від того, щоб побачити напівзаповнений плейсхолдер: він або лишається null-плейсхолдером
цілком, або вже замінений реальними даними ДО того, як щось інше його прочитає.

### IV.2 Точки краху над послідовністю "один batch"

Кожен рядок — це "де саме стався крах", а не окремий рецепт: відповідь скрізь та сама (redo з `getBatch()`),
і посилається на рядок таблиці вище, який доводить, що це безпечно.

| # | Де стався крах | Що на диску | Що робить рестарт | Безпечно через |
|---|---|---|---|---|
| 1 | Під час R3b claim (§II.8) | `.attempted-commit` і/або `.attempted` можуть лишитись | `getBatch()` виконує crash-recovery гілку (§II.8) | IV.1 рядок 1 |
| 2 | Після claim, ДО будь-якого push | Batch у `push_queue/` незмінний | Повний цикл `_diff3` над файлами batch-у з нуля | Читання ідемпотентне (blob-и content-addressed) |
| 3 | ПІСЛЯ push у MAIN, ДО запису на диск | Remote head УЖЕ рухнувся, локально ще стара `head_hash` | `restart_batch=true` (стартове значення) → свіжий diff бачить власний push як "remote" | IV.1 рядок 3 |
| 4 | ПІСЛЯ push у CONFLICT-BRANCH, ДО запису на диск | Гілка вже містить коміт, `conflicts` на диску застарілий (`conflict_hash` більше не персистується — §II.7) | STEP1/STEP2 знову намагаються пушити той самий шлях | IV.1 рядок 4 (`shouldPushToConflictBranch` бачить SHA вже там) |
| 5 | Між push MAIN і push CONFLICT-BRANCH (для одного batch) | Одна гілка просунулась, інша — ні | Незалежний redo кожної: MAIN-частина йде по рядку 3, CONFLICT-частина — по рядку 4 | Обидва push незалежні (різні refs, §VI) |
| 6 | Під час FINALIZE (merge/delete), ДО запису на диск | Гілка може бути влита і/або видалена, metadata — ні | FINALIZE знову запускається на наступному drain (не в циклі по батчах — виконується щоразу, коли `conflictBranchName != null`) | IV.1 рядки 5-6. **⚠️ ДОПОВНЕНО (2026-08-25):** ця умова тепер ФАКТИЧНО тримається наскрізь, а не лише декларативно — до фіксів "Hot-пара"/"Seeding" (IV.1) `conflictBranchName` міг осиротіти (журнал видалено, hot-поле занулене чужою тернаркою) і FINALIZE перестав би запускатись для лінгеруючого конфлікту без реального merge/delete; тепер джерело істини єдине (FINALIZE — єдиний, хто зануляє), і Seeding-фолбек читає саме його. |
| 7 | Під час Vault-step, ПОСЕРЕД `for tracked in TrackedFiles` **АБО graceful `return NETWORK_ERROR` з того самого циклу** (⚠️ ДОДАНО 2026-08-25, Finding #2 — обидва тепер той самий рядок, не два різні) | Частина файлів у Vault уже оновлена, частина — ні; `TrackedFiles`-журнал ще НЕ видалено (він видаляється лише в самому кінці, п.3 фінального блоку §III) | `for`-цикл виконується заново для ВСІХ tracked-файлів; вже записані — записуються тим самим вмістом вдруге | IV.1 рядок "Vault-step запис" (перезапис того самого — no-op) |
| 8 | ПІСЛЯ Vault-step, ДО видалення `TrackedFiles`-журналу | Vault консистентний, журнал ще існує | Весь Vault-step (п.7) повторюється — безпечно (рядок 7) — і завершується видаленням журналу | IV.1 рядок 7 |
| 9 | Епілог, ПІСЛЯ кроку 1 (cold baseline), ДО кроку 2 (conflicts save) | Частина/усі cold-кошики оновлені; conflicts-store ще старий; журнал існує | Епілог виконується заново з нуля: крок 1 — no-op/довершення (ідемпотентно), крок 2 довершується | IV.1 "Cold baseline-transfer" + "conflicts → durable store" |
| 10 | Епілог, ПІСЛЯ кроку 2, ДО кроку 3 (hot-пара) | Cold + conflicts-store вже нові; hot ще стара; журнал існує | Епілог redo: кроки 1-2 no-op (уже застосовано), крок 3 виконується | IV.1 "Hot-пара" |
| 11 | Епілог, ПІСЛЯ кроку 3, ДО кроку 4 (видалення журналу) | Увесь ПІДТВЕРДЖЕНИЙ стан (cold, store, hot) уже новий; журнал ще на диску | Епілог redo: кроки 1-3 no-op, крок 4 довершує видалення | IV.1 "Видалення TrackedFiles-журналу" |
| 12 | Епілог, ПІСЛЯ кроку 4 (журнал видалено), ДО кроку 5 (sweep) | Журнал відсутній | Наступний `drain()` бачить ПОРОЖНІЙ `TrackedFiles`, черга порожня → одразу епілог: кроки 1-2 no-op (нічого переносити), крок 3 no-op (той самий `head_hash`), крок 4 no-op (уже видалено), крок 5 нарешті виконується. Якщо наступний drain найближчим часом не запуститься — той самий sweep однаково запуститься на onload плагіна (§12.5.C) | IV.1 "sweep sync_store" + §12.5.C onload backstop |
| 13 ⚠️ НОВЕ (2026-08-25) | Епілог, ПІСЛЯ кроку 2 (`conflicts` записано БЕЗ щойно скасованого шляху, §III STEP3 NOT_FOUND-cancel), ДО кроку 4 (журнал ще з прапорцем `is_manual_conflict=true` для цього шляху) | Durable `conflicts` уже без запису; журнал (`TrackedFiles`) ще на диску, ще каже "конфлікт" | Restart перечитує журнал — БАЧИТЬ `is_manual_conflict=true`, АЛЕ Seeding (`restoreTrackedFilesFromDiskOrCreateNewOne`) reconcile-гілка звіряє журнал зі свіжим `conflicts` (той самий скан, що й process_conflicts()) — шляху там уже нема → прапорець скидається сам, без окремого коду. Самолікується тим самим reconciliation, що вже доведений для "передумови рядків 1/2" вище. | IV.1 "Seeding" + "Передумова" вище |
| 14 ⚠️ НОВЕ (2026-08-25) | Між `conflicts.delete(...)` (§III STEP3 NOT_FOUND-cancel, лише в пам'яті) і початком епілогу (крок 2 ще не записав це на диск) | Durable `conflicts` на диску ЩЕ містить скасований шлях; in-memory-стан цього drain-у вже без нього | Крах тут ідентичний рядку 7/8 вище (Vault-step ще не завершився) — redo повторює Vault-step з нуля, доходить до ТОГО САМОГО NOT_FOUND (природа помилки не залежить від спроби), re-cancel-ить ідентично. Немає "часткового" скасування, яке потребувало б окремого рецепта. | IV.1 "STEP3 blob-fetch + NOT_FOUND-cancel" |
| 15 ⚠️ НОВЕ (2026-08-26, §II.11, друга ревізія) | STEP3 replace-транзакція, ПІСЛЯ мітки (крок 1), ДО запису нового sibling-файлу (крок 2) | Мітка на диску; ні новий, ні старий sibling-файл не зачеплені; `conflicts.lastSiblingTxGuid` ще СТАРИЙ (не збігається з міткою) | `recoverSiblingTransactionIfNeeded()`: новий файл ще не існує → `verifySiblingFileIntegrity` = false → НАЗАД. `guidMatches=false` → metadata не займаємо; новий файл прибрати (його й нема — no-op); unmark. Журнал живий, наступний STEP3 перераховує fold з нуля | IV.1 "STEP3 replace-транзакція" |
| 16 ⚠️ НОВЕ (2026-08-26, §II.11, друга ревізія) | Посеред запису нового sibling-файлу (крок 2) — файл частково записаний/бита копія | Мітка на диску; новий файл присутній, але SHA/розмір не зійдуться; `conflicts.lastSiblingTxGuid` ще СТАРИЙ | Той самий шлях, що й рядок 15 — дискримінатор (цілісність нового файлу) провалюється незалежно від того, що каже metadata → НАЗАД: новий файл прибирається (не довіряємо), metadata не займаємо (`guidMatches=false`), unmark, журнал довершить fold | IV.1 "STEP3 replace-транзакція" |
| 17 ⚠️ НОВЕ (2026-08-26, §II.11, друга ревізія) | ПІСЛЯ durable-персисту (крок 3, `conflicts.lastSiblingTxGuid` уже новий), ДО видалення старого sibling-файлу (крок 4) | Мітка на диску; новий файл справжній І зареєстрований; старий файл ФІЗИЧНО ще на диску, але вже НЕ в `siblings`-списку (synthetic) | Новий файл валідний → ВПЕРЕД: `guidMatches=true` → крок 3 вже не потрібен (no-op), лишається довершити ЛИШЕ крок 4 (видалити старий) і unmark, БЕЗ redo Vault-step для цього шляху — саме та властивість, заради якої й писалась ця транзакція | IV.1 "STEP3 replace-транзакція" |
| 18 ⚠️ НОВЕ (2026-08-26, §II.11, друга ревізія) | Між записом валідного нового sibling-файлу (крок 2 повністю успішний) і durable-персистом (крок 3 ще НЕ виконався) — вікно, якого перша версія контракту трактувала як повний rollback+redo | Мітка на диску; новий файл справжній і ПРОХОДИТЬ перевірку; `conflicts.lastSiblingTxGuid` ЩЕ СТАРИЙ (`guidMatches=false`) | Новий файл валідний → ВПЕРЕД, попри те що `guidMatches=false`: `conflicts.set` (реконструкція old+мітка→new) + `lastSiblingTxGuid=mark.guid` + `saveConflictsToStore` (довершує крок 3), потім крок 4 (видалити старий), unmark. Redo Vault-step НЕ потрібен — це і є зміна другої ревізії відносно першої (яка тут форсувала повний rollback) | IV.1 "STEP3 replace-транзакція" |
| 19 ⚠️ НОВЕ (2026-08-26, §II.11, друга ревізія) | ПІСЛЯ durable-персисту (крок 3), ДО видалення старого (крок 4) — новий sibling-файл на диску ВИЯВЛЯЄТЬСЯ битим при відновленні (torn write, реальний ризик без fsync — §II.11), СТАРИЙ файл ще фізично на диску | Мітка на диску; `conflicts.lastSiblingTxGuid` новий, `verifySiblingFileIntegrity` провалюється; старий sibling-файл ще присутній (крок 4 не виконувався) | НАЗАД: `guidMatches=true` → відкат durable-запису на `mark.oldSibling` (undo `replaceLast`, `lastSiblingTxGuid=null`), прибрати биту копію нового, unmark. Старий файл нікуди не діли — журнал живий, наступний Vault-step сам домержить fold для цього шляху, спеціального redo-коду не потрібно | IV.1 "STEP3 replace-транзакція" |
| 20 ⚠️ НОВЕ (2026-08-26, §II.11, друга ревізія) | ПІСЛЯ видалення старого sibling-файлу (крок 4), новий sibling-файл на диску ВИЯВЛЯЄТЬСЯ битим при відновленні (torn write без fsync-гарантії порядку durability МІЖ окремими файлами, тому "новий записався раніше за старий" не гарантовано) | Мітка на диску; `conflicts.lastSiblingTxGuid` новий, `verifySiblingFileIntegrity` провалюється; старого sibling-файлу ТЕЖ немає на диску (крок 4 уже виконався) | НАЗАД: `guidMatches=true` → відкат durable-запису на `mark.oldSibling` (undo `replaceLast`, `lastSiblingTxGuid=null`), прибрати биту копію нового, unmark. Але `mark.oldSibling`-ФАЙЛУ фізично вже немає — метадата вказує в нікуди. `process_conflicts()` (сценарій C.6, "tracked sibling фізично видалений") prune-ить запис із порожнім `siblings`; наступний STEP3 відбудовує ланцюжок з нуля, з першого sibling (`sync_store/`). Деградація (втрата ОДНОГО проміжного sibling-запису), не корупція | IV.1 "STEP3 replace-транзакція"; §II.11 "Рішення власника" |

**Висновок:** для КОЖНОЇ точки краху рецепт один — "продовжити з того самого місця, звідки читає
`getBatch()`/цикл, довіряючи ідемпотентності". Немає жодної точки, що вимагає окремого, унікального
recovery-коду.

### IV.3 `processed_batch`-маркер — оптимізація, НЕ умова коректності

Чорновий псевдокод (§III, "БАТЧ ОБРОБЛЕНО") згадував запис `"processed_batch": "<batch-dirname>"` у
журнал. Матриця вище показує, що коректність цього НЕ потребує — повний redo вже безпечний без нього
(рядки 3-4 таблиці IV.2). Але залишити маркер варто як **оптимізацію**: якщо крах стався між "журнал
записано" і "batch-каталог видалено" (рядок між 3-4 і завершенням), маркер дозволяє рестарту побачити
"цей batch уже позначений оброб­леним" і просто видалити каталог, замість повного redo з мережевими
читаннями — суттєво дешевше на мобільному з обмеженим трафіком. **Явно документується як оптимізація**,
щоб майбутня реалізація не почала покладатись на нього як на єдине джерело істини (якщо маркер
загубився чи застарів — redo без нього все одно коректний, просто дорожчий).

---

## V. Персистентність `TrackedFiles` — ping-pong, не append-log

**Рішення власника (2026-08-23):** реалістичний масштаб — **сотні файлів** за один (навіть
багатоденний) drain, типовий випадок. За такого масштабу журнал `TrackedFiles` переписується
**повністю** щобатч через уже прийнятий 2-slot ping-pong патерн (SYNC2-METAFILE-REFACTOR.md §2,
`tracked-files-{a,b}.json`, keyed на монотонний `seq`, ніколи не пишемо max-seq слот) — той самий
клас проблеми (часті записи, потрібна crash-safety, clock не потрібен), що й hot-метадані, тому
новий rename-протокол не винаходимо.

**Розрахунок розміру (для довідки, не для рішення — рішення вже прийняте):** запис `TrackedFiles`
на шлях ≈ 200-400 байт (path + base{sha,size,mtime} + remote{sha,size,mtime,mode} + прапорець
конфлікту). Сотні файлів × 300 байт ≈ 150 КБ — переписується один раз НА BATCH, а не на файл. Це
на порядки менше за сам мережевий round-trip одного batch-push-а — I/O журналу не є вузьким місцем.

Якщо в майбутньому реальний масштаб виявиться істотно більшим (десятки тисяч файлів за один
відкладений drain), append-log зі стисненням (replay + компакція) стане виправданим — але це
окреме рішення, коли й якщо факти зміняться, не зараз.

---

## VI. Модель паралелізму та швидкодії

Псевдокод у §III написаний послідовним стилем для читабельності, але кроки всередині нього мають
різну природу: частина — це чиста CPU-робота чи мережевий I/O за НЕЗАЛЕЖНИМИ шляхами (паралелити
безпечно й вигідно), частина — послідовна за дизайном (паралелити НЕБЕЗПЕЧНО, а не просто "поки не
робили").

### VI.0 `diff3()` — НЕ на main thread, навіть для ОДНОГО файлу. Це вже вирішено, не нова вимога

Синхронний стиль §III (`d = diff3(base.blob, local.blob, remote.blob)`, звичайний виклик функції)
приховує те, що фактичний виклик 3-way merge **зобов'язаний** іти через CPU worker pool — і це не
паралелізм заради швидкодії (те, про що §VI.1-VI.4 нижче), а окрема, жорсткіша вимога: без цього
merge ВЕЛИКОГО файлу підвішує UI thread, і користувач не може торкнутись Vault, поки один-єдиний
diff3-виклик не завершиться. Це вже архітектурно вирішено в проєкті, не нова ідея для NEW-DRAIN:
`src/worker/cpu-worker.ts` вже виносить `merge-text` (обгортка над `node-diff3`), обчислення SHA і
base64-decode з main thread у CPU worker pool (SYNC2.md §8, `.claude/rules/sync2-engine.md`,
"Stage 4-6 … moved every hot-path CPU operation … off the main thread"). Той самий механізм
застосовний тут без змін — новий алгоритм не міняє, ЩО таке diff3-виклик, лише ЯК drain доходить до
нього.

Це узгоджується з наявним запобіжником: `maximum_auto_merge_file_size` (§II.1, п.9) уже обмежує, які
файли взагалі доходять до `diff3()` — а `SYNC2.md §9` документує ту саму турботу з іншого боку
("single-MB merge cliff still bites… size guard §8.6 covers the worst cases"). Тобто три механізми
(розмір-кап, worker-виконання, size guard) — про одне й те саме занепокоєння, кожен закриває свою
частину: кап не пускає геть величезні файли в merge узагалі, worker гарантує, що ті, які пройшли, не
блокують UI, size guard — запасний рубіж для того, що проскочило повз обидва.

### VI.1 Дві тверді межі

**Межа 1 — між батчами паралелити НЕМОЖЛИВО, не "не можна за принципом", а бракує вхідних даних.**
Rolling-base механізм §II.3 (`tracked.remote = D_n`, щойно запушений вміст батча N — база для
batch-у N+1 того самого шляху) означає: **вхідні дані для diff3 батчу N+1 не існують, поки push
батчу N не підтверджено успішним.** Це не заборона з обережності — це data dependency: немає що
обчислювати наперед, доки немає результату попереднього push-а. (Це також те, що структурно виключає
`crash-gap` зі старого §8.7 п.9 SYNC2-FIX.md — нема попередньо обчисленого стану, який міг би
"розійтися" з реальністю.)

**Межа 2 — побудова `createTree`/`createCommit` відбувається один раз, ПІСЛЯ per-file циклу.**
Усередині ОДНОГО батчу per-file-обробка (§VI.2) тепер послідовна (рішення власника, 2026-08-23 —
див. нижче), тому це не join-бар'єр над паралельними гілками, а просто природний "після циклу":
per-file обробка (по одному) → `createTree`+`createCommit` (один раз, коли цикл завершився).

### VI.2 Що всередині одного батчу — ПОСЛІДОВНЕ, і чому

⚠️ **Per-file обробка (`_diff3`, blob-завантаження/вивантаження) — ПОСЛІДОВНА, НЕ `Promise.all`**
(рішення власника, 2026-08-23 — коригує ранішу чернетку паралелізму нижче). Blob-завантаження
(`getBlobFromRepo`) і вивантаження (`saveBlobToGitHub`) тримають вкладення в пам'яті, а в цьому
проєкті вони вже бувають 2-50 МБ. Фан-аут `Promise.all` над batch-ем із 40-50 файлів (навіть під
семафором 3-6, як розглядалось раніше) означає до 6 таких вкладень одночасно в пам'яті мобільного
WebView — і саме тут, а не в мережевих rate-limits, реальний ризик OOM на слабкому пристрої.
**Кожен файл проходить свій повний конвеєр (blob-load → diff3 → upload) до кінця, перш ніж
починається наступний.** Повільніше за N файлів, зате пікова пам'ять — O(1 файл), не O(N). Частковий
провал (файл дав NETWORK_ERROR) так само абортує ВЕСЬ batch (I4 — транзакція) — файли, оброблені
ДО цього в тій самій послідовності, могли вже встигнути залити blob, це нешкідливо
(content-addressed, IV.1) і буде переиспользоно на повторі.

Це ж усуває потребу в §VI.4 п.1-2 нижче (семафор і in-flight promise cache для SHA-колізії) —
обидва вирішували проблеми, що існують ЛИШЕ за конкурентного доступу; без фан-ауту всередині
batch-у й проблем нема (див. §VI.4).

- **Push у MAIN ∥ push у CONFLICT-BRANCH** — незалежні git-ref, паралельно безпечно (обидва
  ідемпотентні під фіксами §II.7, IV.1). **Один задокументований наслідок:** conflict-branch —
  per-device (названа з `deviceLabel`), тож НАШИМ плагіном туди ніколи не потрапляє коміт з
  іншої машини (лише вручну, через git CLI/web — поза цим аналізом). Але якщо MAIN зловив 422,
  рестарт перечитує СВІЖИЙ MAIN (інший пристрій запушив ТУДИ) і заново прогонить `_diff3` для
  цього шляху проти нового remote — і ця нова спроба може вже НЕ класифікувати шлях як
  MANUAL_CONFLICT (rolling base зрушив). Коміт із попередньої (передкрахової) спроби лишається
  в conflict-branch "осиротілим, але reachable". Нешкідливо
  ([[feedback-preserve-all-commits]] це навіть схвалює), і finalize (§III) все одно зіллє
  гілку — але варто знати, а не "виявити" пізніше як баг.
- **Читання голів на старті `restart_batch`-циклу** (MAIN head+diff, CONFLICT head+diff) — дві
  незалежні пари запитів, паралельно замість послідовно.
- **Vault-step, `updateFileInVault` для РІЗНИХ шляхів** — незалежні файли, паралельно безпечно (бар'єр
  тримає лише сам `atomicWriteFile` per-path).

### VI.3 Що ЗАЛИШАЄТЬСЯ послідовним усередині батчу — і чому

- **Створення conflict-sibling файлів** (Vault-step) — НЕ path-локальне: `ConflictStore.create`
  робить content-based скан осиротілих sibling-файлів по всьому vault ПЕРЕД створенням нового
  (пам'ять [[project-conflict-dedup-content-based]]), і кожне створення мутує СПІЛЬНИЙ
  conflict-metadata файл. Серіалізація тут майже безкоштовна — конфлікти рідкісні відносно
  загальної кількості файлів — і рятує від доведення "конкурентний скан проти конкурентного запису"
  в матриці IV.

### VI.4 Огороджувальні умови (без них паралелізм ламає, а не пришвидшує)

⚠️ **Пункти 1-2 попередньої редакції (семафор 3-6, in-flight promise cache для SHA-колізії) —
СКАСОВАНО (2026-08-23), не звужено.** Обидва вирішували проблеми конкурентного доступу всередині
batch-у, а per-file обробка тепер послідовна (§VI.2) — конкуренції, яку вони закривали, просто
нема: один шлях обробляється, а не N одночасно, тож два шляхи з однаковим SHA НІКОЛИ не пишуть у
`sync_store/{sha}` в один момент (другий застає результат першого вже готовим). Залишається
рівно одна огороджувальна умова:

1. **Передумова, на якій тримається безпека спільних акумуляторів (`commit`, `conflict_commit`,
   `TrackedFiles`)** — **один шлях зустрічається щонайбільше раз в одному батчі.** За послідовної
   обробки це вже не питання потокобезпеки (нема конкурентного доступу взагалі), а простіше:
   якби той самий шлях трапився в одному batch двічі, другий запис тихо перезаписав би перший у
   `TrackedFiles`/`commit`, і перша версія загубилась би без помилки. Це не припущення "напевно
   так" — це названа передумова моделі, яку варто звірити з `push-queue.ts` (чи справді
   `enqueue`/`consolidateCommits=false` гарантує, що той самий шлях ніколи не потрапляє в ОДИН
   batch двічі), а не мовчки покладатись на неї.

Паралелізм між РІЗНИМИ batch-ами лишається неможливим за конструкцією (§VI.1, Межа 1 — rolling
base); паралелізм між MAIN-push/CONFLICT-push і між парами head-читань (§VI.2 нижче) — по 2
незалежні операції, фіксований, малий фан-аут, семафора не потребує.

---

## VII. Відкриті питання

1. **⚠️ ПІДТВЕРДЖЕНО (2026-08-23) — GitHub Compare API обрізає `files[]` на 300 файлах, і БЕЗ ЖОДНОГО
   сигналу, що обрізання сталось.** Перевірено проти офіційної документації GitHub REST API
   (`GET /repos/{owner}/{repo}/compare/{basehead}`, розділ "compare two commits"):
   - **Ліміт — 300 файлів, і лише на ПЕРШІЙ сторінці пагінації.** Дослівно з документації: "The list
     of changed files is only shown on the first page of results, and it includes up to 300 changed
     files for the entire comparison." Понад цей поріг `files[]` просто не містить решти шляхів —
     без винятку, без помилки.
   - **У відповіді НЕМА поля-прапорця truncation.** Схема відповіді: `url`, `html_url`,
     `permalink_url`, `diff_url`, `patch_url`, `base_commit`, `merge_base_commit`, `status`,
     `ahead_by`, `behind_by`, `total_commits`, `commits[]`, `files[]`. Жодне з них не сигналізує
     "files обрізано" — `files.length === 300` і "рівно 300 файлів дійсно змінилось" НЕВІДРІЗНИМІ
     без стороннього знання про ліміт.
   - **`client.compare()` (`src/github/client.ts:708`) сьогодні не має жодного захисту** — ані
     перевірки на `files.length`, ані пагінації, ані фолбеку. `sync2-manager.ts:1220-1221` споживає
     `cmp.files` напряму.
   - **Наслідок для нового drain, конкретно:** сценарій "дні чи тижні без мережі" (§II) — саме той,
     де base→head вікно найширше і 300-файловий поріг найімовірніший — призводить до **мовчазної
     втрати частини remote-змін**: шлях, що випав з `files[]`, ніколи не потрапляє в `TrackedFiles`,
     `base` просувається до нового `head_hash` так, ніби цей шлях synced, і той remote-контент
     ігнорується назавжди (I2-класу дефект, тихіший за G9, бо нема навіть конфлікту — просто мовчання).
   - **Це блокує реалізацію `getChangedFilesFromGitHubRepo`**, доки не обрано підхід: (а) пагінація
     через `commits[]` + per-commit diff замість покладання на `files[]`, (б) виявлення "можливо
     обрізано" через `files.length >= 300` як консервативний сигнал і фолбек на дорожчий, але повний
     механізм (напр. порівняння дерев напряму), (в) інше. Рішення — власника, не моє.
2. **Delete-mid-drain семантика — ВИРІШЕНО (2026-08-23).** Файл, видалений з Vault, поки drain ще
   тривав, трактується у Vault-step як `local.mode=DELETED`, не як `null` (§II.6, Vault-step у §III).
   Конфлікт можливий (правило 8.b), якщо remote за цей час теж змінився; тихе видалення (правило 5),
   якщо ні. Записано тут, щоб не переглядалось повторно.
3. **Масштаб `TrackedFiles` — ВИРІШЕНО (2026-08-23).** Сотні файлів за один drain — типовий випадок
   (§V). Ping-pong journal достатній; append-log НЕ реалізовувати, доки цей факт не зміниться.
4. **Timestamp у назві conflict-sibling-file — ВИРІШЕНО (2026-08-23).** Завжди `tracked.remote.mtime`
   (дата remote-коміту на GitHub), НІКОЛИ не момент запису на диск. Раніше §II.6 STEP3 казав
   "з власним timestamp" — це була реальна розбіжність із §III (не-конфліктна гілка Vault-step),
   а не два законних випадки; виправлено в обох місцях (§II.6 прозі та §III STEP3 псевдокоді,
   явним `merged_sibling.mtime = tracked.remote.mtime` перед збереженням, бо `_diff3()` завжди
   повертає `mtime=null` для свіжозлитого результату).
5. **mtime-інваріант для `tracked.remote` + ім'я `D` розведено — ВИРІШЕНО (2026-08-23, за наводкою
   advisor, двома раундами).** §III мав ДВІ різні змінні `D` в різних циклах (main-loop
   push-результат і Vault-step sibling-результат) з однаковою назвою — власник прочитав це як
   суперечність із п.4 вище. Раунд 1: Vault-step `D` перейменовано на `merged_sibling` /
   `vault_result` — усуває колізію імен структурно.
   Раунд 2 — власник слушно засумнівався: "чи ми дійсно маємо зберігати push-time, а не час
   remote-коміту від пристрою-автора?" Перевірка pull-шляху (§III цикл "for file in remote_files",
   `tracked_file.remote.mtime = file.mtime`) показала: там mtime — це `file.mtime` з
   `getChangedFilesFromGitHubRepo()`, АВТОРИТЕТНА дата з GitHub API, не локальний здогад. Перший
   фікс (`main_push_time = now()`) був асиметричним — локальний годинник замість того самого
   джерела істини. Виправлено: `pushCommit()` тепер повертає `(new_head_hash, committed_at)`,
   де `committed_at` = `committer.date` з відповіді GitHub Create-Commit API (та сама відповідь,
   яку функція і так парсить заради sha); `main_push_tracked` після підтвердженого успіху
   проставляє САМЕ це значення, не `now()`. Крім симетрії з pull-шляхом, це закриває crash-
   consistency діру: якщо drain впаде ПІСЛЯ успішного push, ДО персисту TrackedFiles, рестарт
   підбере той самий коміт через pull-folding і отримає те саме значення з Compare API — з
   `now()` шлях-без-краху і шлях-з-крахом дали б РІЗНИЙ mtime для того самого вмісту, з
   `committed_at` вони byte-ідентичні. `conflict_commit`-шлях (`client.pushCommit(...)`, рядок
   ~1421) отримав той самий `(hash, committed_at)`-контракт для узгодженості, але
   `committed_at` там свідомо ігнорується (`_`) — conflict-branch вміст на sibling-timestamp не
   впливає (§II.7: `conflicts` звіряється лише по sha). Інваріант тепер строгий, без
   винятків і без локального годинника: `tracked.remote.mtime` = дата GitHub-коміту, який дав
   цей вміст, хто б його не пушив. Закриває TODO, що висів на цьому рядку з чернетки.

---

## VIII. Чек-лист тестових сценаріїв для TDD-розробки `drain()`

**Мотивація (2026-08-25):** реалізація нового `drain()` починається з тестів, не з коду
(CLAUDE.md §4, "Test-first where you can"). Базою слугує `tests/integration/scenarios/sync2/
multi-device/G9-concurrent-push-mid-drain.test.ts` — діагностичний тест, який **відтворив
реальний clobber-баг** у поточному (старому) двигуні: `C7..C10` тихо затирають конкурентні
remote-зміни `note7..note10`, без жодного конфлікту, стан не самозцілюється навіть після 2
повторних `syncAll`. Цей та подібні сценарії (нижче, категорія M) — контракт, який новий
`drain()` МУСИТЬ задовольняти, на відміну від старого.

**Дворівнева стратегія:** швидкий unit-рівень (fake GitHub-клієнт, без мережі, основний TDD-
цикл для самої логіки — `_diff3`, rolling base, conflict-siblings, NETWORK_ERROR-аборт,
seeding) + рідший integration-рівень (реальний GitHub, підтвердження контракту й регресія
відомих дефектів на кшталт G9). Категорія — це НЕ порядок виконання; починати варто з
категорії A (`_diff3`) — вона чиста функція, найдешевша, і все інше в §III на ній стоїть.

### A. `_diff3()` — чиста функція, правила 1-9 (§II.1, §III) — unit, без мережі

26 сценаріїв, по одному на кожне правило + edge-case:
1. `base=null`, тільки local → local (правило 1.a)
2. `base=null`, тільки remote → remote (1.b)
3. `base=null`, local + `remote=deleted` → local (1.c)
4. `base=null`, `local=deleted` + remote → remote (1.d)
5. `base=null`, `local==remote` (однаковий вміст) → цей вміст, без конфлікту (1.e)
6. `base=null`, `local==remote==deleted` (обидва видалили) → deleted, без конфлікту (1.e, окремий випадок)
7. `base=null`, `local≠remote`, обидва not-null → MANUAL_CONFLICT (правило 2 — справжня колізія)
8. `base=A local=A remote=A` → A, без push (правило 3)
9. `base=A local=A remote=B` → B, чистий pull (правило 4)
10. `base=A local=B remote=A` → B, чистий push (правило 5)
11. `base=A local=B remote=B` → B, обидва погодились (правило 6)
12. `base=A local=null remote=null` → A (7.a, null сприймається як base)
13. `base=A local=B remote=null` → B (7.b)
14. `base=A local=null remote=B` → B (7.c)
15. `base=A local=B remote=deleted` → B перемагає (8.a, local-edit-vs-remote-delete)
16. `base=A local=deleted remote=B` → MANUAL_CONFLICT (8.b, local-delete-vs-remote-edit — АСИМЕТРІЯ з 15, критичний тест)
17. `base=A local=deleted remote=deleted` (обидва видалили) → deleted, без конфлікту (сентинел-рівність, правило 3/6)
18. `maximum_auto_merge_file_size` менший за `max(local.size, remote.size)` → MANUAL_CONFLICT, НАВІТЬ якщо звичайний diff3 зійшовся б без конфлікту (правило 9)
19. `maximum_auto_merge_file_size=0` → diff3 взагалі не викликається, кожна пара, що відрізняється, стає конфліктом
20. шляхи `base.path`/`local.path`/`remote.path` розходяться → `COMPARE_WRONG_FILES`
21. `local.blob` відсутній і не відновлюється з `sync_store/` → `LOCAL_FILE_IS_NOT_FOUND_ERROR`
22. `remote.blob` відсутній у `sync_store/`, довантажується мережею успішно → результат коректний, blob збережено в `sync_store/`
23. `remote.blob` NOT_FOUND і в `sync_store/`, і на GitHub → `REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR`
24. `base.blob` NOT_FOUND і в `sync_store/`, і на GitHub → `BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR`
25. NETWORK_ERROR/TOKEN_EXPIRED під час догрузки `remote.blob`/`base.blob` — коректно пропагуються, а не ковтаються
26. успішний diff3-merge отримує свіжий SHA, зберігається в `sync_store/` лише якщо там ще нема, `mtime=null` (§II.6, "файл не закомічено")

### B. Rolling-base / chaining (§II.3-II.5) — unit з fake GitHub-клієнтом

1. Ланцюжок `C1..Cn` без remote-змін (§II.4): кожен `D_i = C_i`, база просувається щоразу
2. Ланцюжок з ОДНІЄЮ remote-зміною посеред (§II.3): diff3 на кожному кроці проти "remote" = попередній `D`
3. ERROR422 mid-chain: приклад "C4" з доку — рестарт з реальним pull, підстановка справжнього remote замість застарілого `D`, ланцюжок продовжується коректно
4. Crash-after-successful-push-before-persist (усі 3 варіанти II.3/II.4/II.5): рестарт через pull-folding бачить власний push як "remote", повторний push НЕ відбувається (byte-identical drop)
5. Тільки remote-зміни, `push_queue/` порожній (§II.5): TrackedFile заміщується безумовно, push не потрібен, `base = R_n`
6. Remote-only сценарій, під час якого з'являється local batch → перехід на гілку §II.3 всередині ОДНОГО drain-у
7. Vault-step, `base==remote` (не було remote-змін) → Vault не чіпається
8. Vault-step, `base≠remote`, diff3 OK → Vault оновлюється до злитого результату
9. Vault-step, локальний файл видалено з Vault ПІД ЧАС drain-у (`local.mode=DELETED`, не `null`) → тихе видалення (правило 5) якщо remote не змінився, MANUAL_CONFLICT (8.b) якщо змінився

### C. Manual Conflict lifecycle (§II.6) — 21 сценарій

1. STEP1: конфлікт народжується з `_diff3` ERROR → `conflicts.set(path, {conflictBase, siblings: []})`, push у conflict-branch, `base=remote=R_m`, `is_manual_conflict=true`
2. STEP2: файл уже в конфлікті, новий local edit → push у conflict-branch з dedup (той самий SHA, що вже в `conflictBase` → пуш пропускається)
3. STEP2: pull безумовно заміщує remote-половину, поки в конфлікті (blob НЕ довантажується eagerly)
4. STEP3, випадок "ще не був у конфлікті цього drain-у" (`siblings==[]`): `base(R_last)` зберігається як перший sibling-файл, base-file у Vault не чіпається
5. STEP3, випадок "sibling уже є" + diff3 OK: старий sibling замінюється новим (довжина списку та сама)
6. STEP3, випадок "sibling уже є" + diff3 ERROR: новий sibling ДОДАЄТЬСЯ (список росте), старий лишається tracked
7. Ім'я sibling-файлу (`buildSiblingFilePath`) завжди береться з `tracked.remote.mtime` — НІКОЛИ момент запису на диск
8. STEP3 NOT_FOUND при `siblings==[]` → скасування `is_manual_conflict`, видалення запису з `conflicts`
9. STEP3 NOT_FOUND при `siblings≠[]` → лише skip, без скасування (інші tracked siblings лишаються)
10. Третій сайт народження конфлікту (Vault-step, не-конфліктна гілка, `_diff3` повертає MANUAL_CONFLICT): `conflictBase=tracked.remote`, `siblings=[tracked.remote]`, `is_manual_conflict=true`
11. Idle lingering-конфлікт (`tracked.remote.sha==null`, нема свіжого pull цього drain-у) → Vault-step чисто пропускає, без побічних ефектів
12. Кілька drain-ів поспіль, кожен додає ще один sibling при ERROR → список росте коректно, порядок = append-order = порядок за mtime
13. `device_label` заповнюється на ВСІХ 3 сайтах народження конфлікту (STEP1, pull-folding-refresh, Vault-step-born) і НЕ для звичайних (не-конфліктних) файлів
14. **STEP3 replace-транзакція (§II.11), щасливий шлях:** мітка → новий sibling → durable-персист (`lastSiblingTxGuid`) → видалення старого → unmark — увесь ланцюжок відбувається, старий файл справді зникає, новий справді tracked
15. **Крах/аборт МІЖ міткою (крок 1) і повноцінним записом нового sibling-файлу (крок 2)** — новий файл ще не з'явився, або з'явився частково биту-копію — дискримінатор (`verifySiblingFileIntegrity`) провалюється НЕЗАЛЕЖНО від стану metadata → НАЗАД: metadata не займаємо, новий файл прибирається (якщо є), unmark, журнал довершить fold наступним drain-ом
16. **⚠️ Друга ревізія (2026-08-26): крах ПІСЛЯ повного і валідного запису нового sibling-файлу (крок 2), АЛЕ ДО durable-персисту (крок 3)** — `verifySiblingFileIntegrity` ПРОХОДИТЬ, `conflicts.lastSiblingTxGuid` ще старий (`guidMatches=false`) → ВПЕРЕД попри це: перша версія контракту тут форсувала повний rollback+redo, друга — дискримінатор лише цілісність файлу, тому просто довершує крок 3 (реконструкція old+мітка→new) і крок 4, БЕЗ redo Vault-step
17. **Крах ПІСЛЯ durable-персисту (крок 3), ДО видалення старого (крок 4)** (`lastSiblingTxGuid` уже новий, новий sibling-файл справжній) → ВПЕРЕД, крок 3 вже no-op → відновлення довершує ЛИШЕ крок 4, БЕЗ redo Vault-step для цього шляху
18. **Новий sibling-файл виявляється битим при відновленні, СТАРИЙ фізично ще на диску** (крок 4 не виконувався) → НАЗАД: відкат durable-запису на старий sibling (undo `replaceLast`, `lastSiblingTxGuid=null`), бита копія прибирається, unmark. Сама злука (fold) свіжої remote-зміни НЕ відновлюється тут спеціальним кодом — журнал живий, наступний Vault-step сам повторює fold для цього шляху
19. **⚠️ НОВИЙ (2026-08-26, друга ревізія): новий sibling-файл битий ПРИ відновленні, І старий ТЕЖ фізично відсутній** (крах ПІСЛЯ видалення старого, крок 4, + torn новий — без fsync немає гарантії порядку durability МІЖ окремими файлами) → НАЗАД відкочує metadata на `mark.oldSibling`, але сам файл цей уже видалено — метадата вказує в нікуди → `process_conflicts()` (сценарій C.6) prune-ить запис, наступний STEP3 відбудовує ланцюжок з нуля, з першого sibling (`sync_store/`) — деградація (втрата ОДНОГО проміжного sibling-запису), не корупція
20. **Крах ПОСЕРЕД самого recovery** (мітка з попереднього краху вже читається вдруге — сам `recoverSiblingTransactionIfNeeded()` не встиг завершитись): і forward-гілка (крах між `removeFromVaultIfExists(oldSibling)` і `deleteSiblingTransactionMark()`), і backward-гілка (крах між `saveConflictsToStore` з обнуленим `lastSiblingTxGuid` і `deleteSiblingTransactionMark()`) — за повторного виклику дають ТУ САМУ гілку детерміновано (дискримінатор — цілісність файлу, яка не змінюється між спробами; `lastSiblingTxGuid` явно обнуляється при backward, §II.11) і завершуються без побічних ефектів
21. **`verifySiblingFileIntegrity` — size-first short-circuit:** розбіжність розміру дає `false` без читання й хешування байтів (той самий принцип, що й `getBlobFromSyncStore`, §II.9)

### D. Крах-відновлення / ідемпотентність (§IV.1-IV.2) — 12+2+6 точок краху

Крах під час: R3b claim; після claim до будь-якого push; після MAIN push до диску; після
CONFLICT-BRANCH push до диску; між MAIN і CONFLICT push; під час FINALIZE до диску; посеред
Vault-step циклу; після Vault-step до видалення журналу; кожен з епілог-переходів 1→2, 2→3,
3→4, 4→5. Плюс 2 нові вікна навколо сьогоднішнього STEP3 NOT_FOUND-cancel фіксу: крах між
`conflicts.delete()` (у пам'яті) і епілог-кроком 2; крах між епілог-кроком 2 (durable вже без
запису) і кроком 4 (журнал ще з прапорцем) — має самолікуватись через RECONCILE. Плюс 6 вікон
STEP3 replace-транзакції (§II.11, IV.2 рядки 15-20 — sibling-driven контракт, друга ревізія
2026-08-26): кожна фазова межа мітка→новий файл→durable-персист→видалення старого→unmark, і
окремо деградаційний випадок "обидва sibling-файли втрачені" (рядок 20).

### E. Уніфікація NETWORK_ERROR (сьогоднішній фікс, 2026-08-25) — ПРІОРИТЕТ, ще не верифіковано тестами

1. Усі 5 Vault-step NETWORK_ERROR-сайтів абортують ВЕСЬ drain (той самий шлях, що й TOKEN_EXPIRED) — параметризований тест на кожен сайт
2. NOT_FOUND-сайти (підтверджено відсутні дані, не мережева помилка) лишаються вузьким skip/cancel, НЕ абортом
3. device_label NETWORK_ERROR на STEP1 абортує весь drain
4. device_label NETWORK_ERROR на pull-folding-refresh абортує весь drain
5. device_label NETWORK_ERROR на Vault-step-born-конфлікт сайті абортує весь drain (консистентність усіх 3 сайтів)
6. `retryOnNetworkError`: вичерпання `MAX_ATTEMPTS` з експоненційним backoff, запис `.runtime/sync_network_error`
7. `retryOnNetworkError`: TOKEN_EXPIRED/ERROR422 НЕ ретраяться, повертаються одразу
8. Відновлення мережі посеред drain-у: мітка знімається на ПЕРШОМУ успішному виклику, не на старті drain-у

### F. `sync_store/` та sweep (§II.9, SYNC2-FIX.md §12.5) — 9 сценаріїв

1. hash-on-load: розбіжність `size` → бита копія, `null`, без спроби читання (дешевий fail)
2. hash-on-load: `size` збігається, SHA після читання — ні → бита копія, `null`
3. hash-on-load: `verified_shas` кеш уникає повторного хешування того самого SHA за один drain
4. `existInSyncStore`: лише stat+size, без хешу (дешевий dedup fast-path)
5. Sweep: `candidates \ referenced`, 4 джерела перевірені НЕЗАЛЕЖНО:
   - blob з metadata батчу в черзі переживає sweep
   - blob з `baseSha` журналу переживає sweep ("ours став theirs")
   - blob, який drain зараз тримає "в обробці", переживає sweep
   - **blob `conflictBase` незавершеного manual conflict переживає sweep через ДОВІЛЬНУ кількість проміжних drain-ів (§12.5.D, сьогоднішній фікс)**
6. Sweep: щойно конфлікт розв'язується — його `conflictBase`-blob підмітається НАСТУПНИМ sweep-ом (більше не захищений)
7. Sweep запускається в 3 точках (старт drain-у, кінець drain-у, onload плагіна) з тією самою формулою `referenced`
8. `local`-blob відсутній у `sync_store/` → ремонт з Vault, якщо SHA збігається; інакше шлях пропускається (не помилка)
9. `remote`/`base`-blob відсутній у `sync_store/` → перекачується з GitHub, зберігається назад

### G. Crash-safe запис у conflict-branch (§II.7) — 8 сценаріїв

1. `shouldPushToConflictBranch`: журнал підтверджує той самий SHA → push пропускається, без мережі
2. `shouldPushToConflictBranch`: журнал не підтверджує, `conflict_head_hash is null` (гілки ще нема) → push
3. `shouldPushToConflictBranch`: журнал не підтверджує, жива перевірка знаходить той самий SHA на ref → push пропускається (crash-recovery випадок)
4. `shouldPushToConflictBranch`: жива перевірка знаходить інший SHA або 404 → push
5. Ім'я гілки персистується в журнал ДО першого мережевого виклику, що її торкається
6. `conflictBranchName` переживає МІЖ-drain'ові рестарти без journal через hot-metadata фолбек
7. FINALIZE запускається лише коли `conflictBranchName != null` І `len(conflicts) == 0`
8. FINALIZE: ancestor-check ідемпотентність (гілка вже влита → лише delete) + 404-як-success (гілку вже видалено)

### H. `getBatch()`/R3b claim-протокол (§II.8) — 6 сценаріїв

Пітерсонів протокол (commit claims dir, drain чекає); TOCTOU-вікно (drain ставить `.attempted`
рівно тоді, коли commit заявляє права); crash-recovery ремонт (size-перед-SHA); unrepairable
entry випадає з batch-у, решта продовжує; batch, у якого ВСІ entries випали після ремонту →
пропускається повністю (§11 П11, empty-batch skip).

### I. `process_conflicts()` дедуп TRACKED vs SYNTHETIC (§III) — 9 сценаріїв

1. tracked і synthetic з однаковим SHA в одній групі → tracked завжди переважає
2. кілька tracked-дублікатів → виживає найновіший, решта видаляється і з диска, і зі списку
3. кілька synthetic-дублікатів (без tracked у групі) → виживає найновіший за timestamp
4. SHA sibling-файлу збігається з SHA поточного base-file → auto-resolve, ОДНАКОВО для tracked і synthetic
5. користувач переносить base-file РАЗОМ з sibling-файлом в інший каталог → стає "synthetic"-парою за новим шляхом, резолюція (п.4) все одно спрацьовує (сценарій, явно описаний у документі)
6. tracked sibling фізично видалений користувачем (не через збіг SHA) → прибирається зі списку без додаткових дій
7. **`conflicts.delete(path)` лише на переході непорожній→порожній, НІКОЛИ коли список був порожній на вході** (регресія, сьогоднішній фікс — інакше свіжий STEP1-запис зникав би щоразу при 422-рестарті)
8. **`conflicts is null` (перезавантажити з диску) відрізняється від `conflicts is {}`** (регресія, сьогоднішній фікс — інакше STEP3 NOT_FOUND-cancel воскресав би скасований запис)
9. `process_conflicts()` викликається з 4 різних місць (onload, відкриття diff-panel, вихід з diff-editor, старт drain-у) — той самий контракт кожного разу

### J. `restoreTrackedFilesFromDiskOrCreateNewOne` — 7 сценаріїв

1. Журнал присутній (crash recovery) → `TrackedFiles`+`conflictBranchName` відновлені дослівно
2. Журналу нема, `conflicts` непорожній (лінгеруючий, без краху) → `conflictBranchName` бере hot-metadata фолбек, НЕ `null`
3. **Seeding для шляху з порожнім `siblings`** — все одно `is_manual_conflict=true` (регресія — "порожній siblings ≠ нема конфлікту")
4. **Плейсхолдер seeding НЕ пише `base: null`** — alias-об'єкт `{path,sha:null,...}` в обох полях (регресія — інакше STEP2 падає на `null.path`)
5. Seeding НЕ перезаписує вже наявний у журналі прогрес цього ж drain-у для того самого шляху
6. RECONCILE: `is_manual_conflict==true`, але шлях відсутній у свіжому скані → прапорець скидається, з логом (легітимне зовнішнє розв'язання)
7. RECONCILE НЕ спрацьовує для конфлікту, що просто ще не дійшов до STEP3 (`siblings==[]` в процесі, не "розв'язано")

### K. Наскрізні сценарії матриці відновлення (§IV.2) — integration-рівень

1. Повний drain з ін'єктованим крахом У КОЖНІЙ задокументованій точці по черзі — збіжність до того самого фінального стану, що й без краху
2. 422-CAP: 5 поспіль 422 без жодного успіху між ними → `TOO_MANY_CONCURRENT_PUSHES`, чистий вихід, нічого не втрачено

### L. Модель паралелізму (§VI) — 3 сценарії

Послідовна per-file обробка всередині batch-у (пікова пам'ять O(1 файл) навіть на великих
вкладеннях); той самий шлях ніколи не трапляється двічі в одному batch (інваріант
`push_queue/`); MAIN∥CONFLICT-BRANCH push безпечні незалежно один від одного (різні refs).

### M. Відомі/відтворені дефекти — регресійні тести "чому ми це робимо"

1. **G9 clobber** (`tests/integration/scenarios/sync2/multi-device/G9-concurrent-push-mid-drain.test.ts`, відтворено 2026-08-25) — конкурентна remote-зміна `note7..note10` під час push `C6` НЕ повинна тихо затиратись `C7..C10`; має дати конфлікт або коректний merge, ніколи мовчазну втрату даних. **Це головний контракт-тест, який новий `drain()` мусить пройти, а старий — провалює.**
2. Той самий корінь, інша назва — chaining пропускає per-batch pull / fast-path пропускає reconcile (SYNC-FIX "defect A")
3. commit/drain race (R3b) — покрито категорією H, але вартий і власного top-level регрес-тесту
4. Stale head-read (SYNC2 §7.10) — eventually-consistent GitHub head read, "власні дані як конфлікт" — chaining + монотонний guard + 422-retry мусять це запобігати

### N. Заблоковано — НЕ писати GREEN-тест, лише зафіксувати сценарій

1. **§VII.1, Compare API 300-файлів truncation** — рішення власника про підхід (пагінація через `commits[]`, сигнал `length>=300`, чи інше) ще НЕ прийнято; тест написати, коли підхід обрано
2. Чи досі актуальний відкладений епілог-крок-1 baseline-запис для NETWORK_ERROR-пропущених Vault-файлів (стара "Finding #2, не чіпати зараз") тепер, коли NETWORK_ERROR більше не доходить до епілогу взагалі — імовірно вже само закрилось, варто перепитати власника перед написанням тесту