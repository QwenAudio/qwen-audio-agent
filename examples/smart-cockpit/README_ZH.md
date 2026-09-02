# Qwen Audio Agent 智能座舱示例

[English](README.md) | 中文

![智能座舱框架架构图](docs/framework-architecture.svg)

这是 qwen-audio-agent 在智能座舱领域的可运行落地示范。它使用框架公开能力
重新实现完整座舱链路，并在边界合适的地方复用早期座舱原型的 UI 代码和视觉资源，
以节约实现成本。它不是对旧 Demo 的迁移或兼容改造，也没有自建第二套 Realtime
或前台对话历史；后台模型循环只存在于可替换的 `agent/` 进程中。

qwen-audio-agent 的基础边界是“前台对话 + 后台执行”两层。示例中的座舱 UI 是前台的
可替换客户端组件，座舱 Agent 是可替换后台；二者都不是框架强制实现。真正复用的
框架能力是 Gateway、前台实时对话、GCP Client SDK、BackendPort、A2A 和 MCP 接缝。
后台 Agent 可以按需派生独立 Session，扩展出第三层执行空间；仓库自带示例则使用
紧凑的 Qwen3.8-Flash 工具调用循环。

## 目录职责一览

| 目录 / 进程 | 默认地址 | 角色与契约 | 什么时候修改 |
|---|---|---|---|
| [`client/`](client/) / cockpit-client | `http://127.0.0.1:5173` | 可替换的前台客户端。对话走 GCP，业务面板走场景 HTTP/SSE。 | 替换座舱 UI、浏览器音频 I/O 或面板交互时。 |
| [`gateway/`](gateway/) / cockpit-gateway | `http://127.0.0.1:18888` | 前台 Agent 与 Gateway 的场景装配；可信人设、前台 Profile 和 `spawn_thinking` 描述都归这里。 | 更换协议 Adapter、前台 Prompt 或场景装配时；不在这里实现业务逻辑。 |
| [`agent/`](agent/) / cockpit-agent | `http://127.0.0.1:3020` | 可替换、由模型驱动的 A2A 后台示例。Qwen3.8-Flash 规划任务并调用后台 MCP 工具面。 | 替换或扩展示例后台 Agent 时。 |
| [`service/`](service/) / cockpit-service | `http://127.0.0.1:3010` | 座舱环境与基础设施：集中管理场景状态、业务规则、外部服务适配和 [`tools/`](service/tools/) 能力契约，并向 UI、前台和座舱 Agent 提供受限接口。 | 增加座舱能力、业务状态、校验或外部服务接入时。 |
| [`bootstrap/`](bootstrap/) | — | 四个进程共用的环境加载与启动预检。 | 调整本地示例的启动条件或端口检查时。 |

常见修改应保持局部化：

- **想换后台 Agent：**将 `COCKPIT_AGENT_CARD_URL` 指向自己的 Agent；如果修改
  仓库自带示例，只动 [`agent/`](agent/)。客户端、Gateway 核心和座舱服务契约
  都不需要变化。
- **想加场景能力：**在 [`service/tools/`](service/tools/) 实现并注册；需要新增状态、规则或
  外部服务适配时再修改 `service/` 的其他模块。若要作为前台低延迟工具暴露，再更新
  `gateway/frontend-mcp.json`。不要把业务执行分支写入 Gateway 或客户端。
- **想换座舱 UI：**只替换 [`client/`](client/)，继续遵守 GCP 和场景状态契约。
- **想改前台人设：**修改 [`gateway/assistant/`](gateway/assistant/) 中对应的 Markdown。
  新增选项时，再分别增加 Gateway 白名单和 `client/src/config/personas.js` 的客户端展示项；
  两者只通过场景事件 ID 对齐，不互相 import 实现。

## 快速开始

在仓库根目录执行：

```bash
cp examples/smart-cockpit/.env.example examples/smart-cockpit/.env.local
```

