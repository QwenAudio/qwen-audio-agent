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

ACP uses one persistent coordinator Session per owner and backend. Its turns run sequentially;
starting new work never implicitly cancels existing work. It uses a project Session for work with
a distinct goal that benefits from sustained, independent execution. Brief operations, clarification,
and result synthesis stay in the coordinator Session. Related follow-ups continue in the original
project Session rather than creating another; the user does not need to request a separate Session.
The coordinator can dispatch several independent tasks in one turn. Backends without delegation
handle the request directly.

After dispatching or continuing independent work, the coordinator ends its turn without waiting,
polling, or repeating the work locally, and becomes available for another request. The project
Sessions keep running; their verified results return through the same coordinator queue for a
final reply. Sessions do not isolate files, working directories, or external resources.

`QWEN_AUDIO_AGENT_TASK_MAX_CONCURRENT_PER_OWNER=1` and `QWEN_AUDIO_AGENT_TASK_MAX_CONCURRENT=1`
remain the default task-admission limits, not limits on the number of project Sessions. A directly
executed task holds its admission slot, including while awaiting input or permission. ACP delegation
releases that slot after the coordinating turn ends, so the default does not restrict all independent
work to one running Session. Increasing these limits does not create more coordinator Sessions.

### Conversation Context

Alongside the current instruction, the runtime supplies up to 2,000 characters of new user/assistant
dialogue to help the coordinator resolve references. It tracks delivered dialogue rather than repeatedly
attaching the whole history. This background is not a new request and does not copy tool calls, tool
results, raw backend output, the frontend persona, or durable memory. Attachments remain native protocol
parts. No additional frontend tool is needed.

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
- Independent ACP work: send changes to the coordinator, which forwards them to the original
  project session with `session_send`, even when there is only one project. Routing waits if the
  coordinator is busy; it never steers an unrelated task. A spoken acknowledgement alone is not delivery.
- Completed, directly executed work: continue under the same ID when the original context remains available. Earlier
  results remain in history. If its original session is busy with another task, wait for that
  session rather than steering the other task.
- Completed framework-owned ACP delegation: continue under the same work ID through the original
  coordinator, which uses `session_send` only for the project sessions bound to that work. It does
  not create replacement sessions or rerun unchanged sibling projects.

Acceptance does not mean the change has taken effect, and interruption does not undo actions.
Steering changes reset per-task permission grants; session-wide “Always allow” remains effective. Unsupported
updates, unavailable contexts, and results still being delivered return explicit errors.
Backend-native delegations without a reliable targeted continuation entry point do not provide
continuation context. Older ACP continuation contexts without versioned project bindings fail
explicitly; targets are not guessed or automatically migrated. Running framework-owned ACP
delegations support targeted updates. After a Gateway restart,
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
