export function desktopOrbClassName({
  state,
  enabled,
  error = false,
  dragging = false,
  lifecycle = 'active',
}) {
  return [
    'desktop-orb-stage',
    state,
    enabled ? 'enabled' : 'input-muted',
    error ? 'error' : '',
    dragging ? 'dragging' : '',
    lifecycle !== 'active' ? lifecycle : '',
  ].filter(Boolean).join(' ')
}
