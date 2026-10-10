export function overlayWindowBounds(workArea) {
  const width = Math.min(390, workArea.width)
  const height = Math.min(560, workArea.height)
  return { width, height,
    x: workArea.x + Math.max(0, workArea.width - width - 12),
    y: workArea.y + Math.max(0, workArea.height - height - 12) }
}

export function overlayWindowOptions(bounds, preload) {
  return { ...bounds, frame: false, transparent: false, resizable: false,
    maximizable: false, fullscreenable: false, alwaysOnTop: true, hasShadow: true,
    backgroundColor: '#0b1120', title: 'Vidu Avatar', autoHideMenuBar: true,
    skipTaskbar: true, show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false } }
}
