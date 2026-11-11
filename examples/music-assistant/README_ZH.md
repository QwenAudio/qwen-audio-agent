# Music Assistant

[English](README.md) | 中文

音乐 App 语音陪伴助手的**服务端示例**。它把 qwen-audio-agent Gateway 装配成一个「聊音乐、
还能语音控制播放」的助手，供外部移动客户端通过 GCP WebSocket 协议接入，实现听歌时的实时
语音对话与播放控制。

> **客户端代码不在本仓库**，位于独立仓库：
> 👉 **https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile**
> （一个 Expo / React Native 音乐播放器，内嵌本助手；负责麦克风采集、PCM 播放、UI，
> 以及**播放器工具的实际执行**。）

本示例展示两个扩展点：**Frontend Profile 人设注入**（`QWEN_AUDIO_FRONTEND_PROFILE`）与
**原生移动端 Client 的协议接入**（[GCP 7.0](../../docs/gateway-protocol.zh.md)）。
后台**零核心代码改动、零额外 npm 依赖**——只靠 env 装配 + 人设文件。

## 核心能力

- **实时语音对话**：客户端推送 16 kHz PCM16 音频，Gateway 返回 24 kHz 语音与转写字幕
  （服务端 VAD，支持打断）。
- **音乐陪伴人设「千问」**：经 `frontend-profile.json` + `assistant/music-companion.md` 注入，
  口语化、回答简短（1–3 句）。
- **语音控制播放**：助手可调用一组**客户端自有工具**（client-owned tools）真正操作 App 播放器
  ——切歌、搜歌、放歌单、点喜欢、看歌词等（见下节）。
- **世界知识问答**：Gateway 内置联网检索工具（`web_search` / `fetch_url`，默认开启），人设引导
  助手在回答歌曲/歌手等问题时组合「取歌词 + 联网搜索」多步查证，而非凭记忆瞎猜。

## 助手可调用的工具

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

## 架构与边界

| 部分 | 职责 | 位置 |
| --- | --- | --- |
| qwen-audio-agent Gateway | 会话、语音 Provider（DashScope Realtime）、VAD、音频转码、人设注入、内置联网检索、把客户端工具映射为 function-calling | 本仓库，经公开入口 `server/src/index.mjs` 启动 |
| 本示例 | 仅 env 装配（`start.mjs`）+ 人设文件（Frontend Profile）；零核心代码改动、零额外依赖 | `examples/music-assistant/` |
| 移动客户端 | 麦克风采集、PCM 播放、UI、**注册并执行播放器工具** | 独立仓库 [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile) |

数据流：

```
客户端麦克风 PCM16(base64)
  → input_audio_buffer.append → Gateway → DashScope Realtime
  → audio.delta(24 kHz PCM) / transcript.* → 客户端播放与字幕

模型决定操作播放器时：
  Gateway → client.action.request(client.tool.*) → 客户端本地执行 → client.action.result → Gateway → 模型
```

人设经 [Frontend Profile](../../docs/extensions.zh.md) 扩展点注入，示例不导入任何运行时私有
实现。Gateway 进程由使用者启动和停止（`npm run example:music-assistant`，Ctrl+C 退出）。
API key 只配置在 Gateway 侧，客户端不接触。

## 部署流程

整体三步：**① 启动后台 Gateway → ② 运行客户端 App → ③ 在 App 里填后台地址与 token**。

