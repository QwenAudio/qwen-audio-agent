import {
  DEFAULT_ORIGIN,
  FLASHBUY_CATALOG,
} from './catalog.mjs'
import { CockpitStateStore } from './state-store.mjs'
import { COCKPIT_TOOL_NAMES } from './tool-catalog.mjs'

const WINDOW_PARTS = ['windowFL', 'windowFR', 'windowRL', 'windowRR']
const VEHICLE_PARTS = [...WINDOW_PARTS, 'sunroof', 'headlights']
const PART_LABELS = Object.freeze({
  windowFL: '主驾车窗',
  windowFR: '副驾车窗',
  windowRL: '左后车窗',
  windowRR: '右后车窗',
  windows: '全部车窗',
  sunroof: '天窗',
  headlights: '大灯',
  ac: '空调',
  all: '全部可控部件',
})

function clean(value) {
  return String(value || '').trim()
}

function activity(callback, category, status, message) {
  callback?.({
    kind: 'status',
    category,
    status,
    message,
  })
}

function result(content, state, changed, data = {}) {
  return {
    content,
    stateVersion: state.version,
    changed,
    data,
  }
}

function inferCategory(query = '', category) {
  if (['food', 'tea'].includes(category)) return category
  if (/(外卖|吃|饭|面|沙拉|餐|牛肉|肥牛)/u.test(query)) return 'food'
  return 'tea'
}

function itemMatches(item, query = '') {
  if (!query) return true
  return [item.name, item.shopName, item.category, item.tag]
    .some(value => String(value || '').includes(query))
}

function normalizeItem(item) {
  return structuredClone(item)
}

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

function emptyServices() {
  return {
    async resolvePlace() { return null },
    async drivingRoute() { return null },
    async weather() { return null },
  }
}

export class CockpitDomain {
  constructor({
    store = new CockpitStateStore(),
    services = emptyServices(),
    now = Date.now,
    random = Math.random,
  } = {}) {
    this.store = store
    this.services = services
    this.now = now
    this.random = random
  }

  snapshot(cockpitId = 'default') {
    return this.store.snapshot(cockpitId)
  }

  subscribe(cockpitId, listener) {
    return this.store.subscribe(cockpitId, listener)
  }

  async execute(name, args = {}, {
    cockpitId = 'default',
    onActivity = null,
  } = {}) {
    if (!COCKPIT_TOOL_NAMES.includes(name)) {
      throw new Error(`Unknown cockpit tool: ${name}`)
    }
    if (name.startsWith('vehicle_')) {
      return this.#vehicle(name, args, cockpitId)
    }
    if (name.startsWith('music_')) {
      return this.#music(name, args, cockpitId)
    }
    if (name.startsWith('navigation_')) {
      return this.#navigation(name, args, cockpitId, onActivity)
    }
    if (name === 'weather') {
      return this.#weather(args, cockpitId, onActivity)
    }
    return this.#flashbuy(args, cockpitId, onActivity)
  }

