# 前台配置

语音前台是 Gateway 连接的实时语音模型。本页设置都写在用户配置文件中
（`~/.config/qwaudio/config.env`，见[配置总览](../configuration.zh.md)），
修改后执行 `qwenaudio gateway restart` 生效。

## 凭据与端点

默认 Provider 是 DashScope（`QWEN_AUDIO_REALTIME_PROVIDER=dashscope`）：

```dotenv
DASHSCOPE_API_KEY=your-key
```

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | — | 百炼 API Key，实时语音前台与网关其他功能共用 |
| `QWEN_AUDIO_REALTIME_API_KEY` | 空 | 语音前台的 `DASHSCOPE_API_KEY` 高优先级别名 |
| `QWEN_AUDIO_REALTIME_BASE_URL` / `QWEN_AUDIO_REALTIME_URL` | 空 | 覆盖 DashScope Realtime 端点（私有部署或代理） |
| `DASHSCOPE_WORKSPACE_ID` | 空 | 切换到百炼专属 workspace 端点 |

完全本地化的前台可通过 `QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech` 启用，
见 [Speech-to-Speech](../voice-frontends/speech-to-speech.zh.md)；自定义 Provider
需实现 Provider 契约，见[自定义 Provider](../voice-frontends/custom-provider.zh.md)。

前台工具单独配置：Web 搜索（`QWEN_AUDIO_WEB_SEARCH_PROVIDER`，见
[配置总览](../configuration.zh.md)）；通用对话工具见
[前台 MCP 客户端](../reference/frontend-mcp.zh.md)、
[前台 OpenAPI 适配器](../reference/frontend-openapi.zh.md)或
[前台 Profile](../reference/frontend-profile.zh.md)。

## Realtime 模型选择

一个 Gateway 只拥有一个当前生效的 Realtime 模型。桌面设置页可以配置本地自有
Gateway 的模型，CLI 提供等价命令：

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen3.5-omni-flash-realtime
qwenaudio gateway restart
```

精确支持的模型 ID 如下：

| 模型 | 模型输入 | 模型输出 | 当前客户端传输 |
| --- | --- | --- | --- |
| `qwen3.5-omni-flash-realtime` | 文本、音频、图片 | 文本、音频 | 文本、音频、JPEG 观察 |
| `qwen3.5-omni-plus-realtime` | 文本、音频、图片 | 文本、音频 | 文本、音频、JPEG 观察 |
| `qwen-audio-3.0-realtime-plus`（默认） | 文本、音频 | 文本、音频 | 文本、音频 |
| `qwen-audio-3.0-realtime-flash` | 文本、音频 | 文本、音频 | 文本、音频 |

四个档案都支持 Function Calling。两个 Omni 档案支持 WebUI 显式开启的 JPEG 观察传输：
约每秒发送一帧，内存中最多保留最近 8 帧，观察本身不会创建模型回复。原生视频以及
旧版 Audio 档案的画面观察仍不可用。WebUI 与 TUI 从 Gateway health 读取权威档案，并据此
限制或展示可用输入；同一 Gateway 上的不同客户端不能选择互相冲突的模型。桌面版附着到借用的
Gateway 时，或后续 CLI 运行时使用了冲突的已配置模型时，会拒绝不一致，而不会静默
修改运行中服务。回滚时设置上表的旧版模型 ID 并重启 Gateway。

## 后台视觉分析

摄像头观察和后台视觉分析是相互独立的能力。当前配置的后台 Agent 接受图片输入时，
WebUI 会显示“深度分析”按钮，前台 Agent 也可以调用 `analyze_visual_scene`。Gateway
会冻结最新一帧或最近的有界帧窗口（最多 8 帧），仅将本次请求所需的 JPEG 输入发送给
当前配置后台，不把原始画面写入日志或默认持久化。

结果会归一化为带观察会话、generation、帧范围、采集时间、摘要、不确定项和置信度的
有界 `VisualInsight`。交付方式可以是 `display`（只显示卡片）、`context`（静默加入
前台后续上下文）或 `respond`（触发一次前台自然回复）。后台未声明图片输入能力时会
明确失败；前台仍可继续普通聊天。
