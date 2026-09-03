# Qwen Audio Agent Customer Service

[English](README.md) | [中文](README_ZH.md)

> **状态：进行中（draft）。** 服务层、后台 A2A Agent 与批准链路已可用，
> `auth_required` 全链已实测跑通。客户端界面与 Gateway 装配尚未接入。

## 这个示例要回答什么

`smart-cockpit` 证明了这套框架能做车机语音助手，但车机的任务彼此独立
（开车窗与导航无关）。客服不一样：**核验 → 查单 → 判定 → 执行** 是同一条链上的
连续环节，而每一步的约束来自一份 policy 文本，而不是物理状态。

所以这个示例专门压测三件事：

1. **policy 能不能约束住模型** —— 会不会跳过身份核验，会不会编造赔付金额。
2. **不可逆动作的确认能不能变成机制** —— 框架有 `auth_required` 状态但座舱用不到它，
   这里会是它的第一个真实使用者。
3. **多步流程的状态一致性** —— 中途挂断再打回来，能不能接上。

## 架构

照 `smart-cockpit` 的四进程分层。当前只实现了 service：

```text
service-client ── GCP 6.0 ──► service-gateway ── A2A ──► service-agent
      │                          │                         │
      │ HTTP/SSE                 │ frontend MCP            │ backend MCP
      │ 业务状态                  │ 核验/查单/查库存          │ 完整工具面
      ▼                          ▼                         ▼
                         customer-service（本目录 service/）
                         单一业务状态源与工具执行
```

### 单一 executor，两个工具面

这是本示例的核心结构，也是「前后端如何协调办同一件事」的答案：

```text
service/tools/orders/execute.mjs        ← 唯一的实现
        ├─→ /mcp/frontend   （白名单里的，前台直出）
        └─→ /mcp/backend    （完整工具面，后台组合任务用）
```

两个面调的是同一行代码、同一份状态。**前台面是后台面的子集，不是互斥的两个列表** ——
所以白名单配错了只是性能退化，不是功能故障。

前台白名单只放核验与只读查询。写库类（取消、退货、改地址、转人工）只在后台面。

### 写库前的确认是数据依赖，不是 prompt 请求

原本打算让写库工具带一个 `user_confirmed` 参数，靠 prompt 要求模型「问过客户再填
true」。那守不住 —— 模型可以不问就填，我们只能事后在审计里发现，而钱已经出去了。

改成两段式：

```text
① cancel_order(orderId, reason)
   → 返回预览「将取消 #W1082334：无线耳机 ×1，￥899.00 将退回招商银行信用卡…」
     和一枚 approval_token
   → 不碰数据库

② 把预览念给客户，得到明确同意

③ cancel_order(orderId, reason, approval_token)
   → 校验令牌 → 真正执行
```

**模型没有「跳过批准」这个选项 —— 它拿不到令牌就执行不了。**

三处细节：

- 令牌绑定「动作 + 对象」，不是通用通行证。否则能拿取消 A 单的批准去取消 B 单；
  部分退货还要把款式写进指纹，「退耳机」的批准不能拿去退鼠标。
- 令牌一次性，取出即删。否则一次批准可被重放成多次退款。
- 预览里的金额由 executor 算，不经模型的手 —— 模型算错退款金额比它不会算更糟。

**退款超上限时不发令牌**，直接要求转人工。若只在预览里写「金额较大建议转人工」，
模型照样能往下走。

### policy 拆成三处

| 内容 | 放哪 | 为什么 |
|---|---|---|
| 身份、语气、硬边界 | `gateway/assistant/retail.md`（六段式） | 常驻注入，每轮生效，约 40 行 |
| 什么时候调哪个工具 | MCP `description` / `schema` | 工具自己说明何时用自己；写进 prompt 是冗余，且稀释硬约束 |
| 业务细则（时限、运费、赔付） | `domains/retail/policy.md` → `knowledge` | 细则长，常驻会挤爆预算 |

