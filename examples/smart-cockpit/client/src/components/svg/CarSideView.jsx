export default function CarSideView() {
  return (
    <svg className="car-large" viewBox="0 0 520 300" aria-label="车模显示区域">
      <defs>
        <linearGradient id="bodyPaint" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#f6f9fa" />
          <stop offset=".52" stopColor="#cfd8dc" />
          <stop offset="1" stopColor="#f9fbfc" />
        </linearGradient>
        <linearGradient id="glassPaint" x1="0" x2="1">
          <stop offset="0" stopColor="#314653" />
          <stop offset="1" stopColor="#9eb1ba" />
        </linearGradient>
      </defs>
      <ellipse cx="256" cy="249" rx="176" ry="22" fill="rgba(32,70,88,.18)" />
      <path d="M92 191h-22c-12 0-22-10-22-22v-28c0-14 9-26 22-31l35-14 37-49c9-12 23-19 38-19h132c18 0 34 9 44 24l35 53 45 15c17 6 29 22 29 40v20c0 8-7 15-15 15h-24" fill="url(#bodyPaint)" stroke="#65747b" strokeWidth="4" strokeLinejoin="round" />
      <path d="M149 91h83V47h-47c-10 0-19 5-25 13l-31 39h20v-8Zm103-44v44h103l-27-39a28 28 0 0 0-23-5h-53Z" fill="url(#glassPaint)" opacity=".92" />
      <path d="M72 134h55l22-43h219l28 43h59" fill="none" stroke="#87949a" strokeWidth="4" strokeLinecap="round" />
      <path d="M142 154h252" stroke="#ffffff" strokeWidth="5" opacity=".74" />
      <circle cx="148" cy="194" r="40" fill="#20282d" />
      <circle cx="148" cy="194" r="22" fill="#697980" />
      <circle cx="148" cy="194" r="9" fill="#d8e0e4" />
      <circle cx="395" cy="194" r="40" fill="#20282d" />
      <circle cx="395" cy="194" r="22" fill="#697980" />
      <circle cx="395" cy="194" r="9" fill="#d8e0e4" />
      <path d="M60 160h42" stroke="#26333a" strokeWidth="8" strokeLinecap="round" />
      <path d="M430 145h34" stroke="#f5f0dc" strokeWidth="8" strokeLinecap="round" />
      <path d="M191 38h60M335 56l36 36" stroke="#fff" strokeWidth="6" strokeLinecap="round" opacity=".7" />
    </svg>
  )
}
