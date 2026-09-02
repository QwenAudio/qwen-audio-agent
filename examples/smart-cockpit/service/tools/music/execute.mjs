import { clean, reportActivity, toolResult } from '../shared.mjs'

const VOLUME_MIN = 0
const DEFAULT_VOLUME_MAX = 11
const DEFAULT_VOLUME_STEP = 1
const SOURCE_ALIASES = Object.freeze({
  qq: 'qq_music',
  qqmusic: 'qq_music',
  'qq音乐': 'qq_music',
  radio: 'radio',
  '广播': 'radio',
  fm: 'radio',
  bluetooth: 'bluetooth',
  '蓝牙': 'bluetooth',
  usb: 'usb',
  spotify: 'spotify',
  'apple_music': 'apple_music',
  'apple music': 'apple_music',
  applemusic: 'apple_music',
  '苹果音乐': 'apple_music',
  tunein: 'tunein',
  'youtube_music': 'youtube_music',
  'youtube music': 'youtube_music',
  youtubemusic: 'youtube_music',
  caraoke: 'caraoke',
  '卡拉ok': 'caraoke',
  browser: 'browser',
  '浏览器': 'browser',
})

function matchesQuery(song, query) {
  return !query
    || song.title.toLowerCase().includes(query)
    || song.artist.toLowerCase().includes(query)
    || song.album.toLowerCase().includes(query)
}

function searchSongs(music, query) {
  return (music.playlist || []).filter(song => matchesQuery(song, query))
}

function currentTrack(music) {
  return music.playlist?.[music.currentIndex] || music.playlist?.[0] || null
}

function sourceLabel(music, source = music.source) {
  return music.sources?.find(item => item.id === source)?.label || source || '未知来源'
}

function clampVolume(value, music) {
  const max = Number.isFinite(Number(music.volumeMax))
    ? Number(music.volumeMax)
    : DEFAULT_VOLUME_MAX
  return Math.max(VOLUME_MIN, Math.min(max, Number(value)))
}

function trackText(track) {
  return track ? `${track.title} - ${track.artist}` : '暂无曲目'
}

function musicSummary(music) {
  const status = music.playing ? '播放中' : '已暂停'
  const muted = music.muted ? '，已静音' : ''
  return `${status}${muted}，当前来源${sourceLabel(music)}，音量 ${music.volume}/${music.volumeMax || DEFAULT_VOLUME_MAX}，当前曲目：${trackText(currentTrack(music))}`
}

function favoriteTracks(music) {
  const ids = new Set(music.favoriteIds || [])
  return (music.playlist || []).filter(song => ids.has(song.id))
}

function changed(content, state, extra = {}) {
  return toolResult(content, state, ['music'], { music: state.music, ...extra })
}

function unchanged(content, state, extra = {}) {
  return toolResult(content, state, [], { music: state.music, ...extra })
}

function executeStateQuery(args, state) {
  const part = clean(args.part) || 'all'
  const music = state.music
  if (part === 'volume') {
    return unchanged(
      `当前媒体音量 ${music.volume}/${music.volumeMax || DEFAULT_VOLUME_MAX}${music.muted ? '，已静音' : ''}`,
      state,
    )
  }
  if (part === 'source') return unchanged(`当前媒体来源为${sourceLabel(music)}`, state)
  if (part === 'favorites') {
    const favorites = favoriteTracks(music)
    return unchanged(
      favorites.length
        ? `已收藏 ${favorites.length} 首：${favorites.map(trackText).join('；')}`
        : '当前没有收藏歌曲',
      state,
      { favorites },
    )
  }
  if (part === 'results') {
    return unchanged(
      music.results?.length
        ? `最近搜索结果：${music.results.map(trackText).join('；')}`
        : '当前没有音乐搜索结果',
      state,
      { matches: music.results || [] },
    )
  }
  return unchanged(musicSummary(music), state, { track: currentTrack(music) })
}