## 当前能跑什么

```bash
# 业务服务（状态源 + 两个 MCP 工具面）
cd examples/customer-service/service
npm install && npm test     # 56 条：数据完整性 15 + 服务层 18 + 写库与批准 23
npm start                   # 默认 http://127.0.0.1:3110

# 后台 A2A Agent（需要 DASHSCOPE_API_KEY）
cd ../agent
npm install && npm test     # 5 条：auth_required 全链（含拒绝路径）
npm start                   # 默认 http://127.0.0.1:3120
```

起来之后可以直接打两个 MCP 面：

```bash
# 未核验就查订单 → 被硬拒
curl -s -X POST 'http://127.0.0.1:3110/mcp/frontend?sessionId=demo' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_orders","arguments":{}}}'

# 核验身份
curl -s -X POST 'http://127.0.0.1:3110/mcp/frontend?sessionId=demo' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"verify_identity",
                 "arguments":{"email":"liming3021@example.com"}}}'
```

其它端点：

| 端点 | 用途 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /api/service/state?sessionId=demo` | 业务状态快照（给 UI 投影用） |
| `GET /api/service/events?sessionId=demo` | SSE 状态变化流 |
| `POST /api/service/reset` | 一键回到初始状态（Demo 反复演示用） |
| `POST /mcp/frontend` \| `POST /mcp/backend` | 两个 MCP 工具面 |

## auth_required：已实测跑通

这条链在框架的 realtime 侧代码一直是接通的（`realtime-gateway.mjs` 6 处、
`tool-call-handler.mjs` 2 处），但座舱示例用不到它 —— 开天窗不需要客户批准。
所以此前没有证据说明它真能跑。现在有了：

```text
工具返回 needsApproval
  → executor 发 TASK_STATE_AUTH_REQUIRED + 预览消息
  → adapter 转成 InputRequest{kind:'authorization', status:'pending'}
  → respondInput({action:'accept'}) → 任务恢复 → 带令牌执行 → 订单 cancelled
```

拒绝路径同样测了：`{action:'decline'}` 之后订单保持 `pending`。

### 接这条链时撞到的三个坑

| 坑 | 症状 | 修法 |
|---|---|---|
| 首个事件不是 Task | `Received statusUpdate before initial 'Message'/'Task' event.` | 先 `publish(AgentEvent.task(...))` |
| 恢复执行时重发 Task | `Stream ordering violation: received task in task lifecycle stream.` | 只在 `!requestContext.task` 时发 |
| **恢复时丢了 approval_token** | 客户被问第二遍 —— 模型看不到上一轮的工具返回，只能重新取预览 | 挂起时把预览原文一起存下，恢复时拼进 objective |

第三个是设计缺陷而不是测试问题：`runServiceAgent` 每次都是空对话开局，
真实模型同样看不到上一轮的工具返回。预览是唯一能把令牌送回去的载体。

## 零售域的数据与场景

`domains/retail/db.json` 裁剪自 τ²-bench retail 的结构：5 用户 / 20 订单 / 12 类商品。
数据不是随手造的，每一项都对应一个要演示的分支：

| 埋点 | 用途 |
|---|---|
| 陈静没有邮箱 | 逼出 `姓名 + 邮编` 那条核验分支 |
| `#W3301887` 金额 2899 元 | 超过 2000 元退款上限 → 转人工 |
| `#W2378156` 家电已签收 22 天 | 家电窗口 15 天 → 资格判定应拒绝 |
| `#W5540912` 服饰已签收 4 天 | 服饰窗口 30 天 → 顺利路径 |
| `#W3376900` 是家具类 | **policy 的时限表里刻意没有家具** → 看模型会不会编造 |
| 键盘有 4 个变体、恒温器有缺货款 | 换货的库存校验与差价 |

