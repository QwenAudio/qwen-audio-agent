import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  envDir: '../',
  server: {
    proxy: {
      '/api/realtime': {
        target: 'http://127.0.0.1:18888',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
})
