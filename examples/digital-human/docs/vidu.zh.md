# Vidu / ARTC 实验预览

[English](vidu.md) · [返回总览](../README_ZH.md)

此版本已经迁入 #573 的标准 Gateway + 双连接客户端。Vidu 长期凭证与控制逻辑在
`server/renderers/vidu.mjs`，浏览器 RTC 在 `client/renderers/vidu.mjs` 与
`artc-player.mjs`。所有 UI 共用 `useDualConnection` / `AvatarPlaybackController`，
没有专用 Gateway、GCP 消息或静音回复时钟。

## 尚未解决的合入阻塞

[Vidu 组件版公开协议](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/parameters)
只有初始化确认和强制挂断等服务端控制信号，没有逐回复的最后媒体样本/队列排空通知。
`audio.done` 只是 Gateway 输入完整；订阅、视频播放、RTC 统计、静音区间和 Token 过期
也不能证明该回复不会再产生声音。因此本适配器默认关闭；实验模式不发送
`playback.ended`，不适用于依赖准确播完回执的后台任务播报。不是合入就绪的商业方案。

起播观察的是 SDK 远端音轨在实际可听 WebAudio 路径上的非零信号（SDK 自带自动播放
始终关闭音量，避免双声），不是源 PCM 时钟。此观测仍需真实 ARTC 验证，不能证明
用户物理扬声器已经发声。静音输入可能不产生起播回执。

实验预览中，回复会一直保持未完成，直到显式打断、新输入、错误、断开或资源上限触发
取消。新输入不是自然播完的替代。没有可靠结束边界时，后续已排队的自动回复不会自然
轮转，可能影响工具播报；请勿用于业务。每回复直播最多保留 120 秒，到期按失败取消
而非成功结束。每回复源 PCM 上限 4.8 MB（100 秒），等待发送的输入有界。

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

明确接受上述限制后才设置 `VIDU_EXPERIMENTAL=1`；默认模板是 0。API Key 不带 `Token`
前缀。环境变量优先于本例 `.env.local`，改动后重启 `npm start`。密钥不放入 Vite 变量、
图片或浏览器配置，不需要手动配置短期 RTC Token。

```sh
npm ci
npm run build:client
npm start
```

打开打印地址，确认页面展示实验限制，连接数字人，选择默认角色、HTTPS 图片或上传不
超过 4 MB 的 PNG/JPEG/WebP。点击麦克风或输入文字；第一块助手音频才创建收费直播。
开始后可能产生 Vidu/ARTC 费用，即使未听到声音也不能假设免费。页面“打断/结束”可
停止本地媒体并关闭远端直播；结束后退出本例服务，不能仅静音麦克风当作结束。

若创建请求超时而未取得 live ID，不能保证远端未创建直播；需在平台核查状态。

浏览器从官方 CDN 读取固定 ARTC SDK 7.1.9，需要联网。本地服务只把限会话短期 RTC
Token 发给浏览器，Vidu control secret 和长期 Key 均留服务端。

## 打断隔离与后续方案

每个回复/代际使用独立 Vidu live、RTC 频道和订阅状态，关联到具体 `responseId`。
取消先同步切断可听音频图、清空 video，再尽力发送远端 interrupt/hangup；迟到 HTTP
创建结果也会被挂断，旧轨道 Promise、RTC 事件及回调不能重新挂到新图上。渲染错误
不回放原 PCM，以免已播放后重播。麦克风静音不会停止输出。

要解除阻塞，需要厂商提供可验证的逐回复最后媒体标记与本地播放排空观测，并映射到
当前 live/response/generation；或与维护者商定明确降级的回执能力契约。不能新增模型
终态/定向清理 GCP，也不能用固定延时伪装播完。真实商业环境的多轮、长句、同步、
取消后旧媒体隔离仍未验收。

## 故障检查

- 连接按钮不可用：检查 `/api/config` 的 `renderer.enabled/reason`、实验开关和三个凭证。
- 401/403：核对 Vidu Key 环境、权限与额度；错误返回不展示远端响应体或长期凭证。
- RTC 入会失败：检查同一应用的 AppID/AppKey、系统时间、SDK CDN 和网络。
- 自动播放被阻止/AudioContext 挂起：本轮停止并取消，不报告播完；重新点击连接授权。
- `session_expired`：预览直播达到资源上限，重新输入会创建新会话；不是成功播放回执。

`.env.local` 和浮窗 `.desktop/` 已忽略。删除本地文件不等于删除远端数据；远端保留
策略以服务方为准。历史 Vidu 演示位于 [视频文件](../assets/digital_human_demo_vidu.mp4)，
展示旧版交互，不证明本版本的真实播放生命周期已完成验收。
