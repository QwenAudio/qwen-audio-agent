export function countPilotModel(model, counts) {
  return {
    async complete(options) {
      counts.modelCalls += 1
      return model.complete(options)
    },
    async authorizePriorPlan(options) {
      counts.approvalClassifications += 1
      return model.authorizePriorPlan(options)
    },
  }
}

export async function forwardPilotReply(backend, event, reply, options) {
  if (reply.stop) {
    await backend.cancel(event.taskId, options)
    return false
  }
  await backend.respondInput(event.taskId, event.input.id, { text: reply.content }, options)
  return true
}
