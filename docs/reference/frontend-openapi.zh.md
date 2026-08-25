# 前台 OpenAPI Tool Adapter

前台 OpenAPI Adapter 用于把选定的 REST 操作接入 Chatbot，不绑定具体
Realtime Provider，也不绑定后台 Agent。它与前台 MCP Client 复用同一套动态工具
Source、执行边界和逐操作授权链路。

OpenAPI 文档只描述 API；哪些 `operationId` 可以被模型看到，由独立的
qwen-audio-agent 策略显式决定，不会自动开放整份 API。

## 配置

用 `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG` 指定带版本的 JSON 配置文件。
OpenAPI 文档可以是 JSON 或 YAML，相对路径以该配置文件所在目录为基准：

```env
QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG=/absolute/path/to/frontend-openapi.json
WEATHER_AUTHORIZATION=Bearer replace-me
```

```json
{
  "version": 1,
  "apis": {
    "weather": {
      "enabled": true,
      "document": "./weather.openapi.yaml",
      "baseUrl": "https://weather.example.com/v1",
      "headers": {
        "authorization": "${WEATHER_AUTHORIZATION}"
      },
      "operations": {
        "getWeather": {
          "enabled": true,
          "readOnly": true,
          "description": "读取指定城市的当前天气。"
        },
        "createAlert": {
          "enabled": true,
          "readOnly": false,
          "approval": "required",
          "description": "创建天气提醒。"
        }
      }
    }
  }
}
```

模型可见名称稳定为 `openapi__<api>__<operationId>`。设置 `baseUrl` 时，
它会覆盖文档中的第一个 `servers` 地址。

## 支持边界

- 本地 JSON 或 YAML 格式的 OpenAPI 3.0、3.1 文档。
- 具有 `operationId` 且被逐项显式启用的操作。
- Path、Query 参数和 `application/json` Request Body。
- 本地 `$ref`；外部引用和递归引用失败关闭。
- 固定请求 Header；密钥值可用精确的 `${VARIABLE}` 环境变量引用。
- GET、HEAD 可以声明为只读；其他方法必须声明为可写，并设置
  `approval: "required"`。
- 每次可写调用都要获得用户自然语言确认，且最多执行一次；拒绝、重复确认或确认前
  重连都会失败关闭。
- 远端 API 必须使用 HTTPS；回环地址可使用 HTTP，但不能携带 Header；不跟随重定向。
- Schema、调用次数、执行时间和结果大小都有边界；API 返回按不可信数据处理，
  不能覆盖系统指令或用户要求。

首版有意不支持 Header/Cookie 参数、非 JSON Body、远程 OpenAPI 文档和未配置操作的
自动开放。修改配置或文档后需要重启 Gateway。
