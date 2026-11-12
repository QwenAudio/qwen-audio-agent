# Music Assistant

[English](README.md) | 中文

用于音乐聊天与语音播放控制的服务端配置示例，将标准 qwen-audio-agent Gateway、音乐陪伴人设
与外部 [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
客户端组合，展示 Frontend Profile 注入和 [GCP 7.0](../../docs/gateway-protocol.zh.md)
客户端自有工具接入，无需修改核心或增加服务端依赖。移动 App 及其播放器实现不在本仓库内，
也不是默认应用的内置能力。

## 核心能力

- **实时语音对话**：客户端推送 16 kHz PCM16 音频，Gateway 返回 24 kHz 语音与转写字幕
  （服务端 VAD，支持打断）。
- **音乐陪伴人设「千问」**：经 `frontend-profile.json` + `assistant/music-companion.md` 注入，
  口语化、回答简短（1–3 句）。
- **语音控制播放**：助手可调用一组**客户端自有工具**（client-owned tools）真正操作 App 播放器
  ——切歌、搜歌、放歌单、点喜欢、看歌词等（见下节）。
- **世界知识问答**：Gateway 内置联网检索工具（`web_search` / `fetch_url`，默认开启），人设引导
  助手结合歌词查询歌曲/歌手信息；可用性取决于配置的搜索服务和网络。

### 助手可调用的工具

工具分两类。**客户端工具**由移动客户端在 `session.hello` 里通过 `client.tools` 能力注册，
Gateway 把它们映射为 DashScope 原生 function-calling；模型决定调用时，Gateway 下发
`client.action.request`，**由客户端本地执行**并回传 `client.action.result`。后台不实现这些工具。

**客户端工具（在 App 本地执行）**

| 工具 | 作用 |
| --- | --- |
| `player_control` | 播放 / 暂停 / 上一首 / 下一首 |
| `player_stop` | 停止并清空播放队列 |
| `player_set_mode` | 顺序 / 随机 / 单曲循环 |
| `player_seek` | 跳到绝对时间点，或相对快进 / 快退 |
| `player_set_volume` | 设置音量（0–1） |
| `player_get_state` | 当前曲目 / 播放状态 / 进度 / 音量 / 队列位置 |
| `player_get_queue` | 分页列出播放队列 |
| `track_set_like` | 把当前歌曲加入 / 移出「我喜欢」 |
| `track_get_lyrics` | 当前歌曲带时间戳歌词，并标记正在唱的那句 |
| `music_search_songs` | 搜索歌曲（返回候选，不自动播放） |
| `music_search_playlists` | 搜索歌单（返回候选，含歌单 id） |
| `music_play_songs` | 搜索并从某个结果开始播放，后续结果排入队列 |
| `music_play_playlist` | 按 id 或名称播放歌单 |
| `music_play_daily_recommend` | 播放「每日推荐」 |

**Gateway 内置工具（在后台执行，默认开启）**

| 工具 | 作用 |
| --- | --- |
| `web_search` | 联网搜索，返回摘要与来源引用 |
| `fetch_url` | 抓取指定网页正文 |

> 内置联网工具可用 `QWEN_AUDIO_WEB_TOOLS_ENABLED=false` 关闭，搜索源用
> `QWEN_AUDIO_WEB_SEARCH_PROVIDER` 配置（详见仓库根 `.env.example` 与配置文档）。

## 架构边界

| 部分 | 职责 | 位置 |
| --- | --- | --- |
| qwen-audio-agent Gateway | 会话、语音 Provider（DashScope Realtime）、VAD、音频转码、人设注入、内置联网检索、把客户端工具映射为 function-calling | 本仓库的标准 Gateway 进程 |
| 本示例 | 环境变量装配与 Frontend Profile 人设文件 | [start.mjs](start.mjs)、[frontend-profile.json](frontend-profile.json) |
| 移动客户端 | 麦克风采集、PCM 播放、UI、**注册并执行播放器工具** | 独立仓库 [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile) |

数据流：

```
客户端麦克风 PCM16(base64)
  → input_audio_buffer.append → Gateway → DashScope Realtime
  → audio.delta(24 kHz PCM) / transcript.* → 客户端播放与字幕

模型决定操作播放器时：
  Gateway → client.action.request(client.tool.*) → 客户端本地执行 → client.action.result → Gateway → 模型
```

人设经公开 [Frontend Profile](../../docs/reference/frontend-profile.zh.md) 扩展点注入。
播放指令调用 App 本地工具，不是操控手机的 Agent，也不依赖后台 ACP 任务。已有后台配置仍会
继承；如需仅运行语音前台，在本示例 `.env` 中显式设置 `AGENT_PROTOCOL=none`。

使用者分别启动和关闭 Gateway 与外部 App/开发服务器。模型 API key 只留在 Gateway，
App 仅需填写 Gateway 访问 token。

## 快速开始

前提条件：Node.js 22.22.2（[`.nvmrc`](../../.nvmrc) 指定版本）、npm ≥ 10、Git，
以及有权访问所选实时模型的 DashScope API key，可从
[百炼控制台](https://bailian.console.aliyun.com/)获取；真实语音调用可能产生费用。
外部 App 面向 iOS/Android，需相应原生构建工具（本地 iOS 构建需 macOS/Xcode，
本地 Android 构建需 Android SDK）。

### 1. 启动 Gateway

```bash
# 终端 1，从本仓库的上级目录执行
cd qwen-audio-agent
npm ci
cp -n examples/music-assistant/.env.example examples/music-assistant/.env
# 编辑示例 .env：填入 QWEN_AUDIO_REALTIME_API_KEY。
# 手机真机接入还需设 HOST=0.0.0.0 和
# QWEN_AUDIO_GATEWAY_ACCESS_TOKEN（至少 24 字符的随机 token）。
# 可选：AGENT_PROTOCOL=none，避免使用已有后台 Agent。
npm run example:music-assistant        # 启动 Gateway，默认 ws://127.0.0.1:3101
```

仅首次配置时复制 `.env`，保留已有设置。启动前阅读下方配置与数据复用说明，
不要与另一个正在运行的 Gateway 共用状态目录。

### 2. 构建并运行外部 App

另开终端，在存放外部项目的目录执行：

```bash
git clone --recurse-submodules https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile.git
cd VoiceAgent-MoeKoeMusic-Mobile
```

按客户端[构建说明](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile#-部署与运行)
安装依赖并准备 API 子模块。请克隆上面的 fork，不要使用其 README 当前列出的基础播放器仓库。
其 [package.json](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile/blob/master/package.json)
提供 `npm run ios` / `npm run android` 和 development-build 脚本。它使用的
`react-native-audio-api` 需要原生开发构建，
[Expo Go 不包含该原生模块](https://docs.swmansion.com/react-native-audio-api/docs/fundamentals/getting-started/)；
仅启动 `expo start` 不会完成原生 App 构建。

### 3. 连接并完成一次交互

打开 App 的「**设置**」页，填写语音助手连接信息：

| 字段 | 填什么 |
| --- | --- |
| **Gateway 地址** | 后台的 ws 地址，形如 `ws://<后台机器IP>:3101`，只填到端口即可（App 会自动补 `/api/realtime`）。iOS 模拟器与 Mac 共享网络栈，用 `ws://127.0.0.1:3101`。 |
| **Token** | 与后台 `.env` 里 `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` **一致**的值。**回环连接（模拟器 / 本机）免 token**；手机等跨设备连接必须填。 |

真机 / 跨机器接入要点：

- **局域网**：手机与后台机器需在同一网络（例如手机个人热点），记下后台机器的局域网 IP。
- **公网**：通过 TLS / 反向代理使用 `wss://`，不要经公网明文 `ws://` 发送 token 或音频，
  详见[远程连接](../../docs/operations/remote-access.zh.md)。

打开 App「**语音**」Tab，授予麦克风权限，点「**唤醒**」并说「你好，介绍一下你自己」。
预期出现转写并听到简短回复。播放队列中有可播放音乐时说「下一首」，检查 App 是否切歌。
登录、收藏与推荐能力依赖播放器的音乐服务/账号和可用内容。

退出时点「暂停」或关闭 App，在其开发服务器终端按 Ctrl+C，再在终端 1 按 Ctrl+C 停止
Gateway；这不会清除已持久化的数据。

## 配置与数据

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `QWEN_AUDIO_REALTIME_API_KEY` | 是 | - | DashScope Realtime 模型凭据，只留在 Gateway 侧 |
| `QWEN_AUDIO_REALTIME_PROVIDER` | 固定 | `dashscope` | 本示例启动脚本强制设置 |
| `QWEN_AUDIO_REALTIME_MODEL` | 否 | `qwen-audio-3.1-realtime-plus` | 语音模型 |
| `QWEN_AUDIO_FRONTEND_PROFILE` | 否 | 本示例 `frontend-profile.json` | 在 shell 或示例 `.env` 中覆盖以更换人设 |
| `HOST` / `PORT` | 否 | `127.0.0.1` / `3101` | 监听地址；真机接入设 `HOST=0.0.0.0` |
| `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` | 远程时是 | - | 固定访问密钥（≥ 24 字符），客户端经 `Authorization: Bearer` 携带 |
| `QWEN_AUDIO_WEB_TOOLS_ENABLED` | 否 | `true` | 关闭内置联网检索工具（`web_search` / `fetch_url`） |
| `AGENT_PROTOCOL` | 否 | 继承已有配置，否则无后台 | 音乐工具不需要后台；设为 `none` 可显式禁用已有后台 |

普通设置优先级：shell 环境变量 > 示例 `.env` > 仓库根 `.env.local` > 仓库根 `.env` >
用户 `config.env` > Gateway 默认值。启动脚本会先固定 DashScope，并在 shell 与示例
`.env` 未指定模型/人设时注入示例默认值，因此这些值优先于仓库根/用户文件。其他配置继续
复用，包括后台 Agent、工具、记忆和目录覆盖，详见[配置文档](../../docs/configuration.zh.md)。

标准 Gateway 会持久化数据；本示例不是隔离或临时实例：

| 数据 | 默认位置 |
| --- | --- |
| 共享配置、人设、身份 | `~/.config/qwaudio/config.env`、`ASSISTANT.md`、`identity.env` |
| 偏好、记忆、笔记 | `~/.config/qwaudio/data/` |
| Gateway 任务/会话状态与日志 | `~/.config/qwaudio/state/`（日志在 `state/logs/`） |

`QWAUDIO_CONFIG_DIR`（或 `XDG_CONFIG_HOME`）改变产品根目录；`QWAUDIO_DATA_DIR`、
`QWAUDIO_STATE_DIR`、`QWAUDIO_CACHE_DIR` 可分别覆盖目录。启动会复用已有文件并创建缺失的
标准文件，不会用示例设置替换已有配置。记忆、已存储的任务/会话状态和日志在停服后保留；
具体记录内容取决于启用的功能，详见通用配置文档。

音频、对话上下文和工具结果会发送至 DashScope；已启用的联网工具向搜索服务或目标网站发送
查询/URL，App 访问其音乐服务。继承的后台或记忆服务可能按相应配置发送其他数据。
App 自行管理本地存储，清理本地文件不会删除服务提供方的记录。

不要提交 `.env`、API key、访问 token 或 `identity.env`。清理前停止 Gateway，确认实际
目录、备份所需数据，仅移除本次测试独有的文件/设置。删除示例 `.env` 不会清除共享状态或
其他位置保存的凭据；不要删除整个共享 `~/.config/qwaudio`，其中可能有其他助手的数据。
远端保留策略以各服务条款为准。

## 验证与限制

在仓库根目录执行：

```bash
# 本地回归测试；使用模拟 WebSocket 对端，不调用云端语音
node --test test/music-assistant-example.test.mjs

# 终端 2：Gateway 已启动，App 已断开
node examples/music-assistant/verify.mjs
# 可选远端地址：node examples/music-assistant/verify.mjs ws://host:port
```

预期回归测试全部通过；握手检查打印 `verify ok: session.ready received`、协商出的
协议/能力并以 0 退出。验证远程 Gateway 时，在该终端导出
`QWEN_AUDIO_GATEWAY_ACCESS_TOKEN`；`verify.mjs` 不读取示例 `.env`。握手成功不代表
DashScope 音频、原生 App 构建或播放工具执行已验证。

真实服务验收需在实际客户端完成上述交互，确认可听到语音、出现转写、回复为简短中文，
以及播放状态确实改变。本地测试不覆盖这些云端/真机检查，此处不声明已通过；执行时请记录
客户端版本、系统/设备、模型及结果。

已知限制：

- Gateway 单用户仅一个活动 Client：`verify.mjs` 与真实客户端同时连接时，后连者收到
  `client_occupied`。
- 客户端外放时助手声音可能回采导致自打断，建议戴耳机（客户端侧问题，见客户端仓库）。
- 原生音频权限/构建兼容性及音乐服务可用性由外部客户端负责；浏览器/Expo Go 测试
  不能替代原生客户端验收。

## 替换扩展

- **换人设**：编辑 `assistant/music-companion.md`，或复制本目录改 `frontend-profile.json` 的
  `assistant` 指向。人设里描述的工具需与客户端实际注册的工具一致。
- **增删播放控制工具**：需要改客户端代码，在客户端仓库
  [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
  里注册与执行（`session.hello` 的 `client.tools`），并同步更新人设说明；后台无需改动。
  替换播放器需实现 GCP 的工具注册/请求/结果契约；音乐 API 与工具 schema 仍依赖具体实现，
  不保证即插即用。服务端工具接入见公开[前台 MCP 接口](../../docs/reference/frontend-mcp.zh.md)。
- **换语音模型**：`.env` 设 `QWEN_AUDIO_REALTIME_MODEL`（可用模型见
  [模型目录](../../shared/realtime-model-catalog.mjs)）。启动脚本固定 DashScope；改用其他
  供应商需要修改启动脚本并验证音频/工具兼容性。
- **恢复默认 Gateway（不带音乐人设）**：不使用本启动脚本，在仓库根运行 `npm start`，
  并移除 shell/仓库根/用户配置中仍指向音乐人设的 `QWEN_AUDIO_FRONTEND_PROFILE`。
  共享记忆和其他设置保持不变。

## 作者与致谢

- [juhayna-zh（Haina Zhu）](https://github.com/juhayna-zh)：Gateway 示例、音乐陪伴人设、
  移动客户端工具接入。
- 上游播放器：[MoeKoeMusic/MoeKoeMusic-Mobile](https://github.com/MoeKoeMusic/MoeKoeMusic-Mobile)，
  源自 [MoeKoeMusic](https://github.com/iAJue/MoeKoeMusic)。
- 独立的 [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
  客户端基于该播放器开发，包含 [GPL-2.0 许可证](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile/blob/master/LICENSE)，
  包元数据声明 `GPL-2.0-only`。复用代码时请查阅各仓库的许可证及署名说明；本仓库未打包
  该外部客户端代码。
