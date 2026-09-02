import { useState, useRef, useEffect, useCallback } from 'react'

function formatArgs(args) {
  if (!args || Object.keys(args).length === 0) return ''
  return Object.entries(args).map(([k, v]) => `${k}=${v}`).join(', ')
}

const TOOL_TAGS = {
  vehicle_location_query: { label: '位置查询', cls: 'tag-car' },
  vehicle_state_query: { label: '车况查询', cls: 'tag-car' },
  vehicle_window_control: { label: '车窗控制', cls: 'tag-car' },
  vehicle_sunroof_control: { label: '天窗控制', cls: 'tag-car' },
  vehicle_headlights_control: { label: '大灯控制', cls: 'tag-car' },
  vehicle_climate_control: { label: '空调控制', cls: 'tag-car' },
  navigation_start: { label: '开始导航', cls: 'tag-nav' },
  navigation_route_query: { label: '路线查询', cls: 'tag-nav' },
  navigation_stop: { label: '停止导航', cls: 'tag-nav' },
  navigation_add_waypoint: { label: '增加途经点', cls: 'tag-nav' },
  navigation_remove_waypoint: { label: '删除途经点', cls: 'tag-nav' },
  navigation_change_destination: { label: '变更目的地', cls: 'tag-nav' },
  navigation_set_route_strategy: { label: '路线偏好', cls: 'tag-nav' },
  navigation_search_place: { label: '地点搜索', cls: 'tag-nav' },
  navigation_to_favorite: { label: '常用地点导航', cls: 'tag-nav' },
  navigation_set_favorite: { label: '设置常用地点', cls: 'tag-nav' },
  navigation_set_voice: { label: '导航播报', cls: 'tag-nav' },
  navigation_set_view: { label: '导航视图', cls: 'tag-nav' },
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

export default function ChatPanel({
  onClose,
  onClear,
  messages,
  onMessagesChange,
  onSendMessage,
  voiceActive = false,
}) {
  const [input, setInput] = useState('')
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
  }, [messages])

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

  const sendMessage = () => {
    const text = input.trim()
    if (!text) return

    const userMsg = { id: crypto.randomUUID(), role: 'user', content: text }
    const accepted = onSendMessage?.(text) === true
    onMessagesChange([
      ...messages,
      userMsg,
      ...(accepted ? [] : [{
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '对话中控尚未连接，请稍后再试。',
      }]),
    ])
    setInput('')
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
        <span className="chat-title">Qwen Audio Agent Smart Cockpit · 调试</span>
        <div className="chat-header-actions">
          <button
            className="chat-clear"
            onClick={onClear}
            onMouseDown={event => event.stopPropagation()}
            aria-label="清空"
            title="清空"
          >
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
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
      </div>
      {voiceActive ? (
        <div className="chat-input-area chat-input-voice-hint">
          <span>语音模式中，请通过麦克风交互</span>
        </div>
      ) : (
        <div className="chat-input-area">
          <div className="chat-input-row">
            <input
              className="chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入消息..."
            />
            <button className="chat-send" onClick={sendMessage} disabled={!input.trim()}>
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
