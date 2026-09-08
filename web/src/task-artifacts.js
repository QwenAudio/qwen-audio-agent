const REMOTE_PROTOCOLS = new Set(['http:', 'https:'])

function clean(value) {
  return String(value || '').trim()
}

function safeRemoteUrl(value) {
  try {
    const url = new URL(value)
    if (!REMOTE_PROTOCOLS.has(url.protocol)) return ''
    if (url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}

function serializedData(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

function mediaKind(mediaType) {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType.startsWith('video/')) return 'video'
  return 'file'
}

export function artifactPartView(part, index = 0) {
  if (!part || typeof part !== 'object') return null
  const mediaType = clean(part.mediaType).toLowerCase()
    || 'application/octet-stream'
  const filename = clean(part.filename)

  if (Object.hasOwn(part, 'text')) {
    const content = String(part.text || '')
    return content ? {
      kind: 'text',
      content,
      mediaType,
      filename,
    } : null
  }

  if (Object.hasOwn(part, 'data')) {
    const content = serializedData(part.data)
    return content ? {
      kind: 'data',
      content,
      mediaType,
      filename,
    } : null
  }

  if (Object.hasOwn(part, 'raw')) {
    const raw = clean(part.raw).replace(/\s/g, '')
    if (!raw || !/^[a-z\d+/]*={0,2}$/i.test(raw)) return null
    return {
      kind: mediaKind(mediaType),
      href: `data:${mediaType};base64,${raw}`,
      mediaType,
      filename,
      remote: false,
      index,
    }
  }

  if (Object.hasOwn(part, 'url')) {
    const href = safeRemoteUrl(part.url)
    if (!href) return null
    return {
      kind: mediaKind(mediaType),
      href,
      mediaType,
      filename,
      remote: true,
      index,
    }
  }

  return null
}

export function taskArtifactViews(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : []).flatMap((artifact, index) => {
    if (!artifact || typeof artifact !== 'object') return []
    const parts = (Array.isArray(artifact.parts) ? artifact.parts : [])
      .map((part, partIndex) => artifactPartView(part, partIndex))
      .filter(Boolean)
    if (!parts.length) return []
    return [{
      id: clean(artifact.artifactId) || `artifact_${index + 1}`,
      name: clean(artifact.name),
      description: clean(artifact.description),
      parts,
    }]
  })
}

export function taskHasArtifacts(task) {
  return taskArtifactViews(task?.artifacts).length > 0
}
