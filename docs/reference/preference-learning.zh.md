# 偏好学习机制

设 `QWEN_AUDIO_PREFERENCE_LEARNING=on` 后，会话结束时会从这一场对话里观察用户画像，
跨会话攒够确认再写进 `USER.md`。默认关闭，因为它每场会话多一次模型调用。

只观察四个字段，取值空间刻意收窄：

| 字段 | 说明 |
| --- | --- |
| `occupation` | 职业 |
| `special_skills` | 擅长的技术或领域，最多 6 项 |
| `response_length` | 回答长短，只能是 `brief`、`normal`、`detailed` 之一 |
| `response_style` | 回答风格 |

写入位置是 `USER.md` 的 `## 观察推断` 段，与 `## 用户明确要求` **物理分开**。两段冲突
时明说恒优先。这样划分是为了避免推断内容污染用户自己写下的指令 —— 用户能看到哪些是
他说过的、哪些是系统猜的，也能直接编辑或删掉后者。

### 晋升门槛

一条观察要同时满足两个条件才写进文档：`confirm ≥ 2` 且来自 **≥ 2 个不同会话**。
90 天内没有新确认则 `confirm` 归零。

### 四道结构性防护

模型有时会给出真实的引用、但从引用到结论的推理不成立。这类错误重复采样挡不住 ——
用户每场都说同一句话，模型每次同样误推，计数照样涨到门槛。所以判据放在入池那一刻：

| 判据 | 挡什么 |
| --- | --- |
| `quote_not_from_user` | 引用必须逐字出现在用户轮，挡编造证据、把助手发言当用户偏好、以及自我强化 |
| `value_not_anchored` | 结论的字面成分要能在引用里找到落点 |
| `value_parrots_quote` | 值与引用完全相同 —— 那是复读，不是提取特征 |
| `quote_not_about_interaction` | 交互偏好字段的引用必须指向助手，挡「把内容该多长当成回话该多长」 |

诊断记录写进 `memory-audit.jsonl`，可以事后查某条为什么没被收下。

用户设置方式见[个性化](personalization.zh.md)，Provider 边界见[Memory Provider](memory-provider.zh.md)。
