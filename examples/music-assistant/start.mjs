import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_DASHSCOPE_REALTIME_MODEL } from '../../shared/realtime-model-catalog.mjs'

export function demoEnvironment(environment) {
  return {
    ...environment,
    QWEN_AUDIO_FRONTEND_PROFILE:
      environment.QWEN_AUDIO_FRONTEND_PROFILE
      || fileURLToPath(new URL('./frontend-profile.json', import.meta.url)),
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_MODEL: environment.QWEN_AUDIO_REALTIME_MODEL || DEFAULT_DASHSCOPE_REALTIME_MODEL,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    try { process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    Object.assign(process.env, demoEnvironment(process.env))
    process.chdir(fileURLToPath(new URL('../../', import.meta.url)))
    console.log(`Music assistant example: model ${process.env.QWEN_AUDIO_REALTIME_MODEL}`)
    console.log('Gateway endpoint: ws://127.0.0.1:3101/api/realtime (loopback needs no token).')
    console.log('For a phone or another machine, set HOST=0.0.0.0 and QWEN_AUDIO_GATEWAY_ACCESS_TOKEN (>= 24 chars).')
    await import('../../server/src/index.mjs')
  } catch (error) {
    console.error(`Music assistant example: ${error.message}`)
    process.exitCode = 1
  }
}
