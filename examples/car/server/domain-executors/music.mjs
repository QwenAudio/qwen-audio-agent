const SONGS = [
  { title: '晴天', artist: '周杰伦', album: '叶惠美' },
  { title: '七里香', artist: '周杰伦', album: '七里香' },
  { title: '稻香', artist: '周杰伦', album: '魔杰座' },
  { title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' },
  { title: '简单爱', artist: '周杰伦', album: '范特西' },
  { title: '青花瓷', artist: '周杰伦', album: '我很忙' },
]

function searchSongs(query) {
  const q = String(query || '').toLowerCase()
  return SONGS.filter(song => (
    song.title.toLowerCase().includes(q)
    || song.artist.toLowerCase().includes(q)
    || song.album.toLowerCase().includes(q)
  ))
}

async function executeMusic(params = {}) {
  const { action, query } = params
  switch (action) {
    case 'play': {
      if (query) {
        const matches = searchSongs(query)
        if (matches.length > 0) {
          return {
            result: `正在播放：${matches[0].title} - ${matches[0].artist}（${matches[0].album}）`,
            action: { type: 'music', action: 'play', query: matches[0].title },
          }
        }
      }
      return {
        result: query ? `未找到"${query}"，已继续播放当前歌曲` : '已继续播放',
        action: { type: 'music', action: 'play', query },
      }
    }
    case 'pause':
      return {
        result: '已暂停播放',
        action: { type: 'music', action: 'pause' },
      }
    case 'next':
      return {
        result: '已切换到下一首',
        action: { type: 'music', action: 'next' },
      }
    case 'prev':
      return {
        result: '已切换到上一首',
        action: { type: 'music', action: 'prev' },
      }
    case 'search': {
      if (!query) return { result: '请提供搜索关键词' }
      const matches = searchSongs(query)
      if (matches.length === 0) return { result: `未找到与"${query}"相关的歌曲` }
      const list = matches.map(song => `${song.title} - ${song.artist}（${song.album}）`).join('\n')
      return {
        result: `找到 ${matches.length} 首相关歌曲：\n${list}`,
        action: { type: 'music', action: 'search', query },
      }
    }
    default:
      return { result: '未知音乐操作' }
  }
}

export default {
  'music.play': params => executeMusic({ action: 'play', ...(params?.query ? { query: params.query } : {}) }),
  'music.pause': () => executeMusic({ action: 'pause' }),
  'music.next': () => executeMusic({ action: 'next' }),
  'music.previous': () => executeMusic({ action: 'prev' }),
  'music.search': params => executeMusic({ action: 'search', query: params?.query }),
}
