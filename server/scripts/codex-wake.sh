#!/bin/sh
# Tracker launches can deploy this project over SSH without disabling file isolation.
# Other projects retain the default workspace-write network restrictions.
set -eu
# Give unattended runs browser tools up front. The MCP process is started by
# Codex, outside the shell-command sandbox; Chrome uses a fresh in-memory profile.
set -- -c 'mcp_servers.playwright={command="npx",args=["-y","@playwright/mcp@0.0.76","--browser","chrome","--headless","--isolated"],default_tools_approval_mode="approve",startup_timeout_sec=60,tool_timeout_sec=120}' "$@"
tracker_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
task_root=$(pwd -P)
if [ "$task_root" = "$tracker_root" ]; then
  exec codex exec --skip-git-repo-check --sandbox workspace-write \
    -c sandbox_workspace_write.network_access=true "$@"
fi
exec codex exec --skip-git-repo-check --sandbox workspace-write "$@"
