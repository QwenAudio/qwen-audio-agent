import { AnnouncementManager } from './announcement-manager.mjs'
import {
  ProgressAnnouncementManager,
} from './progress-announcement-manager.mjs'

const RESULT_METHODS = Object.freeze([
  'completed',
  'failed',
  'dismissActive',
  'confirmMany',
  'retryMany',
  'flush',
  'pause',
  'close',
])

const PROGRESS_METHODS = Object.freeze([
  'offer',
  'remove',
  'clear',
  'flush',
  'close',
])

function assertMethods(value, methods, label) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${label} must be an object`)
  }
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`${label}.${method} must be a function`)
    }
  }
}

/**
 * Default code-level composition for background Task announcements.
 *
 * A scenario may replace this factory at the Gateway composition root. The
 * supplied options are live runtime dependencies, not user configuration;
 * protocol and default product behaviour remain owned by these managers.
 */
export function createTaskAnnouncementRuntime({
  resultOptions,
  progressOptions,
} = {}) {
  return {
    results: new AnnouncementManager(resultOptions || {}),
    progress: new ProgressAnnouncementManager(progressOptions),
  }
}

export function resolveTaskAnnouncementRuntime(factory, options) {
  if (typeof factory !== 'function') {
    throw new TypeError('taskAnnouncementFactory must be a function')
  }
  const runtime = factory(options)
  assertMethods(runtime?.results, RESULT_METHODS, 'Task announcement results')
  assertMethods(runtime?.progress, PROGRESS_METHODS, 'Task announcement progress')
  return runtime
}
