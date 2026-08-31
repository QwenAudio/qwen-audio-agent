# Qwen Audio Agent Car — 开发边界

本目录是三层框架的座舱参考场景，不是第二套框架。

- `react-app/` 是可替换的客户场景客户端，只依赖 GCP Client SDK；浏览器音频和 UI 保持场景本地。
- `gateway.mjs` 是场景装配点，不复制 Gateway、Realtime、Task、播报或历史实现。
- `agent/` 是轻量、可替换的 A2A 后台示例，不扩展成通用 Agent 框架。
- `domain/` 是单一业务状态源，通过 MCP 服务 Agent、通过 HTTP/SSE 服务 UI。
- 不增加 `actions[]`、第二套 Realtime Server、第二套会话历史或 Gateway 可解析的座舱对象。

前端使用 React 19、Vite 8 和 JavaScript；组件用函数与 Hooks，样式保留在 `App.css`。提交前运行：

```bash
npm run test:car
npm run example:car:lint
npm run example:car:build
```