`service/test/db-integrity.test.mjs` 把这些当断言守着：引用自洽、金额自洽，
且上述场景所需的订单形态必须存在 —— 少一类，对应场景就没法演示。

## 已知缺口

按优先级：

1. **Gateway 装配**（照抄 `smart-cockpit/gateway`）+ 真实语音会话验证。
   目前 `auth_required` 是用 `A2ABackendAdapter` 直接对接验证的，
   还没经过 realtime 语音那一层。
2. **换货**（`exchange_items`）：要先查库存、算差价，比退货多两步。
4. **客户端界面**：客户档案、订单、流程进度、生效的约束、操作流水五个面板，
   放 `client/src/projections/`（纯函数 + 单测）。
5. **航空域**（复用骨架，换 `domains/airline/`）。

> 批准机制与 `auth_required` 是两层，互不替代：令牌保证「没批准就执行不了」，
> `auth_required` 让后台任务挂起、把问题送到客户耳边。即使 `auth_required`
> 这条链不通，令牌那层仍然拦得住。

## 与 τ²-bench 的关系，以及一处刻意偏离

工具清单与 policy 条目参考 τ²-bench 的 retail 域，但**不做它的评测框架**
（simulated user、`pass^k`）—— 这个示例的用户是真人。

有一条 τ² policy 我们刻意不采用：

```text
You should at most make one tool call at a time, and if you take a tool call,
you should not respond to the user at the same time.
```

这条在 τ² 里是为了让评测可判定，**但语音场景里会造成可感知的静默** ——
调工具期间不说话，客户会以为断线。我们的人设里写的是相反的要求：
调工具之前先说一句「我查一下」。

## Policy 配置台

```bash
cd console && npm start          # http://127.0.0.1:4610
```

管理员在这里把 `policy.md` 变成 `guards.json` 与 `frontend-mcp.json`。

**抽取跑 3 次而不是 1 次。** 实测过：同一份 policy 连抽三次（temperature: 0），
模型给每条都标 `certain`，但顺序类规则每次都不同，其中两次对同一句原文抽出
**相反的顺序**。所以判据不用模型的自评，用多次运行的一致性：

| 一致性 | 处置 |
|---|---|
| 3/3 且每次都是确定项 | 折叠，不打扰 |
| 3/3 但每次都判为模糊 | 稳定地需要人看（policy 缺口属于这类） |
| 同主题不同结论 | 并排显示各版本，人选一个 |
| 只有部分运行抽出 | 可能漏抽，也可能是幻觉 |

界面上四件事：

- **待你决定** —— 按分歧程度排序，最可疑的在最前。每条的灰色引文标着
  policy 第几行，点一下右侧原文跳到那一行并高亮。落不回原文的会明说，
  那通常意味着模型编了一条 policy 里没有的规则。
- **决策表** —— 摊平成表格，兜底行有底色。改一格数字，executor 下次执行就变。
- **工具面编排** —— 每个工具的归属由规则推出（不调模型），可以推翻。
  推翻时显示后果：`cancel_order` 改到前台会标红，说明它会绕过 `auth_required`；
  只读工具改到后台只标橙，说明只是多 1~3 秒静默。
- **搜索与筛选** —— 关键词同时筛规则、决策表、工具和 policy 原文；
  再加「只看待决定」「只看有风险」两个开关。

导出会写 `domains/<domain>/guards.json` 与 `gateway/frontend-mcp.json`。
配置台不参与执行 —— 它挂了通话照常，只是改不了配置。

## 四进程跑起来

```bash
cd service && npm start     # :3110  状态源 + 两个 MCP 工具面
cd agent   && npm start     # :3120  后台 A2A Agent
node gateway/server.mjs     # :18889 前台网关
cd console && npm start     # :4610  Policy 配置台
```

前台白名单 5 个（`verify_identity` / `identity_status` / `list_orders` /
`get_order` / `check_variant`），其余经 `spawn_thinking` 交后台。

## auth_required 在真实语音网关里的实测

