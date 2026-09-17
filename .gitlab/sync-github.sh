#!/usr/bin/env bash
set -euo pipefail

# This script runs from the CI GitLab checkout. It imports GitHub objects,
# never executes the fetched tree, and creates a normal child of GitLab main.
source_url=${SYNC_SOURCE_URL:-}
target_remote=${SYNC_TARGET_REMOTE:-origin}
bootstrap_target=${SYNC_BOOTSTRAP_TARGET:-}
bootstrap_source=${SYNC_BOOTSTRAP_SOURCE:-}
dry_run=${SYNC_DRY_RUN:-true}
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never

# CI provides GNU timeout; local macOS tests may not. HTTP low-speed limits
# remain active on either platform. Do not let unattended auth wait for input.
network_git() {
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=10s 180s git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 "$@"
  else
    git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 "$@"
  fi
}

fail() { printf 'Sync stopped: %s\n' "$1" >&2; exit 1; }
for variable in SYNC_SOURCE_URL SYNC_COMMIT_NAME SYNC_COMMIT_EMAIL; do
  [ -n "${!variable:-}" ] || fail "$variable is required"
done
case "$dry_run" in true|false) ;; *) fail 'SYNC_DRY_RUN must be true or false' ;; esac
git rev-parse --git-dir >/dev/null

# Keep credentials out of remote URLs, command arguments and Git config.
# Only the exact GitLab repository can obtain the step-scoped environment token.
credential_helper=
if [ -n "${SYNC_GITLAB_TOKEN:-}" ]; then
  [ "$target_remote" = origin ] || fail 'Authenticated CI sync requires the origin remote'
  for variable in SYNC_TARGET_URL SYNC_GITLAB_USERNAME; do
    [ -n "${!variable:-}" ] || fail "$variable is required for authenticated sync"
  done
  target_url_pattern='^https://[[:alnum:].-]+(:[0-9]+)?/[[:alnum:]._~%/-]+$'
  [[ "$SYNC_TARGET_URL" =~ $target_url_pattern ]] \
    || fail 'SYNC_TARGET_URL must be an HTTPS repository URL without credentials, query or fragment'
  case "$SYNC_GITLAB_USERNAME$SYNC_GITLAB_TOKEN" in
    *$'\n'*|*$'\r'*) fail 'Credentials must not contain line breaks' ;;
  esac
  git remote set-url origin "$SYNC_TARGET_URL"
  git config --unset-all remote.origin.pushurl || [ "$?" = 5 ]
  credential_script=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/git-credential.sh
  printf -v credential_helper '!bash %q' "$credential_script"
fi
target_git() {
  if [ -n "$credential_helper" ]; then
    network_git -c credential.helper= -c credential.useHttpPath=true \
      -c "credential.helper=$credential_helper" "$@"
  else
    network_git "$@"
  fi
}

# Do not send destination credentials to the public GitHub source.
printf '[1/4] Fetch GitHub main\n'
(
  unset SYNC_GITLAB_TOKEN
  network_git -c credential.helper= -c http.extraHeader= \
    -c http.https://github.com/.extraHeader= \
    fetch --quiet --no-tags "$source_url" main
)
source_commit=$(git rev-parse 'FETCH_HEAD^{commit}')
source_tree=$(git rev-parse "$source_commit^{tree}")
printf '[2/4] Fetch GitLab main\n'
target_git fetch --quiet --no-tags "$target_remote" main
target_commit=$(git rev-parse 'FETCH_HEAD^{commit}')
target_tree=$(git rev-parse "$target_commit^{tree}")

printf '[3/4] Verify snapshot baseline\n'
previous_source=$(git show -s --format='%(trailers:key=GitHub-Commit,valueonly)' "$target_commit")
if [ -z "$previous_source" ]; then
  [ -n "$bootstrap_target" ] && [ -n "$bootstrap_source" ] \
    || fail 'Initial sync requires SYNC_BOOTSTRAP_TARGET and SYNC_BOOTSTRAP_SOURCE'
  [ "$target_commit" = "$bootstrap_target" ] || fail 'GitLab main has an unrecognized commit; manual review is required'
  previous_source=$bootstrap_source
else
  previous_repository=$(git show -s --format='%(trailers:key=GitHub-Repository,valueonly)' "$target_commit")
  [ "$previous_repository" = "$source_url" ] || fail 'The previous snapshot belongs to a different source repository'
fi
[[ "$previous_source" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid GitHub baseline commit'
git cat-file -e "$previous_source^{commit}" || fail 'GitHub baseline is unavailable'
[ "$target_tree" = "$(git rev-parse "$previous_source^{tree}")" ] \
  || fail 'GitLab main contains changes outside the recorded GitHub snapshot'
git merge-base --is-ancestor "$previous_source" "$source_commit" \
  || fail 'GitHub main history diverged from the previous snapshot'

if [ "$target_tree" = "$source_tree" ]; then
  printf 'No code changes. GitHub main: %s; GitLab main: %s\n' "$source_commit" "$target_commit"
  exit 0
fi

message=$(printf 'sync: GitHub main %s..%s\n\nGitHub-Repository: %s\nGitHub-Commit: %s\nGitHub-Previous: %s\n' \
  "${previous_source:0:12}" "${source_commit:0:12}" "$source_url" "$source_commit" "$previous_source")
snapshot=$(printf '%s\n' "$message" | \
  GIT_AUTHOR_NAME="$SYNC_COMMIT_NAME" GIT_AUTHOR_EMAIL="$SYNC_COMMIT_EMAIL" \
  GIT_COMMITTER_NAME="$SYNC_COMMIT_NAME" GIT_COMMITTER_EMAIL="$SYNC_COMMIT_EMAIL" \
  git commit-tree "$source_tree" -p "$target_commit")

# A regular push also acts as a concurrency guard: another writer moving main
# causes rejection. Never force-push, merge, or silently replace their changes.
if [ "$dry_run" = true ]; then
  printf '[4/4] Validate GitLab push permission (dry run)\n'
  target_git push --dry-run "$target_remote" "$snapshot:refs/heads/main"
  printf 'Dry run passed. Would sync %s..%s; no remote changes made.\n' "$previous_source" "$source_commit"
else
  printf '[4/4] Push GitLab snapshot\n'
  target_git push "$target_remote" "$snapshot:refs/heads/main"
  printf 'Synced GitHub %s to GitLab %s.\n' "$source_commit" "$snapshot"
fi
