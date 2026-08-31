// Replaceable cockpit client: conversation crosses GCP, while scenario panels
// observe the cockpit Domain directly. Keep Agent and Realtime provider logic
// out of this component tree.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import TopBar from './components/TopBar'
import Dock from './components/Dock'
import VehiclePanel from './components/VehiclePanel'
import MapPanel from './components/MapPanel'
import SettingsPanel from './components/SettingsPanel'
import ChatPanel from './components/ChatPanel'
import MusicPanel, { PLAYLIST } from './components/MusicPanel'
import FlashBuyPanel from './components/FlashBuyPanel'
import useCockpitState from './hooks/useCockpitState'
import useVoiceSession from './hooks/useVoiceSession'
import { finalUserTranscript } from './voice-transcript'

const INITIAL_CAR_STATE = {
  windowFL: 0,
  windowFR: 0,
  windowRL: 0,
  windowRR: 0,
  sunroof: 0,
  headlights: 0,
  ac: 1,
  acTemp: 25.0,
  acMode: 'cool',
  acFan: 3,
}

const VALID_TABS = ['persona']
const VALID_PERSONAS = ['聊愈师', '行动派', '疯批']
const VALID_VOICES = ['小酒窝', '台御姐', '阳光男', '酷酷男']
const DEFAULT_PERSONA = '聊愈师'
const DEFAULT_VOICE = '小酒窝'
const PERSONA_STORAGE_KEY = 'selectedPersona'
const VOICE_STORAGE_KEY = 'selectedVoice'
const INITIAL_WEATHER_STATE = {
  city: '杭州市',
  dayweather: '多云',
  daytemp: '28',
}
const INITIAL_FLASH_BUY_STATE = {
  status: 'idle',
  message: '',
  category: 'food',
  items: [],
  cartItems: [],
  total: 0,
  preview: null,
  order: null,
}

function getClientId() {
  let id = localStorage.getItem('clientId')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('clientId', id)
  }
  return id
}

function getStoredChoice(key, fallback, validValues) {
  const value = localStorage.getItem(key)
  return validValues.includes(value) ? value : fallback
}

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '')
  if (hash.startsWith('settings')) {
    const tab = hash.split('/')[1] || 'persona'
    return { screen: 'settings', tab: VALID_TABS.includes(tab) ? tab : 'persona' }
  }
  if (hash === 'music') return { screen: 'music', tab: 'persona' }
  if (hash === 'flashbuy') return { screen: 'flashbuy', tab: 'persona' }
  return { screen: 'main', tab: 'persona' }
}

