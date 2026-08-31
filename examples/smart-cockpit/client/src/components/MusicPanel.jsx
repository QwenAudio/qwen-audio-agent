import { useState, useEffect, useRef, useCallback } from 'react'
import qqMusicIcon from '../assets/qq_music.png'

const PLAYLIST = [
  { title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, cover: '/covers/yehuimei.jpg' },
  { title: '七里香', artist: '周杰伦', album: '七里香', duration: 299, cover: '/covers/qilixiang.jpg' },
  { title: '稻香', artist: '周杰伦', album: '魔杰座', duration: 223, cover: '/covers/mojiezuo.jpg' },
  { title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', duration: 226, cover: '/covers/xiaobang.jpg' },
  { title: '简单爱', artist: '周杰伦', album: '范特西', duration: 270, cover: '/covers/fantexi.jpg' },
  { title: '青花瓷', artist: '周杰伦', album: '我很忙', duration: 239, cover: '/covers/wohenmang.jpg' },
]

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export { PLAYLIST }

export default function MusicPanel({ musicState, onPlay, onPause, onNext, onPrev, onSelectTrack }) {
  const { playing, currentIndex } = musicState
  const track = PLAYLIST[currentIndex] || PLAYLIST[0]
  const [progress, setProgress] = useState(0)
  const [liked, setLiked] = useState({})
  const [mode, setMode] = useState('order')
  const prevIndexRef = useRef(currentIndex)
  const listRef = useRef(null)

  useEffect(() => {
    if (prevIndexRef.current !== currentIndex) {
      setProgress(0)
      prevIndexRef.current = currentIndex
    }
    if (!playing) return
    const timer = setInterval(() => {
      setProgress(prev => {
        if (prev >= track.duration) {
          onNext()
          return 0
        }
        return prev + 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [playing, currentIndex, track.duration, onNext])

  useEffect(() => {
    const el = listRef.current?.querySelector('.is-active')
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentIndex])

  const handleProgressClick = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    setProgress(Math.floor(ratio * track.duration))
  }, [track.duration])

  const toggleLike = useCallback(() => {
    setLiked(prev => ({ ...prev, [currentIndex]: !prev[currentIndex] }))
  }, [currentIndex])

  const cycleMode = useCallback(() => {
    setMode(prev => prev === 'order' ? 'shuffle' : prev === 'shuffle' ? 'repeat' : 'order')
  }, [])

  const modeIcon = mode === 'repeat'
    ? <path d="M7 7h10v1.8L21 5l-4-3.8V3H6a1 1 0 0 0-1 1v5h2V7Zm10 10H7v-1.8L3 19l4 3.8V21h11a1 1 0 0 0 1-1v-5h-2v3Z" fill="currentColor" />
    : mode === 'shuffle'
      ? <path d="M16 3.4l4 3.6-4 3.6V8h-2.2L9.6 16H5v-2h3.4l4.2-8H16V3.4ZM5 6h4.4l1.1 2H8.6L5 6Zm11 14.6 4-3.6-4-3.6V16h-2.8l-1.1-2h1.9l2 2H16v2.6Z" fill="currentColor" />
      : <path d="M3 12h2v2H3v-2Zm4-6h2v14H7V6Zm4 3h2v8h-2V9Zm4-3h2v14h-2V6Zm4 3h2v8h-2V9Z" fill="currentColor" />

  return (
    <div className="music-panel">
      <div className="music-left">
        <div className="music-source">
          <img src={qqMusicIcon} alt="QQ音乐" className="music-source-icon" />
          <span className="music-source-name">QQ音乐</span>
        </div>
        <div className="music-cover-wrap">
          <img className={`music-cover-img ${playing ? 'is-spinning' : ''}`} src={track.cover} alt={track.album} />
        </div>
        <div className="music-info">
          <div className="music-title">{track.title}</div>
          <div className="music-artist">{track.artist} · {track.album}</div>
        </div>
        <div className="music-progress-bar" onClick={handleProgressClick}>
          <div className="music-progress-fill" style={{ width: `${(progress / track.duration) * 100}%` }} />
          <div className="music-progress-thumb" style={{ left: `${(progress / track.duration) * 100}%` }} />
        </div>
        <div className="music-time">
          <span>{formatTime(progress)}</span>
          <span>{formatTime(track.duration)}</span>
        </div>
        <div className="music-controls">
          <button className="music-ctrl-btn" onClick={cycleMode} aria-label="播放模式" title={mode === 'order' ? '顺序播放' : mode === 'shuffle' ? '随机播放' : '单曲循环'}>
            <svg viewBox="0 0 24 24" width="20" height="20">{modeIcon}</svg>
          </button>
          <button className="music-ctrl-btn" onClick={onPrev} aria-label="上一首">
            <svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6h2v12H6V6Zm3.5 6 8.5 6V6l-8.5 6Z" fill="currentColor" /></svg>
          </button>
          <button className="music-play-btn" onClick={playing ? onPause : onPlay} aria-label={playing ? '暂停' : '播放'}>
            {playing ? (
              <svg viewBox="0 0 24 24" width="32" height="32"><path d="M6 4h4v16H6V4Zm8 0h4v16h-4V4Z" fill="currentColor" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="32" height="32"><path d="M8 5v14l11-7L8 5Z" fill="currentColor" /></svg>
            )}
          </button>
          <button className="music-ctrl-btn" onClick={onNext} aria-label="下一首">
            <svg viewBox="0 0 24 24" width="24" height="24"><path d="M16 6h2v12h-2V6ZM6 6l8.5 6L6 18V6Z" fill="currentColor" /></svg>
          </button>
          <button className={`music-ctrl-btn ${liked[currentIndex] ? 'is-liked' : ''}`} onClick={toggleLike} aria-label="喜欢">
            <svg viewBox="0 0 24 24" width="20" height="20">
              {liked[currentIndex]
                ? <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z" fill="currentColor" />
                : <path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3Zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5 18.5 5 20 6.5 20 8.5c0 2.89-3.14 5.74-7.9 10.05Z" fill="currentColor" />
              }
            </svg>
          </button>
        </div>
      </div>
      <div className="music-right" ref={listRef}>
        <div className="music-list-header">
          <span className="music-list-title">播放队列</span>
          <span className="music-list-count">{PLAYLIST.length} 首</span>
        </div>
        {PLAYLIST.map((t, i) => (
          <button
            key={i}
            className={`music-list-item ${i === currentIndex ? 'is-active' : ''}`}
            onClick={() => onSelectTrack(i)}
          >
            <img className="music-list-cover" src={t.cover} alt={t.album} />
            <div className="music-list-info">
              <span className="music-list-name">{t.title}</span>
              <span className="music-list-meta">{t.artist} · {t.album}</span>
            </div>
            <span className="music-list-dur">{formatTime(t.duration)}</span>
            {i === currentIndex && playing && (
              <span className="music-list-eq">
                <span /><span /><span />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
