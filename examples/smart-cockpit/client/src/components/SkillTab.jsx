import { useEffect, useState } from 'react'
import navigatorImage from '../assets/skills/navigator.png'
import musicMasterImage from '../assets/skills/music-master.png'
import vehicleControlImage from '../assets/skills/vehicle-control.png'
import flashBuyImage from '../assets/taobao_flashbuy.png'

const BUILTIN_SKILLS = [
  { id: 'route', title: '领航员', desc: '智能规划路线，支持有序途经点。', image: navigatorImage },
  { id: 'rest', title: '音乐大师', desc: '搜索、播放与控制座舱音乐。', image: musicMasterImage },
  { id: 'control', title: '车控大管家', desc: '查询并控制车辆座舱设备。', image: vehicleControlImage },
  { id: 'flashbuy', title: '闪购达人', desc: '搜索、加购、预览并确认下单。', logo: flashBuyImage },
]

const TrashIcon = () => (
  <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v9h-2V9Zm4 0h2v9h-2V9ZM7 9h2v10h8V9h2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Z" fill="currentColor" /></svg>
)

const CodeIcon = () => (
  <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z" fill="currentColor" /></svg>
)

function BuiltinCard({ skill }) {
  return (
    <article
      className={`skill-card ${skill.id}`}
      style={skill.image ? { '--skill-image': `url(${skill.image})` } : undefined}
    >
      {skill.logo && <img className="skill-card-logo" src={skill.logo} alt="" aria-hidden="true" />}
      <strong>{skill.title}</strong>
      <span>{skill.desc}</span>
    </article>
  )
}
function SkillDetail({ skillId, onLoad, onClose }) {
  const [skill, setSkill] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    onLoad(skillId)
      .then(value => {
        if (!disposed) setSkill(value)
      })
      .catch(reason => {
        if (!disposed) setError(reason?.message || '加载失败')
      })
    return () => { disposed = true }
  }, [onLoad, skillId])

  return (
    <div className="skill-detail-overlay" onClick={onClose}>
      <div className="skill-detail" onClick={event => event.stopPropagation()}>
        <div className="skill-detail-header">
          <strong>{skill?.name || '自定义技能'}</strong>
          <button className="skill-detail-close" onClick={onClose} aria-label="关闭">
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>
        <pre className="skill-detail-content">{error || skill?.instructions || '加载中...'}</pre>
      </div>
    </div>
  )
}

export default function SkillTab({ skills = [], error, onLoad, onDelete }) {
  const [detailId, setDetailId] = useState(null)

  const remove = async (skill) => {
    if (!window.confirm(`删除自定义技能“${skill.name}”？`)) return
    try {
      await onDelete(skill.id)
    } catch {
      // The hook exposes the persistent error on the next refresh.
    }
  }

  return (
    <div className="skill-scroll">
      <h2 className="section-title">座舱能力</h2>
      <div className="builtin-grid">
        {BUILTIN_SKILLS.map(skill => <BuiltinCard key={skill.id} skill={skill} />)}
      </div>

      <div className="custom-head">
        <span>我的技能</span>
        <span>通过语音创建</span>
      </div>
      <div className="custom-grid" aria-label="自定义技能">
        {skills.map(skill => (
          <article key={skill.id} className="custom-skill">
            <span><strong>{skill.name}</strong><span>{skill.description}</span></span>
            <div className="custom-skill-actions">
              <button className="code-btn" aria-label={`查看${skill.name}详情`} onClick={() => setDetailId(skill.id)}><CodeIcon /></button>
              <button className="trash-btn" aria-label={`删除${skill.name}`} onClick={() => remove(skill)}><TrashIcon /></button>
            </div>
          </article>
        ))}
      </div>
      {!skills.length && (
        <div className="empty-state" style={{ display: 'block' }}>
          {error || '暂无自定义技能，可以说“创建一个下班回家技能”'}
        </div>
      )}

      {detailId && <SkillDetail skillId={detailId} onLoad={onLoad} onClose={() => setDetailId(null)} />}
    </div>
  )
}
