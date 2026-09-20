# Backend Skills

Skills are standard directories containing `SKILL.md`, read and executed by the Backend Agent. They are not installed for the voice frontend and do not give it a Shell or file execution environment.

## Install and manage

`qwenaudio skill` invokes the community [skills.sh](https://skills.sh) installer, selecting supported backends detected on the machine and the currently configured backend.

List the skills in a source, then install the ones you need:

```bash
qwenaudio skill install vercel-labs/agent-skills --list
qwenaudio skill install vercel-labs/agent-skills --skill web-design-guidelines
```

You can also use a Git repository URL or local directory:

```bash
qwenaudio skill install ./my-skill --skill my-skill
```

Repeat `--skill` to select multiple skills. Install only what you need and trust; the command does not install an entire skill repository by default.

```bash
qwenaudio skill list
qwenaudio skill remove <name>
qwenaudio skill update
```

## Installation location

Skills go into supported user-level directories such as `~/.qwen/skills/`, `~/.claude/skills/`, or `~/.agents/skills/`. They are also available when running those Agents directly; Desktop and CLI do not need separate copies.

Only backends that declare support for the installer are selected. MiniMax Code manages its own Skill / Plugin storage; the command does not write to its private directories.

When switching backends, the Gateway checks the installer lock file at startup and attempts to synchronize missing skills. Failures are logged, not treated as successful installation. If offline, retry installation or startup later.

## Activate a skill

Reload behavior varies by backend. If a newly installed skill is not discovered, [restart the Gateway you actually use](../operations/gateway.md#applying-configuration-changes) so it restarts the backend. Then explicitly request the skill and inspect the result; availability does not guarantee that the model selects it every time.

The frontend calls the backend to execute requests; it does not load all backend skills into its own prompt. Prepare any tools, credentials, and dependencies required by the skill in the backend environment.

## Advanced configuration

`QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE` overrides the installer package version. The default is usually sufficient.

The skill installation directory is separate from the working directory. Backends process files in the shared `<data-dir>/workspace` by default; see [Common Backend Settings](../configuration/backend.md) for overrides.