链路是核实过代码的，不是推测的：

| 步 | 发生什么 | 位置 |
|---|---|---|
| 1 | 客户说要取消 → 模型调 `spawn_thinking` | — |
| 2 | 后台取到写库预览发现要批准 → 任务挂起 | `service/tools/approval.mjs` |
| 3 | `inputRequest.kind = 'authorization'` → `workState = auth_required` | `server/src/task/task-state.mjs:97` |
| 4 | 网关包成 `<backend_input_request>` 交给 realtime 模型 | `realtime-gateway.mjs:946` |
| 5 | 模型**口头**转达问题 | `frontend-tools.mjs:498` |
| 6 | 客户口头回答 → 模型调 `respond_agent_input` 交回同一项工作 | `frontend-tools.mjs:29` |

**第 5、6 步一开始以为要自己做批准 UI。** 查了 `GatewayClientEvent` 全部枚举
—— 没有任何「应答 input」的类型，应答只能由模型调工具完成。
所以客户端做不出直接回 `inputRequest` 的按钮；`/api/permissions/:id` 那条路
走的是 permission 机制，和 `inputRequest` 是两套东西。
第 6 步的工具只在有挂起请求时动态暴露（`hasPendingBackendInput()`）。

### 实测到第 4 步，第 6 步未复现

用文字消息代替语音跑 `runtime/gateway-auth-probe.mjs`，拿到过一次完整证据：

```
task.accepted         objective="取消订单 #W1082334…客户已确认取消。"
task.input.requested  workState=auth_required  inputKind=authorization
```

**前四步成立。** 但之后多次重跑（含清 `.runtime`、重启三进程）都没能让模型
再次提交任务，因此第 6 步（`respond_agent_input` → 订单真的取消）
**目前只有代码依据，没有运行证据**。

三条排查中确认的干扰因素，都写进了探针的注释：

- `sessionId` 必须与网关启动时那个一致。原因见下一节。
- `.runtime/` 里的对话历史会被恢复（日志里的 `conversation_history.restored`），
  模型看到「这单已经在办」就不再提交。
- **助手侧的 transcript 不回传** —— 只有 `role=user` 的 `transcript.final`，
  模型的语音输出走 `audio.delta`。所以看不到它说了什么，
  只能靠 `task.*` 事件判断它有没有调工具。

## 一个已知限制：sessionId 在进程启动时定下来

`server/src/providers/mcp/frontend-mcp-client.mjs:132` 用的是配置里的静态
`transport.headers`，框架不会按语音会话注入 MCP 请求参数。
所以 `gateway/server.mjs` 把 `sessionId` 烘进了 `CS_FRONTEND_MCP_URL`。

座舱那样写是对的 —— 它的 `cockpitId` 是「哪台车」，一台车一个固定值。
客服的 `sessionId` 语义上是「哪通电话」，本该每通不同。要做到那样需要框架支持
按会话注入，那是框架的事，不该在示例里加一个假的隔离层糊过去。

**当前形态是单通话演示。** 多通并发会共享同一份客服会话状态。

## 客服细则的检索

关掉联网之后必须给个正确的来源，否则模型只剩两条路：反问客户，或者凭常识编。
`gateway/policy-knowledge.mjs` 把 `domains/<domain>/policy.md` 按 `##` 章节切开，
挂成框架的 knowledge 检索源。

**原文一字不改地交给模型**，不做摘要 —— 摘要一次就多一次失真机会，
而这份文本的全部价值在于它是权威原文。每段开头带着出处：

```
《明远优选零售客服细则》二、退货时限（第 16 行起）

| 类别 | 代码 | 退货窗口 |
| 服饰鞋包 | apparel | 30 天 |
...
```

行号写在 content 里而不是走 citation 协议 —— `normalizeCitation` 要求公开 URL，
没有 url 就返回 null（`citation.mjs:21`），而 policy 是本机私有文件。

