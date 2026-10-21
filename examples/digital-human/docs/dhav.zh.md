[返回数字人方案总览](../README_ZH.md)

# DHAV Mock / FlashHead 运行指南

[English](dhav.md) | [中文](dhav.zh.md)

一个跑在 qwen-audio-agent Gateway 上的「语音 + 头像」可运行 demo。Realtime 模型
仍然负责理解和说话；一个可替换的 DHAV 渲染服务消费回复音频、产出说话头像，再经
WebRTC 的 `recvonly` 视频轨送到浏览器。产品 `web/` 应用不参与：本 example 自带
SPA，由 Gateway 从 `/skins` 挂载发布。

## 数字人演示

**自然对话，声形相随。** 语音驱动数字人的口型与表情，展示实时对话的交互效果。

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

[数字人演示视频](../assets/digital-human-demo.mp4)

两种运行方式：

1. **Mock 渲染服务** —— 任意机器、无需 GPU。用一个随音频跳动的频谱代替头像，但
   其余各层（Realtime 语音、WebRTC 协商、DHAV 协议、A/V 配对、播放回执）都是真的。
2. **自部署的 FlashHead 渲染服务** —— GPU 主机上的真实说话头像。部署方式见 §3.3，
   本指南假设按该节操作后你已经拿到一个 FlashHead API 端点。

两种模式的语音都走真实 Realtime 上游（DashScope），因此都需要 API key。

```
浏览器 SPA（/skins/digital-human）
   │  WebRTC：麦克风上行，音频 + 头像视频下行
   ▼
Gateway（本仓库）  ──WSS──►  DashScope Realtime（ASR/LLM/TTS）
   │  DHAV over HTTP/WS
   ▼
渲染服务：本地 Mock  |  你的 FlashHead 服务（GPU）
```

## 1. 前置条件

- Node.js >= 22.22.2。
- 仓库根目录已安装（`npm install`）。example 的 SPA 没有自己的 manifest：`react`
  和 `vite` 从根 `node_modules` 向上解析，所以根安装就足够构建。
- 原生 WebRTC 扩展，以及本 example 自己的依赖（`ws`）：

  ```bash
  npm run example:digital-human:install     # 在仓库根目录执行
  ```

- DashScope key。复制 example 的 env 文件并填写（`.env.local` 已被 gitignore，
  绝不能提交）：

  ```bash
  cd examples/digital-human
  cp .env.example .env.local                # 然后填 DASHSCOPE_API_KEY
  ```

- 构建好的头像 SPA。没有它 `start.mjs` 会拒绝启动：

  ```bash
  npm run build:client                      # 产物在 examples/digital-human/skins/digital-human/
  ```

配置参考（见 `.env.example`）。除 `DASHSCOPE_API_KEY` 外，Mock 模式下均可选；
一旦 `DH_RENDERER_URL` 指向远端渲染服务，`DH_RENDERER_TOKEN` 就变成必填。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `DASHSCOPE_API_KEY` | — | Realtime 上游凭据。必填。 |
| `DH_GATEWAY_HOST` / `DH_GATEWAY_PORT` | `127.0.0.1` / `18895` | demo Gateway 的监听地址。 |
| `DH_RENDERER_URL` | 空 | 渲染服务地址。留空表示 `start.mjs` 自动启动本地 Mock。 |
| `DH_RENDERER_TOKEN` | 空 | 远端渲染服务控制面的 Bearer token。**只要设了 `DH_RENDERER_URL` 就必填**：否则建会话返回 401，该轮对话会静默降级成纯音频。本地 Mock 忽略此项。从不写日志。 |
| `DH_PERSONA` | `mock-default` | 启动人设；必须在服务端白名单内。本地 Mock 只认 `mock-default`，远端 FlashHead 用 `flashhead-default`。渲染服务不认识的人设会在建会话时被 400 拒绝。 |
| `DH_MOCK_FAULT` | 空 | Mock 故障注入（见 §2）。 |
| `DH_MOCK_RENDERER_HOST` / `DH_MOCK_RENDERER_PORT` | `127.0.0.1` / `0` | Mock 监听地址（仅本地 Mock 模式）。 |
| `QWEN_AUDIO_REALTIME_VOICE` | provider 默认 | 数字人音色。由框架的 Realtime provider 解析读取，而不是 `bootstrap/env.mjs`，所以它是随 `.env.local` 载入进程的。Audio 模型族可选：`longanqian`、`longanlingxin`、`longanlingxi`、`longanxiaoxin`、`longanlufeng`。想保持默认就整行不要写——对框架而言空值等于「显式清空」。 |
| `QWEN_AUDIO_REALTIME_MODEL` | `qwen-audio-3.0-realtime-plus` | Realtime 模型。`compose-gateway.mjs` 用 `\|\|=` 赋值，所以 `.env.local` 里写了就以它为准。 |

