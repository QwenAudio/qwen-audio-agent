# Qwen Audio Agent Memcode 示例

[English](README.md) | 中文

这个可选示例通过 qwen-audio-agent 公开的 `MemoryProvider` v2 边界注入
Memcode。默认 Gateway 不会因此增加凭据或网络请求。

## 行为

- 用户明确调用 `memory` 工具进行追加、替换或删除时，Provider 先向 Memcode
  个人 v2 持久化接口提交同一项权威变更，成功受理后再更新权限为 `0600` 的本地快照。
- 自然语言记忆读取使用 Memcode 语义搜索。
- Realtime Prompt 的同步 `list()` 只读取有界的本地快照。
- Memcode 凭据决定个人身份；Provider 只接受配置好的 Gateway owner，不发送
  `user_id` 或归因覆盖字段。
- 默认不观察完整对话或音频。普通聊天不会自动写入记忆。

## 从源码运行

```bash
cd examples/memcode
npm install
cp .env.example .env.local
# 编辑 .env.local，填写 MEMCODE_API_KEY
node --env-file=.env.local gateway.mjs
```

随后打开 qwen-audio-agent 输出的 Gateway 地址。其余安装和前台配置仍按项目文档完成。

## 隔离、保留与失败行为

默认 owner 为 `user_personal`。出现其他 owner 时会在请求 Memcode 前失败，避免把一个
个人 API Key 当作跨用户兜底。多用户部署应为每个已认证 owner 建立独立的 Provider
与凭据绑定。

可精确编辑的 `user` 与 `memory` 文档保存在
`.qwen-audio/runtime/memory/memcode/snapshot.json`。文件权限为 `0600`，其中含有记忆
内容，应与 Gateway 的其他私有状态同等保护。远端保留策略由 Memcode 管理。只有远端
受理 ingest 后才修改本地快照，因此鉴权、网络或 Provider 错误都会让写入失败关闭。
Ingest 为异步流程，已受理的更正可能会在短时间内出现“本地文档已更新、语义检索仍是
旧版本”的情况。

Provider 不记录凭据、远端原始错误或记忆正文，也不发送集成归因字段；归因由 Memcode
服务端根据凭据分配。

## 测试

```bash
npm test
```

测试注入假的 Memcode Client，不会发送网络请求。
