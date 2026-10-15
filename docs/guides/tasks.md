# Work & Permissions

With a configured [Backend Agent](../backends/overview.md), ask the assistant to inspect computer
information, edit files, write software, or use the backend's tools and Skills. Execution capabilities,
authentication, and accessible resources depend on that backend environment.

Without a configured backend, the frontend does not expose `spawn_thinking` or `update_agent_task`,
or support scheduled backend execution. Chat, available frontend tools, and scheduled reminders remain usable. Status
and cancellation tools stay available to manage reminders and other existing records.

## Start and Continue

- Start work: “Make a minimal web game.”
- Add instructions: “Give that page a dark background.”
- Check progress: “How far along is it?”
- Cancel: “Cancel that game.”

Work runs asynchronously, so you can keep chatting. Identify the work you mean, or use its card
identifier, particularly when several items are active. Native session restoration, independent
work, and individual tools depend on the backend; one backend's capabilities are not universal guarantees.

By default, the runtime executes one user task at a time; later work queues until the current
task ends. Starting new work never implicitly cancels existing work.
A task waiting for input or permission, or executing delegated work, still occupies its slot until
the whole task ends. You can still answer its questions or steer that same work without creating
another task. The defaults are `QWEN_AUDIO_AGENT_TASK_MAX_CONCURRENT_PER_OWNER=1` and
`QWEN_AUDIO_AGENT_TASK_MAX_CONCURRENT=1`; both limits remain explicitly configurable.
ACP defaults to one coordinator slot and reuses the task's recorded context for updates and
continuation. Sessions do not isolate files, working directories, or external resources.

### Update Work in Progress

“Also draw a cat” queues new work without cancelling the dog drawing. “Change that dog to a cat”
updates the existing work. The frontend uses `spawn_thinking` for new work and `update_agent_task`
for targeted changes and replies, keeping the same work ID and original backend context.
It clarifies ambiguous references instead of choosing based on whether the backend is busy.

- Queued: include new requirements in that work's first execution, without steering another item.
- Awaiting input: send the user's answer as `instruction` on the same task; an optional
  `input_request_id` identifies the exact request. Preserve confirmation, refusal, and changed
  conditions in the user's natural language; the backend interprets them in the original context.
  Changing conditions does not approve the old preview.
- Running: use a verified ACP injection extension when available; otherwise cancel the current
  turn, wait for it to finish, and continue in the same session.
- Completed: continue under the same ID when the original context remains available. Earlier
  results remain in history. If its original session is busy with another task, wait for that
  session rather than steering the other task.

Acceptance does not mean the change has taken effect, and interruption does not undo actions.
Steering changes reset per-task permission grants; session-wide “Always allow” remains effective. Unsupported
updates, unavailable contexts, and results still being delivered return explicit errors.
Backend-native delegations and completed delegated work cannot yet be resumed automatically;
running framework-owned ACP delegations support targeted updates. After a Gateway restart,
unconfirmed updates are not replayed automatically. To stop the whole task, use `cancel_agent_task`;
backend permission decisions still use `respond_permission`.

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