至少填写：

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
```

后台 Agent 默认使用 `qwen3.8-flash` 并开启思考模式；需要时可通过 `DASHSCOPE_MODEL` 覆盖。

高德地图和路线服务可按需填写 `VITE_AMAP_KEY`、`VITE_AMAP_SECRET` 与 `AMAP_MCP_KEY`。然后安装示例依赖并一键启动：

```bash
npm run example:smart-cockpit:install
npm run example:smart-cockpit
```

浏览器打开 `http://localhost:5173`。该命令会同时启动上表中的四个进程。

按 `Ctrl+C` 会一起关闭四个进程。

启动前会一次性检查 Realtime 配置和四个默认端口；缺少 Key 或存在旧实例时会给出明确提示，不会再让四个子进程分别输出错误堆栈。

## 边界

- 前台由座舱客户端和 Gateway/Realtime 对话中控组成；两者是一个前台层内的
  组件边界，不是两个 Agent 层。
- UI 仅通过 GCP 与 Gateway 对话，不感知 Realtime Provider 或后台 Agent。
- 音色设置只提供 Qwen Audio 3.0 Realtime 的“甜美女声”（`longanqian`）和
  “阳光男声”（`longanlufeng`）；客户端通过正式 GCP/SDK 音色能力切换，Gateway
  只刷新上游 Realtime 会话，不会重启座舱应用。
- UI 通过已注册的 `client.event.publish` 只发送 `healer`、`action` 或 `sharp`；
  Gateway 将其映射到已有 Markdown，并通过 `session.update` 从下一轮起刷新当前会话人设。
  客户端不能传入任意 Prompt，切换不会修改磁盘文件、丢失对话或产生额外播报。
- 主座舱区域保持纯语音交互；文字转写只进入调试面板，并且 ASR 仅展示最终结果。
- UI 通过场景自己的 HTTP/SSE 通道展示车辆、路线、音乐、天气和订单状态，以及细粒度场景进度；Gateway 不解析这些对象。
- 用户可以通过语音创建和运行持久化的座舱自定义技能；技能是按座舱隔离的用户工作流，
  由后台 Agent 加载后编排现有 MCP 工具。它不是动态 MCP 插件、A2A Agent Card 或全局 Agent Skill。
- 前台 Agent 通过标准 MCP 直接调用天气、车辆位置、车况、车窗、天窗、大灯、
  空调、停止导航、导航视图/播报/偏好和音乐播放控制工具；这些低延迟指令直接执行，
  不再增加重复确认。
- 位置查询与导航起点共用 Cockpit Service 的 `vehicleLocation()` 适配入口；
  未接车机 GPS 时会明确返回 Demo 默认位置，部署时只需替换该服务。
- 路线偏好按钮写入座舱权威状态；用户未另行指定时，后续导航会继承该偏好。
- 记忆设置面板调用 Gateway 的 Provider 无关记忆控制面，列出并精确删除
  Realtime 共用的 USER/MEMORY 文档条目，不维护座舱私有的另一份记忆。
- 其他座舱任务通过固定的 `spawn_thinking` 桥梁提交给后台。示例后台通过 A2A
  接入 Gateway，Qwen3.8-Flash 会发现并调用独立的后台 MCP 工具面，完成车控、
  导航、音乐、闪购和自定义技能任务，包括有序的多途经点导航。
- 后台 Agent 如何调用工具和组织工作是后台内部实现；若创建独立派生 Session，
  可以形成由后台扩展出的第三层执行空间，不改变前台协议。
- 场景工具按领域收敛在 [`service/tools/`](service/tools/README.md)，开发者通过显式
  注册表增加领域工具包，并按工具名选择哪些额外暴露给前台作为低延迟快路径；
  后台保留完整工具面用于组合任务，不需要修改 Gateway 协议或复制执行逻辑。
- 客户可以替换整个 UI、座舱 Agent 或座舱 Service，而不修改框架核心。

## 开发与测试

```bash
npm run example:smart-cockpit:lint
npm run example:smart-cockpit:build
npm run test:smart-cockpit
```

更多说明：

- [架构与数据流](docs/architecture.md)
- [替换 UI、Agent 或座舱 Service](docs/replacing-components.md)
- [测试矩阵](docs/test-matrix.md)
