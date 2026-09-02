import { useState, useEffect } from 'react'
import qwenLogo from '../assets/qwen_logo.svg'

function useClock() {
  const [time, setTime] = useState(() => {
    const now = new Date()
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  })

  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date()
      setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return time
}

export default function TopBar({ weather }) {
  const time = useClock()
  const weatherText = weather?.dayweather && weather?.daytemp
    ? `${weather.dayweather} ${weather.daytemp}°`
    : '多云 28°'

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo-mark"><img className="logo-qwen-icon" src={qwenLogo} alt="" aria-hidden="true" />Qwen Audio Agent Smart Cockpit</span>
        <span className="weather">
          <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M18 17H7.5a4.5 4.5 0 0 1-.6-8.96A6.2 6.2 0 0 1 18.5 10 3.5 3.5 0 0 1 18 17Z" opacity=".35" />
            <path fill="currentColor" d="M18.5 10A6.5 6.5 0 0 0 6 8.3 4.7 4.7 0 0 0 7.5 17H18a3.5 3.5 0 0 0 .5-7Z" />
          </svg>
          {weatherText}
        </span>
      </div>
      <div className="status-icons" aria-label="状态栏">
        <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3Zm0 6 5.2 9H6.8L12 9Zm-1 3v3h2v-3h-2Zm0 4v2h2v-2h-2Z" fill="currentColor" /></svg>
        <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2.6 2.6 0 0 0 2.45-1.75h-4.9A2.6 2.6 0 0 0 12 22Zm7-6.1V11a7 7 0 1 0-14 0v4.9L3.6 18v.9h16.8V18L19 15.9ZM7 17v-5.8a5 5 0 0 1 10 0V17H7Z" fill="currentColor" /></svg>
        <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18h2v-6H4v6Zm4 0h2V9H8v9Zm4 0h2V6h-2v12Zm4 0h2V4h-2v14Z" fill="currentColor" /></svg>
        <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m13 12 4-4-6-6h-1v8L6.7 6.7 5.3 8.1 9.2 12l-3.9 3.9 1.4 1.4L10 14v8h1l6-6-4-4Zm-1-6.2 2.2 2.2L12 10.2V5.8Zm0 8 2.2 2.2L12 18.2v-4.4Z" fill="currentColor" /></svg>
        <span>{time}</span>
      </div>
    </header>
  )
}
