# 安装

需要 Node.js ^22.22.2、^24.15.0 或 >=26.0.0，npm 10+。使用默认的 DashScope
实时语音前台时，还需要 DashScope API Key。
仓库提供 `.nvmrc` 和 `.node-version`；使用 nvm 时可直接运行 `nvm use`。

## 一键安装

推荐从 npm 安装：

```bash
npm install -g qwen-audio-agent
```

也可以直接从 GitHub 安装最新代码：

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

## 从源码安装

```bash
git clone https://github.com/QwenAudio/qwen-audio-agent.git
cd qwen-audio-agent
npm install
npm run install:global
```

## 升级

升级到最新 npm 版本：

```bash
npm install -g qwen-audio-agent@latest
```

升级到 GitHub 最新代码：

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

升级后如果以后台服务方式运行 Gateway，需执行 `qwenaudio gateway restart` 让新版本生效。

## 验证安装

查看配置文件的准确位置并确认安装就绪：

```bash
qwenaudio config
```

配置后台 Agent 后，可运行只读检查确认后台可执行文件、ACP 接入和适配器是否就绪：

```bash
qwenaudio setup
```

## 配置文件位置

CLI 与桌面版共享 `~/.config/qwaudio/config.env`（设置、身份、记忆与共享 workspace
都在同一个用户目录下）。只有运行时状态——Gateway 进程、锁、日志与皮肤——存放在桌面版
自己的应用数据目录（macOS 为 `~/Library/Application Support/Qwen Audio Agent`），两者可以同时运行。设置 `QWAUDIO_CONFIG_DIR` 或
`XDG_CONFIG_HOME` 可以更改配置目录。详见[配置说明](../configuration.zh.md)。

## 获取 DashScope API Key

阿里云百炼为符合条件的新用户自动发放
[新人免费额度](https://help.aliyun.com/zh/model-studio/new-free-quota)，通常不需要另行领取。
可以在官方的[免费额度说明](https://help.aliyun.com/zh/model-studio/new-free-quota)中查看
领取、地域、有效期和用完即停规则，也可以打开[模型用量页面](https://help.aliyun.com/zh/model-studio/model-usage-statistics)
查看剩余额度。免费额度和计费规则可能随地域、模型及账号状态变化，请以百炼官方页面为准。

1. 打开百炼控制台的 [API Key 页面](https://bailian.console.aliyun.com/?tab=model#/api-key)，
   登录账号，单击**创建 API Key**。
2. 复制生成的 Key，稍后填入 `config.env`。请勿公开或提交 API Key。

详细说明见[获取与配置 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)；
如果账号已完成实名认证，免费额度用完后可能继续按量付费，建议按需开启免费额度用完即停。
