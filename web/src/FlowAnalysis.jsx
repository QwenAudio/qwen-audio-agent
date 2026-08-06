import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  FLOW_LAYERS,
  buildFlowRows,
  formatOffset,
} from './flow-timeline.js'

// The message flow analysis page. Reached with ?analysis=flow, which is why no
// router is needed.
//
// A conversation is shown as one timeline rather than one per turn. The
// failures worth finding here are session-level: a permission raised in one
// turn and attributed to another, a listener that outlived the turn that
// installed it. Split per turn, the cause and the effect land on separate
// pages and the tool is blind to exactly what it exists to find.
// Anything past this reads better as a block than as a table cell.
const LONG_FIELD_CHARS = 80

// Fields that are long and mostly boilerplate: shown, but not in the way.
// Only the prompt starts closed, because it is mostly the same instructions
// every turn and what differs was pulled out into the table above. Everything
// else, content included, is what the reader came for and opens straight away.
const COLLAPSED_FIELDS = new Set(['prompt'])

function detailFields(detail) {
  const short = []
  const long = []
  for (const [key, value] of Object.entries(detail || {})) {
    if (value === null || value === undefined || value === '') continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text.length > LONG_FIELD_CHARS || text.includes('\n')) long.push([key, text])
    else short.push([key, text])
  }
  return { short, long }
}

function rowClass(row, selected) {
  const base = `flow-row flow-row-${row.layer}`
  // Selection is marked in addition to severity rather than instead of it: a
  // row can be both the one being read and the one at fault.
  const picked = selected ? ' flow-row-on' : ''
  if (row.severity === 'error') return `${base} flow-row-error${picked}`
  if (row.severity === 'warn') return `${base} flow-row-warn${picked}`
  return `${base}${picked}`
}

