import healerImage from '../assets/personas/healer-character.png'
import actionImage from '../assets/personas/action-character.png'
import wildImage from '../assets/personas/wild-character.png'

const PERSONAS = [
  { id: '聊愈师', desc: '温柔陪伴，用声音治愈旅途疲惫', image: healerImage },
  { id: '行动派', desc: '直击要点，高效执行每一个指令', image: actionImage },
  { id: '疯批', desc: '有逻辑地反驳，毒舌但不越界', image: wildImage },
]

const VOICES = [
  { id: '小酒窝', label: '女/甜美' },
  { id: '台御姐', label: '女/知性' },
  { id: '阳光男', label: '男/温暖' },
  { id: '酷酷男', label: '男/低沉' },
]

const WAKE_POSITIONS = ['主驾', '副驾', '左后', '右后']

export default function PersonaTab({ selectedPersona, onSelectPersona, selectedVoice, onSelectVoice, selectedWake, onSelectWake }) {
  return (
    <>
      <section className="setting-section">
        <h2 className="section-title">灵魂</h2>
        <div className="persona-grid">
          {PERSONAS.map(p => (
            <button
              key={p.id}
              className={`persona-card ${selectedPersona === p.id ? 'is-selected' : ''}`}
              style={{ '--persona-image': `url(${p.image})` }}
              onClick={() => onSelectPersona(p.id)}
              aria-pressed={selectedPersona === p.id}
            >
              <strong>{p.id}</strong>
              <span>{p.desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="setting-section">
        <h2 className="section-title">音色</h2>
        <div className="voice-grid">
          {VOICES.map(v => (
            <button
              key={v.id}
              className={`voice-card ${selectedVoice === v.id ? 'is-selected' : ''}`}
              onClick={() => onSelectVoice(v.id)}
              aria-pressed={selectedVoice === v.id}
            >
              <span><strong>{v.id}</strong><small>{v.label}</small></span>
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
