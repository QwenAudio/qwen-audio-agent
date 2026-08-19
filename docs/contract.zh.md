# Gateway 契约

本文件是外部客户端（桌面版、CLI、WebUI，或集成 qwen-audio-agent 的平台方）
可以依赖的**唯一契约索引**。未在此列出的一切（内部模块路径、配置目录内除下文
点名之外的文件布局、数据库与状态文件格式）都不属于契约，可能在任意版本变更。

本文件中的每一条承诺都有测试锁定；各节表格中注明了对应测试。

## 协议版本与能力位

`GET /api/health` 返回 `protocolVersion` 与 `capabilities`。客户端应按能力位
分支，而不是比较产品版本号——旧版 Gateway 会降级而不是报错。

版本号遵循 SemVer：新增能力升 minor；下文点名的任一端点或事件发生破坏性
变更升 major。

当前版本为 `2.1.0`，在 `2.0.0` 上新增默认关闭的 composer 听写事件与能力。
`2.0.0` 接替 `feat/embedded-gateway-host-contract` 分支的 `1.x`
版本线（止于 `1.7.0`）：升 major 记录的事实是——那条线宣告过的部分能力位
（如 `gateway.embedded-lifecycle`、`desktop.settings-window`）不在本契约中。
从该分支迁移的宿主应重新核对下方能力位表，而不是假设旧清单仍然成立。

