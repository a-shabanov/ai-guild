#!/bin/bash
# Puts the tracker's rules, skill and commands where Claude Code and Codex look for them.
# Safe to run again after editing the files in this folder.
set -euo pipefail
cd "$(dirname "$0")"

install_rules() {
  local file="$1"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  python3 - "$file" tracker-rules.md <<'PY'
import re, sys
path, source = sys.argv[1:3]
text, rules = open(path).read(), open(source).read().rstrip("\n") + "\n"
start = text.find("## AI Tracker")
if start < 0:
    text = (text.rstrip("\n") + "\n\n" if text.strip() else "") + rules
else:
    nxt = re.search(r"\n## (?!AI Tracker)", text[start + 5:])
    end = start + 5 + nxt.start() + 1 if nxt else len(text)
    text = text[:start] + rules + ("\n" if nxt else "") + text[end:]
open(path, "w").write(text)
PY
  echo "rules    -> $file"
}

install_rules "$HOME/.claude/CLAUDE.md"
install_rules "$HOME/.codex/AGENTS.md"

for home in "$HOME/.claude" "$HOME/.codex"; do
  mkdir -p "$home/skills/ai-tracker"
  cp skills/ai-tracker/SKILL.md "$home/skills/ai-tracker/SKILL.md"
  echo "skill    -> $home/skills/ai-tracker"
done

mkdir -p "$HOME/.claude/commands" "$HOME/.codex/prompts"
for command in tracker-backfill tracker-plan tracker-history; do
  cp "$command.md" "$HOME/.claude/commands/$command.md"
  cp "$command.md" "$HOME/.codex/prompts/$command.md"
  echo "command  -> /$command"
done

# Instructions that the commands refer to stay in the repository: prompts/tracker-history-plan.md
