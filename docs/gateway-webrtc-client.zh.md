# WebRTC 客户端接入预览版

状态：实验性 0.1。只扩展客户端到 Gateway 的传输，不包含数字人。

```text
客户端 -- WebRTC Track / DataChannel -- Node 媒体子进程 -- IPC -- 现有会话运行时 -- WSS -- 百炼
客户端 -------------------- 原有 WSS ----------- 现有会话运行时 -- WSS -- 百炼
```

网关仍然负责身份、会话历史、工具、前后台协作、内容安全恢复和客户端占用管理。
此接口不是只代理 SDP 后让客户端直连模型。供应商密钥不会交给客户端。
原有 `/api/realtime` WebSocket 接口、消息和默认依赖安装不变。

## 启动

完整演示与安装指导见 [examples/webrtc](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/webrtc/README_ZH.md)。
正式版将使用独立扩展包（尚未发布）：

```sh
npm install -g qwen-audio-agent qwen-audio-agent-webrtc
qwenaudio gateway --webrtc
```

两个包应使用同一个 npm 安装目录。扩展只携带媒体依赖，不会自动开启 WebRTC。
主框架不依赖该扩展；普通 WSS 用户无需安装。

在仓库根目录安装一次可选的媒体依赖（推荐 Node.js 22.22.2）：

```sh
npm run example:webrtc:install
npm run example:webrtc
# 摄像头输入：停止 Audio 后运行 npm run example:webrtc:omni
```

示例命令会为当前进程开启 WebRTC 并选择对应模型，不修改持久配置。
CLI 可用 `qwenaudio gateway --webrtc` 开启同一个入口；先安装依赖并配置 Audio/Omni 模型。
常驻服务使用 `qwenaudio gateway install --webrtc`，之后正常 start/restart。
已有的百炼 Key、Workspace 配置继续使用。也可以不用示例启动脚本，手动测试 Audio：

```sh
QWAUDIO_WEBRTC_ENABLED=1 \
QWEN_AUDIO_REALTIME_PROVIDER=dashscope \
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus \
npm run start --workspace server
```

另一次测试 Omni 时，将模型改成 `qwen3.5-omni-plus-realtime` 并重启。
沿用服务器已有 `DASHSCOPE_API_KEY` 和地域/Workspace 配置，不需要将 Key 写入示例页。
同一个 Gateway 本版使用其当前配置的模型，不支持请求级随意覆盖模型或上游地址。

默认端口下打开：

```text
http://127.0.0.1:3101/api/realtime/webrtc/example
```

示例有麦克风、可选摄像头、文本消息、打断、会话 ID、显式接管和事件日志。
非本机访问需先通过现有网关配对/认证。页面中的访问凭证是 Gateway 凭证，不是百炼 Key。
示例页面及其 JavaScript 本身也受网关认证保护。

关闭开关（默认）时没有 WebRTC 路由，不加载 native addon，也不创建媒体定时器。
原生媒体依赖由 `qwen-audio-agent-webrtc` 管理；源码开发时安装在 `packages/webrtc` 中。
主 npm 包不包含扩展实现、原生依赖或示例中的私有 `.env`。
开启 WebRTC 后两个客户端入口同时存在，不是把 WSS 切换掉；上游连接仍为 WSS。

## API

所有接口沿用现有 HTTP 身份认证和 Origin 检查。`ownerId` 来自认证，不能由请求冒充。
会话历史仍以认证 owner 和 `sessionId` 共同隔离。

### 获取媒体配置

`GET /api/v1/webrtc/config`

返回当前 `model`、`video_input`、浏览器用 `iceServers` 和 `iceTransportPolicy`。
ICE 配置仅对已认证客户端返回，响应禁止缓存。

### SDP 建连

```http
POST /api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-plus&sessionId=my-session
Authorization: Bearer <Gateway access credential>
Content-Type: application/sdp

v=0
...
```

