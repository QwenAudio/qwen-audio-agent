import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { configureGatewayTransport } from '../../web/src/gateway-transport.js'
import '../../web/src/styles.css'
import './mobile.css'
import { pairMobileGateway } from './mobile-profile.js'
import {
  loadMobileGatewayProfile,
  mobileDeviceId,
  mobileLaunchUrl,
  mobilePairingRequest,
  onMobileUrlOpen,
  removeMobileGatewayProfile,
  saveMobileGatewayProfile,
  scanGatewayInvitation,
} from './native-runtime.js'

function MobileApp() {
  const [profile, setProfile] = useState(null)
  const [WebApp, setWebApp] = useState(null)
  const [invitation, setInvitation] = useState('')
  const [status, setStatus] = useState('正在读取连接配置…')
  const [busy, setBusy] = useState(false)
  const pairing = useRef(false)

  const activateProfile = useCallback(async next => {
    configureGatewayTransport({
      gatewayUrl: next.gatewayUrl,
      accessToken: next.accessToken,
      clientType: 'mobile',
      clientLabel: next.label || '移动端',
    })
    const module = await import('../../web/src/App.jsx')
    setProfile(next)
    setWebApp(() => module.default)
    setStatus('')
  }, [])

  const pair = useCallback(async value => {
    if (!String(value || '').trim() || pairing.current) return
    pairing.current = true
    setBusy(true)
    setStatus('正在安全配对…')
    try {
      const next = await pairMobileGateway(String(value).trim(), {
        request: mobilePairingRequest,
        deviceId: await mobileDeviceId(),
        label: 'Qwen Audio Agent Mobile',
      })
      await saveMobileGatewayProfile(next)
      await activateProfile(next)
    } catch (error) {
      setStatus(error.message || '无法连接 Gateway')
    } finally {
      pairing.current = false
      setBusy(false)
    }
  }, [activateProfile])

  useEffect(() => {
    let active = true
    loadMobileGatewayProfile()
      .then(next => {
        if (!active) return
        if (next) return activateProfile(next)
        return mobileLaunchUrl().then(url => {
          if (url) return pair(url)
          setStatus('请扫描电脑端显示的 Gateway 配对码')
        })
      })
      .catch(error => active && setStatus(error.message || '无法读取连接配置'))
    const removeListener = onMobileUrlOpen(url => void pair(url))
    return () => {
      active = false
      removeListener()
    }
  }, [activateProfile, pair])

  const scan = async () => {
    setBusy(true)
    try {
      const value = await scanGatewayInvitation()
      if (value) await pair(value)
    } catch (error) {
      setStatus(error.message || '没有读到配对码')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (!confirm('断开这台 Gateway？之后需要重新扫码配对。')) return
    await removeMobileGatewayProfile()
    configureGatewayTransport()
    setProfile(null)
    setWebApp(null)
    setStatus('已断开，请重新扫码配对')
  }

  if (profile && WebApp) return <div className="mobile-runtime">
    <button className="mobile-disconnect" type="button" onClick={disconnect}>
      断开
    </button>
    <WebApp />
  </div>

  return <main className="mobile-onboarding">
    <div className="mobile-mark">Q</div>
    <h1>连接你的 Agent</h1>
    <p>Gateway 和后台 Agent 继续运行在你的电脑上，手机通过安全连接与它对话。</p>
    <button className="mobile-primary" type="button" disabled={busy} onClick={scan}>
      {busy ? '正在连接…' : '扫描配对码'}
    </button>
    <div className="mobile-divider"><span>或</span></div>
    <label>
      配对链接
      <textarea
        value={invitation}
        onChange={event => setInvitation(event.target.value)}
        placeholder="粘贴 qwaudio://connect…"
        spellCheck={false}
      />
    </label>
    <button type="button" disabled={busy || !invitation.trim()} onClick={() => pair(invitation)}>
      使用链接连接
    </button>
    <small role="status">{status}</small>
  </main>
}

createRoot(document.getElementById('root')).render(
  <StrictMode><MobileApp /></StrictMode>,
)
