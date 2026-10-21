import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Avatar UI for this example. Follows the x-omni convention: the Vite config
// lives at the example root, `client/` holds flat sources, and there is no
// nested package manifest — react/vite resolve from the repo root.
//
// Unlike x-omni (dev-server only), the build lands in a skins tree that the
// Gateway serves from /skins, so `npm start` stays a single command that prints
// one URL. Relative base keeps the bundle mount-point independent.
export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  plugins: [react()],
  base: './',
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    // useWebRtcVoice drives the framework's browser transport instead of a copy
    // of it, so the dev server must be allowed to serve files from the repo root.
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
    proxy: {
      '/api': {
        target: process.env.DH_GATEWAY_ORIGIN || 'http://127.0.0.1:18895',
        ws: true,
      },
    },
  },
  build: { outDir: '../skins/digital-human', emptyOutDir: true },
})