本机/已配对浏览器可使用现有认证，不必显式传 Bearer。

- 成功：`200 application/sdp`，正文为 Answer SDP。
- `Location`：本连接删除地址，不是会话历史 ID。
- 失败：JSON `{"error":{"code":"...","message":"..."}}`。
- Offer 必须含一个音频媒体段、一个 DataChannel 媒体段；Omni 可再含一个视频段。
- `model` 可省略；提供时必须等于网关配置，错误不会静默切换供应商。
- `sessionId` 默认 `main`；支持 1–128 位字母、数字、`_ . : -`。
- `takeover=true` 显式接管已有客户端。默认不挤掉桌面端或 WSS 客户端。
- 可选 `client_actions` 是 JSON 数组（例如 `["xomni.visual.capture"]`），声明客户端实际实现的动作。
  最多 16 个不同名称；运行时仍与宿主注册的能力取交集，不允许客户端注入工具或 Prompt。
- 收集完 ICE 候选后发送 `pc.localDescription.sdp`。本版不支持 trickle ICE、重新协商、ICE restart。

### 结束连接

对 `Location` 发 `DELETE`，成功 `204`。其他 owner 的连接返回 `404`。
客户端关闭 PeerConnection 后服务器也会回收；设备凭证撤销覆盖正在协商的连接。
关闭连接不删除历史。同一 owner 使用相同 `sessionId` 重连，复用现有恢复逻辑。

## 浏览器最小连接方式

```js
const config = await fetch('/api/v1/webrtc/config').then(r => r.json())
const pc = new RTCPeerConnection({ iceServers: config.iceServers })
const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
for (const track of stream.getTracks()) {
  track.enabled = false
  pc.addTrack(track, stream)
}
pc.createDataChannel('oai-events', { ordered: true })
pc.ondatachannel = ({ channel }) => {
  if (channel.label !== 'txt') return
  channel.onmessage = ({ data }) => {
    const event = JSON.parse(data)
    if (event.type === 'session.updated') {
      for (const track of stream.getTracks()) track.enabled = true
    }
    // Handle errors, transcripts, Gateway extensions and playback receipts.
  }
  // The server-created txt channel is bidirectional; send controls here.
}
pc.ontrack = ({ track }) => {
  audioElement.srcObject = new MediaStream([track])
  audioElement.play().catch(showPlaybackButton)
}
await pc.setLocalDescription(await pc.createOffer())
// Wait for pc.iceGatheringState === 'complete'; see the complete example.
const response = await fetch('/api/v1/webrtc/realtime?sessionId=my-session', {
  method: 'POST', headers: { 'Content-Type': 'application/sdp' },
  body: pc.localDescription.sdp,
})
if (!response.ok) throw await response.json()
await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() })
```

完整可运行示例位于 `examples/webrtc/client.mjs`，包含 ICE 超时、关闭和认证处理。

## 与百炼的对应关系与差异

