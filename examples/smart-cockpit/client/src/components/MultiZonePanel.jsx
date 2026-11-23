import { useState } from 'react'

const ZONES = [
  { id: 'driver', label: '主驾', window: 'windowFL', temp: 'acTemp' },
  { id: 'passenger', label: '副驾', window: 'windowFR', temp: 'passengerTemp' },
  { id: 'rearLeft', label: '左后', window: 'windowRL', temp: 'rearTemp' },
  { id: 'rearRight', label: '右后', window: 'windowRR', temp: 'rearTemp' },
]
const EMPTY = { driver: '', passenger: '', rearLeft: '', rearRight: '' }
const PRESETS = [
  ['独立指令', { ...EMPTY, driver: '打开车窗', passenger: '温度调整到24度' }],
  ['我也要', { ...EMPTY, driver: '打开车窗', passenger: '我也要' }],
  ['四区交互', { driver: '打开车窗', passenger: '温度调整到24度', rearLeft: '打开我的座椅加热', rearRight: '我也要' }],
]

export default function MultiZonePanel({ state, ready, carState, onSend, voiceMuted, voiceError, onToggleVoice, messages, onOpenChat, onClose }) {
  const [drafts, setDrafts] = useState(EMPTY)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const batch = state.batch
  const wakeZone = state.wakeZone || 'driver'
  const recent = state.history?.[0]
  const calls = messages.flatMap(message => message.debug?.tool_calls || []).slice(-8)
  const reply = [...messages].reverse().find(message => message.role === 'assistant' && message.content)?.content
  const send = async event => {
    event.preventDefault()
    const rows = ZONES.filter(zone => drafts[zone.id].trim()).map(zone => ({ zone: zone.id, text: drafts[zone.id].trim() }))
    if (!rows.length) return
    setSending(true)
    setError('')
    try {
      await onSend(rows)
      setDrafts(current => Object.fromEntries(ZONES.map(zone => [zone.id, current[zone.id] === drafts[zone.id] ? '' : current[zone.id]])))
    } catch (reason) { setError(reason.message) } finally { setSending(false) }
  }
  return (
    <section className="multi-zone-panel" aria-label="四音区模拟">
      <header className="multi-zone-heading">
        <div><small>SMART COCKPIT · MULTI-ZONE</small><h2>四音区交互</h2></div>
        <div className="zone-heading-actions">
          <span className={`zone-connection ${ready ? 'is-ready' : ''}`}>{ready ? '已连接' : '连接中'}</span>
          <button type="button" className="zone-close" onClick={onClose}>返回座舱</button>
        </div>
      </header>
      <p className="zone-description">主驾为唤醒音区，麦克风直连中央。其他三区用文字模拟识别结果，可独立发送；多人参与时收齐本轮话语后统一处理。</p>
      <div className="zone-presets" aria-label="多音区示例">
        {PRESETS.map(([label, values]) => <button key={label} type="button" onClick={() => setDrafts({ ...values })}>{label}</button>)}
      </div>
      <form onSubmit={send}>
        <div className="zone-seat-grid">
          {ZONES.map(zone => {
            const entry = batch?.entries.filter(row => row.zone === zone.id).at(-1)
            const status = entry ? entry.ended && entry.final ? '已就绪' : entry.ended ? '等待最终识别' : '正在说话' : zone.id === 'driver' && state.driverSpeaking ? '正在说话' : '等待输入'
            return (
              <article key={zone.id} className={`zone-seat ${entry ? 'is-speaking' : ''}`}>
                <div className="zone-seat-title"><strong>{zone.label}{zone.id === wakeZone ? ' · 唤醒区' : ''}</strong><span>{status}</span></div>
                <label htmlFor={`zone-${zone.id}`} className="zone-input-label">{zone.label}文字输入</label>
                <textarea id={`zone-${zone.id}`} value={drafts[zone.id]} maxLength={2000} placeholder={zone.id === 'driver' ? '文字测试，或使用主驾麦克风' : '输入该座位的话，例如“我也要”'} onChange={event => setDrafts(current => ({ ...current, [zone.id]: event.target.value }))} />
                {entry && <p className="zone-transcript">{entry.text || '正在识别…'}</p>}
                <div className="zone-vehicle-state"><span>车窗 {carState[zone.window] > 0 ? '已打开' : '已关闭'}</span><span>{carState[zone.temp]}°C</span><span>加热 {carState.seatHeating?.[zone.id] || 0}档</span></div>
              </article>
            )
          })}
        </div>
        <div className="zone-actions">
          <button type="button" className="zone-mic" aria-pressed={!voiceMuted} onClick={onToggleVoice}>{voiceMuted ? '开启主驾语音' : '关闭主驾语音'}</button>
          <button type="submit" className="zone-send" disabled={!ready || sending || !Object.values(drafts).some(text => text.trim())}>{sending ? '发送中…' : '发送本轮输入'}</button>
        </div>
      </form>
      <div className="zone-collection-state" role="status" aria-live="polite">
        {batch ? batch.status === 'waiting_realtime' ? '各区已识别，等待中央原生轮次与旧回复终止…' : batch.status === 'merging' ? '各音区已就绪，正在合并本轮输入…' : `正在收集：${batch.entries.map(entry => entry.label).join('、')}。等待 Smart Turn 发言结束和最终识别。` : recent?.status === 'failed' ? recent.error : recent ? '本轮已提交中央 Realtime，执行结果见车辆状态和工具回执。' : '中央已绑定主驾唤醒音区；其他区文字可独立发送'}
      </div>
      {(error || state.asrError || voiceError) && <p className="zone-error" role="alert">{error || state.asrError || voiceError}</p>}
      <div className="zone-debug">
        <details open><summary>本轮合并文本 <span>轮次：{state.asr || 'Smart Turn'}</span></summary><pre>{batch?.entries.map(entry => `【${entry.label}】${entry.text || '识别中…'}`).join('\n') || recent?.text || state.driverTranscript || '尚未提交'}</pre></details>
        {reply && <p className="zone-reply">{reply}</p>}
        <details><summary>实际工具调用 · {calls.length}</summary>
          <button type="button" onClick={onOpenChat}>打开完整对话</button>
          {calls.length ? calls.map((call, index) => <div className="zone-tool" key={call.callId || index}><strong>{call.name}</strong><span>{call.status}</span><pre>{JSON.stringify(call.arguments, null, 2)}</pre><p>{call.result}</p></div>) : <p>尚无工具调用</p>}
        </details>
        <details><summary>最近批次 · {state.history?.length || 0}</summary>{state.history?.map(row => <div key={row.id}><small>{row.status === 'failed' ? '失败' : '已提交'} · {new Date(row.startedAt).toLocaleTimeString()}</small><pre>{row.text || row.error}</pre></div>)}</details>
      </div>
      <p className="zone-footnote">中央固定绑定主驾唤醒音区，其他音区请求仍按各自座位执行。左后、右后共享后排温区；已执行动作不会自动撤销。</p>
    </section>
  )
}
