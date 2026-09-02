import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = fileURLToPath(
  new URL('../../.runtime/custom-skills/', import.meta.url),
)
const SKILL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/u

function normalizedText(value, field, { maxLength, required = true } = {}) {
  const text = String(value || '').replace(/\r\n?/gu, '\n').trim()
  if (required && !text) throw new TypeError(`${field} is required`)
  if (text.length > maxLength) {
    throw new TypeError(`${field} must not exceed ${maxLength} characters`)
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw new TypeError(`${field} contains unsupported control characters`)
  }
  return text
}

function cockpitDirectory(root, cockpitId) {
  const id = normalizedText(cockpitId || 'default', 'cockpitId', { maxLength: 120 })
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 24)
  return resolve(root, digest)
}

function publicSummary(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}
function validRecord(value) {
  return value
    && value.version === 1
    && SKILL_ID_PATTERN.test(value.id)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && typeof value.instructions === 'string'
}

export class CustomSkillStore {
  constructor({ root = DEFAULT_ROOT, now = () => new Date() } = {}) {
    this.root = resolve(root)
    this.now = now
  }

  async list(cockpitId = 'default') {
    const skills = await this.#readAll(cockpitId)
    return skills
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(publicSummary)
  }

  async get(cockpitId = 'default', reference) {
    const value = normalizedText(reference, 'skill reference', { maxLength: 80 })
    const skills = await this.#readAll(cockpitId)
    const normalizedName = value.toLocaleLowerCase('zh-CN')
    const skill = skills.find(item => (
      item.id === value || item.name.toLocaleLowerCase('zh-CN') === normalizedName
    ))
    return skill ? structuredClone(skill) : null
  }

  async upsert(cockpitId = 'default', input = {}) {
    const name = normalizedText(input.name, 'skill name', { maxLength: 40 })
    const description = normalizedText(input.description, 'skill description', {
      maxLength: 200,
    })
    const instructions = normalizedText(input.instructions, 'skill instructions', {
      maxLength: 8_000,
    })
    const directory = cockpitDirectory(this.root, cockpitId)
    const existing = (await this.#readAll(cockpitId)).find(
      item => item.name.toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN'),
    )
    const timestamp = this.now().toISOString()
    const skill = {
      version: 1,
      id: existing?.id || randomUUID(),
      name,
      description,
      instructions,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    }
    await mkdir(directory, { recursive: true })
    await writeFile(
      resolve(directory, `${skill.id}.json`),
      `${JSON.stringify(skill, null, 2)}\n`,
      'utf8',
    )
    return structuredClone(skill)
  }

  async delete(cockpitId = 'default', reference) {
    const skill = await this.get(cockpitId, reference)
    if (!skill) return null
    await rm(resolve(cockpitDirectory(this.root, cockpitId), `${skill.id}.json`), {
      force: true,
    })
    return publicSummary(skill)
  }

  async #readAll(cockpitId) {
    const directory = cockpitDirectory(this.root, cockpitId)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const skills = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const value = JSON.parse(await readFile(resolve(directory, entry.name), 'utf8'))
        if (validRecord(value)) skills.push(value)
      } catch {
        // One damaged user skill must not make the whole cockpit unavailable.
      }
    }
    return skills
  }
}
