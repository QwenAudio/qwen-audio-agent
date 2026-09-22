# Qwen Audio Agent Memcode 集成示例

[English](README.md) | 中文

这个可选示例通过 qwen-audio-agent 的 `MemoryProvider` v2 接口接入
[Memcode](https://memcode.in/) 托管记忆服务。它复用前台已有的 `memory` 工具，
不改变默认 Gateway。通过此 Provider 提交的记忆会发送到远端服务。

## 核心能力

- **可替换记忆：** Memcode 专用代码和 SDK 依赖都位于本示例中。
- **本地快照：** 同步 `list()` 为前台 Prompt 提供 `user` 和 `memory` 文档。
- **语义回忆：** `query()` 检索相关记忆，供前台组织回答。
- **显式编辑：** `apply()` 在本地计算修改，并向 Memcode 提交自然语言更新指令。
- **Owner 检查：** 拒绝与配置的 Gateway owner 不一致的请求。

## 架构

| 组件 | 职责 |
|---|---|
| qwen-audio-agent Gateway | 语音对话、记忆工具和 Provider 生命周期。 |
| [MemcodeMemoryProvider](provider.mjs) | 本地快照，以及记忆操作到远端 API 的映射。 |
| memcode-sdk | 向独立托管的服务发送带鉴权的请求。 |
| Memcode | 远端记忆处理、存储和语义检索。 |

`apply()` 调用 `ingestV2()`，通过 `getIngestStatusV2()` 确认任务完成后才更新快照。
提交前会保存待处理操作和幂等键；超时或重启后，下一次写入或查询会先恢复该操作，
而不是盲目新建入库任务。`query()` 调用 `searchV2()`，
返回回答材料，由前台生成最终回答。当前限制见下文。

## 快速开始

使用仓库要求的 Node.js 版本。在仓库根目录执行：

```bash
npm ci
npm run build
npm ci --prefix examples/memcode
cd examples/memcode
cp .env.example .env.local
```

在 [Memcode 控制台](https://app.memcode.in/dashboard?section=api-keys&integration=qwen-audio-agent)
创建密钥，集成选择 **Qwen Audio Agent**。编辑 `.env.local`，填写密钥和语音前台配置。
使用默认前台时：

```dotenv
MEMCODE_API_URL=https://memory.memcode.in
MEMCODE_API_KEY=your_memcode_api_key
DASHSCOPE_API_KEY=your_dashscope_api_key
AGENT_PROTOCOL=none
QWAUDIO_CONFIG_DIR=.qwen-audio/runtime
PORT=3102

```

Memcode 密钥不能替代语音前台的鉴权。使用其他前台时，按该前台要求配置，
替换上面的默认前台密钥配置。
启动器在加载 Gateway 配置前关闭自动记忆提取和偏好学习，只启用显式记忆操作。

在 `examples/memcode` 目录启动 Gateway：

```bash
node --env-file=.env.local gateway.mjs
```

打开 `http://127.0.0.1:3102`，开启麦克风，让助手记住一项偏好，再新建语音会话询问
这项偏好。远端检索可能晚于本地编辑生效。按 Ctrl+C 停止服务。

## 配置与数据

默认 owner 为 `user_personal`，可通过 `QWEN_AUDIO_AGENT_PERSONAL_OWNER_ID` 调整。
远端身份由 Memcode 凭据决定；适配器不发送 `user_id` 或归因覆盖字段。

按上述方式启动时，快照保存在
`examples/memcode/.qwen-audio/runtime/memory/memcode/snapshot.json`。
启动器根据 `QWAUDIO_CONFIG_DIR` 确定此路径，相对路径以启动目录为基准。文件包含私有记忆和待处理修改，
写入时指定 `0600` 权限。不要将它或 `.env.local` 提交到仓库。

快照绑定 owner，以及服务地址与 API Key 的哈希，不保存 Key 原文。更换 Key、服务地址，
或加载旧版未绑定快照时会拒绝复用。其他账号或轮换后的密钥应使用独立配置目录；
不会静默覆盖或迁移原有状态。
远端保留策略由 Memcode 管理。

## 当前限制

- **等待有上限：** 每次写入最多等待 30 秒。超时或回执不确定时返回错误，并保留待处理
  操作供下次恢复，不报告成功。`health()` 是本地状态快照，不是远端探活。
- **远端修改仍需验证：** 替换与删除通过自然语言指令提交，不是精确的远端记录操作。
- **其他宿主接入：** `sessionObservation: false` 本身不会关闭框架的自动学习。
  不使用本启动器时，如只允许显式写入，宿主需自行关闭 `QWEN_AUDIO_MEMORY_AUTO`
  和 `QWEN_AUDIO_PREFERENCE_LEARNING`。此适配器不转发原始音频。
- **文档容量：** 建议保持默认 8,000 字符上限，与框架的 Prompt 投影一致。
  加载超限快照时会拒绝，而非截断数据。

## 测试

在 `examples/memcode` 目录执行：

```bash
npm test
```

测试覆盖编辑、失败与超时恢复、凭据绑定，以及模拟 HTTP 响应下的正式 SDK 调用。
测试不访问外部网络，不代表已验证真实服务的语义更正或删除保证。

## 作者与致谢

- [Vivek Gupta](https://github.com/vivekgupta-memcode)：在
  [PR #488](https://github.com/QwenAudio/qwen-audio-agent/pull/488) 中贡献 Memcode
  Provider 接入、示例启动器、测试和初始文档。
- [Memcode](https://memcode.in/)：提供本示例使用的托管记忆服务及 SDK。
