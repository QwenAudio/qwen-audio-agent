# Music tool design

本文记录 smart-cockpit 示例中的音乐 / 媒体 function call 设计。参考 Tesla Fleet API 的媒体命令、Fleet Telemetry 的媒体状态字段，以及 Tesla 车主手册中的语音媒体控制说明，但工具粒度保持本项目的车机业务语义。

## 设计定位

音乐工具保持“状态查询独立、播放控制保留常用快捷函数、音量/来源/收藏按能力域聚合”的粒度。

设计分层：

- 模型可见工具：表达用户意图和车机媒体动作，例如播放歌曲、暂停、切歌、调节音量、切换媒体来源、收藏歌曲、查询当前播放。
- 服务层能力：把业务工具参数映射到底层媒体播放器、厂商 API、媒体服务 SDK 或本地 Demo 状态。
- 状态层：维护当前播放状态、当前曲目、播放来源、音量、静音、搜索结果和收藏列表。

这样可以减少模型在底层媒体 endpoint 之间的选择负担，同时保留车机语音里最常见的即时媒体控制。

## 工具大类

| 大类 | 工具 | 目标 |
| --- | --- | --- |
| 状态查询 | `music_state_query` | 查询当前播放、音量、来源、收藏或搜索结果 |
| 播放/搜索 | `music_play`, `music_search` | 点播/继续播放，或只搜索不播放 |
| 播放控制 | `music_toggle_playback`, `music_pause`, `music_next`, `music_previous` | 播放暂停切换、暂停、上一首、下一首 |
| 音量控制 | `music_volume_control` | 设置、调高、调低、静音或取消静音媒体音量 |
| 来源控制 | `music_source_control` | 切换广播、蓝牙、USB、QQ音乐、Spotify、Apple Music 等媒体来源 |
| 收藏控制 | `music_favorite_control` | 收藏/取消收藏歌曲，或切换上一首/下一首收藏 |

## Function call 表

| Function | 什么时候调用 | 关键参数 | 状态影响 | 内部对应能力 |
| --- | --- | --- | --- | --- |
| `music_state_query` | 用户问“现在放的什么”“音量多少”“当前音乐来源”“收藏了哪些” | `part?` | 只读 | Tesla Fleet Telemetry `media_info.*` |
| `music_play` | 用户明确说“播放”“听某首歌/某个歌手/某张专辑”或“继续播放” | `query?` | `playing=true`，可更新当前曲目 | Tesla 语音 `Listen to [song name]` / Grok media search and play |
| `music_search` | 用户只是搜索歌曲、歌手、专辑，不要求播放 | `query` | 更新最近搜索结果 | Tesla 媒体搜索 / 语音搜索 |
| `music_toggle_playback` | 用户说“播放/暂停一下”“切换播放状态” | `action?` | 切换或显式设置播放状态 | Tesla `media_toggle_playback` |
| `music_pause` | 用户明确要求暂停 | 无 | `playing=false` | Tesla `media_toggle_playback` 的暂停语义 |
| `music_next` | 用户说“下一首”“切歌” | 无 | 切到下一首并播放 | Tesla `media_next_track` |
| `music_previous` | 用户说“上一首” | 无 | 切到上一首并播放 | Tesla `media_prev_track` |
| `music_volume_control` | 用户说“音量大一点/小一点/调到 6/静音/取消静音” | `action`, `volume?`, `delta?` | 更新 `volume` / `muted` | Tesla `adjust_volume`, `media_volume_up`, `media_volume_down` |
| `music_source_control` | 用户说“切到蓝牙/广播/Spotify/Apple Music/QQ音乐” | `source` | 更新媒体来源 | Tesla 语音 `Change the source to [media source]` |
| `music_favorite_control` | 用户说“收藏这首”“取消收藏”“下一首收藏” | `action?`, `query?` | 更新收藏列表或切换收藏歌曲 | Tesla `media_next_fav`, `media_prev_fav` / 媒体收藏 |

## Tesla 参考范围

本设计只取 Tesla 媒体相关能力作为参考，不包含导航、电话、车控、Grok 普通问答、娱乐应用启动等非本轮 music scope。

### 语音媒体能力

