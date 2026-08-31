function clean(value) {
  return String(value || '').trim()
}

function action(text) {
  if (/(关闭|关上|暂停|停止)/u.test(text)) return 'close'
  return 'open'
}

function windowPart(text) {
  if (/(全部|所有|四个|车窗)/u.test(text) && !/(主驾|副驾|后排|左后|右后)/u.test(text)) {
    return 'windows'
  }
  if (/(主驾|左前)/u.test(text)) return 'windowFL'
  if (/(副驾|右前)/u.test(text)) return 'windowFR'
  if (/(左后)/u.test(text)) return 'windowRL'
  if (/(右后)/u.test(text)) return 'windowRR'
  return 'windows'
}

function destination(text) {
  const match = text.match(/(?:导航到|导航去|前往|去)([^，。,.！？!?\n]{2,40})/u)
  return clean(match?.[1]).replace(/(?:怎么走|的路线|路线)$/u, '')
}

function songQuery(text) {
  const match = text.match(/(?:播放|放|听)(?:一首|一下)?([^，。,.！？!?\n]{1,30})/u)
  return clean(match?.[1]).replace(/(?:这首歌|音乐|歌曲)$/u, '')
}

export function planCockpitTool(input) {
  const text = clean(input)
  if (!text) return null

  if (/(确认|下单|就这个|可以买)/u.test(text) && /(订单|闪购|外卖|奶茶|咖啡|买)/u.test(text)) {
    return { name: 'flashbuy', arguments: { action: 'confirm_order', confirmed: true } }
  }
  if (/(取消|不要了)/u.test(text) && /(订单|闪购|外卖|奶茶|咖啡)/u.test(text)) {
    return { name: 'flashbuy', arguments: { action: 'cancel_order' } }
  }
  if (/(外卖|奶茶|咖啡|点餐|闪购|买杯|来一杯|想喝|想吃)/u.test(text)) {
    const category = /(外卖|点餐|吃|饭|面|沙拉)/u.test(text) ? 'food' : 'tea'
    const search = /(看看|搜索|搜一下|有什么|有哪些)/u.test(text)
    return {
      name: 'flashbuy',
      arguments: {
        action: search ? 'search' : 'add_to_cart',
        query: text,
        category,
      },
    }
  }

  if (/(停止导航|结束导航|取消导航)/u.test(text)) {
    return { name: 'navigation_stop', arguments: {} }
  }
  if (/(还有多久|剩余多久|导航路线|路线情况)/u.test(text)) {
    return { name: 'navigation_route_query', arguments: {} }
  }
  if (/(导航|前往|怎么去)/u.test(text)) {
    const target = destination(text)
    if (target) return { name: 'navigation_start', arguments: { destination: target } }
  }

  if (/(下一首|切歌)/u.test(text)) return { name: 'music_next', arguments: {} }
  if (/(上一首)/u.test(text)) return { name: 'music_previous', arguments: {} }
  if (/(暂停|停止)/u.test(text) && /(音乐|播放|歌曲|这首)/u.test(text)) {
    return { name: 'music_pause', arguments: {} }
  }
  if (/(播放|放歌|听歌|音乐|歌曲)/u.test(text)) {
    const query = songQuery(text)
    return { name: 'music_play', arguments: query ? { query } : {} }
  }

  if (/(车况|车辆状态|车窗状态|空调状态|大灯状态|天窗状态)/u.test(text)) {
    return { name: 'vehicle_state_query', arguments: { part: 'all' } }
  }
  const temperature = text.match(/(1[6-9]|2\d|3[0-2])\s*(?:度|℃)/u)?.[1]
  if (/(空调|温度|制冷|制热|风量)/u.test(text)) {
    if (temperature) {
      return {
        name: 'vehicle_climate_control',
        arguments: { action: 'set_temp', temperature: Number(temperature) },
      }
    }
    if (/(制热)/u.test(text)) {
      return {
        name: 'vehicle_climate_control',
        arguments: { action: 'set_mode', mode: 'heat' },
      }
    }
    if (/(制冷)/u.test(text)) {
      return {
        name: 'vehicle_climate_control',
        arguments: { action: 'set_mode', mode: 'cool' },
      }
    }
    return {
      name: 'vehicle_climate_control',
      arguments: { action: action(text) },
    }
  }
  if (/(车窗)/u.test(text)) {
    return {
      name: 'vehicle_window_control',
      arguments: { action: action(text), window: windowPart(text) },
    }
  }
  if (/(天窗)/u.test(text)) {
    return { name: 'vehicle_sunroof_control', arguments: { action: action(text) } }
  }
  if (/(大灯|车灯)/u.test(text)) {
    return { name: 'vehicle_headlights_control', arguments: { action: action(text) } }
  }
  return null
}

export function describePlan(plan) {
  if (!plan) return '正在检查示例座舱能力'
  if (plan.name.startsWith('vehicle_')) return '正在执行车辆操作'
  if (plan.name.startsWith('navigation_')) return '正在处理导航请求'
  if (plan.name.startsWith('music_')) return '正在处理音乐请求'
  return '正在处理闪购请求'
}