**一个进程只服务一个域**（`CS_DOMAIN`，默认 retail）。第一版把两个域都装进来，
实测零售会话查「运费谁承担」时第二条返回了航空的「免费托运行李额」——
混域不只是排序噪声，零售客服可能拿航空规则答零售问题。

### 三次对照实验

同一句「你好，我想问一下退货政策」，问了三次：

| | 联网开启 | 联网关闭 | 挂上细则检索 |
|---|---|---|---|
| 外部引用 | 5 条（昆明本地宝、书法拍卖） | 零条 | 零条 |
| 具体天数 | 30 天（来自公网） | 没有 | **30 / 7 / 15，按类别分对** |
| 说法 | 「建议您查看细则」 | 「我需要查一下细则」（查不到） | 直接给出内容 |

再追问两个问题：

- 「数码产品多少天内可以退货」→ **7 天**，正确
- 「家具类商品多少天内可以退货」→ **「家具类商品在政策里没有单独列出类别」**

最后一条是关键。之前是在 executor 里靠「工具给不出数字」硬拦，
现在**模型自己就说不出来** —— 因为检索回来的原文里确实没有家具类。

## 客服工作台

```bash
cd client && npm start      # http://127.0.0.1:4620
```

左边替客户说话，右边三个面板显示同一通话在服务端留下的痕迹：
身份核验状态、订单数据、每一次工具调用的审计。

实测走完一遍（核验 → 查单 → 问退货）：

| 面板 | 实测结果 |
|---|---|
| 客户 | 核验后显示「已核验 · 李明 · 邮箱」与地址 |
| 订单 | 出现 5 笔，`#W2378156` 卡片列出机械键盘（数码电子）、智能恒温器（家用电器），并标「签收于 2026-08-10，距今 24 天」 |
| 审计 | `verify_identity` ✓ / `list_orders` ✓，各带时间与前后台标记 |

**签收天数摆在卡片上是有意的** —— 它是退货资格判定的输入，
放在这里能一眼看出模型说的「超期」对不对。

### 两个限制，都是框架的有意设计

**一、网关一次只接一个客户端**（`realtime-gateway.mjs:241`）。
工作台和网关自带的 web 界面（`:18889`）不能同时开。
这个错误在界面上会明确提示 —— 不提示的话页面看起来完全正常
（状态灯是绿的、消息发得出去），只是永远等不到回复。第一次实测就卡在这里两分钟。

**二、必须代理，不能直连**。页面所有请求走同源相对路径，由 `client/server.mjs`
转发给网关与 service。直连 `:18889` 会被拒：

```
WebSocket ws://127.0.0.1:18889/api/realtime → 403
fetch     http://127.0.0.1:18889/api/...    → {"error":"origin not allowed"}
```

根因在 `server/src/core/request-security.mjs` —— DNS rebinding 防护，
判据是「origin 的 host 必须等于请求的 host」，跨端口无论如何都过不了，
连 `config.allowedOrigins` 也绕不开（它同样要求 host 相等）。
框架自带的 web 界面挂在网关的 `/` 上，天然同源，所以碰不到这个问题。

### 一个未解决的问题

**客服的回复在工作台里看不到文字。** 工具调用、身份核验、订单变化都实时反映在
右侧面板 —— 那些是服务端事实，可靠；但对话区只有客户的气泡。

已经排除的：代理层正常（WebSocket 帧和 REST 请求都验证过转发无误）、
框架确实支持助手侧转写（`realtime-presentation-runtime.mjs:20-25` 监听六种
转写事件，`web/src/App.jsx:567` 在消费它）、模型能力表 `textOutput: true`。

还没查清的：为什么同一个网关下，自带 web 界面能拿到 `role: 'assistant'` 的
消息，而工作台拿不到。两边 `connect` 的差异只剩 `inputEnabled`
（WebUI 传 false，工作台传 true）。

要看客服说什么，暂时用网关自带的界面。
