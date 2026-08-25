# 轻量 Frontend Profile

Frontend Profile 是一个本地、版本化的组合清单，用一个入口选择前台助手画像和外部工具
配置。它适合把一套前台体验作为目录保存或分享，但不会引入新的 Skill 或插件协议。

## 配置

创建一个目录：

```text
research-profile/
├── frontend-profile.json
├── ASSISTANT.md
└── tools/
    ├── mcp.json
    └── openapi.json
```

`frontend-profile.json`：

```json
{
  "version": 1,
  "name": "research",
  "description": "面向检索与资料整理的语音前台",
  "assistant": "./ASSISTANT.md",
  "toolSources": {
    "mcp": "./tools/mcp.json",
    "openapi": "./tools/openapi.json"
  }
}
```

启用：

```dotenv
QWEN_AUDIO_FRONTEND_PROFILE=/absolute/path/to/research-profile/frontend-profile.json
```

`assistant`、`toolSources.mcp` 和 `toolSources.openapi` 都是可选项，但至少配置一项。
引用必须是 Profile 目录内已有文件的相对路径。MCP 与 OpenAPI 文件继续使用各自的
版本化格式和授权策略；Profile 不复制它们的协议。

## 优先级

原有单项设置拥有更高优先级，便于临时覆盖：

1. `QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH`、`QWEN_AUDIO_FRONTEND_MCP_CONFIG`、
   `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG`；
2. Frontend Profile 中的引用；
3. qwen-audio-agent 默认配置。

`/api/health` 的 `frontendProfile` 只报告是否启用、名称和描述，不暴露本地路径。

## 边界

Frontend Profile 不能修改核心 Prompt，也不包含用户记忆、Realtime Provider、后台
Agent、密钥、脚本或可执行代码。密钥仍通过环境变量传入 MCP/OpenAPI 配置。未知字段、
越出目录的路径和缺失文件会在 Gateway 启动时明确失败。

Web Search 继续使用独立的 Provider 配置；未配置时只有内置的简易搜索兜底。Profile
不会增加搜索引擎回退链。
