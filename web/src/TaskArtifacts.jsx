import MessageContent, { MediaEmbed } from './MessageContent.jsx'
import { t } from './i18n.js'
import { taskArtifactViews } from './task-artifacts.js'

function partLabel(part, index) {
  return part.filename || t('文件 {number}', { number: index + 1 })
}

function ArtifactPart({ part, index }) {
  if (part.kind === 'text') {
    return <MessageContent role="assistant" content={part.content} />
  }
  if (part.kind === 'data') {
    return <pre className="task-artifact-data">{part.content}</pre>
  }
  if (part.remote && ['image', 'audio', 'video'].includes(part.kind)) {
    return <MediaEmbed
      key={part.href}
      src={part.href}
      alt={partLabel(part, index)}
      type={part.kind}
    />
  }
  if (part.kind === 'image') {
    return <a
      className="task-artifact-image"
      href={part.href}
      download={part.filename || undefined}
      target="_blank"
      rel="noopener noreferrer"
    >
      <img src={part.href} alt={partLabel(part, index)} loading="lazy" />
    </a>
  }
  return <a
    className="task-artifact-file"
    href={part.href}
    download={part.remote ? undefined : part.filename || undefined}
    target="_blank"
    rel="noopener noreferrer"
  >
    <span aria-hidden="true">↗</span>
    {partLabel(part, index)}
  </a>
}

export default function TaskArtifacts({ artifacts }) {
  const views = taskArtifactViews(artifacts)
  if (!views.length) return null
  return <section className="task-artifacts" aria-label={t('任务产物')}>
    {views.map((artifact, artifactIndex) => <section
      className="task-artifact"
      key={artifact.id}
    >
      <strong>{artifact.name || t('任务产物 {number}', {
        number: artifactIndex + 1,
      })}</strong>
      {artifact.description && <small>{artifact.description}</small>}
      <div className="task-artifact-parts">
        {artifact.parts.map((part, partIndex) => <ArtifactPart
          key={`${artifact.id}:${partIndex}`}
          part={part}
          index={partIndex}
        />)}
      </div>
    </section>)}
  </section>
}