## 2. 用 Mock 渲染服务运行

在 example 目录下：

```bash
npm start
```

或在仓库根目录：

```bash
npm run example:digital-human
```

因为 `DH_RENDERER_URL` 为空，`start.mjs` 会先在随机端口启动本地 Mock 渲染服务，
跑完 preflight，再启动带头像视频下行的 Gateway。预期输出：

```
[start] Mock renderer listening on http://127.0.0.1:5xxxx
[preflight] webrtc_extension: ok
[preflight] gateway_port: ok
[preflight] renderer_ready: ok
[start] Gateway ready at http://127.0.0.1:18895
[start] Open http://127.0.0.1:18895/skins/digital-human/index.html?persona=mock-default in a browser, allow the microphone, and speak.
```

打开打印出的 URL，允许麦克风，然后说话——或者在头像下方的输入框里打一句话回车。
你应该看到：

- 头像舞台开始绘制视频帧（Mock 渲染的是随音频跳动的频谱），状态点依次走过
  `待命 → 正在听 → 正在处理 → 正在说话 → 待命`；
- 头像说话的同时，下方 transcript 面板出现助手的文字；
- 打断（barge-in）生效：在头像说到一半时插话，它会停下来，而不是把上一句说完。

Mock 渲染服务同时是降级路径的故障注入工具：

```bash
npm start -- --fault=first_media_timeout
```

| `--fault=` | 应该观察到什么 |
|---|---|
| `first_media_timeout` | 渲染服务收下音频但始终不发布媒体；首帧超时后会话降级为纯音频：能听到回复，舞台显示 `仅音频（头像降级）`，不绘制任何视频帧。 |
| `media_stall` | 回合中途媒体停住；停滞看门狗降级或取消该回合。 |
| `protocol_error` | 渲染服务发出非法 DHAV 帧；回合被取消，连接保持存活。 |
| `mid_turn_failure` | 渲染服务在回合中途死掉；该回合降级，后续回合恢复。 |
| `channel_drop` | 媒体通道断开；会话以新的 generation 重建。 |

任何情况下，头像故障都只应降级为纯音频，绝不应拆掉语音连接。

## 3. 用自部署的 FlashHead 渲染服务运行

本节假设你已经有一个可通过 HTTP/WS 访问的、兼容 DHAV 的 FlashHead 服务（例如
GPU 主机上跑 SoulX-FlashHead Lite 的 OpenAvatarChat FlashHead Avatar 组件）。
部署该服务的方式见 §3.3。

### 3.1 渲染服务需要提供什么

Provider（`providers/dhav-provider.mjs`）按 DHAV 协议访问以下端点：

| 端点 | 用途 |
|---|---|
| `GET /health/ready` | 启动 preflight 探针。Gateway 启动前必须返回 2xx。 |
| `POST /v1/avatar/sessions` | 创建头像会话；配置了 `DH_RENDERER_TOKEN` 时接受 `Authorization: Bearer <token>`。返回会话 id，以及一个作用域受限、短时效的媒体通道 URL 和 token。 |
| `WS <session.input.url>` | 私有媒体通道：PCM 音频进，DHAV A/V 单元出。用建会话时下发的作用域 token 鉴权，而不是外层 Bearer token。 |
| `DELETE /v1/avatar/sessions/<id>` | 拆除会话。 |

### 3.2 配置并启动

在 `examples/digital-human/.env.local` 里写渲染服务地址和 token：

```bash
DH_RENDERER_URL=http://<gpu-host>:<port>
DH_RENDERER_TOKEN=<bearer token>
DH_PERSONA=flashhead-default
```

然后：

```bash
npm start
```

或者不改 env 文件、按次传参：

```bash
npm start -- --renderer=http://<gpu-host>:<port> --persona=flashhead-default
```

`flashhead-default` 是服务端白名单里对应真实渲染服务的人设（`mock-default` 仍
可用于 Mock）。Gateway 打印的 demo URL 与 §2 相同，用 `?persona=flashhead-default`
打开。SPA 的人设以服务端白名单为准：不在白名单里的 `?persona=` 不会被采用，页面
会显示一条说明替换情况的提示，而不是静默失败。

服务不可达时 preflight 会以 `renderer_unreachable` / `renderer_not_ready`
快速失败，因此一个错误地址不会变成浏览器里挂死的会话。

### 3.3 部署 FlashHead 渲染服务

渲染端在独立的仓库里，完整的部署教程也在那里；渲染端的一切以该仓库为准：

> <https://github.com/juhayna-zh/OpenAvatarChat> —— 一个改编版 OpenAvatarChat，
> 为本 example 暴露可自部署的、兼容 DHAV 的数字人 API（FlashHead 渲染、DHAV v1、
> Bearer token 鉴权、端口 18910）。

