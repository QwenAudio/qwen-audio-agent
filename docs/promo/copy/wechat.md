# 微信公众号文章草稿

## 标题候选

1. 我们给 AI Agent 装上了耳朵和嘴：对话继续，任务也在继续
2. 喊一声"你好千问"，你的编码 Agent 就醒了

## 正文框架

> 全文建议以产品叙事为主、技术细节为辅，配图用 docs/ 下现有 GIF
> （desktop-fluid-orb-thinking.gif / desktop-goo-orb-thinking.gif）
> 与 demo 视频截图。

### 开头：一个场景

你在厨房做饭，随口说了句"帮我把昨天那个 bug 修一下"。
桌面上的悬浮球亮起来："好，我让后台去处理。"你继续问别的事，
十分钟后它自然地说一句："已经好了。"

这就是 qwen-audio-agent 想做的事：Agent 始终在场。

### 中间：三个核心能力

1. 全双工对话：随时打断，不用等它说完
2. 任务并行：聊天和干活同时进行，结果自动回到对话
3. 唤醒词休眠：不用时安静省电，喊一声就回来

（每段配一张截图/GIF）

### 技术彩蛋（一段即可）

唤醒词完全本地运行，3M 参数的小模型，休眠时没有任何云端调用；
后台 Agent 通过开放的 ACP 协议接入，Claude Code、Codex、OpenCode
都能用。

### 结尾

项目开源（Apache-2.0），基于 Qwen/DashScope 构建：
- GitHub：https://github.com/QwenAudio/qwen-audio-agent
- 安装：npm install -g qwen-audio-agent
- 扫码加入交流群（放 wechat-group-qr.png）

## 排版注意

- 首图用 media/social-banner.png
- 视频放"对话继续，任务也在继续"那一段（README 里的演示视频）
