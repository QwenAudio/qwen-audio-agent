import { useState, useRef, useEffect, useCallback } from 'react'

function formatArgs(args) {
  if (!args || Object.keys(args).length === 0) return ''
  return Object.entries(args).map(([k, v]) => `${k}=${v}`).join(', ')
}

const TOOL_TAGS = {
  skill_create: { label: '技能创建', cls: 'tag-skill' },
  skill_run: { label: '技能执行', cls: 'tag-skill' },
  memory_write: { label: '记忆写入', cls: 'tag-memory' },
  memory_read: { label: '记忆读取', cls: 'tag-memory' },
  memory_delete: { label: '记忆删除', cls: 'tag-memory' },
  vehicle_state_query: { label: '车况查询', cls: 'tag-car' },
  vehicle_window_control: { label: '车窗控制', cls: 'tag-car' },
  vehicle_sunroof_control: { label: '天窗控制', cls: 'tag-car' },
  vehicle_headlights_control: { label: '大灯控制', cls: 'tag-car' },
  vehicle_climate_control: { label: '空调控制', cls: 'tag-car' },
  notify_user: { label: '通知', cls: 'tag-skill' },
  timer_set: { label: '定时器', cls: 'tag-skill' },
  timer_cancel: { label: '定时器', cls: 'tag-skill' },
  navigation_start: { label: '开始导航', cls: 'tag-nav' },
  navigation_route_query: { label: '路线查询', cls: 'tag-nav' },
  navigation_stop: { label: '停止导航', cls: 'tag-nav' },
  maps_geo: { label: '地理编码', cls: 'tag-nav' },
  maps_text_search: { label: '地点搜索', cls: 'tag-nav' },
  maps_search_detail: { label: '地点详情', cls: 'tag-nav' },
  maps_direction_driving: { label: '驾车路线', cls: 'tag-nav' },
  maps_distance: { label: '距离测量', cls: 'tag-nav' },
  music_play: { label: '音乐播放', cls: 'tag-music' },
  music_pause: { label: '音乐暂停', cls: 'tag-music' },
  music_next: { label: '下一首', cls: 'tag-music' },
  music_previous: { label: '上一首', cls: 'tag-music' },
  music_search: { label: '音乐搜索', cls: 'tag-music' },
  flashbuy: { label: '闪购', cls: 'tag-skill' },
  weather: { label: '天气', cls: 'tag-nav' },
  web_search: { label: '联网查询', cls: 'tag-skill' },
}

const MEMORY_MUTATION_TOOLS = new Set(['memory_write', 'memory_delete'])
const SKILL_MUTATION_TOOLS = new Set(['skill_create', 'skill_delete'])

function progressTag(progress) {
  if (progress.domain === 'flashbuy') return { label: '闪购', cls: 'tag-skill' }
  if (progress.domain === 'weather') return { label: '天气', cls: 'tag-nav' }
  if (progress.domain === 'web_search') return { label: '联网', cls: 'tag-skill' }
  return { label: '导航', cls: 'tag-nav' }
}

function getDefaultPosition(panel) {
  const container = panel?.parentElement
  if (!panel || !container) return { x: 0, y: 0 }

  const panelRect = panel.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  return {
    x: Math.max(0, containerRect.width - panelRect.width),
    y: 0,
  }
}

