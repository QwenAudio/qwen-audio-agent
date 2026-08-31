import { clean, reportActivity, toolResult } from '../shared.mjs'

function weatherText(data) {
  if (!data) return '天气查询失败'
  if (data.raw) return data.raw
  const summary = [
    data.city || '当前城市',
    data.dayweather || data.nightweather || '未知',
    data.daytemp ? `${data.daytemp}°` : '',
    data.nighttemp ? `夜间${data.nighttemp}°` : '',
    data.daywind && data.daypower ? `${data.daywind}风${data.daypower}级` : '',
  ].filter(Boolean).join('，')
  const tips = []
  const weather = data.dayweather || data.nightweather || ''
  const temperature = Number(data.daytemp || data.nighttemp)
  if (/雨/u.test(weather)) tips.push('记得带伞')
  if (Number.isFinite(temperature) && temperature <= 10) tips.push('注意保暖')
  if (Number.isFinite(temperature) && temperature >= 30) tips.push('注意防晒补水')
  return tips.length ? `${summary}。${tips.join('，')}` : summary
}

export async function executeWeatherTool(_name, args, context) {
  const {
    cockpitId,
    onActivity,
    services,
    snapshot,
    store,
  } = context
  const city = clean(args.city) || '杭州'
  reportActivity(onActivity, 'weather', 'weather_querying', '正在查询天气')
  const weather = await services.weather(city)
  if (!weather) return toolResult('天气查询失败', snapshot(), [])
  const state = store.update(cockpitId, ['weather'], next => {
    next.weather = structuredClone(weather)
  })
  reportActivity(onActivity, 'weather', 'weather_ready', '天气已更新')
  return toolResult(weatherText(weather), state, ['weather'], { weather: state.weather })
}