建连方式参考[百炼 Realtime 接入文档](https://help.aliyun.com/zh/model-studio/realtime-connect-model)。
采用原始 SDP、音视频 Track、可靠有序 DataChannel，以及服务端 `txt` 通道。
这是一组熟悉的接入语义，**不是完整的百炼 API 透传**。

| 客户端事件 | 本版行为 |
| --- | --- |
| `session.update` | 支持输出 `voice`；`modalities` 只接受 `["text","audio"]`；VAD 参数只接受与网关配置一致的值 |
| `conversation.item.create` | 支持一个暂存的 user `input_text` 消息，返回 `conversation.item.created` |
| `response.create` | 提交暂存文本并触发现有网关输入流程；不接受 per-response 覆盖 |
| `response.cancel` | 取消当前生成，清除待发送音频；不支持指定某个 response ID |
| 音频 Track | 转换成 Provider 所需 PCM 后调用现有输入路径；不发送 Base64 音频事件 |
| 视频 Track | 最多每秒抽一帧 JPEG，最长边 640，Base64 不超过 256 KiB；进入现有视觉输入路径 |
| 手动音频 commit、客户端 tools/instructions、任意历史注入 | 不支持，返回结构化错误；不允许绕过网关的 Agent 与历史管理 |

服务端提供 `session.created`、`session.updated`、`response.created`、`response.audio.done`、
`response.done`、转录增量/完成事件、`output_audio_buffer.cleared`、`error`。
`response.done` 携带 ID 与供应商完成状态，但不复制百炼完整 output/usage 结构。
网关文本输入的 item ID 与上游 item ID 不保证一致；暂存 item 仅在 `response.create` 时提交历史。
网关投影的用户转录使用相同事件名称，但不保证供应商原始 item ID。
`response.audio_transcript.*` 是网关呈现文本，不承诺其来源一定是原始 TTS 转录。

其他网关事件用 `{"type":"qwaudio.event","event":{...原有网关事件...}}` 包装。
任务、权限、历史等 GCP 控制可用 `qwaudio.command` 的 `event` 字段发送原有受支持命令。
权限、owner 校验与能力协商仍在现有运行时执行，不把命令直接转发给供应商。

客户端动作沿用 GCP：`client.action.request` 放在 `qwaudio.event` 中下发，
`client.action.result` 通过 `qwaudio.command` 回传，保留 `request_event_id`。
`client.event.publish` 也通过同一命令通道发送，不另建 WebSocket 会话。

截图等较大入站 JSON 可使用 `qwaudio.transport.chunk` 分片：
`{type, id, index, total, data}`，其中 `index` 从 0 连续递增，`data` 为 JSON 文本片段。
每片最多 8,192 个 UTF-16 代码单元，单帧最多 64 KiB，重组后最多 512 KiB；
同一连接仅允许一个待重组消息，5 秒超时后丢弃，不接受嵌套分片。
重组后仍走原有消息校验与权限检查。普通小消息不需要分片。
浏览器可复用 `shared/gateway/webrtc-browser.mjs` 和 `webrtc-message.mjs`，
不要直接发送超过 SCTP 单消息限制的图片。

### 播放回执与打断

生成结束、服务器发完 RTP 与客户端真正播放完成是三件不同的事。

- `qwaudio.output.started`：开始向 RTP 输出该响应，不代表客户端已经听到。
- `qwaudio.output.drained`：该响应的服务器发送队列已排空，不代表浏览器抖动缓冲已排空。
- 客户端实际开始播放后发送 `qwaudio.playback.started`，带 `response_id`。
- 客户端实际播完/取消后发送 `qwaudio.playback.ended` / `qwaudio.playback.cancelled`。
- 播放回执用于现有转录呈现、历史落账、任务通知等；服务端不会伪造回执。

预览页根据音频元素播放状态和接收端音量检测估计回执，也提供“确认已听完”按钮。
这是演示策略，不是可用作精确计费或可靠送达证明的逐帧时间同步。
标准浏览器接口无法直接清空远端 RTP 抖动缓冲；打断会清服务器队列并拒绝旧响应后续音频，
网络及客户端缓冲仍可能留下短暂尾音。示例对清除事件做短时静音；严格无尾音仍需后续验证。

## 部署边界

- 本版为 CPU 媒体桥接，无 GPU、无 Python、无房间/SFU 平台。
- 原生依赖为 `@roamhq/wrtc` 和 `sharp`，仅在按需启动的 Node 媒体子进程内加载。每条连接一个进程，不向其传递供应商 Key 或会话历史。不同系统的二进制支持需单独验证。
- 当前原生库在 macOS arm64 的自然退出析构中存在可复现崩溃。媒体子进程先关闭轨道、Sink、连接和定时器，再发送清理确认并显式正常退出；网关等待实际退出。崩溃、超时强制终止不会被计为正常退出，也不会拖垮 WSS。
- 关闭中的子进程仍占连接配额，避免连续建连/关闭绕过资源限制。网关关闭时等待所有媒体子进程回收；父进程断开 IPC 时子进程自行结束。
- 默认最多 4 个连接，协商/接入超时 20 秒，单连接最长 30 分钟，断网宽限 10 秒。
- 媒体输出队列最多 60 秒；慢消费者、错误媒体序列和数据通道拥塞会关闭本 RTC 连接。
- 视频超过 1080p 的解码帧被丢弃；客户端应请求 640×480。编码上限不代替公网资源配额。
- 不自动切回 WSS；失败后由客户端明确选择重试 WebRTC 或新建 WSS。
- 本机浏览器适合先验证；远程部署需 HTTPS、可达媒体端口，以及合适的 STUN/TURN。
- HTTP 反向代理只代理 SDP，**不会自动代理媒体**。只开放 HTTPS 或仅有 HTTP 隧道不够。

可选环境变量：

```sh
QWAUDIO_WEBRTC_ENABLED=1
QWAUDIO_WEBRTC_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"short-lived-user","credential":"short-lived-credential"}]'
QWAUDIO_WEBRTC_ICE_TRANSPORT_POLICY=all
```

当前静态 ICE 配置会分享给已认证客户端，不要使用长期高权限 TURN 凭证。
多实例路由、TURN 动态凭证、限额与弱网长稳测试属于正式开放公网前的工作，不宣称已完成。

## 测试

```sh
node --test server/test/webrtc.test.mjs server/test/webrtc-transport-regressions.test.mjs server/test/webrtc-media-process.test.mjs server/test/gateway-client-handshake.test.mjs server/test/gateway-application.test.mjs
npx playwright install chromium
QWAUDIO_TEST_WEBRTC_NATIVE=1 node --test server/test/webrtc-native.test.mjs
```

默认测试不要求 native addon。原生测试使用 Playwright Chromium 打开实际调试页，
以虚拟麦克风/摄像头发送合成媒体，反复连接并检查转录、历史恢复和媒体进程正常退出，
也会模拟媒体进程崩溃并确认已有 WSS 仍可通信、新 WebRTC 仍可连接。
上游为可控假 Provider，不会调用百炼，不会上传历史或读取供应商 Key。
它能验证传输及网关接线，不能替代真实模型质量、浏览器兼容性或公网稳定性结论。

手工验收：分别以 Audio、Omni 启动，测试多轮语音、文本、打断、断开后同会话恢复、
不同会话隔离、显式接管；Omni 增加摄像头画面问答。最后关闭 WebRTC 开关复测原有 WSS。

## 代码组织

- `routes.mjs`：HTTP SDP、资源配额、身份作用域、连接生命周期。
- `protocol.mjs`：百炼风格事件与现有 GCP/会话连接之间的适配。
- `media.mjs`：原生 PeerConnection、音频 pacing、JPEG 抽帧和背压。
- `media-process.mjs` / `media-worker.mjs`：受控 Node 子进程、有限 IPC 缓冲、退出确认与崩溃隔离。
- `pcm.mjs`：PCM 字节序、流式重采样和声道转换。
- `transport/gateway-client-transport.mjs`：提供内部已认证连接端口；WSS 和 RTC 共用同一业务路径。
- `shared/gateway/webrtc.mjs`：定位已安装扩展，检查 API 版本与依赖；不加载原生库。
- `shared/gateway/webrtc-browser.mjs`：两个示例共用的浏览器连接、轨道管理与播放回执；不含场景工具。
- `shared/gateway/webrtc-message.mjs`：有大小/时限限制的入站分片，不改变 GCP 业务语义。
- `packages/webrtc/`：独立 npm 扩展包，提供延迟加载的媒体依赖，不进入默认 workspace 或主包。
- `examples/webrtc/`：按需安装指导、启动脚本和纯浏览器 Web UI，与网关协议实现分离。
