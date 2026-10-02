#!/bin/sh
# Tracker launches can deploy this project over SSH without disabling file isolation.
# Other projects retain the default workspace-write network restrictions.
set -eu
tracker_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
task_root=$(pwd -P)
if [ "$task_root" = "$tracker_root" ]; then
  exec codex exec --skip-git-repo-check --sandbox workspace-write \
    -c sandbox_workspace_write.network_access=true "$@"
fi
exec codex exec --skip-git-repo-check --sandbox workspace-write "$@"