function executeSearch(args, context) {
  const { cockpitId, onActivity, snapshot, store } = context
  const currentState = snapshot()
  const query = clean(args.query).toLowerCase()
  const matches = searchSongs(currentState.music, query)
  const state = store.update(cockpitId, ['music'], next => {
    next.music.results = matches
  })
  const content = matches.length
    ? `找到 ${matches.length} 首相关歌曲：${matches.map(trackText).join('；')}`
    : `未找到与“${args.query}”相关的歌曲`
  reportActivity(onActivity, 'music', 'music_results_ready', content)
  return changed(content, state, { matches })
}

function selectTrackByQuery(music, query) {
  if (!query) return music.currentIndex || 0
  const matches = searchSongs(music, query)
  if (!matches.length) return -1
  return music.playlist.findIndex(song => song.id === matches[0].id)
}

function executePlay(args, context) {
  const { cockpitId, onActivity, snapshot, store } = context
  const query = clean(args.query).toLowerCase()
  const currentState = snapshot()
  const selectedIndex = selectTrackByQuery(currentState.music, query)
  if (selectedIndex < 0) {
    const content = `未找到与“${args.query}”相关的歌曲`
    reportActivity(onActivity, 'music', 'music_results_ready', content)
    return unchanged(content, currentState)
  }
  const state = store.update(cockpitId, ['music'], next => {
    next.music.currentIndex = selectedIndex
    next.music.playing = true
    next.music.muted = false
  })
  const content = `正在播放：${trackText(currentTrack(state.music))}`
  reportActivity(onActivity, 'music', 'music_started', content)
  return changed(content, state)
}

function executePlayback(name, args, context) {
  const { cockpitId, onActivity, snapshot, store } = context
  const action = name === 'music_toggle_playback'
    ? (clean(args.action) || 'toggle')
    : name.replace('music_', '')
  const currentState = snapshot()
  if (!['play', 'pause', 'toggle', 'next', 'previous'].includes(action)) {
    return unchanged('音乐播放控制参数无效', currentState)
  }
  const state = store.update(cockpitId, ['music'], next => {
    if (action === 'pause') next.music.playing = false
    else if (action === 'play') {
      next.music.playing = true
      next.music.muted = false
    } else if (action === 'toggle') {
      next.music.playing = !next.music.playing
      if (next.music.playing) next.music.muted = false
    } else if (action === 'next') {
      next.music.currentIndex = (next.music.currentIndex + 1) % next.music.playlist.length
      next.music.playing = true
      next.music.muted = false
    } else if (action === 'previous') {
      next.music.currentIndex = (next.music.currentIndex - 1 + next.music.playlist.length) % next.music.playlist.length
      next.music.playing = true
      next.music.muted = false
    }
  })
  const content = state.music.playing
    ? `正在播放：${trackText(currentTrack(state.music))}`
    : '已暂停播放'
  const status = state.music.playing
    ? action === 'next' || action === 'previous' ? 'music_track_changed' : 'music_started'
    : 'music_paused'
  reportActivity(onActivity, 'music', status, content)
  return changed(content, state)
}

function executeVolume(args, context) {
  const { cockpitId, onActivity, snapshot, store } = context
  const currentState = snapshot()
  const action = clean(args.action) || 'set'
  const rawVolume = args.volume ?? args.level
  if (!['increase', 'decrease', 'set', 'mute', 'unmute'].includes(action)) {
    return unchanged('音量控制参数无效', currentState)
  }
  if (action === 'set' && !Number.isFinite(Number(rawVolume))) {
    return unchanged('请指定 0~11 之间的媒体音量', currentState)
  }
  const state = store.update(cockpitId, ['music'], next => {
    const step = Number.isFinite(Number(args.delta))
      ? Math.abs(Number(args.delta))
      : Number(next.music.volumeStep) || DEFAULT_VOLUME_STEP
    if (action === 'increase') {
      next.music.volume = clampVolume(Number(next.music.volume) + step, next.music)
      next.music.muted = false
    } else if (action === 'decrease') {
      next.music.volume = clampVolume(Number(next.music.volume) - step, next.music)
      next.music.muted = next.music.volume === 0
    } else if (action === 'set') {
      next.music.volume = clampVolume(rawVolume, next.music)
      next.music.muted = next.music.volume === 0
    } else if (action === 'mute') {
      next.music.muted = true
    } else if (action === 'unmute') {
      next.music.muted = false
    }
  })
  const content = state.music.muted
    ? `已静音，媒体音量 ${state.music.volume}/${state.music.volumeMax || DEFAULT_VOLUME_MAX}`
    : `媒体音量已设为 ${state.music.volume}/${state.music.volumeMax || DEFAULT_VOLUME_MAX}`
  reportActivity(onActivity, 'music', 'music_volume_changed', content)
  return changed(content, state)
}

