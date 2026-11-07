# Music Assistant

[English](README.md) | 中文

音乐 App 语音陪伴助手的服务端示例。它把 qwen-audio-agent Gateway 装配成一个「聊音乐」的
语音助手，供外部移动客户端（示例中为 [MoeKoeMusic-Mobile](https://github.com/MoeKoeMusic/MoeKoeMusic-Mobile)，
Expo / React Native 音乐播放器）通过 GCP WebSocket 协议接入，实现听歌时的实时语音对话。
示例展示两个扩展点：Frontend Profile 人设注入（`QWEN_AUDIO_FRONTEND_PROFILE`）与
原生移动端 Client 的协议接入（[GCP 7.0](../../docs/gateway-protocol.zh.md)）。

## 核心能力

- 实时语音对话：客户端推送 16 kHz PCM16 音频，Gateway 返回 24 kHz 语音与转写字幕（服务端 VAD，支持打断）。
- 音乐陪伴人设：通过 `frontend-profile.json` + `assistant/music-companion.md` 注入，口语化、回答简短。
- 协议冒烟脚本 `verify.mjs`：零依赖验证 Gateway 握手（`session.hello` → `session.ready`）。
- 未来计划（本示例未实现）：语音控制播放（切歌 / 搜歌 / 推荐），需接入后端 Agent 工具。

## 架构边界

| 部分 | 职责 |
| --- | --- |
| qwen-audio-agent Gateway | 会话、语音 Provider（DashScope Realtime）、VAD、音频转码；经公开入口 `server/src/index.mjs` 启动 |
| 本示例 | 仅 env 装配（`start.mjs`）+ 人设文件（Frontend Profile），零核心代码改动，零额外 npm 依赖 |
| 移动客户端（外部仓库） | 麦克风采集、PCM 播放、UI；经 `ws://<gateway>/api/realtime` 接入，API key 不接触 |

数据流：客户端麦克风 PCM16(base64) → `input_audio_buffer.append` → Gateway → DashScope Realtime →
`audio.delta`(24 kHz PCM) / `transcript.*` → 客户端播放与字幕。人设经
[Frontend Profile](../../docs/extensions.zh.md) 扩展点注入，示例不导入任何运行时私有实现。
Gateway 进程由使用者启动和停止（`npm run example:music-assistant`，Ctrl+C 退出）。

## 快速开始

前提条件：Node.js ≥ 22.22.2（见仓库根 `.nvmrc`）、仓库根依赖已安装（`npm install`）、
一个 DashScope API key（[阿里云百炼控制台](https://bailian.console.aliyun.com/)获取）。

```bash
# 终端 1：仓库根目录
cd qwen-audio-agent
cp examples/music-assistant/.env.example examples/music-assistant/.env
# 编辑 .env 填入 DASHSCOPE_API_KEY
npm run example:music-assistant        # 启动 Gateway，默认 ws://127.0.0.1:3101

# 终端 2：验证握手
node examples/music-assistant/verify.mjs
# 预期输出 verify ok: session.ready received
```

客户端接入（iOS 模拟器与 Mac 共享网络栈，回环直连免 token）：在 MoeKoeMusic-Mobile 的
设置页把 Gateway 地址设为 `ws://127.0.0.1:3101`，进入播放页点语音助手按钮，说一句话即可听到回复。
真机 / 跨机器访问见下节配置。

## 配置与数据

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | 是 | - | DashScope Realtime 模型凭据，只留在 Gateway 侧 |
| `QWEN_AUDIO_REALTIME_MODEL` | 否 | `qwen-audio-3.1-realtime-plus` | 语音模型 |
| `QWEN_AUDIO_FRONTEND_PROFILE` | 否 | 本示例 `frontend-profile.json` | 已设置时不覆盖，便于换人设 |
| `HOST` / `PORT` | 否 | `127.0.0.1` / `3101` | 监听地址；真机接入设 `HOST=0.0.0.0` |
| `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` | 远程时是 | - | 固定访问密钥（≥ 24 字符），客户端经 `Authorization: Bearer` 携带 |

配置优先级：shell 环境变量 > 本目录 `.env` > 上表默认值。通用 Gateway 配置见
[配置文档](../../docs/configuration.zh.md)。音频数据经 Gateway 发送至 DashScope；示例本身
无本地持久化，停止 Gateway 即结束会话。删除 `.env` 即可清理凭据；DashScope 侧数据保留
策略以其服务条款为准。

## 验证与限制

自动化冒烟：`node examples/music-assistant/verify.mjs [ws://host:port]`，预期打印
`verify ok: session.ready received` 及协商出的协议版本与能力，退出码 0。远程 Gateway 需
`QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` 环境变量。真实语音链路（DashScope 计费调用）需在客户端
说话验证：用户语音出现转写、助手语音可听、人设风格为 1-3 句口语化中文。

已知限制：

- 无工具调用，助手不能实际控制播放器（人设中已声明）。
- Gateway 单用户仅一个活动 Client：verify.mjs 与真实客户端同时连接时，后连者收到 `client_occupied`。
- 客户端外放时助手声音可能回采导致自打断，建议戴耳机（客户端侧问题，见 MoeKoeMusic-Mobile）。
- 未在 Android 真机验证；iOS 模拟器 / 真机路径已由 MoeKoeMusic-Mobile 联调覆盖。

## 替换扩展

- 换人设：编辑 `assistant/music-companion.md`，或复制本目录改 `frontend-profile.json` 的 `assistant` 指向。
- 加工具（如真正的播放控制）：参照 [customer-service](../customer-service/) 的 `toolSources.mcp` 与
  `createGatewayApplication` 组合根模式，把客户端播放能力经 MCP / 后端 Agent 暴露给助手。
- 换语音模型：`.env` 设 `QWEN_AUDIO_REALTIME_MODEL`（可用模型见 `shared/realtime-model-catalog.mjs`）。
- 恢复默认 Gateway（不带人设）：直接 `npm start`（仓库根），不设 `QWEN_AUDIO_FRONTEND_PROFILE`。

## 作者与致谢

- 示例作者：Juhayna —— Gateway 装配、人设、verify 脚本与 MoeKoeMusic-Mobile 客户端接入实现。
- 致谢上游项目 [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent)（Gateway、GCP 协议、
  Frontend Profile 扩展点）与 [DashScope Realtime](https://help.aliyun.com/zh/model-studio/) 语音模型服务；
  客户端为独立开源项目 [MoeKoeMusic-Mobile](https://github.com/MoeKoeMusic/MoeKoeMusic-Mobile)。
  本示例不暗示获得上游官方背书。
