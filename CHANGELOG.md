# Changelog

## 1.1.1

- 修复空白数值环境变量被误解析为 `0` 并钳制到错误下限的问题，同时保留显式
  `0` 的配置语义。
- 修复协调 Agent 的 Markdown、代码或链接结果无法进入时间线的问题，并避免公共
  任务快照暴露后台 Session、目录及委托标识。
- 修复桌面版内嵌 Gateway 并发启动或重启时可能创建重复进程、被旧进程事件覆盖
  状态的问题。

## 1.1.0

- 新增官方 Kimi Code CLI 后台，使用原生 `kimi acp` 接入共享 ACP Session、权限、
  模型覆盖和第三层任务链路；支持原生登录与 `KIMI_MODEL_*` 临时凭据配置，并将
  Gateway `full` 权限精确映射为 Kimi Auto 模式；保持跨协调轮次的 Session MCP
  连接有效，同时更新每轮任务关联上下文。

## 1.0.0

- 桌面版内置并管理 Gateway：已有配置时直接启动，首次使用时自动创建
  `config.env` 并通过设置页完成 API Key、前台模型和后台 Agent 配置；退出桌面版
  时同步回收 Gateway 及其启动的后台进程。
- 新增桌面端后台切换与运行状态管理：支持仅前台聊天及多种已安装 Agent，配置应用
  后自动重启并持续刷新 Gateway、Realtime 和后台连接状态。
- 重构桌面设置界面：提供完整的 Plus/Flash 前台模型选择、可留空的后台模型覆盖、
  百炼 API Key 获取入口及更清晰的服务状态展示。
- 完善 macOS 打包运行时：将 Gateway、配置模板和启动脚本纳入 DMG，恢复登录 Shell
  的可执行路径，并避免桌面端静默下载未安装的后台 Agent。

## 0.12.1

- 简化实时语音权限确认：前台 Agent 按用户自然表达判断同意或拒绝，不再要求固定
  口令或逐字证据；意图明确后直接提交权限工具调用，并仅在结果返回后播报最终状态。

## 0.12.0

- 新增仅前台 Gateway 模式：后台 Agent 配置改为可选，未配置
  `AGENT_PROTOCOL` 或显式使用 `--backend none` 时仍可正常进行实时语音对话；
  需要后台执行的请求会明确说明当前没有可用的后台 Agent。
- 调整中英文 README 的开篇结构，将演示视频、核心特色和参考架构按实际体验到
  技术实现的顺序重新组织。

## 0.11.0

- 统一后台 Setup：OpenCode 和 OpenClaw 优先使用用户安装，并提供固定 npm 包
  自动下载兜底；配置百炼 API Key 和后台模型后可自动完成模型接入。其他 Agent
  暂时要求用户自行安装配置。新增只读 `qwenaudio setup` 检查及可复用的 JSON 输出。
- 统一 ACP Session 模型覆盖：默认不发送模型设置；显式配置时按标准
  `category: model` 强制设置并验证全部受管 Session，失败时明确报错；新建和
  恢复 Session 的默认模型选择完全交由后台 Agent。后台模型只保留统一配置入口
  `QWEN_AUDIO_AGENT_BACKEND_MODEL`，不再提供各 Agent 专属的模型变量；模型 ID
  和显示名称匹配不区分大小写，并使用后台返回的规范 ID 完成设置，兼容 Qoder
  等使用不透明模型 ID 的 ACP 后端。
- 统一后台进程归属：所有后台实例均由 qwen-audio-agent 启动和回收；OpenClaw
  始终使用独立 Gateway、运行状态和 Session 存储，同时复用用户已有能力配置，
  不再连接或影响用户常驻 Gateway。
- 加强协调 Session 与结果交付：恢复失效时自动建立新的协调 Session，任务完成后
  主动触发语音回复，并避免工具受理确认、最终结果和播放通知互相阻塞或重复。
- 修复 OpenClaw 连续消息或第三层任务完成回传紧邻下一轮请求时，可能触发
  reply Session 初始化竞争的问题；仅在尚未产生回复或工具活动时原 Session 重试。

## 0.10.0

- 新增基于 `@zed-industries/claude-code-acp` 的 Claude Code 后端，支持独立协调
  工作区、原生权限确认、第三层项目 Session 和固定版本回退启动。
- 清理 OpenCode 旧版命名 Agent Prompt，统一由 Gateway 通过 ACP 动态注入协调规则，
  同时保留显式选择用户自定义 OpenCode Agent 的能力。

## 0.9.1

- 修复 Gateway 在任务结果已经开始播报后重启，仍可能重复播报同一条旧消息的问题；
  前端回传 `playback.started` 后即确认通知已送达。
- 修复发布检查仍要求静态 npm 徽章，导致动态徽章触发 CI 失败的问题。

## 0.9.0

- 新增 Hermes、CodeBuddy 和 Codex 后台支持，并将 OpenCode、OpenClaw、Qoder
  与新增 Agent 统一收敛到可插拔 ACP Agent/Runtime 驱动架构。