前提条件：Node.js ≥ 22.22.2（见仓库根 `.nvmrc`）、仓库根依赖已安装（`npm install`）、
一个 DashScope API key（[阿里云百炼控制台](https://bailian.console.aliyun.com/)获取）。

### ① 启动后台 Gateway

```bash
# 仓库根目录
cd qwen-audio-agent
cp examples/music-assistant/.env.example examples/music-assistant/.env
# 编辑 .env：填入 DASHSCOPE_API_KEY
#           手机真机接入还需设 HOST=0.0.0.0 和 QWEN_AUDIO_GATEWAY_ACCESS_TOKEN（≥24 字符）
npm run example:music-assistant        # 启动 Gateway，默认 ws://127.0.0.1:3101
```

可选：另开一个终端做握手冒烟测试。

```bash
node examples/music-assistant/verify.mjs
# 预期输出：verify ok: session.ready received
```

### ② 运行客户端 App

客户端是独立仓库，构建/运行方式见其 README：
👉 **https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile**

### ③ 在 App 里连接后台

打开 App 的「**设置**」页，填写语音助手连接信息：

| 字段 | 填什么 |
| --- | --- |
| **Gateway 地址** | 后台的 ws 地址，形如 `ws://<后台机器IP>:3101`，只填到端口即可（App 会自动补 `/api/realtime`）。iOS 模拟器与 Mac 共享网络栈，用 `ws://127.0.0.1:3101`。 |
| **Token** | 与后台 `.env` 里 `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` **一致**的值。**回环连接（模拟器 / 本机）免 token**；手机等跨设备连接必须填。 |

真机 / 跨机器接入要点：

- **局域网**：手机与后台机器需在同一网络（例如手机个人热点），记下后台机器的局域网 IP。
- **公网**：后台服务器需有公网 IP 并开放对应 TCP 端口；公网建议用 `wss://`（在 Gateway 前置
  TLS / 反向代理），明文 `ws://` 不安全。

填好后进入 App 底部「**语音**」Tab，点「**唤醒**」，说一句话即可听到助手回复；之后切到其他
页面助手仍常驻运行（悬浮球可见），可随时回到对话或点「暂停」。

## 配置与数据

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | 是 | - | DashScope Realtime 模型凭据，只留在 Gateway 侧 |
| `QWEN_AUDIO_REALTIME_MODEL` | 否 | `qwen-audio-3.1-realtime-plus` | 语音模型 |
| `QWEN_AUDIO_FRONTEND_PROFILE` | 否 | 本示例 `frontend-profile.json` | 已设置时不覆盖，便于换人设 |
| `HOST` / `PORT` | 否 | `127.0.0.1` / `3101` | 监听地址；真机接入设 `HOST=0.0.0.0` |
| `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` | 远程时是 | - | 固定访问密钥（≥ 24 字符），客户端经 `Authorization: Bearer` 携带 |
| `QWEN_AUDIO_WEB_TOOLS_ENABLED` | 否 | `true` | 关闭内置联网检索工具（`web_search` / `fetch_url`） |

配置优先级：shell 环境变量 > 本目录 `.env` > 上表默认值。通用 Gateway 配置见
[配置文档](../../docs/configuration.zh.md)。音频数据经 Gateway 发送至 DashScope；示例本身
无本地持久化，停止 Gateway 即结束会话。删除 `.env` 即可清理凭据；DashScope 侧数据保留
策略以其服务条款为准。

## 验证与限制

自动化冒烟：`node examples/music-assistant/verify.mjs [ws://host:port]`，预期打印
`verify ok: session.ready received` 及协商出的协议版本与能力，退出码 0。远程 Gateway 需
`QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` 环境变量。真实语音链路（DashScope 计费调用）需在客户端
说话验证：用户语音出现转写、助手语音可听、人设风格为 1–3 句口语化中文；播放控制类指令
（如「下一首」「播放每日推荐」）能真正改变 App 播放状态。

已知限制：

- Gateway 单用户仅一个活动 Client：`verify.mjs` 与真实客户端同时连接时，后连者收到
  `client_occupied`。
- 客户端外放时助手声音可能回采导致自打断，建议戴耳机（客户端侧问题，见客户端仓库）。

## 替换与扩展

- **换人设**：编辑 `assistant/music-companion.md`，或复制本目录改 `frontend-profile.json` 的
  `assistant` 指向。人设里描述的工具需与客户端实际注册的工具一致。
- **增删播放控制工具**：工具是**客户端自有**的，在客户端仓库
  [VoiceAgent-MoeKoeMusic-Mobile](https://github.com/juhayna-zh/VoiceAgent-MoeKoeMusic-Mobile)
  里注册与执行（`session.hello` 的 `client.tools`），并同步更新人设说明；后台无需改动。
  若想把工具放到**后台**执行，可参照 [customer-service](../customer-service/) 的
  `toolSources.mcp` 与 `createGatewayApplication` 组合根模式，经 MCP / 后端 Agent 暴露。
- **换语音模型**：`.env` 设 `QWEN_AUDIO_REALTIME_MODEL`（可用模型见
  `shared/realtime-model-catalog.mjs`）。
- **恢复默认 Gateway（不带人设）**：仓库根直接 `npm start`，不设 `QWEN_AUDIO_FRONTEND_PROFILE`。
