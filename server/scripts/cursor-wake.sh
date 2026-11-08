#!/bin/sh
# Cursor's CLI owns model selection; the tracker account remains cursor.
set -eu
tracker_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
AI_TRACKER_KEY=$(cat "${AI_TRACKER_CURSOR_KEY_FILE:-$HOME/.config/ai-tracker/cursor.key}")
export AI_TRACKER_KEY
export AI_TRACKER_ACCOUNT=cursor
request=$1
shift
rules=$(cat "$tracker_root/prompts/tracker-rules.md")
accounting='Для Cursor нет проверенного счётчика токенов: не запускай session-usage.ts --find codex или claude. Запиши время start_timer/stop_timer с настоящей моделью и effort; неизвестные токены и стоимость оставь пустыми. Если выбран Auto и реальная модель не сообщена, укажи model="cursor-auto", effort="unknown" и объясни это в записи.'
exec "${AI_TRACKER_CURSOR_BIN:-agent}" --print --output-format stream-json --sandbox enabled --force "$@" "$rules

$accounting

$request"
