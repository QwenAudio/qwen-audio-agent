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

浏览器播放器可以是 WebAudio + canvas，也可以是厂商 RTC `<video>`。商业适配器不能用另一条静音 PCM 轨的播放时钟代替真正的 RTC 播放。

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

## #570 商业实现如何迁入

| 原实现责任 | 在此示例的位置 |
| --- | --- |
| 商业组件鉴权、创建 / 关闭、音频提交 | 新的 server/renderers/vidu.mjs |
| ARTC 入会、音视频订阅、SDK 清理 | 新的 client/renderers/vidu.mjs |
| 原 GatewayClient 对话连接 | 复用 useDualConnection，无须再实现 |
| 静音音轨模拟播放回执 | 移除；改由实际 RTC 播放生命周期驱动 |
| 旧响应 / 旧媒体回调 | 映射 responseId / generation 并在打断后隔离 |

如果厂商只提供“生成结束”而不提供可验证的播放边界，适配器必须补足媒体队列 / 播放观测，或明确声明不支持准确播完回执。不能把生成结束当作播放结束。

DHAV 实现和非 DHAV 测试替身继续保留。Vidu 已按上表迁入示例内的服务端/浏览器注册点，
但公开 API 缺少可验证的逐回复播完信号；默认关闭的实验预览不发送 `playback.ended`，
不能视为完成本契约的商业实现。配置、取消隔离和剩余阻塞见 [Vidu 指南](vidu.zh.md)。
尚未执行真实 Vidu/ARTC 部署验收。
