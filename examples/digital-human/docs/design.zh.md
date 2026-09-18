# 数字人接入架构设计

状态：待评审。日期：2026-09-18。框架基线：GitHub `main`，`9ad6348f`（PR #465）。

本文与 [Provider 契约](provider-contract.zh.md)、[开发计划](implementation-plan.zh.md) 共同构成开发交接；所有新增接口均为拟议接口，尚未实现。

## 1. 目标与非目标

数字人是网关的可选呈现能力，不是另一套对话系统。客户端不接触厂商密钥、Renderer 地址、LiveKit 房间凭证或 Python 类型。

- 输入是模型已经生成的助手回复音频，不是用户麦克风录音。
- TTS 与 S2S 生成的回复统一视为助手音频，不要求存在独立 TTS 模块。
- 文本是可选辅助输入；Provider 不得依赖必须先有完整文本才能接收音频。
- 网关拥有会话、历史、工具、权限、内容安全恢复及取消策略。
- Provider 拥有头像渲染、其内部推理状态和媒体输出，不拥有对话历史。
- 首版交付一个人设、Mock 和 OpenAvatarChat/FlashHead 实接；LiveAvatar 仅做契约映射。
- 不替换现有 Realtime Provider，不引入第二套 ASR/LLM/TTS，不实现客户端直连数字人厂商。
- 不把 GPU、模型、厂商 SDK 或 example 专用依赖放进主框架默认安装。

## 2. 已有能力与缺口

| 基线已有 | 本次开发仍需补充 |
| --- | --- |
| 可选客户端 WebRTC、现有 WSS 并存 | 数字人按连接显式启用 |
| Audio/Omni 模型侧 WSS | 不变，仍由现有语音前台生成回复 |
| 麦克风上行和音频下行 | 数字人视频下行、配对音视频调度 |
| Omni 摄像头上行 | 将 `video_input` 与 `video_output` 能力分离 |
| 认证、owner/session、连接接管 | 沿用，不建立第二套身份或历史 |
| 每连接独立媒体子进程 | 可注入的媒体输入适配器和受控私有媒体连接 |
| 生成完成、发送排空、播放回执分离 | 视频时间轴、取消代次、可验证的播放边界 |

现有 `session.update` 不支持数字人字段，也没有公共 Avatar Provider SPI。不能只安装一个 example 就宣称这些能力已经存在。

实现定位参考：`realtime-presentation-runtime.mjs`、`realtime-gateway.mjs`、`transport/webrtc/{routes,protocol,media,media-process,media-worker}.mjs`。这些模块的职责可复用，不能把厂商逻辑直接塞进其中。

## 3. 分层与部署

| 层 | 所在位置 | 职责 |
| --- | --- | --- |
| 对话运行时 | 主框架 | Realtime、工具、历史、响应状态、内容安全 |
| DigitalHumanOrchestrator | 主框架的可选模块 | 生命周期、超时、取消、输出模式和降级决策 |
| DigitalHumanProvider SPI | 主框架 | 厂商无关的助手音频输入和渲染结果契约 |
| Provider Adapter | 本 example | 把 SPI 映射为 Renderer 或厂商 API |
| Media Source Adapter | 本 example，受控媒体子进程内加载 | 接收媒体，转成网关统一媒体单元 |
| Media Worker | 已有可选 WebRTC 能力的扩展 | 发布客户端音视频、队列和时间轴管理 |
| Python Renderer | 本 example 的独立 GPU 服务 | 调用 OpenAvatarChat Avatar 组件和 FlashHead |
| WebUI | 本 example，由网关提供页面 | 麦克风、数字人视频、文字、打断、状态诊断 |

网关是唯一的客户端对接边界，但不是要求所有媒体字节都穿过 Node 主进程。Renderer 的大体积媒体直接进入网关管理的媒体子进程；主进程只管理控制和输入音频。

### 3.1 一次回复的数据流

1. WebUI 经网关 WebRTC 提交麦克风音频，网关通过现有 WSS 调用 Realtime。
2. 对话运行时产生助手音频、可用的文本增量和响应生命周期事件。
3. 编排器在现有响应有效性/抑制规则之后，选择普通音频或数字人输出。
4. 数字人模式下，适配器向 Renderer 流式发送回复音频，不等待整句完成。
5. Renderer 复用 Avatar 组件输出配对音视频，私有媒体适配器将它们交给 Media Worker。
6. Media Worker 通过同一个客户端 PeerConnection 发布音频和数字人视频。
7. 客户端播放回执回到现有呈现运行时，Provider 的完成事件不代替用户端播放回执。

