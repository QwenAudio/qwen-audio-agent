# Qwen Audio Agent Car

[English](README.md) | 中文

这是 qwen-audio-agent 在智能座舱领域的可运行落地示范。它使用框架公开能力
重新实现完整座舱链路，并在边界合适的地方复用早期座舱原型的 UI 代码和视觉资源，
以节约实现成本。它不是对旧 Demo 的迁移或兼容改造，也没有自建第二套 Realtime、
对话历史或 Agent Loop。

qwen-audio-agent 的基础边界是“前台对话 + 后台执行”两层。示例中的座舱 UI 是前台的
可替换客户端组件，座舱 Agent 是可替换后台；二者都不是框架强制实现。真正复用的
框架能力是 Gateway、前台实时对话、GCP Client SDK、BackendPort、A2A 和 MCP 接缝。
后台 Agent 可以按需派生独立 Session，扩展出第三层执行空间；当前轻量座舱 Agent
没有实现这项可选能力。

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

| 进程 | 默认地址 | 架构归属 | 职责 |
|---|---|---|---|
| cockpit-client | `http://127.0.0.1:5173` | 前台客户端组件 | 场景 UI、浏览器音频 I/O、业务面板 |
| cockpit-gateway | `http://127.0.0.1:18888` | 前台对话核心 | 实时对话、前台工具、任务桥梁、播报、打断和恢复 |
| cockpit-agent | `http://127.0.0.1:3020` | 后台执行示例 | 轻量、可替换的 A2A 座舱 Agent |
| cockpit-domain | `http://127.0.0.1:3010` | 场景基础设施（非额外层） | 单一业务状态、HTTP/SSE 与 MCP 能力 |

按 `Ctrl+C` 会一起关闭四个进程。

启动前会一次性检查 Realtime 配置和四个默认端口；缺少 Key 或存在旧实例时会给出明确提示，不会再让四个子进程分别输出错误堆栈。

## 边界

- 前台由座舱客户端和 Gateway/Realtime 对话中控组成；两者是一个前台层内的
  组件边界，不是两个 Agent 层。
- UI 仅通过 GCP 与 Gateway 对话，不感知 Realtime Provider 或后台 Agent。
- 主座舱区域保持纯语音交互；文字转写只进入调试面板，并且 ASR 仅展示最终结果。
- UI 通过场景自己的 HTTP/SSE 通道展示车辆、路线、音乐、天气和订单状态，以及细粒度场景进度；Gateway 不解析这些对象。
- 前台 Agent 负责实时聊天，可通过标准 MCP 直接调用只读天气工具；其他座舱任务通过固定的 `spawn_thinking` 桥梁提交给后台。
- 示例后台通过 A2A 接入 Gateway，并通过独立的后台 MCP 工具面调用车控、导航、音乐和闪购；它只实现少量意图路由。
- 后台 Agent 如何调用工具和组织工作是后台内部实现；若创建独立派生 Session，
  可以形成由后台扩展出的第三层执行空间，不改变前台协议。
- 场景工具按领域收敛在 [`tools/`](tools/README.md)，开发者通过显式注册表增加工具包或调整前后台归属，不需要修改 Gateway 协议。
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
