#!/usr/bin/env bash
set -euo pipefail

# Git consumes stdout as its credential protocol; never invoke this for logging.
# Do not persist credentials on Git's store/erase callbacks.
[ "${1:-}" = get ] || exit 0
protocol= host= path=
while IFS='=' read -r key value && [ -n "$key" ]; do
  case "$key" in
    protocol) protocol=$value ;;
    host) host=$value ;;
    path) path=$value ;;
  esac
done
[ "$protocol" = https ] || exit 0
[ -n "$host" ] && [ -n "$path" ] || exit 0
[ "https://$host/$path" = "${SYNC_TARGET_URL:-}" ] || exit 0
[ -n "${SYNC_GITLAB_USERNAME:-}" ] || exit 0
[ -n "${SYNC_GITLAB_TOKEN:-}" ] || exit 0
case "$SYNC_GITLAB_USERNAME$SYNC_GITLAB_TOKEN" in *$'\n'*|*$'\r'*) exit 0 ;; esac
printf 'username=%s\npassword=%s\n' "$SYNC_GITLAB_USERNAME" "$SYNC_GITLAB_TOKEN"
