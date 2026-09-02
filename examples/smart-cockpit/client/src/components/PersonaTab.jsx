import { COCKPIT_PERSONAS } from '../config/personas'
import { COCKPIT_VOICES } from '../config/voices'

const WAKE_POSITIONS = ['主驾', '副驾', '左后', '右后']

export default function PersonaTab({ selectedPersona, onSelectPersona, selectedVoice, onSelectVoice, selectedWake, onSelectWake }) {
  return (
    <>
      <section className="setting-section">
        <h2 className="section-title">灵魂</h2>
        <div className="persona-grid">
          {COCKPIT_PERSONAS.map(persona => (
            <button
              key={persona.id}
              className={`persona-card ${selectedPersona === persona.label ? 'is-selected' : ''}`}
              style={{ '--persona-image': `url(${persona.image})` }}
              onClick={() => onSelectPersona(persona.label)}
              aria-pressed={selectedPersona === persona.label}
            >
              <strong>{persona.label}</strong>
              <span>{persona.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="setting-section">
        <h2 className="section-title">音色</h2>
        <div className="voice-grid">
          {COCKPIT_VOICES.map(voice => (
            <button
              key={voice.id}
              className={`voice-card ${selectedVoice === voice.id ? 'is-selected' : ''}`}
              onClick={() => onSelectVoice(voice.id)}
              aria-pressed={selectedVoice === voice.id}
            >
              <span><strong>{voice.label}</strong><small>{voice.id}</small></span>
              <span className="speaker">
                <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4Zm12.5 2a4.4 4.4 0 0 0-2-3.7v7.4a4.4 4.4 0 0 0 2-3.7Z" fill="currentColor" /></svg>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="setting-section">
        <h2 className="section-title">唤醒位置</h2>
        <div className="wake-grid">
          {WAKE_POSITIONS.map(w => (
            <button
              key={w}
              className={`wake-btn ${selectedWake === w ? 'is-selected' : ''}`}
              onClick={() => onSelectWake(w)}
              aria-pressed={selectedWake === w}
            >
              {w}
            </button>
          ))}
        </div>
      </section>
    </>
  )
}
