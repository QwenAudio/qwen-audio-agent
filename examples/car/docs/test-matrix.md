# 座舱示例测试矩阵

| 边界 | 覆盖内容 | 自动化入口 |
|---|---|---|
| cockpit-domain | 多座舱隔离、车控校验、音乐、导航阶段、闪购确认、状态事件 | `examples/car/domain/test` |
| MCP | 工具发现、参数传递、与 HTTP 共用单一状态 | `examples/car/domain/test/server.test.mjs` |
| cockpit-agent | 车控、导航、音乐、天气、闪购意图；未知请求不臆造能力 | `examples/car/agent/test` |
| A2A → MCP | 标准 Task 生命周期和真实领域状态变更 | `examples/car/agent/test/integration.test.mjs` |
| Gateway 装配 | 仅使用公开 API 注入 A2A Agent、健康和关闭 | `examples/car/test/gateway-composition.test.mjs` |
| 启动预检 | Realtime 配置、四进程端口、无效端口 | `examples/car/test/preflight.test.mjs` |
| GCP 客户端 | 握手、重连、回放、播放回执、Task 与会话恢复 | 根目录 Gateway Client SDK / protocol tests |
| BackendPort/A2A | 取消、超时、断线、重复终态、输入与权限映射 | `server/test/a2a-backend-adapter.test.mjs` 及 Backend tests |
| cockpit-client | ESLint 与生产构建 | `npm run example:car:lint`、`npm run example:car:build` |

统一运行：

```bash
npm run test:car
npm run example:car:lint
npm run example:car:build
```

根目录 `npm test` 已包含 `test:car`，因此 CI 会覆盖座舱领域、Agent 和场景装配。涉及视觉资源或浏览器麦克风策略的变更仍需在 Chrome/Edge/Safari 做人工体验；协议行为不依赖浏览器私有 API。
