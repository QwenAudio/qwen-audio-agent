# Qwen Audio Agent Customer Service

[English](README.md) | [中文](README_ZH.md)

> **Status: work in progress (draft).** The service layer, the backend A2A Agent and the
> approval chain are usable, and the full `auth_required` round-trip has been verified
> end-to-end. The client UI and Gateway composition are not wired yet.

## What this example is for

`smart-cockpit` proved the framework can drive an in-car voice assistant, but cockpit
tasks are independent of each other (opening a window has nothing to do with navigation).
Customer service is different: **verify → look up → assess → execute** are consecutive
links in one chain, and every step is constrained by a policy document rather than by
physical state.

So this example stresses three things specifically:

1. **Whether policy actually constrains the model** — will it skip identity verification,
   will it invent compensation amounts.
2. **Whether confirmation of irreversible actions can be a mechanism** — the framework has
   an `auth_required` state that the cockpit never needs; this example will be its first
   real consumer.
3. **State consistency across a multi-step flow** — hang up mid-way, call back, can it resume.

## Architecture

Follows the four-process layering of `smart-cockpit`. Only `service` exists today:

```text
service-client ── GCP 6.0 ──► service-gateway ── A2A ──► service-agent
      │                          │                         │
      │ HTTP/SSE                 │ frontend MCP            │ backend MCP
      │ business state           │ verify / orders / stock  │ full tool surface
      ▼                          ▼                         ▼
                         customer-service (service/ in this directory)
                         single business state source and tool execution
```

### One executor, two tool surfaces

This is the core structure of the example, and the answer to "how do frontend and backend
cooperate on the same job":

```text
service/tools/orders/execute.mjs        ← the only implementation
        ├─→ /mcp/frontend   (whitelisted, runs in the foreground)
        └─→ /mcp/backend    (full surface, for composed backend tasks)
```

Both surfaces call the same line of code against the same state. **The frontend surface is
a subset of the backend surface, not a mutually exclusive list** — so a mis-configured
whitelist only costs latency, it does not break functionality.

The frontend whitelist holds verification and read-only lookups only. Write operations
(cancel, return, change address, escalate) live on the backend surface exclusively.

### Confirmation before a write is a data dependency, not a prompt request

The original plan was to give write tools a `user_confirmed` parameter and ask the model
via prompt to "only set true after asking the customer". That does not hold — the model can
set it without asking, and we would only find out in the audit trail, after the money left.

It is now two-phase:

```text
① cancel_order(orderId, reason)
   → returns a preview ("will cancel #W1082334: 1× wireless headphones, ¥899.00 back to
     the CMB credit card…") plus an approval_token
   → does not touch the database

② read the preview to the customer, obtain explicit consent

③ cancel_order(orderId, reason, approval_token)
   → validates the token → actually executes
```

**The model has no "skip approval" option — without a token it cannot execute.**

Three details:

- The token is bound to "action + subject", not a general pass. Otherwise approval to cancel
  order A could cancel order B; partial returns additionally fold the item ids into the
  fingerprint, so approval to return headphones cannot return the mouse.
- The token is single-use, deleted on consumption. Otherwise one approval could be replayed
  into several refunds.
- The amount in the preview is computed by the executor, never by the model — a model that
  gets a refund amount wrong is worse than one that cannot compute it.

**No token is issued when the refund exceeds the ceiling**; it demands escalation instead.
Merely writing "large amount, consider escalating" into the preview would let the model
proceed anyway.

### Policy is split across three places

| Content | Where | Why |
|---|---|---|
| Identity, tone, hard boundaries | `gateway/assistant/retail.md` (six-segment) | Always injected, effective every turn, ~40 lines |
| When to call which tool | MCP `description` / `schema` | A tool explains its own applicability; repeating it in the prompt dilutes the hard constraints |
| Business details (windows, shipping, compensation) | `domains/retail/policy.md` → `knowledge` | Too long to keep resident |

## What runs today

```bash
# Business service (state source + both MCP tool surfaces)
cd examples/customer-service/service
npm install && npm test     # 56: 15 data integrity + 18 service + 23 write/approval
npm start                   # defaults to http://127.0.0.1:3110

# Backend A2A Agent (needs DASHSCOPE_API_KEY)
cd ../agent
npm install && npm test     # 5: full auth_required chain, including the decline path
npm start                   # defaults to http://127.0.0.1:3120
```

Once running you can hit both MCP surfaces directly:

