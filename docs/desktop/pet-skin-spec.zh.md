# 桌宠皮肤协议

本文定义 qwen-audio-agent 使用的桌宠皮肤包格式。它以 Codex Pet 图集为
兼容基础，并增加可选的 `animations.frames/fps`，用于描述生成式皮肤中每个
动作实际占用的帧。

`animations` 是 qwen-audio-agent 扩展，不是 Codex Pet 官方清单字段。未提供
该字段的 Codex Pet 社区皮肤仍按固定图集规则播放。

## 包结构

```text
<skin-id>/
├── pet.json
└── spritesheet.webp
```

- v1 图集：1536×1872，8 列 × 9 行，每格 192×208。
- v2 图集：1536×2288，8 列 × 11 行；前 9 行动作与 v1 相同，后 2 行为
  16 个注视方向。
- 帧索引从 0 开始，按从左到右、从上到下计算：`行号 × 8 + 列号`。

## 九个标准动作

皮肤制作方只应使用以下动作名。每个动作的帧按播放顺序排列——惯例为对应行内的
1–8 帧（整张雪碧图受 256 帧总量上限约束）。

| 行 | 动作名 | 中文含义 | 默认有效帧 |
| ---: | --- | --- | --- |
| 0 | `idle` | 待机 | 0–5 |
| 1 | `running-right` | 向右跑 | 8–15 |
| 2 | `running-left` | 向左跑 | 16–23 |
| 3 | `waving` | 挥手 | 24–27 |
| 4 | `jumping` | 跳跃 | 32–36 |
| 5 | `failed` | 失败 | 40–47 |
| 6 | `waiting` | 等待 | 48–53 |
| 7 | `running` | 奔跑 | 56–61 |
| 8 | `review` | 审查 | 64–69 |

## pet.json

```json
{
  "id": "example-pet",
  "displayName": "Example Pet",
  "description": "可选描述",
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

基础字段：

- `id`：必填，皮肤唯一标识。
- `displayName`：建议填写，界面显示名称。
- `description`：可选。
- `spriteVersionNumber`：可选，省略时为 v1；v2 必须填写 `2`。
- `spritesheetPath`：可选，缺省为 `spritesheet.webp`。
- `animations`：可选的 qwen-audio-agent 动画扩展。

每个 `animations` 条目只包含：

- `frames`：必填，非空的全局帧索引数组；索引不能越界，并应位于该动作的
  标准行内。
- `fps`：可选，播放帧率，大于 0 且不超过 60；省略时为 8。

皮肤不得控制动作生命周期。`loop`、`fallback` 不属于本协议；旧皮肤即使包含
这些字段也会被兼容导入，但 qwen-audio-agent 不读取其含义。动作是否持续、何时
结束以及随后播放什么，由使用皮肤的播放器决定。

## 缺省与兼容

- 没有 `animations`：按 Codex Pet 的固定行、固定有效帧数和默认时序播放。
- 有 `animations`：所声明动作使用 `frames/fps`；未声明动作继续使用默认规则。
- 原生 Codex 客户端可能忽略 `animations`，因此该扩展保证的是
  qwen-audio-agent 中的精确播放。

## 制作方检查清单

- 图集尺寸、网格和透明背景正确。
- 只使用九个标准动作名。
- 每个动作的 `frames` 都位于对应行且不重复引用其他动作行。
- `fps` 与动作观感匹配。
- 不生成 `loop` 或 `fallback`。
- `idle` 表现自然待机，而不是睡眠；`running` 表现奔跑，而不是编程。

完整清单可参考 [Firefly pet.json 示例](./examples/firefly.pet.json)。