- 后台 Agent 改为必须由用户显式选择；同时保留通用 ACP stdio 入口，便于接入
  其他支持 ACP 的 Agent。
- 完善 CodeBuddy 公共模型配置同步、Codex ACP 固定版本启动和各后端独立权限模式。
- 修复 GitHub 直接安装缺少 WebUI、遗留 backend 入口绕过统一启动逻辑的问题，
  并扩充 npm 成品内容检查。
- 加强发布安全检查：覆盖完整依赖树、公开 Git 历史、后台启动器固定版本以及
  新增 Agent 的模板与资源。
- 修复非 Realtime WebSocket Upgrade 连接未释放，并统一 ACP/OpenClaw 上报的
  客户端版本。
- 更新中英文 README、架构图、隐私说明与后台配置文档，为首次公开发布
  做准备。

## 0.7.0

- 后台 Agent 接入统一迁移到 ACP，复用同一套会话、权限、任务和结果中转能力，
  同时保留各 Agent 的原生特性与独立适配边界。
- 新增 Qoder 支持，并完善 OpenCode、OpenClaw 的启动、已有会话续接和配置管理。
- 完善三层 Agent 架构：协调 Agent 可以异步新建或继续独立 Session，Gateway
  持久管理委托任务，并在完成后将结果交回协调 Agent 整理和播报。
- 增加后台任务状态查询、取消、忙碌协调 Agent 兜底处理和完成通知，改善 TUI
  与 WebUI 的状态展示、权限确认、回复顺序和重复播报。
- TUI 启动目录会作为当前工作目录传给 Agent，便于直接查看和继续开发当前项目。
- 强化 Realtime 生命周期：增加断线重连退避、响应关联保护、播放回执清理和
  输入静音模式，降低串台、热循环、内存滞留和音频路径阻塞风险。
- 收敛跨端 Gateway 事件定义，拆分 ACP 配置和 Session 解析逻辑，并移除 URL
  中的敏感令牌传递。

## 0.6.0

- TUI 流式 ASR 预览支持按终端宽度多行换行，并在识别结果更新时可靠清除和重绘。
- 修复无效语音轮次残留临时 ASR、断线期间重连提示被未完成回复流阻塞的问题。
- macOS CoreAudio 与 PortAudio 播放链路增加原生队列回执，按实际播放队列排空
  确认开始和结束，不再通过音频字节长度估算。
- Linux 和 Windows 半双工模式改为在录音与播放设备之间真实切换，播报期间不再
  同时占用输入设备；显式全双工模式继续保持输入输出并行。
- 补充播放生命周期、回声转写、断线恢复和跨平台音频桥接回归测试。

## 0.5.0

- 终端客户端收敛到 minimal TUI：macOS 使用 CoreAudio 回声消除全双工并仅支持
  语音打断；Linux 和 Windows 默认使用 PortAudio 半双工和按键手动打断，也可
  明确开启推荐搭配耳机使用的无 AEC 全双工与语音打断。
- 暂时隐藏仍在开发中的全屏 TUI 和纯文字 CLI，不纳入 npm 发布包。
- Gateway 新增 `text.message` 文字通道,与语音共用会话与任务体系;
  文字触发采用静音提交序列适配 Qwen Realtime。
- 修复播放回执缺失响应上下文时的 Gateway 崩溃;静默打断竞态中
  无害的 "no active response" 报错。
- WebUI 资源与 API 改为相对路径,支持反向代理前缀部署。
- 修复后台服务从非仓库目录启动时无法定位 WebUI 的问题，并固定 launchd/systemd
  工作目录。
- 收紧 Gateway Host/Origin 校验，阻止默认局域网暴露与 DNS rebinding；远程部署
  改为显式可信 Origin 加带认证的 HTTPS 反向代理。
- 远程图片、音频和视频改为用户确认后加载，避免 Agent 输出触发隐私泄露。
- 固定 OpenCode/OpenClaw 兜底运行时版本，补齐公开 npm/GitHub 元数据、跨平台 CI、
  安全政策、贡献说明和第三方组件声明。
- macOS 正式构建启用 hardened runtime、Developer ID 签名与公证；保留独立的
  本地未签名构建命令。
- 公开仓库迁移至 QwenAudio 组织；固定 GitHub Actions 提交并收紧工作流权限，
  补充隐私说明、Dependabot 和结构化 Issue/PR 模板。

## 0.2.0

- 将 Realtime 前台与后台 Agent 收敛为清晰的 Gateway 边界。
- 默认支持 OpenCode 持久 Coordinator Session，并保留 OpenClaw 适配入口。
- 后台任务采用非阻塞提交、持久状态和可靠结果回注。
- 优化多任务结果批处理、播报插入时机、打断恢复和对话展示顺序。
- 完善 WebUI 任务动效、macOS 全双工语音 TUI 和 Electron 小窗口。
- 增加个人记忆、身份隔离、Smart Turn 时序保护和发布验证。
- 部署入口收敛为 `npm run backend` 与 `npm start` 两个常驻命令。