```bash
# Query orders before verification → hard refusal
curl -s -X POST 'http://127.0.0.1:3110/mcp/frontend?sessionId=demo' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_orders","arguments":{}}}'

# Verify identity
curl -s -X POST 'http://127.0.0.1:3110/mcp/frontend?sessionId=demo' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"verify_identity",
                 "arguments":{"email":"liming3021@example.com"}}}'
```

Other endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /health` | Health check |
| `GET /api/service/state?sessionId=demo` | Business state snapshot (for UI projections) |
| `GET /api/service/events?sessionId=demo` | SSE stream of state changes |
| `POST /api/service/reset` | Reset to the initial state (needed for repeated demos) |
| `POST /mcp/frontend` \| `POST /mcp/backend` | The two MCP tool surfaces |

## auth_required: verified end-to-end

The chain has always been wired on the framework's realtime side (6 sites in
`realtime-gateway.mjs`, 2 in `tool-call-handler.mjs`), but the cockpit example never needs
it — opening a sunroof requires no customer approval. So there was no evidence it actually
worked. Now there is:

```text
tool returns needsApproval
  → executor emits TASK_STATE_AUTH_REQUIRED with the preview message
  → adapter turns it into InputRequest{kind:'authorization', status:'pending'}
  → respondInput({action:'accept'}) → task resumes → executes with token → order cancelled
```

The decline path is covered too: after `{action:'decline'}` the order stays `pending`.

### Three traps hit while wiring this

| Trap | Symptom | Fix |
|---|---|---|
| First event is not a Task | `Received statusUpdate before initial 'Message'/'Task' event.` | publish `AgentEvent.task(...)` first |
| Re-publishing Task on resume | `Stream ordering violation: received task in task lifecycle stream.` | only publish when `!requestContext.task` |
| **Losing the approval_token on resume** | the customer gets asked twice — the model cannot see the previous tool result, so it fetches a fresh preview | store the preview text alongside the objective and fold it back in on resume |

The third is a design flaw rather than a test artifact: `runServiceAgent` always starts from
an empty conversation, so a real model equally cannot see the previous tool result. The
preview is the only vehicle that can carry the token back.

## Retail data and scenarios

`domains/retail/db.json` is trimmed from the τ²-bench retail structure: 5 users,
20 orders, 12 product types. The data is not arbitrary — every entry backs a branch
that needs to be demonstrated:

| Fixture | Purpose |
|---|---|
| Chen Jing has no email | Forces the `name + zip` verification branch |
| `#W3301887` totals ¥2899 | Exceeds the ¥2000 refund ceiling → escalate to a human |
| `#W2378156` appliance delivered 22 days ago | Appliance window is 15 days → assessment must refuse |
| `#W5540912` apparel delivered 4 days ago | Apparel window is 30 days → happy path |
| `#W3376900` is furniture | **The policy table deliberately omits furniture** → does the model invent a rule |
| Keyboard has 4 variants, thermostat has an out-of-stock one | Stock check and price difference for exchanges |

`service/test/db-integrity.test.mjs` guards all of this with assertions: references and
totals must be self-consistent, and the order shapes the scenarios need must exist —
lose one and the matching scenario can no longer be demonstrated.

## Known gaps

In priority order:

1. **Gateway composition** (mirroring `smart-cockpit/gateway`) plus verification through a
   real voice session. `auth_required` is currently verified by driving
   `A2ABackendAdapter` directly; it has not yet gone through the realtime voice layer.
2. **Exchanges** (`exchange_items`): needs a stock check and a price-difference step on top
   of the return flow.
4. **Client UI**: customer card, orders, flow progress, active constraints and action log —
   five panels living in `client/src/projections/` as pure functions with unit tests.
5. **Airline domain** (reuse the skeleton, swap in `domains/airline/`).

> The approval mechanism and `auth_required` are two separate layers, neither replaces the
> other: the token guarantees "no approval, no execution"; `auth_required` suspends the
> backend task and carries the question to the customer's ear. Even if the `auth_required`
> chain turns out to be broken, the token layer still holds.

## Relationship to τ²-bench, and one deliberate deviation

The tool list and policy clauses follow the τ²-bench retail domain, but this example
**does not implement its evaluation harness** (simulated users, `pass^k`) — the user here
is a real person.

One τ² policy clause is deliberately not adopted:

```text
You should at most make one tool call at a time, and if you take a tool call,
you should not respond to the user at the same time.
```

In τ² this exists to keep evaluation decidable, **but in a voice setting it produces
audible silence** — saying nothing while a tool runs makes the customer think the line
dropped. Our persona asks for the opposite: say "let me check that" before calling a tool.

## Policy console

```bash
cd console && npm start          # http://127.0.0.1:4610
```

