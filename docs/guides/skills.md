# Backend Skills


Backend agents execute the actual tasks, so standard Agent Skills
(`SKILL.md` folders in the open format) are installed for backends.
`qwenaudio skill` is a branded entry point for the community-standard
[skills.sh](https://skills.sh) installer (`npx skills`): every command is a
1:1 passthrough, with one addition — installs target the backends that
actually exist on this machine (CLI detected) plus the currently configured
backend, instead of relying on skills.sh's own agent detection.

```bash
qwenaudio skill install <source> --skill <name>   # install to every backend
qwenaudio skill install <source> --list           # list skills in a source
qwenaudio skill list                              # list installed skills
qwenaudio skill remove <name>                     # remove a skill
qwenaudio skill update                            # update installed skills
```

Supported sources are whatever skills.sh supports:

| Source form | Example |
| --- | --- |
| GitHub shorthand | `qwenaudio skill install vercel-labs/agent-skills --skill web-design-guidelines` |
| Repository URL (GitHub/GitLab/any git) | `qwenaudio skill install https://github.com/alirezarezvani/claude-skills --skill skill-security-auditor` |
| Tree URL (skill subdirectory) | `qwenaudio skill install https://github.com/o/r/tree/main/skills/x --skill x` |
| Hub skill page URL | `qwenaudio skill install https://clawhub.ai/thcjp/skills/excel-formula-tool-free --skill excel-formula-tool-free` |
| Local directory | `qwenaudio skill install ./my-skill --skill my-skill` |

For multi-skill repositories `--skill` is required (repeat it to install
several); run `--list` first to see what a source provides. Installing an
entire large catalog at once is intentionally not supported — every skill
description is injected into backend system prompts.

Skills land in the backend CLI's own user-level directory when that backend
declares a skills.sh installer (`~/.claude/skills/`, `~/.qwen/skills/`,
`~/.openclaw/skills/`, `~/.agents/skills/`, …), so they also work when you use
those CLIs directly, and the desktop app and CLI share the same skills. MiniMax
Code manages its own Skill/Plugin storage; `qwenaudio skill` does not write to
that private store.

When you switch to — or newly install — a backend that is missing previously
installed skills, the gateway backfills them synchronously at startup: a
millisecond-level local check against the skills.sh lockfile
(`~/.agents/.skill-lock.json`), and only when something is actually missing a
one-off skills.sh run (a few seconds) before the backend process starts, so
the backend always sees a complete skill set on its first scan. Failures
(for example offline) are logged and never block the voice gateway.

The pinned skills.sh version can be overridden with
`QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE` (for example `skills@latest`). If a
newly added backend is not yet supported by skills.sh, contribute an agent
definition to its `src/agents.ts` — that is the official extension point.

### When skills take effect

Files are synced immediately, but each backend discovers new skills on its
own schedule:

| Backend | Discovery | New skill visible |
| --- | --- | --- |
| Claude Code, Qwen Code, Hermes, DeepSeek | Hot reload (watcher or on-demand read) | Immediately, no action needed |
| Qoder | On session start; `/skills reload` inside a native session | Next backend session |
| OpenCode, OpenClaw, Kimi Code, CodeBuddy, Codex | Snapshot at process or session start | After the backend process restarts |

If a newly installed skill is not discovered, [restart the Gateway for your run mode](../operations/gateway.md#applying-configuration-changes)
so the backend reloads its skills.

### Shared backend workspace

All backends now share one default working directory,
`<data-dir>/workspace`, so switching backends continues the same files
seamlessly. Per-backend overrides (for example `OPENCODE_WORKSPACE`)
still isolate a specific backend when set explicitly.
