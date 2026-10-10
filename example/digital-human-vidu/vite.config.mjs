import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  server: {
    host: '127.0.0.1', port: 5181, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
    proxy: {
      '/api': { target: process.env.VIDU_GATEWAY_ORIGIN || 'http://127.0.0.1:3101', ws: true },
      '/vidu': { target: 'http://127.0.0.1:5182', ws: true, rewrite: path => path.replace(/^\/vidu/, '') },
    },
  },
  build: { outDir: '../dist', emptyOutDir: true },
})
