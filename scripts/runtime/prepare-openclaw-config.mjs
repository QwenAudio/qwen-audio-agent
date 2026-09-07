#!/usr/bin/env node

import {
  writeIsolatedOpenClawConfig,
} from '../../server/src/process/backend-drivers/openclaw-auth.mjs'

const [, , sourcePath, targetPath] = process.argv
if (!writeIsolatedOpenClawConfig({ sourcePath, targetPath })) {
  process.stderr.write('Unable to prepare isolated OpenClaw configuration.\n')
  process.exitCode = 1
}
