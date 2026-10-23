# Realtime model catalog / 实时模型目录

This directory separates model records, reusable API integration presets, and file loading. It stores no credentials and does not discover executable plugins.

- `builtins.mjs`: built-in model IDs, labels, API bindings, default voices, and optional model-specific turn detection defaults.
- `api-profiles.mjs`: reusable integration presets grouping a wire variant, default capability declarations, session defaults (including turn detection), and integration constraints. Provider adapters implement the wire behavior.
- `registry.mjs`: strict validation and immutable, append-only catalog snapshots; user registrations cannot replace built-in models or introduce another API.
- `config-file.mjs`: Node-only path resolution and bounded JSON loading; catalog data and validation remain browser-safe.
- `frontend-models.example.json`: a placeholder-only configuration example, not a verified service model.

`../realtime-model-catalog.mjs` is the public facade. Gateway configuration loads the optional user JSON; Desktop and CLI select from the resulting catalog. The active provider, model, credentials, endpoint, and voice use the shared `QWEN_AUDIO_REALTIME_*` fields in `config.env`. See the [user guide](../../docs/configuration/frontend.md#register-an-additional-model).

An API profile describes the integration's common defaults, not a universal capability contract for every model sharing an upstream API. Registration selects an existing preset without changing its defaults; verify that the model fits its wire behavior, capabilities, and constraints. A mismatch needs an explicit integration change and tests, not a name-based inference or an undeclared override field.

Built-in records may refine turn detection without changing their API binding or the shared preset. This is internal model metadata, not an additional field accepted in user JSON registrations.

本目录分离模型记录、可复用 API 接入预设和文件加载，不存凭据，也不发现可执行插件。`builtins.mjs` 登记内置模型；`api-profiles.mjs` 将线协议变体、默认能力声明、会话默认参数（含话轮检测）和接入约束集中为预设；`registry.mjs` 严格校验并合并只追加的用户登记；`config-file.mjs` 独立承担 Node 端路径解析与有大小限制的 JSON 读取。目录数据和校验逻辑保持浏览器可用。Provider adapter 负责线上协议，公共入口为 `../realtime-model-catalog.mjs`。

API profile 表示当前接入的共用默认值，并不保证使用同一上游 API 的所有模型能力一致。登记模型会选择已有预设，不修改其中的默认值；需确认模型符合对应线协议、能力与约束。存在差异时，应明确调整接入实现并补充测试，而不是按名称推断或添加未声明的覆盖字段。

内置模型可单独覆盖话轮检测默认值，不改变 API 绑定或共享预设。这是内部模型元数据，用户 JSON 登记不接受该额外字段。

Gateway 配置层读取可选用户 JSON，桌面与 CLI 使用生成的有效目录。当前供应商、模型、凭据、地址与音色统一使用 `config.env` 的 `QWEN_AUDIO_REALTIME_*` 字段。示例中的模型 ID 必须替换为服务实际支持的型号；登记本身不保证账号授权或模型兼容性。详见[用户手册](../../docs/configuration/frontend.zh.md#登记额外模型)。
