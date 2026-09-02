// Main-process half of the orb shell contract.
//
// bindOrbShell answers the IPC channels the orb page's preload sends, so an
// embedding host only has to supply its BrowserWindow, a DesktopPresence
// instance, and a few callbacks. The desktop shell uses this same binding,
// which is what keeps the two surfaces from drifting apart.
//
// This module intentionally does not import 'electron' itself: the host
// passes its ipcMain in, so the contract stays testable without Electron and
// usable from both CommonJS and ESM Electron mains.
export const ORB_CHANNELS = Object.freeze({
  dragStart: 'qwen-audio-agent:drag-start',
  dragMove: 'qwen-audio-agent:drag-move',
  dragEnd: 'qwen-audio-agent:drag-end',
  openSettings: 'qwen-audio-agent:open-settings',
  enterHide: 'qwen-audio-agent:enter-hide',
  wake: 'qwen-audio-agent:wake',
  lifecycleReady: 'qwen-audio-agent:lifecycle-ready',
  lifecycleLoad: 'qwen-audio-agent:lifecycle-load',
  lifecycle: 'qwen-audio-agent:lifecycle',
  taskCardPlacement: 'qwen-audio-agent:task-card-placement',
  surfaceLoad: 'qwen-audio-agent:surface-load',
  surfaceSet: 'qwen-audio-agent:surface-set',
  conversationSessionSet: 'qwen-audio-agent:conversation-session-set',
  quit: 'qwen-audio-agent:quit',
})

function validPoint(point) {
  return (
    Number.isFinite(point?.x)
    && Number.isFinite(point?.y)
  )
}

// Electron rejects positions outside the signed 32-bit range; a renderer must
// not be able to throw in the main process by reporting a wild pointer.
function validWindowPosition(x, y) {
  return (
    Number.isSafeInteger(x)
    && Number.isSafeInteger(y)
    && x >= -2_147_483_648
    && x <= 2_147_483_647
    && y >= -2_147_483_648
    && y <= 2_147_483_647
  )
}

// Window flags that belong to the orb form itself, not to any host: the orb
// floats above normal windows and stays visible in every workspace, including
// another app's fullscreen space. Hosts call this once after creating the
// window; the desktop shell applies the same flags.
export function configureOrbWindow(window) {
  window.setAlwaysOnTop?.(true, 'floating')
  window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
}

export function bindOrbShell({
  ipc,
  getWindow,
  presence,
  logger = null,
  onOpenSettings = null,
  onLoadSurface = null,
  onSetSurface = null,
  onSetConversationSession = null,
  onQuit = null,
  onDragEnd = null,
} = {}) {
  if (!ipc) throw new Error('bindOrbShell: ipc (electron ipcMain) is required')
  if (typeof getWindow !== 'function') {
    throw new Error('bindOrbShell: getWindow is required')
  }
  if (!presence) throw new Error('bindOrbShell: presence is required')

  let dragState = null
  const registrations = []
  const on = (channel, listener) => {
    ipc.on(channel, listener)
    registrations.push(() => ipc.removeListener(channel, listener))
  }
  const handle = (channel, listener) => {
    ipc.handle(channel, listener)
    registrations.push(() => ipc.removeHandler(channel))
  }
  const fromOrbWindow = event => {
    const window = getWindow()
    return Boolean(window && event.sender === window.webContents)
  }

  on(ORB_CHANNELS.dragStart, (event, point) => {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || !validPoint(point)) return
    const [windowX, windowY] = window.getPosition()
    dragState = {
      pointerX: point.x,
      pointerY: point.y,
      windowX,
      windowY,
    }
  })

  on(ORB_CHANNELS.dragMove, (event, point) => {
    const window = getWindow()
    if (
      !window
      || event.sender !== window.webContents
      || !dragState
      || !validPoint(point)
    ) return
    const x = Math.round(dragState.windowX + point.x - dragState.pointerX)
    const y = Math.round(dragState.windowY + point.y - dragState.pointerY)
    if (!validWindowPosition(x, y)) {
      logger?.warn('desktop.drag_position_invalid', { x, y })
      dragState = null
      return
    }
    try {
      window.setPosition(x, y)
    } catch (error) {
      logger?.warn('desktop.drag_position_failed', { x, y, error })
      dragState = null
    }
  })

  on(ORB_CHANNELS.dragEnd, event => {
    if (fromOrbWindow(event)) {
      dragState = null
      // Hosts persist the new position here; see createOrbPlacement.
      onDragEnd?.()
    }
  })

  handle(ORB_CHANNELS.lifecycleLoad, event => {
    if (!fromOrbWindow(event)) {
      throw new Error('无权读取桌面状态')
    }
    return { state: presence.state }
  })

  handle(ORB_CHANNELS.enterHide, (event, options = {}) => {
    if (!fromOrbWindow(event)) {
      throw new Error('无权修改桌面状态')
    }
    // The conversation panel is an active application surface. A stale
    // inactivity timer from the compact orb must never disconnect its
    // realtime session while the panel remains visible and interactive.
    const explicit = options?.explicit === true
    if (!explicit && onLoadSurface?.() === 'panel') {
      return { state: presence.state }
    }
    if (explicit && onLoadSurface?.() === 'panel') onSetSurface?.('orb')
    return { state: presence.hide(explicit ? 'requested' : 'inactivity') }
  })

  handle(ORB_CHANNELS.surfaceLoad, event => {
    if (!fromOrbWindow(event)) {
      throw new Error('无权读取桌面展示形态')
    }
    return { mode: onLoadSurface?.() === 'panel' ? 'panel' : 'orb' }
  })

  handle(ORB_CHANNELS.surfaceSet, (event, requestedMode) => {
    if (!fromOrbWindow(event)) {
      throw new Error('无权修改桌面展示形态')
    }
    const mode = requestedMode === 'panel' ? 'panel' : 'orb'
    return { mode: onSetSurface?.(mode) === 'panel' ? 'panel' : 'orb' }
  })

  handle(ORB_CHANNELS.conversationSessionSet, (event, sessionId) => {
    if (!fromOrbWindow(event)) {
      throw new Error('无权修改桌面对话会话')
    }
    return { sessionId: onSetConversationSession?.(sessionId) || '' }
  })

  on(ORB_CHANNELS.wake, event => {
    if (fromOrbWindow(event)) presence.wake('orb')
  })

  on(ORB_CHANNELS.lifecycleReady, event => {
    if (fromOrbWindow(event) && presence.state === 'waking') {
      presence.ready()
    }
  })

  if (onOpenSettings) {
    on(ORB_CHANNELS.openSettings, event => {
      if (fromOrbWindow(event)) onOpenSettings()
    })
  }

  if (onQuit) {
    on(ORB_CHANNELS.quit, event => {
      // 「关闭」只向宿主请求退出；本模块绝不自行销毁窗口或结束进程。
      if (fromOrbWindow(event)) onQuit()
    })
  }

  return {
    channels: ORB_CHANNELS,
    // Drop an in-flight drag without waiting for drag-end; hosts call this
    // when the orb window loses focus mid-drag so stale offsets cannot apply.
    cancelDrag() {
      dragState = null
    },
    dispose() {
      while (registrations.length) registrations.pop()()
      dragState = null
    },
  }
}
