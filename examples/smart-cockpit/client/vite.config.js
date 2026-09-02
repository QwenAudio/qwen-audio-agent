import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../', '')
  return {
    plugins: [react()],
    envDir: '../',
    server: {
      host: env.COCKPIT_CLIENT_HOST || '127.0.0.1',
      port: Number(env.COCKPIT_CLIENT_PORT) || 5173,
      strictPort: true,
      proxy: {
        '/api/realtime': {
          target: `http://${env.COCKPIT_GATEWAY_HOST || '127.0.0.1'}:${Number(env.COCKPIT_GATEWAY_PORT) || 18888}`,
          ws: true,
        },
        '/api/memory': {
          target: `http://${env.COCKPIT_GATEWAY_HOST || '127.0.0.1'}:${Number(env.COCKPIT_GATEWAY_PORT) || 18888}`,
        },
        '/api': {
          target: env.COCKPIT_SERVICE_ORIGIN || 'http://127.0.0.1:3010',
          ws: true,
        },
      },
    },
  }
})
