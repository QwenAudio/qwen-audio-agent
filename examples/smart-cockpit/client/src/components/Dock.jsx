import qqMusicIcon from '../assets/qq_music.png'
import flashBuyIcon from '../assets/taobao_flashbuy.png'
import { PLAYLIST } from './MusicPanel'

export default function Dock({ screen, onNavigateHome, onOpenSettings, onToggleChat, carState, musicState, onTogglePlay, onOpenMusic, onOpenFlashBuy }) {
  const currentTrack = PLAYLIST[musicState?.currentIndex || 0] || PLAYLIST[0]
  return (
    <footer className="dock" aria-label="底部车机控制栏">
      <div className="dock-side">
        <button className="dock-btn" aria-label="车辆" onClick={onNavigateHome}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17h16v3h-2a2 2 0 0 1-4 0h-4a2 2 0 0 1-4 0H4v-3Zm2-6 2-5h8l2 5 2 2v2H4v-2l2-2Zm2.4-3-1.2 3h9.6l-1.2-3H8.4Z" fill="currentColor" /></svg>
        </button>
        <span className="temp">{(carState?.acTemp ?? 25).toFixed(1)}°</span>
        <button className="dock-btn settings" aria-label="设置" onClick={onOpenSettings}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.6A7 7 0 0 0 7 6.6l-2.4-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 3l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a7 7 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" fill="currentColor" /></svg>
        </button>
        <button className={`dock-btn nav ${screen === 'main' ? 'is-active' : ''}`} aria-label="导航" onClick={onNavigateHome}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 21l8-4 8 4-8-19Z" fill="currentColor" /></svg>
        </button>
      </div>
      <div className={`music-capsule ${screen === 'music' ? 'is-active' : ''}`} onClick={onOpenMusic} role="button" tabIndex={0}>
        <button className="capsule-play" aria-label={musicState?.playing ? '暂停' : '播放'} onClick={e => { e.stopPropagation(); onTogglePlay?.() }}>
          {musicState?.playing ? (
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6V4Zm8 0h4v16h-4V4Z" fill="currentColor" /></svg>
          ) : (
            <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z" fill="currentColor" /></svg>
          )}
        </button>
        <span className="capsule-title">{currentTrack.title}-{currentTrack.artist}</span>
        <img className="capsule-icon" src={qqMusicIcon} alt="QQ音乐" />
      </div>
      <div className="dock-side">
        <button className={`dock-btn flashbuy ${screen === 'flashbuy' ? 'is-active' : ''}`} aria-label="淘宝闪购" onClick={onOpenFlashBuy}>
          <img className="flashbuy-dock-icon" src={flashBuyIcon} alt="" aria-hidden="true" />
        </button>
        <button className="dock-btn chat" aria-label="AI对话" onClick={onToggleChat}>
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3l3 4 3-4h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm-8 11H7v-2h5v2Zm5-4H7V7h10v2Z" fill="currentColor" /></svg>
        </button>
        <span className="temp">{(carState?.acTemp ?? 25).toFixed(1)}°</span>
        <button className="dock-btn" aria-label="音量">
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4Zm12.5 2a4.4 4.4 0 0 0-2-3.7v7.4a4.4 4.4 0 0 0 2-3.7ZM18 6.4l1.4-1.4A10 10 0 0 1 19.4 19L18 17.6a8 8 0 0 0 0-11.2Z" fill="currentColor" /></svg>
        </button>
      </div>
    </footer>
  )
}