export default function App() {
  const clientId = useMemo(() => getClientId(), [])
  const cockpitId = import.meta.env.VITE_COCKPIT_ID || 'default'
  const {
    state: cockpitState,
    progress: cockpitProgress,
    execute: executeCockpitCommand,
  } = useCockpitState(cockpitId)
  const [screen, setScreen] = useState('main')
  const [settingsTab, setSettingsTab] = useState('persona')
  const [selectedPersona, setSelectedPersona] = useState(() => getStoredChoice(PERSONA_STORAGE_KEY, DEFAULT_PERSONA, VALID_PERSONAS))
  const [selectedVoice, setSelectedVoice] = useState(() => getStoredChoice(VOICE_STORAGE_KEY, DEFAULT_VOICE, VALID_VOICES))
  const [selectedWake, setSelectedWake] = useState('主驾')
  const carState = cockpitState?.vehicle || INITIAL_CAR_STATE
  const [showChat, setShowChat] = useState(false)
  const [chatMessages, setChatMessages] = useState([])
  const navState = cockpitState?.navigation || { status: 'idle' }
  const mapActions = useMemo(() => [], [])
  const [routeStrategy, setRouteStrategy] = useState(0)
  const musicState = cockpitState?.music || { playing: false, currentIndex: 0 }
  const flashBuyState = cockpitState?.flashbuy || INITIAL_FLASH_BUY_STATE
  const weatherState = cockpitState?.weather || INITIAL_WEATHER_STATE
  const [voiceMuted, setVoiceMuted] = useState(true)
  const voiceAssistantMessageIdRef = useRef(null)

  const runCockpitCommand = useCallback((name, args = {}) => {
    executeCockpitCommand(name, args).catch(error => {
      console.warn(`Cockpit command ${name} failed`, error)
    })
  }, [executeCockpitCommand])

  const musicPlay = useCallback(() => runCockpitCommand('music_play'), [runCockpitCommand])
  const musicPause = useCallback(() => runCockpitCommand('music_pause'), [runCockpitCommand])
  const musicNext = useCallback(() => runCockpitCommand('music_next'), [runCockpitCommand])
  const musicPrev = useCallback(() => runCockpitCommand('music_previous'), [runCockpitCommand])
  const musicSelectTrack = useCallback((index) => {
    runCockpitCommand('music_play', { query: PLAYLIST[index]?.title })
  }, [runCockpitCommand])

  useEffect(() => {
    localStorage.setItem(PERSONA_STORAGE_KEY, selectedPersona)
  }, [selectedPersona])

  useEffect(() => {
    localStorage.setItem(VOICE_STORAGE_KEY, selectedVoice)
  }, [selectedVoice])

  const openMusic = useCallback(() => {
    setScreen('music')
    window.location.hash = '#music'
  }, [])

  const openFlashBuy = useCallback(() => {
    setScreen('flashbuy')
    window.location.hash = '#flashbuy'
  }, [])

  const handleFlashBuyAction = useCallback((event) => {
    if (event.type === 'set_category') {
      runCockpitCommand('flashbuy', { action: 'search', category: event.category })
    } else if (event.type === 'toggle_item') {
      const exists = flashBuyState.cartItems.some(row => row.id === event.itemId)
      runCockpitCommand('flashbuy', exists
        ? { action: 'update_cart', itemId: event.itemId, quantity: 0 }
        : { action: 'add_to_cart', itemId: event.itemId })
    } else if (event.type === 'confirm_order') {
      runCockpitCommand('flashbuy', { action: 'confirm_order', confirmed: true })
    }
  }, [flashBuyState.cartItems, runCockpitCommand])

  const toggleCarPart = useCallback((part) => {
    const action = carState[part] === 0 ? 'open' : 'close'
    if (part.startsWith('window')) {
      runCockpitCommand('vehicle_window_control', { action, window: part })
    } else if (part === 'sunroof') {
      runCockpitCommand('vehicle_sunroof_control', { action })
    } else if (part === 'headlights') {
      runCockpitCommand('vehicle_headlights_control', { action })
    }
  }, [carState, runCockpitCommand])

  const navigateHome = useCallback(() => {
    setScreen('main')
    window.location.hash = '#main'
  }, [])

  const openSettings = useCallback((tab = 'persona') => {
    setScreen('settings')
    setSettingsTab(tab)
    window.location.hash = `#settings/${tab}`
  }, [])

  const changeTab = useCallback((tab) => {
    setSettingsTab(tab)
    window.location.hash = `#settings/${tab}`
  }, [])

  const toggleChat = useCallback(() => {
    setShowChat(prev => !prev)
  }, [])

  const toggleVoiceMute = useCallback(() => {
    setVoiceMuted(prev => !prev)
  }, [])

  const handleVoiceMessage = useCallback((event) => {
    if (!event) return

    const updateAssistantMessage = (updater) => {
      const id = voiceAssistantMessageIdRef.current || crypto.randomUUID()
      voiceAssistantMessageIdRef.current = id
      setChatMessages(prev => {
        const next = [...prev]
        let index = next.findIndex(msg => msg.id === id)
        if (index < 0) {
          next.push({ id, role: 'assistant', content: '' })
          index = next.length - 1
        }
        next[index] = updater(next[index])
        return next.slice(-80)
      })
    }

    if (event.thinkingDelta) {
      updateAssistantMessage(msg => ({
        ...msg,
        thinking: `${msg.thinking || ''}${event.thinkingDelta}`,
      }))
      return
    }

    if (event.toolCall) {
      updateAssistantMessage(msg => ({
        ...msg,
        thinkingMs: msg.thinkingMs || 1,
        debug: {
          ...(msg.debug || {}),
          tool_calls: [...(msg.debug?.tool_calls || []), event.toolCall],
        },
      }))
      return
    }

    if (event.progress) {
      updateAssistantMessage(msg => ({
        ...msg,
        debug: {
          ...(msg.debug || {}),
          progress: [...(msg.debug?.progress || []), event.progress],
          tool_calls: msg.debug?.tool_calls || [],
        },
      }))
      return
    }

    if (event.debug) {
      updateAssistantMessage(msg => {
        const thinking = msg.thinking || event.debug.thinking || ''
        return {
          ...msg,
          ...(thinking ? { thinking, thinkingMs: event.debug.duration_ms || msg.thinkingMs || 1 } : {}),
          debug: {
            ...(msg.debug || {}),
            ...event.debug,
            progress: msg.debug?.progress || [],
            tool_calls: msg.debug?.tool_calls || [],
          },
        }
      })
      return
    }

    if (event.role === 'user') {
      voiceAssistantMessageIdRef.current = null
      const content = finalUserTranscript(event)
      if (!content) return
      setChatMessages(prev => {
        const last = prev.at(-1)
        if (last?.role === 'user' && last.content === content) return prev
        return [
          ...prev,
          { id: crypto.randomUUID(), role: 'user', content },
        ].slice(-80)
      })
      return
    }

    if (event.role !== 'assistant') return
    if (!event.content) return

    if (event.delta) {
      updateAssistantMessage(msg => ({ ...msg, content: `${msg.content || ''}${event.content}` }))
      return
    }

    if (event.final) {
      updateAssistantMessage(msg => ({ ...msg, content: event.content || msg.content }))
      voiceAssistantMessageIdRef.current = null
    }
  }, [])

  const handleConversationRecovery = useCallback((messages) => {
    voiceAssistantMessageIdRef.current = null
    setChatMessages((Array.isArray(messages) ? messages : []).map(message => ({
      ...message,
      id: message.id || crypto.randomUUID(),
    })).slice(-10))
  }, [])

  const {
    voiceState,
    inputLevel,
    outputLevel,
    progress: voiceProgress,
    error: voiceError,
    sendInput,
  } = useVoiceSession({
    muted: voiceMuted,
    clientId,
    onVoiceMessage: handleVoiceMessage,
    onConversationRecovery: handleConversationRecovery,
  })
  const visualProgress = cockpitProgress || voiceProgress

  const handleTextMessage = useCallback((text) => (
    sendInput([{ type: 'text', text }])
  ), [sendInput])

  useEffect(() => {
    if (!['navigation', 'flashbuy'].includes(visualProgress?.domain)) return undefined
    const frame = requestAnimationFrame(() => {
      if (visualProgress.domain === 'navigation') {
        setScreen('main')
        window.location.hash = '#main'
      } else {
        setScreen('flashbuy')
        window.location.hash = '#flashbuy'
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [visualProgress])

  useEffect(() => {
    const onHashChange = () => {
      const { screen: s, tab } = parseHash()
      setScreen(s)
      setSettingsTab(tab)
    }
    window.addEventListener('hashchange', onHashChange)
    onHashChange()
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return (
    <main className="device" aria-label="车机语音交互原型">
      <section className="screen">
        <TopBar weather={weatherState} />

        <div className="screen-view is-active">
          <div className="main-grid">
            <VehiclePanel
              onOpenSettings={() => openSettings('persona')}
              carState={carState}
              onTogglePart={toggleCarPart}
              voiceMuted={voiceMuted}
              voiceState={voiceState}
              voiceProgress={visualProgress}
              voiceError={voiceError}
              inputLevel={inputLevel}
              outputLevel={outputLevel}
              persona={selectedPersona}
              onSelectPersona={setSelectedPersona}
              onToggleVoiceMute={toggleVoiceMute}
            />
            {screen === 'main' && (
              <MapPanel navState={navState} navProgress={visualProgress} mapActions={mapActions} routeStrategy={routeStrategy} onStrategyChange={setRouteStrategy} />
            )}
            {screen === 'music' && (
              <MusicPanel musicState={musicState} onPlay={musicPlay} onPause={musicPause} onNext={musicNext} onPrev={musicPrev} onSelectTrack={musicSelectTrack} />
            )}
            {screen === 'flashbuy' && (
              <FlashBuyPanel flashBuyState={flashBuyState} onFlashBuyAction={handleFlashBuyAction} />
            )}
            {screen === 'settings' && (
              <SettingsPanel
                activeTab={settingsTab} onTabChange={changeTab}
                selectedPersona={selectedPersona} onSelectPersona={setSelectedPersona}
                selectedVoice={selectedVoice} onSelectVoice={setSelectedVoice}
                selectedWake={selectedWake} onSelectWake={setSelectedWake}
              />
            )}
          </div>
          {showChat && <ChatPanel onClose={toggleChat} messages={chatMessages} onMessagesChange={setChatMessages} onSendMessage={handleTextMessage} voiceActive={!voiceMuted} />}
        </div>

        <Dock screen={screen} onNavigateHome={navigateHome} onOpenSettings={() => openSettings('persona')} onToggleChat={toggleChat} carState={carState} musicState={musicState} onTogglePlay={musicState.playing ? musicPause : musicPlay} onOpenMusic={openMusic} onOpenFlashBuy={openFlashBuy} />
      </section>
    </main>
  )
}
