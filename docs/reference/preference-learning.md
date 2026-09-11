# Preference Learning

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

See [Personalization](personalization.md) for user settings and [Memory Provider](memory-provider.md) for integration boundaries.
