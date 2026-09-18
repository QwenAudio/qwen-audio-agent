import { fileURLToPath, pathToFileURL } from 'node:url'
import { requireWebRtcDependencies } from '../../shared/gateway/webrtc.mjs'

export function demoEnvironment(environment, args = []) {
  if (args.some(arg => arg !== '--omni')) throw new Error('Usage: node start.mjs [--omni]')
  return {
    ...environment,
    QWAUDIO_WEBRTC_ENABLED: '1',
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_MODEL: args.includes('--omni')
      ? 'qwen3.5-omni-plus-realtime'
      : 'qwen-audio-3.0-realtime-plus',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    try { process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const environment = demoEnvironment(process.env, process.argv.slice(2))
    requireWebRtcDependencies()
    Object.assign(process.env, environment)
    process.chdir(fileURLToPath(new URL('../../', import.meta.url)))
    console.log(`WebRTC example: ${environment.QWEN_AUDIO_REALTIME_MODEL}`)
    console.log('When the Gateway is ready, open /api/realtime/webrtc/example at its printed origin (default http://127.0.0.1:3101).')
    await import('../../server/src/index.mjs')
  } catch (error) {
    console.error(`WebRTC example: ${error.message}`)
    process.exitCode = 1
  }
}
