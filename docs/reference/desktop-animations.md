# Desktop Animation Integration

The desktop does not flatten every business signal into one "Agent state".
Lifecycle, runtime readiness, voice interaction, and background work remain
separate; skins consume only stable presentation states and one-shot events.

| Standard animation | Meaning | Agent state or event | Playback |
| --- | --- | --- | --- |
| `idle` | Resting | `idle`, `connecting`, `occupied` | Loop while the state persists |
| `running-right` | Moving right | The user drags the pet right | Loop while dragging |
| `running-left` | Moving left | The user drags the pet left | Loop while dragging |
| `waving` | Speaking | `speaking` | Loop for the full `speaking` state |
| `jumping` | Success / wake | `waking`, first startup readiness, successful task completion, pointer enter | Play once per event |
| `failed` | Failure | `error`, desktop runtime failure, task failure | Play once per event |
| `waiting` | Listening | `listening` | Loop for the full `listening` state |
| `running` | Working / startup | `working`, `starting` | Loop while the state persists |
| `review` | Foreground turn processing | `processing` | Play once per processing phase |

Sustained states and one-shot events are arbitrated separately: startup,
listening, speaking, and background work retain their looping tracks, while
first readiness, wake, task results, foreground processing, and pointer entry
play once. A one-shot action restores the current base track: `running` while
work remains active, otherwise `idle`. Every active background task uses
`working` → `running`, including backend thinking; a pending authorization does
not select an Agent animation and remains visible in the Task UI until its
spoken request naturally enters `speaking`. Every task kind uses the same
start, completion, and failure rules. Front-end-only mode skips backend readiness.
Skin packages are static assets only (JSON + WebP) and are validated on
import; if a selected skin package is removed, the orb falls back to the
built-in appearance.

See [Pet Skin Protocol](../desktop/pet-skin-spec.md) for resource formats and [Desktop](../desktop/overview.md) for everyday use.
