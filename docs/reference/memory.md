# User Profile and Memory

User data is stored under the configuration directory (`~/.config/qwaudio/` for the CLI):

| File | Description |
| --- | --- |
| `USER.md` | Name, location, preferences, and frequently used projects |
| `frontend-memory.json` | Cross-session long-term memory (explicitly requested to remember, plus automatically distilled after sessions) |
| `memory-audit.jsonl` | Audit log for automatic memory (writes, skips, and failures appended per entry, for retrospective review only) |
| `tasks.json` | Background task results and pending notification states |
| `state.env` | Local identity key (auto-generated on first launch, readable and writable only by the current user) |
| `logs/` | Credential-redacted, auto-rotated local runtime logs |

These files are stored only on the local machine, are never committed to the source
repository, and have file permissions restricted to the current user only.

## USER.md

You can edit `USER.md` directly to write content by hand, or ask the assistant during a
conversation to remember or forget information. The program only modifies marked managed
regions within the file; all other hand-written content is preserved as-is. Changes take
effect in the next conversation turn. To store the profile in a different location, set
`QWEN_AUDIO_AGENT_USER_PROFILE_PATH`.

Do not store passwords, API Keys, verification codes, or tokens in this file.

## Long-Term Memory

`frontend-memory.json` stores personal facts, preferences, and agreements remembered
across sessions, from two sources:

- **Explicitly requested**: When you say "remember, change, no longer" etc. in a
  conversation, the assistant updates or replaces old records with the corresponding
  memory operation.
- **Automatic distillation**: After a session ends, a lightweight text model extracts
  stable personal facts (such as preferences, habits, long-term plans) from the
  conversation and saves them silently — no need to say "remember." Automatic
  distillation uses DashScope's `qwen-flash` model by default (reusing
  `DASHSCOPE_API_KEY`); it is automatically disabled when no API Key is available, and
  explicitly requested memory is unaffected. Set `QWEN_AUDIO_MEMORY_AUTO=off` to disable
  it globally; `QWEN_AUDIO_MEMORY_MODEL`, `QWEN_AUDIO_MEMORY_BASE_URL`, and
  `QWEN_AUDIO_MEMORY_API_KEY` can point to any OpenAI-compatible endpoint (including
  local Ollama).

Automatic distillation only writes to general long-term memory and does not create or
modify long-term agreements or the user profile; sensitive content such as passwords and
keys is intercepted by dual filtering. Every automatic write is logged in
`memory-audit.jsonl` for review. If you think a memory entry is incorrect, simply say
"that one is wrong" or "forget it" in the conversation. Memory capacity and retention
period use built-in defaults; see [configuration guide](../configuration.md) for
details.

## Logs

Logs use JSON Lines format. API Keys, Tokens, Authorization headers, Cookies, passwords,
and Secret fields are redacted before writing. By default, microphone audio, user
transcription text, model reply text, and task results are not logged. In the desktop
edition, you can open the log directory via "Settings → Application → Logs." See
[configuration guide](../configuration.md#本地日志) for details.