export default function FlowAnalysis() {
  const [sessions, setSessions] = useState([])
  const [selected, setSelected] = useState('')
  const [session, setSession] = useState(null)
  const [anomalies, setAnomalies] = useState([])
  const [error, setError] = useState('')
  const [openRow, setOpenRow] = useState(null)
  const [layerFilter, setLayerFilter] = useState('')

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/sessions/flows')
      if (response.status === 404) {
        const body = await response.json().catch(() => ({}))
        setError(body.hint || '消息流分析未开启')
        return
      }
      const body = await response.json()
      setSessions(body.sessions || [])
      setError('')
      // Opening the page almost always means looking at what just happened.
      setSelected(current => current || body.sessions?.[0]?.sessionId || '')
    } catch (cause) {
      setError(`无法读取会话列表：${cause.message}`)
    }
  }, [])

  const loadSession = useCallback(async id => {
    if (!id) return
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/flow`)
      if (!response.ok) return
      const body = await response.json()
      setSession(body)
      setAnomalies(body.anomalies || [])
    } catch {
      // A failed refresh leaves the previous view in place, which is more
      // useful than blanking the page mid-investigation.
    }
  }, [])

  useEffect(() => {
    loadSessions()
    const timer = setInterval(loadSessions, 4000)
    return () => clearInterval(timer)
  }, [loadSessions])

  // Polling rather than streaming: a merged session timeline changes shape when
  // events from any turn arrive, and some anomaly rules depend on elapsed time,
  // so a whole re-read is both simpler and always consistent with the rules.
  useEffect(() => {
    loadSession(selected)
    const timer = setInterval(() => loadSession(selected), 3000)
    return () => clearInterval(timer)
  }, [selected, loadSession])

  const { rows, durationMs, layerCounts, turnCount } = useMemo(
    () => buildFlowRows(session, anomalies),
    [session, anomalies],
  )

  const visibleRows = useMemo(
    () => (layerFilter ? rows.filter(row => row.layer === layerFilter) : rows),
    [rows, layerFilter],
  )

  const rowByIndex = useMemo(() => {
    const map = new Map()
    for (const row of rows) map.set(row.index, row)
    return map
  }, [rows])

  // Turn ids are opaque, so a boundary is labelled by its number in the
  // conversation and by what the user asked, which is what a reader recognises.
  const turnTitles = useMemo(() => {
    const titles = new Map()
    let number = 0
    for (const row of rows) {
      if (titles.has(row.turnId)) continue
      number += 1
      const said = rows.find(item => item.turnId === row.turnId && item.type === 'user.said')
      titles.set(row.turnId, {
        number,
        text: said?.detail?.text || said?.summary || '',
      })
    }
    return titles
  }, [rows])

  return (
    <div className="flow-analysis">
      <header className="flow-analysis-header">
        <h1>消息流分析</h1>
        <p>
          一次会话在各层之间传了什么，用于分析与定位。开启方式：
          <code>QWEN_AUDIO_AGENT_FLOW_TRACE=on</code>
        </p>
      </header>

      {error ? <p className="flow-error">{error}</p> : null}

      <section className="flow-list">
        <h2>会话</h2>
        {sessions.length === 0 ? <p className="flow-empty">还没有记录到交互。</p> : null}
        <ul>
          {sessions.map(item => (
            <li key={item.sessionId}>
              <button
                type="button"
                className={item.sessionId === selected ? 'flow-pick flow-pick-on' : 'flow-pick'}
                onClick={() => {
                  setSelected(item.sessionId)
                  setOpenRow(null)
                  setLayerFilter('')
                }}
              >
                <span className="flow-pick-request">{item.sessionId}</span>
                <span className="flow-pick-meta">
                  {item.turnCount} 轮 · {item.eventCount} 个事件
                </span>
                {item.lastRequest ? (
                  <span className="flow-pick-said">最近：{item.lastRequest}</span>
                ) : null}
                {item.failed ? (
                  <span className="flow-pick-bad">有失败</span>
                ) : null}
                {item.anomalyCount > 0 ? (
                  <span className="flow-pick-bad">{item.anomalyCount} 处可疑</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected && anomalies.length > 0 ? (
        <section className="flow-anomalies">
          <h2>可疑之处</h2>
          <ul>
            {anomalies.map((anomaly, position) => (
              <li key={`${anomaly.rule}-${position}`} className={`flow-anomaly-${anomaly.severity}`}>
                <button
                  type="button"
                  className="flow-anomaly-jump"
                  onClick={() => setOpenRow(rowByIndex.get(anomaly.eventIndexes[0]) || null)}
                >
                  {anomaly.summary}
                </button>
                <p>{anomaly.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className={openRow ? 'flow-split flow-split-open' : 'flow-split'}>
      {selected && rows.length > 0 ? (
        <section className="flow-steps">
          <h2>
            经过
            <span className="flow-steps-span">
              {turnCount} 轮 · {rows.length} 步 · 共 {formatOffset(durationMs)}
            </span>
          </h2>

          <div className="flow-filters">
            <button
              type="button"
              className={layerFilter ? 'flow-filter' : 'flow-filter flow-filter-on'}
              onClick={() => setLayerFilter('')}
            >
              全部
            </button>
            {FLOW_LAYERS.filter(layer => layerCounts[layer.id]).map(layer => (
              <button
                type="button"
                key={layer.id}
                title={layer.hint}
                className={layerFilter === layer.id ? 'flow-filter flow-filter-on' : 'flow-filter'}
                onClick={() => setLayerFilter(layer.id)}
              >
                {layer.label} {layerCounts[layer.id]}
              </button>
            ))}
          </div>

          <ol className="flow-rows">
            {visibleRows.map((row, position) => {
              const title = turnTitles.get(row.turnId)
              const showTurn = position === 0 || row.turnChanged
              return (
                <li key={row.index}>
                  {showTurn && title ? (
                    <div className="flow-turn">
                      第 {title.number} 轮
                      {title.text ? <span>{title.text}</span> : null}
                    </div>
                  ) : null}
                  {row.gapMs ? (
                    <div className="flow-gap">等待 {formatOffset(row.gapMs)}</div>
                  ) : null}
                  <button
                    type="button"
                    className={rowClass(row, openRow?.index === row.index)}
                    onClick={() => setOpenRow(row)}
                  >
                    <span className="flow-row-time">+{formatOffset(row.offsetMs)}</span>
                    <span className="flow-row-layer">{row.layerLabel}</span>
                    <span className="flow-row-label">
                      {row.label}
                      {row.repeated > 1 ? <em> ×{row.repeated}</em> : null}
                    </span>
                    <span className="flow-row-summary">{row.summary}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}

      {openRow ? (
        <section className="flow-detail">
          <h2>
            {openRow.label}
            <code>{openRow.type}</code>
          </h2>
          <p>
            +{formatOffset(openRow.offsetMs)} · {openRow.layerLabel}
            {turnTitles.get(openRow.turnId) ? ` · 第 ${turnTitles.get(openRow.turnId).number} 轮` : ''}
            {openRow.taskId ? ` · 任务 ${openRow.taskId}` : ''}
          </p>
          {/* Short fields as a table, long ones as their own block. A prompt or
              an answer inside a JSON dump is technically complete and
              practically unreadable. */}
          {detailFields(openRow.detail).short.length > 0 ? (
            <dl className="flow-fields">
              {detailFields(openRow.detail).short.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {detailFields(openRow.detail).long.map(([key, value]) => (
            <details
              className="flow-text"
              key={key}
              /* The raw prompt is mostly the same instructions every turn, so
                 it starts closed; what differs was pulled out into the table
                 above. Anything else long is worth showing straight away. */
              open={!COLLAPSED_FIELDS.has(key)}
            >
              <summary>
                {key}
                <em>{value.length} 字</em>
              </summary>
              <pre>{value}</pre>
            </details>
          ))}
          {detailFields(openRow.detail).short.length === 0
            && detailFields(openRow.detail).long.length === 0
            ? <p className="flow-empty">这个事件没有附带内容。</p>
            : null}
          <button type="button" onClick={() => setOpenRow(null)}>关闭</button>
        </section>
      ) : null}
      </div>
    </div>
  )
}
