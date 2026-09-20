# 后台通用设置

先让 Agent 在自己的原生入口中可用，再让 Gateway 接入。以它的原生配置为基础，可复用的模型、工具、MCP、Skills 与认证取决于后台能力；各接入的限制见专属说明。

## 选择后台

在 `config.env` 中设置，例如：

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

后台名称及安装要求见[后台列表](../backends/overview.zh.md)。留空或设为 `none` 不启动后台；聊天与已启用的前台工具仍可使用。

临时切换可运行 `qwenaudio gateway --backend qwen`。修改持久配置后，按[运行方式](../operations/gateway.zh.md#修改配置后生效)重启实际 Gateway。

## 检查与安装

```bash
qwenaudio setup --backend qwen
qwenaudio install qwen
```

`setup` 只检查可执行文件和接入组件，不安装、不登录、不验证额度。`install` 只补齐缺失组件；需要外部 ACP 适配器时会一起安装。脚本类步骤执行前要求确认，`--yes` 可跳过。

安装完成后，使用后台自己的入口完成登录与模型配置。桌面设置的“安装”“配置”入口复用这套逻辑。“已安装”只表示组件存在，“已就绪”也不能代替一次真实任务验证。

通用 `acp` 入口不提供安装器，需自行设置 `ACP_COMMAND` 与 `ACP_ARGS`。后台独立参数见[各后台详细配置](../backends/configuration.zh.md)。

## 模型选择

对支持标准模型配置的 ACP 后台，`QWEN_AUDIO_AGENT_BACKEND_MODEL` 留空时：

- 不传模型、不猜默认值、不调用设置接口。
- 新 Session 由后台选择模型；恢复 Session 保留原来的模型。

显式填写时，ACP 后台只通过标准 `configOptions`（`category: model`）与 `session/set_config_option` 覆盖。模型 ID 必须来自后台提供的选项；不支持、设置失败或无法确认生效时会明确报错，不静默回退。

DeepSeek Harness 当前使用独立启动模型设置，见 [DeepSeek](../backends/configuration.zh.md#deepseek)。

覆盖应用于协调、新建和恢复的项目 Session。非 ACP 适配器按自己的公开能力实现；例如 Muse Code 使用 MSP `modelId`，不是 ACP。

### OpenCode / OpenClaw 一键托管

这两个后台支持缺失时自动下载安装，并为自有实例初始化百炼配置：

```dotenv
AGENT_PROTOCOL=opencode
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

使用 OpenClaw 时改为 `AGENT_PROTOCOL=openclaw`。这是启动前部署配置，不代表所有后台都支持相同方式。若希望完全沿用现有 Agent 模型，后台模型应留空。细节见 [OpenCode](../backends/configuration.zh.md#opencode) / [OpenClaw](../backends/configuration.zh.md#openclaw)。

## 工作区与进程

默认工作区为 `<data-dir>/workspace`；可用 `QWAUDIO_WORKSPACE` 统一修改，或用后台专属变量单独指定。工作区是项目目录，不是沙箱。

Gateway 通常新建自己的后台进程，复用用户配置；退出时关闭自己启动的进程。显式连接外部 OpenClaw Gateway 时，不管理远端服务生命周期。

## 后台权限模式

| 模式 | 行为 |
| --- | --- |
| `native`（默认） | 后台决定是否请求权限；Gateway 转发真实请求并执行已授予的任务 / 会话授权。 |
| `full` | 对支持该模式的后台启用最高权限，并自动批准其权限请求。 |

`full` 支持 OpenCode、Qoder、Qwen Code、MiniMax Code、Kimi Code、Hermes、CodeBuddy、Codex、Claude Code、DeepSeek 和 Muse Code。它允许后台直接修改文件或执行命令，只应在可信环境启用。

- **OpenClaw**：授权还受其原生执行策略约束，统一 `full` 模式会被拒绝；请在 OpenClaw 自身配置。
- **Pi**：当前接入没有审批环节，始终等效 `full`，即使配置为 `native` 也不能提供权限沙箱。
- 其他后台是否支持，以启动检查和对应页面为准。

对话中的“允许此任务”“始终允许”和拒绝的范围见[后台工作与授权](../guides/tasks.zh.md)。

## 技能管理

技能仅安装给后台，见[后台 Skills](../guides/skills.zh.md)。接入外部 Agent 服务见其专属说明，不要把后台服务地址当作客户端连接 Gateway 的地址。

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

[各后台详细配置](../backends/configuration.zh.md)集中列出命令、认证入口和专属变量。
