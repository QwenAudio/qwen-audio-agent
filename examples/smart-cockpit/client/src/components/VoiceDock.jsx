import { useEffect, useRef, useState } from 'react'
import VoiceWave from './VoiceWave'
import { COCKPIT_PERSONA_LABELS } from '../config/personas'

export default function VoiceDock({ muted, state = 'idle', progress = null, error = null, inputLevel = 0, outputLevel = 0, persona, onSelectPersona, onToggleMute, onOpenSettings }) {
  const activeError = !muted && error
  const activeState = muted ? 'muted' : activeError ? 'error' : state
  const activeProgress = !muted && progress?.message ? progress : null
  const progressClass = activeProgress?.stage ? ` has-progress progress-${activeProgress.stage}` : ''
  const [personaMenuOpen, setPersonaMenuOpen] = useState(false)
  const personaMenuRef = useRef(null)

  useEffect(() => {
    if (!personaMenuOpen) return undefined

    const handlePointerDown = (event) => {
      if (!personaMenuRef.current?.contains(event.target)) {
        setPersonaMenuOpen(false)
      }
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setPersonaMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [personaMenuOpen])

  const selectPersona = (nextPersona) => {
    onSelectPersona(nextPersona)
    setPersonaMenuOpen(false)
  }

  return (
    <section className={`voice-dock is-${activeState}${progressClass}`} aria-label="语音助手">
      <div className="voice-dock-logo-slot" aria-hidden="true" />

      <div className="voice-dock-wave">
        <VoiceWave muted={muted} state={state} progress={activeProgress} inputLevel={inputLevel} outputLevel={outputLevel} />
      </div>

      <div className="voice-dock-controls">
        <button
          className="voice-dock-mic"
          onClick={onToggleMute}
          aria-label={muted ? '取消静音' : '静音'}
          aria-pressed={!muted}
        >
          {muted ? (
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" fill="currentColor" />
              <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" fill="currentColor" />
            </svg>
          )}
        </button>

        <div className="voice-persona-menu" ref={personaMenuRef}>
          <button
            className="voice-select-pill"
            onClick={() => setPersonaMenuOpen(open => !open)}
            aria-label="选择灵魂类型"
            aria-expanded={personaMenuOpen}
            aria-haspopup="menu"
          >
            <span>{persona}</span>
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5H7Z" fill="currentColor" /></svg>
          </button>

          {personaMenuOpen && (
            <div className="voice-persona-options" role="menu" aria-label="灵魂类型">
              {COCKPIT_PERSONA_LABELS.map(item => (
                <button
                  key={item}
                  className={`voice-persona-option ${persona === item ? 'is-selected' : ''}`}
                  onClick={() => selectPersona(item)}
                  role="menuitemradio"
                  aria-checked={persona === item}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <button className="voice-dock-settings" onClick={onOpenSettings} aria-label="打开语音设置">
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.6A7 7 0 0 0 7 6.6l-2.4-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 3l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a7 7 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" fill="currentColor" /></svg>
      </button>
    </section>
  )
}
