# Assistant Profile, User Preferences, and Memory

Frontend context is split into four layers with non-overlapping responsibilities:

| Layer | Source | Responsibility |
| --- | --- | --- |
| Core policy | `config/frontend-agent/PROMPT.md` | Tool protocol, permission, safety, and task boundaries; user memory cannot override it |
| Assistant profile | `ASSISTANT.md` | Instance-wide default identity, personality, relationship stance, and expression style; configured by users or downstream products |
| User preferences | `USER.md` / `user` | Explicit long-term personalization for the current user; overrides the default persona |
| Long-term memory | `MEMORY.md` / `memory` | Durable facts and decisions used to understand the user and answer questions; no behavioral authority |

Instruction conflicts resolve in this order: core policy, the user's current explicit request,
the user preferences, then the assistant profile. Long-term memory is not part of the instruction
hierarchy; it is evidence only, and the user's current statement wins when facts conflict.
Saying “keep replies shorter from now on” or “call yourself Skiff from now on” updates the
current user's `USER.md`, not instance-wide `ASSISTANT.md`; a temporary request applies only to
the current turn.

User data is stored under the configuration directory (`~/.config/qwaudio/` for the CLI):

| File | Description |
| --- | --- |
| `ASSISTANT.md` | Instance-wide default persona: identity, personality, relationship stance, and expression style |
| `USER.md` | Long-term personalization overlay for the current user |
| `MEMORY.md` | Durable facts and decisions about the user |
| `memory-audit.jsonl` | Diagnostic log for automatic memory patches, skips, and failures |
| `tasks.json` | Background task results and pending notification states |
| `state.env` | Local identity key (auto-generated on first launch, readable and writable only by the current user) |
| `logs/` | Credential-redacted, auto-rotated local runtime logs |

These files are stored only on the local machine, are never committed to the source
repository, and have file permissions restricted to the current user only.

## Assistant Profile

On first launch, the packaged `config/frontend-agent/ASSISTANT.md` template is copied to the
local `ASSISTANT.md`; upgrades never overwrite it. Edit the local file to change the whole
assistant instance's default name, personality, relationship stance, and expression style.
Changes apply to the next voice session. You can also
point `QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH` to another file.

`ASSISTANT.md` is neither conversation memory nor runtime policy. The assistant never changes it
through the `memory` tool. Statements about tools, permissions, safety, memory, task routing, or
capabilities cannot override `PROMPT.md`.

## User Preferences

`USER.md` is the current user's long-term personalization overlay on the default persona, not a
second assistant persona or a general fact store. It may contain how the assistant addresses the
user, how this user addresses the assistant, and explicitly requested language, reply style, and
default behavior. It changes only for an explicit user setting or correction. Session-end
reconciliation may recover such an explicit directive, but it never infers one.

Classify by scope, not grammatical subject. “The assistant's default name is Qwen Audio” belongs
in `ASSISTANT.md`; when the current user says “call yourself Skiff from now on,” Skiff is that
user's override and belongs in `USER.md`. Likewise, “continue project A by default” belongs in
`USER.md`, while “project A uses React” is a fact for `MEMORY.md`. It is ordinary Markdown. Tool
writes take effect immediately; direct edits apply to the next voice session. To store it elsewhere, set
`QWEN_AUDIO_AGENT_USER_MODEL_PATH` (the legacy
`QWEN_AUDIO_AGENT_USER_PROFILE_PATH` name is still accepted).

Do not store passwords, API Keys, verification codes, or tokens in this file.

Legacy `profile`, `rules`, and `user` records from `frontend-memory.json` are migrated into
`USER.md` on first launch.

## Long-Term Memory

Composer dictation does not create transcript or episodic history. Partial,
cancelled, failed, timed-out, and otherwise unsubmitted text never reaches this
service. Only a successfully submitted, explicit `correct long-term fact:`
instruction may perform an exact replacement in `memory`; it uses the same
sensitive-content policy and metadata-only audit as existing Memory writes.

`MEMORY.md` stores durable facts and decisions about the user—such as location, habits,
interests, relationships, projects, goals, and plans—in ordinary Markdown. It informs
understanding and answers but carries no behavioral authority. Content comes from two sources:

- **Explicitly requested**: When you say "remember, change, no longer" etc., the assistant
  generates precise Markdown edits. Multiple durable items in one utterance are handled as
  separate atomic operations in the same turn, followed by one final response.
- **Automatic reconciliation**: After a session ends, a lightweight text model fills gaps by
  routing explicit long-term interaction directives to `USER.md` and stable facts or decisions
  to `MEMORY.md`. Automatic reconciliation uses DashScope's `qwen-flash` model by default (reusing
  `DASHSCOPE_API_KEY`); it is automatically disabled when no API Key is available, and
  explicitly requested memory is unaffected. Set `QWEN_AUDIO_MEMORY_AUTO=off` to disable
  it globally; `QWEN_AUDIO_MEMORY_MODEL`, `QWEN_AUDIO_MEMORY_BASE_URL`, and
  `QWEN_AUDIO_MEMORY_API_KEY` can point to any OpenAI-compatible endpoint (including
  local Ollama).

Realtime and automatic reconciliation submit constrained Markdown changes through the same
memory service; neither writes the files directly. Reconciliation may recover a form of address
or reply preference the user explicitly stated, but never infer one, and it can never modify
`ASSISTANT.md`. Sensitive content is intercepted by dual filtering. `memory-audit.jsonl` records
patch outcomes, revisions, and errors without copying the full memory text. If something is
wrong, say "that one is wrong" or "forget it"; the assistant edits or removes the matching
Markdown text.

The frontend exposes one `memory` tool, with one atomic operation per call: `read` reads one or
both documents, `append` adds Markdown, and `replace` replaces or removes a uniquely matching
`old_text` fragment. Realtime may issue several calls in one turn when an utterance contains
several durable changes; the Gateway still produces only one follow-up response. Each write
starts from the latest document, and an exact replacement fails safely when its source fragment
is missing or ambiguous.

## Logs

Logs use JSON Lines format. API Keys, Tokens, Authorization headers, Cookies, passwords,
and Secret fields are redacted before writing. By default, microphone audio, user
transcription text, model reply text, and task results are not logged. In the desktop
edition, you can open the log directory via "Settings → Application → Logs." See
[configuration guide](../configuration.md#本地日志) for details.
