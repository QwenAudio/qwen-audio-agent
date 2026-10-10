# Vidu 数字人示例

[English](README.md)

独立的桌面浮窗与浏览器数字人客户端：现有 Qwen Audio Agent Gateway 负责语音、对话和已配置的后端/工具，Vidu S2 Avatar **组件版**负责数字人渲染，通过阿里云 ARTC 返回音视频。麦克风只发给 Gateway，不向 ARTC 发布麦克风或摄像头。

所有新增代码、依赖和启动脚本均在本目录，无需修改 Gateway、Provider、桌面或依赖 `3d-model`。从源码仓库运行，复用现有 Gateway SDK 与 web 音频工具。

## 启动

1. 在仓库根目录执行 `npm ci`，按标准流程配置实时语音 Provider 和后端。示例优先发现悬浮球正在使用的 Gateway；没有时沿用相同配置/状态目录启动 Gateway。也可单独执行 `npm start` 并通过 `VIDU_GATEWAY_ORIGIN` 指定该地址。
2. 在另一终端从仓库根目录执行：

   ```sh
   cd example/digital-human-vidu
   npm ci
   cp .env.example .env.local
   # 编辑 .env.local，填入 Vidu API Key 和 ARTC AppID/AppKey。
   npm run desktop:vidu
   ```

3. 屏幕右下角出现可拖动、置顶的 Vidu 浮窗，点击 ⚙，填写单人物图片 URL 或上传 PNG/JPEG/WebP 图片（最多 4 MB）。点击“开始对话”，允许麦克风后直接说话；文字聊天请打开 `http://127.0.0.1:5181` 的浏览器页面。关闭程序前先点击“结束对话”，再按 Ctrl-C。

## 与悬浮球的关系和 UI 选择

在本目录执行 `npm run desktop:vidu`（或 `npm run desktop`）启动 Vidu 桌面浮窗；执行 `npm run desktop:orb` 启动原悬浮球。执行 `npm run dev` 启动浏览器版，打开 `http://127.0.0.1:5181`。Vidu 浮窗设置中提供“切换到悬浮球”：先结束数字人会话并清理自己拥有的运行进程，再打开原悬浮球。

两套 UI 共用 Gateway 配置、语音模型、后端/工具和持久状态，但窗口偏好与对话会话独立。Vidu 是另一套桌面宿主，不是悬浮球皮肤，也不会替换原桌面。一次只使用一套 UI 采集麦克风：开始数字人对话前，先结束/退出悬浮球对话。Vidu 不实现悬浮球的唤醒词和自动隐藏。语音/工具配置仍在原悬浮球设置中修改，修改后重启 Vidu 运行服务加载。本 PR 不修改原设置页面来增加选择器。

如果 Gateway 已在运行，Vidu 只借用，退出不会关闭它；如果没有匹配的桌面 Gateway lease，Vidu 通过已有进程管理器启动并在退出时停止自己拥有的 Gateway。若浏览器版服务已运行，浮窗附着到该服务，退出也不会关闭浏览器版服务。

可通过 `VIDU_GATEWAY_ORIGIN` 显式指定其他本机 HTTP Gateway 地址。示例使用 5181/5182 端口，浏览器必须使用上述 `127.0.0.1:5181` 地址。`VIDU_HOST` 支持 `api.vidu.cn` 和 `api.vidu.com`。密钥只从环境变量或 `.env.local` 读取，不打包到浏览器；ARTC 应用需启用 Token 鉴权。

**开始对话会初始化 Vidu 直播，可能产生 Vidu/ARTC 费用。**每次启动创建新的 Gateway 对话 ID 和 RTC 频道。Gateway 断开、初始化超时、直播挂断和 Ctrl-C 都会关闭控制连接。尚未连接的本地会话句柄一分钟后过期，已连接会话最长两小时，在 RTC 凭证过期前结束；本示例不提供 Token 续期或远程部署。

## 与原 Vidu 实现的差异

- 保留语音/文字输入、助手音频及最终回复文本转发、打断、图片选择、远端音视频订阅和诊断。
- 使用最新上游已有的 Gateway Client SDK，不需要原实现对核心框架、根依赖、桌面设置及 `3d-model` 的修改。
- 独立 `package.json` 和锁文件；Gateway 优先复用，也可沿用共享配置自启。保留 Electron 浮窗与原悬浮球启动选项，未迁入 Vidu 自带对话的实时版 demo、纯文本转发模式及动作/表情控制。
- 本地服务保存 Vidu Key、ARTC AppKey 和 Vidu client secret；浏览器仅获取短期 RTC Token 和随机控制句柄。增加来源校验、图片大小限制、音频拥塞处理、取消/超时/退出清理。

## 音频与工具边界

助手音频转换为单声道 24 kHz、16-bit little-endian PCM，以二进制帧发给 Vidu。最终助手回复使用 type 10（`output_transcription`），打断重置重采样器并发送 type 7，挂断发送 type 5。初始化返回 `NOT_READY` 时在同一 WebSocket 重试。文本是辅助信令，不是 Vidu TTS；Gateway Provider 必须输出助手 PCM 才能让数字人说话。

可听声音只来自 ARTC。静音的本地 PCM 时钟用于估算 Gateway 播放开始/结束回执，**不代表远端渲染或播放的实际时刻**，不保证帧级同步。浏览器阻止声音自动播放时，请允许站点播放声音并重新启动。设置中可查看远端音轨和订阅诊断。

工具仍在 Gateway 执行。本页面不注册浏览器工具，也不实现完整任务/审批控制台；权限确认与补充输入请在标准 Gateway WebUI 处理，收到请求时示例会显示提示。

## 验证

在本目录执行 `npm test` 和 `npm run build`。测试使用模拟 HTTP/WebSocket 服务覆盖 RTC 签名、密钥隔离、音频/文本/打断/挂断信令、初始化重试和超时、来源校验、图片限制、取消、过期和关闭清理。构建只验证浏览器导入；产物不能直接作为独立站点部署，仍需 Gateway/API/WebSocket 代理。

模拟测试不能证明真实 ARTC 数字人有声。真实验收步骤：开始一次对话，确认画面与有声回复，回复中打断，调用已配置工具，结束后重新开始确认新对话，再检查 Vidu 控制台直播已结束。

参考：[Vidu 组件版协议](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters)、[ARTC Token 鉴权](https://help.aliyun.com/en/ims/developer-reference/token-based-authentication)。页面从官方 CDN 加载固定版本 ARTC Web SDK 7.1.9，不在仓库复制该 SDK；使用时需要联网。
