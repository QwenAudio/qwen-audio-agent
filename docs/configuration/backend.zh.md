# 后台配置

## 后台 Setup 检查

配置后台 Agent 后，可运行统一的只读检查：

```bash
qwenaudio setup
```

它会检查后台可执行文件、ACP 接入方式和必要的 Adapter，并明确显示当前选择。
检查命令本身不会安装或下载后台 Agent，不会触发登录，也不会输出或验证凭据、修改模型
配置。它会提示 OpenCode/OpenClaw 是否能在正式启动时自动下载和配置；其他后台
的配置状态由 Agent 自己管理。

只检查指定后台或获取机器可读结果：

```bash
qwenaudio setup --backend codex
qwenaudio setup --json
```

JSON 输出与 CLI 使用同一个共享检测模块，可供桌面版和其他工具直接复用。

## 一键安装后台 Agent

未安装的后台 Agent 可用统一命令安装到本机：

```bash
qwenaudio install codex
qwenaudio install deepseek
qwenaudio install minimax
```

- 安装前先检测，只补齐缺失的组件：原生 ACP 后台仍需按要求完成登录和配置；本体缺失时装本体；
  本体已装、仅缺 ACP 适配器时只装适配器；全部就绪时直接提示已可用。
- 安装规格（官方 npm 包与锁定版本、官方安装脚本）由 CLI 与桌面版共享同一份
  定义，版本与 `scripts/` 下 managed 启动脚本保持一致；可用对应环境变量覆盖，
  如 `OPENCODE_PACKAGE`、`CODEX_ACP_PACKAGE`、`CLAUDE_CODE_ACP_PACKAGE`。
- Codex、Claude Code 的 ACP 适配器随本体一并提供；Hermes 使用官方安装
  脚本。脚本类步骤执行前会逐个展示完整命令并等待确认，`--yes` 跳过确认
  （谨慎使用）。
- 安装完成后自动重新检测该后台的可用状态；需要初始化、登录或填写凭据的后台会
  给出统一的“配置”入口。
- 通用 `acp` 后台不提供一键安装，请自行安装后通过 `ACP_COMMAND` 配置。
- 桌面版设置页的“后台 Agent”列表中，未安装且支持一键安装的后台行尾会显示
  “安装”按钮，与 CLI 使用同一份安装逻辑；脚本类安装会弹出原生确认框。

桌面版只提供统一的安装、配置和连接状态外壳，不理解具体 Agent 的登录流程。
每个后台 Onboarding Adapter 声明自己的受信配置入口与状态检测方式；目前入口可以
打开官方终端流程，后续也可扩展为网页、表单或纯说明，而不需要修改设置页的产品逻辑。
渲染层只提交后台 ID，不能自行拼接或执行配置命令。

安装 DeepSeek Harness 后运行 `dsh web`，在模型设置中配置官方
API Key，ACP 接入会直接复用该凭据。它的模型配置独立于其他后台，避免把 Qwen 等
模型名称误传给 DeepSeek：

```dotenv
AGENT_PROTOCOL=deepseek
# 可选：deepseek-v4-pro（默认）或 deepseek-v4-flash
DEEPSEEK_HARNESS_MODEL=deepseek-v4-pro
```

仍可通过 `DEEPSEEK_API_KEY` 为单次运行显式覆盖凭据。

## 选择后台

`AGENT_PROTOCOL` 没有默认值，也是可选配置。留空时 Gateway 不启动后台 Agent，前台聊天与已启用工具仍可使用；需要后台执行的请求会返回明确错误，不会创建任务或猜测执行结果。
也可以使用 `qwenaudio --backend none` 显式启动仅前台模式。

## 模型选择

后台模型留空时，使用用户原生默认配置；显式设置才要求覆盖：

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

未指定时 Gateway 不传模型、不猜默认值，也不调用设置接口。新建 Session 由后台选择模型，
恢复 Session 保留原来的模型。显式值应用于协调、新建和恢复的项目 Session。

