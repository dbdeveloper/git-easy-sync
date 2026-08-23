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
    1. в metadata зберігається остання дата local commit `lastCommitMtime` (watermark). Шукаємо в Vault всі файли
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

   **Примітка (2026-08-23): це сканування — сторона `[commit]`/`findChanges`, НЕ `drain2()`.** П.2
   описує, як формуються batches, які ЗГОДОМ бачить drain — сам `drain2()` (§III) ніколи не сканує
   Vault на предмет "що змінилось", він лише читає вже готові `{path,sha,size}` з batches у
   `push_queue/` (§II.8). Тому це правило свідомо відсутнє в псевдокоді §III — не пропуск, а межа
   відповідальності: commit і drain — окремі процеси (`.claude/rules/sync2-engine.md`).

   **Правило size-перед-SHA — ЗАГАЛЬНЕ, не лише для цього сканування.** П.2-3 — один з проявів
   принципу, вже зафіксованого системно в SYNC-FIX.md §12.9 ("Двоступеневе порівняння — спершу size,
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
   сервері у форматі приблизно `{path, sha, size}`
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

2. під час drain створюємо поле файлів, що змінюються. Ці файли проходять послідовно через усі commit_push, за потреби,
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
процесу як самостійний файл, або ініціюють конфлікт, після чого вже втрачають свою важливість.

Отже, все починається зі створення TrackedFile. TrackedFile створюється з meta-info remote file (файлу, зміненого на
сервері). Таким чином, знаючи `base_head_hash` і `the_newest_remote_head_hash`, ми можемо отримати список змінених
в remote repo файлів. Саме ці файли й стають нашим списком TrackedFiles на початку drain.

Важливо! TrackedFiles переживають збій (зберігаються після кожного успішно-обробленого batch), тому при наповненні
TrackedFiles meta-info remote files з repo, як вказано в абзаці вище, після відновлення може виявитись, що ці файли
вже присутні в TrackedFiles. Тоді ці файли замінюються в відновленому з диску TrackedFiles залежно від стану, в якому
перебуває файл (нормальний, файл в конфлікті).

Наступною особливістю є те, що далі ми скануємо всі файли кожного batches і порівнюємо ці локальні файли з файлами в
tracked_files. Якщо під час обробки окремого batches жодної пари local/remote не було виявлено, TrackedFiles
залишаються не зміненими й передаються, як по естафеті, на вхід оборобки наступного batch.

## II.1 _diff3

Насамперед вважаємо, що _diff3() автоматично вирішує такі конфлікти:

1. _diff3(base=NULL, local=A, remote=A) ⇒ A
2. _diff3(base=NULL, local=A, remote=B) ⇒ manual_conflict
3. _diff3(base=A, local=A, remote=A) ⇒ A
4. _diff3(base=A, local=A, remote=B) ⇒ B
5. _diff3(base=A, local=B, remote=A) ⇒ B
6. _diff3(base=A, local=B, remote=B) ⇒ B
7. А також NULL сприймається, як base:
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
   вважаються в manual conflict mode, якщо вони не однакові. Таким чином, фактично,
   `maximum_auto_merge_file_size=0` — вимикає diff3-трансформації взагалі для всіх файлів для тих користувачів, які
   не хочуть автоматичного merge взагалі, бо хочуть самі контролювати всі зміни файлів.

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
                              - якщо файл в manual-conflict mode, тоді _diff3(C4, Vault, D4) взагалі не робирться, а
                                одразу D4 зберігається як conflict-sibling-file. 
       
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
Ми не встигли записати нові значення, отже BASE залишився той самий, і C1 - також, але
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
Ми не встигли записати нові значення, отже BASE залишився той самий, і C1 - також, але
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

Тут не може бути кількох remote змін в одному drain, тому-що pull буде тільки один,
на початку, а отже нема push і нема перезапуску після push по помилці ERROR422. Якщо операція була перервана — починаємо
з початку (BASE, pull) знову і так, поки не закінчимо цей drain, або поки не з'являться локальні batches але тоді режим
drain зміниться на II.3 ("Base Conflict resolving mode") і піде по іншій гілці:

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
Vault ---  (diff3) ---- якщо Vault == base, тоді перемагає R1: Vault = R_n;
      (BASE,Vault,R_n)  якщо Vault != base, але diff3 - OK, тоді Vault = diff3(BASE,Vault,R_n);
                        якщо Vault != base, але diff3 - Conflict, тоді:
                          - base = R_n
                          - Vault conflict-sibling-file = R_n з додаванням
                        додаванням в список tracked конфліктів цього конфлікту. conflict branch створювати не потрібно,
                        і комітити VAULT в нього - також. Якщо конфлікт було виявлено тільки при порівнянні з Vault 
                        файлом, а не файлу в batches, тобто, з файлом, який зараз редагується, тоді наявність вже
                        зареєстрованого tracked конфлікту, вже спричинить особливий режим обробки цього файлу в 
                        наступному drain, і тоді ж буде створено conflict_branch, якщо його ще не було створено раніше.
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
   drain ми знаємо в якому режимі знаходиться файл і продовжуємо підтримувати цей режим аж до кроку "Vault step"

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
C_{n} ---- (_diff3 ERROR) ===> Manual conflict: 1. add C_{n} to conflict_list
      (C_{n-1}, C_{n}, R_{m})                   2. push C_{n} to conflict branch;
                |                               3. base = R_{m};
                V                               4. conflict_base = C_{n} те ж саме що: conflict_list[file] = C_{n} ;
                                                5. remote залишається R_{m}  
                                                
*STEP2*. Якщо файл вже знаходиться в manual conflict mode:
# тепер до кінця drain, незалежно скільки ще буде C_{n} і R_{m}:
# 1. push C_{n} to conflict_branch - всі C_{n} ідуть в confict_branch (якщо тільки послідовно вони не однакові: тобто C_{n-1} != C_{n}
# 2. condflict_base = C_{n} теж саме що і conflict_list[filepath] = C_{n} - заміна попередньої conflict_base на нову
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
               |                                       3. base = R_{m};
              ...                                      4. conflict_base = C_{n};  
               |  D_{last}                             5. D_{n} = R_{m}
               V 
*STEP3* (Vault-step):               
1. цей файл ще не був в конфлікті до початку drain:
Vault ------- [] -> зберігаємо D_{*} як conflict-sibling-file до C_{*}, base-file в Vault - НЕ чіпаємо!     

2. якщо цей файл вже був в режимі "manual conflict" до початку drain (тобто на момент "Vault step" в локальній файловій
   системі вже присутній previous tracked manual conflict):
Vault ------- (_diff3(conflict_base, prev_conflict_sibling_file, D_{last}) -> D_{conflict}:
                         - OK: 1. видаляємо previous conflict-sibling-file;
                               2. зберігаємо D_{conflict} як нoвий conflict-sibling-file (timestamp у назві —
                                  R_m.mtime, дата ОСТАННЬОГО remote-коміту, що увійшов у D_{conflict}; див.
                                  примітку нижче), base-file в Vault - НЕ чіпаємо!     
                         - ERROR: 1. залишаємо на файловій системі previous conflict-sibling-file;
                                  2. зберігаємо D_{last} як новий conflict-sibling-file (timestamp у назві —
                                     R_m.mtime, ТА САМА дата, що й вище) в Vault, 
                                     base-file в Vault - НЕ чіпаємо  
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
C_{n} ---- (_diff3 ERROR) ===> Manual conflict: 1. add C_{n} to conflict_list
      (C_{n-1}, C_{n}, R_{m})                   2. push C_{n} to conflict branch;
                |                               3. base = R_{m};
                V                               4. conflict_base = C_{n} те ж саме що: conflict_list[file] = C_{n} ;
                                                5. remote залишається R_{m}  
<<ЗБІЙ>>>
```
Ми не встигли записати нові значення, отже BASE (C_{n-1}) залишився той самий, і local (C_{n}) той самий, і 
при повтоному PULL ми отримаємо той самий R_{m} з repo. То що ми отримаємо? Ми отримаєм,о той самий конфлікт, який
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
C_{n} ---- (_diff3 ERROR) ===> Manual conflict: 1. add C_{n} to conflict_list  (це в пам'яті, тому так, це потрібно)
      (C_{n-1}, C_{n}, R_{m})                   2. push C_{n} to conflict branch;  (ми перевіряємо останній файл в repo 
                                                   в conflict branch, тому ця дія просто пропускається)
                |                               3. base = R_{m};   (так, це робиться в пам'яті)
                V                               4. conflict_base = C_{n} те ж саме що: conflict_list[file] = C_{n} ; також
                                                5. remote залишається R_{m}  - також
```
Отже, повторний запуск branch в цій ситуації не приводить до інших результатів. STEP2 також дає такий самий висновок.



ВАЖЛИВО! Таким чином, з одного drain може вийти тільки ОДИН conflict-sibling-file (останній завантажений з repo remote
file) для окремого base-file!
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
   цього файлу на нове значення з наступних pull з repo
3. В останній фазі (Vault) перебираються (for each) всі файли в TrackedFiles і ті з них, які є в manual conflict mode, і
   для яких є завантажені remote file з репо, зберігаються як conflict-sibling-file.
4. Якщо conflict-sibling-file вже існує в Vault, тоді робиться
   `_diff3(conflict_base, prev_conflict_sibling_file, D_{last})` (спроба замінити попередній конфлікт файл).
5. Якщо спроба п.4 - вдала, тоді новий conflict-sibling-file (timestamp у назві — `tracked.remote.mtime`,
   дата remote-коміту, НЕ момент запису на диск) зберігається з результатом _diff3
   на файловій системі, а старий — видаляється(!).
6. Якщо спроба п.4 - не вдала, тоді на файловій системі просто зберігається ще один (новий, додатковий)
   conflict-sibling-file (той самий `tracked.remote.mtime`) як додаток до вже існуючого.
7. І після п.5 і в п.6 оновлюємо conflict metadata list і зберігаємо на файловій системі.

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
   `github-easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>`. Момент вибору імені й atomicWrite
   `conflictBranchName` у metadata — ПЕРШИЙ крок, ще ДО спроби створити чи запушити гілку. Тоді після
   краху це ім'я завжди відоме, незалежно від того, чи встиг сам push відбутись:
   ```
   conflictBranchName = metadata.conflictBranchName
   if conflictBranchName is null:
       conflictBranchName = buildConflictBranchName(deviceLabel, now())
       atomicWrite(metadata.conflictBranchName = conflictBranchName)   # ПЕРШИЙ крок, до мережі
   conflict_head_hash = getBranchHeadSha(conflictBranchName)  # null, якщо 404 (ще не створена)
   ```
   Персистований SHA-pointer (`conflict_hash`) на цьому й закінчується — його більше НЕ зберігаємо
   взагалі: `conflictBranchName` повністю його замінює, а `conflict_head_hash` завжди читається
   живим (`getBranchHeadSha`), ніколи з диска. Для ВІДКРИТТЯ гілки після краху достатньо самого
   ІМЕНІ — воно discoverable незалежно від того, чи був колись відомий SHA.

2. **Guard на push у conflict-branch — журнал як швидкий шлях, жива перевірка як crash-safe fallback,
   ЄДИНА функція для STEP1 і STEP2:**
   ```
   def shouldPushToConflictBranch(path, sha, conflict_list, conflict_head_hash):
       cached = conflict_list.get(path)
       if cached is not null and cached.sha == sha:
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
(TOCTOU) — це вже було знайдено й розв'язано раніше (SYNC-FIX.md §6, "R3b"), і новий `getBatch()`
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

**Crash-recovery (лишений `.attempted-commit` після краху commit-а)** — адаптовано з SYNC-FIX.md §6
(рядки 569-574) під термінологію §12 (`.runtime/sync_store/{sha}`, не старий "cache-dir"):

```
CRASH_RECOVERY(dir):
    if not metafileComplete(dir):
        # metafile взагалі не дописано (крах ДО завершення запису) — консолідація не відбулась
        # атомарно, нема довіри жодному вмісту каталогу.
        rmdir(dir)
        return getBatch()   # наступний каталог (якщо є) або null

    for (path, sha, size) in batch.entries:
        if not existsInSyncStore(sha):
            # спробувати долатати з живого Vault (той самий принцип, що й §12.6). Size-перед-SHA
            # (§I.2 примітка, SYNC-FIX.md §12.9): stat дешевий, hash — ні (2 МБ → 6.3 мс,
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

**Чому "drain теж appender" (відкрита прогалина R3b, SYNC-FIX §6, "≥2 appender-и + 1 claimer") тут НЕ
застосовна.** Та прогалина виникала через Phase B (`synthesizeResolutionSideBatches` — drain сам
дописував синтетичні side-batch-і в `push_queue/` ПОСЕРЕД своєї роботи, ламаючи Пітерсонове
припущення "рівно один appender"). У новому дизайні (§II.6-II.7) конфлікти йдуть напряму в
`conflict_commit` і `conflictBranchName`, НІКОЛИ не через `push_queue/` — drain більше не є
appender-ом ні за яких обставин. Прогалина закрита структурно, не патчем (це саме те, що SYNC-FIX.md
§12 вже передбачив: "Синтетичні батчі… скасовано, тож відкрита прогалина… закривається окремо").

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
    # 1. _diff3(base=NULL, local=A, remote=A) => A
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
       base = FileInfo()   # equal to: {path: null, size: null, mtime: null, sha:  null, blob: null mode: null}
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
       if local.sha is not null and remote.sha == local.sha:                                              # 1 
             return (local, null)       
             
       if local.sha is not null and remote.sha != local.sha:                                              # 2
             return (null, MANUAL_CONFLICT) 
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
        local.blob = getBlobFromSyncStore(local.sha) # шукає файл з назвою `{sha}` в `.runtime/sync_store/`, якщо
                                                     # він є і його SHA збігається з SHA в назві, тоді отримуємо 
                                                     # цей blob, інакше null
        if local.blob is null:
           return (null, LOCAL_FILE_IS_NOT_FOUND_ERROR(local.path))
                                                      
    if remote.blob is null:        
        # remote.mode=DELETED НЕ МОЖЕ потрапити на цей рівень — те саме доведення, що й для local вище.
        remote.blob = getBlobFromSyncStore(remote.sha) # шукає файл з назвою `{sha}` в `.runtime/sync_store/`, якщо
                                                       # він є і його SHA збігається з SHA в назві, тоді отримуємо 
                                                       # цей blob, інакше null
        if remote.blob is null:
           # вантажаимо цей блоб з repo i зберігаємо його в `.runtime/sync_store`:
           (remote.blob, error) = getBlobFromRepo(remote.sha) # продумати які ще дані потрібно для завантаження.
                                                              # чи одного github-sha достатньо для завантаження? 
           if error == TOKEN_EXPIRED:
               return (null, error)  
               
           if error == NETWORK_ERROR
               return (null, error)                                                
              
           if remote.blob is null:
               return (null, REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR(remote.path))   
              
           if not existInSyncStore(remote.sha): 
               saveBlobToSyncStore(remote)

    if base.blob is null:
        base.blob = getBlobFromSyncStore(base.sha) # шукає файл з назвою `{sha}` в `.runtime/sync_store/`, якщо
                                                   # він є і його SHA збігається з SHA в назві, тоді отримуємо 
                                                   # цей blob, інакше null
        if base.blob is null:
            # вантажаимо цей блоб з repo i зберігаємо його в `.runtime/sync_store`:
            (base.blob, error) = getBlobFromRepo(base.sha) # продумати які ще дані потрібно для завантаження.
                                                           # чи одного github-sha достатньо для завантаження? 
            if error == TOKEN_EXPIRED:  # той самий контракт, що й вище для remote.blob — без цього
                                        # протухлий токен тут помилково впав би в
                                        # BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR нижче
                return (null, error)
            if error == NETWORK_ERROR:
                return (null, error)                                                
               
            if base.blob is null:
               return (null, BASE_FILE_IS_NOT_EXIST_IN_REPO_ERROR(base.path))   
    
            if not existInSyncStore(base.sha): 
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
    if not existInSyncStore(d_sha): 
        saveBlobToSyncStore(d_file)
        
    return (d_file, null)
    

dif process_conflicts():
   # ця процедура робить такі дії:
   # 1. ЯКЩО В ПАМ'ЯТІ ЩЕ НЕМА conflict_list, зчитуємо цей список з файлової системи Obsidian Vault з conflict's 
   #    metadata file
   # 2. скануємо цей список. Для кожного base-file з цього списку:
   #    1. шукаємо всі його conflict-sibling-files - як tracked, так і synthetic
   #    2. порівнюємо SHA всіх conflict-sibling-files для даного base-file між собою, якщо вони однакові тоді видаляємо 
   #       дублікати за правилом:
   #        1. якщо однаковий SHA одночасно в tracked i synthetic файлі - видаляємо SYNTHETIC ФАЙЛ з файлової системи
   #        2. якщо однаковий SHA в файлах одного типу (tracked чи synthetic), видаляємо ФАЙЛ ЗІ СТАРІШИМ TIMESTAMP з 
   #           файлової системи і (якщо це тracked file), тоді видаляємо цей старий файл з conflict list
   #    3. для conflict-файлів, які залишились для даного base-file, порівнюємо їх з base-file SHA за правилом:
   #        1. якщо base-file існує, а відповідного йому conflict-sibling-file нема - видаляємо запис про цей конфлікт з
   #           conflict's list. Якщо нема ні base-file ні conflict-sibling-file - так само (конфлікт вирішено через 
   #           видалення)
   #        2. якщо base-file не існує, а conflict-sibling-file - існує, пропускаємо (конфлікт залишається в силі)
   #        3. якщо base-file існує і conflict-sibling-file існує, і в них однакові SHA, тоді видаляємо 
   #           conflict-sibling-file з файлової системи і (якщо це tracked file)  то і з conflict list.
   # 3. Якщо список змінився, зберігаємо на диск оновллений conflict's metadata file (AtomicWrite)
   #
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
   # В результаті маємо отримати тільки список актуальних tracked конфліктів:
   return updated_tracked_conflict_list 

 
def drain2():
    rearangeSyncStore()   # чистимо `.runtime/sync_store/` від старих файлів (SYNC-FIX.md, §12.5 (sweep))
                          # це робиться тільки при старті drain, а не в циклі, і ще раз в кінці (після обробки ВСІХ 
                          # batches)
                          
    # Починаємо цикл drain:
    # Один цикл drain2 приблизно складається з таких кроків:
    #  1. отримуємо змінені файли з repo.
    #  2. беремо перший batch і скануємо по файлам в цьому batch. Коли батчі закінчились ідемо на завершення п.7.
    #  3. порівнюємо файли, модифікуємо їх за потреби (diff3) і формуємо списки на коміти.
    #  4. після обробки всіх файлів з даного batch - пушимо коміти (чому в множині? Бо це можуть бути 2 коміти - в main 
    #     і в conflict branches). 
    #  5. якщо все OK, видаляємо це поточний (перший у списку) batch так, що другий стає першим і знову переходимо до п.2. 
    #  6. якщо push завершився зі збоєм (Error422, хтось інший вже закомітив зміни) переходимо до п.1 
    #     (через restart_batch=true, поточний батч не видалено, тому його буде оброблено ще раз з новими даними з repo.
    #  7. остаточне порівняння з файлами в Vault (vault step) і збереження змін в valult (base-files і(якщо є) - 
    #     conflict-sibling-files).

    restart_batch = true
    error422_count = 0   # I6: обмежуємо ланцюжок 422-рестартів (§III нижче, коментар "422-CAP")
    while true:                                                            
        if restart_batch:
            #==========================================================================================
            # перший крок - це обробка старих (з попередніх sync) tracked manual conflicts
            #==========================================================================================
            manual_conflicts = process_conflicts() # manual_conflicts[] може бути порожній, якщо нема нерозв'язаних 
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
            TrackedFiles = restoreTrackedFilesFromDiskOrCreateNewOne(manual_conflicts) 
                                                                  # Відновлюєммо tracked files з диску якщо був збій   
                                                                  # або створюємо порожній список TrackedFiles  
                                                                  # TrackedFile зберігає інформацію про remote файл
                                                                  # чи трансформований з допомогою diff3 файл: path,
                                                                  # sha, size, type, is_manual_conflict...
                                                                  # принагідно додаємо до них manual conflicts, які
                                                                  # на файловій системі зберігаються окремо(!) 
                                                                  #
                                                                  # ⚠️ RECONCILE (закриває "ЦЕ НОРМАЛЬНО???" STEP2
                                                                  # і безгардовий сайт STEP3 — один фікс на джерелі,
                                                                  # не два патчі на споживачах): для кожного
                                                                  # tracked.is_manual_conflict==true, чийого шляху
                                                                  # НЕМА у свіжому `manual_conflicts` (щойно
                                                                  # повернутому `process_conflicts()` — реальний
                                                                  # скан файлової системи, авторитетний), скидаємо
                                                                  # is_manual_conflict=false тут, з гучним логом.
                                                                  # Це ЛЕГІТИМНИЙ випадок — користувач вручну
                                                                  # вирішив конфлікт (видалив/змержив sibling) між
                                                                  # drain-ами; трактувати як критичний збій означало
                                                                  # б блокувати drain через штатну дію користувача
                                                                  # (порушення I6). Канон: PSEUDO-MERGE-MODE.md
                                                                  # Scenario C — "конфлікт закритий, коли зникли
                                                                  # ВСІ siblings". Після цього reconcile обидва
                                                                  # споживачі (STEP2 рядок ~1189, STEP3 рядок
                                                                  # ~1444) можуть покладатись на assert, а не на
                                                                  # захисний код: якщо tracked.is_manual_conflict,
                                                                  # то запис у manual_conflicts/conflict_list
                                                                  # ГАРАНТОВАНО є.
                                                                  
            #==========================================================================================
            # Отримуємо SHA найновішої BranchHead для MAIN BRANCH
            #==========================================================================================
            while true:                                                               
                try:
                    head_hash = getBranchHeadSha(MAIN);    # отримуємо останній branchHead з remote repo 
                    break;
                catch e: TOKEN_EXPIRED:
                    # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                    saveTokenExpiredMark()
                    return e
                catch е: NETWORK_ERROR:
                    continue then return e                 # нема мережі. помилка. Повторити кілька разів з збільшенням 
                                                           # інтервалу, але якщо мережа не з'явилась - припинити drain з
                                                           # помилкою TIMEOUT, нехай користувач сам його перезапустить 
                                                           # (або drain буде запускатись періодично) поки не з'явиться 
                                                           # мережа  
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
                while true:                                                               
                    try:
                        remote_files = getChangedFilesFromGitHubRepo(base=base_hash, head=head_hash)
                        break;
                    catch e: TOKEN_EXPIRED:
                        # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                        saveTokenExpiredMark()
                        return e    
                    catch е: NETWORK_ERROR:
                        continue then return e                 # нема мережі. помилка. Повторити кілька разів з збільшенням 
                                                               # інтервалу, але якщо мережа не з'явилась - припинити drain з
                                                               # помилкою TIMEOUT, нехай користувач сам його перезапустить 
                                                               # (або drain буде запускатись періодично) поки не з'явиться 
                                                               # мережа. При цьому варто на файловій системі створити
                                                               # файл мітку (наприклад, `.runtime/sync_network_error` в якій
                                                               # записувати причину збою drain, при наявності цього файлу
                                                               # зафарбовувати іконку sync в ribbon в червоний колір, hint
                                                               # показує причину помилки (network error). і В settings, в
                                                               # sекції "GitHub Sync Status" вказувати цю помилку з 
                                                               # рекомендацією перезапустити Sync, коли з'явиться мережа.
                                                               # Отже поведінка всіх мережевих операцій однакова:
                                                               # повторюємо кілька разів, збільшуючи timeout, а потім
                                                               # перериваємо drain з повідомленням про помилку.
                                                           
            #==========================================================================================
            # Ім'я conflict-branch персистується ДО будь-якого мережевого виклику, що її торкається
            # (§II.7) — тому воно відоме навіть якщо drain ще ЖОДНОГО разу не пушив у цю гілку.
            #==========================================================================================
            conflictBranchName = metadata.conflictBranchName
            if conflictBranchName is null:
                conflictBranchName = buildConflictBranchName(deviceLabel, now())
                atomicWrite(metadata.conflictBranchName = conflictBranchName)  # ПЕРШИЙ крок, до мережі

            #==========================================================================================
            # Отримуємо SHA найновішої BranchHead для CONFLICT BRANCH (null, якщо 404 — гілки ще нема)
            #==========================================================================================
            while true:                                                               
                try:
                    conflict_head_hash = getBranchHeadSha(conflictBranchName);  # null, якщо 404
                    break;
                catch e: TOKEN_EXPIRED:
                    # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                    saveTokenExpiredMark()
                    return e
                catch е: NETWORK_ERROR:
                    continue then return e                 # нема мережі. помилка. Повторити кілька разів з збільшенням 
                                                           # інтервалу, але якщо мережа не з'явилась - припинити drain з
                                                           # помилкою TIMEOUT, нехай користувач сам його перезапустить 
                                                           # (або drain буде запускатись періодично) поки не з'явиться 
                                                           # мережа  
            # ПРИМІТКА: bulk-diff conflict_files БІЛЬШЕ НЕ ПОТРІБЕН (§II.7) — STEP1/STEP2 звіряються
            # напряму через shouldPushToConflictBranch(path, sha, conflict_list, conflict_head_hash),
            # що падає на живий per-file запит лише коли журнал (conflict_list) не підтверджує сам.
                                                            
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
                                                       # (SYNC-FIX.md §12). Завжди беремо найстаріший
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
        for each local in batch:   # структура local (FileInfo): {path, size, sha, mode, blob=null}
            # перевіряємо чи існує в sync_store blob файлу з даного batch (див. SYNC-FIX, §12)
            if local.mode != DELETED:
                local.blob = getBlobFromSyncStore(local.sha) # шукає файл з назвою `{sha}` в `.runtime/sync_store/`, якщо
                                                             # він є і його SHA збігається з SHA в назві, тоді отримуємо 
                                                             # цей blob, інакше null
                if local.blob is null:
                    # намагаємось його відновити з Vault:
                    vault_file = vault.files.get(local.path)  # повертає {path, size, mtime} або null, якщо файл не  
                                                              # знайдено. Для отримання sha треба викликати getSha()
                                                              # кешується, тому другий виклик (повторний) - дешевий
                    if vault_file is not null and vault_file.size == local.size and vault_file.getSha() == local.sha:
                       local.blob = copyFileFromFSToSyncStore(vault_file.path, vault_file.getSha())
                    else:
                       # якщо цього файлу в Vault вже нема, або він змінився - ігноруємо (SYNC-FIX.md, §12.5.B)
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
                # (рядок ~976) гарантує: якщо tracked.is_manual_conflict тут true, запис у
                # conflict_list ІСНУЄ — випадок "конфлікт розв'язано між drain-ами" уже
                # відфільтровано на джерелі, тут лишається чистий assert, не захисна гілка.
                conflict_base = conflict_list.get(tracked.base.path)
                assert conflict_base is not null
                if conflict_base.sha != local.sha:
                    # §II.7: журнал (conflict_list) як швидкий шлях, жива перевірка як
                    # crash-safe fallback — замінює колишній bulk-diff conflict_files.
                    if shouldPushToConflictBranch(local.path, local.sha, conflict_list, conflict_head_hash):
                        local.mtime = now()  # час, коли файл покладено в список на конфлікт-коміт
                        (savedInRepoBlob, error) = saveBlobToGitHub(local)  # той самий (blob, error)
                                                                            # контракт, що й для MAIN push
                        if error == TOKEN_EXPIRED:
                            saveTokenExpiredMark()
                            return error
                        if error == NETWORK_ERROR:
                            return error
                        conflict_commit.add(savedInRepoBlob)

                    conflict_list.set(conflict_base.path) = local

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
                        D.blob = getBlobFromSyncStore(D.sha) # шукає файл з назвою `{sha}` в `.runtime/sync_store/`, якщо
                                                             # він є і його SHA збігається з SHA в назві, тоді отримуємо 
                                                             # цей blob, інакше null
                        if D.blob is null: # blob може не бути ще в SyncStore, якщо це remote file. Local files вже всі
                                           # мають бути представлені в SyncStore, ми про це подбали вище
                            # вантажимо цей блоб з repo i зберігаємо його в `.runtime/sync_store`:
                            (D.blob, error) = getBlobFromRepo(D.sha)
                            if error == TOKEN_EXPIRED:
                                # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                                saveTokenExpiredMark()
                                return error
                            if error == NETWORK_ERROR
                                return error                                                
                               
                            if D.blob is null:
                                return REMOTE_FILE_IS_NOT_EXIST_IN_REPO_ERROR(D.path)   
                               
                            if not existInSyncStore(D.sha): 
                                saveBlobToSyncStore(D)
                        
                    # D.mtime НЕ ставимо тут: TODO закрито (2026-08-23, за наводкою advisor) —
                    # tracked.remote.mtime мусить БУТИ точною датою remote-коміту в будь-якому
                    # випадку, а не лише коли контент прийшов з pull. Посеред цього for-циклу ми
                    # ще й не знаємо справжньої дати — GitHub призначає її лише в момент обробки
                    # pushCommit() нижче, і то ОДНУ на весь batch (commit атомарний). Замість
                    # локального здогаду — main_push_tracked: єдиний список, якому нижче
                    # проставляється АВТОРИТЕТНА дата з відповіді GitHub.
                    (savedInRepoBlob, error) = saveBlobToGitHub(D)  # (blob, error) — той самий контракт, що й
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
                if shouldPushToConflictBranch(local.path, local.sha, conflict_list, conflict_head_hash):
                    local.mtime = now()
                    (savedInRepoBlob, error) = saveBlobToGitHub(local)
                    if error == TOKEN_EXPIRED:
                        saveTokenExpiredMark()
                        return error
                    if error == NETWORK_ERROR:
                        return error
                    conflict_commit.add(savedInRepoBlob)
                manual_conflicts.add(local)                   # conflict_base це і є запис у форматі FileInfo 
                                                              # в manual_conflicts[filename]
                conflict_list.set(local.path) = local
                tracked.base = tracked.remote
        #=========================================================================================    
        # end for batch
        #=========================================================================================    
             
        #=========================================================================================    
        # оброблено всі файли даного batch. комітимо зміни
        #=========================================================================================    
        if len(commit)>0:  # якщо commit порожній (нема файів), коміт ігнорується
            while true:
                try:
                    (new_head_hash, committed_at) = pushCommit(commit, head_hash)  # committed_at =
                                        # committer.date з відповіді GitHub Create-Commit API —
                                        # pushCommit() і так парсить цю відповідь заради sha, друге
                                        # поле дістається майже безкоштовно
                    head_hash = new_head_hash   # ⚠️ ОБОВ'ЯЗКОВО: без цього наступний batch (якщо
                                                # restart_batch лишився false) пушить проти
                                                # ЗАСТАРІЛОГО head_hash → гарантований 422 на
                                                # кожному наступному batch
                    # mtime-інваріант: tracked.remote.mtime ЗАВЖДИ дата remote-коміту цього
                    # вмісту — і коли він прийшов з pull (Compare API, `file.mtime`, рядок ~1113),
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
                catch e: TOKEN_EXPIRED:
                    # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                    saveTokenExpiredMark()
                    return e    
                catch e: NETWORK_ERROR:   
                    continue then return e              # нема мережі. помилка. Повторити кілька разів з збільшенням 
                                                        # інтервалу, але якщо мережа не з'явилась - припинити drain з
                                                        # помилкою TIMEOUT, нехай користувач сам його перезапустить 
                                                        # (або drain буде запускатись періодично) поки не з'явиться 
                                                        # мережа  
                catch e: ERROR422:
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
                         
            if restart_batch:
                 continue;  # перезапускаємо drain з даного (першого) batch зпочатку
           
        # комітимо в conflict_branch, якщо є що комітити
        if len(conflict_commit) > 0:
            cnt = 0
            while cnt<3:
                try:   
                    conflict_head_hash = getBranchHeadSha(conflictBranchName);   # null, якщо гілки ще нема
                    (conflict_head_hash, _) = client.pushCommit(conflict_commit, conflict_head_hash, conflictBranchName);
                                                                       # той самий (hash, committed_at) контракт,
                                                                       # що й pushCommit() вище — тут committed_at
                                                                       # свідомо ігнорується (`_`): conflict-branch
                                                                       # вміст на sibling-timestamp не впливає
                                                                       # (§II.7 — conflict_list звіряється лише по
                                                                       # sha, sibling-назви беруть tracked.remote.mtime,
                                                                       # не дату конфлікт-коміту)
                                                                       # якщо conflict_head_hash = null, отже ще нема
                                                                       # conflict branch, тоді він створюється
                    error422_count = 0   # 422-CAP: успіх (у будь-якій з двох гілок) скидає лічильник
                    break
                catch e: ERROR422:
                    # упс. поки ми цей коміт намагались зберегти, хтось інший закомітив свої зміни в conflict-бранч, але це
                    # АБСОЛЮТНО НЕМОЖЛИВО! Бо цей branch належить тільки нашому device! Тому отримуємо новий head і 
                    # пробуємо записати щє раз
                    cnt+=1
                    continue
                catch e: TOKEN_EXPIRED:
                    # зберігаємо файл-ознаку TOKEN_EXPIRED і завершуємо drain з помилкою
                    saveTokenExpiredMark()
                    return e    
                catch e: NETWORK_ERROR:   
                    continue then return e                # нема мережі. помилка. Повторити кілька разів з збільшенням 
                                                          # інтервалу, але якщо мережа не з'явилась - припинити drain з
                                                          # помилкою TIMEOUT, нехай користувач сам його перезапустить 
                                                          # (або drain буде запускатись періодично) поки не з'явиться 
                                                          # мережа  
            if cnt == 3:
                 return ERROR_COMMIT_TO_CONFLICT_BRANCH

        # ПРИМІТКА: злиття conflict-branch → main ("finalize") СВІДОМО не робиться тут, per-batch.
        # Причина руху — не стиль: злиття рухає main head, а наступний pushCommit() цього batch-циклу
        # все ще використовує СТАРИЙ head_hash → гарантований 422 на найближчому push і зайвий повний
        # restart. Finalize винесено після "end while true" (нижче), поруч із Vault-step — де вже
        # немає жодного push, якому потрібен би був актуальний head_hash. Див. §IV (recovery matrix)
        # для ідемпотентності самого merge+delete.

        # BATCH ОБРОБЛЕНО!
        # Отже, ми маємо повністю оброблений batch, тепер варто зберегти проміжні результати на файловій системі
        # і видалити цей batch з `push_queue/`. Для цього робимо наступні кроки (деталізовано, з відповіддю на
        # відкрите питання нижче, у §IV "Матриця відновлення після краху"):
        # 1. Атомарно (ping-pong, §V) записуємо оновлений TrackedFiles + conflict metadata ОДНИМ записом —
        #    включно з main-branch-head і conflict-branch-head, які щойно успішно записали в репо, і
        #    (опційно, як оптимізація — §IV) назвою обробленого batch-каталогу.
        # 2. Видаляємо оброблений batch з `push_queue/`.
        #
        # §IV відповідає на відкрите питання "що як push вдався, а збій — ДО запису на диск": завдяки
        # ідемпотентності кожного мережевого кроку (§IV, таблиця) ПОВНИЙ ПОВТОР batch-у з нуля — завжди
        # безпечна відповідь, тому двофазний протокол зводиться до "крок 1 успішний → крок 2 можна робити",
        # без проміжних станів, які треба окремо лагодити.
        # 
        # ПОВТОРНЕ ВИКОНАННЯ BATCH, якщо вже все було закомічено не приводить до змін ні в MAIN ні в CONFLICT BRANCHES
       
        
    #=========================================================================================    
    # end while true  # Вихід з цього циклу тільки тоді, коли черга batches закінчиться          
    #=========================================================================================    

    #=========================================================================================
    # FINALIZE: злиття conflict-branch → main, ОДИН РАЗ, наприкінці drain (не per-batch — §III
    # вище, коментар "ПРИМІТКА"). Умова та сама: жодних НЕвирішених tracked-конфліктів не лишилось.
    #=========================================================================================
    conflictBranchName = metadata.conflictBranchName
    if conflictBranchName is not null and len(manual_conflicts) == 0:
        head_hash = getGuardedHead()   # свіжий, а не той, що лишився з останнього batch-push
        conflict_head_hash = getBranchHeadSha(conflictBranchName)
        if conflict_head_hash is null:
            # 404: гілку вже видалено раніше (напр. crash ПІСЛЯ delete, ДО очищення metadata —
            # див. §IV) — трактуємо як "уже фіналізовано", просто чистимо metadata і не падаємо.
            atomicWrite(metadata.conflictBranchName = null)  # persisted SHA-pointer скасовано (§II.7) — нема що ще чистити
        else if isAncestorOf(conflict_head_hash, head_hash):
            # Ідемпотентність: якщо conflict-branch tip вже reachable з main (попередня спроба
            # merge удалась, крах стався ПІСЛЯ merge, ДО delete-branch чи ДО запису на диск) —
            # повторний merge НЕ РОБИМО (GitHub або відмовить "nothing to merge", або мовчки
            # прийме no-op — обидва варіанти зайві мережеві виклики без потреби). Одразу видаляємо.
            deleteBranchIfExists(conflictBranchName)  # 404 = вже видалено = success, не помилка
            atomicWrite(metadata.conflictBranchName = null)  # persisted SHA-pointer скасовано (§II.7) — нема що ще чистити
        else:
            client.mergeBranches(conflict_head_hash, head_hash)  # merge-commit, два parent (§4.3
                                                                  # PSEUDO-MERGE-MODE.md)
            deleteBranchIfExists(conflictBranchName)
            atomicWrite(metadata.conflictBranchName = null)  # persisted SHA-pointer скасовано (§II.7) — нема що ще чистити
        # Жодних подальших push у цьому drain немає, тому "head_hash застарів після merge" —
        # структурно неможливо: нема наступного кроку, якому він був би потрібен.

    # всі batches оброблено, тепер порівнюємо файли з TrackedFiles з оригінальними файлами в Vault і замінюємо їх, 
    # видаляємо, зберігаємо conflict-siblings до них.     
    vault_step_errors = []   # NETWORK_ERROR per-file — не абортує весь Vault-step (§IV.2 рядок 7)
    for tracked in TrackedFiles:
       if tracked.is_manual_conflict:
          # II.6.STEP3:
          tracked.base = manual_conflicts.get(tracked.remote.path)  # conflict_base — push у
                                                                    # conflict-branch, RECOVERABLE
                                                                    # з репо (getBlobFromRepo), якщо
                                                                    # sweep не встиг зачистити
                                                                    # (§12.5 referenced-множина МУСИТЬ
                                                                    # включати SHA з conflict_list —
                                                                    # інакше зайва мережа тут)
          previous_sibling = manual_conflicts.getPreviousConflict(tracked.remote.path)
                                                                    # ⚠️ на відміну від conflict_base,
                                                                    # sibling-контент ІСНУЄ ТІЛЬКИ у
                                                                    # Vault (§II.6, "на сервер НЕ ЙДУТЬ")
                                                                    # — з мережі невідновний. Тому
                                                                    # getPreviousConflict() МУСИТЬ
                                                                    # повертати FileInfo з уже
                                                                    # заповненим `.blob` (прочитаним із
                                                                    # sibling-файлу на диску), інакше
                                                                    # _diff3() нижче впаде на
                                                                    # LOCAL_FILE_IS_NOT_FOUND_ERROR —
                                                                    # той самий клас бага, що й
                                                                    # readVaultFileInfo нижче.
          # Vault step (II.6.STEP3):
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
              # На відміну від TOKEN_EXPIRED — транзієнтне, інші файли можуть пройти. Пропускаємо
              # ЦЕЙ файл (tracked.base НЕ просувається → §IV.2 рядок 7: наступний drain повторить
              # рівно цей Vault-крок для нього), збираємо для звіту в кінці, йдемо далі.
              vault_step_errors.add({path: tracked.remote.path, error: diff_error})
              continue
          if diff_error != MANUAL_CONFLICT:
             # видаляємо попередній sibling файл і зберігаємо поточний замість нього в Vault і в таблицю
             manual_conflicts.remove(previous_sibling)
             merged_sibling.mtime = tracked.remote.mtime  # РІШЕННЯ ВЛАСНИКА (2026-08-23): дата
                                             # remote-коміту, НЕ момент запису. _diff3() завжди
                                             # повертає mtime=null для свіжозлитого результату —
                                             # без цього присвоєння timestamp у назві sibling-файлу
                                             # був би відсутній. tracked.remote.mtime тепер ЗАВЖДИ
                                             # точна дата remote-коміту (і для pull, і для власного
                                             # push — див. інваріант і фікс нижче, §III main-loop) —
                                             # це рішення тримається строго, не приблизно.
             saveConflictSiblingFile(merged_sibling)
             manual_conflicts.add(merged_sibling)
          else:
             # Зберігаємо новий, старий не чіпаємо. tracked.remote.mtime вже присутній (заповнюється
             # при кожному pull-фолдингу, §III) — той самий timestamp-принцип, без додаткового кроку:
             saveConflictSiblingFile(tracked.remote)
             manual_conflicts.add(tracked.remote)
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
                  # тут _diff3() тягне base-blob з репо навіть для §II.5-файлів (тільки-remote) —
                  # мережева помилка тепер мейнлайн, не рідкість. Пропускаємо файл, tracked.base
                  # НЕ просувається (не доходимо до рядка "tracked.base = tracked.remote" нижче) →
                  # §IV.2 рядок 7 покриває безпечний повтор наступним drain.
                  vault_step_errors.add({path: tracked.remote.path, error: diff_error})
                  continue
              if diff_error == MANUAL_CONFLICT:
                  # додаємо новий конфлікт для даного файла.
                  # якщо вже були конфлікти - додаємо новий, якщо ще не було - створюємо новий і додаємо його
                  # Цей конфлікт з'являється одразу в Vault, і не потрапляє в conflict_branch, але все ж це
                  # tracked конфлікт:
                  manual_conflicts.add(tracked.remote)
                  saveConflictSiblingFile(tracked.remote) # timestamp в назві файлу беремо з tracked.remote.mtime
              else: 
                  updateFileInVault(vault_result);  # замінити base-file в Vault на vault_result (атомарно,
                                         # rename або, якщо файл відкритий - перезаписом). Якщо
                                         # vault_result.mode == DELETED, тоді файл локально видаляється
              tracked.base = tracked.remote 
          else:
              # tracked.base.sha == tracked.remote.sha (змін в Vault не робимо взагалі). base залишається з tracked.base
              null         

    if len(vault_step_errors) > 0:
        # Не критично для drain (batches вже успішно допушені) — але користувач має знати, що
        # частина remote-контенту НЕ потрапила у Vault цього разу і чекає наступного sync.
        logWarning("Vault-step: N файлів пропущено через мережеву помилку", vault_step_errors)
                
    # зберігаємо всі head правильно в metadata на диск
    # save_metadata() 
    # а тепер потрібно позбутись усіх метафайлів, які істосуються drain, і записати все в базові metadata.files:
    # 1. скануємо trackedFiles і переносимо base в metadata.files
    # 2. оптимізуємо (може якісь конфліцт файли тепер знову отримали однаковий SHA? - process_conflicts()) і зберігаємо 
    #    ще раз conflict_list (manual_conflicts) міг змінитись в Vault-step, вище
    # 3. видаляємо trackedFiles metafile з файлової системи. Всі попередні оброблені каталоги batch в `push_queue/` вже
    #    видалені
    # 4. sweep `.runtime/sync_store/` за посиланнями (НЕ "чистимо кеш" — це не кеш, SYNC-FIX.md §12.3):
    #    rearangeSyncStore()
    
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
| **Vault-step запис** (`updateFileInVault`, `saveConflictSiblingFile`) | Так, через `atomicWriteFile`/rename | Запис того самого вмісту вдруге — той самий байтовий результат; крах-recovery для atomic write вже покритий існуючим `AtomicWriteRecovery.sweep` (SYNC2.md §10), новий механізм не потрібен. `readVaultFileInfo`/`getPreviousConflict` тепер повертають `.blob` одразу (§III) — без цього `_diff3()` тут падав би на `LOCAL_FILE_IS_NOT_FOUND_ERROR` при КОЖНОМУ виклику, а не лише при краху. NETWORK_ERROR — per-file skip-and-continue (§III), не абортить решту Vault-step; `tracked.base` для пропущеного файлу не просувається, тому рядок 7 нижче однаково коректний і для "крах" і для "мережева помилка на одному файлі серед багатьох". |

**Передумова, на якій тримаються рядки 1/2 нижче (не мережевий side-effect, а чиста in-memory
реконструкція): reconciliation `is_manual_conflict` при відновленні.** `restoreTrackedFilesFromDiskOrCreateNewOne`
(§III) скидає `is_manual_conflict` для будь-якого шляху, відсутнього у свіжому `manual_conflicts`
(реальний скан ФС від `process_conflicts()`). Без цього STEP2/STEP3 могли б впасти в
неозначену поведінку не лише після краху, а й у ЗВИЧАЙНОМУ випадку "користувач розв'язав конфлікт
між drain-ами" — це не крах-сценарій, але й для нього потрібна явна відповідь, і вона та сама:
довіряти щойно відновленому стану, а не застарілому прапорцю.

### IV.2 Точки краху над послідовністю "один batch"

Кожен рядок — це "де саме стався крах", а не окремий рецепт: відповідь скрізь та сама (redo з `getBatch()`),
і посилається на рядок таблиці вище, який доводить, що це безпечно.

| # | Де стався крах | Що на диску | Що робить рестарт | Безпечно через |
|---|---|---|---|---|
| 1 | Під час R3b claim (§II.8) | `.attempted-commit` і/або `.attempted` можуть лишитись | `getBatch()` виконує crash-recovery гілку (§II.8) | IV.1 рядок 1 |
| 2 | Після claim, ДО будь-якого push | Batch у `push_queue/` незмінний | Повний цикл `_diff3` над файлами batch-у з нуля | Читання ідемпотентне (blob-и content-addressed) |
| 3 | ПІСЛЯ push у MAIN, ДО запису на диск | Remote head УЖЕ рухнувся, локально ще стара `head_hash` | `restart_batch=true` (стартове значення) → свіжий diff бачить власний push як "remote" | IV.1 рядок 3 |
| 4 | ПІСЛЯ push у CONFLICT-BRANCH, ДО запису на диск | Гілка вже містить коміт, `conflict_list` на диску застарілий (`conflict_hash` більше не персистується — §II.7) | STEP1/STEP2 знову намагаються пушити той самий шлях | IV.1 рядок 4 (`shouldPushToConflictBranch` бачить SHA вже там) |
| 5 | Між push MAIN і push CONFLICT-BRANCH (для одного batch) | Одна гілка просунулась, інша — ні | Незалежний redo кожної: MAIN-частина йде по рядку 3, CONFLICT-частина — по рядку 4 | Обидва push незалежні (різні refs, §VI) |
| 6 | Під час FINALIZE (merge/delete), ДО запису на диск | Гілка може бути влита і/або видалена, metadata — ні | FINALIZE знову запускається на наступному drain (не в циклі по батчах — виконується щоразу, коли `conflictBranchName != null`) | IV.1 рядки 5-6 |
| 7 | Під час Vault-step, ПОСЕРЕД `for tracked in TrackedFiles` | Частина файлів у Vault уже оновлена, частина — ні; `TrackedFiles`-журнал ще НЕ видалено (він видаляється лише в самому кінці, п.3 фінального блоку §III) | `for`-цикл виконується заново для ВСІХ tracked-файлів; вже записані — записуються тим самим вмістом вдруге | IV.1 рядок 7 (перезапис того самого — no-op) |
| 8 | ПІСЛЯ Vault-step, ДО видалення `TrackedFiles`-журналу | Vault консистентний, журнал ще існує | Весь Vault-step (п.7) повторюється — безпечно (рядок 7) — і завершується видаленням журналу | IV.1 рядок 7 |

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
`crash-gap` зі старого §8.7 п.9 SYNC-FIX.md — нема попередньо обчисленого стану, який міг би
"розійтися" з реальністю.)

**Межа 2 — join-бар'єр перед `createTree`/`createCommit`.** Усередині ОДНОГО батчу
per-file-обробка (нижче) паралельна, але побудова дерева й коміту — це одна операція над ПОВНИМ
набором результатів усіх файлів батчу. Тому: fan-out (паралельно) → join (зачекати ВСІ) →
`createTree`+`createCommit` (послідовно, один раз).

### VI.2 Що паралельне всередині одного батчу

- **Per-file обробка (`_diff3`, blob-завантаження, upload)** — незалежна між РІЗНИМИ шляхами одного
  батчу. Модель: `Promise.all` (fan-out) над `batch.entries`, кожен елемент — своя послідовність
  (blob-load → diff3 → upload), потім join перед commit-побудовою. Частковий провал (один файл дав
  NETWORK_ERROR) абортує ВЕСЬ batch (I4 — транзакція) — інші файли того ж батчу могли вже встигнути
  залити blob, це нешкідливо (content-addressed, IV.1) і буде переиспользоно на повторі.
- **Push у MAIN ∥ push у CONFLICT-BRANCH** — незалежні git-ref, паралельно безпечно (обидва
  ідемпотентні під фіксами §II.7, IV.1). **Один задокументований наслідок:** якщо MAIN зловив 422, а
  CONFLICT-BRANCH встиг долетіти, рестарт може виявити, що conflict тепер auto-merge-иться чисто
  (інший пристрій запушив те саме) — коміт з невдалої спроби лишається в conflict-branch
  "осиротілим, але reachable". Нешкідливо ([[feedback-preserve-all-commits]] це навіть схвалює), і
  finalize (§III) все одно зіллє гілку — але варто знати, а не "виявити" пізніше як баг.
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

1. **Обмежена конкурентність, НЕ голий `Promise.all`.** GitHub secondary rate limits цілять саме в
   конкурентні ЗАПИСИ (`POST /git/blobs` — запис); необмежений fan-out на batch з 40-50 файлів
   ризикує 403 abuse-detection з retry-after — на мобільному, посеред drain, це виглядає точнісінько
   як та сама мережева нестабільність, від якої захищаємось, тільки цього разу — самим собою
   спричинена. Семафор: 3-6 одночасних мережевих операцій. Той самий семафор вирішує другу проблему
   заразом: N blob-ів одночасно в пам'яті мобільного WebView (вкладення у цьому проєкті вже бувають
   2-50 МБ) — одна межа, дві причини її тримати.
