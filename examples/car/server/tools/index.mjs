import { readdir } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { builtinSkills } from '../skills/builtin/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const tools = []
const executors = {}

function registerTool(tool) {
  if (!tool || !tool.function?.name) return
  tools.push({ type: tool.type || 'function', function: tool.function })
  executors[tool.function.name] = tool.execute
}

const files = await readdir(__dirname)
for (const file of files) {
  if (file === 'index.mjs' || !file.endsWith('.mjs')) continue
  const mod = await import(join(__dirname, file))
  const def = mod.default
  if (Array.isArray(def)) {
    def.forEach(registerTool)
  } else {
    registerTool(def)
  }
}

builtinSkills.forEach(registerTool)

export { tools, executors }
