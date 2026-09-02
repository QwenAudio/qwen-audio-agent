# Qwen Audio Agent Customer Service

[English](README.md) | [中文](README_ZH.md)

> **状态：进行中（draft）。** 服务层与零售域的完整工具面已可用（含写库与批准机制），
> 客户端界面、Gateway 装配与后台 Agent 尚未接入。可运行的部分见下方「当前能跑什么」。

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
cd examples/customer-service/service
npm install
npm test                    # 56 条：数据完整性 15 + 服务层 18 + 写库与批准 23
npm start                   # 默认 http://127.0.0.1:3110
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

1. **`auth_required` 端到端探链**。这条链在 realtime 侧代码是接通的
   （`realtime-gateway.mjs` 6 处、`tool-call-handler.mjs` 2 处），但座舱示例用不到它，
   所以**可能从没在真实语音会话里跑过**。它通不通会影响工具归属的划分。
2. **Gateway 装配与后台 Agent**（照抄 `smart-cockpit/gateway` 与 `agent/`）。
3. **换货**（`exchange_items`）：要先查库存、算差价，比退货多两步。
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
