export default function CarTopView() {
  return (
    <svg className="car-top" viewBox="0 0 160 240" aria-label="车模顶视图">
      <defs>
        <linearGradient id="topBody" x1="0" x2="1">
          <stop offset="0" stopColor="#e8eff1" />
          <stop offset=".52" stopColor="#ffffff" />
          <stop offset="1" stopColor="#bdc8cf" />
        </linearGradient>
        <linearGradient id="topGlass" x1="0" x2="1">
          <stop offset="0" stopColor="#1f323d" />
          <stop offset="1" stopColor="#7a8d95" />
        </linearGradient>
      </defs>
      <ellipse cx="80" cy="212" rx="44" ry="14" fill="rgba(40,64,76,.18)" />
      <rect x="39" y="38" width="82" height="168" rx="32" fill="url(#topBody)" stroke="#6d7980" strokeWidth="3" />
      <rect x="52" y="59" width="56" height="44" rx="13" fill="url(#topGlass)" />
      <rect x="52" y="132" width="56" height="44" rx="13" fill="url(#topGlass)" opacity=".86" />
      <path d="M42 115h76" stroke="#c3ccd1" strokeWidth="4" />
      <rect x="28" y="70" width="16" height="48" rx="7" fill="#1d252b" />
      <rect x="116" y="70" width="16" height="48" rx="7" fill="#1d252b" />
      <rect x="28" y="142" width="16" height="48" rx="7" fill="#1d252b" />
      <rect x="116" y="142" width="16" height="48" rx="7" fill="#1d252b" />
      <path d="M59 41h42" stroke="#2f3c43" strokeWidth="4" strokeLinecap="round" />
      <path d="M55 202h50" stroke="#2f3c43" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}
