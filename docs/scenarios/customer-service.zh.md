# 客服

> **场景蓝图——当前不可直接部署。**
> qwen-audio-agent 是个人助手运行时：一个 Gateway 同一时刻只服务
> **一个活跃的语音客户端**（第二个客户端会被告知网关被占用）。
> 多访客并发的客服部署依赖仍在
> [路线图](https://github.com/QwenAudio/qwen-audio-agent/issues/251)上的
> 多客户端支持。本页记录该场景与架构的映射关系，供能力落地后参考——
> 以及今天已经可用的单坐席形态。

## 今天已经可用（单坐席）

本节每一项都是已发布的能力，适用于同一时间一个操作员或一位访客的
形态——例如人工客服的辅助坐席台，或顺序接待访客的 kiosk：

- **服务人设**——`ASSISTANT.md` 定义助手的名称、人格和表达风格，
  把它改写为你的服务人设（品牌口径、语气、绝不能承诺什么）。见
  [助手画像与用户偏好](../reference/personalization.zh.md)。
- **按访客隔离的记忆**——`QWEN_AUDIO_AGENT_IDENTITY_MODE=browser` 让每个
  浏览器身份在 `users/` 下拥有隔离的 `USER.md` / `MEMORY.md`，自动记忆
  整理也按身份工作。隔离是真实能力；**并发不是**——访客仍然要一个
  接一个地被服务。
- **业务系统作为执行层**——通过通用 ACP 入口接入自有服务 Agent，或对于
  既不说 ACP 也不说 A2A 的 CRM/工单系统，用
  [Backend Adapter SDK](../reference/backend-adapter-sdk.zh.md) 直接实现
  `BackendPort`。见[接入新后台](../backends/extend.zh.md)。
- **领域流程作为技能**——退货政策、查单流程、升级规则打包为标准
  Agent Skills，用 `qwenaudio skill install` 安装。
- **无后台的前台工具**——应答级能力（查订单状态、FAQ 搜索）可以通过
  [前台 MCP 客户端](../reference/frontend-mcp.zh.md)或
  [前台 OpenAPI 适配器](../reference/frontend-openapi.zh.md)直接暴露给
  对话；知识库接入
  [知识检索 Provider](../reference/knowledge.zh.md) 边界，而非内置 RAG。
- **严格边界**——面向公众的页面跨越信任边界：前置带认证的 HTTPS 反向
  代理，用 `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS` 声明公网 Origin，绝不在裸
  端口上设 `HOST=0.0.0.0`。遵循
  [远程访问安全](../configuration/advanced.zh.md#远程访问安全)。

## 仍需平台侧工作的部分

| 缺口 | 影响 | 跟踪 |
| --- | --- | --- |
| 并发访客 | 今天一个 Gateway 只有一个活跃客户端；繁忙热线需要 N 路并行对话 | [路线图 #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251) |
| 多租户授权 | `QWEN_AUDIO_AGENT_AUTH_SECRET` 只签署本地身份，不是租户模型 | 未来协议工作 |
| 电话音频 | 把 PSTN 音频桥接进实时前台目前是接入方自己的工作 | 自定义[语音前台 Provider](../voice-frontends/custom-provider.zh.md) |

蓝图刻意停在接缝处：知识库、CRM 和业务 UI 仍然是你的系统。
qwen-audio-agent 贡献的是持续在场的语音对话、人设与记忆平面，
以及通向你所连接的任何执行层的派发路径。
