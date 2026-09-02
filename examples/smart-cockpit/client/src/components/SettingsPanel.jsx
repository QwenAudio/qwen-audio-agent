import PersonaTab from './PersonaTab'
import SkillTab from './SkillTab'
import MemoryTab from './MemoryTab'

const TABS = [
  { id: 'persona', label: '个性化' },
  { id: 'skills', label: '技能' },
  { id: 'memory', label: '记忆' },
]

export default function SettingsPanel({
  activeTab, onTabChange,
  selectedPersona, onSelectPersona,
  selectedVoice, onSelectVoice,
  selectedWake, onSelectWake,
  skills, skillsError, onLoadSkill, onDeleteSkill,
  memories, memoryLoading, memoryError, onDeleteMemory, onRefreshMemory,
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
      <div className={`tab-page ${activeTab === 'skills' ? 'is-active' : ''}`}>
        <SkillTab
          skills={skills}
          error={skillsError}
          onLoad={onLoadSkill}
          onDelete={onDeleteSkill}
        />
      </div>
      <div className={`tab-page ${activeTab === 'memory' ? 'is-active' : ''}`}>
        <MemoryTab
          items={memories}
          loading={memoryLoading}
          error={memoryError}
          onDelete={onDeleteMemory}
          onRefresh={onRefreshMemory}
        />
      </div>
    </section>
  )
}
