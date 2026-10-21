# Vidu 数字人示例

[English](README.md)

[返回数字人方案总览](../README_ZH.md) · [架构对比与整合说明](../docs/integration-architecture.zh.md)

独立的桌面浮窗与浏览器数字人客户端：现有 Qwen Audio Agent Gateway 负责语音、对话和已配置的后端/工具，Vidu S2 Avatar **组件版**负责数字人渲染，通过阿里云 ARTC 返回音视频。麦克风只发给 Gateway，不向 ARTC 发布麦克风或摄像头。

从源码仓库运行本示例。本目录包含独立的依赖配置和启动脚本，客户端复用仓库中的 Gateway SDK 与 web 音频工具。

## 演示视频

<video src="../assets/digital_human_demo_vidu.mp4" controls width="100%"></video>

[观看或下载演示视频](../assets/digital_human_demo_vidu.mp4)

## API 申请与配置

### 申请 Vidu API Key

1. 打开 [Vidu 国内 API 平台](https://platform.vidu.cn/)，点击“开始接入”并注册/登录。
2. 在“API Key 管理”中创建密钥，复制完整的 `vda_...` 值，填入下文的 `VIDU_API_KEY`。账户充值入口用于购买调用额度，具体申请与充值操作见 [Vidu API 快速开始](https://platform.vidu.cn/docs/quick-start)及[常见问题](https://platform.vidu.cn/docs/overview/faq)。
3. 确认账户可使用 S2 Avatar 组件版且额度足够；若接口提示权限不足，向 Vidu 平台确认该服务的开通情况。

API Key 与调用环境必须匹配，按申请密钥的平台选择 `VIDU_HOST`：

| 申请入口 | `VIDU_HOST` |
| --- | --- |
| [国内平台](https://platform.vidu.cn/) | `api.vidu.cn`（默认） |
| [海外平台](https://platform.vidu.com/) | `api.vidu.com` |

官方 [S2 Avatar 实时版快速开始](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/realtime/quick-start)介绍实时版接入和环境选择。本示例使用[组件版协议](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/parameters)，调用 `/live/s_avatar/component`，由 Gateway 提供助手音频，并使用自己的 ARTC 应用；本示例的安装与启动命令见下文。

### 获取 ARTC AppID / AppKey

1. 注册并实名认证阿里云账号，按[创建实时音视频应用](https://help.aliyun.com/zh/live/activate-application)开通视频直播服务。
2. 在[视频直播控制台](https://live.console.aliyun.com/)进入“直播+ → 实时音视频 → 应用管理”，创建服务类型为“实时音视频”的应用。
3. 打开该应用的“管理 → 基本信息”，复制同一应用的 AppID 和 AppKey，分别填入 `ARTC_APP_ID` 与 `ARTC_APP_KEY`。这两项是应用开发参数，与阿里云账号的 AccessKey ID/Secret 不同。

使用 [ARTC Token 鉴权](https://help.aliyun.com/zh/live/token-based-authentication)。本示例的本地服务端会根据 AppID/AppKey 自动生成频道、用户 ID 和短期 Token；无需手动填写 RTC Token。AppKey 保留在服务端，浏览器仅接收入会凭证。

### 配置本地环境文件

首次配置时，在 `examples/digital-human/vidu` 目录复制模板；已有 `.env.local` 时直接编辑现有文件：

```sh
cp .env.example .env.local
```

将 `.env.local` 中的占位值替换为自己的凭证：

```dotenv
VIDU_API_KEY=vda_your_vidu_api_key
ARTC_APP_ID=your_artc_app_id
ARTC_APP_KEY=your_artc_app_key
VIDU_HOST=api.vidu.cn

# 可选：连接已经启动的本机 Gateway
# VIDU_GATEWAY_ORIGIN=http://127.0.0.1:3101
```

`VIDU_API_KEY` 直接填写 `vda_...`，本地服务自动添加 HTTP 的 `Token` 前缀。三个凭证均为必填；Vidu Key 用于创建数字人直播，ARTC 参数用于接收音视频，语音模型与工具另按下文 Gateway 快速开始配置。`.env.local` 已被 Git 忽略，不要将凭证改写到客户端代码中。

`npm run desktop:vidu` 和 `npm run dev` 会读取本目录的 `.env.local`；终端中已设置的同名环境变量优先。修改后退出并重新启动示例，桌面版需重启整个浮窗程序；附着到已运行浏览器服务时，也需重启该服务。

### 检查配置与常见问题

启动后，在终端检查本地配置状态：

```sh
curl http://127.0.0.1:5181/vidu/api/config
```

返回的 `configured: true` 只表示三项配置已填写且 Key 格式符合要求，不代表 Vidu 权限、额度或 ARTC 凭证已经验证。点击“开始对话”后，再确认数字人画面与有声回复。

| 现象 | 检查方式 |
| --- | --- |
| 提示需要配置 Vidu Key，或 `configured: false` | 检查本目录 `.env.local` 的三项凭证、`vda_` 前缀及终端同名变量；重启运行服务。 |
| Vidu 返回 401 / 403 | 检查 Key 是否有效、是否属于当前 `VIDU_HOST` 环境，并确认组件版权限和账户额度。 |
| ARTC 入会或 Token 鉴权失败 | 确认 AppID/AppKey 来自同一已启用应用且复制完整，检查系统时间，结束后重新开始以生成新 Token。 |
| ARTC SDK 加载失败 | 检查能否访问官方 SDK CDN；页面需要联网。 |
| 有画面但听不到回复 | 确认 Gateway 语音 Provider 输出助手 PCM、浏览器允许声音播放，并查看设置中的远端音轨诊断。 |

## 启动

在仓库根目录执行 `npm ci`，按照[快速开始](../../../docs/getting-started/quickstart.zh.md)配置实时语音 Provider 和后端。示例优先发现悬浮球正在使用的 Gateway；没有时沿用相同配置/状态目录启动 Gateway。也可单独执行 `npm start` 并通过 `VIDU_GATEWAY_ORIGIN` 指定该地址。

在另一终端从仓库根目录执行：

```sh
cd examples/digital-human/vidu
npm ci
# 按上文“API 申请与配置”准备 .env.local。
npm run desktop:vidu
```

屏幕右下角出现置顶的 Vidu 浮窗，可拖动顶部空白处或画面中部移动窗口；设置打开时仍可拖动顶部。点击 ⚙，可以直接使用预填的默认示例图片，也可填写单人物图片 URL 或上传 PNG/JPEG/WebP 图片（最多 4 MB，上传文件优先；URL 留空时使用默认图片）。点击“开始对话”，允许麦克风后直接说话；文字聊天请打开 `http://127.0.0.1:5181` 的浏览器页面。关闭程序前先点击“结束对话”，再按 Ctrl-C。

## 与悬浮球的关系和 UI 选择

在本目录执行 `npm run desktop:vidu`（或 `npm run desktop`）启动 Vidu 桌面浮窗；执行 `npm run desktop:orb` 启动原悬浮球。执行 `npm run dev` 启动浏览器版，打开 `http://127.0.0.1:5181`。Vidu 浮窗设置中提供“切换到悬浮球”：先结束数字人会话并清理自己拥有的运行进程，再打开原悬浮球。

两套 UI 共用 Gateway 配置、语音模型、后端/工具和持久状态，但窗口偏好与对话会话独立。一次只使用一套 UI 采集麦克风：开始数字人对话前，先结束/退出悬浮球对话。唤醒词和自动隐藏功能由原悬浮球提供。语音/工具配置仍在原悬浮球设置中修改，修改后重启 Vidu 运行服务加载。

如果 Gateway 已在运行，Vidu 只借用，退出不会关闭它；如果没有匹配的桌面 Gateway lease，Vidu 通过已有进程管理器启动并在退出时停止自己拥有的 Gateway。若浏览器版服务已运行，浮窗附着到该服务，退出也不会关闭浏览器版服务。

可通过 `VIDU_GATEWAY_ORIGIN` 显式指定其他本机 HTTP Gateway 地址。示例使用 5181/5182 端口，浏览器必须使用上述 `127.0.0.1:5181` 地址。`VIDU_HOST` 支持 `api.vidu.cn` 和 `api.vidu.com`。密钥只从环境变量或 `.env.local` 读取。Vidu API Key、ARTC AppKey 和 Vidu client secret 保存在本地服务端，浏览器仅获取短期 RTC Token 和随机控制句柄。ARTC 应用需启用 Token 鉴权。

**开始对话会初始化 Vidu 直播，可能产生 Vidu/ARTC 费用。**每次启动创建新的 Gateway 对话 ID 和 RTC 频道。Gateway 断开、初始化超时、直播挂断和 Ctrl-C 都会关闭控制连接。尚未连接的本地会话句柄一分钟后过期，已连接会话最长两小时，在 RTC 凭证过期前结束；本示例不提供 Token 续期或远程部署。

## 音频与工具边界

助手音频转换为单声道 24 kHz、16-bit little-endian PCM，以二进制帧发给 Vidu。最终助手回复使用 type 10（`output_transcription`），打断重置重采样器并发送 type 7，挂断发送 type 5。初始化返回 `NOT_READY` 时在同一 WebSocket 重试。文本是辅助信令，不是 Vidu TTS；Gateway Provider 必须输出助手 PCM 才能让数字人说话。

可听声音只来自 ARTC。静音的本地 PCM 时钟用于估算 Gateway 播放开始/结束回执，**不代表远端渲染或播放的实际时刻**，不保证帧级同步。浏览器阻止声音自动播放时，请允许站点播放声音并重新启动。设置中可查看远端音轨和订阅诊断。

工具仍在 Gateway 执行。本页面不注册浏览器工具，也不实现完整任务/审批控制台；权限确认与补充输入请在标准 Gateway WebUI 处理，收到请求时示例会显示提示。

## 验证

在本目录执行 `npm test` 和 `npm run build`。测试使用模拟 HTTP/WebSocket 服务覆盖 RTC 签名、密钥隔离、音频/文本/打断/挂断信令、初始化重试和超时、来源校验、图片限制、取消、过期和关闭清理。构建只验证浏览器导入；产物不能直接作为独立站点部署，仍需 Gateway/API/WebSocket 代理。

模拟测试不能证明真实 ARTC 数字人有声。真实验收步骤：开始一次对话，确认画面与有声回复，回复中打断，调用已配置工具，结束后重新开始确认新对话，再检查 Vidu 控制台直播已结束。

参考：[Vidu 组件版协议](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters)、[ARTC Token 鉴权](https://help.aliyun.com/en/ims/developer-reference/token-based-authentication)。页面从官方 CDN 加载固定版本 ARTC Web SDK 7.1.9，不在仓库复制该 SDK；使用时需要联网。
