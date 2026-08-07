// 悬浮球皮肤目录：主进程与 web 渲染层共用的单一事实来源。
// 皮肤 = { id, type, displayName }。内置皮肤是 theme 类型（CSS 渲染），
// 导入皮肤是 sprite 类型（Codex pet 包渲染），两者共用同一选择链。

export const BUILTIN_ORB_SKINS = Object.freeze([
  Object.freeze({ id: 'fluid', type: 'theme', displayName: '流光声波球' }),
  Object.freeze({ id: 'goo', type: 'theme', displayName: '液态渐变球' }),
])

export const ORB_SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function isBuiltinOrbSkin(id) {
  return BUILTIN_ORB_SKINS.some(skin => skin.id === String(id || ''))
}

export function normalizeOrbSkinId(value) {
  const id = String(value || '').trim()
  return ORB_SKIN_ID_PATTERN.test(id) ? id : ''
}

// 统一回退链：orbSkin → orbStyle（旧配置只读兼容）→ fluid。
export function resolveOrbSkinId({ orbSkin, orbStyle } = {}) {
  return (
    normalizeOrbSkinId(orbSkin)
    || normalizeOrbSkinId(orbStyle)
    || 'fluid'
  )
}
