# Vidu：标准 Gateway 与独立延迟展示

[返回总览](../README_ZH.md) · [Vidu 配置](vidu.zh.md) · [流程图](audio-processing-flow.zh.md)

沿用包含 #573 的双连接架构、公开 npm 导出及现有示例目录，不修改 Gateway、模型 Provider、
Agent prompt、工具注册或协议。DHAV 适配器及其真实配对媒体回执保持原有路径。

Vidu 现在是独立的展示旁路。`source-playback.mjs` 持有原始 PCM、本地音频源及回执，
默认 gain=0；原声对照开关只交换源音量与 RTC 音量、隐藏画面，不改变调度。`vidu.mjs`
把源 PCM 副本发送到示例服务端，`artc-player.mjs` 持续播放同一原生媒体元素里的音视频。

已移除在线内容对齐、双时间轴估算、静音门槛、额外播放预留、视频帧缓存，以及自然结束后
静音、摘轨、发送 interrupt 的行为。语音或按钮打断仅停止原始播放和后续旧源音频上传，
不硬切已经上传的数字人媒体。停止展示、挂断及资源过期不产生 Gateway 播放回执。

`useDualConnection` 在 Vidu 模式下不等待展示就绪才启动 Gateway。展示错误不停止 Gateway，
也不取消、延迟或补造源音频回执。展示失败后可切换原声对照继续听取回复。

## 审核范围变化

原 [#570 维护者意见](https://github.com/QwenAudio/qwen-audio-agent/pull/570#issuecomment-6336667891)
要求实际 ARTC 媒体驱动回执，以及本地立即停止、远端取消和迟到媒体隔离。本次方案主动
改变范围：Gateway 回执表示源音频时间线，数字人不参与 Agent 决策；已上传媒体允许继续。
这两点需要维护者认可，不能称为已经满足原要求。保留实验开关，默认关闭。

设计可以避免展示延迟反向改变 Agent 调度，但不能消除用户所听进度与模型上下文的差异，
也没有新增模型端历史截断能力。具体例子与建议 PR 文案见 [PR 说明](pr-description.zh.md)。

新方案的测试结果以当前旁路回归为准；历史波形匹配与真实对话报告只记录旧实现，不是新方案验收。
