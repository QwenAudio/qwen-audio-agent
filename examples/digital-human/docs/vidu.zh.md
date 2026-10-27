# Vidu / ARTC 原生音画预览

[English](vidu.md) · [返回总览](../README_ZH.md)

Vidu 适配器接收 Gateway 已生成的助手 PCM，并通过原生 ARTC 返回音视频；浏览器用同一媒体元素播放，保留供应商提供的声音和音画同步。框架运行时、公开 SDK、GCP、模型 prompt 与工具配置均不需要数字人专用修改。

**当前为默认关闭的实验预览，PR 保持 Draft。逐回复播放边界与真实服务验收尚未补齐，不能用于可靠的任务结果播报或交付确认。**

## 回执边界

- Vidu 不协商 `playback.receipts`，也不发送 `playback.started/ended/cancelled`；DHAV 的真实播放回执保持不变。
- 已移除静音源 PCM 播放器与原声对照开关，不用另一条听不到的时间线表示用户已听到。
- Gateway 的 `audio.done` 只表示本轮源音频输入结束，不等于 Vidu 已完成生成或浏览器已播完。
- 不用静音间隔、输入时长、波形匹配或估算定时器补造完成事件。不抽取并重排供应商音轨或视频帧。
- 关闭回执能力只是避免错误确认，**不代表可靠任务播报已经成立**；Gateway 无法据此知道用户实际听到或听完了哪条回复。

截至 2026-10-27，[官方组件版参数](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters)未定义与本地 `responseId` 对应的输出结束事件；[官方 WebSocket 协议参考](https://github.com/shengshu-ai/vidu-s-api/blob/main/skills/vidu-s-api/references/websocket-protocol.md)中的 type 7 是打断请求，没有可用于确认旧媒体排空的对应 ack。连接初始化成功、RTC 入会和挂断都不能替代逐回复完成证明。上述结论针对公开接口，不推断供应商内部没有相关能力。

正式接入公共播放控制器前，需要供应商提供可关联回复的输出边界，并结合播放器实际排空确认完成。当前没有听到位置反馈或模型历史截断能力。

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
3. 先启动普通 Gateway，再填写本例 `.env.local`：

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

本次自动化与真实服务验证状态见[验证记录](presentation-validation.zh.md)，部署检查见[验收清单](implementation-plan.zh.md)。[旧版视频](../assets/digital_human_demo_vidu.mp4)只展示历史外观与交互，不证明当前实现已验收；旧对齐实验也不作为本次证据。