### 3.2 每段协议

| 链路 | 首版选择 |
| --- | --- |
| WebUI 与网关建连 | 现有 HTTPS SDP 接口，补充数字人能力协商 |
| WebUI 与网关媒体 | WebRTC 音频轨道、视频轨道、DataChannel |
| 网关与 Realtime | 现有 WSS，不改 |
| OpenAvatarChat Adapter 与 Renderer | 私有 HTTP 会话管理、WSS 控制及二进制 PCM |
| Renderer 与 Media Worker | 私有 WSS 二进制配对媒体，限定同机/高带宽内网 |
| 将来的 LiveAvatar Adapter | 按 LITE 接口发送音频，另行适配其媒体服务 |

Provider SPI 不限定网络协议。将来即使厂商只提供 WebRTC/LiveKit，适配器也不能把房间地址直接交给浏览器来绕过网关。

## 4. 框架应提供的最小扩展

### 4.1 启动时注入，不自动发现任意插件

建议新增可选 `digitalHuman` 组合参数，包含 Provider factory、媒体适配器注册表和服务端配置。具体名称在 M0 固定；未注入时不创建 Provider、不分配媒体资源、不增加定时器。

首版由 example 的启动程序组合网关，不新增未经实现的 `qwenaudio --avatar` 命令。若现有程序化启动入口不适合扩展，先补最小受支持入口，不能让 example monkey-patch 网关内部方法。

注册表接受的模块和执行入口只能来自可信启动配置。HTTP、DataChannel 请求不能提交模块路径、可执行文件、服务 URL 或任意模型配置。

### 4.2 独立的呈现接口

提供规范化的 `response.start / assistant.audio / assistant.text / response.finish / response.cancel` 内部事件，并保留响应状态和取消原因。它不是公开的厂商消息原样转发。

现有语音转写可能等 `playback.started` 才向客户端发送。因此不能仅通过订阅公开 `transcript.delta` 驱动 Provider，否则依赖文本的实现可能形成等待环。内部文本分支应在适当的响应检查后、公开字幕播放门控前交付；对外字幕和历史确认语义不变。

编排器需要控制是否发布原始音频，不能挂成不受控的异步旁观者。未开启数字人时走原路径；开启后由每轮输出选择器决定去向。不得绕过现有安全恢复、权限撤销、连接接管和响应抑制。

### 4.3 视频下行与媒体进程

能力必须独立表达 `video_input` 和 `video_output`。普通 Audio 模型也能输出数字人，不要求 Omni 或摄像头权限。

首版连接时决定数字人模式，浏览器在 Offer 中预置接收视频的 transceiver。现有版本不支持重协商，不把“会话中突然增加视频轨道”作为隐式行为。只要不启用数字人，现有 SDP 和媒体行为保持不变。

Media Worker 保持可丢弃进程边界。仅接收作用域有限的媒体连接信息，不接收 Realtime 密钥、历史或工具上下文。新增视频队列必须有字节数和媒体时长限制，不能原样沿用 JSON IPC 传递高帧率原始视频。

## 5. 对客户端的拟议最小扩展

沿用现有 `/api/v1/webrtc/config`、SDP 创建及 DELETE 接口，避免建立第二套登录和会话 API。

- 配置响应新增 `video_output`、`digital_human.available` 及获授权的 persona 标识；`video_input` 保持原义。
- SDP 创建拟新增可选 `avatarPersonaId`，值必须由服务端白名单解析。不携带即保持普通模式。
- 模型仍在网关启动时选择；客户端不能通过数字人参数更改上游模型或地址。
- 不把 `digital_human` 硬塞进百炼风格 `session.update`。公共数字人状态通过现有 `qwaudio.event` 承载，例如内部事件 `digital_human.state`。
- `session.created` 的网关扩展可声明本连接最终能力；新增字段必须与协议/能力版本协商同步。
- 不支持的请求明确报错。数字人服务暂时不可用时，依策略显式进入 `audio_only`，不能伪称头像已就绪。
- M1 不支持运行中换人设。后续切换采用取消、关闭、按目标 session 重连，不改变 `ownerId`。
- WSS 不增加视频协议；未选择数字人的 WSS 客户端完全不受影响。

