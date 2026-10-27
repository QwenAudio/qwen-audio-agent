# Vidu / ARTC 原生音画预览

[English](vidu.md) · [返回总览](../README_ZH.md)

Vidu 适配器接收 Gateway 已生成的助手 PCM，并通过原生 ARTC 返回音视频；浏览器用同一媒体元素播放，保留供应商提供的声音和音画同步。厂商实现位于 example；Gateway 只增加显式能力协商后的通用无播放回执降级，不加入供应商代码、新公开协议或厂商 SDK 依赖。

**这是默认关闭、需显式启用的商业服务接入示例。本版尚未完成真实 Vidu 验收；不适合依赖自动播报确认的生产流程。** 自部署服务可选择默认 DHAV，其真实播放回执不变。

**Gateway 版本要求：**须包含通用无回执降级（`761672f` 及之后版本）。对应版本发布前，按[总览的源码步骤](../README_ZH.md#快速开始)使用最新 `main` 启动 Gateway；旧已发布版本可能卡在等待回执的字幕/调度路径。只更新 example 或客户端 SDK 不够。

## 回执边界

- Vidu 不协商 `playback.receipts`，也不发送 `playback.started/ended/cancelled`；DHAV 的真实播放回执保持不变。
- 已移除静音源 PCM 播放器与原声对照开关，不用另一条听不到的时间线表示用户已听到。
- Gateway 的 `audio.done` 只表示本轮源音频输入结束，不等于 Vidu 已完成生成或浏览器已播完。
- 不用静音间隔、输入时长、波形匹配或估算定时器补造完成事件。不抽取并重排供应商音轨或视频帧。
- 关闭回执能力只是避免错误确认，**不代表可靠任务播报已经成立**；Gateway 无法据此知道用户实际听到或听完了哪条回复。

完成显式 GCP 能力协商且未声明 `playback.receipts` 时，Gateway 展示生成字幕、保存普通对话，在生成完成后释放生成侧调度；这些是生成状态，不是播放回执。自动后台结果通知不领取，保持 pending，避免被误判为已播报。框架的任务记录与查询、权限和取消接口保留；用户可通过语音或文字主动询问状态，但本例没有完整的任务卡片/权限管理 UI。未采用这类显式协商的传统客户端行为不变。

截至 2026-10-27，[官方组件版参数](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters)未定义与本地 `responseId` 对应的输出结束事件；[官方 WebSocket 协议参考](https://github.com/shengshu-ai/vidu-s-api/blob/main/skills/vidu-s-api/references/websocket-protocol.md)中的 type 7 是打断请求，没有可用于确认旧媒体排空的对应 ack。连接初始化成功、RTC 入会和挂断都不能替代逐回复完成证明。上述结论针对公开接口，不推断供应商内部没有相关能力。

若将来要启用真实播放回执，需要供应商提供可关联回复的输出边界，并结合播放器实际排空确认完成。当前没有听到位置反馈或模型历史截断能力；这些限制不妨碍将其作为能力明确的可选接入示例。

## 首包与媒体就绪

ARTC 入会并配置接收后，播放器通过示例内部 `onInputReady` 允许发送排队 PCM，**不等待远端音视频轨出现**。部分服务收到首包才发布媒体，先等轨再发音频会形成循环等待。

音视频返回并实际开始播放另由 `onReady` 更新客户端展示状态；它不代表本轮播完，也不会产生 Gateway 回执。已发送音频后若媒体持续不就绪，则有界超时并报错，不无限等待。

## 打断与会话隔离

1. 用户打断、新文字输入或 Gateway 清空输出时，本地立即静音、暂停并解绑旧 RTC 媒体，不等待网络响应。
2. 拒绝旧回复后续 PCM，令旧 epoch 的凭据、回调和媒体失效。
3. 服务端尽力发送 type 7 interrupt，再发送 hangup 关闭旧 live；这不是远端打断成功的确认。
4. 下一条有效回复到达后，使用新 epoch、新 live 和新 RTC channel。不能仅解除静音而继续使用旧流。

正常 `audio.done` 不触发挂断或估算播放完成。连接期间可能持续产生待机费用；打断后的重新建连增加首帧延迟，也可能增加供应商会话费用。点击“结束”释放当前连接。

初始化、播放或连接失败时，明确显示错误、停止麦克风采集并要求重连，不自动重播原始音频。用户主动静音麦克风只停止输入，不停止正常播放。

## 申请与配置

1. 在 [Vidu 国内 API 平台](https://platform.vidu.cn/)申请有 S2 Avatar 组件版权限和额度的 `vda_...` Key。国内 Key 使用 `api.vidu.cn`，[海外平台](https://platform.vidu.com/) Key 使用 `api.vidu.com`。
2. 按[阿里云实时音视频应用指南](https://help.aliyun.com/zh/live/activate-application)创建应用，复制同一应用的 AppID/AppKey；它们不是阿里云账号 AccessKey。服务端按 [Token 鉴权](https://help.aliyun.com/zh/live/token-based-authentication)签发临时入会凭证。
3. 按上述版本要求启动配套 Gateway，再填写本例 `.env.local`：

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

确认接受实验限制及费用后才设置 `VIDU_EXPERIMENTAL=1`，模板默认是 0。Key 不带 `Token` 前缀。环境变量优先于 `.env.local`，改动后重启示例；不要把长期密钥放进 Vite 变量、图片或浏览器配置。

```sh
npm ci
npm run build:client
npm start
```

连接前选择默认角色、HTTPS 图片 URL 或不超过 4 MB 的 PNG/JPEG/WebP。默认预览随示例打包。Vidu 模式连接后请求麦克风权限；桌面浮窗共用同一页面，原悬浮球仍是独立 UI 选项，一次仅使用一个客户端收音。

## 资源与验证

- 长期 Vidu Key、ARTC AppKey 和控制 secret 留在服务端，浏览器只收到临时 RTC 凭证。
- ARTC Web SDK 固定为 7.1.9；模型、工具和 prompt 继续由普通 Gateway 配置。
- 每回复源 PCM 限 4.8 MB，输入排队有界，live 最长 30 分钟；故障和到期会关闭会话并提示重连。
- 创建请求超时且未获得 live ID 时，不能保证远端未创建直播，需核查平台会话与账单。
- `.env.local` 与 `.desktop/` 已忽略；删除本地文件不等于删除供应商保留的数据。

本次自动化与真实服务验证状态见[验证记录](presentation-validation.zh.md)，部署检查见[验收清单](implementation-plan.zh.md)。[旧版视频](https://github.com/user-attachments/assets/dc9296b5-dfbe-4243-a2c6-3bf49237d71b)只展示历史外观与交互，不证明当前实现已验收；旧对齐实验也不作为本次证据。
