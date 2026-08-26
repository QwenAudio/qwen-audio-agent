import { backendInstructionFromWork } from '../backend/backend-work-input.mjs'
import { COORDINATOR_STABLE_INSTRUCTIONS } from './acp-coordinator-instructions.mjs'

export function buildAcpCoordinatorInstruction({
  includeStableInstructions = true,
  ...work
} = {}) {
  const instruction = backendInstructionFromWork(work)

  return [
    instruction,
    ...(includeStableInstructions
      ? ['', COORDINATOR_STABLE_INSTRUCTIONS]
      : []),
  ].filter(Boolean).join('\n')
}
