# Third-Party Notices

qwen-audio-agent 使用并分发若干开源组件。项目自身使用 Apache License 2.0；
第三方组件仍分别受其原许可证约束。

主要组件包括：

| Component | License | Project |
| --- | --- | --- |
| Electron | MIT | https://github.com/electron/electron |
| React / React DOM | MIT | https://github.com/facebook/react |
| Express | MIT | https://github.com/expressjs/express |
| ws | MIT | https://github.com/websockets/ws |
| Vite | MIT | https://github.com/vitejs/vite |
| react-markdown | MIT | https://github.com/remarkjs/react-markdown |
| remark-gfm | MIT | https://github.com/remarkjs/remark-gfm |
| electron-builder | MIT | https://github.com/electron-userland/electron-builder |
| Agent2Agent Protocol JavaScript SDK | Apache-2.0 | https://github.com/a2aproject/a2a-js |
| Agent Client Protocol TypeScript SDK | Apache-2.0 | https://github.com/agentclientprotocol/typescript-sdk |
| Codex ACP adapter | Apache-2.0 | https://github.com/agentclientprotocol/codex-acp |
| Claude Code ACP adapter | Apache-2.0 | https://github.com/zed-industries/claude-code-acp |
| Model Context Protocol TypeScript SDK | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| Zod | MIT | https://github.com/colinhacks/zod |
| concurrently | MIT | https://github.com/open-cli-tools/concurrently |

完整、可复现的依赖版本记录在 `package-lock.json`。npm 安装保留每个依赖包自带的
许可证文件；Electron 安装包同时保留 Electron/Chromium 自带的许可证与 notices。
发布者在升级或新增依赖时必须检查其许可证兼容性，并同步更新本文件。