| Tesla 描述 | 用途 | 建议映射 |
| --- | --- | --- |
| Listen to song | 播放指定歌曲 | `music_play` |
| Lower/raise volume | 调低/调高媒体音量 | `music_volume_control` |
| Skip to next | 切到下一首 | `music_next` |
| Pause/play song | 暂停或继续播放 | `music_toggle_playback`, `music_pause` |
| Change source | 切换媒体来源 | `music_source_control` |
| Search and play media content | 搜索并播放媒体内容 | `music_play`；只搜索时用 `music_search` |

### Fleet API 媒体命令

| Tesla function | 用途 | 建议映射 |
| --- | --- | --- |
| `adjust_volume` | 设置车辆媒体播放音量 | `music_volume_control(action=set)` |
| `media_volume_up` | 音量增加一档 | `music_volume_control(action=increase)` |
| `media_volume_down` | 音量降低一档 | `music_volume_control(action=decrease)` |
| `media_toggle_playback` | 播放/暂停切换 | `music_toggle_playback` |
| `media_next_track` | 下一首 | `music_next` |
| `media_prev_track` | 上一首 | `music_previous` |
| `media_next_fav` | 下一首收藏 | `music_favorite_control(action=next)` |
| `media_prev_fav` | 上一首收藏 | `music_favorite_control(action=previous)` |

### Fleet Telemetry 媒体状态

| Tesla 字段 | 用途 | 建议映射 |
| --- | --- | --- |
| `MediaAudioVolume` / `MediaAudioVolumeMax` | 当前音量和最大音量 | `music_state_query(part=volume)` |
| `MediaPlaybackSource` | 当前播放来源 | `music_state_query(part=source)` |
| `MediaPlaybackStatus` | 播放状态 | `music_state_query(part=playback)` |
| `MediaNowPlayingTitle` / `Artist` / `Album` | 当前曲目信息 | `music_state_query(part=playback)` |
| `MediaNowPlayingDuration` / `Elapsed` | 曲目时长和播放进度 | 后续接入真实播放器时扩展状态层 |

## 参数建议

### `music_state_query`

`part` 建议枚举：

| 值 | 含义 |
| --- | --- |
| `all` | 全部媒体状态 |
| `playback` | 播放状态和当前曲目 |
| `volume` | 音量和静音 |
| `source` | 媒体来源 |
| `favorites` | 收藏歌曲 |
| `results` | 最近搜索结果 |

### `music_volume_control`

- `action=increase/decrease` 默认按一档调节，可用 `delta` 指定调节幅度。
- `action=set` 使用 `volume`，范围为 `0~11`，对齐 Tesla 媒体音量遥测的常见范围。
- `action=mute/unmute` 只改变静音状态，不清空当前音量。

### `music_source_control`

当前 Demo 可选来源：

| 值 | 含义 |
| --- | --- |
| `qq_music` | QQ音乐 |
| `radio` | 广播 |
| `bluetooth` | 蓝牙 |
| `usb` | USB |
| `spotify` | Spotify |
| `apple_music` | Apple Music |
| `tunein` | TuneIn |
| `youtube_music` | YouTube Music |
| `caraoke` | Caraoke |
| `browser` | 浏览器音频 |

## 调用原则

- 用户问状态时调用 `music_state_query`，不要用控制工具代替查询。
- 用户明确要听某首歌、某个歌手或某张专辑时调用 `music_play`；只是找歌时调用 `music_search`。
- 暂停、继续、上一首、下一首保留快捷函数，便于前台低延迟执行；“播放暂停切一下”使用 `music_toggle_playback`。
- 音量、媒体来源、收藏分别使用独立控制工具，避免把所有媒体设置塞进播放工具。
- 收藏切歌和普通上下首不同：普通切歌使用 `music_next` / `music_previous`，收藏切歌使用 `music_favorite_control`。
- 底层厂商 API 或真实播放器 SDK 由服务层编排，不直接暴露给模型。

## 来源

- Tesla Model Y Owner's Manual - Voice Commands: https://www.tesla.com/ownersmanual/modely/en_us/GUID-EA1715B0-A3A6-454E-995A-8AA2C3A32D44.html
- Tesla Model Y Owner's Manual - Media: https://www.tesla.com/ownersmanual/modely/en_us/GUID-7A85FB6B-9DF6-4C55-A2F9-793207E48E9D.html
- Tesla Fleet API - Vehicle Commands: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands
- Tesla Fleet API - Fleet Telemetry Available Data: https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data
