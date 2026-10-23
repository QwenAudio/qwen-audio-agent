# #570 评审后的适配与剩余阻塞

[返回总览](../README_ZH.md) · [Vidu 实验模式](vidu.zh.md)

## 新基线

2026-10-23 已同步 main（`d2a8dc4`），包含已合并的
[#573 双连接客户端](https://github.com/QwenAudio/qwen-audio-agent/pull/573)。
[#570 的维护者 remark](https://github.com/QwenAudio/qwen-audio-agent/pull/570#issuecomment-6336667891)
要求复用此基线，撤掉 #562 内嵌 Gateway 呈现、WebRTC worker 的接入方式。
旧的 #562 架构对照已过时，本文件替代其原始分析。

## 本次迁移

- 直接保留 main 的标准 Gateway + `useDualConnection`，不维护 Vidu 专属 Gateway Client。
  `vidu/client/src/gateway-voice.js` 和旧 `main.js` 均删除。
- [服务端 Vidu 适配器](../server/renderers/vidu.mjs)负责鉴权、创建直播、输入 PCM、初始化
  重试、hangup 和短期 RTC Token；通过现有 `server/renderers/index.mjs` 注册。
- [浏览器 Vidu 适配器](../client/renderers/vidu.mjs)注册到 `renderer-adapters.mjs`，复用
  `AvatarPlaybackController`；[ARTC 播放器](../client/renderers/artc-player.mjs)保留原生 RTC。
  没有 DHAV 转码、Gateway 注入或新增 GCP 事件。
- 可听声音来自远端 ARTC 音轨，经实际 WebAudio 图播放；SDK 自动播放始终音量为 0，
  避免双声。已删除把源 PCM 接入静音节点模拟回复回执的实现。麦克风 worklet 的静音
  sink 只用于采集处理，不生成回复播放回执。
- 每回复/代际新建直播与频道，明确关联 `responseId/generation`；取消先停止本地图，
  再尽力取消/挂断远端。迟到 HTTP 创建结果也会关闭，旧媒体事件/Promise 不能复活。
- 默认连接操作者已启动的普通 Gateway；本例与桌面壳不启动、配置或停止它。
  跨目录内部源码引用已移除；框架访问只用 main 中既有公开 npm 导出。
- 桌面壳只打开同一页面，保持角色图片、拖动、对话与控制；没有另一套对话/回执状态机。
  原悬浮球可独立选择，可选本机操作者配置的无 Shell 启动命令。

## 无法声称已解决：逐回复媒体结束

核对 [Vidu 组件版详细协议](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters)
及固定 [ARTC Web SDK 7.1.9](https://g.alicdn.com/apsara-media-box/imp-web-rtc/7.1.9/aliyun-rtc-sdk.js)：
公开的组件 WS 服务端信号为初始化确认、强制挂断等，没有按 response 标记的最后媒体
样本或队列排空信号。ARTC 轨道持续存在，收到静音也不能排除稍后继续产出。

| 信号 | 能说明什么 | 不能说明什么 |
| --- | --- | --- |
| Vidu 初始化成功 / ARTC 入会、订阅 | 控制链路/媒体订阅就绪 | 回复已起播、已完成 |
| 实际可听音频图中的非零信号 | 当前独立 live 有音频通过播放图 | 物理扬声器状态、回复已排空 |
| Gateway `audio.done` | 源 PCM 输入已结束 | Vidu 不会再产出、RTC 缓冲已排空 |
| 静音、时长、视频帧、统计 | 某时刻观测状态 | 逐回复最后媒体边界 |
| 断线、到期、打断、资源上限 | 本轮需要取消 | 成功播完 |

因此默认不开启 Vidu。只有 `VIDU_EXPERIMENTAL=1` 可手动预览，并明确**不发送
`playback.ended`**。它会保留未完成状态，直至用户新输入/打断或失败；可能阻塞已排队
的自动回复及任务播报。禁用原 PCM 回退，避免不知道是否已经开口时重播。每轮直播
120 秒上限只用于成本/资源控制，到期失败取消，不冒充播放结束。

解除阻塞需要：厂商可验证的逐回复终止标记、与 RTC 实际播放排空的关联；或者维护者
认可的降级回执能力契约。不能靠新增模型终态、定向 `playback.clear` 或延时来绕过。
本 PR 应保持 Draft，待该契约讨论和真实商业环境验收后再标为可合入。

## 验证与待办

已执行模拟回归与实际浏览器媒体图验证，保留 DHAV 原有测试；详见 PR 的实际验证结果。
覆盖 Vidu 多轮、长 PCM、初始化重试、取消/迟到隔离、自动播放失败、悬挂入会、SDK 单例
释放、重连、凭据过期和关闭。测试不访问真实模型、GPU 或收费 API；不能把假 SDK 产生
的 MediaStream 当作真实 Vidu/ARTC 验收。

仍需确认真实 SDK 的远端轨道播放、音画同步和首帧表现，完成可验证的逐回复边界设计，
再在用户商业账户验证长句、多轮和打断后旧音频隔离。当前没有执行该付费验收。

本次验证：116 项单元/本地集成测试、DHAV 浏览器冒烟、Vidu 假厂商 SDK + 真 MediaStream
浏览器冒烟、共用页面 Electron 浮窗/拖动/退出验证通过；前端构建、显式源码 ESLint、
Markdown 本地链接与 diff 检查通过。隔离目录的 `npm ci --ignore-scripts` 安装通过；
构建与浏览器测试复用本机已有依赖，没有执行真实收费 API 验收。演示视频保留原 GitHub
链接和本地素材，它们不证明新适配的验收状态。
