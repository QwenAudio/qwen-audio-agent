import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export function createCockpitViteConfig(env) {
  const mcpCockpitId = env.COCKPIT_FRONTEND_MCP_URL
    ? new URL(env.COCKPIT_FRONTEND_MCP_URL).searchParams.get('cockpitId')
    : null
  return {
    plugins: [react()],
    envDir: '../',
    define: {
      // Use the same default cockpit as the Gateway's foreground MCP tools.
      'import.meta.env.VITE_COCKPIT_ID': JSON.stringify(
        env.VITE_COCKPIT_ID || mcpCockpitId || env.COCKPIT_ID || 'default',
      ),
    },
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
}

export default defineConfig(({ mode }) => createCockpitViteConfig(loadEnv(mode, '../', '')))
