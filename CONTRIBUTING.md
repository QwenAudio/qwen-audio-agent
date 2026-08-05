# Contributing to qwen-audio-agent

感谢你帮助改进 qwen-audio-agent。

## 开发环境

需要 Node.js 22.22.2 或 24.15.0、npm 10+。使用 nvm 时：

```bash
nvm install
nvm use
npm ci
```

运行完整检查：

```bash
npm run lint
npm test
npm run build
npm run release:check
```

提交前请确保没有把 `.env`、API Key、用户档案、任务状态、日志或后台工作目录加入
版本控制。

## 变更原则

- 保持 Realtime 前台与后台 Agent 的边界，遵循 `docs/architecture.md`。
- 修复应包含覆盖失败场景的测试。
- 避免在无关变更中重排或重写大段代码。
- 新配置必须有安全默认值，并同步更新 `.env.example` 与配置文档。
- 用户可见行为变化应更新 `CHANGELOG.md`。

## Pull Request

请在 PR 中说明问题、修复方式、验证命令和兼容性影响。涉及网络、权限、持久化、
进程管理或发布流程的变更，应明确列出安全影响和回滚方式。

行为准则以友善、尊重和建设性协作为基本要求。骚扰、歧视、泄露隐私或恶意提交
不会被接受。

## 发布

根目录 `package.json` 是项目版本的唯一来源。准备发布时使用以下任一命令，
脚本会同步根包、所有 workspace 和 `package-lock.json`：

```bash
npm run version:patch                 # 0.5.0 → 0.5.1，兼容性修复
npm run version:minor                 # 0.5.0 → 0.6.0，兼容性功能
npm run version:major                 # 0.5.0 → 1.0.0，不兼容或稳定版
npm run version:set -- 0.6.0-beta.1  # 指定预发布版本
```

更新版本后必须同步维护 `CHANGELOG.md` 并运行 `npm run release:check`。发布改动
应从专用分支提交，例如 `release/0.11.0` 或 `codex/release-0.11.0`。Release PR
合并到 `main` 后，工作流会确认版本确实发生变化、版本对应的 Changelog 存在且
完整检查通过，然后自动创建 `v0.11.0` 标签、以 npm provenance 发布公共包，
构建 Universal macOS 桌面版，完成 Developer ID 签名和 Apple 公证，并将 DMG
上传到 GitHub Release。

普通 PR 合并或未改变版本号的 `main` 更新不会触发发布。若发布在创建标签、上传
npm 或生成 Release 之间中断，可从 GitHub Actions 手动运行 Release 工作流，并
输入当前 `package.json` 中的版本继续；已经完成的阶段会被安全复用。仓库维护者
需预先配置 `NPM_TOKEN`，以及以下 GitHub Actions Secrets：

- `CSC_LINK`：包含证书和私钥的加密 `.p12` 文件，以 Base64 编码保存。
- `CSC_KEY_PASSWORD`：导出 `.p12` 时设置的密码。
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：Apple 公证凭据。
