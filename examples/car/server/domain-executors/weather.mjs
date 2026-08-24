import { getWeather } from '../amap-mcp.mjs'

function formatWeather(data) {
  if (!data) return '天气查询失败'
  if (data.raw) return data.raw
  const city = data.city || '当前城市'
  const weather = data.dayweather || data.nightweather || '未知'
  const temp = data.daytemp ? `${data.daytemp}°` : ''
  const low = data.nighttemp ? `夜间${data.nighttemp}°` : ''
  const wind = data.daywind && data.daypower ? `${data.daywind}风${data.daypower}级` : ''
  return [city, weather, temp, low, wind].filter(Boolean).join('，')
}

function weatherAdvice(data) {
  if (!data) return ''
  const temp = data.daytemp || data.nighttemp
  const weather = data.dayweather || data.nightweather || ''
  const tips = []
  if (/雨/.test(weather)) tips.push('记得带伞')
  if (Number(temp) <= 10) tips.push('注意保暖')
  if (Number(temp) >= 30) tips.push('注意防晒补水')
  return tips.length ? `。${tips.join('，')}` : ''
}

async function queryWeather(params = {}, context = {}) {
  const city = params.city || '杭州'
  if (context.onProgress) {
    context.onProgress({ domain: 'weather', stage: 'weather_querying', message: '正在查询天气', speakPolicy: 'if_slow' })
  }

  const data = await getWeather(city)
  if (context.onProgress) {
    context.onProgress({ domain: 'weather', stage: 'weather_ready', message: '天气已更新', speakPolicy: 'silent' })
  }

  return {
    result: `${formatWeather(data)}${weatherAdvice(data)}`,
    action: data ? { type: 'weather', weather: data } : null,
  }
}

export default {
  'weather.query': queryWeather,
}