显式覆盖只使用 ACP 标准 `configOptions` 中 `category: model` 的选项，以及
`session/set_config_option`。后台不支持、目标值不在清单、设置失败或不能确认生效时，
当前请求会明确失败，不使用私有 RPC 或启动参数模拟覆盖。模型 ID 按后台声明的值填写。

OpenCode / OpenClaw 另支持一键托管：配置 `DASHSCOPE_API_KEY` 与后台模型后，
可以在启动前为自有实例初始化百炼配置。这是部署步骤，不代表所有 ACP 后台都支持模型覆盖。
已安装并配置好的其他后台通常只需选择名称，模型留空即可。

## 各后台设置

<a id="openclaw"></a>
<a id="opencode"></a>
<a id="qoder"></a>
<a id="qwen-code"></a>
<a id="minimax-code"></a>
<a id="kimi-code"></a>
<a id="hermes"></a>
<a id="codebuddy"></a>
<a id="codex"></a>
<a id="claude-code"></a>
<a id="pi"></a>

[OpenClaw](../backends/configuration.zh.md#openclaw) · [OpenCode](../backends/configuration.zh.md#opencode) · [Qoder](../backends/configuration.zh.md#qoder) · [Qwen Code](../backends/configuration.zh.md#qwen-code) · [MiniMax Code](../backends/configuration.zh.md#minimax-code) · [Kimi Code](../backends/configuration.zh.md#kimi-code) · [Hermes](../backends/configuration.zh.md#hermes) · [CodeBuddy](../backends/configuration.zh.md#codebuddy) · [Codex](../backends/configuration.zh.md#codex) · [Claude Code](../backends/configuration.zh.md#claude-code) · [Pi](../backends/configuration.zh.md#pi)

## 技能管理

技能只安装给后台，命令与安装位置见[后台 Skills](../guides/skills.zh.md)。

### 技能何时生效

见[技能发现与加载](../guides/skills.zh.md#技能何时生效)。

### 共享后台 workspace

见[共享后台 workspace](../guides/skills.zh.md#共享后台-workspace)。

## 后台权限模式

`QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` 可设为：

- `native`（默认）：权限由后台 Agent 自己判断和询问，Gateway 只负责原样转发。
- `full`：启动时明确授予最高权限，后台可直接执行命令、读写文件，不再逐次确认。

`full` 当前支持 OpenCode、Qoder、Qwen Code、MiniMax Code、Kimi Code、Hermes、CodeBuddy、Codex 和
Claude Code。Gateway 会自动批准这些 ACP 后台发起的权限请求；此外 Kimi Code
会通过 ACP Session 配置切换到不会再提问的 Auto 模式，Qoder 和 CodeBuddy CLI
会使用 `--dangerously-skip-permissions`，OpenCode 会在受管进程的内联配置中为协调
Agent 和任务 Agent 设置 `permission: "allow"`，Codex 会使用
`agent-full-access` 模式。Kimi Code 的 YOLO 模式仍可能向用户提问，因此这里不会
用它映射 `full`。

Pi 是特例：它没有任何内置沙箱或权限审批机制，适配器 pi-acp 也未实现 ACP
`session/request_permission`，因此无论配置哪种权限模式，Pi 都始终等效
`full` 权限运行——这不是“支持 `full`”，而是根本不存在审批环节。Pi 通过
`alwaysFullPermission` 后台能力声明这一点：配置解析与 Gateway 健康状态都会
归一化并展示真实生效的 `full`（而不是具有误导性的 `native`）。只在可信项目和
可信提示词环境中使用。

OpenClaw 的执行授权同时受 exec approvals、elevated 和执行 host 等配置约束，
无法由一个统一开关安全、完整地表达；选择 `full` 时 Gateway 会明确拒绝启动，
需要按 OpenClaw 自身方式单独配置。最高权限会放大误操作风险，只应在可信项目和
可信提示词环境中启用。
