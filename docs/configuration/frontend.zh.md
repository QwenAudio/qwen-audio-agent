# 前台配置

语音前台是 Gateway 连接的实时语音模型。本页设置都写在用户配置文件中
（`~/.config/qwaudio/config.env`，见[配置总览](../configuration.zh.md)），
修改后按[实际运行方式应用设置](../operations/gateway.zh.md#修改配置后生效)：终端退出重启、后台服务执行 `gateway restart`，桌面版点击应用。

## 凭据与端点

默认 Provider 是 DashScope（`QWEN_AUDIO_REALTIME_PROVIDER=dashscope`）：

```dotenv
DASHSCOPE_API_KEY=your-key
```

| Provider | 凭证 | 地址 | 模型 / 音色 |
| --- | --- | --- | --- |
| DashScope（默认，别名 `qwen`） | `DASHSCOPE_API_KEY` | `QWEN_AUDIO_REALTIME_BASE_URL`（别名 `QWEN_AUDIO_REALTIME_URL`） | `QWEN_AUDIO_REALTIME_MODEL`；Audio：`QWEN_AUDIO_REALTIME_VOICE`；Omni：`QWEN_OMNI_REALTIME_VOICE` |
| StepFun | `STEPFUN_API_KEY` | `STEPFUN_REALTIME_URL` | `STEPFUN_REALTIME_MODEL`、`STEPFUN_REALTIME_VOICE` |
| speech-to-speech（别名 `s2s`） | `SPEECH_TO_SPEECH_AUTH_TOKEN`（别名 `S2S_API_KEY`） | `SPEECH_TO_SPEECH_REALTIME_URL`（别名 `S2S_REALTIME_URL`） | 由服务管理 |
| minicpm-o（别名 `minicpmo`） | `MINICPM_O_AUTH_TOKEN` | `MINICPM_O_REALTIME_URL` | 由服务管理 |

只有 `QWEN_AUDIO_REALTIME_PROVIDER` 是公共选择项。各家参数配置一次后，切换只需改
Provider；密钥、地址、模型和音色互不串用。显式清空凭证表示删除；模型、地址为空时使用
该 Provider 默认值，音色为空时使用模型或服务默认值。同一家变量的主名称优先于别名。

不再提供统一覆盖。`QWEN_AUDIO_REALTIME_MODEL` 和 `QWEN_AUDIO_REALTIME_VOICE`
恢复为 DashScope 专属。进程环境中的 `QWEN_AUDIO_REALTIME_API_KEY` 和
`QWEN_AUDIO_REALTIME_ENDPOINT` 不再生效。

CLI 来源优先级保持：进程环境变量、项目 `.env.local`、项目 `.env`、用户 `config.env`。
桌面端把各家独立字段共同写入 `config.env`，`realtime-profiles.json` 只作为私密草稿回退。
文件中明确指定的值优先于草稿，包括清空的密钥，以及通过 CLI 修改的非当前 Provider 参数。

过渡版本保存的统一字段只在读取配置文件时，按该文件原来的 Provider 转换，再合并其他来源。
下次在桌面保存前台设置时，会写入供应商字段并删除废弃字段。若同一家同时保存了不同的旧统一
密钥和供应商密钥，会明确报迁移冲突而非静默替换：保留需要的供应商密钥并删除废弃字段即可。
只读加载不会修改文件。

其他前台可选择 [StepAudio 3 Realtime](../voice-frontends/stepfun.zh.md)（使用独立的 StepFun API Key）、
[GPT-Live / OpenAI Realtime](../voice-frontends/gpt-live.zh.md)、
[Google Gemini Live](../voice-frontends/google-live.zh.md)、
[Speech-to-Speech](../voice-frontends/speech-to-speech.zh.md)，或通过
[面壁智能](../voice-frontends/minicpm-o.zh.md)连接本地及云端 MiniCPM-o 4.5 服务；自定义 Provider 需实现
Provider 契约，见[自定义 Provider](../voice-frontends/custom-provider.zh.md)。

MiniCPM-o 当前公开的 Audio Realtime 传输支持连续音频输入及文本、音频输出，
但不提供对话项、结构化 Function Calling 或输入转写。因此它目前定位为实时语音
聊天前台，不用于编排后台 Agent。

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
# 以下仅用于已安装的用户后台服务：
qwenaudio gateway restart
```

精确支持的 DashScope 模型 ID 如下：

| 模型 | 模型输入 | 模型输出 | Realtime 传输 |
| --- | --- | --- | --- |
| `qwen3.5-omni-flash-realtime` | 文本、音频、图像/视频帧 | 文本、音频 | 文本、音频、实时 JPEG 帧 |
| `qwen3.5-omni-plus-realtime` | 文本、音频、图像/视频帧 | 文本、音频 | 文本、音频、实时 JPEG 帧 |
| `qwen-audio-3.0-realtime-plus`（默认） | 文本、音频 | 文本、音频 | 文本、音频 |
| `qwen-audio-3.0-realtime-flash` | 文本、音频 | 文本、音频 | 文本、音频 |

其他云端前台的模型 ID 见各自页面：
[StepAudio 3 Realtime](../voice-frontends/stepfun.zh.md)、
[GPT-Live](../voice-frontends/gpt-live.zh.md)、
[Google Gemini Live](../voice-frontends/google-live.zh.md)。

四个档案都支持 Function Calling。模型能力仍与传输能力分离：Omni 可以接收 WebUI
经过 capability 协商的实时 JPEG 帧，普通上传图片继续走附件链路；Desktop 与 TUI
暂不采集实时画面。客户端从 Gateway health 读取权威档案；同一 Gateway 上的不同客户端不能选择互相冲突的模型。桌面版附着到借用的
Gateway 时，或后续 CLI 运行时使用了冲突的已配置模型时，会拒绝不一致，而不会静默
修改运行中服务。回滚时设置上表的旧版模型 ID 并重启 Gateway。| GPT-Live | `OPENAI_API_KEY`（别名 `GPT_LIVE_API_KEY`） | `GPT_LIVE_REALTIME_URL`（别名 `OPENAI_REALTIME_URL`） | `GPT_LIVE_REALTIME_MODEL`、`GPT_LIVE_REALTIME_VOICE`（支持 `OPENAI_REALTIME_*` 别名） |
| Google Live | `GOOGLE_API_KEY`（别名 `GEMINI_API_KEY`、`GOOGLE_LIVE_API_KEY`） | `GOOGLE_LIVE_REALTIME_URL`（别名 `GEMINI_LIVE_REALTIME_URL`） | `GOOGLE_LIVE_REALTIME_MODEL`、`GOOGLE_LIVE_REALTIME_VOICE`（支持 `GEMINI_LIVE_REALTIME_*` 别名） |
