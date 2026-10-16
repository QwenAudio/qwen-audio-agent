import { backendInstructionFromWork } from '../../backend-work-input.mjs'

export function buildAcpCoordinatorInstruction(work = {}) {
  return backendInstructionFromWork(work)
}
