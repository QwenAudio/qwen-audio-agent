# 配置

正式安装后，qwen-audio-agent 从用户配置文件读取设置：

```text
~/.config/qwaudio/config.env
```

设置 `QWAUDIO_CONFIG_DIR` 或 `XDG_CONFIG_HOME` 可以更改配置目录。开发仓库中的
`.env.local` 和 `.env` 仍然支持，并优先于用户配置文件。

桌面版与 CLI 共享同一个资产层、各自保留运行时状态（参照 Qoder IDE 与 qodercli
的目录分层）。共享的资产——`config.env`、本地身份（`state.env`）、记忆文档
（`USER.md`、`MEMORY.md`、`ASSISTANT.md`）、前台清单以及 Agent 共享 `workspace/`——
统一放在 CLI 的用户数据目录（`~/.config/qwaudio`，可用 `QWAUDIO_DATA_DIR` 覆盖），
两种形态是同一个助手：一份记忆、一份配置。运行时状态——`gateway.lock`、
`tasks.json`、ACP 会话状态、日志与桌面皮肤——留在各自目录：CLI 为
`~/.config/qwaudio`，桌面版为系统标准应用数据目录（macOS 为
`~/Library/Application Support/Qwen Audio Agent`，Linux 为
`~/.config/Qwen Audio Agent`，Windows 为 `%APPDATA%\Qwen Audio Agent`）。因此两者
可以作为两个独立的 Gateway 进程同时运行，各自拥有会话、任务和日志，同时共享用户的
助手配置。从旧版本升级时，桌面版只补齐共享层缺失的资产（包括旧 `workspace/`）；两边
都存在时不会自动覆盖或合并。显式设置 `QWAUDIO_CONFIG_DIR` 时桌面版遵循该覆盖，资产与
运行时状态落在同一目录，为 Profile 场景保留完全隔离。共享记忆与清单的写入使用跨进程
串行事务，Desktop 与 CLI 同时更新时不会静默丢失内容。

配置优先级固定为：

```text
CLI 参数 > 进程环境变量 > .env.local > .env > 用户配置文件 > 内置默认值
```

运行下面的命令可以显示当前用户配置文件的准确位置：

```bash
qwenaudio config
```

## 最小配置

最小配置只需要填写实时语音凭据：

```dotenv
DASHSCOPE_API_KEY=your-key
```

语音前台的 `web_search` 工具返回可核验的来源链接，不会创建后台 Agent 工作，也不会
额外调用文本大模型。用户未配置时，默认使用无需 Key、国内可访问的简易 360 搜索
Adapter，只解析一次公开搜索结果页。该基础兜底属于实验性实现，可能被拦截、结果质量
不稳定或受上游变化影响；稳定使用时应配置自己的 Provider。

在百炼开通联网搜索 MCP 后，需要显式选择内置预设；此时会复用
`DASHSCOPE_API_KEY`：

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=bailian
```

同一个与供应商无关的 Adapter 也可以接入其他兼容的 MCP 搜索服务；自定义地址必须
显式提供自己的凭据：

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=mcp
QWEN_AUDIO_WEB_SEARCH_MCP_URL=https://example.com/mcp
QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN=your-token
QWEN_AUDIO_WEB_SEARCH_MCP_TOOL=web_search
```

设置 `QWEN_AUDIO_WEB_SEARCH_PROVIDER=none` 可以关闭前台联网搜索。

通用 Chatbot 工具可以通过前台 MCP Client 接入。用
`QWEN_AUDIO_FRONTEND_MCP_CONFIG` 指定带版本的 JSON 文件并逐个启用；可写操作
需要用户确认。详见[前台 MCP Client](reference/frontend-mcp.zh.md)。

具有 OpenAPI 3.x 文档的 REST 服务，通过
`QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG` 复用同一套工具和授权边界。详见
[前台 OpenAPI Tool Adapter](reference/frontend-openapi.zh.md)。
需要把助手画像、MCP 和 OpenAPI 工具配置作为一套本地前台组合时，可以只设置
`QWEN_AUDIO_FRONTEND_PROFILE`。详见[轻量 Frontend Profile](reference/frontend-profile.zh.md)。
WebUI 和终端客户端会在最终回答下方展示规范化的来源链接；其他客户端可通过
Gateway 的 `messages.citations` 能力位消费同一字段。

需要执行后台任务时，再选择后台 Agent（以 OpenClaw 为例）：

