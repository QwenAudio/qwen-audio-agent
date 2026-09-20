# 安装与升级

## 版本选择

- **日常使用**：选择 [GitHub Release](https://github.com/QwenAudio/qwen-audio-agent/releases/latest)
  的桌面安装包，或 npm 最新正式版。
- **测试新功能**：使用 GitHub `main` 源码。本文档跟随 `main`，不代表所有功能已包含在正式包中。
- 移动端当前使用[开发测试包](mobile.zh.md#获取测试包)，测试时尽量使用同一批代码构建的 Gateway 与客户端。

## 桌面安装

桌面安装包已包含 Gateway 及其运行环境，**不需要为了启动桌面版另装 Node.js 或 npm**。
后台 Agent 的安装、登录与配置另见[后台 Agent](../backends/overview.zh.md)。

从[正式发布页](https://github.com/QwenAudio/qwen-audio-agent/releases/latest)下载：

| 平台 | 安装方式 |
| --- | --- |
| macOS | 打开 `.dmg`，将 Qwen Audio Agent 拖入“应用程序”，再打开应用。 |
| Windows | 运行 `.exe` 安装程序，按向导完成安装。 |

首次使用见[桌面版指南](../desktop/overview.zh.md)。Linux 可[从源码构建](../desktop/overview.zh.md#安装)。

## 一键安装

以下是 **CLI / 源码** 的要求：Node.js ^22.22.2、^24.15.0 或 >=26.0.0，npm 10+。
源码仓库提供 `.nvmrc` 和 `.node-version`，使用 nvm 时可运行 `nvm use`。

安装正式版：

```bash
npm install -g qwen-audio-agent
```

安装 GitHub 最新开发代码：

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

## 从源码安装

```bash
git clone https://github.com/QwenAudio/qwen-audio-agent.git
cd qwen-audio-agent
npm ci
npm run build
```

在仓库根目录直接启动，无需全局安装：

```bash
npm run cli -- config
npm run gateway
# 另一个终端
npm run cli -- webui
```

如需在任意目录使用 `qwenaudio`，再执行 `npm run install:global`。
启动桌面开发版用 `npm run desktop`；它不是系统中已安装的正式版应用。

## 升级

桌面版在设置页检查更新，或重新下载安装包。CLI 正式版升级：

```bash
npm install -g qwen-audio-agent@latest
```

使用 GitHub 开发版时，重新执行上面的 GitHub 安装命令。升级后必须重启实际使用的
Gateway：[终端运行、后台服务、桌面版的方式不同](../operations/gateway.zh.md#修改配置后生效)。

## 验证安装

```bash
qwenaudio --version
qwenaudio config
```

前者显示已安装版本，后者显示配置路径并在缺失时创建模板；它们不能验证 API Key 或模型连通性。
配置完成后，按[快速开始](quickstart.zh.md)实际进行一次对话。

开发版提供 `qwenaudio doctor` 只读诊断；`qwenaudio setup` 检查后台安装与接入组件，
不会验证登录或额度。见[故障排查](../operations/troubleshooting.zh.md)。

## 配置文件位置

CLI 与桌面版默认共享 `~/.config/qwaudio/config.env`，运行时状态分别保存。
目录覆盖与数据说明见[配置总览](../configuration.zh.md#配置与数据目录)。

## 获取 DashScope API Key

1. 打开百炼控制台的 [API Key 页面](https://bailian.console.aliyun.com/?tab=model#/api-key)，登录并创建 Key。
2. 将 Key 填入桌面设置，或写入 `config.env` 的 `DASHSCOPE_API_KEY`。

免费额度及适用条件以[百炼官方说明](https://help.aliyun.com/zh/model-studio/new-free-quota)为准。开始前确认账户可用额度与计费设置，不要公开 Key 或提交配置文件。
