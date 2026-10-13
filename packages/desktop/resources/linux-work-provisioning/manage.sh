#!/bin/sh
set -eu
if [ "$#" = 0 ]; then set -- diagnose; fi
# The package-owned interpreter is used only to run the packaged setup tool.
# Its namespace permission is never broadened by this installer.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
app_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
case "$app_root" in /opt/*) ;; *) echo 'DAC_PROVISIONING_LAYOUT_UNAVAILABLE' >&2; exit 2;; esac
# The generated contract is validated before any setup mutation in manage.mjs.
# executable.name is create-only package data prepared alongside install.json.
IFS= read -r executable < "$script_dir/executable.name"
case "$executable" in ''|*[!A-Za-z0-9\ ._-]*) echo 'DAC_PROVISIONING_LAYOUT_UNAVAILABLE' >&2; exit 2;; esac
exec env -u NODE_OPTIONS -u NODE_PATH -u LD_PRELOAD -u LD_LIBRARY_PATH -u LD_AUDIT \
  ELECTRON_RUN_AS_NODE=1 "$app_root/$executable" "$script_dir/manage.mjs" "$@"