| 能力位 | 含义 | 锁定测试 |
| --- | --- | --- |
| `web.same-origin-ui` | Gateway 在自己的 origin 上静态托管 Web UI，webview 指向 Gateway 地址即可，无需额外配置 | `test/consumer-install.test.mjs` |
| `web.skin-assets` | 导入的悬浮球皮肤在 Gateway origin 的 `/skins/<id>/` 下提供，悬浮球页面的同源素材请求无需宿主另起静态服务 | `test/consumer-install.test.mjs` |
| `gateway.instance-lease` | 配置目录中的租约标识运行中的实例；`/api/health` 回显 `gatewayInstanceId`，同端口的陌生进程不会被误认为本 Gateway | `test/consumer-install.test.mjs` |
| `gateway.setup-gate` | 未配置的启动以 `QWAUDIO_GATEWAY_SETUP_REQUIRED` 拒绝并附带 `missing` 清单，而不是运行一个语音不可用的实例 | `test/gateway-setup.test.mjs` |
| `gateway.settings-store` | 配置持久化由本包自持：`createSettingsStore({ configDir })`——宿主不认识任何配置项、不持有任何配置文件 | `desktop/test/settings-store.test.mjs` |
| `host.electron-entry` | `qwen-audio-agent/electron`：Electron 主进程可直接 `require` 的 CommonJS 入口，一次 `load()` 拿到全部契约 | `test/consumer-install.test.mjs` |
| `host.gateway-process` | `GatewayProcess` 随包发布：fork、端口回退、就绪握手、重启、计划退出与崩溃分离——桌面版跑的是同一份实现 | `desktop/test/gateway-process.test.mjs` |
| `input.suspend-protocol` | `POST /api/input/suspend\|resume`、`GET /api/input`；Gateway 通过 `input.suspend` / `input.resume` 把抢占传达给客户端 | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-clears-playback` | 抢占同时清除播报，宿主录音不会录进 Gateway 自己的语音 | `server/test/input-suspend-protocol.test.mjs` |
| `input.suspend-ttl` | 持有者不主动释放时抢占自行过期 | `server/test/input-arbitration.test.mjs` |
| `input.suspend-ack` | 客户端以 `input.suspend.ack` 确认抢占生效（仅用于状态展示——不要等待它） | `server/test/input-suspend-protocol.test.mjs` |
| `desktop.orb-shell` | 悬浮球形态的主进程契约随包发布：`bindOrbShell` 应答随包 preload 发出的全部通道 | `desktop/test/orb-shell.test.mjs` |
| `desktop.orb-window-factory` | `createOrbWindow` 持有悬浮球窗口配方；其 `destroy()` 是宿主的同步销毁路径（渲染进程退出才能确定性释放麦克风） | `desktop/test/orb-window.test.mjs` |
| `desktop.orb-placement` | `createOrbPlacement` 覆盖默认锚点、显示器夹取与拖放持久化 | `desktop/test/orb-placement.test.mjs` |
| `desktop.orb-position-store` | 悬浮球位置由本包记忆（settings store 的 ui-state） | `desktop/test/settings-store.test.mjs` |
| `desktop.skin-store` | 皮肤的导入、列表、删除与生效决策是发布的库接口 | `desktop/test/skin-store.test.mjs` |
| `dictation.session-v1` | 默认关闭、限存活进程的听写会话把 composer 音频送到独立 ASR，并提供可见生命周期状态 | `server/test/dictation-session.test.mjs` |
| `dictation.draft-ops-v1` | 草稿修改基于客户端权威快照和 revision 守卫的插入、替换、删除、改写操作 | `test/dictation-protocol.test.mjs` |
| `dictation.commit-idempotency-v1` | 存活客户端会话按 `commitId` 去重，并至多一次调用现有 composer 提交路径 | `server/test/dictation-session.test.mjs`、`web/test/dictation-client.test.mjs`、`tui/test/dictation.test.mjs` |

能力位清单本体是 `server/src/core/gateway-protocol.mjs` 的
`GATEWAY_CAPABILITIES`；`test/gateway-contract.test.mjs` 会在能力位与本文档
不一致时失败。

## 包入口（package exports）

只有下列子路径属于契约；按内部路径引用不受支持，随时会断。

| 入口 | 导出 |
| --- | --- |
| `qwen-audio-agent/electron` | **CJS**：`load()`（一个命名空间拿到全部契约）、`PRELOAD_PATH` |
| `qwen-audio-agent/gateway-protocol` | `GATEWAY_PROTOCOL_VERSION`、`GATEWAY_CAPABILITIES` |
| `qwen-audio-agent/gateway-setup` | `gatewaySetupStatus`、`assertGatewaySetup` |
| `qwen-audio-agent/gateway-process` | `GatewayProcess`、`createGatewayProcess`、`GATEWAY_READY_MESSAGE`、`DEFAULT_GATEWAY_ENTRY`、`validateGatewayOrigin`、`portInUse` |
| `qwen-audio-agent/gateway-lease` | `readGatewayLease`、`findRunningGateway`、`acquireGatewayLease` |
| `qwen-audio-agent/realtime-events` | `GatewayClientEvent`、`GatewayServerEvent`、`GatewayTaskEvent` |
| `qwen-audio-agent/settings` | `createSettingsStore` |
| `qwen-audio-agent/skin-store` | `importSkin`、`listSkins`、`removeSkin`、`effectiveOrbSkin`、`skinsDirectory`、`validateSkinPackage` |
| `qwen-audio-agent/orb/main` | `bindOrbShell`、`configureOrbWindow`、`ORB_CHANNELS` |
| `qwen-audio-agent/orb/window` | `createOrbWindow`、`orbWindowOptions`、`ORB_PRELOAD_PATH`、`ORB_WINDOW_SIZE` |
| `qwen-audio-agent/orb/placement` | `createOrbPlacement`、`ORB_PLACEMENT_MARGIN` |
| `qwen-audio-agent/orb/presence` | `DesktopPresence` |
| `qwen-audio-agent/orb/preload` | 悬浮球与设置页共用的渲染进程 preload |
| `qwen-audio-agent/orb/url` | `desktopOrbUrl` |
| `qwen-audio-agent/web-dist/*` | 预构建的前端产物 |

除 `qwen-audio-agent/electron` 与 `qwen-audio-agent/orb/preload` 为
CommonJS（边界所需）外，其余均为 ESM。

## 嵌入流程

```js
const audioAgent = require('qwen-audio-agent/electron')
const api = await audioAgent.load()

const settings = api.createSettingsStore({ configDir })
if (!settings.ready()) { /* 展示 settings.status().missing，settings.save(...) */ }

const gateway = api.createGatewayProcess({ configDir, wakeWord: false })
const origin = await gateway.start()

const placement = api.createOrbPlacement({
  getDisplays: () => screen.getAllDisplays(),
  orbSize: api.ORB_WINDOW_SIZE,
  loadState: () => settings.orbPosition.load(),
  saveState: state => settings.orbPosition.save(state),
})
const orb = await api.createOrbWindow({
  pageUrl: () => api.desktopOrbUrl(origin, { orbSkin: settings.load().orbSkin }),
  placement,
  partition: 'persist:my-host',
})
const presence = new api.DesktopPresence({ getWindow: () => orb.window() })
const shell = api.bindOrbShell({
  ipc: ipcMain,
  getWindow: () => orb.window(),
  presence,
  onDragEnd: () => {
    const [x, y] = orb.window().getPosition()
    placement.recordPosition({ x, y })
  },
  onQuit: () => stopPlugin(),
})

