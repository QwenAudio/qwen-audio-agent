export function recordTaskResult({
  conversationSync,
  ownerId,
  sessionId,
  task,
}) {
  if (!['completed', 'failed'].includes(task?.status)) return null
  return conversationSync.record({
    ownerId,
    sessionId,
    id: `agent:${task.id}`,
    role: 'assistant',
    content: task.status === 'completed' ? task.result : task.error,
    source: 'agent-result',
    // This is a durable task fact recorded before presentation, not an
    // assistant utterance in the user's original realtime turn.
    turnId: null,
    taskId: task.id,
  })
}
