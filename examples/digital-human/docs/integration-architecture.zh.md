# PR #548 与 #562：架构差异及整合决策

[返回示例总览](../README_ZH.md)

分析基线：2026-10-21 的 `main` 为 `ff04050`，已合并 [PR #562](https://github.com/QwenAudio/qwen-audio-agent/pull/562)
（源分支头 `6d46c45`）。[PR #548](https://github.com/QwenAudio/qwen-audio-agent/pull/548)
已关闭，未合并，源分支头 `7856f32`。本次在最新 main 上迁入 Vidu 示例。

## 结论

需要调整目录、启动入口、文档和视频引用；当前没有必要再次修改 Gateway 核心，或把
Vidu 强行包装成 DHAV Provider。统一在 `examples/digital-human` 内，保留两条媒体链路：

- `bootstrap/`、`presentation/`、`providers/`、`media/`、`client/`：#562 已有的 DHAV
  Mock / FlashHead 与服务端 WebRTC 呈现。
- `vidu/`：#548 的 Vidu 控制代理、ARTC 浏览器订阅、可拖动 Electron 浮窗及测试。
- `assets/`：已有数字人视频 `digital-human-demo.mp4` 与 Vidu 视频
  `digital_human_demo_vidu.mp4`。中英文总览提供两个本地引用；DHAV 详细步骤保留在
  [中文指南](dhav.zh.md)和[英文指南](dhav.md)。

同一 example 代表统一的场景入口和维护位置，不代表同一活动会话内可以热切换传输。

## #562 的实现结构

1. **组合入口与依赖注入。** [compose-gateway.mjs](../bootstrap/compose-gateway.mjs)
   显式把 `digitalHuman` 注入 `createGatewayApplication`。配置含 Provider、persona
   白名单、renderer allowlist 和媒体适配器模块路径。框架默认值为 `null`；普通连接
   不创建数字人 runtime，核心没有反向导入 example。
2. **在服务端分流助手音频。** [RealtimePresentationRuntime](../../../server/src/voice/realtime-presentation-runtime.mjs)
   在首个音频 delta 上绑定回合；[编排器](../presentation/orchestrator.mjs)处理
   `responseId`、`generation`、打断、服务重建与回退。音频交给 renderer 时不同时沿
   普通路径播放，避免双声；[输出选择器](../presentation/output-selector.mjs)在首帧前
   缓冲音频，决定头像或音频路径，防止迟到媒体与降级回放竞争。
3. **控制与媒体分开。** [DHAV Provider](../providers/dhav-provider.mjs)创建会话、发送
   24 kHz 单声道 PCM 和控制指令，提供 scoped media binding。媒体 worker 直接用
   [framed-av-source](../media/framed-av-source.mjs)连接 renderer 的媒体通道，原始
   音视频帧不经主进程 JSON IPC。私有媒体凭证由 WebRTC transport 消费，不转发浏览器。
4. **统一音视频出口。** renderer 必须返回 [DHAV](../protocol/dhav.mjs)配对单元：
   PCM、I420 视频、PTS、序号和回合代际；[AvatarAvScheduler](../../../server/src/transport/webrtc/avatar-av-scheduler.mjs)
   以音频消费时钟驱动视频帧，隔离过期 generation，并用 `media_end`/队列排空区分
   模型生成完成和媒体播放完成。客户端经一条 Gateway WebRTC 连接接收音视频，视频
   transceiver 为 `recvonly`。
5. **保持语音会话可用。** 首帧前 renderer 不可用可转纯音频；已提交头像后的失败按
   编排器策略取消/恢复，不等价于无缝重放整个已播放回合。播放终态仍需客户端回执；
   worker 排空不证明声卡已发声。当前预览版拒绝同时请求摄像头输入和头像下行。

这些核心改动用于支持可替换渲染器、音视频配对与可验证的播放生命周期，有通用价值。
本次保留已合并实现及测试；无需为目录统一删除或重做这些接口。

## 与 #548 Vidu 的差异

| 方面 | #562 DHAV | #548 Vidu |
| --- | --- | --- |
| 接入层 | 服务端呈现扩展，生成音频在 Gateway 内分流 | 普通 Gateway SDK 客户端，收到助手 PCM 后转发给 Vidu |
| 语音与渲染协议 | Gateway → DHAV input；独立 DHAV media channel 返回配对媒体 | Gateway WebSocket → 浏览器 → 本地 Vidu WebSocket 代理；音视频通过 ARTC 返回浏览器 |
| 音频出口 | 媒体 worker 的队列，头像/普通音频择一 | ARTC 为唯一可听声音；本地 PCM 播放被静音 |
| 同步与回执 | 配对 PTS + 音频时钟 + response/generation + 队列/客户端回执 | ARTC SDK 内部播放；Gateway 回执由静音 PCM 时钟估算，不知道实际 ARTC 播放位置 |
| 渲染失败 | 首帧超时/错误等情况下有选择器与回退逻辑 | 结束失败会话/报告错误，没有 DHAV 音频回退契约 |
| Gateway | 单独示例配置和 state，注入数字人选项 | 默认借用原悬浮球 Gateway，或按桌面配置启动并负责自己的进程 |
| 客户端 | React SPA，Gateway `/skins`，浏览器 WebRTC | 独立 Vite 浏览器 UI + Electron 浮窗，原悬浮球可选 |
| 附加依赖 | 原生 WebRTC 媒体扩展、远端 GPU 或本地 Mock | Vidu/ARTC 账户、官方浏览器 ARTC SDK；独立 Electron 依赖 |

Vidu 控制接口接收音频/文字/打断等指令，但当前实现取得的是 RTC 入会凭证和控制 secret，
没有 DHAV 的配对 PCM/I420、PTS、逐回合媒体序号或 `media_end`。因此实现一个同名
`capabilities()`/`openSession()` 外壳并不能满足 #562 的媒体契约。

## 本次必要改动

- 从 #548 的 `example/digital-human-vidu` 迁至 `examples/digital-human/vidu`，修正
  仓库导入深度、桌面路径、Vite 访问范围和原悬浮球启动路径；保留独立依赖锁文件。
- 在 example 根增加 `start:vidu`、`dev:vidu`、`start:orb`、`vidu:install`、
  `build:vidu`、`test:vidu`、`test:all`；现有 `npm start` 的 DHAV 行为保持兼容。
- 中英文根 README 统一展示能力、边界、运行选择、配置、验证与署名；详细操作各自保留。
  保留原 GitHub 附件在线播放链接，另附仓库已有视频链接，并将 Vidu 视频放入同一 assets 目录。
- 根 CHANGELOG 记录整合；本次不新增 server/shared/desktop 核心改动，不迁入旧版依赖
  中不存在的 3D 模型，也不复制本地 `.env.local` 或运行状态。

## 何时才值得进一步改架构

若产品要求所有数字人都走同一 Gateway WebRTC 连接、真实渲染进度参与工具播报调度、
统一跨设备客户端，或服务端强制管理所有 renderer，会需要更深的整合。可选路径是实现
Vidu/ARTC 服务端接收桥，导出有时间戳和回合/代际关联的 PCM/I420，再适配 DHAV；这会
引入 RTC 接收、解码、格式转换、背压、取消后迟到帧处理及额外网络跳数，需单独验证
SDK 支持、延迟和许可。仅迁移目录或复用 UI 不构成引入该桥的理由。

另一种未来方案是为外部 RTC 下行设计独立的 presentation transport 契约，并用真实
ARTC 回调定义可靠回执；它不能直接沿用目前要求 `paired_av` 的 DHAV 调度器。当前
用户需求是示例归一与保留可选 UI，现有两条链路已覆盖，不预先增加这一抽象。

## 验证范围

本次迁移需验证两套协议测试、两套前端构建、Vidu 默认仓库路径和 Gateway 生命周期，
并确认文档与两份视频引用存在。真实 GPU FlashHead、收费 Vidu/ARTC 以及真实语音
上游的有声交互仍属独立手工验收，不能用 Mock 测试结果替代。

2026-10-21 本地已执行：

- DHAV 98 项、Vidu 16 项测试通过；新增嵌套目录下默认仓库路径的回归覆盖。
- 核心 presentation 与 A/V scheduler 的 20 项独立测试通过。
- `build:client`、`build:vidu` 通过，迁入源码 ESLint 与 `git diff --check` 通过；
  7 份说明文档的本地链接、代码块解析和 video 文件引用检查通过。
- Chrome 使用假麦克风与模拟 Gateway/Vidu/ARTC，验证 SDK 握手、文字、PCM 转发、
  播放回执、打断、挂断和新会话重连通过；未使用真实收费服务。
- 隔离 Electron 浮窗和浏览器冒烟通过：窗口、设置、原悬浮球选项、缺配置提示与渲染
  隔离正常；退出关闭自己启动的 Vidu 服务，借用的模拟 Gateway 仍在运行。

测试依赖复用本机已有安装，未重新安装整份最新根锁文件。原 GitHub 附件地址在无登录
命令行 HEAD 请求中返回 404，但这不能证明页面视频不可用；按用户确认保留原链接，
同时提供本地视频文件引用。
