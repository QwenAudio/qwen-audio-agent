## 变更说明

新增 `examples/customer-service` —— 继 `examples/car` 之后的第二个场景级示例：**语音客服**。

Gateway（语音前台 + GCP）保持不变，业务逻辑收敛在示例自己的进程与域配置里。

### 五个进程各自的职责

| 进程 | 端口 | 职责 |
|---|---|---|
`service` | 3110 | 唯一的状态源与 executor。对外暴露**两个 MCP 面**：`/mcp/frontend`（白名单子集）与 `/mcp/backend`（全集） |
`agent` | 3120 | 后台 A2A Agent。承接需要客户批准的写库任务，走框架的 `auth_required` 挂起-恢复链 |
`gateway` | 18889 | 语音前台。装配人设、前台工具白名单、policy 检索源；关掉了联网检索与用户画像 |
`client` | 4620 | 客服工作台。左侧「你正在演谁」给测试者看剧本，右侧「客服看到的」是模型视角 |
`desk` | 4630 | 人工坐席台。转人工之后亮起，显示转接原因与已办事项 |

外加一个域无关的 **Policy 配置台**（`console`，4610）：读 `policy.md`，抽出可机器执行的约束，管理员裁决后导出 `guards.json`。

### 一份代码，两份域配置

`domains/retail`（明远优选）与 `domains/airline`（云途航空）各含三个文件：

- `policy.md` — 业务细则原文，是所有判定的依据
- `db.json` — 示例数据。带 `_anchorDate`，装载时把所有日期平移到「现在」，避免 demo 随时间腐烂
- `guards.json` — 从 policy 抽出的**决策表**（DMN 最小子集：比较、区间 `]a..b]`、通配、兜底行）+ 工具级前置条件 + 枚举 + 阈值

换域只换环境变量 `CS_DOMAIN`，它决定四样东西：人设、前台工具白名单、policy 检索源、默认库。两组进程可同时跑（航空端口 +100），互不干扰。

### 三层保障，分工明确

| | 管什么 | 落在哪 |
|---|---|---|
**数据合法性** | 这笔单能不能办 | 工具内硬检查 + `guards.json` 的决策表 |
**流程顺序** | 核验之后才能查单 | `guards.json` 的 `preconditions`，工具拒绝并说明缺什么 |
**不可逆动作** | 涉款操作必须客户批准 | 两段式令牌：第一次调用只返回预览 + 一次性令牌，不碰数据库 |
**出口** | 客服**说出去的话** | `output-audit.mjs` 对助手 transcript 做四条禁止事项的机检 |

最后一层是这个示例特有的：判定和事实都对了，模型仍然可能把「超出时限」说成「我帮您申请特批」。审计从 `/api/conversations/:sessionId/messages` 取回原话，违规的在界面上标红并给出细则行号。

---

## 验证

- [x] `npm test`
- [x] `npm run lint`
- [x] `npm run build`
- [x] 行为变化已补充测试或说明无法自动测试的原因

### example 已纳入根 CI

之前根 `test` 里只有 `test:smart-cockpit`，客服的测试**从未在 CI 跑过**。这一版补齐了与 smart-cockpit 对称的一组 script，并把 `test:customer-service` 挂进根 `test` —— `ci.yml` 跑的是 `npm test`，所以现在会随 CI 一起跑。

```
npm run example:customer-service:install   装五个子包依赖
npm run example:customer-service           起零售一组
npm run example:customer-service:airline   起航空一组（端口 +100）
npm run example:customer-service:both      两组同时跑
npm run example:customer-service:console   Policy 配置台
npm run example:customer-service:lint      lint（见下）
npm run test:customer-service              350 条测试
```

### 实际运行结果

```
npm test                              全绿（含下面 350 条）
  service  190   agent   10   console 108
  client    10   desk     8   gateway  24

npm run lint                          零错误
npm run example:customer-service:lint 零错误
npm run build                         通过（构建 web workspace；客服无构建步骤）
```

### lint 需要单独一份配置

根 `eslint.config.mjs` 显式忽略 `examples/**`，所以 `npm run lint` 对这个目录**零输出而非通过** —— 它压根没检。补了 `examples/customer-service/eslint.config.mjs`，复用根规则、只摘掉那条忽略。

