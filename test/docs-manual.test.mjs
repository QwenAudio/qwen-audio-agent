import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseArguments } from '../cli/src/arguments.mjs'
import { REALTIME_PROVIDERS } from '../shared/realtime-provider-definitions.mjs'

const root = fileURLToPath(new URL('../docs/', import.meta.url))
// Git may check out Markdown with CRLF on Windows; examples are unchanged.
const read = file => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n')

function markdownFiles(directory = root, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || ['roadmap', 'promo'].includes(entry.name)) return []
    const name = prefix + entry.name
    return entry.isDirectory()
      ? markdownFiles(join(directory, entry.name), `${name}/`)
      : entry.name.endsWith('.md') ? [name] : []
  })
}

const files = markdownFiles()
// Maintainer-only, unpaired pages are outside the published manual.
const pairs = files.filter(file => !file.endsWith('.zh.md')
  && files.includes(file.replace(/\.md$/, '.zh.md')))

test('bilingual manual pairs document the same configuration identifiers', () => {
  const identifiers = text => [...new Set(text.match(
    /\b(?:QWEN_[A-Z_0-9]+|QWAUDIO_[A-Z_0-9]+|(?:DASHSCOPE|DEEPSEEK|GPT_LIVE|GOOGLE_LIVE|STEPFUN|SPEECH_TO_SPEECH|MINICPM_O|ACP|OPENCODE|OPENCLAW|QODER|KIMI|PI|CODEX|CLAUDE_CODE|MUSE)_[A-Z_0-9]+)\b/g,
  ) || [])].sort()
  for (const file of pairs) {
    assert.deepEqual(identifiers(read(file)), identifiers(read(file.replace(/\.md$/, '.zh.md'))), file)
  }
})

test('frontend guide includes every built-in provider and its primary settings', () => {
  for (const suffix of ['md', 'zh.md']) {
    const document = read(`configuration/frontend.${suffix}`)
    for (const provider of REALTIME_PROVIDERS) {
      assert.ok(document.includes(`\`${provider.key}\``), `${suffix}: ${provider.key}`)
      for (const field of provider.settings) {
        assert.ok(document.includes(field.environment[0]), `${suffix}: ${field.environment[0]}`)
      }
    }
  }
})

test('manual shell examples use CLI arguments accepted by the current parser', () => {
  let checked = 0
  for (const file of pairs.flatMap(file => [file, file.replace(/\.md$/, '.zh.md')])) {
    for (const fence of read(file).matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
      for (const line of fence[1].replace(/\\\r?\n/g, ' ').split('\n')) {
        if (!/^qwenaudio(?:\s|$)/.test(line)) continue
        // These examples use simple quoted arguments, not arbitrary shell programs.
        const words = line.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || []
        const comment = words.findIndex(word => word.startsWith('#'))
        const args = (comment < 0 ? words : words.slice(0, comment)).slice(1)
          .map(word => word.replace(/^(?:"|')|(?:"|')$/g, ''))
        // The launcher handles version before argument parsing.
        if (args.length === 1 && ['--version', '-v'].includes(args[0])) continue
        assert.doesNotThrow(() => parseArguments(args, {}), `${file}: ${line}`)
        checked++
      }
    }
  }
  assert.ok(checked > 0, 'expected executable CLI examples')
})

test('frontend MCP and OpenAPI configuration examples contain valid JSON', () => {
  for (const name of ['frontend-mcp', 'frontend-openapi', 'frontend-profile']) {
    for (const suffix of ['md', 'zh.md']) {
      const file = `reference/${name}.${suffix}`
      const examples = [...read(file).matchAll(/```json\n([\s\S]*?)```/g)]
      assert.ok(examples.length, `${file}: missing example`)
      for (const example of examples) {
        assert.doesNotThrow(() => JSON.parse(example[1]), file)
      }
    }
  }
})
