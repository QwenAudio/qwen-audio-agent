const MAX_ARTIFACTS = 32
const MAX_PARTS = 64
const MAX_TEXT_CHARS = 1_000_000
const MAX_RAW_CHARS = 16_000_000
const MAX_DATA_CHARS = 1_000_000
const MAX_TOTAL_PART_CHARS = 16_000_000
const PUBLIC_URL_PROTOCOLS = new Set(['data:', 'http:', 'https:'])

function clean(value, max) {
  return String(value || '').replaceAll('\u0000', '').trim().slice(0, max)
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function mediaType(value, fallback) {
  const normalized = clean(value, 160).toLowerCase()
  return /^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : fallback
}

function jsonValue(value) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized.length > MAX_DATA_CHARS) return null
    return JSON.parse(serialized)
  } catch {
    return null
  }
}

function normalizePart(part) {
  if (!part || typeof part !== 'object') return null
  const filename = clean(part.filename, 240)
  if (own(part, 'text')) {
    const text = clean(part.text, MAX_TEXT_CHARS)
    if (!text) return null
    return {
      text,
      mediaType: mediaType(part.mediaType || part.mimeType, 'text/plain'),
      ...(filename ? { filename } : {}),
    }
  }
  if (own(part, 'raw')) {
    const raw = clean(part.raw, MAX_RAW_CHARS).replace(/\s/g, '')
    if (!raw || !/^[a-z\d+/]*={0,2}$/i.test(raw)) return null
    return {
      raw,
      mediaType: mediaType(
        part.mediaType || part.mimeType,
        'application/octet-stream',
      ),
      ...(filename ? { filename } : {}),
    }
  }
  if (own(part, 'url')) {
    const url = clean(part.url, 20_000)
    if (!url) return null
    try {
      if (!PUBLIC_URL_PROTOCOLS.has(new URL(url).protocol)) return null
    } catch {
      return null
    }
    return {
      url,
      mediaType: mediaType(
        part.mediaType || part.mimeType,
        'application/octet-stream',
      ),
      ...(filename ? { filename } : {}),
    }
  }
  if (own(part, 'data')) {
    const data = jsonValue(part.data)
    if (data === null && part.data !== null) return null
    return {
      data,
      mediaType: mediaType(part.mediaType || part.mimeType, 'application/json'),
      ...(filename ? { filename } : {}),
    }
  }
  return null
}

function normalizeArtifact(artifact, index) {
  if (!artifact || typeof artifact !== 'object') return null
  const parts = (Array.isArray(artifact.parts) ? artifact.parts : [])
    .slice(0, MAX_PARTS)
    .map(normalizePart)
    .filter(Boolean)
  if (!parts.length) return null
  const artifactId = clean(artifact.artifactId || artifact.id, 160)
    || `artifact_${index + 1}`
  const name = clean(artifact.name, 240)
  const description = clean(artifact.description, 1000)
  return {
    artifactId,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    parts,
  }
}

function partSize(part) {
  if (part.text !== undefined) return part.text.length
  if (part.raw !== undefined) return part.raw.length
  if (part.url !== undefined) return part.url.length
  try {
    return JSON.stringify(part.data).length
  } catch {
    return MAX_TOTAL_PART_CHARS + 1
  }
}

export function normalizeArtifacts(artifacts) {
  const normalized = (Array.isArray(artifacts) ? artifacts : [])
    .slice(0, MAX_ARTIFACTS)
    .map(normalizeArtifact)
    .filter(Boolean)
  const used = new Set()
  let remaining = MAX_TOTAL_PART_CHARS
  return normalized.flatMap(artifact => {
    if (used.has(artifact.artifactId)) return []
    used.add(artifact.artifactId)
    const parts = artifact.parts.filter(part => {
      const size = partSize(part)
      if (size > remaining) return false
      remaining -= size
      return true
    })
    return parts.length ? [{ ...artifact, parts }] : []
  })
}

export function mergeArtifacts(current, incoming) {
  const byId = new Map()
  for (const artifact of normalizeArtifacts(current)) {
    byId.set(artifact.artifactId, artifact)
  }
  for (const artifact of normalizeArtifacts(incoming)) {
    byId.set(artifact.artifactId, artifact)
  }
  return normalizeArtifacts([...byId.values()])
}

export function artifactsFromOutcome(outcome) {
  return normalizeArtifacts(
    outcome?.artifacts || outcome?.metadata?.artifacts,
  )
}
