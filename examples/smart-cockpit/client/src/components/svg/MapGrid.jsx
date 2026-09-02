export default function MapGrid() {
  return (
    <svg className="map-grid" viewBox="0 0 760 560" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id="smallGrid" width="78" height="78" patternUnits="userSpaceOnUse">
          <path d="M 78 0 L 0 0 0 78" fill="none" stroke="#d9e2e6" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="760" height="560" fill="#eef4f5" />
      <rect x="0" y="0" width="760" height="560" fill="url(#smallGrid)" opacity=".62" />
      <path d="M-20 436 H800" stroke="#d9c4cd" strokeWidth="16" opacity=".6" />
      <path d="M490 -30 V620" stroke="#d8c2cb" strokeWidth="16" opacity=".52" />
      <path d="M620 -20 V610" stroke="#d8c2cb" strokeWidth="11" opacity=".52" />
      <path d="M-30 110 H800" stroke="#d7c5cd" strokeWidth="10" opacity=".52" />
      <path d="M230 -20 C260 120 254 260 230 380 S220 540 265 600" fill="none" stroke="#d8c2cb" strokeWidth="9" opacity=".48" />
      <rect x="70" y="42" width="116" height="102" fill="#bee0de" opacity=".38" />
      <rect x="262" y="172" width="116" height="180" fill="#b8d9d6" opacity=".36" />
      <rect x="412" y="50" width="112" height="70" fill="#badad9" opacity=".52" />
      <rect x="118" y="472" width="190" height="72" fill="#bddcd9" opacity=".3" />
      <rect x="560" y="210" width="110" height="126" fill="#bfd9d8" opacity=".34" />
      <path d="M424 380 L424 280 L514 280 L514 212 L602 212 L602 318 L662 318 L662 458" fill="none" stroke="#d74467" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M424 380 L424 280 L514 280 L514 212" fill="none" stroke="#2b74cc" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M660 458 C680 484 694 512 698 552" fill="none" stroke="#24a785" strokeWidth="18" strokeLinecap="round" />
      <path d="M424 380 L424 280 L514 280 L514 212 L602 212 L602 318 L662 318 L662 458" fill="none" stroke="rgba(255,255,255,.72)" strokeWidth="3" strokeDasharray="7 13" />
      <polygon points="405,389 426,349 447,389 426,380" fill="#23b884" stroke="#fff" strokeWidth="5" />
    </svg>
  )
}
