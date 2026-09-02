# Qwen Audio Agent Customer Service

[English](README.md) | [中文](README_ZH.md)

> **Status: work in progress (draft).** The service layer and the full retail tool
> surface are usable (including write operations and the approval mechanism). The client
> UI, Gateway composition and backend Agent are not wired yet. See "What runs today".

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
cd examples/customer-service/service
npm install
npm test                    # 56 assertions: 15 data integrity + 18 service + 23 write/approval
npm start                   # defaults to http://127.0.0.1:3110
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

1. **End-to-end probe of `auth_required`.** The chain is wired on the realtime side
   (6 sites in `realtime-gateway.mjs`, 2 in `tool-call-handler.mjs`) but the cockpit example
   never needs it, so it **may never have run in a real voice session**. Whether it works
   affects how tools are split between surfaces.
2. **Gateway composition and backend Agent** (mirroring `smart-cockpit/gateway` and `agent/`).
3. **Exchanges** (`exchange_items`): needs a stock check and a price-difference step on top
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