Turns `policy.md` into `guards.json` and `frontend-mcp.json`.

**Extraction runs three times, not once.** Measured: extracting the same policy
three times at temperature 0, the model labels every item `certain`, yet the
ordering rules differ every run — twice producing **opposite orders** from the
same sentence. So the criterion is not the model's self-assessment but the
agreement across runs:

| Agreement | Treatment |
|---|---|
| 3/3, determined every run | Collapsed, no attention needed |
| 3/3 but ambiguous every run | Stably needs a human (policy gaps land here) |
| Same topic, different conclusions | Variants shown side by side to pick from |
| Only some runs produced it | Either a miss or a hallucination |

Four things in the UI:

- **Needs your decision** — sorted by how much the runs disagreed. Each grey
  quote carries the policy line number; clicking it scrolls and highlights that
  line on the right. Items that cannot be traced back say so — usually meaning
  the model invented a rule the policy never stated.
- **Decision tables** — flattened into grids with the catch-all row shaded.
  Change one cell and the executor behaves differently on its next call.
- **Tool surfaces** — assignment derived by rules, no model involved, and
  overridable. Overriding shows the consequence: moving `cancel_order` to the
  frontend is flagged red because it bypasses `auth_required`; moving a
  read-only tool to the backend is only amber — it just adds 1–3s of silence.
- **Search and filters** — one keyword filters rules, tables, tools and the
  policy text at once, plus "pending only" and "risky only" toggles.

Exporting writes `domains/<domain>/guards.json` and `gateway/frontend-mcp.json`.
The console never takes part in execution — if it dies, calls keep working; you
just cannot change configuration.

## Running the four processes

```bash
cd service && npm start     # :3110  state source + two MCP tool surfaces
cd agent   && npm start     # :3120  backend A2A agent
node gateway/server.mjs     # :18889 foreground gateway
cd console && npm start     # :4610  policy console
```

Five tools are frontend-direct (`verify_identity`, `identity_status`,
`list_orders`, `get_order`, `check_variant`); everything else goes through
`spawn_thinking` to the backend.

## auth_required in a real voice gateway

The chain below was read out of the framework source, not guessed:

| Step | What happens | Where |
|---|---|---|
| 1 | Customer asks to cancel → model calls `spawn_thinking` | — |
| 2 | Backend gets a write preview needing approval → task suspends | `service/tools/approval.mjs` |
| 3 | `inputRequest.kind = 'authorization'` → `workState = auth_required` | `server/src/task/task-state.mjs:97` |
| 4 | Gateway wraps it as `<backend_input_request>` for the realtime model | `realtime-gateway.mjs:946` |
| 5 | Model relays the question **out loud** | `frontend-tools.mjs:498` |
| 6 | Customer answers → model calls `respond_agent_input` | `frontend-tools.mjs:29` |

**Steps 5–6 were assumed to need a custom approval UI.** Checking every
`GatewayClientEvent` member showed no "respond to input" type at all — only the
model can answer, by calling a tool. A client therefore cannot build a button
that replies to an `inputRequest` directly; `/api/permissions/:id` belongs to
the separate permission mechanism. The step-6 tool is exposed only while a
request is pending (`hasPendingBackendInput()`).

### Verified through step 4; step 6 not reproduced

Running `runtime/gateway-auth-probe.mjs` with text instead of audio produced one
complete piece of evidence:

```
task.accepted         objective="cancel order #W1082334 … customer confirmed."
task.input.requested  workState=auth_required  inputKind=authorization
```

**The first four steps hold.** Repeated attempts afterwards — including clearing
`.runtime` and restarting all three processes — did not get the model to submit
the task again, so step 6 (`respond_agent_input` actually cancelling the order)
**currently rests on source reading, not on a runtime observation.**

Three confounders found while investigating, all noted in the probe:

- `sessionId` must match the one baked in at gateway startup. See below.
- Conversation history is restored from `.runtime/`
  (`conversation_history.restored` in the log), after which the model considers
  the order already being handled and stops resubmitting.
- **Assistant transcripts are not sent back** — only `role=user`
  `transcript.final` arrives; model speech goes out as `audio.delta`. So what it
  said is invisible; only `task.*` events reveal whether it called a tool.

## Known limitation: sessionId is fixed at process start

`server/src/providers/mcp/frontend-mcp-client.mjs:132` uses the static
`transport.headers` from configuration; the framework does not inject
per-session parameters into MCP requests. So `gateway/server.mjs` bakes
`sessionId` into `CS_FRONTEND_MCP_URL`.