2. **Колізія однакового SHA у паралельному `saveBlobToSyncStore`.** Два шляхи одного батчу з
   ідентичним вмістом (дедуплікація — навмисний, очікуваний випадок, §12.2 SYNC-FIX.md) обидва не
   знаходять blob у сховищі, обидва вантажать/рахують, обидва пишуть `sync_store/{sha}` одночасно.
   Однакові байти роблять "хто останній записав" нешкідливим ТІЛЬКИ якщо сам запис атомарний — тому
   потрібен write-temp-then-rename (з Capacitor exists-check, як і всюди) АБО in-flight promise
   cache, keyed за sha, щоб другий запит на той самий SHA чекав на перший замість дублювання роботи.
3. **Передумова, на якій тримається вся безпека спільних акумуляторів (`commit`, `conflict_commit`,
   `TrackedFiles`)** — **один шлях зустрічається щонайбільше раз в одному батчі.** JS-однопотоковість
   робить конкурентний append у спільний масив/мапу безпечним БЕЗ локів, доки жоден await не
   переривається посеред мутації ОДНОГО й того самого ключа — а це саме так, якщо шлях унікальний у
   межах батчу. Це не припущення "напевно так" — це названа передумова моделі, яку варто звірити з
   `push-queue.ts` (чи справді `enqueue`/`consolidateCommits=false` гарантує, що той самий шлях
   ніколи не потрапляє в ОДИН batch двічі), а не мовчки покладатись на неї.

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
   remote-коміту від пристрою-автора?" Перевірка pull-шляху (рядок ~1113,
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
   впливає (§II.7: `conflict_list` звіряється лише по sha). Інваріант тепер строгий, без
   винятків і без локального годинника: `tracked.remote.mtime` = дата GitHub-коміту, який дав
   цей вміст, хто б його не пушив. Закриває TODO, що висів на цьому рядку з чернетки.