function normalizeSource(value) {
  const id = clean(value).toLowerCase().replace(/[\s-]+/g, '_')
  return SOURCE_ALIASES[id] || id
}

function executeSource(args, context) {
  const { cockpitId, onActivity, snapshot, store } = context
  const currentState = snapshot()
  const source = normalizeSource(args.source)
  if (!source) return unchanged('请指定媒体来源', currentState)
  const available = new Set(currentState.music.sources.map(item => item.id))
  if (!available.has(source)) {
    return unchanged(
      `暂不支持该媒体来源，可选来源：${currentState.music.sources.map(item => item.label).join('、')}`,
      currentState,
    )
  }
  const state = store.update(cockpitId, ['music'], next => {
    next.music.source = source
  })
  const content = `已切换媒体来源为${sourceLabel(state.music)}`
  reportActivity(onActivity, 'music', 'music_source_changed', content)
  return changed(content, state)
}

function targetTrack(music, args) {
  const query = clean(args.query).toLowerCase()
  if (!query) return currentTrack(music)
  const index = selectTrackByQuery(music, query)
  return index >= 0 ? music.playlist[index] : null
}

function executeFavorite(args, context) {
  const { cockpitId, onActivity, snapshot, store } = context
  const currentState = snapshot()
  const action = clean(args.action) || 'toggle'
  if (!['add', 'remove', 'toggle', 'next', 'previous'].includes(action)) {
    return unchanged('收藏控制参数无效', currentState)
  }
  if (action === 'next' || action === 'previous') {
    const favorites = favoriteTracks(currentState.music)
    if (!favorites.length) return unchanged('当前没有收藏歌曲', currentState)
    const current = currentTrack(currentState.music)
    const index = Math.max(0, favorites.findIndex(song => song.id === current?.id))
    const nextFavorite = action === 'next'
      ? favorites[(index + 1) % favorites.length]
      : favorites[(index - 1 + favorites.length) % favorites.length]
    const state = store.update(cockpitId, ['music'], next => {
      next.music.currentIndex = next.music.playlist.findIndex(song => song.id === nextFavorite.id)
      next.music.playing = true
      next.music.muted = false
    })
    const content = `正在播放收藏：${trackText(nextFavorite)}`
    reportActivity(onActivity, 'music', 'music_track_changed', content)
    return changed(content, state, { track: nextFavorite })
  }
  const track = targetTrack(currentState.music, args)
  if (!track) return unchanged(`未找到与“${args.query}”相关的歌曲`, currentState)
  const state = store.update(cockpitId, ['music'], next => {
    const ids = new Set(next.music.favoriteIds || [])
    if (action === 'add') ids.add(track.id)
    else if (action === 'remove') ids.delete(track.id)
    else if (ids.has(track.id)) ids.delete(track.id)
    else ids.add(track.id)
    next.music.favoriteIds = [...ids]
  })
  const favorite = state.music.favoriteIds.includes(track.id)
  const content = favorite
    ? `已收藏：${trackText(track)}`
    : `已取消收藏：${trackText(track)}`
  reportActivity(onActivity, 'music', 'music_favorites_changed', content)
  return changed(content, state, { track, favorite })
}

export function executeMusicTool(name, args = {}, context) {
  if (name === 'music_state_query') return executeStateQuery(args, context.snapshot())
  if (name === 'music_search') return executeSearch(args, context)
  if (name === 'music_play') return executePlay(args, context)
  if (name === 'music_pause' || name === 'music_next' || name === 'music_previous' || name === 'music_toggle_playback') {
    return executePlayback(name, args, context)
  }
  if (name === 'music_volume_control') return executeVolume(args, context)
  if (name === 'music_source_control') return executeSource(args, context)
  if (name === 'music_favorite_control') return executeFavorite(args, context)
  throw new Error(`Unknown music tool: ${name}`)
}
