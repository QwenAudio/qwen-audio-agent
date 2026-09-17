# Work & Permissions

With a configured [Backend Agent](../backends/overview.md), ask the assistant to inspect computer
information, edit files, write software, or use the backend's tools and Skills. Execution capabilities,
authentication, and accessible resources depend on that backend environment.

Without a configured backend, the frontend does not expose `spawn_thinking` or support scheduled
backend execution. Chat, available frontend tools, and scheduled reminders remain usable. Status
and cancellation tools stay available to manage reminders and other existing records.

## Start and Continue

- Start work: “Make a minimal web game.”
- Add instructions: “Give that page a dark background.”
- Check progress: “How far along is it?”
- Cancel: “Cancel that game.”

Work runs asynchronously, so you can keep chatting. Identify the work you mean, or use its card
identifier, particularly when several items are active. Native session restoration, independent
work, and individual tools depend on the backend; one backend's capabilities are not universal guarantees.

## Understand Work State

Acceptance means the request was received, not completed. Cards may show queued, running, waiting
for input or authorization, preparing an announcement, and final results. Queries and cancellation
must also be judged by their actual returned state; requesting cancellation is not proof it has stopped.

The backend may ask a follow-up question rather than return a final deliverable. Answer it to continue.
If work fails, keep the error and check backend authentication, model quota, and tool configuration.
A connected voice frontend alone does not prove the backend is usable.

## Allow or Reject

When the backend raises a real permission request, the UI displays the operation and the frontend
can ask for your decision. Express it naturally:

| Decision | Effect |
| --- | --- |
| Allow task | Allows this task and its subsequent operations until completion, failure, or cancellation; other tasks require their own approval. |
| Always allow | Allows subsequent Gateway-managed permission requests in the current frontend session, not a permanent change to every backend. |
| Reject | Rejects the current request. |

Ordinary consent means “Allow task,” including subsequent write or delete operations within that task.
Grants live only in the current Gateway process; restarting it requires fresh approval.

If multiple work items await authorization, identify which one you mean. Not every backend exposes
permission events. The frontend cannot create a sandbox for a backend that lacks approval support.
“Always allow” also does not necessarily override a backend's native safety restrictions.

For `native` / `full` startup modes and backend differences, see
[Backend Permission Modes](../configuration/backend.md#backend-permission-modes).

Frontend MCP / OpenAPI services own their own confirmation and authentication. Backend approval is
not a universal safety layer for all tools. Enable only operations you trust and need.
