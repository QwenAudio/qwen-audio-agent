# 座舱示例测试矩阵

本页记录软件契约与回归测试，不是模型能力成绩。模型评测的用例数、交互轮数、
准确率与时延统一见 [Benchmark 说明](../bench/README.md)。

| 边界 | 覆盖内容 | 自动化入口 |
|---|---|---|
| cockpit-service | 多座舱隔离、车控校验、车辆定位适配、音乐、导航阶段/偏好、闪购确认、自定义技能持久化/更新/删除、场景状态事件 | `examples/smart-cockpit/service/test` |
| MCP | 分领域路由及环境覆盖、前后台工具面互斥、自定义技能固定工具契约、参数传递、与 HTTP 共用单一状态 | `examples/smart-cockpit/service/test/server.test.mjs`、`examples/smart-cockpit/gateway/test/frontend-tools.test.mjs`、`examples/smart-cockpit/test/tool-surfaces.test.mjs` |
| cockpit-agent | Qwen3.8-Flash 思考模式、标准函数工具、多轮工具循环、自定义技能发现/加载/真实工具执行、歧义追问 | `examples/smart-cockpit/agent/test`（模型使用确定性测试替身） |
| A2A → MCP | 标准 Task 生命周期、真实领域状态变更和有序多途经点导航 | `examples/smart-cockpit/agent/test/integration.test.mjs` |
| Gateway 装配 | 仅使用公开 API 注入 A2A Agent、健康和关闭 | `examples/smart-cockpit/gateway/test/composition.test.mjs` |
| Assistant Profile | 客户端展示与 Gateway Prompt 分离、三份完整人设、场景事件 ID 契约、白名单校验和会话级刷新 | `examples/smart-cockpit/gateway/test/assistant-profiles.test.mjs`、`server/test/client-event-router.test.mjs`、`server/test/realtime-provider.test.mjs` |
| 音色 | 两个 Qwen Audio 3.0 Realtime 音色、默认值、GCP `session.output_voice`、客户端 SDK 动态切换与 Provider 优先级 | `examples/smart-cockpit/client/test/voices.test.mjs`、`examples/smart-cockpit/client/test/voice-session-mode.test.mjs`、根目录 GCP tests、`server/test/realtime-provider*.test.mjs` |
| 启动预检 | Realtime 配置、四进程端口、无效端口 | `examples/smart-cockpit/bootstrap/test/preflight.test.mjs` |
| GCP 客户端 | 握手、重连、回放、播放回执、Task 与会话恢复 | 根目录 Gateway Client SDK / protocol tests |
| BackendPort/A2A | 取消、超时、断线、重复终态、输入与权限映射 | `server/test/a2a-backend-adapter.test.mjs` 及 Backend tests |
| cockpit-client | 场景活动到导航/音乐/闪购面板的投影、路线动画终止、解除静音意图与麦克风权限解耦、自定义技能列表/详情/删除、前台记忆投影/删除、Task 进度语义去重、ESLint 与生产构建 | `examples/smart-cockpit/client/test/`、`server/test/gateway-application.test.mjs`、`npm run example:smart-cockpit:lint`、`npm run example:smart-cockpit:build` |
| Benchmark | 用例合法性、评分器、确定性回放、时延采集与离线导出、文档统计一致性 | `examples/smart-cockpit/bench/test/`（不调用真实模型） |

统一运行：

```bash
npm run test:smart-cockpit
npm run example:smart-cockpit:lint
npm run example:smart-cockpit:build
```

根目录 `npm test` 已包含 `test:smart-cockpit`，因此 CI 会覆盖座舱 Service、Agent 和场景装配。涉及视觉资源或浏览器麦克风策略的变更仍需在 Chrome/Edge/Safari 做人工体验；协议行为不依赖浏览器私有 API。

不要把自动化测试通过数写成模型评测的用例数或准确率。实时模型调用另按 Benchmark
命令执行，会产生 API 用量；Gold replay 仅验证用例、模拟服务和评分器的一致性。
