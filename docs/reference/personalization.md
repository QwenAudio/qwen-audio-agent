# Personalization and Memory

Set long-term names and communication preferences in conversation, without editing source code:

- “Call me Captain from now on.”
- “Keep replies more concise from now on.”
- “Remember that I currently live in Hangzhou.”
- “Forget the address you just recorded.”

Names and communication style are preferences; addresses and project facts belong in long-term
memory. Temporary requests apply to the current turn and should not automatically become lasting
settings. Edit `ASSISTANT.md` for the default persona; conversational changes update user preferences
or memory, not the application's default persona.

## Default implementation

With the default configuration, the Gateway uses its built-in Markdown provider. It keeps
the following files under the configuration directory (`~/.config/qwaudio/` for the CLI):

| File | Description |
| --- | --- |
| `ASSISTANT.md` | Instance-wide default persona: identity, personality, relationship stance, and expression style |
| `USER.md` | Long-term personalization overlay for the current user |
| `MEMORY.md` | Durable facts and decisions about the user |
| `memory-audit.jsonl` | Diagnostic log for automatic memory patches, skips, and failures |

These files remain local and are never committed to the source repository. `USER.md` and
`MEMORY.md` are the default provider's physical representation, not a requirement imposed on
other providers.

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

## Preference self-update (default provider only, off by default)

Set `QWEN_AUDIO_PREFERENCE_LEARNING=on` to observe a small set of traits after a session and
write them to the observed section of `USER.md` only after cross-session confirmation.
It is off by default and adds text-model calls. Explicit preferences always override inferences;
you can inspect or delete the observed section.

### Promotion gate

See [Preference Learning](preference-learning.md#promotion-gate) for counts and expiry.

### Four structural guards

See [Preference Learning](preference-learning.md#four-structural-guards) for evidence checks and diagnostics.

## Replacing the memory implementation

Markdown memory is the default; [VoiceMem](../scenarios/voicemem.md) is an optional alternative.
Developer interfaces and the four context layers are documented in [Memory Provider](memory-provider.md).

## Data and Privacy

Files are stored on the Gateway host. With cloud models, relevant preferences and memories are
still supplied as context; processing is not entirely offline. Do not store passwords, keys, or
verification codes. See [Memory](memory.md) for automatic reconciliation, optional model settings,
and removal.

## Read next

- [Memory](memory.md): automatic reconciliation, session recall, and optional connectors.