  #vehicle(name, args, cockpitId) {
    if (name === 'vehicle_state_query') {
      const state = this.snapshot(cockpitId)
      return result(this.#vehicleStateText(args.part, state.vehicle), state, [], {
        vehicle: state.vehicle,
      })
    }

    if (name === 'vehicle_climate_control') {
      const action = clean(args.action)
      const current = this.snapshot(cockpitId)
      if (action === 'set_temp') {
        const temperature = Number(args.temperature)
        if (!Number.isFinite(temperature) || temperature < 16 || temperature > 32) {
          return result('温度超出范围，空调温度需在 16~32°C 之间', current, [])
        }
      }
      if (action === 'set_fan') {
        const fan = Number(args.fan)
        if (!Number.isInteger(fan) || fan < 1 || fan > 5) {
          return result('风量超出范围，需在 1~5 档之间', current, [])
        }
      }
      if (action === 'set_mode' && !['cool', 'heat'].includes(args.mode)) {
        return result('请指定空调模式（cool 或 heat）', current, [])
      }
      const state = this.store.update(cockpitId, ['vehicle'], next => {
        if (action === 'open') next.vehicle.ac = 1
        else if (action === 'close') next.vehicle.ac = 0
        else if (action === 'set_temp') {
          next.vehicle.ac = 1
          next.vehicle.acTemp = Number(args.temperature)
        } else if (action === 'set_mode') {
          next.vehicle.ac = 1
          next.vehicle.acMode = args.mode
        } else if (action === 'set_fan') {
          next.vehicle.ac = 1
          next.vehicle.acFan = Number(args.fan)
        } else {
          throw new Error(`Unknown climate action: ${action}`)
        }
      })
      return result(this.#vehicleStateText('ac', state.vehicle), state, ['vehicle'], {
        vehicle: state.vehicle,
      })
    }

    const action = clean(args.action)
    if (!['open', 'close'].includes(action)) throw new Error(`Unknown vehicle action: ${action}`)
    const stateValue = action === 'open' ? 1 : 0
    let parts
    if (name === 'vehicle_window_control') {
      const window = clean(args.window) || 'windows'
      parts = window === 'windows' ? WINDOW_PARTS : [window]
    } else if (name === 'vehicle_sunroof_control') {
      parts = ['sunroof']
    } else {
      parts = ['headlights']
    }
    if (parts.some(part => !VEHICLE_PARTS.includes(part))) throw new Error('Unknown vehicle part')
    const state = this.store.update(cockpitId, ['vehicle'], next => {
      for (const part of parts) next.vehicle[part] = stateValue
    })
    const target = name === 'vehicle_window_control'
      ? PART_LABELS[args.window || 'windows']
      : PART_LABELS[parts[0]]
    return result(`已${action === 'open' ? '打开' : '关闭'}${target}`, state, ['vehicle'], {
      vehicle: state.vehicle,
    })
  }

  #vehicleStateText(part = 'all', vehicle) {
    if (!part || part === 'all' || part === 'windows') {
      return [
        ...VEHICLE_PARTS.map(key => `${PART_LABELS[key]}: ${vehicle[key] ? '开启' : '关闭'}`),
        `空调: ${vehicle.ac ? '开启' : '关闭'}，${vehicle.acMode === 'heat' ? '制热' : '制冷'}，${vehicle.acTemp}°C，${vehicle.acFan}档`,
      ].join('，')
    }
    if (part === 'ac') {
      return `空调当前${vehicle.ac ? '开启' : '关闭'}，${vehicle.acMode === 'heat' ? '制热' : '制冷'}，${vehicle.acTemp}°C，${vehicle.acFan}档`
    }
    return `${PART_LABELS[part] || part}当前${vehicle[part] ? '开启' : '关闭'}`
  }

  #music(name, args, cockpitId) {
    const snapshot = this.snapshot(cockpitId)
    const query = clean(args.query).toLowerCase()
    const matches = snapshot.music.playlist.filter(song => (
      !query
      || song.title.toLowerCase().includes(query)
      || song.artist.toLowerCase().includes(query)
      || song.album.toLowerCase().includes(query)
    ))
    if (name === 'music_search') {
      const state = this.store.update(cockpitId, ['music'], next => {
        next.music.results = matches
      })
      const content = matches.length
        ? `找到 ${matches.length} 首相关歌曲：${matches.map(song => `${song.title} - ${song.artist}`).join('；')}`
        : `未找到与“${args.query}”相关的歌曲`
      return result(content, state, ['music'], { matches })
    }
    const state = this.store.update(cockpitId, ['music'], next => {
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
    return result(content, state, ['music'], { music: state.music })
  }

  async #navigation(name, args, cockpitId, onActivity) {
    if (name === 'navigation_stop') {
      const state = this.store.update(cockpitId, ['navigation'], next => {
        next.navigation = {
          status: 'idle',
          destination: null,
          via: null,
          strategy: next.navigation.strategy,
          route: null,
          map: { markers: [], polylines: [] },
        }
      })
      activity(onActivity, 'navigation', 'navigation_stopped', '已停止导航')
      return result('已停止导航', state, ['navigation'], { navigation: state.navigation })
    }

    const destination = clean(args.destination)
    if (!destination) throw new Error('Destination is required')
    const via = clean(args.via)
    const strategy = Number(args.strategy) || 0
    activity(onActivity, 'navigation', 'searching_destination', '正在查找目的地')
    const destinationLocation = await this.services.resolvePlace(destination, DEFAULT_ORIGIN.city)
    if (!destinationLocation) {
      activity(onActivity, 'navigation', 'destination_not_found', `没有找到${destination}`)
      const state = this.snapshot(cockpitId)
      return result(`无法找到“${destination}”的位置信息`, state, [])
    }
    const viaLocation = via
      ? await this.services.resolvePlace(via, DEFAULT_ORIGIN.city)
      : null
    activity(onActivity, 'navigation', 'planning_route', '正在规划路线')
    const route = await this.#planRoute(destinationLocation, viaLocation, strategy)
    if (!route) {
      activity(onActivity, 'navigation', 'route_failed', '路线规划失败')
      return result('路线规划失败，请稍后重试', this.snapshot(cockpitId), [])
    }
    const state = this.store.update(cockpitId, ['navigation'], next => {
      next.navigation = {
        status: name === 'navigation_start' ? 'navigating' : 'preview',
        destination,
        via: via || null,
        strategy,
        route,
        map: {
          markers: [
            { role: 'destination', name: destination, location: destinationLocation },
            ...(viaLocation ? [{ role: 'via', name: via, location: viaLocation }] : []),
          ],
          polylines: route.legs.map((leg, index) => ({
            segment: index,
            polyline: leg.polyline,
            trafficSegments: leg.trafficSegments || [],
          })),
        },
      }
    })
    const status = name === 'navigation_start' ? 'navigation_started' : 'route_ready'
    activity(onActivity, 'navigation', status, name === 'navigation_start' ? '开始导航' : '路线规划好了')
    const viaText = via ? `，途经${via}` : ''
    const content = `已规划到${destination}${viaText}的路线，全程${route.distKm}公里，约${route.durationMin}分钟`
    return result(content, state, ['navigation'], { navigation: state.navigation })
  }

  async #planRoute(destination, via, strategy) {
    const points = via
      ? [[DEFAULT_ORIGIN.location, via], [via, destination]]
      : [[DEFAULT_ORIGIN.location, destination]]
    const legs = []
    for (const [origin, target] of points) {
      const leg = await this.services.drivingRoute(origin, target, strategy)
      if (!leg) return null
      legs.push(leg)
    }
    const distance = legs.reduce((total, leg) => total + Number(leg.distance || 0), 0)
    const duration = legs.reduce((total, leg) => total + Number(leg.duration || 0), 0)
    const arrival = new Date(this.now() + duration * 1_000)
    return {
      distance,
      duration,
      distKm: (distance / 1_000).toFixed(1),
      durationMin: Math.ceil(duration / 60),
      arrival: `${String(arrival.getHours()).padStart(2, '0')}:${String(arrival.getMinutes()).padStart(2, '0')}`,
      legs: structuredClone(legs),
    }
  }

  async #weather(args, cockpitId, onActivity) {
    const city = clean(args.city) || '杭州'
    activity(onActivity, 'weather', 'weather_querying', '正在查询天气')
    const weather = await this.services.weather(city)
    if (!weather) return result('天气查询失败', this.snapshot(cockpitId), [])
    const state = this.store.update(cockpitId, ['weather'], next => {
      next.weather = structuredClone(weather)
    })
    activity(onActivity, 'weather', 'weather_ready', '天气已更新')
    return result(weatherText(weather), state, ['weather'], { weather: state.weather })
  }

  #flashbuy(args, cockpitId, onActivity) {
    const action = clean(args.action)
    const before = this.snapshot(cockpitId)
    if (action === 'search') {
      const query = clean(args.query)
      const category = inferCategory(query, args.category)
      let items = FLASHBUY_CATALOG.filter(item => item.category === category && itemMatches(item, query))
      if (!items.length) items = FLASHBUY_CATALOG.filter(item => item.category === category)
      activity(onActivity, 'flashbuy', 'flashbuy_searching', '正在查找附近可送商品')
      const state = this.store.update(cockpitId, ['flashbuy'], next => {
        Object.assign(next.flashbuy, {
          status: 'selecting',
          message: items.length ? '已找到附近可送商品' : '没有找到可送商品',
          query,
          category,
          items: items.map(normalizeItem),
          order: null,
        })
      })
      return result(`找到${items.length}个可送商品`, state, ['flashbuy'], { flashbuy: state.flashbuy })
    }
    if (action === 'cancel_order') {
      const state = this.store.update(cockpitId, ['flashbuy'], next => {
        Object.assign(next.flashbuy, {
          status: 'cancelled',
          message: '已取消当前闪购流程',
          cartItems: [],
          total: 0,
          preview: null,
          order: null,
        })
      })
      return result('已取消当前闪购流程', state, ['flashbuy'], { flashbuy: state.flashbuy })
    }
    if (action === 'add_to_cart') return this.#addToCart(args, cockpitId, onActivity)
    if (action === 'update_cart') return this.#updateCart(args, cockpitId)
    if (action === 'preview_order') return this.#previewOrder(args, cockpitId, onActivity)
    if (action === 'confirm_order') {
      if (before.flashbuy.order) {
        return result(`订单${before.flashbuy.order.id}已经提交，请勿重复下单`, before, [], {
          order: before.flashbuy.order,
          duplicate: true,
        })
      }
      if (!before.flashbuy.preview) {
        return result('还没有可确认的订单，请先选择商品并预览订单', before, [])
      }
      if (args.confirmed !== true) {
        return result('下单前需要用户明确确认', before, [], {
          requireConfirm: true,
          preview: before.flashbuy.preview,
        })
      }
      activity(onActivity, 'flashbuy', 'flashbuy_ordering', '正在提交订单')
      const state = this.store.update(cockpitId, ['flashbuy'], next => {
        const preview = next.flashbuy.preview
        next.flashbuy.status = 'completed'
        next.flashbuy.message = '已完成下单'
        next.flashbuy.order = {
          id: `SG${Math.floor(1_000 + this.random() * 9_000)}`,
          status: '骑手取货中',
          eta: preview.eta,
          total: preview.total,
          address: preview.address,
          items: preview.items,
        }
        next.flashbuy.cartItems = []
        next.flashbuy.total = 0
        next.flashbuy.preview = null
      })
      activity(onActivity, 'flashbuy', 'flashbuy_order_completed', '已完成下单')
      return result(`已下单，订单${state.flashbuy.order.id}，预计${state.flashbuy.order.eta}送达`, state, ['flashbuy'], {
        order: state.flashbuy.order,
      })
    }
    throw new Error(`Unknown flashbuy action: ${action}`)
  }

  #addToCart(args, cockpitId, onActivity) {
    let state = this.snapshot(cockpitId)
    if (!state.flashbuy.items.length) {
      this.#flashbuy({ action: 'search', query: args.query, category: args.category }, cockpitId, onActivity)
      state = this.snapshot(cockpitId)
    }
    const item = args.itemId
      ? state.flashbuy.items.find(row => row.id === args.itemId)
      : state.flashbuy.items.find(row => itemMatches(row, clean(args.query))) || state.flashbuy.items[0]
    if (!item) return result('没有可加入购物车的商品', state, [])
    const quantity = Math.max(1, Number(args.quantity) || 1)
    activity(onActivity, 'flashbuy', 'flashbuy_adding', '正在加入购物车')
    this.store.update(cockpitId, ['flashbuy'], next => {
      next.flashbuy.cartItems.push({
        ...normalizeItem(item),
        lineId: `${item.id}-${this.now()}`,
        quantity,
        selectedOptions: structuredClone(args.options || {}),
      })
      next.flashbuy.total = next.flashbuy.cartItems.reduce((sum, row) => sum + row.price * row.quantity, 0)
      next.flashbuy.status = 'cart_updated'
      next.flashbuy.message = '已更新购物车'
      next.flashbuy.order = null
      next.flashbuy.preview = null
    })
    const preview = this.#previewOrder(args, cockpitId, onActivity)
    return {
      ...preview,
      content: `已加入${item.name}。${preview.content}。请向用户确认是否下单。`,
    }
  }

  #updateCart(args, cockpitId) {
    const quantity = Math.max(0, Number(args.quantity) || 0)
    const state = this.store.update(cockpitId, ['flashbuy'], next => {
      next.flashbuy.cartItems = next.flashbuy.cartItems
        .map(row => (
          row.lineId === args.lineId || row.id === args.itemId
            ? { ...row, quantity }
            : row
        ))
        .filter(row => row.quantity > 0)
      next.flashbuy.total = next.flashbuy.cartItems.reduce((sum, row) => sum + row.price * row.quantity, 0)
      next.flashbuy.status = next.flashbuy.cartItems.length ? 'cart_updated' : 'selecting'
      next.flashbuy.message = next.flashbuy.cartItems.length ? '已更新购物车' : '购物车已清空'
      next.flashbuy.preview = null
      next.flashbuy.order = null
    })
    return result(state.flashbuy.message, state, ['flashbuy'], { flashbuy: state.flashbuy })
  }

  #previewOrder(args, cockpitId, onActivity) {
    const before = this.snapshot(cockpitId)
    if (!before.flashbuy.cartItems.length) {
      return result('购物车为空，请先选择商品', before, [])
    }
    activity(onActivity, 'flashbuy', 'flashbuy_previewing', '正在试算订单')
    const state = this.store.update(cockpitId, ['flashbuy'], next => {
      const subtotal = next.flashbuy.cartItems.reduce((sum, row) => sum + row.price * row.quantity, 0)
      const deliveryFee = subtotal >= 35 ? 0 : 5
      const eta = next.flashbuy.cartItems
        .map(row => Number.parseInt(row.eta, 10))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0] || 25
      next.flashbuy.address = clean(args.address) || next.flashbuy.address
      next.flashbuy.status = 'awaiting_confirm'
      next.flashbuy.message = '请确认订单后下单'
      next.flashbuy.total = subtotal
      next.flashbuy.preview = {
        shopName: next.flashbuy.cartItems[0].shopName,
        items: structuredClone(next.flashbuy.cartItems),
        subtotal,
        deliveryFee,
        total: subtotal + deliveryFee,
        address: next.flashbuy.address,
        eta: `${eta}分钟`,
      }
    })
    const preview = state.flashbuy.preview
    const content = `订单预览：${preview.items.map(row => `${row.name}x${row.quantity}`).join('、')}，总价${preview.total}元，预计${preview.eta}送达`
    return result(content, state, ['flashbuy'], { preview, requireConfirm: true })
  }
}
