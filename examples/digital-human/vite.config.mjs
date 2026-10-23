import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Resolve only PUBLIC exports to checkout source. A source-copied example
// instead resolves the installed qwen-audio-agent package.
const root = new URL('../../', import.meta.url)
const manifest = new URL('package.json', root)
const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null
const alias = pkg?.name === 'qwen-audio-agent'
  ? Object.entries(pkg.exports).filter(([, target]) => typeof target === 'string' && !target.includes('*'))
    .map(([key, target]) => ({ find: `qwen-audio-agent/${key.slice(2)}`, replacement: fileURLToPath(new URL(target, root)) }))
  : []

export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  plugins: [react()], base: './',
  resolve: { alias, dedupe: ['react', 'react-dom'] },
  build: { outDir: '../dist', emptyOutDir: true },
})
