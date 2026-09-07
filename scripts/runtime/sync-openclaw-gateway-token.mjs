#!/usr/bin/env node

import {
  syncOpenClawGatewayTokenFile,
} from '../../server/src/process/backend-drivers/openclaw-auth.mjs'

syncOpenClawGatewayTokenFile({
  targetPath: process.argv[2],
})