```dotenv
AGENT_PROTOCOL=openclaw
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

OpenCode 和 OpenClaw 在以上配置下可以自动下载兼容版本并配置百炼模型，实现
一键启动。若未指定后台模型，则优先使用用户已经安装和配置的 Agent，不覆盖其
模型、Provider、工具、MCP、Skill 和认证。其他后台暂时需要用户自行安装配置。

这是 qwen-audio-agent 唯一的后台 Session 模型覆盖入口。模型 ID 是后台通过 ACP
声明的不透明值，Gateway 不会猜测或改写它。后台自身的原生模型环境变量仍可由后台
读取，但 Gateway 不会把它们解释为 Session 模型覆盖请求。OpenCode/OpenClaw
一键托管使用同一值初始化独立的百炼配置，属于启动前部署，不属于 ACP Session 覆盖。

未指定模型时，Gateway 不传模型，也不猜测默认值：新建 Session 的模型完全由
后台 Agent 根据用户配置选择，恢复 Session 则保留其原有模型。历史 Session
使用的模型可能与用户当前默认模型不同，这是后台 Agent 的 Session 语义，
Gateway 不会擅自重置。

显式模型会应用于协调 Session、新建项目 Session 和恢复的项目 Session。Gateway
从 ACP `configOptions` 中按 `category: model` 发现模型选项，并通过
`session/set_config_option` 设置；如果 Agent 没有提供模型配置、目标模型不在
可选清单中、调用失败或返回结果无法确认生效，当前请求会明确失败，不会静默换用
其他模型。Gateway 不使用 `session/set_model`、后台私有 RPC、启动参数或生成配置文件
模拟 Session 覆盖。未设置 `QWEN_AUDIO_AGENT_BACKEND_MODEL` 时完全不调用模型设置接口。

本地身份密钥由程序首次启动时自动生成，保存在同一配置目录的 `state.env`，
文件权限为仅当前用户可读写。

同一目录还会自动创建 `ASSISTANT.md`、`USER.md` 和 `MEMORY.md`。`ASSISTANT.md` 只定义
助手实例的默认名称、人格和表达风格；`USER.md` 保存当前用户明确设定的长期个性化覆盖；
`MEMORY.md` 保存只用于理解和回答的长期事实与决定。
它们都是普通 Markdown，直接编辑后在下一次建立语音会话时生效。助手通过受限的精确
编辑维护后两者，不会自行修改 `ASSISTANT.md`。请勿在其中保存密码、API Key、验证码或令牌。
如需把用户偏好放在其他位置，可设置：

```dotenv
QWEN_AUDIO_AGENT_USER_MODEL_PATH=/absolute/path/to/USER.md
QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH=/absolute/path/to/ASSISTANT.md
```

同一用户目录还保存：

```text
ASSISTANT.md          # 可定制的助手名称、人格和表达风格
USER.md               # 当前用户明确设定的长期交互方式
MEMORY.md             # 关于用户和项目的长期事实与决定
memory-audit.jsonl    # 自动记忆的审计日志（逐条追加，仅供事后查阅）
tasks.json            # 后台任务、结果和待播报通知的恢复状态
```

这些文件和 `ASSISTANT.md`、`USER.md`、`state.env` 一样只允许当前用户读写，不会写入源码仓库。
旧版 `frontend-memory.json` 会在首次启动时拆分迁移到 `USER.md` 和 `MEMORY.md`。
高级用户仍可通过 `QWEN_AUDIO_AGENT_MEMORY_PATH`（旧变量
`QWEN_AUDIO_AGENT_FRONTEND_MEMORY_PATH` 仍兼容）和 `QWEN_AUDIO_AGENT_TASK_STATE_PATH`
覆盖位置。

### 自动记忆整理

会话结束后，Gateway 会用一个轻量文本模型整理对话：遗漏的明确长期交互指令进入
`USER.md`，稳定事实与决定进入 `MEMORY.md`。自动路径与 Realtime 共用同一个记忆服务，
不会直接写文件或修改 `ASSISTANT.md`（详见[长期记忆](reference/memory.zh.md)）。相关可选配置：

```bash
QWEN_AUDIO_MEMORY_AUTO=on         # off 全局关闭自动整理（默认 on）
QWEN_AUDIO_MEMORY_MODEL=qwen-flash  # 提取模型（默认 qwen-flash）
QWEN_AUDIO_MEMORY_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
                                  # 任意 OpenAI 兼容端点，含本地 Ollama
QWEN_AUDIO_MEMORY_API_KEY=        # 默认复用 DASHSCOPE_API_KEY
```

两个 Key 都未配置时（如纯本地 speech-to-speech 前台），自动整理静默关闭，
明确要求的记忆不受影响。


## 继续阅读

- [前台配置](configuration/frontend.zh.md)——实时语音凭据、端点与模型选择
- [后台配置](configuration/backend.zh.md)——后台 Setup 检查、一键安装、
  技能管理、各后台设置与权限模式
- [高级设置](configuration/advanced.zh.md)——远程访问安全、Gateway 运行方式、
  本地日志与完整高级设置表
