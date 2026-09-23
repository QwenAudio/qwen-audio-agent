# 客服语音助手

客服示例将 qwen-audio-agent 用于零售和航空服务：语音前台负责对话、身份核验和查询，
需要执行业务操作时通过 A2A 交给后台 Agent。前后台分别通过 MCP 访问同一个业务服务；
资格、金额、库存和授权由服务校验，而不是让模型自行判断。

## 演示

视频展示了客户通过语音取消订单：核验身份、查询订单、听取退款预览，明确同意后再提交。

<video controls playsinline preload="metadata" poster="https://raw.githubusercontent.com/QwenAudio/qwen-audio-agent/main/examples/customer-service/assets/customer-service-demo-poster.jpg" style="width: 100%; border-radius: 12px;">
  <source src="https://github.com/user-attachments/assets/e0f9fefa-f24b-47e5-bc2c-8402fc107df4" type="video/mp4">
</video>

## 核心特点

- 零售场景支持订单查询、取消、退货和地址变更；航空场景支持预订查询、退票、改签、改舱等。
- 前台 MCP 处理身份核验和只读查询；需要批准的写操作由后台 Agent 执行。两面共享业务状态与规则。
- 写操作先提供预览，客户明确同意后才提交；拒绝、取消或超时不会执行原操作。
- 客服工作台展示通话和业务状态，人工坐席台接收转人工上下文；Policy 配置台可检查和调整示例规则。

## 架构

| 组件 | 职责与接口 |
|---|---|
| `client/` | 客服工作台；采集和播放语音，通过 Gateway 客户端协议进行对话。 |
| `gateway/` | 语音前台、核验与查询工具、场景人设；通过 A2A 委托业务任务。 |
| `agent/` | 后台 Agent；执行多步骤业务操作，并处理客户批准的等待与恢复。 |
| `service/` | 零售或航空业务状态、规则及前后台 MCP 工具面。 |
| `desk/`、`console/` | 人工坐席展示与可选的 Policy 配置台，不在语音通话的关键路径上。 |

## 运行示例

在仓库根目录安装依赖，参考
[`examples/customer-service/.env.example`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/customer-service/.env.example)
创建 `examples/customer-service/.env.local`，至少填写有模型访问权限的 `DASHSCOPE_API_KEY`。
后台 Chat Completions 和前台 Realtime 使用不同接口。

```bash
npm install
npm run example:customer-service:install
npm run example:customer-service           # 零售
# 或：npm run example:customer-service:airline  # 航空
```

打开零售客服工作台 `http://127.0.0.1:4620`；航空工作台为 `http://127.0.0.1:4720`，
并允许麦克风访问。先核验身份，再查询订单或预订；尝试取消或改签时，可以分别测试
“不同意”和“同意”，观察业务状态是否仅在明确批准后改变。

本例面向本地单通话演示，不是生产客服系统，也不是完整的官方 τ-bench 实现。
完整配置、演示步骤、已知限制与测试命令见
[示例 README](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/customer-service/README_ZH.md)；
可选评测接口见 [Benchmark 说明](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/customer-service/benchmark/README.md)。
