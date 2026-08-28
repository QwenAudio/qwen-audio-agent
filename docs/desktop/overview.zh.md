# 桌面版

桌面版提供常驻桌面的语音悬浮球，并内置 Gateway，无需事先启动服务。同一用户配置
目录已有本地 Gateway 时会直接连接并以其当前运行配置为准，否则由桌面版自动启动和管理。首次运行时，
应用会创建配置文件，并引导你在设置页填写 DashScope API Key、选择后台 Agent
（也可以使用仅前台模式）。

## 后台 Agent 连接

桌面版默认管理所选后台 Agent。对于声明支持外部服务的 Agent，设置页还可以选择
“连接现有服务”，填写服务地址和可选的访问令牌；目前 OpenClaw 支持此模式。
不具备该能力的 Agent 继续使用托管 ACP 进程，也不会显示无效的连接字段。

## 悬浮球与自动休眠

闲置后悬浮球会自动隐藏并断开实时语音；也可以直接说“可以退下了”让它隐藏。应用仍
常驻菜单栏，可从菜单栏或显示快捷键重新唤出。默认快捷键为 `⇧⌘ Space`，也可以在
应用设置中更换。

休眠超时与自动隐藏合并为统一的“自动休眠”设置：休眠期间麦克风保持本地监听，说出
唤醒词“你好千问”即可恢复对话。后台 Agent 和已提交任务不会因休眠停止，任务结果
会在唤醒后播报。首次启用唤醒词时会自动下载并校验约 33 MB 的
[`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) 中英文 KWS 模型，之后直接使用本地缓存。
检测完全在桌面客户端的独立 Worker 中运行；音频不会为了唤醒词发送给 Gateway，检测成功后客户端只发送标准 `wake` 事件。

## 外观

桌面版支持流光声波球和液态渐变球两种外观。下面分别展示它们在思考 / 呼吸状态
下的原始动态效果：

| 流光声波球 | 液态渐变球 |
| --- | --- |
| ![流光声波球思考动画](../desktop-fluid-orb-thinking.gif) | ![液态渐变球思考动画](../desktop-goo-orb-thinking.gif) |

## 皮肤

除内置外观外，悬浮球还支持
[Codex pet](https://github.com/legeling/awesome-codex-pet) 包格式的精灵皮肤：
一个包含 `pet.json` 与 `spritesheet.webp` 的目录（8 列网格，v1 为
1536x1872 共 9 行，v2 为 1536x2288 共 11 行）。Codex pet 生态的素材无需
任何转换即可使用，也不要求安装 Codex。

生成式皮肤可以通过可选的 `animations.frames/fps` 描述每个标准动作的实际
帧数与速度，详见[桌宠皮肤协议](./pet-skin-spec.zh.md)。

导入已下载好的皮肤：打开“设置 → 应用 → 外观”，点击“导入皮肤…”，选择
皮肤文件夹、其中的 `pet.json` 或 zip 压缩包。导入的皮肤存放在桌面版数据
目录的 `skins/` 下，与内置外观一起出现在外观下拉框中；选中已导入的皮肤时
可用旁边的“删除”按钮移除，内置外观不可删除。

桌面端不把所有业务信号混成一个“Agent 状态”。生命周期、运行就绪、语音交互和
后台工作分别管理；皮肤只消费稳定的表现状态和一次性事件。

| 开源标准动画 | 业务含义 | Agent 状态或触发事件 | 播放方式 |
| --- | --- | --- | --- |
| `idle` | 待机 | `idle`、`connecting`、`occupied` | 状态持续期间循环 |
| `running-right` | 向右移动 | 用户向右拖动桌宠 | 拖动期间循环 |
| `running-left` | 向左移动 | 用户向左拖动桌宠 | 拖动期间循环 |
| `waving` | 说话 | `speaking` | `speaking` 持续期间循环 |
| `jumping` | 成功 / 唤醒 | `waking`、首次启动成功、任务成功完成、鼠标移入 | 每次事件单次播放 |
| `failed` | 失败 | `error`、桌面运行环境失败、任务执行失败 | 每次事件单次播放 |
| `waiting` | 聆听 | `listening` | `listening` 持续期间循环 |
| `running` | 工作 / 启动 | `working`、`starting` | 状态持续期间循环 |
| `review` | 前台轮次处理 | `processing` | 每个处理阶段单次播放 |

持续状态与单次事件分别仲裁：启动、聆听、说话和后台工作保持各自的循环轨道；首次
就绪、唤醒、任务结果、前台处理和鼠标移入只播放一次。单次动作结束后恢复当前基础
动作；如果仍有后台任务则恢复 `running`，否则恢复 `idle`。包括后台 thinking 在内的
所有活跃后台任务都统一使用 `working` → `running`；等待审批不选择 Agent 动画，持续
由任务界面承载，需要语音询问时自然进入 `speaking`。所有任务类型使用同一套开始、
完成与失败规则。仅前台模式会跳过后台 Agent 就绪要求。皮肤包只包含静态资源
（JSON + WebP），导入时会校验格式与尺寸；若选中的
皮肤包被删除，悬浮球会自动回退到内置外观。

## 安装

从发布页下载对应平台的安装包：

- **macOS**：下载 `.dmg`，打开后将 **Qwen Audio Agent** 拖入"应用程序"。
- **Windows**：下载 `.exe` 安装程序，双击运行并按向导完成安装。

从源码生成本机测试版：

```bash
npm run desktop:build:local      # macOS
npm run desktop:build:win        # Windows
npm run desktop:build:linux      # Linux（AppImage + deb，无需签名）
```

产物位于 `dist/desktop/`。

## 数据目录与隔离

桌面版与 CLI 共享同一个用户目录（`~/.config/qwaudio`）：设置、身份、
记忆与共享工作区在两者间一致。只有运行时状态——Gateway 进程、锁、
日志、任务记录与皮肤——存放在桌面版自己的应用数据目录（macOS 为
`~/Library/Application Support/Qwen Audio Agent`，Windows 为
`%APPDATA%/Qwen Audio Agent`，Linux 为
`~/.config/Qwen Audio Agent`），因此两者可以同时运行。首次启动时，
旧版桌面版的配置会迁移进共享的 CLI 目录（CLI 保留原件）。

## 自动更新与日志

设置页显示当前版本并可手动检查更新，发现新版本后台差量下载，完成后一键重启安装。

桌面版可在“设置 → 应用 → 日志”中打开日志目录，与 Gateway 一起记录结构化
JSONL 日志，凭据自动脱敏并自动轮转。日志配置详见
[配置说明](../configuration/advanced.zh.md#本地日志)。
