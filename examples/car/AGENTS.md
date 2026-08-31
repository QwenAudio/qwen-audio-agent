# Qwen Audio Agent Car — 开发边界

本目录是 qwen-audio-agent 在智能座舱领域的落地示范，不是第二套框架，也不是
对旧 Demo 的兼容改造。实现基于框架公开接缝重新组织；旧座舱代码和视觉资源只在
边界合适时复用，以节约实现成本。

- qwen-audio-agent 的基础边界是前台对话与后台执行两层。客户端属于前台的可替换
  I/O 组件；后台 Agent 可以按需派生独立 Session，形成后台扩展出的第三层执行
  空间。本示例后台保持轻量，默认不实现这类派生执行。
- `react-app/` 是可替换的场景客户端，只依赖公开 GCP Client SDK；浏览器音频和 UI 保持场景本地。
- `gateway.mjs` 是前台场景装配点，不复制 Gateway、Realtime、Task、播报或历史实现。
- `agent/` 是轻量、可替换的后台 A2A 示例，不扩展成通用 Agent 框架。
- `domain/` 与 `tools/` 是座舱示例自己的业务基础设施，不是 qwen-audio-agent
  的额外架构层。前者提供单一业务状态，后者按领域组织 MCP 工具。
- 不增加 `actions[]`、第二套 Realtime Server、第二套会话历史或 Gateway 可解析的座舱对象。

前端使用 React 19、Vite 8 和 JavaScript；组件用函数与 Hooks，样式保留在 `App.css`。提交前运行：

```bash
npm run test:car
npm run example:car:lint
npm run example:car:build
```
