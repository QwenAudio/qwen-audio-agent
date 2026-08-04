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
npm test
npm run build
npm run release:check
```

提交前请确保没有把 `.env`、API Key、用户档案、任务状态、日志或后台工作目录加入
版本控制。

## Windows + WSL2 桌面开发

Windows 安装包必须使用 Windows Node.js/npm 构建。推荐在 Windows PowerShell 或
Command Prompt 中进入仓库后运行：

```bash
npm run desktop:build:win:local
```

该命令会依次构建 WebUI、生成并校验私有 WSL npm 载荷，然后输出未签名的 x64
NSIS 安装包、blockmap、`latest.yml` 和 `win-unpacked`。本地构建显式关闭证书发现，
不会发布产物。若仓库和 `node_modules` 由 WSL npm 安装，应先在 WSL 构建跨平台
资源，再只用 Windows Node.js 执行需要 Windows 工具链的打包阶段：

```bash
npm run build
npm run build:wsl-runtime-payload
repo_wsl="$PWD"
repo_win="$(wslpath -w "$repo_wsl")"
wsl_distro="${WSL_DISTRO_NAME:?run this command from WSL}"
cmd.exe /d /s /c "pushd \"$repo_win\" && node scripts\\build-windows-desktop.mjs --local --stage-output --wsl-distribution \"$wsl_distro\" --wsl-project-directory \"$repo_wsl\""
```

`--stage-output` 会先在 Windows `%TEMP%` 的本地 NTFS 目录完成 Electron 解包、
重命名和 NSIS 阶段，再让 `--wsl-distribution` 指定的发行版把本次生成的产物
同步回 `--wsl-project-directory` 下的 `dist/desktop`。这样可以避开 `pushd` 将
WSL UNC 共享映射成临时盘符后，Windows 在映射盘上执行可执行文件原子重命名
或覆盖时偶发的 `EPERM`；`dist/desktop/verification` 等非 Builder 目录会保留。

不要让 Windows npm 复用 Linux npm 生成的 `.bin`；其中没有 `vite.cmd` 等 Windows
命令垫片。也不要直接用 WSL 的 Linux Node.js 生成正式 Windows 包；Electron
Builder 的 Windows 资源编辑和 NSIS 阶段需要 Windows 运行环境或额外的 Wine
工具链。可独立检查载荷：

```bash
npm run build:wsl-runtime-payload
node scripts/verify-package.mjs
sha256sum dist/wsl-runtime/*.tgz
tar -tf dist/wsl-runtime/*.tgz
```

本地 Windows 烟测使用明确的可执行文件路径，并且脚本只停止自己启动的进程：

```powershell
wsl.exe --status
wsl.exe --list --verbose
wsl.exe -d Ubuntu -- bash -lc 'node --version; npm --version'
powershell.exe -ExecutionPolicy Bypass -File scripts/windows-smoke-test.ps1 `
  -ExecutablePath 'dist\desktop\win-unpacked\Qwen Audio Agent.exe'
```

需要验证特定 Gateway 时，可在 Windows PowerShell 使用
`Invoke-WebRequest http://127.0.0.1:<port>/api/health` 检查 Windows 到 WSL 的
localhost 转发。不得用烟测脚本执行 `wsl.exe --shutdown`、终止全局 Node 进程或
修改防火墙。

正式 Windows 构建必须从以下两种证书来源中选择一种：

```powershell
# PFX/P12 文件、Base64 内容或 electron-builder 支持的私密链接
$env:WIN_CSC_LINK = 'C:\secure\windows-release.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<从安全凭据存储读取>'
npm run desktop:build:win

# 或使用已安装到 Windows 证书存储的证书主题
$env:WIN_CSC_SUBJECT_NAME = 'Certificate subject name'
npm run desktop:build:win
```

正式命令强制 SHA-256 Authenticode 和 RFC 3161 时间戳；没有证书、PFX 缺少密码或
同时选择两种来源都会在打包前失败。证书值不得写入命令输出、仓库或测试快照。

桌面共享代码变更还必须在 macOS 运行桌面测试和本地 DMG 回归：

```bash
npm run test --workspace desktop
npm run desktop:build:local
```

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
构建 Universal macOS 桌面版，完成 Developer ID 签名和 Apple 公证；同时在
Windows runner 构建 x64 NSIS，完成 Authenticode 校验。两个平台均成功后，DMG、
EXE、blockmap 和更新元数据才会上传到 GitHub Release。

普通 PR 合并或未改变版本号的 `main` 更新不会触发发布。若发布在创建标签、上传
npm 或生成 Release 之间中断，可从 GitHub Actions 手动运行 Release 工作流，并
输入当前 `package.json` 中的版本继续；已经完成的阶段会被安全复用。仓库维护者
需预先配置 `NPM_TOKEN`，以及以下 GitHub Actions Secrets：

- `CSC_LINK`：包含证书和私钥的加密 `.p12` 文件，以 Base64 编码保存。
- `CSC_KEY_PASSWORD`：导出 `.p12` 时设置的密码。
- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`：Apple 公证凭据。
- `WIN_CSC_LINK`：Windows Authenticode PFX/P12 文件的 Base64 内容或私密下载地址。
- `WIN_CSC_KEY_PASSWORD`：Windows 证书文件密码。
