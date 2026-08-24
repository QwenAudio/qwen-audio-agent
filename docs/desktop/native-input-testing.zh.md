# Desktop 原生输入验证

本文严格区分“自动化原生输入证据”和“已安装 App 的真实交互结论”。原生
输入属于 Qwen Audio Agent Desktop，但安装 InputMethodKit bundle 会改变
macOS 输入源状态；未经机器所有者明确授权，不得执行人工矩阵。

## 当前状态

- Phase 0 自动化基础能力：已实现并在本机验证。
- Desktop 生命周期与 IME→Bridge→Gateway 自动化链：已使用注入式文件系统/
  输入源适配器、fake transcript 和真实 ad-hoc 签名 IME/Bridge peer 往返验证。
- 用户级安装、注册、启用和选择输入源：已在 macOS 26.5.1 arm64 上使用
  Debug/ad-hoc 构建验证。
- 跨应用 InputMethodKit 真实交互：已用 fake transcript 验证 TextEdit 与
  Safari textarea/contenteditable/password；Terminal 和更广应用矩阵仍未完成。
- 物理麦克风与 TCC 授权链路：未运行。
- 基于 Accessibility 的可选 Voice Send：未实现、未授权。
- Developer ID 签名、公证与 Release Gatekeeper：未运行。

已安装路径通过仍不等于发布验收。物理麦克风、真实 provider、Terminal、更广
目标应用、Developer ID 签名和公证仍是后续门禁。自动化生命周期测试不会复制、
注册、启用或选择输入源。

在本次 macOS 版本上，仅通过 TIS 选择 Qwen Input 不会激活可用的
InputMethodKit controller。因此首版契约明确为：用户从 macOS 输入菜单启用并
选择 Qwen Input，使用原生听写期间保持选中；物理键盘始终透传。从其他输入源
启动会以 `input_source_selection_required` 可见失败，且不会改变系统输入源。

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
- status/install/repair/uninstall 请求关联，symlink/owner/签名/版本拒绝，原子替换
  回滚，只注册不启用，以及卸载时先 disable 再移到废纸篓；
- 真实签名 IME peer 注册目标、轮询一次相关 operation、通过 Bridge 返回结果并清理
  临时 socket；renderer 测试覆盖 ownership/suspend、空草稿 Gateway 启动、终态迟到
  消息拒绝与原生失败取消。

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

下表结果来自 macOS 26.5.1 arm64、版本 1.11.0 Debug/ad-hoc 产物和非敏感
fake transcript。正式签名与未列为通过的场景仍未验证。

| 范围 | 场景与预期 | 状态 |
| --- | --- | --- |
| 安装 | 用户级安装拒绝符号链接、错误属主/签名，且不弹管理员密码 | 通过（Debug/ad-hoc） |
| 启用 | 用户明确启用并选择 Qwen Input，Desktop 均不得静默代办 | 通过 |
| TextEdit / Notes | partial 有 marked 样式，final 落在光标处，物理打字不被吞 | TextEdit 通过 |
| Safari textarea | partial/final/edit 始终锁定同一目标 | 通过 |
| Safari contenteditable | UTF-16 范围和光标移动行为确定 | 通过 |
| Safari 密码框 | secure 字段拒绝启动，零写入、零采集 | 通过 |
| Terminal | 普通提示符可插入，键盘输入始终可用 | 未运行 |
| Terminal 安全输入 | Secure Keyboard Entry 立即阻止或终止会话 | 未运行 |
| VS Code / Monaco | marked/final 兼容；不兼容时可见失败且不写错目标 | 未运行 |
| Mail / Messages | 保留原草稿和选区 | 未运行 |
| 自绘控件 | 未知/不支持控件 fail closed | 未运行 |
| 焦点切换 | 目标代次改变，移除 partial，不向新焦点写入 | 通过 |
| 键盘/鼠标打断 | 自有 partial 确定性结算或移除，并暂停采集 | 未运行 |
| 输入源变化 | 不覆盖用户外部选择；macOS 会把活跃 marked partial 结算在旧目标 | 通过（平台行为已记录） |
| Bridge/Desktop 崩溃 | 停止采集、移除 partial、无孤儿进程/socket，替代 Bridge 可重连 | Bridge SIGTERM 通过 |
| 麦克风拒绝/撤权 | 可见失败，provider 音频、conversation、Memory 均零副作用 | 未运行 |
| 网络/provider 失败 | 回到普通键盘，不回退主 Realtime | 未运行 |
| continuous/pause/cancel | 暂停期间上行字节为 0，取消无未提交副作用 | 未运行 |
| Memory 纠正 | 只做精确、非敏感事实替换，审计仅含元数据 | 未运行 |
| 更新/回滚 | 活跃会话先 drain、输入源由用户持有、版本匹配、可回滚 | 安装/修复事务通过；发布更新未运行 |
| 禁用/卸载 | 禁用输入源、bundle 移入废纸篓、清除运行产物 | Debug/ad-hoc 生命周期通过 |
| 孤立修复 | 无合格 Desktop/Bridge 时输入法惰性失效，且可修复 | 未运行 |
| 架构 | arm64 与 x86_64/Rosetta 均验证 | universal 二进制通过；仅 arm64 运行时通过 |

## 清理证据

获批执行后，要确认 Qwen Input 已不再选中、原输入源已恢复、Bridge 与
Desktop 测试进程均退出、运行 socket 不存在，并删除测试安装、profile 和
音频。对仓库、运行目录和测试日志只做凭据模式扫描，不得打印凭据值。
