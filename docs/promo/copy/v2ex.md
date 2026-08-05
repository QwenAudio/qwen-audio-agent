# V2EX 帖子草稿（节点：分享创造）

## 标题

给 Claude Code / Codex 装上全双工语音：干活的时候对话不断线

## 正文

各位好，分享一个开源项目 qwen-audio-agent，给编码 Agent 做的实时语音前台。

做这个东西的原因：用语音驱动 Claude Code 时，它一开始读文件、调工具，
对话就死了，只能干等。我想要的是"它在干活，我们还能继续聊"。

实现上的几个点：

- 全双工 + 打断：随时开口打断，播放队列和生成中的回复会被显式取消，
  被取消的响应留 tombstone，防止迟到的异步事件把它复活（这块踩了不少坑）
- 前台/后台分工：能直接答的由前台模型秒回；要调工具的委派给后台
  Agent 异步跑，任务完成后自然回到对话里，可以接着追问
- 走 ACP 协议接入，Claude Code/Codex 用适配器，OpenCode/Qoder/Kimi 原生，
  接一个新 Agent 就是加一个 driver 文件，语音层零改动
- 桌面悬浮球（macOS，Linux 刚支持），还有 TUI 和 WebUI
- 唤醒词：空闲休眠后麦克风保持开着，本地 sherpa-onnx 3M 模型监听，
  休眠期间没有任何云端调用

技术栈 Node.js，语音默认走 DashScope 实时接口，也接了 speech-to-speech
支持全本地部署。测试覆盖比较全（600+ 用例）。

仓库：https://github.com/QwenAudio/qwen-audio-agent
npm 一行安装：npm install -g qwen-audio-agent

欢迎拍砖，特别是语音播报的啰嗦程度问题，我们还在调。

## 注意

- 发布后前 2 小时保持在线，认真回复每条技术提问
- 不顶帖、不拉票
