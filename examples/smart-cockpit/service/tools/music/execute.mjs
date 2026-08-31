import { clean, reportActivity, toolResult } from '../shared.mjs'

export function executeMusicTool(name, args, context) {
  const { cockpitId, onActivity, snapshot, store } = context
  const currentState = snapshot()
  const query = clean(args.query).toLowerCase()
  const matches = currentState.music.playlist.filter(song => (
    !query
    || song.title.toLowerCase().includes(query)
    || song.artist.toLowerCase().includes(query)
    || song.album.toLowerCase().includes(query)
  ))
  if (name === 'music_search') {
    const state = store.update(cockpitId, ['music'], next => {
      next.music.results = matches
    })
    const content = matches.length
      ? `找到 ${matches.length} 首相关歌曲：${matches.map(song => `${song.title} - ${song.artist}`).join('；')}`
      : `未找到与“${args.query}”相关的歌曲`
    reportActivity(onActivity, 'music', 'music_results_ready', content)
    return toolResult(content, state, ['music'], { matches })
  }
  const state = store.update(cockpitId, ['music'], next => {
    if (name === 'music_pause') next.music.playing = false
    if (name === 'music_next') {
      next.music.currentIndex = (next.music.currentIndex + 1) % next.music.playlist.length
      next.music.playing = true
    }
    if (name === 'music_previous') {
      next.music.currentIndex = (next.music.currentIndex - 1 + next.music.playlist.length) % next.music.playlist.length
      next.music.playing = true
    }
    if (name === 'music_play') {
      if (matches.length && query) {
        next.music.currentIndex = next.music.playlist.findIndex(song => song.id === matches[0].id)
      }
      next.music.playing = true
    }
  })
  const current = state.music.playlist[state.music.currentIndex]
  const content = name === 'music_pause'
    ? '已暂停播放'
    : `正在播放：${current.title} - ${current.artist}`
  const status = name === 'music_play'
    ? 'music_started'
    : name === 'music_pause'
      ? 'music_paused'
      : 'music_track_changed'
  reportActivity(onActivity, 'music', status, content)
  return toolResult(content, state, ['music'], { music: state.music })
}
