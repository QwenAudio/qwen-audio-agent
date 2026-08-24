import { readdir, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { domainExecutorRegistry } from '../../domain-executors/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const domainsDir = join(__dirname, '../../domains')

const builtinSkills = []
const builtinSkillExecutors = {}
const builtinSkillCatalog = []
const builtinDomainCatalog = []

function registerSkill(skill) {
  if (!skill || !skill.function?.name) return
  builtinSkills.push(skill)
  builtinSkillExecutors[skill.function.name] = skill.execute
  builtinSkillCatalog.push({
    id: skill.skill?.id || `builtin.${skill.function.name}`,
    name: skill.skill?.name || skill.function.name,
    toolName: skill.function.name,
    description: skill.skill?.description || skill.function.description,
    domain: skill.skill?.domain || '',
    label: skill.skill?.label || skill.skill?.name || skill.function.name,
    exposure: skill.skill?.exposure || {},
  })
}

function defaultParameters(parameters) {
  return parameters || { type: 'object', properties: {} }
}

function registerDomainFunction(domain, fn) {
  if (fn.enabled === false) return
  if (!fn.name) throw new Error(`Domain ${domain.domain} has a function without name`)
  if (!fn.executor) throw new Error(`Domain function ${fn.name} is missing executor`)

  const executor = domainExecutorRegistry[fn.executor]
  if (!executor) throw new Error(`Missing executor ${fn.executor} for function ${fn.name}`)

  registerSkill({
    type: 'function',
    skill: {
      id: fn.id || `builtin.${fn.name}`,
      name: fn.label || fn.name,
      label: fn.label || fn.name,
      description: fn.description,
      domain: domain.domain,
      exposure: fn.exposure || {},
    },
    function: {
      name: fn.name,
      description: fn.description,
      parameters: defaultParameters(fn.parameters),
    },
    execute: executor,
  })
}

async function loadDomainDefinitions() {
  const files = (await readdir(domainsDir)).filter(file => file.endsWith('.json')).sort()
  for (const file of files) {
    const domain = JSON.parse(await readFile(join(domainsDir, file), 'utf8'))
    if (domain.enabled === false) continue
    builtinDomainCatalog.push({
      domain: domain.domain,
      label: domain.label || domain.domain,
      description: domain.description || '',
      routeRules: domain.routeRules || [],
      examples: domain.examples || [],
      functions: (domain.functions || [])
        .filter(fn => fn.enabled !== false)
        .map(fn => ({
          name: fn.name,
          label: fn.label || fn.name,
          description: fn.description,
          exposure: fn.exposure || {},
        })),
    })
    for (const fn of domain.functions || []) {
      registerDomainFunction(domain, fn)
    }
  }
}

await loadDomainDefinitions()

const files = await readdir(__dirname)
for (const file of files) {
  if (file === 'index.mjs' || !file.endsWith('.mjs')) continue
  const mod = await import(join(__dirname, file))
  const def = mod.default
  if (Array.isArray(def)) {
    def.forEach(registerSkill)
  } else {
    registerSkill(def)
  }
}

export { builtinSkills, builtinSkillExecutors, builtinSkillCatalog, builtinDomainCatalog }
