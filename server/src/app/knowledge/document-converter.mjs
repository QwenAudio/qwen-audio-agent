function clean(value) {
  return String(value || '').trim()
}

/**
 * The single document converter used by the built-in local knowledge provider.
 * It shares the configured Agent runtime, but explicitly requests a fresh,
 * isolated execution context instead of entering the coordinator Session.
 */
export class AgentDocumentConverter {
  constructor({ backendRuntime } = {}) {
    if (typeof backendRuntime?.runIsolated !== 'function') {
      throw new TypeError('AgentDocumentConverter requires isolated backend execution')
    }
    this.backendRuntime = backendRuntime
  }

  async convert({ sourcePath, targetPath } = {}, context = {}) {
    const source = clean(sourcePath)
    const target = clean(targetPath)
    if (!source || !target) {
      throw new TypeError('Document conversion requires sourcePath and targetPath')
    }
    const instruction = [
      `把「${source}」里的文字内容完整提取出来，原样写入「${target}」。`,
      '保留原文措辞、标题层级与条目顺序；不要概括、改写、补充或翻译。',
      '如果是扫描件、加密件或无法可靠提取，不要编造内容，直接说明原因。',
      '写好后只确认已经完成，不要在回复中重复正文。',
    ].join('\n')
    return this.backendRuntime.runIsolated({ instruction }, {
      ownerId: context.ownerId,
      taskId: context.taskId,
      signal: context.signal,
      onEvent: context.onEvent,
    })
  }
}
