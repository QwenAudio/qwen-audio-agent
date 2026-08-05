#!/usr/bin/env node

import { main } from '../src/launcher.mjs'
import { createLogger } from '../../shared/logger.mjs'

const logger = createLogger({
  component: 'cli',
  fileName: 'cli.log',
  consoleEnabled: false,
})
const startedAt = Date.now()
logger.info('cli.started', {
  command: process.argv[2] || 'gateway',
})

main(process.argv.slice(2)).then(code => {
  if (Number.isInteger(code)) process.exitCode = code
  logger.info('cli.completed', {
    command: process.argv[2] || 'gateway',
    exitCode: Number.isInteger(code) ? code : 0,
    durationMs: Date.now() - startedAt,
  })
}).catch(error => {
  logger.error('cli.failed', {
    command: process.argv[2] || 'gateway',
    durationMs: Date.now() - startedAt,
    error,
  })
  process.stderr.write(`qwenaudio: ${error.message}\n`)
  process.exitCode = 1
})