简而言之，在 GPU 主机上：

```bash
git clone https://github.com/juhayna-zh/OpenAvatarChat && cd OpenAvatarChat
uv run install.py                                   # 依赖与 CUDA 环境
.venv/bin/python scripts/download_models.py         # SoulX-FlashHead Lite 权重
openssl rand -hex 32 > ~/.config/dhav-bridge/token  # bearer token，只生成一次
DHAV_AUTH_TOKEN=$(cat ~/.config/dhav-bridge/token) \
  .venv/bin/python src/demo.py --config config/chat_with_flashhead_passthrough.yaml --host 127.0.0.1
```

服务随后监听 `:18910`；在本 example 里用
`DH_RENDERER_URL=http://<gpu-host>:18910` 指向它，并把 `DH_RENDERER_TOKEN` 设成
你生成的同一个 token。GPU/驱动前置条件、权重许可、以及单机之外的部署形态，都以该
仓库的 README 为准。

两个仓库之间必须保持同步的契约细节：

- **readiness 路径。** 本 example 的 preflight 探的是 `GET /health/ready`
  （`bootstrap/preflight.mjs`），而渲染端 README 写的是 `GET /readiness`。首次运行
  之前，要么让 bridge 两个路径都暴露，要么把 `checkRendererReady` 改成渲染端的路径；
  否则 preflight 会以 `renderer_not_ready` 拦住 demo。
- **token 变量名。** 渲染端读 `DHAV_AUTH_TOKEN`，本 example 发 `DH_RENDERER_TOKEN`。
  同一个密钥、两个名字：生成一次，两处都填。任何一份都不要提交。

### 3.4 网络与安全注意事项

- FlashHead 传输是明文 HTTP/WS。如果 GPU 主机在云安全组里，源地址必须限制为你的
  固定出口 IP；绝不开放 `0.0.0.0/0`。
- 渲染服务地址和人设只来自服务端启动配置。浏览器无法让 Gateway 去连任意渲染服务
  或任意人设；未知人设会以 `avatar_persona` 被拒绝，而不是静默降级。
- `DH_RENDERER_TOKEN` 只从 `.env.local` 读取，只作为发往渲染服务的
  `Authorization` 头使用，从不写入日志、文档或提交。

## 4. 测试

```bash
npm test                                # 在 example 内：单元 + 契约测试，不需要 GPU 和网络
npm run test:digital-human              # 同一套测试，在仓库根目录执行
npm run test:digital-human-browser      # headless Chromium 端到端冒烟
```

浏览器冒烟只 mock 渲染服务、语音走真实 Realtime 上游，因此需要
`DASHSCOPE_API_KEY` 和构建好的 `skins/digital-human/`。确定性覆盖（编解码、
调度器、输出选择器、编排器、表现层挂钩）都在非浏览器测试里。

## 5. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `skins/digital-human not found; run \`npm run build:client\` first` | SPA 没构建过。执行 `npm run build:client`。 |
| `DASHSCOPE_API_KEY is required` | 缺 key。在 `examples/digital-human/.env.local` 或仓库根 `.env.local` 里设置。 |
| preflight `webrtc_extension_missing` | 原生 WebRTC 包没装。执行 `npm run example:digital-human:install`。 |
| preflight `port_in_use` | `:18895` 上已有 Gateway。停掉它，或用 `--port=` / `DH_GATEWAY_PORT`。 |
| preflight `renderer_unreachable` | 渲染服务没起、地址写错，或云安全组挡住了你的出口 IP。见 §3.4。 |
| 浏览器提示 `Gateway 未启用数字人…` | Gateway 启动时没带渲染服务，或人设白名单为空。 |
| offer 时 `400 avatar_persona` | 请求的人设不在服务端白名单内。用 `mock-default` 或 `flashhead-default`。 |
| `400 avatar_conflict` | 本预览版不允许摄像头输入与头像输出同时开启；双视频 m-line 的关联顺序尚未验证。 |
| 头像视频黑屏，点一下页面才有 | 浏览器自动播放策略。点一下页面；SPA 会把这个情况显示为错误提示。 |
| 有声音但没头像，状态显示 `仅音频（头像降级）` | 渲染服务没能在时限内发布首帧。`--fault=first_media_timeout` 下是预期行为；否则查渲染服务日志。 |

## 6. 设计文档

可运行 demo 实现的是本目录下的三份提案：

1. [架构与范围](design.zh.md)
2. [Provider 契约与具体映射](provider-contract.zh.md)
3. [OpenAvatarChat 实施与验收计划](implementation-plan.zh.md)

目录中其他设计文件为历史草案，已被这三份取代。
