# Security Policy

## 支持范围

安全修复优先提供给最新发布版本。尚未发布的 main 分支问题会在下一个版本中修复。

## 报告安全问题

请不要公开提交包含利用细节、用户数据或密钥的 Issue。优先使用 GitHub 仓库的
**Security → Report a vulnerability** 私密报告功能：

https://github.com/QwenAudio/qwen-audio-agent/security/advisories/new

报告请包含受影响版本、复现条件、潜在影响和可行的缓解方式。维护者确认并准备好
修复前，请避免公开漏洞细节。

## 安全边界

- Gateway 默认只监听本机。可信局域网可显式使用 `--lan`；跨网络访问使用
  `--tailnet` 或带可信证书的 HTTPS 反向代理。不要将 LAN 的明文 HTTP 入口开放到公网。
- 网络可达不等于获得授权。远程客户端需要独立的设备配对凭据或访问 Token；
  设备凭据可撤销，连接码不得公开分享。自建代理还需正确转发 WebSocket、Host
  与转发头，并配置允许的浏览器 Origin，详见[远程连接与配对](docs/operations/remote-access.zh.md)。
- `QWEN_AUDIO_AGENT_AUTH_SECRET` 是身份签名密钥，不是远程访问密码。
- API Key、用户档案、记忆和任务状态必须留在用户配置目录，不得提交到仓库。
- 从不受信任来源获得的 Agent 输出、Markdown、URL 和媒体都应视为不可信数据。

## 临时构建链例外

正式发布检查同时审计生产依赖与开发/构建依赖。生产依赖存在 high 或 critical
漏洞时阻止发布；审计服务不可用时，正式发布也不会跳过检查。

当前限时例外仅针对 VitePress 1.6.4 开发服务器的间接依赖：
`GHSA-67mh-4wv8-2f99`、`GHSA-4w7w-66w2-5vf9`、`GHSA-v6wh-96g9-6wx3`、
`GHSA-fx2h-pf6j-xcff`，截至 **2026-11-30**。这些开发依赖不进入用户运行时；
文档网站部署的是静态构建产物，不应将文档开发服务器开放到不可信网络。

例外及到期检查由[依赖审计脚本](scripts/audit-dependencies.mjs)维护。
出现可用修复后应升级并移除相应例外；未批准的问题或已到期例外会阻止发布。
