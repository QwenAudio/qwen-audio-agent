# Desktop 原生输入验证

本文严格区分“自动化原生输入证据”和“已安装 App 的真实交互结论”。原生
输入属于 Qwen Audio Agent Desktop，但安装 InputMethodKit bundle 会改变
macOS 输入源状态；未经机器所有者明确授权，不得执行人工矩阵。

## 当前状态

- Phase 0 自动化基础能力：已实现并在本机验证。
- 用户级安装、注册、选择输入源：未运行。
- 跨应用 InputMethodKit 真实交互：未运行。
- 物理麦克风与 TCC 授权链路：未运行。
- 基于 Accessibility 的可选 Voice Send：未实现、未授权。
- Developer ID 签名、公证与 Release Gatekeeper：未运行。

自动化通过不等于“全局听写已经可供用户使用”。生产 IME→Bridge 操作路由、
Desktop 安装/设置生命周期、Gateway 音频路由和已安装 App 矩阵仍是后续门禁。

## Phase 0 自动化门禁

在 macOS 仓库根目录运行：

```sh
npm run native-input:test
node --test desktop/test/native-input-*.test.mjs
npm test
npm run lint
npm run build
npm run test:desktop-smoke
git diff --check
```

原生测试覆盖：

- 协议版本、序号、代次、目标、重放和 64 KiB 上限；
- UTF-16 自有 marked/final 范围，包括 emoji 和组合字符；
- 替换/删除只能作用于最近一次本会话已确认文本；
- Secure Event Input 与可见状态门禁的 fail-closed 行为；
- InputMethodKit 客户端调用，以及物理按键不被吞掉；
- 精确进程身份、同用户检查、0700 运行目录和 0600 Unix socket；
- 原输入源 compare-and-set 恢复；
- Desktop 持有 Bridge、环境变量白名单、紧急停止和有界退出；
- 用真实构建出的 Bridge 进程验证 fake partial/final/pause/resume/cancel、
  畸形帧拒绝、EOF 清理和零运行文件残留。

打包门禁还要求：

```sh
npm run native-input:build:release
lipo -archs dist/native-input/QwenInputBridge
lipo -archs "dist/native-input/Qwen Input.app/Contents/MacOS/Qwen Input"
codesign --verify --strict \
  -R='identifier "ai.qwenaudio.agent.inputbridge"' \
  dist/native-input/QwenInputBridge
codesign --verify --deep --strict \
  -R='identifier "ai.qwenaudio.agent.inputmethod"' \
  "dist/native-input/Qwen Input.app"
```

两个原生产物都必须同时包含 `arm64` 与 `x86_64`。本地构建使用 ad-hoc
签名，只能证明构建和完整性，不能代替正式签名、公证与 Gatekeeper 验收。

## 授权边界

人工验证前必须逐项取得明确授权：

1. 把版本匹配的 bundle 复制到 `~/Library/Input Methods`；
2. 注册输入法，并由用户在系统设置中手动启用 Qwen Input；
3. 在测试应用中临时选择该输入源；
4. 启动打包后的 Desktop 并请求麦克风权限；
5. 若另行测试 Voice Send，再单独请求 Accessibility 权限。

基础听写不得申请 Accessibility、Input Monitoring、Full Disk Access 或
管理员权限。人工测试只使用非敏感测试文本。

## 已安装 App 人工矩阵

在单独获批之前，下表每一项均保持 **未运行**。每次执行必须记录系统版本、
CPU 架构、App/IME/Bridge 版本、结果和清理证据。

| 范围 | 场景与预期 | 状态 |
| --- | --- | --- |
| 安装 | 用户级安装拒绝符号链接、错误属主/签名，且不弹管理员密码 | 未运行 |
| 启用 | 用户明确启用 Qwen Input，Desktop 不得静默启用 | 未运行 |
| TextEdit / Notes | partial 有 marked 样式，final 落在光标处，物理打字不被吞 | 未运行 |
| Safari textarea | partial/final/edit 始终锁定同一目标 | 未运行 |
| Safari contenteditable | UTF-16 范围和光标移动行为确定 | 未运行 |
| Safari 密码框 | secure 字段拒绝启动，零写入、零采集 | 未运行 |
| Terminal | 普通提示符可插入，键盘输入始终可用 | 未运行 |
| Terminal 安全输入 | Secure Keyboard Entry 立即阻止或终止会话 | 未运行 |
| VS Code / Monaco | marked/final 兼容；不兼容时可见失败且不写错目标 | 未运行 |
| Mail / Messages | 保留原草稿和选区 | 未运行 |
| 自绘控件 | 未知/不支持控件 fail closed | 未运行 |
| 焦点切换 | 目标代次改变，移除 partial，不向新焦点写入 | 未运行 |
| 键盘/鼠标打断 | 自有 partial 确定性结算或移除，并暂停采集 | 未运行 |
| 输入源变化 | 用户外部切换输入源后，恢复逻辑不得覆盖用户选择 | 未运行 |
| Bridge/Desktop 崩溃 | 停止采集、移除 partial、无孤儿进程/socket | 未运行 |
| 麦克风拒绝/撤权 | 可见失败，provider 音频、conversation、Memory 均零副作用 | 未运行 |
| 网络/provider 失败 | 回到普通键盘，不回退主 Realtime | 未运行 |
| continuous/pause/cancel | 暂停期间上行字节为 0，取消无未提交副作用 | 未运行 |
| Memory 纠正 | 只做精确、非敏感事实替换，审计仅含元数据 | 未运行 |
| 更新/回滚 | 活跃会话先 drain、恢复输入源、版本匹配、可回滚 | 未运行 |
| 禁用/卸载 | 禁用输入源、bundle 移入废纸篓、清除运行产物 | 未运行 |
| 孤立修复 | 无合格 Desktop/Bridge 时输入法惰性失效，且可修复 | 未运行 |
| 架构 | arm64 与 x86_64/Rosetta 均验证 | 未运行 |

## 清理证据

获批执行后，要确认 Qwen Input 已不再选中、原输入源已恢复、Bridge 与
Desktop 测试进程均退出、运行 socket 不存在，并删除测试安装、profile 和
音频。对仓库、运行目录和测试日志只做凭据模式扫描，不得打印凭据值。
