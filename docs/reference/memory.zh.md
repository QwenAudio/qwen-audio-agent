# 长期记忆

Gateway 通过两个逻辑文档提供记忆能力：`user` 保存用户明确设定的长期个性化，
`memory` 保存长期事实与决定。默认 Provider 将它们存为 `USER.md` 与 `MEMORY.md`；
外部 Provider 可以采用其他物理模型，但必须保持相同的公开语义。四层上下文和冲突顺序见
[个性化与记忆](personalization.zh.md)。

## 默认 Markdown Provider

`MEMORY.md` 使用普通 Markdown 保存关于用户的长期事实与决定，例如所在地、习惯、兴趣、
关系、项目、目标和计划。它只帮助理解和回答，不直接支配行为。内容来源有两种：

- **明确要求**：对话中说“记住、改成、不再”等，助手会生成精确 Markdown 修改；
  一句话中的多项信息会在同一轮逐项处理，并只生成一次最终回应。
- **自动整理**：会话结束后，一个轻量文本模型会查漏补缺，把用户明确提出的长期交互
  指令写入 `USER.md`，把稳定事实与决定写入 `MEMORY.md`。自动整理默认使用
  DashScope 的 `qwen-flash` 模型（复用 `DASHSCOPE_API_KEY`）；没有可用 API Key
  时自动关闭，明确要求的记忆不受影响。设置 `QWEN_AUDIO_MEMORY_AUTO=off`
  可全局关闭；`QWEN_AUDIO_MEMORY_MODEL`、`QWEN_AUDIO_MEMORY_BASE_URL`、
  `QWEN_AUDIO_MEMORY_API_KEY` 可指向任意 OpenAI 兼容端点（含本地 Ollama）。

Realtime 与自动整理都通过同一个记忆服务提交受限 Markdown 变更，不能直接写文件。
自动整理可以补记用户明确说出的称呼或回复偏好，但不会推测这些设定，也永远不能修改
`ASSISTANT.md`。密码、
密钥等敏感内容会被双重过滤拦截。`memory-audit.jsonl` 只记录补丁是否执行、版本和
错误等诊断信息，不保存完整记忆正文。觉得内容不对，直接在对话中说“那条记错了”
或“忘掉它”即可；助手会修改或删除对应 Markdown 原文。

## 查看、修改与删除

自动整理只学习新产生的对话，不会把重启恢复的历史重新学习，也不会因重复断线反复
处理同一批内容。通过客户端/API 或记忆工具成功修改后，修改前待学习的内容和内置
学习器的过期结果会失效。同一用户的内置学习写入与显式编辑顺序提交：已发出的写入先
完成，排队中的旧证据不会在编辑成功后写回。聊天历史仍然保留，之后的新对话仍可正常学习。
Markdown 精确编辑保留未选中的条目（包括其他章节的同文条目）；仅追加请求维持原有的
全文清理行为。

直接问“你记住了我哪些信息？”查看内容；说“把我的住址改成……”或“忘掉那条记录”
进行修改。默认实现也可直接编辑共享数据目录里的 `USER.md` 和 `MEMORY.md`，
文件编辑在下次语音会话生效，工具修改立即生效。新建对话不会清空长期记忆。

## `memory` 工具

工具操作与开发者参数见[Memory Provider](memory-provider.zh.md#memory-工具)。

## 客户端控制面

自定义客户端读写接口见[Memory Provider](memory-provider.zh.md#客户端控制面)。

## 会话摘要与回溯（默认关闭）

设 `QWEN_AUDIO_SESSION_DIGEST=on` 后，会话结束时记下这一场的话题与一句不超过 50 字的
要点，保留 90 天，供 `recall` 工具回答「前几天我们聊的那个」。

摘要**不注入** `instructions`：它每场都在变，注入会让 prompt 前缀每场都变、前缀缓存
失效。所以它是一个按需调用的工具，而不是上下文的一部分。

`recall` 只回答「以前聊过什么、派过什么活」。个人事实与偏好由 `memory` 工具读取；
用户提供的参考资料走 `knowledge` 工具（见[知识检索 Provider](./knowledge.zh.md)）。
命名清单由 `notes` 管理，不写入长期记忆，也不代表后台工作状态。

摘要里只冻结派过的活的目标，**不存状态**：状态是活的，存进摘要过几天那个值就是错的
且不会报错。状态一律在检索时从任务台账实时读；台账终态只保留 3 天，更早的活查不到
记录，此时只回答「派过这件事」而不给状态。

台账仍保留的工作会返回 `task_id`；需要最新详情时，可用它调用 `get_agent_task_status`，
包括之前会话中的工作。已清理或不可访问的记录不返回 ID，不能凭摘要猜造查询目标。

## 可选 VoiceMem 连接器

核心 npm 包只提供 Node.js `MemoryProvider` 连接器，不包含 VoiceMem 本身、Python 依赖或
Python Sidecar。按照配置示例在框架外安装后，在 `config.env` 选择即可：

```dotenv
QWEN_AUDIO_MEMORY_PROVIDER=voicemem
VOICEMEM_PYTHON=/absolute/path/to/python
VOICEMEM_SIDECAR=/absolute/path/to/voicemem-sidecar.py
VOICEMEM_INPUT_MODE=text
```

`text` 复用 Realtime 转写，`audio` 则把按用户轮次截取的音频交给 VoiceMem 自己的 ASR
和声学感知。VoiceMem 声明 `sessionObservation` 后，会完整接管 `user`、`memory`、语义
召回与会话结束学习；默认 Markdown 自动整理不会并行运行。默认数据位于用户数据目录的
`memory/voicemem/`。切回 `markdown` 不会删除 VoiceMem 数据，也不会自动把两套数据互相
迁移。外部安装、Sidecar 和百炼推荐配置见
[VoiceMem 配置示例](../scenarios/voicemem.zh.md)。

嵌入式宿主也可以直接从 `qwen-audio-agent/voicemem-provider` 导入
`VoiceMemProvider`，显式传给 `createGatewayApplication`。

## 替换记忆 Provider

接口、生命周期和可选音频观察见[Memory Provider](memory-provider.zh.md)。
Provider 切换不会自动迁移另一套存储；操作前按对应系统要求备份。

## 日志

日志采用 JSON Lines 格式，API Key、Token、Authorization、Cookie、密码和
Secret 字段会在写入前脱敏，默认不记录麦克风音频、用户转写正文、模型回复正文
或任务结果。桌面版可在“设置 → 应用 → 日志”中打开日志目录。详见
[配置说明](../configuration/advanced.zh.md#本地日志)。
