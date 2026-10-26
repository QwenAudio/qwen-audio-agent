# Vidu / ARTC 延迟展示预览

[English](vidu.md) · [返回总览](../README_ZH.md)

Vidu 是原始语音会话的展示旁路。模型 PCM 在本地按原声时间线实际调度，通过增益 0 静音；
其开始、排空和取消产生 Gateway 播放回执。Vidu 返回音视频由同一原生媒体元素持续播放，
不向 Gateway 提供播放时间、结束候选或打断判断。没有新增 Gateway 协议或 Agent 配置。

## 两条独立链路

- 原始链路：用户麦克风 → Gateway → 原有模型及工具链 → 源 PCM 播放器 → Gateway 回执。
- 展示旁路：源 PCM 的副本 → 示例内 Vidu 适配器 → Vidu / ARTC → 原生音视频播放。
- 源音频静音只改变 GainNode 的增益，保留真实 PCM、采样率、连续调度、onended 和清理。
  `playback.started/ended/cancelled` 明确表示源音频时间线状态，不表示数字人已经出声或播完。
- RTC 初始化、媒体内容、返回速度、播放失败及断线均不能取消源播放器、修改回执或触发模型取消。
  Gateway 连接不等待 Vidu 初始化或 RTC 入会。Vidu 失败会提示，原始对话仍可继续。
- 不做在线波形匹配、频域匹配、双时间轴估算、固定起播等待、额外音频缓冲或视频帧重排。
  浏览器和 RTC 自身的网络及解码缓冲仍存在。
- 没有源音频块时不向 Vidu 发送数据、不补静音；源 PCM 中已有的静音原样发送。

“原声对照”开关隐藏数字人并静音 RTC，开放同一个源播放器的音量。它不重建会话、不重播音频、
不改变 PCM 内容或调度，也不改变回执。切回数字人时只交换音量与画面可见性。
本地 PCM 的基础调度提前量为普通本地 Web 客户端同样的 20 ms，没有 Vidu 专属等待。
此对照验证本例内部两种输出模式，不能据此宣称完整 WebUI、远程传输及各模型体验完全相同。

## 打断与连续展示的取舍

语音打断仍由原有 Realtime 服务的检测事件和 Gateway 决定；点击打断及新文字输入仍走原有
客户端取消链路。源播放器停止并按原有语义上报取消，之后的旧回复块不再追加到 Vidu。
**已经上传的音视频允许继续顺序展示**，不在正常结束、用户打断或下一轮开始时向 Vidu 发送
interrupt，不静音、不摘轨，也不为了匹配状态切掉画面。Vidu 侧不存在逐回复播放占用。

因此数字人可能仍播放已经被 Agent 取消的内容；新回复也可能晚于原始时间线出现。此设计优先
保留原有 Agent 行为和数字人的连续输出，不提供“用户按所听位置打断后模型精确截断历史”的能力。

例如源回复在本地时间 0 秒开始，数字人延迟 3 秒。用户在本地第 8 秒开口时，听到的约是源第 5 秒，
原始模型链路则可能已经生成或处理到第 8 秒甚至更远。把数字人播放时间作为新的回执条件，
不会自动让模型撤回这段差额；继续以原始时间线处理，可避免展示延迟再反过来改变 Agent 调度，
但不能消除用户听到位置与模型上下文的差异。要消除差异，必须另行设计模型可支持的听到位置反馈、
历史截断及媒体停止契约，这不属于此展示旁路。

该取舍与此前审核要求的“回执来自实际 ARTC 播放、打断立即停止并隔离旧媒体”不同，需维护者
明确认可本例作为延迟展示的范围，不能宣称原审核要求已经满足。保留实验开关，默认关闭。

## 申请与配置

1. 登录 [Vidu 国内 API 平台](https://platform.vidu.cn/)，在 API Key 管理创建 `vda_...`
   密钥；[申请/充值指南](https://platform.vidu.cn/docs/quick-start)。确认账户具备 S2
   Avatar 组件版权限和额度。国内 Key 使用 `api.vidu.cn`，
   [海外平台](https://platform.vidu.com/) Key 使用 `api.vidu.com`。
2. 按[阿里云实时音视频应用创建指南](https://help.aliyun.com/zh/live/activate-application)，
   在视频直播控制台的“直播+ → 实时音视频 → 应用管理”创建应用，管理/基本信息中复制
   同一应用的 AppID/AppKey。它们不是阿里云账号 AccessKey。服务端按
   [Token 鉴权](https://help.aliyun.com/zh/live/token-based-authentication)签发短期入会凭证。
3. 先启动标准 Gateway，在 `examples/digital-human/.env.local` 填写：

```dotenv
DH_GATEWAY_URL=ws://127.0.0.1:18888/api/realtime
DH_CLIENT_PORT=5273
DH_RENDERER_ADAPTER=vidu
VIDU_EXPERIMENTAL=1
VIDU_API_KEY=vda_your_key
ARTC_APP_ID=your_app_id
ARTC_APP_KEY=your_app_key
VIDU_HOST=api.vidu.cn
```

确认接受延迟展示及计费后才设置 `VIDU_EXPERIMENTAL=1`；默认模板是 0。API Key 不带 `Token`
前缀。环境变量优先于本例 `.env.local`，改动后重启 `npm start`。密钥不放入 Vite 变量、
图片或浏览器配置，不需要手动配置短期 RTC Token。

```sh
npm ci
npm run build:client
npm start
```

打开打印地址，点击连接即可启动普通 Gateway 会话及独立的 Vidu 展示。Vidu 模式会请求
麦克风权限并持续收音；麦克风静音只影响采集。图片支持默认角色、HTTPS URL 或不超过 4 MB
的 PNG/JPEG/WebP 上传，需在连接前选择。默认预览随示例打包。

“打断”处理原始会话，数字人不硬切；“结束”关闭两条连接并 hangup。待机期间仍可能计费。
桌面浮窗保持持续人物画面，设置和对话可展开；原悬浮球仍作为另一套可选 UI。
同一会话复用一个 Vidu live、ARTC 引擎及音视频轨；不逐回复重连。

## 资源与故障

- 长期 Vidu Key、ARTC AppKey 及控制 secret 留在服务端；浏览器仅接收会话临时 RTC 凭证。
- 官方 CDN 的 ARTC Web SDK 固定为 7.1.9。模型、工具、搜索及 prompt 由用户普通 Gateway 配置决定。
- 每回复源 PCM 上限 4.8 MB，待发送输入有界；超限仅停止展示，不取消原始对话。
- live 最长 30 分钟；结束、到期及展示连接错误会清理展示资源，不发送 Gateway 成功或取消回执。
- 断线或自动播放失败时显示提示。可使用原声对照继续听原音频，结束后重连可重建展示。
- 创建请求超时且未取得 live ID 时，无法保证远端未创建直播，需在平台核查。
- `.env.local` 与 `.desktop/` 已忽略。删除本地数据不会自动删除服务端保留的数据。

历史演示：[Vidu 视频](../assets/digital_human_demo_vidu.mp4)。它展示旧版交互，不证明本次旁路
设计已完成真实服务验收。完整控制流见[音频流程图](audio-processing-flow.zh.md)，设计动机和
审核范围变化见[PR 说明草稿](pr-description.zh.md)。旧对齐采样仅为历史实验，不是当前算法。
