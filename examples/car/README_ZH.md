# Qwen Audio Agent Car

[English](README.md) | 中文

这是一个基于 qwen-audio-agent 三层框架重新实现的智能座舱参考场景。它保留原座舱面板的主要视觉和交互，但不再自建 Realtime、对话历史或 Agent Loop。

示例中的座舱 UI 和座舱 Agent 都是可替换样例，不是框架强制模块。真正复用的框架能力是 Gateway、前台实时对话、GCP Client SDK、BackendPort、A2A 和 MCP 接缝。

## 快速开始

在仓库根目录执行：

```bash
cp examples/car/.env.example examples/car/.env.local
```

至少填写：

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
```

高德地图和路线服务可按需填写 `VITE_AMAP_KEY`、`VITE_AMAP_SECRET` 与 `AMAP_MCP_KEY`。然后安装示例依赖并一键启动：

```bash
npm run example:car:install
npm run example:car
```

浏览器打开 `http://localhost:5173`。该命令同时启动：

| 进程 | 默认地址 | 职责 |
|---|---|---|
| cockpit-client | `http://127.0.0.1:5173` | 场景 UI、浏览器音频 I/O、业务面板 |
| cockpit-gateway | `http://127.0.0.1:18888` | 前台实时对话、工具、任务、播报、打断和恢复 |
| cockpit-agent | `http://127.0.0.1:3020` | 轻量、可替换的 A2A 后台示例 |
| cockpit-domain | `http://127.0.0.1:3010` | 单一业务状态、HTTP/SSE 与 MCP 能力 |

按 `Ctrl+C` 会一起关闭四个进程。

启动前会一次性检查 Realtime 配置和四个默认端口；缺少 Key 或存在旧实例时会给出明确提示，不会再让四个子进程分别输出错误堆栈。

## 边界

- UI 仅通过 GCP 与 Gateway 对话，不感知 Realtime Provider 或后台 Agent。
- UI 通过场景自己的 HTTP/SSE 通道展示车辆、路线、音乐、天气和订单状态；Gateway 不解析这些对象。
- 前台 Agent 负责实时聊天，座舱任务通过固定的 `spawn_thinking` 桥梁提交给后台。
- 示例后台通过 A2A 接入 Gateway，并通过 MCP 调用领域能力；它只实现少量意图路由，不模拟完整行业 Agent。
- 客户可以替换整个 UI、后台 Agent 或领域服务，而不修改框架核心。

## 开发与测试

```bash
npm run example:car:lint
npm run example:car:build
npm run test:car
```

更多说明：

- [架构与数据流](docs/architecture.md)
- [替换 UI、Agent 或领域服务](docs/replacing-components.md)
- [测试矩阵](docs/test-matrix.md)
