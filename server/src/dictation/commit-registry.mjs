const DEFAULT_MAX_RECEIPTS = 512

export class CommitRegistry {
  constructor({ maxReceipts = DEFAULT_MAX_RECEIPTS } = {}) {
    this.maxReceipts = Math.max(1, Number(maxReceipts) || DEFAULT_MAX_RECEIPTS)
    this.receipts = new Map()
  }

  accept({ commitId, revision, payloadHash } = {}) {
    const id = String(commitId || '')
    const receipt = {
      commitId: id,
      revision: Number(revision),
      payloadHash: String(payloadHash || ''),
    }
    const existing = this.receipts.get(id)
    if (existing) {
      const matches = existing.revision === receipt.revision
        && existing.payloadHash === receipt.payloadHash
      return { status: matches ? 'replay' : 'conflict', receipt: existing }
    }
    this.receipts.set(id, receipt)
    while (this.receipts.size > this.maxReceipts) {
      this.receipts.delete(this.receipts.keys().next().value)
    }
    return { status: 'first', receipt }
  }

  clear() {
    this.receipts.clear()
  }
}
