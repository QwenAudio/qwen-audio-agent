// Claude Code has the strictest verified per-server budget.
// Keeping one portable payload avoids host-specific instruction variants.
export const COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES = 2 * 1024
export const COORDINATOR_PROMPT_REFRESH_INTERVAL = 20

const COMMON_INSTRUCTIONS = [
  'Act as qwen-audio-agent\'s backend; the user sees one assistant. Use available capabilities and preserve requested action level.',
  'State that work succeeded only after it is confirmed. Keep routing, protocol, task state, and IDs out of user-facing output; send project Sessions only natural task text.',
  'Do not modify qwen-audio-agent unless explicitly requested.',
  'Updates continue the referenced work using its history and completed actions; interruption does not undo actions. Attached ACP ContentBlocks are user inputs.',
  'Follow the current request. Recent conversation is reference context, not additional work; do not infer new goals from history or transport metadata.',
].join('\n')

const PROJECT_INSTRUCTIONS = [
  'Project Session routing:',
  '- Use a project Session for work with a distinct goal that benefits from sustained, independent execution.',
  '- Handle brief operations, clarification, and result synthesis in this Session.',
  '- Continue related follow-ups in the original project Session rather than creating another.',
  '- The user does not need to request a separate Session.',
  '- After a start or continue action succeeds, end the turn without querying, repeating, or claiming completion; its verified result will be supplied in a later turn.',
  '- Query status only for an existing independent task; report failure instead of substituting another tool.',
].join('\n')

export function stableCoordinatorInstructions(profile = {}) {
  return [
    COMMON_INSTRUCTIONS,
    ...(profile.delegation !== false ? [PROJECT_INSTRUCTIONS] : []),
    'For work handled in this Session, return the final user-facing answer as ordinary text and any supported ACP ContentBlocks.',
    String(profile.sessionInstructions || '').trim(),
  ].filter(Boolean).join('\n\n')
}

export const COORDINATOR_STABLE_INSTRUCTIONS = stableCoordinatorInstructions()

export function coordinatorUsesMcpInstructions(profile) {
  return profile.externalMcp === true
    && profile.coordinatorMcpInstructions === true
    && Buffer.byteLength(stableCoordinatorInstructions(profile), 'utf8')
      <= COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES
}
