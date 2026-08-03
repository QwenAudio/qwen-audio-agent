import {
  createLogger,
  runWithLogContext,
} from '../../../shared/logger.mjs'

export { runWithLogContext }

const testProcess = process.env.NODE_ENV === 'test'
  || process.argv.some(argument => /[\\/](?:test|tests)[\\/]/.test(argument))

export const logger = createLogger({
  component: 'gateway',
  fileName: 'gateway.log',
  consoleEnabled: testProcess ? false : undefined,
  fileEnabled: testProcess ? false : undefined,
})
