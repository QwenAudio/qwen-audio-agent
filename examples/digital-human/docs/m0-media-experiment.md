# M0 媒体实验记录：@roamhq/wrtc 视频下行能力验证

日期：2026-09-20 · 平台：macOS arm64 · Node v24.21.0 · @roamhq/wrtc 0.10.0（经 `packages/webrtc/index.cjs` apiVersion 1 封装）

## 结论（全部通过）

视频下行所需的原生能力在 @roamhq/wrtc 0.10.0 上完整可用，M1b 无阻塞风险。

## 实验 1：RTCVideoSource 存在性与 API

```js
const { rtc } = loadNative() // packages/webrtc/index.cjs
rtc.nonstandard // → i420ToRgba, RTCAudioSink, RTCAudioSource, RTCVideoSink, RTCVideoSource, rgbaToI420
```

- `new rtc.nonstandard.RTCVideoSource()` 可用；实例方法：`createTrack()`、`onFrame(frame)`、`needsDenoising`、`isScreencast`。
- `source.onFrame({ width, height, data })`：`data` 为 I420 平面布局 Buffer（长度 = width*height*3/2），64x64 帧调用成功，无内部时钟——按调用节奏推帧。
- `createTrack()` 返回 `kind: 'video'`、`readyState: 'live'` 的 MediaStreamTrack。

## 实验 2：node↔node 回环（answerer 发视频）

拓扑与生产一致：offerer 只加 `addTransceiver('video', { direction: 'recvonly' })`；answerer（等价于 Gateway media worker）`pc.addTrack(videoSource.createTrack())` 后 createAnswer。

结果：
- answer 中对应 m-line 方向正确翻转为 `a=sendonly`（recvonly offer → sendonly answer），不会因无本地采集源被置 inactive。
- 以 40ms 间隔推 64x64 I420 帧，4 秒内 `outbound-rtp framesEncoded: 97` / `inbound-rtp framesDecoded: 97`，接收端 `RTCVideoSink` 收到 97 帧——零丢失。
- 帧率完全由 `onFrame` 调用节奏决定（无内部 pace），连接建立后随时可开始推帧。

**关键 API 陷阱**：接收端回调是小写 `sink.onframe = ({ frame }) => ...`（与 `server/src/transport/webrtc/media.mjs:145` 现有视频输入代码一致），写成 `onFrame` 会静默收不到帧。

## 实验 3：双 video m-line（video_input sendonly + video_output recvonly 并存）

offer 同时含 audio(sendrecv) + video(sendonly, 摄像头输入) + video(recvonly, 数字人输出)。answerer 侧 `addTrack(RTCAudioSource track)` + `addTrack(RTCVideoSource track)`：

```
answer m=audio → a=sendrecv
answer m=video#1 → a=recvonly   （摄像头输入，answerer 收）
answer m=video#2 → a=sendonly   （数字人输出，answerer 发）
```

- node-webrtc 按方向兼容性正确关联 addTrack 与 m-line：唯一的 video 输出 track 自动落到 recvonly 段，无需控制 addTrack 顺序或 m-line 索引。
- 推 avatar 帧后仅 offerer 侧输出 sink 收到（73 帧），answerer 的输入 sink 为 0——两条 video 通道互不串扰。

因此原计划中"首版 avatar 模式不与 video_input 同时启用"的缓解措施**不再必要**，但 M1b 演示仍使用 Audio 模型（无 video_input），双通道并存留给 x-omni + 数字人组合场景。

## 对实现的直接影响

1. `media.mjs`：`videoOutput` 时 `new RTCVideoSource()` → `createTrack()` → `pc.addTrack()`，必须在 `answer()` 前完成；avatar 帧经 `onFrame({width, height, data: I420 Buffer})` 直推，由音频主时钟（10ms pump 累计样本数）驱动弹帧。
2. `routes.mjs` `validateOffer`：按 m-section 解析 `a=sendonly|recvonly|sendrecv` 方向；recvonly video 段要求 avatar 模式，sendonly video 段要求模型 video 输入能力。
3. `webrtc-browser.mjs`：avatar 模式 `addTransceiver('video', { direction: 'recvonly' })`；`ontrack` 对 video track 挂 `<video>.srcObject`。
4. 帧尺寸必须为偶数宽高、I420 长度严格等于 `w*h*3/2`；Mock renderer 使用 256x256。

## 复现方式

实验脚本为一次性脚本（`/tmp/dh-m0/loopback2.mjs`、`dual-video.mjs`），核心断言已固化进后续测试：
- 步 5 的 server 侧单测（fake mediaFactory 断言 dh IPC 与 SDP 协商）；
- 步 7 的 `browser-smoke.mjs`（Playwright 真实浏览器收帧计数）。
