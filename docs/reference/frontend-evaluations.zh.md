# 前台 Runtime 评测

确定性前台评测保护 qwen-audio-agent 不依赖 Realtime 模型或供应商也能保证的运行时边界：

| 维度 | 不变量 |
| --- | --- |
| 路由 | Search、URL Fetch、可选 Knowledge 检索、后台 Task 和客户端控制保持为独立的能力门控工具。 |
| 引用 | 来源在单轮内获得稳定 ID；重复 URL 保持同一身份；不安全 URL 被丢弃；最终 Citation 只消费一次。 |
| 打断 | 用户打断后到达的音频和转写会被抑制，打断事件只投射一次。 |
| 重复播报 | Presentation 前的重复完成信号会合并，重复确认也不会让同一 Task 再次生成 Presentation。 |
| Prompt Injection | Search 和 Knowledge 内容始终是不可信数据，携带明确提示，也不能改变已注册的工具面。 |

运行命令：

```bash
npm run eval:frontend
```

通过 `npm run eval:frontend -- --json` 可获得机器可读报告。同一套评测也会从 Server 测试
执行，因此自动进入 `release:check` 和 CI。

评测直接驱动生产 Runtime 组件，不会另写一套路由、Presentation 或 Citation 逻辑。
它不发起外部请求，也不调用语言模型，因此能在所有支持的操作系统上快速、稳定复现。

这套门禁不宣称衡量供应商模型的语义质量，例如某个模型面对自然语言时选择理想工具的
概率。后续线上模型评测可以复用这些维度，但由于需要凭据、成本和统计阈值，不进入确定性
发布门禁。