以上命名是开发提案，不是现有可调用接口。发布文档必须区分网关扩展与百炼原生事件。

## 6. 一路声音、三个完成状态

每轮只选择一个可听出口：普通音频、数字人配对音频或降级音频。Provider 若返回原始音频的配对输出，网关不得再播放原始 Realtime 音频。

必须区分模型生成结束、Provider/服务端媒体排空和客户端播放结束。Provider 的 `turn.completed` 只表示其输出终结，绝不直接记成 `playback.ended`。

降级采用更保守的媒体发布边界：

| 场景 | 行为 |
| --- | --- |
| Renderer 尚未就绪 | 本轮使用普通音频，或在有界首帧期限内等待 |
| 尚未发布本轮任何媒体，Provider 失败 | 取消 Provider，原子地选中 fallback，从缓冲起点流式播放，再接后续原音频 |
| 已发布本轮任何音频/视频，Provider 失败 | 取消本轮，不从头回放；下一轮可用普通音频 |
| 用户打断、内容安全拒绝、权限撤销 | 丢弃相关音频和视频，不得触发“从头播放”的降级 |
| 媒体进程或 PeerConnection 失效 | 该连接失败并由客户端显式重连；不能在失效轨道上承诺降级 |

“已发布但未收到播放回执”仍可能已经被用户听到，不能据此回放整段。输出切换和首包提交必须串行化，保证 Provider 迟到首帧不能与 fallback 同时获准发布。

## 7. 身份、历史和取消

| 字段 | 含义 |
| --- | --- |
| `ownerId` | 网关认证身份，不能由皮肤伪造 |
| `sessionId` | 现有对话历史流 |
| `personaId` | 服务端允许的形象/行为配置选择 |
| `avatarSessionId` | 临时 Provider 会话，重连后重新创建 |
| `responseId` | 网关响应标识，不另造一份对话 ID |
| `generation` | 本次呈现代次，取消或换 Renderer 后使旧输出失效 |

Provider 只获得渲染所需标识和数据，不接收历史、用户麦克风、工具或提示词。头像资产由 persona 配置解析，不接受客户端任意文件路径。

不同人设默认映射到同一 owner 下不同的 session；这是历史选择规则，不是新的权限边界。沿用现有历史恢复策略，不重放旧音频或视频，也不修改恢复条数。

取消同时通知 Realtime、Provider 和 Media Worker，但不无限等待远端 ACK。过期结果在编排器和媒体出口都拒绝；已进入浏览器缓冲的残留需单独测量和处置，不能宣称只清服务端队列就能绝对消除。

## 8. 依赖与安装边界

| 位置 | 允许的内容 |
| --- | --- |
| 主框架 | 无厂商依赖的契约、编排、协议和媒体扩展点 |
| example 的 Node 包 | OpenAvatarChat 适配器、WebUI/启动程序、显式 WebRTC 扩展依赖、开发测试依赖 |
| example 的 Python 包 | Renderer 服务及经锁定的 Avatar 推理依赖 |
| example 的本地缓存 | 上游源码、模型、头像资产、虚拟环境，全部忽略提交和 npm 打包 |
| 将来的 LiveAvatar example 扩展 | 仅选择此实现时安装其媒体 SDK，不成为本 demo 前置依赖 |

不加入根 workspaces，不修改根或 server 的 dependencies/optionalDependencies，不增加根安装时下载模型的脚本。现有 `qwen-audio-agent-webrtc` 是复用的可选能力，其安装由 example 显式管理，不复制 native addon。

Python 包的“安装依赖”与“启动完整对话链路”是两回事。即使为复用上游而暂时安装了较宽依赖，也不能启动其 ASR/LLM/TTS；依赖裁剪及许可证审计是开发任务，不能假设只 import 一个类就不需要上游环境。

## 9. 决策与后续评审门槛

已建议固定：网关唯一客户端入口、Avatar Only、音频核心/文本可选、厂商依赖留 example、OpenAvatarChat 首个实接、单人设单 GPU 活跃渲染会话起步。

必须通过实验再决定：当前原生 WebRTC 库能否满足音画同步及中断目标、私有媒体编码、GPU 型号和并发数。当前 raw-media 路线只用于局域网/同区域验证，不承诺公网低带宽性能。

若实验要求替换媒体引擎、引入 SFU、改为浏览器直连厂商，必须回到架构评审，不能作为适配器的隐式实现细节。完整交付门槛见开发计划。
