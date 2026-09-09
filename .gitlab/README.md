# GitHub → GitLab hourly snapshot

This directory is maintained on GitHub `main` and mirrored to GitLab `main`
with the rest of the repository. No dedicated automation branch is needed.
GitHub Actions runs isolated integration tests only; the scheduled synchronization
runs exclusively in Aone CI for the GitLab repository.

The hosted task checks at the start of every hour, even when GitLab `main`
has not changed. Configure `dry_run=false`, serial execution and failure-only
notifications after validation.

The Aone CI task references `.gitlab/github-sync.yml` on GitLab `main`, checks
out `main`, and runs `.gitlab/sync-github.sh`. Both the task's default branch
and scheduled trigger branch must be `main`, with always-run enabled.
Aone's default CI Token is read-only. Configure the following under repository
Settings → Continuous Integration → Variable Management. Deployment-specific
values belong in CI configuration, not in this directory.

| Name | Type | Value |
| --- | --- | --- |
| `SYNC_SOURCE_URL` | Variables | GitHub source repository URL, without credentials. |
| `SYNC_TARGET_URL` | Variables | GitLab HTTPS repository URL, without credentials. |
| `SYNC_GITLAB_USERNAME` | Variables | Account used to authenticate GitLab writes. |
| `SYNC_COMMIT_NAME` | Variables | Snapshot author and committer name. |
| `SYNC_COMMIT_EMAIL` | Variables | Snapshot author and committer email accepted by the destination. |
| `SYNC_BOOTSTRAP_TARGET` | Variables | Verified initial GitLab main commit SHA. |
| `SYNC_BOOTSTRAP_SOURCE` | Variables | GitHub commit SHA with the same tree as that initial GitLab commit. |
| `GITLAB_SYNC_TOKEN` | Secrets | Token authorized to write this GitLab repository. |

The baseline pair is required only until the first snapshot records its source.
Use the narrowest available token scope and an appropriate expiry.
Checkout uses Aone's read-only CI credential. The write token is supplied only
to the sync step through its environment and a repository-scoped Git credential
helper. Remote URLs and Git config never contain the write token; the GitHub
fetch does not inherit it. Never commit a token or paste one into chat. Keep
the schedule disabled until a real write succeeds.
GitHub source files are never checked out or executed by the job.
The official `setup-github-proxy` component supplies Aone's supported GitHub
transport. Network operations have bounded timeouts and never prompt for login.

Register one repository-YAML template task with an hourly schedule, always-run
enabled, and failure-only notifications. Start with `dry_run=true`; switch it to
false only after a successful hosted-runner dry run and write-permission check.

The synchronizer creates at most one ordinary commit when code differs, using
the configured author and committer identity. The commit tree exactly
matches GitHub main; the commit message records the source SHA and previous SHA.
No changes means no commit. The existing GitLab main history is preserved.

Only the verified initial baseline or a matching previous snapshot is accepted.
Independent GitLab edits, source-history divergence, unavailable baselines and
concurrent pushes fail closed. Never force-push or change a baseline simply to
silence a failure; review it first.

Commit metadata still contains the configured identity and source URL. Moving
configuration out of source files does not anonymize or rewrite Git history.

Run isolated integration tests with `node --test .gitlab/sync-github.test.mjs`.
No personal access token is stored in this directory.