// 导入皮肤并生效：
api.importSkin({ source, skinsRoot: api.skinsDirectory(configDir) })
settings.save({ orbSkin: 'firefly--lingxiaotian' })
await orb.load()
```

## HTTP 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 存活、能力探测与运行状态；含 `protocolVersion`、`capabilities`、`gatewayInstanceId`、`voiceConfigured`、`inputSuspension`、`voiceClients`、`backend` |
| `POST /api/input/suspend` | 抢占麦克风：`{ owner, reason?, ttlMs? }`，默认 15 秒，上限 300 秒 |
| `POST /api/input/resume` | 释放抢占：`{ owner }` |
| `GET /api/input` | 当前抢占状态 |

麦克风抢占的语义要点：**不要等回执**（按键到录音是延迟敏感路径，直接发送并
立即开始录音）；按 owner 幂等，重复宣告只刷新截止时间；多 owner 引用计数；
每个抢占都会过期，持有方崩溃或漏发 `resume` 也会自动恢复。

未在此列出的接口（`/api/tasks`、`/api/timeline`、`/api/backend/ui`、
`/api/permissions/:id`，以及 `WS /api/realtime` 中除下文事件之外的负载）
是我们自己前端在用的，不承诺稳定。

## Realtime 事件

事件名以常量形式发布在 `shared/realtime-events.mjs`；自行拼写字符串的客户端
后果自负。

| 方向 | 事件 | 含义 |
| --- | --- | --- |
| 服务端 → 客户端 | `input.suspend` | 立即停止采集（比用户级静音更强：不采集、不做唤醒词检测）；携带 `owner`、`reason`、`expiresAt` |
| 服务端 → 客户端 | `input.resume` | 可以恢复采集 |
| 客户端 → 服务端 | `input.suspend.ack` | 确认抢占已在本客户端生效 |
| 客户端 → 服务端 | `dictation.start`、`dictation.pause`、`dictation.resume`、`dictation.cancel`、`dictation.stop` | 控制一个可见、显式启用的 composer 听写会话 |
| 客户端 → 服务端 | `dictation.audio.append` | 仅向独立 ASR 会话流式发送 Base64 PCM16 音频 |
| 客户端 → 服务端 | `dictation.context`、`dictation.operation.ack`、`dictation.commit.ack` | 交换一次性 revision 草稿快照并确认草稿/提交结果 |
| 服务端 → 客户端 | `dictation.state`、`dictation.transcript.delta`、`dictation.transcript.final` | 展示听写状态和不会提交的 ASR 预览 |
| 服务端 → 客户端 | `dictation.context.request`、`dictation.operation` | 请求一次客户端权威草稿快照并返回 revision 守卫操作 |
| 服务端 → 客户端 | `dictation.commit.request` | 要求客户端针对唯一的会话内 `commitId` 调用一次普通 composer 提交 |
| 服务端 → 客户端 | `dictation.error` | 展示 ASR/协议失败，绝不回退主 Realtime 前台 |

听写事件带每方向单调递增的 `seq` 与 `sessionId`。操作带
`operationId`/`baseRevision`，提交带 `commitId`/`revision`/`payloadHash`。
运行时关闭时 `/api/health` 不广告听写能力。音频、预览、未提交或已取消文本、
草稿快照均不是 conversation turn，也不会持久化。提交去重明确只保证存活进程与
会话，不承诺跨崩溃的 exactly-once。`stopped` 是 live transcriber 的终态，
必须重新发送 `dictation.start`。`paused`、`stopped`、`cancelled`、`error`
会拒绝迟到的 context、operation、commit；所有采音状态都有有界超时。

## 实例租约

运行中的 Gateway 在其配置目录写入 `gateway.lock`：
`{ schema: "qwaudio.gateway-lock/v1", instanceId, pid, owner, state, origin,
startedAt, heartbeatAt }`。定位实例的方式：读租约、探活 `origin`、并核对
`/api/health` 回显的 `gatewayInstanceId` 是否一致——端口被其他进程复用时
读到的是"未运行"，而不是别人的状态。干净退出会释放租约。锁定测试：
`test/consumer-install.test.mjs`、`test/gateway-instance-lock.test.mjs`。

## 启动门禁（setup gate）

缺少必填的实时语音凭据（`DASHSCOPE_API_KEY`，或选择 Speech-to-Speech 时的
服务地址）时，`server/src/index.mjs` 在触碰租约之前即拒绝启动：进程以非零
退出，错误信息点名每一个缺失的键。`QWEN_AUDIO_ALLOW_UNCONFIGURED=1` 供
从不建立语音连接的调试场景显式跳过。锁定测试：`test/gateway-setup.test.mjs`、
`test/consumer-install.test.mjs`。

## 运行时基线

发布代码必须能在 `engines` 范围允许的最老 Node 上运行。CI 在该版本上实跑
测试套件，`test/runtime-baseline.test.mjs` 会在发布代码用到高于基线的 API
时让构建失败。