export default function ChatPanel({ onClose, messages, onMessagesChange, onActions, onClearHistory, onMemoryChange, onSkillChange, onMapAction, onNavigate, routeStrategy, soul, clientId, voiceActive = false, thinking = false, onThinkingChange }) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const panelRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return undefined

    const syncDefaultPosition = () => {
      setPosition(prev => {
        const next = getDefaultPosition(panel)
        if (prev.x === next.x && prev.y === next.y) return prev
        return next
      })
    }

    syncDefaultPosition()
    window.addEventListener('resize', syncDefaultPosition)
    return () => window.removeEventListener('resize', syncDefaultPosition)
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight)
  }, [messages, loading])

  const handleDragStart = useCallback((e) => {
    const panel = panelRef.current
    const container = panel.parentElement
    const panelRect = panel.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const offsetX = e.clientX - panelRect.left
    const offsetY = e.clientY - panelRect.top

    const onMove = (ev) => {
      let x = ev.clientX - containerRect.left - offsetX
      let y = ev.clientY - containerRect.top - offsetY
      x = Math.max(0, Math.min(x, containerRect.width - panelRect.width))
      y = Math.max(0, Math.min(y, containerRect.height - panelRect.height))
      setPosition({ x, y })
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    onMessagesChange(newMessages)
    setInput('')
    setLoading(true)

    const assistantMsg = { role: 'assistant', content: '', thinking: '', thinkingMs: 0, debug: { tool_calls: [] } }
    const streamMessages = [...newMessages, assistantMsg]
    let thinkingStart = null

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, soul, strategy: routeStrategy, thinking, clientId }),
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const event = JSON.parse(line.slice(6))

          if (event.type === 'map_action') {
            if (onMapAction) onMapAction(event)
          } else if (event.type === 'thinking') {
            if (!thinkingStart) thinkingStart = Date.now()
            assistantMsg.thinking += event.content
            onMessagesChange([...streamMessages])
          } else if (event.type === 'progress') {
            assistantMsg.debug.progress = [...(assistantMsg.debug.progress || []), event]
            if (event.domain === 'navigation' && onNavigate) onNavigate()
            if (event.domain === 'flashbuy' && onActions) {
              onActions([
                { type: 'flashbuy', action: 'open' },
                { type: 'flashbuy', action: 'status', status: event.stage, message: event.message },
              ])
            }
            onMessagesChange([...streamMessages])
          } else if (event.type === 'tool_call') {
            if (thinkingStart) {
              assistantMsg.thinkingMs = Date.now() - thinkingStart
              thinkingStart = null
            }
            if (event.name === 'navigation' && onNavigate) onNavigate()
            if (MEMORY_MUTATION_TOOLS.has(event.name) && onMemoryChange) onMemoryChange()
            if (SKILL_MUTATION_TOOLS.has(event.name) && onSkillChange) onSkillChange()
            assistantMsg.debug.tool_calls = [...assistantMsg.debug.tool_calls, event]
            onMessagesChange([...streamMessages])
          } else if (event.type === 'action') {
            if (onActions) onActions([event.action])
          } else if (event.type === 'text') {
            if (thinkingStart) {
              assistantMsg.thinkingMs = Date.now() - thinkingStart
              thinkingStart = null
            }
            assistantMsg.content += event.content
            onMessagesChange([...streamMessages])
          } else if (event.type === 'done') {
            assistantMsg.content = event.content
            assistantMsg.debug.rounds = event.debug?.rounds
            assistantMsg.debug.usage = event.debug?.usage
            assistantMsg.debug.duration_ms = event.debug?.duration_ms
            onMessagesChange([...streamMessages])
            if (onMemoryChange) onMemoryChange()
            if (onSkillChange) onSkillChange()
          } else if (event.type === 'error') {
            assistantMsg.content = event.message || '抱歉，执行失败，请稍后再试。'
            onMessagesChange([...streamMessages])
          }
        }
      }
    } catch {
      assistantMsg.content = '抱歉，连接失败，请稍后再试。'
      onMessagesChange([...streamMessages])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="chat-panel" ref={panelRef} style={{ left: position.x, top: position.y }}>
      <div className="chat-header" onMouseDown={handleDragStart}>
        <span className="chat-title">Qwen Audio Agent Car · 调试</span>
        <div className="chat-header-actions">
          <button className="chat-reset" onClick={onClearHistory} aria-label="清空">
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2M5 6v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
          <button className="chat-close" onClick={onClose} aria-label="关闭">
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">输入消息开始对话</div>
        )}
        {messages.map((msg, i) => (
          <div key={msg.id || i} className="chat-msg-group">
            {msg.thinking && (
              <details className={`thinking-block ${!msg.thinkingMs ? 'is-thinking' : ''}`}>
                <summary className="thinking-summary">
                  {msg.thinkingMs ? `思考 · ${(msg.thinkingMs / 1000).toFixed(1)}s` : '思考中...'}
                </summary>
                <div className="thinking-content">{msg.thinking}</div>
              </details>
            )}
            {(msg.debug?.tool_calls?.length > 0 || msg.debug?.progress?.length > 0) && (
              <div className="chat-debug">
                {msg.debug.progress?.map((progress, j) => (
                  <div key={`progress-${j}`} className="debug-call debug-progress">
                    <span className={`debug-tag ${progressTag(progress).cls}`}>{progressTag(progress).label}</span>
                    <span className="debug-fn">{progress.stage}</span>
                    <span className="debug-result">{progress.message}</span>
                  </div>
                ))}
                {msg.debug.tool_calls.map((tc, j) => {
                  const tag = TOOL_TAGS[tc.name]
                  return (
                    <div key={j} className="debug-call">
                      {tag && <span className={`debug-tag ${tag.cls}`}>{tag.label}</span>}
                      <span className="debug-fn">{tc.name}</span>
                      <span className="debug-args">{formatArgs(tc.arguments)}</span>
                      <span className="debug-result">{tc.result}</span>
                      <span className="debug-time">{tc.duration_ms}ms</span>
                    </div>
                  )
                })}
                <div className="debug-summary">
                  {msg.debug.rounds}轮 · {msg.debug.usage?.total_tokens || 0} tokens · {msg.debug.duration_ms}ms
                </div>
              </div>
            )}
            <div className={`chat-bubble ${msg.role}`}>
              {msg.content}
              {msg.debug && !msg.debug.tool_calls?.length && !msg.debug.progress?.length && (
                <div className="debug-inline">{msg.debug.usage?.total_tokens || 0} tokens · {msg.debug.duration_ms}ms</div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="chat-bubble assistant loading">
            <span className="dot-pulse"></span>
          </div>
        )}
      </div>
      {voiceActive ? (
        <div className="chat-input-area chat-input-voice-hint">
          <div className="chat-input-options">
            <button className={`thinking-chip ${thinking ? 'active' : ''}`} onClick={() => onThinkingChange?.(!thinking)}>
              <svg className="icon-thinking" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 1a5.5 5.5 0 0 0-2 10.63V13a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-1.37A5.5 5.5 0 0 0 8 1ZM6 14.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 0-1h-3a.5.5 0 0 0-.5.5Z" fill="currentColor" />
              </svg>
              深度思考
            </button>
          </div>
          <span>语音模式中，请通过麦克风交互</span>
        </div>
      ) : (
        <div className="chat-input-area">
          <div className="chat-input-options">
            <button className={`thinking-chip ${thinking ? 'active' : ''}`} onClick={() => onThinkingChange?.(!thinking)}>
              <svg className="icon-thinking" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 1a5.5 5.5 0 0 0-2 10.63V13a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-1.37A5.5 5.5 0 0 0 8 1ZM6 14.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 0-1h-3a.5.5 0 0 0-.5.5Z" fill="currentColor" />
              </svg>
              深度思考
            </button>
          </div>
          <div className="chat-input-row">
            <input
              className="chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入消息..."
              disabled={loading}
            />
            <button className="chat-send" onClick={sendMessage} disabled={loading || !input.trim()}>
              <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M2 21 23 12 2 3v7l15 2-15 2v7Z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
