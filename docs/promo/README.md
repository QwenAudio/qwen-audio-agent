# 宣传物料库（Promo Materials）

本目录存放项目推广用的文章、文案与图片素材，**纯新增内容，
不涉及任何用户可见的产品文档或代码**。

## 目录结构

```
docs/promo/
├── articles/                     # 技术文章（基于真实实现撰写，面向开发者）
│   ├── full-duplex-voice-frontend.md     # 中文：全双工语音前台设计
│   ├── acp-decoupling.md                 # 中文：ACP 解耦架构实践
│   ├── wake-word-engineering.md          # 中文：本地唤醒词工程实现
│   └── voice-runtime-for-ai-agents-en.md    # 英文旗舰稿（HN/Gist 用）
├── beginner/                     # 小白向内容（面向桌面端普通用户）
│   ├── quickstart.md                     # 中文：3 分钟上手指南
│   ├── quickstart-en.md                  # 英文：Getting started
│   ├── use-cases.md                      # 使用场景故事
│   └── faq.md                            # 新手常见问题
├── copy/                         # 各渠道文案草稿
│   ├── show-hn.md                        # Show HN 帖子与预答 FAQ
│   ├── reddit.md                         # r/ClaudeAI 等板块帖子
│   ├── v2ex.md                           # V2EX 分享创造帖
│   ├── xiaohongshu.md                    # 小红书/生活类社区文案
│   ├── wechat.md                         # 微信公众号文章框架
│   ├── awesome-claude-code-submission.md # 列表推荐表单草稿（需人工提交）
│   └── release-notes-v1.5.md             # v1.5.0 Release Notes 中英稿
└── media/                        # 宣传图
    └── social-banner.png         # 社交分享封面图（16:9）
```

## 使用约定

- 定位口径：实时语音运行时（realtime voice runtime for AI
  agents），不说"编码 Agent 的语音接口/语音层"；编码 Agent
  只是可接入的后台之一，面向具体社区时可作场景示例而非产品定义；
- 品牌口径：对外统一"全双工实时语音的社区开源项目"，不强调 Qwen
  关联、不宣称官方出品，唤醒词不提具体词内容；技术栈披露
  （基于 Qwen/DashScope 构建）仅限仓库内公告；
- beginner/ 目录面向不懂代码的普通用户，写作原则见 [beginner/README.md](beginner/README.md)；
- 文章转载请注明仓库链接；
- 新增物料按上述结构归类，本文件同步更新。
