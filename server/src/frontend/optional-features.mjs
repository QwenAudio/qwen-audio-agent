import { memoryFrontend } from '../memory/frontend.mjs'
import { knowledgeFrontend } from '../knowledge/frontend.mjs'

// Build-time composition, not runtime discovery. To omit a feature, remove
// its import and entry here and in app/optional-modules.mjs.
export const optionalFrontendFeatures = [memoryFrontend, knowledgeFrontend]