第一次真跑出 39 个 `no-irregular-whitespace`：我在语音话术里用了 U+3000 全角空格做排版。语音场景里它没有意义（TTS 不读空格），已换成普通空格。

### 手工验证（无法自动化的部分）

需要真实语音会话与 DashScope 凭据，所以这几项是手工验证的，证据记在对应 commit 里：

| 验证项 | 结果 |
|---|---|
助手 transcript 可取回 | 一次真实对话，8 条消息 / 4 条 assistant，原文抄录在 commit 中 |
模型不编造 | 引诱「帮我特批一下」→ 回「一律拒绝，我无法为您特批处理」，零编造 |
出口审计随核验状态变化 | 同一句「您的订单 #W… 已签收」核验前报警、核验后放行 |
`auth_required` 链 | 前 5 步有运行证据（`task.accepted` → `task.input.requested`）；**第 6 步未复现** |
两个域配置隔离 | 网关自报 policy 检索源与前台工具面按 `CS_DOMAIN` 分别装配 |
联网检索已关 | 对照实验：关之前 5 条外部引用、关之后零引用 |

---

## 兼容性与安全

- [x] 未提交密钥、用户数据、日志或内部地址
- [x] 配置、用户可见行为和依赖变化已同步更新文档
- [x] 已说明网络、权限、隐私、持久化或发布流程影响；不适用时请注明

### 密钥

扫过 `sk-` 前缀、`Bearer`、32 位以上十六进制。本地有两个含真实值的文件：

```
.env.local          DASHSCOPE_API_KEY
.runtime/state.env  QWEN_AUDIO_AGENT_AUTH_SECRET
```

两个都**未被 git 跟踪**，`git log --all -S <key>` 确认该字符串在历史中从未出现。仓库根 `.gitignore` 的 `.env` / `.env.*` 全挡并放行 `.env.example`，已用 `git check-ignore` 实测裸 `.env` 也被忽略。

`.env.example` 里只有占位符（`your_dashscope_api_key`）与本机地址。

### 示例数据

全部构造，无真实用户数据：

- 邮箱域名只有 `example.com`（RFC 2606 保留给文档用途）
- 手机号形如 `13800002021`（连号）
- 支付方式只有品牌与后四位，无卡号
- 姓名、会员号、订单号均为虚构

### 网络

- 示例进程只监听 `127.0.0.1`
- 语音前台**关掉了** `web_search` 与 `fetch_url`：客服的信息边界必须封闭。对照实验中，开启时模型会引用与业务无关的公网页面并据此说出「30 天」
- 关掉了用户画像（`memoryProvider: null`）：客服每通电话是不同的客户，跨会话累积偏好会串号
- 后台 Agent 与配置台调用 DashScope（OpenAI 兼容 chat completions），需要 `DASHSCOPE_API_KEY`

### 持久化

- 业务状态在内存，按 `sessionId` 隔离，进程重启即清空。`db.json` 只读作模板
- 网关的会话历史落在 `.runtime-<domain>/`，已在 `.gitignore` 中
- 配置台的抽取缓存在 `console/.cache/`，已忽略
- 数据库编辑会先写 `db.backup.json`（已忽略）

### 已知缺口

1. `auth_required` 第 6 步未复现（前 5 步有运行证据）
2. 网关一次只接一个客户端 —— 残留的浏览器标签会占住槽位，工作台随后进重连循环。这是框架侧的限制，示例里只做了提示
3. `sessionId` 在网关启动时烘进前台 MCP 的 URL，所以是单通话演示；并发通话会共享同一份业务会话
4. 「不得对商品质量给出主观评价」这一条禁止事项**未做机检** —— 判断一句话是否「主观评价」属于语义问题。审计结果里显式列出这一条，避免「零违规」给人全部守住的错觉

---

如果文件数仍偏多，可按您的建议拆分。一个可行的切法是：①零售域 + 四进程骨架（核心证明）②航空域（证明一份代码多份配置）③Policy 配置台 ④出口审计 + 坐席台。
