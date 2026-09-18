import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 5178, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
    proxy: { '/api': { target: 'http://127.0.0.1:18890', ws: true } } },
  build: { outDir: '../dist', emptyOutDir: true },
})
