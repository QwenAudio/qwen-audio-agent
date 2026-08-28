# Assistant Profile and User Preferences

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

## Preference Self-Update (off by default)

With `QWEN_AUDIO_PREFERENCE_LEARNING=on`, the Gateway observes user traits from a
finished session and writes them to `USER.md` only after enough cross-session
confirmation. It is off by default because it adds one model call per session.

Four fields only, with deliberately narrow value spaces:

| Field | Meaning |
| --- | --- |
| `occupation` | Occupation |
| `special_skills` | Technologies or domains the user is strong in, capped at 6 |
| `response_length` | Reply length; only `brief`, `normal`, or `detailed` |
| `response_style` | Reply style |

Writes land in the `## 观察推断` (observed) section of `USER.md`, kept
**physically separate** from `## 用户明确要求` (explicitly stated). An explicit
statement always wins on conflict. The split prevents inferred content from
polluting what the user wrote: the user can see which lines came from their own
words and which the system guessed, and can edit or delete the latter.

### Promotion gate

An observation reaches the document only when `confirm ≥ 2` **and** the
confirmations come from **≥ 2 distinct sessions**. `confirm` resets after 90 days
with no new confirmation.

### Four structural guards

A model sometimes supplies a genuine quote while the inference from that quote
does not hold. Repeated sampling cannot filter this class out — the user says the
same sentence every session, the model makes the same wrong inference, and the
counter climbs to the threshold anyway. The guards therefore apply at admission
time:

| Guard | What it blocks |
| --- | --- |
| `quote_not_from_user` | The quote must appear verbatim in a user turn: blocks fabricated evidence, assistant speech treated as user preference, and self-reinforcement |
| `value_not_anchored` | The literal parts of the conclusion must be findable in the quote |
| `value_parrots_quote` | Value equals the quote — that is repetition, not feature extraction |
| `quote_not_about_interaction` | For interaction-preference fields the quote must address the assistant: blocks "how long the content should be" being read as "how long the reply should be" |

Diagnostics land in `memory-audit.jsonl`, so a rejected observation can be
explained after the fact.

## Read next

- [Long-Term Memory](memory.md) — `MEMORY.md` mechanics, the `memory` tool,
  session digests and recall, and the replaceable Memory Provider
