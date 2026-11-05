# Realtime model catalog / 实时模型目录

This directory contains provider-owned data for the framework's static realtime model catalog. The shared catalog entry handles aggregation and resolution without provider-specific configuration. The modules are browser-safe and contain no credentials or connection implementations.

- `dashscope.mjs`, `stepfun.mjs`, `gpt-live.mjs`, `google-live.mjs`, and `doubao-seeduplex.mjs`: pure data for each provider's model IDs, labels, API bindings, default voices, turn detection, capabilities, and integration constraints.
- `profile.mjs`: browser-safe helpers for immutable model and API declarations.
- `../realtime-model-catalog.mjs`: the shared entry used by Gateway, Desktop, and CLI. It aggregates provider declarations and default selections, constructs immutable model profiles, and provides catalog queries and model resolution. It does not read user model files or merge user overrides.

Users select a supported provider and model with `QWEN_AUDIO_REALTIME_PROVIDER` and `QWEN_AUDIO_REALTIME_MODEL`, alongside the existing API key, URL, and voice connection fields in `config.env`. Model API bindings, capabilities, turn detection, and hard constraints are maintained in code, not exposed as user parameters. Explicit environment and session voice overrides keep their existing precedence. See the [user guide](../../docs/configuration/frontend.md#select-a-supported-model).

DashScope includes Qwen Audio 3.1 Plus and 3.1 Flash; both use `longanqian_v3.1` and `smart_turn_v2`. The default model remains 3.1 Plus. The catalog records implemented support, not live account authorization or a cloud-service verification.

To add framework support for a model, update the corresponding provider data file and tests. If its wire behavior or required capabilities differ, update the provider adapter as well. Model names are never used to infer a protocol or capabilities.

本目录保存框架静态实时模型目录中的供应商专属数据。统一目录入口负责聚合与解析，不包含供应商具体配置。模块保持浏览器可用，不含凭据或连接实现。

- `dashscope.mjs`、`stepfun.mjs`、`gpt-live.mjs`、`google-live.mjs`、`doubao-seeduplex.mjs`：各供应商的纯数据，包括模型 ID、展示名称、API 绑定、默认音色、话轮检测、能力和接入约束。
- `profile.mjs`：用于定义不可变模型和 API 数据的浏览器安全辅助函数。
- `../realtime-model-catalog.mjs`：Gateway、桌面版和 CLI 共用的统一入口，汇总供应商声明与默认选择，生成不可变模型档案，并提供目录查询和模型解析；不读取用户模型文件，也不合并用户覆盖。

用户通过 `config.env` 中的 `QWEN_AUDIO_REALTIME_PROVIDER`、`QWEN_AUDIO_REALTIME_MODEL` 选择受支持的供应商和模型，同时配置现有 API Key、地址和音色连接字段。模型的 API 绑定、能力、话轮检测和硬约束由代码维护，不作为用户参数开放；环境变量和会话显式指定的音色仍保持原有优先级。详见[用户手册](../../docs/configuration/frontend.zh.md#选择受支持模型)。

DashScope 内置 Qwen Audio 3.1 Plus 和 3.1 Flash，二者均使用 `longanqian_v3.1` 和 `smart_turn_v2`；默认模型仍为 3.1 Plus。目录表示代码已实现的支持，不代表实时账号授权或已完成云端验证。

为框架新增模型支持时，修改对应供应商数据文件并补充测试；若线协议行为或所需能力不同，还需修改 Provider adapter。不会通过模型名称推断协议或能力。