The cockpit does this correctly — its `cockpitId` means "which car", one fixed
value per vehicle. A customer-service `sessionId` means "which call" and should
differ every time. Doing that properly needs framework support for per-session
injection; papering over it with a fake isolation layer in an example would be
worse.

**This is a single-call demo.** Concurrent calls share one service session.

## Policy retrieval

With web access removed, the model needs a correct source or it is left with two
options: interrogate the customer, or invent. `gateway/policy-knowledge.mjs`
splits `domains/<domain>/policy.md` on `##` headings and mounts it as the
framework's knowledge retrieval source.

**The source text is handed to the model verbatim** — no summarisation. Summarising adds
one more chance to distort, and the whole value of this text is that it is the
authoritative original. Each passage carries its provenance:

```
《明远优选零售客服细则》二、退货时限（第 16 行起）

| 类别 | 代码 | 退货窗口 |
| 服饰鞋包 | apparel | 30 天 |
...
```

Line numbers live inside `content` rather than going through the citation
protocol: `normalizeCitation` requires a public URL and returns null without one
(`citation.mjs:21`), while the policy is a local private file.

**One process serves one domain** (`CS_DOMAIN`, default retail). The first
version loaded both; a retail session asking about shipping fees got airline
baggage allowance as its second hit. Mixing domains is not just ranking noise —
a retail agent could answer with airline rules.

### Three-way comparison

The same question — "I'd like to ask about the return policy" — asked three times:

| | Web on | Web off | Policy retrieval on |
|---|---|---|---|
| External citations | 5 (local news site, calligraphy auction) | none | none |
| Concrete day counts | 30 days (from the web) | none | **30 / 7 / 15, correct per category** |
| Wording | "you should check the policy" | "I need to look up the policy" (couldn't) | gives the content directly |

Two follow-ups:

- "How many days for digital products?" → **7 days**, correct
- "How many days for furniture?" → **"furniture is not listed as a category in the policy"**

That last one matters. Previously the executor blocked fabrication by refusing to
supply a number; now **the model itself cannot produce one** — the retrieved text
genuinely has no furniture row.

## Customer service console (client)

```bash
cd client && npm start      # http://127.0.0.1:4620
```

Type as the customer on the left; the three panels on the right show what the
same call left behind on the server: verification state, order data, and an audit
entry for every tool call.

A full run (verify → list orders → ask about a return):

| Panel | Observed |
|---|---|
| Customer | after verification: "verified · 李明 · email" plus address |
| Orders | 5 appear; `#W2378156` lists a keyboard (digital) and a thermostat (appliance), tagged "delivered 2026-08-10, 24 days ago" |
| Audit | `verify_identity` ✓ / `list_orders` ✓, each with a timestamp and surface tag |

**The delivered-days figure is on the card deliberately** — it is an input to the
return-eligibility decision, so having it visible makes it obvious whether the
model's "expired" claim is right.

### Two limitations, both intentional in the framework

**One: the gateway accepts a single client at a time**
(`realtime-gateway.mjs:241`). This console and the gateway's own web UI
(`:18889`) cannot both be open. The page surfaces that error explicitly —
without it everything looks fine (green status light, messages send) and replies
simply never arrive. That cost two minutes of confusion on the first run.

**Two: it must proxy, not connect directly.** Every request uses a same-origin
relative path, and `client/server.mjs` forwards to the gateway and service.
Connecting straight to `:18889` is rejected:

```
WebSocket ws://127.0.0.1:18889/api/realtime → 403
fetch     http://127.0.0.1:18889/api/...    → {"error":"origin not allowed"}
```

The cause is `server/src/core/request-security.mjs` — DNS rebinding protection
requiring the Origin host to equal the request host. A different port can never
satisfy that, and `config.allowedOrigins` does not help (it carries the same host
equality requirement). The framework's own web UI lives at the gateway's `/`, so
it is same-origin by construction.

### One unresolved problem

**The agent's replies show no text in this console.** Tool calls, verification and
order changes all appear on the right in real time — those are server-side facts
and reliable — but the conversation pane only ever shows customer bubbles.

Ruled out: the proxy layer (WebSocket frames and REST requests were both verified
to forward correctly), framework support for assistant transcripts
(`realtime-presentation-runtime.mjs:20-25` listens for six transcript event
types and `web/src/App.jsx:567` consumes them), and model capability
(`textOutput: true`).

Still unexplained: why, on the same gateway, the built-in web UI receives
`role: 'assistant'` messages and this console does not. The only remaining
difference in their `connect` payloads is `inputEnabled` (false from the WebUI,
true from the console).

Use the gateway's own UI to see what the agent says, for now.
