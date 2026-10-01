---
description: Перенести в AI Tracker историю всех прошлых чатов проекта
---

Перенеси в AI Tracker историю прошлых чатов. Открывать сами чаты не нужно: по ним уже сделаны выжимки. Твоя часть работы — прочитать выжимки и составить планы задач. В трекер ты не пишешь: записью занимается скрипт, его запустит человек.

$ARGUMENTS

## Где что лежит

Каталоги переноса — в `~/Projects/AI-tracker/history/`, по одному на проект и агента:

| Каталог | Проект | Чьи чаты |
|---|---|---|
| `stillhere-codex` | StillHere | Codex |
| `drop-codex` | Drop | Codex |
| `stillhere-claude` | StillHere | Claude |
| `drop-claude` | Drop | Claude |

Бери каталоги своего агента: Codex — `*-codex`, Claude — `*-claude`. Если человек назвал каталог или проект, работай только с ним.

Правила разбора — в `~/Projects/AI-tracker/prompts/tracker-history-plan.md`. Прочитай этот файл целиком до начала.

## Порядок

1. **Узнай, что осталось.** Для каждого своего каталога:

   ```bash
   node --disable-warning=ExperimentalWarning ~/Projects/AI-tracker/server/scripts/history.ts status --out ~/Projects/AI-tracker/history/<каталог>
   ```

   В `batches_without_plan` — пакеты, которые ещё не разобраны. Разобранные не трогай.

2. **Разбери пакеты по одному.** Для пакета `batch-NNN`: прочитай `batches/batch-NNN.md`, затем все перечисленные в нём выжимки целиком, составь план по правилам и запиши в `plans/batch-NNN.json`. Префикс ключей задач — короткое имя каталога и номер пакета, например `sh-x012-` для двенадцатого пакета `stillhere-codex` и `drop-x001-` для `drop-codex`.

3. **Проверяй каждый план сразу** той же командой `status`: в `problems` не должно быть строк про твой пакет. Исправь и проверь снова, прежде чем брать следующий.

4. **Работай, пока пакеты не кончатся.** Пакеты независимы, поэтому их можно раздавать суб-агентам и вести параллельно; у каждого суб-агента свой пакет и свой файл плана. Если работу пришлось прервать, в следующий раз продолжи с шага 1: готовые планы сохранятся.

5. **Собери структуру**, когда все пакеты каталога разобраны. Выведи список задач:

   ```bash
   node --disable-warning=ExperimentalWarning ~/Projects/AI-tracker/server/scripts/history.ts outline --out ~/Projects/AI-tracker/history/<каталог>
   ```

   Сгруппируй задачи в эпики и стори и запиши в `plans/structure.json`:

   ```json
   {
     "tasks": [
       { "key": "sh-epic-melee", "title": "Ближний бой", "description": "…", "level": "epic", "status": "in_progress", "from_person": false },
       { "key": "sh-story-hit-react", "title": "Зомби реагирует на удар", "description": "…", "level": "story", "parent_key": "sh-epic-melee", "status": "done", "result": "…", "from_person": false }
     ],
     "parents": { "sh-x012-hit-react-anim": "sh-story-hit-react" }
   }
   ```

   В `parents` — какая задача из планов в какую стори или эпик входит. Эпик — когда у нескольких стори общая цель; одиночную задачу никуда не вкладывай. Статус эпика и стори: `done`, если готово всё, что в них входит, иначе `in_progress`. Проверь через `status`.

6. **Отчитайся:** сколько пакетов разобрано, сколько задач в планах, сколько чатов пропущено и почему, что осталось неясным. Напомни человеку команду записи:

   ```bash
   node --disable-warning=ExperimentalWarning ~/Projects/AI-tracker/server/scripts/history.ts import --out ~/Projects/AI-tracker/history/<каталог> --dry-run
   ```

   Без `--dry-run` она запишет задачи в трекер. Сам её не запускай: у твоих команд может не быть доступа к сети.

## Ограничения

- Изменяй только файлы в `plans/`. Выжимки, индекс и репозитории проектов не трогай.
- Не придумывай результат. Если по выжимке неясно, чем кончилось, — так и пиши.
- Ключи, пароли и токены в план не переноси.
