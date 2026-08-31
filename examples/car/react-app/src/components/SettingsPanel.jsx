import PersonaTab from './PersonaTab'

const TABS = [
  { id: 'persona', label: '个性化' },
]

export default function SettingsPanel({
  activeTab, onTabChange,
  selectedPersona, onSelectPersona,
  selectedVoice, onSelectVoice,
  selectedWake, onSelectWake,
}) {
  return (
    <section className="settings-panel">
      <nav className="settings-tabs" aria-label="语音设置分类">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab-btn ${activeTab === t.id ? 'is-active' : ''}`}
            onClick={() => onTabChange(t.id)}
            aria-selected={activeTab === t.id}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className={`tab-page ${activeTab === 'persona' ? 'is-active' : ''}`}>
        <PersonaTab
          selectedPersona={selectedPersona} onSelectPersona={onSelectPersona}
          selectedVoice={selectedVoice} onSelectVoice={onSelectVoice}
          selectedWake={selectedWake} onSelectWake={onSelectWake}
        />
      </div>
    </section>
  )
}
