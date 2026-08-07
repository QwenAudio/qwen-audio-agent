# 桌面版

桌面版提供常驻桌面的语音悬浮球，并内置 Gateway，无需事先启动服务。同一用户配置
目录已有本地 Gateway 时会直接连接并以其当前运行配置为准，否则由桌面版自动启动和管理。首次运行时，
应用会创建配置文件，并引导你在设置页填写 DashScope API Key、选择后台 Agent
（也可以使用仅前台模式）。

## 悬浮球与自动休眠

闲置后悬浮球会自动隐藏并断开实时语音；也可以直接说“可以退下了”让它隐藏。应用仍
常驻菜单栏，可从菜单栏或显示快捷键重新唤出。默认快捷键为 `⇧⌘ Space`，也可以在
应用设置中更换。

休眠超时与自动隐藏合并为统一的“自动休眠”设置：休眠期间麦克风保持本地监听，说出
唤醒词“你好千问”即可恢复对话。后台 Agent 和已提交任务不会因休眠停止，任务结果
会在唤醒后播报。首次启用唤醒词时会自动下载并校验约 33 MB 的
[`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) 中英文 KWS 模型，之后直接使用本地缓存。

## 外观

桌面版支持流光声波球和液态渐变球两种外观。下面分别展示它们在思考 / 呼吸状态
下的原始动态效果：

| 流光声波球 | 液态渐变球 |
| --- | --- |
| ![流光声波球思考动画](../desktop-fluid-orb-thinking.gif) | ![液态渐变球思考动画](../desktop-goo-orb-thinking.gif) |

## 皮肤

除内置外观外，悬浮球还支持
[Codex pet](https://github.com/legeling/awesome-codex-pet) 包格式的精灵皮肤：
一个包含 `pet.json` 与 `spritesheet.webp` 的目录（8 列网格，v1 为
1536x1872 共 9 行，v2 为 1536x2288 共 11 行）。Codex pet 生态的素材无需
任何转换即可使用，也不要求安装 Codex。

导入已下载好的皮肤：打开“设置 → 应用 → 外观”，点击“导入皮肤…”，选择
皮肤文件夹、其中的 `pet.json` 或 zip 压缩包。导入的皮肤存放在桌面版数据
目录的 `skins/` 下，与内置外观一起出现在外观下拉框中；选中已导入的皮肤时
可用旁边的“删除”按钮移除，内置外观不可删除。

悬浮球会把语音与任务状态映射为宠物动作：听你说话时专注等待，思考时低头审阅，
说话或唤醒露面时挥手，后台任务执行中持续向左奔跑，任务等待你确认时持续跳跃
求关注，语音被其他前台占用时奔跑，出错时呈现失败姿态；对话态始终优先于
后台态。皮肤包只包含静态资源（JSON + WebP），导入时会校验格式与尺寸；若选中的
皮肤包被删除，悬浮球会自动回退到内置外观。

## 安装

从发布页下载对应平台的安装包：

- **macOS**：下载 `.dmg`，打开后将 **Qwen Audio Agent** 拖入"应用程序"。
- **Windows**：下载 `.exe` 安装程序，双击运行并按向导完成安装。

从源码生成本机测试版：

```bash
npm run desktop:build:local      # macOS
npm run desktop:build:win        # Windows
npm run desktop:build:linux      # Linux（AppImage + deb，无需签名）
```

产物位于 `dist/desktop/`。

## 数据目录与隔离

桌面版使用系统标准应用数据目录（macOS 为
`~/Library/Application Support/Qwen Audio Agent`，Windows 为
`%APPDATA%/Qwen Audio Agent`，Linux 为
`~/.config/Qwen Audio Agent`），与 CLI 的 `~/.config/qwaudio` 完全隔离。
两者的 Gateway、锁、日志与设置互不干扰，可以同时运行。桌面版首次启动时会从
CLI 目录复制 `config.env` 等用户配置（CLI 保留原件）。

## 自动更新与日志

设置页显示当前版本并可手动检查更新，发现新版本后台差量下载，完成后一键重启安装。

桌面版可在“设置 → 应用 → 日志”中打开日志目录，与 Gateway 一起记录结构化
JSONL 日志，凭据自动脱敏并自动轮转。日志配置详见
[配置说明](../configuration.zh.md#本地日志)。
