# Desktop Pet Skin Protocol

This document defines the desktop pet package consumed by qwen-audio-agent.
It uses the Codex Pet atlas as its compatibility baseline and adds optional
`animations.frames/fps` metadata for generated skins whose actions use a
variable number of frames.

`animations` is a qwen-audio-agent extension, not an official Codex Pet
manifest field. Community Codex Pet packages without it continue to use the
fixed atlas rules.

## Package layout

```text
<skin-id>/
├── pet.json
└── spritesheet.webp
```

- v1: 1536×1872, 8 columns × 9 rows, 192×208 per cell.
- v2: 1536×2288, 8 columns × 11 rows. Its first 9 rows match v1; the last
  2 rows contain 16 look directions.
- Frame indices are zero-based in row-major order: `row × 8 + column`.

## Nine standard actions

Producers should use only these action names. An action lists its frames in
playback order — conventionally 1–8 frames from its assigned row (the sheet
total is bounded by 256 frames).

| Row | Action | Meaning | Default frames |
| ---: | --- | --- | --- |
| 0 | `idle` | idle | 0–5 |
| 1 | `running-right` | run right | 8–15 |
| 2 | `running-left` | run left | 16–23 |
| 3 | `waving` | wave | 24–27 |
| 4 | `jumping` | jump | 32–36 |
| 5 | `failed` | failure | 40–47 |
| 6 | `waiting` | wait | 48–53 |
| 7 | `running` | run | 56–61 |
| 8 | `review` | review | 64–69 |

## pet.json

```json
{
  "id": "example-pet",
  "displayName": "Example Pet",
  "description": "Optional description",
  "spriteVersionNumber": 1,
  "spritesheetPath": "spritesheet.webp",
  "animations": {
    "idle": {
      "frames": [0, 1, 2, 3],
      "fps": 3
    },
    "waving": {
      "frames": [24, 25, 26, 27],
      "fps": 8
    }
  }
}
```

Base fields:

- `id`: required unique skin identifier.
- `displayName`: recommended UI label.
- `description`: optional.
- `spriteVersionNumber`: optional and defaults to v1; v2 must set `2`.
- `spritesheetPath`: optional; defaults to `spritesheet.webp`.
- `animations`: optional qwen-audio-agent animation extension.

Each `animations` entry contains only:

- `frames`: required non-empty array of global frame indices. Indices must be
  in bounds and should stay within the action's standard row.
- `fps`: optional playback rate, greater than 0 and no greater than 60;
  defaults to 8.

Skins do not own animation lifecycle. `loop` and `fallback` are not part of
this protocol. Legacy packages containing them remain importable, but
qwen-audio-agent ignores their meaning. The skin consumer decides how long
an action runs and which action follows it.

## Defaults and compatibility

- Without `animations`, use the Codex Pet fixed rows, effective frame counts,
  and default timing.
- With `animations`, declared actions use `frames/fps`; omitted actions retain
  their defaults.
- Native Codex clients may ignore `animations`, so the extension guarantees
  precise playback in qwen-audio-agent only.

## Producer checklist

- Atlas size, grid, and transparency are correct.
- Only the nine standard action names are used.
- Every `frames` entry stays within its assigned action row.
- `fps` matches the intended motion.
- Do not emit `loop` or `fallback`.
- `idle` depicts natural idle motion rather than sleep; `running` depicts
  running rather than coding.

See the complete [Firefly pet.json example](./examples/firefly.pet.json).
