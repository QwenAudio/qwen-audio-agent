# 示例内的数字人适配器契约

这是本示例的代码扩展点，不是主框架协议。目标是让自部署 DHAV 和商业 RTC 服务复用同一客户端调度，不强迫它们共享媒体格式。

框架保持不变。官方 Client SDK 提供现有 `audio.delta` / `audio.done` 和全量 `playback.clear`；适配器只补充渲染与真实播放边界，不要求新的 GCP 事件或模型终态。普通 WebSocket 的通用 `error` 不用于按文案推断某条回复失败或取消。

## 浏览器适配器

`client/renderer-adapters.mjs` 注册 `createPlayer(options)` 和 `createController(options)`。DHAV 实现在 `client/renderers/dhav.mjs`。

公共控制器依赖的 renderer 接口：

```js
const renderer = {
  startTurn({ responseId, generation }, { onStarted, onDrained, onError }) {},
  appendAudio(turn, base64Pcm24k) {},
  endTurn(turn) {},
  cancelTurn(turn, reason) {},
  handleMessage(message) {}, // 可选：处理服务端消息
  disconnected(reason) {},  // 可选
  close() {},
}
```

- `startTurn` 只在真实 PCM 到达后调用。输入为 PCM16LE / 24 kHz / mono。
- `endTurn` 表示输入完整，不是已经播完。
- `onStarted` 必须依据实际可听播放，不是连接成功、首帧下载或输入结束。
- `onDrained` 必须同时满足：该响应不会再产生媒体，播放器已排空。
- `cancelTurn` 同步停止本地媒体并隔离旧回调；远端取消可以异步完成。
- 若音频已实际起播但 JS 回调延迟，取消时需先补报真实起播，再返回，避免公共控制器误以为可以从头回退。
- 适配器的同步异常、返回 false、Promise 拒绝或 `onError` 表示渲染 / 播放失败，不代表模型执行终态；队列必须有界。
- 异步服务初始化由适配器完成后，桥接发送通用的 `session.ready`。厂商 session 字段不进入公共控制器。

上述 renderer 契约描述实际媒体交付路径，DHAV 继续遵守。Vidu 则明确作为展示旁路：
`createController` 接收 `audioContext`，创建独立的源 PCM 播放器，默认 gain=0，其回执只代表源时间线；
RTC 生命周期不接入这些回调。它不声称以静音源时间线证明 RTC 实际播放。

注册项 `presentationOnly: true` 表示 Gateway 无须等待展示 `session.ready` 或 RTC 入会，展示断线不关闭 Gateway。
Vidu 的 `handleGateway` 先交给源播放器，再尽力转交展示；`rendererDisconnected` 只关闭展示并提示。
`setSourceAudible` 仅用于原声对照，交换音量和画面，不重建音频源。

注册项可选 `maxBufferedBytes`，供公共发送器限制待发字节；例如图片的 Base64 编码可能
大于 PCM 的默认限额。该值来自可信适配器代码，浏览器请求不能任意修改。

## 服务端适配器

在 `server/renderers/index.mjs` 注册同名项：

```js
const adapter = {
  async attach(browserSocket, {
    rendererUrl, rendererToken, persona,
  }) {
    // 创建厂商会话，完成媒体入口初始化。
    // 长期密钥仅在这里使用。
    // 接收助手音频，转为厂商 API；媒体可直接走厂商 RTC。
    browserSocket.send(JSON.stringify({ type: 'session.ready' }))
    return async function close() {
      // 关闭自有会话，幂等释放资源。
    }
  },
}
```

服务器与浏览器之间的厂商消息属于对应适配器；既不是 GCP 扩展，也不要求使用 DHAV。长期密钥不下发；限时、限会话的 RTC 凭据可以下发。服务入口、人设等由可信服务端配置控制。

服务端注册项可选 `config({ providerOptions })` 返回安全的公共能力/不可用原因，不能
包含密钥；可选 `maxMessageBytes` 为对应媒体/图片消息设置有界帧限制。

## DHAV 的现有映射

| 客户端消息 | DHAV 操作 |
| --- | --- |
| `turn.start` + responseId / generation | provider.startTurn |
| `audio.append` + audio / sampleRate | provider.appendAudio，适配器计数 sequence / sampleOffset |
| `audio.end` | provider.finishTurn |
| `turn.cancel` | 本地立即隔离 + provider.interruptTurn |

浏览器接收原 DHAV 二进制帧。provider 的 avatarSessionId 只存在于 DHAV 适配器内部；公共控制器不要求此字段。原 DHAV v1 编解码、Mock 和服务端协议保持可复用。

## Vidu 延迟展示的明确例外

- Gateway 回执全部来自 `source-playback.mjs`，是原始 PCM 时间线状态；不代表 Vidu 媒体排空。
- `audio.append` 转交源 PCM；`audio.end` 仅封口本轮输入，无逐轮媒体停止。
- `turn.cancel` 只拒绝后续旧输入，不发送 Vidu interrupt。正常结束与新回复也不发送 interrupt。
- 无在线匹配、无估算时间、无远端音频等待；持续 RTC 媒体不因源回合而摘轨或静音。
- 结束会话才挂断。展示创建、断线或播放错误只处理展示资源，不能取消源播放器或模型。

该范围与原审查的实际 RTC 回执和立即媒体取消契约不同，需要维护者确认。
详见 [Vidu 指南](vidu.zh.md)及 [PR 说明](pr-description.zh.md)。
