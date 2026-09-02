import { clean, toolResult } from '../shared.mjs'
import { vehicleLocationText } from '../../vehicle-location.mjs'

const WINDOW_PARTS = ['windowFL', 'windowFR', 'windowRL', 'windowRR']
const TEMPERATURE_LIMITS = Object.freeze({ min: 16, max: 32 })
const FAN_LIMITS = Object.freeze({ min: 1, max: 8 })
const CHARGE_LIMITS = Object.freeze({ min: 50, max: 100 })
const CHARGING_AMP_LIMITS = Object.freeze({ min: 5, max: 48 })

const PART_LABELS = Object.freeze({
  all: '全部车辆状态',
  climate: '空调',
  temperature: '温度',
  comfort: '舒适控制',
  windowFL: '主驾车窗',
  windowFR: '副驾车窗',
  windowRL: '左后车窗',
  windowRR: '右后车窗',
  windows: '全部车窗',
  front: '前排',
  rear: '后排',
  left: '左侧',
  right: '右侧',
  sunroof: '天窗',
  closures: '开闭件',
  front_trunk: '前备箱',
  rear_trunk: '后备箱',
  trunk: '后备箱',
  charge_port: '充电口',
  fuel_port: '加油口',
  lights: '灯光',
  headlights: '大灯',
  sound: '声音',
  charging: '充电',
  driver: '主驾',
  passenger: '副驾',
  rearLeft: '左后',
  rearRight: '右后',
  seat_heater: '座椅加热',
  seat_cooler: '座椅通风',
  auto_seat_climate: '自动座椅温控',
  steering_wheel_heater: '方向盘加热',
  steering_wheel_heat_level: '方向盘加热档位',
  auto_steering_wheel_heat: '自动方向盘加热',
})

const ZONE_LABELS = Object.freeze({
  driver: '主驾',
  passenger: '副驾',
  rear: '后排',
  front: '前排',
  all: '全车',
})

const WINDOW_GROUPS = Object.freeze({
  windows: WINDOW_PARTS,
  front: ['windowFL', 'windowFR'],
  rear: ['windowRL', 'windowRR'],
  left: ['windowFL', 'windowRL'],
  right: ['windowFR', 'windowRR'],
})

const TEMPERATURE_ZONES = Object.freeze({
  driver: ['acTemp'],
  passenger: ['passengerTemp'],
  rear: ['rearTemp'],
  front: ['acTemp', 'passengerTemp'],
  all: ['acTemp', 'passengerTemp', 'rearTemp'],
})

const SEAT_GROUPS = Object.freeze({
  driver: ['driver'],
  passenger: ['passenger'],
  rearLeft: ['rearLeft'],
  rearRight: ['rearRight'],
  front: ['driver', 'passenger'],
  rear: ['rearLeft', 'rearRight'],
  all: ['driver', 'passenger', 'rearLeft', 'rearRight'],
})

function enabledText(value) {
  return value ? '开启' : '关闭'
}

function windowText(key, vehicle) {
  const value = Number(vehicle[key]) || 0
  if (value <= 0) return `${PART_LABELS[key]}: 关闭`
  if (value === 1 || value >= 100) return `${PART_LABELS[key]}: 开启`
  return `${PART_LABELS[key]}: 开启${value}%`
}

function climateText(vehicle) {
  return [
    `空调当前${enabledText(vehicle.ac)}`,
    vehicle.preconditioning ? '预处理中' : '未预处理',
    vehicle.acMode === 'heat' ? '制热' : '制冷',
    `风量${vehicle.acFan}档`,
  ].join('，')
}

function temperatureText(vehicle) {
  return `主驾${vehicle.acTemp}°C，副驾${vehicle.passengerTemp}°C，后排${vehicle.rearTemp}°C`
}

function comfortText(vehicle) {
  return [
    `座椅加热: 主驾${vehicle.seatHeating.driver}档，副驾${vehicle.seatHeating.passenger}档，左后${vehicle.seatHeating.rearLeft}档，右后${vehicle.seatHeating.rearRight}档`,
    `座椅通风: 主驾${vehicle.seatCooling.driver}档，副驾${vehicle.seatCooling.passenger}档，左后${vehicle.seatCooling.rearLeft}档，右后${vehicle.seatCooling.rearRight}档`,
    `方向盘加热: ${enabledText(vehicle.steeringWheelHeater)}，${vehicle.steeringWheelHeatLevel}档`,
  ].join('，')
}

function closureText(vehicle) {
  return [
    `前备箱: ${enabledText(vehicle.frontTrunk)}`,
    `后备箱: ${enabledText(vehicle.rearTrunk)}`,
    `充电口: ${enabledText(vehicle.chargePort)}`,
  ].join('，')
}

function lightText(vehicle) {
  return `大灯: ${enabledText(vehicle.headlights)}，已闪灯${vehicle.flashLightsCount || 0}次`
}

function soundText(vehicle) {
  return `已鸣笛${vehicle.hornCount || 0}次${vehicle.boomboxSound ? `，外放提示音: ${vehicle.boomboxSound}` : ''}`
}

function chargingText(vehicle) {
  return [
    `充电: ${vehicle.charging ? '进行中' : '未充电'}`,
    `上限${vehicle.chargeLimit}%`,
    `电流${vehicle.chargingAmps}A`,
    `模式${vehicle.chargeMode === 'max_range' ? '最大续航' : '标准续航'}`,
    `计划${vehicle.chargeSchedules.length}个`,
  ].join('，')
}

function stateText(part = 'all', vehicle) {
  const normalized = part === 'ac' ? 'climate' : part === 'headlights' ? 'lights' : part
  if (!normalized || normalized === 'all') {
    return [
      WINDOW_PARTS.map(key => windowText(key, vehicle)).join('，'),
      `${PART_LABELS.sunroof}: ${sunroofStateText(vehicle.sunroof)}`,
      climateText(vehicle),
      `温度: ${temperatureText(vehicle)}`,
      closureText(vehicle),
      comfortText(vehicle),
      lightText(vehicle),
      soundText(vehicle),
      chargingText(vehicle),
    ].join('，')
  }
  if (WINDOW_PARTS.includes(normalized)) return windowText(normalized, vehicle)
  if (normalized === 'windows') return WINDOW_PARTS.map(key => windowText(key, vehicle)).join('，')
  if (normalized === 'sunroof') return `天窗当前${sunroofStateText(vehicle.sunroof)}`
  if (normalized === 'climate') return `${climateText(vehicle)}，${temperatureText(vehicle)}`
  if (normalized === 'temperature') return temperatureText(vehicle)
  if (normalized === 'closures') return closureText(vehicle)
  if (normalized === 'comfort') return comfortText(vehicle)
  if (normalized === 'lights') return lightText(vehicle)
  if (normalized === 'sound') return soundText(vehicle)
  if (normalized === 'charging') return chargingText(vehicle)
  return `${PART_LABELS[normalized] || normalized}状态暂不支持查询`
}

function sunroofStateText(value) {
  if (value === 'vent') return '通风'
  if (value === 'tilt') return '翘起'
  if (value === 'stopped') return '已停止'
  return value ? '开启' : '关闭'
}

function numeric(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a number`)
  return parsed
}

function integerInRange(value, { min, max }, label) {
  const parsed = numeric(value, label)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`)
  }
  return parsed
}

function numberInRange(value, { min, max }, label) {
  const parsed = numeric(value, label)
  if (parsed < min || parsed > max) {
    throw new RangeError(`${label} must be from ${min} to ${max}`)
  }
  return parsed
}

function clamp(value, { min, max }) {
  return Math.max(min, Math.min(max, value))
}

function windowParts(value) {
  const window = clean(value) || 'windows'
  if (WINDOW_PARTS.includes(window)) return [window]
  const parts = WINDOW_GROUPS[window]
  if (!parts) throw new Error('Unknown vehicle window')
  return parts
}

function temperatureFields(value) {
  const zone = clean(value) || 'all'
  const fields = TEMPERATURE_ZONES[zone]
  if (!fields) throw new Error('Unknown temperature zone')
  return { zone, fields }
}

function seatParts(value) {
  const seat = clean(value) || 'driver'
  const seats = SEAT_GROUPS[seat]
  if (!seats) throw new Error('Unknown seat')
  return { seat, seats }
}

function updateVehicle(cockpitId, store, mutate) {
  return store.update(cockpitId, ['vehicle'], mutate)
}

function unchanged(message, state) {
  return toolResult(message, state, [], { vehicle: state.vehicle })
}

function changed(message, state) {
  return toolResult(message, state, ['vehicle'], { vehicle: state.vehicle })
}

function executeClimate(args, context) {
  const { cockpitId, snapshot, store } = context
  const action = clean(args.action)
  const current = snapshot()
  try {
    if (action === 'set_temp') {
      const temperature = numberInRange(args.temperature, TEMPERATURE_LIMITS, 'temperature')
      const state = updateVehicle(cockpitId, store, next => {
        next.vehicle.ac = 1
        next.vehicle.acTemp = temperature
        next.vehicle.passengerTemp = temperature
        next.vehicle.rearTemp = temperature
      })
      return changed(`${climateText(state.vehicle)}，${temperatureText(state.vehicle)}`, state)
    }
    if (action === 'set_fan') integerInRange(args.fan, FAN_LIMITS, 'fan')
    if (action === 'set_mode' && !['cool', 'heat'].includes(args.mode)) {
      return unchanged('请指定空调模式（cool 或 heat）', current)
    }
  } catch {
    if (action === 'set_temp') return unchanged('温度超出范围，空调温度需在 16~32°C 之间', current)
    if (action === 'set_fan') return unchanged('风量超出范围，需在 1~8 档之间', current)
    throw new Error('Invalid climate arguments')
  }

  const state = updateVehicle(cockpitId, store, next => {
    if (action === 'start') {
      next.vehicle.ac = 1
      next.vehicle.preconditioning = 1
    } else if (action === 'stop') {
      next.vehicle.ac = 0
      next.vehicle.preconditioning = 0
    } else if (action === 'open') {
      next.vehicle.ac = 1
    } else if (action === 'close') {
      next.vehicle.ac = 0
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
  return changed(climateText(state.vehicle), state)
}

function executeTemperature(args, context) {
  const { cockpitId, snapshot, store } = context
  const action = clean(args.action)
  const current = snapshot()
  let zone
  let fields
  try {
    ;({ zone, fields } = temperatureFields(args.zone))
    if (action === 'set') numberInRange(args.temperature, TEMPERATURE_LIMITS, 'temperature')
    else if (action !== 'increase' && action !== 'decrease') throw new Error(`Unknown temperature action: ${action}`)
    if ('delta' in args && args.delta !== undefined) numberInRange(args.delta, { min: 0.5, max: 10 }, 'delta')
  } catch {
    return unchanged('温度参数无效，温区需有效，温度需在 16~32°C 之间', current)
  }
  const delta = Number(args.delta ?? 1)
  const state = updateVehicle(cockpitId, store, next => {
    next.vehicle.ac = 1
    for (const field of fields) {
      if (action === 'set') next.vehicle[field] = Number(args.temperature)
      else {
        const signed = action === 'increase' ? delta : -delta
        next.vehicle[field] = clamp(Number(next.vehicle[field]) + signed, TEMPERATURE_LIMITS)
      }
    }
  })
  return changed(`已调整${ZONE_LABELS[zone]}温度，${temperatureText(state.vehicle)}`, state)
}

function executeWindow(args, context) {
  const { cockpitId, snapshot, store } = context
  const action = clean(args.action)
  const current = snapshot()
  let parts
  let value
  try {
    parts = windowParts(args.window)
    if (action === 'open') value = 1
    else if (action === 'close') value = 0
    else if (action === 'vent') value = 15
    else if (action === 'set') value = numberInRange(args.level, { min: 0, max: 100 }, 'level')
    else throw new Error(`Unknown window action: ${action}`)
  } catch {
    return unchanged('车窗参数无效，请指定有效车窗和开度', current)
  }
  const state = updateVehicle(cockpitId, store, next => {
    for (const part of parts) next.vehicle[part] = value
  })
  const target = PART_LABELS[clean(args.window) || 'windows'] || '车窗'
  const actionText = action === 'close' ? '关闭' : action === 'vent' ? '通风' : '打开'
  return changed(`已${actionText}${target}`, state)
}

function executeSunroof(args, context) {
  const { cockpitId, snapshot, store } = context
  const action = clean(args.action)
  const current = snapshot()
  const nextValue = {
    open: 1,
    close: 0,
    vent: 'vent',
    tilt: 'tilt',
    stop: 'stopped',
  }[action]
  if (nextValue === undefined) return unchanged('天窗参数无效，请指定 open、close、vent、tilt 或 stop', current)
  const state = updateVehicle(cockpitId, store, next => {
    next.vehicle.sunroof = nextValue
  })
  return changed(`天窗当前${sunroofStateText(state.vehicle.sunroof)}`, state)
}

function executeClosure(args, context) {
  const { cockpitId, snapshot, store } = context
  const action = clean(args.action)
  const target = clean(args.target)
  const current = snapshot()
  if (!['open', 'close'].includes(action)) return unchanged('开闭件动作无效，请指定 open 或 close', current)
  const field = {
    front_trunk: 'frontTrunk',
    rear_trunk: 'rearTrunk',
    trunk: 'rearTrunk',
    charge_port: 'chargePort',
    fuel_port: 'chargePort',
  }[target]
  if (!field) return unchanged('开闭件目标无效，请指定前备箱、后备箱或充电口', current)
  const state = updateVehicle(cockpitId, store, next => {
    next.vehicle[field] = action === 'open' ? 1 : 0
  })
  return changed(`已${action === 'open' ? '打开' : '关闭'}${PART_LABELS[target]}`, state)
}

function setSeats(vehicle, target, seats, value) {
  const field = {
    seat_heater: 'seatHeating',
    seat_cooler: 'seatCooling',
    auto_seat_climate: 'autoSeatClimate',
  }[target]
  for (const seat of seats) vehicle[field][seat] = value
}

function executeComfort(args, context) {
  const { cockpitId, snapshot, store } = context
  const target = clean(args.target)
  const action = clean(args.action)
  const current = snapshot()
  let seat = 'driver'
  let seats = ['driver']
  let value
  try {
    if (target.startsWith('seat_') || target === 'auto_seat_climate') {
      ;({ seat, seats } = seatParts(args.seat))
    }
    if (target === 'seat_heater' || target === 'seat_cooler') {
      if (action === 'open') value = 3
      else if (action === 'close') value = 0
      else if (action === 'set') value = integerInRange(args.level, { min: 0, max: 3 }, 'level')
      else throw new Error(`Unknown comfort action: ${action}`)
    } else if (target === 'auto_seat_climate' || target === 'auto_steering_wheel_heat') {
      if (action === 'open') value = 1
      else if (action === 'close') value = 0
      else if (action === 'set') value = args.enabled === false ? 0 : 1
      else throw new Error(`Unknown comfort action: ${action}`)
    } else if (target === 'steering_wheel_heater') {
      if (action === 'open') value = 1
      else if (action === 'close') value = 0
      else if (action === 'set') value = args.enabled === false || Number(args.level) === 0 ? 0 : 1
      else throw new Error(`Unknown comfort action: ${action}`)
    } else if (target === 'steering_wheel_heat_level') {
      if (action === 'open') value = 2
      else if (action === 'close') value = 0
      else if (action === 'set') value = integerInRange(args.level, { min: 0, max: 2 }, 'level')
      else throw new Error(`Unknown comfort action: ${action}`)
    } else {
      throw new Error(`Unknown comfort target: ${target}`)
    }
  } catch {
    return unchanged('舒适控制参数无效，请检查目标、座位和档位', current)
  }
  const state = updateVehicle(cockpitId, store, next => {
    if (target === 'seat_heater' || target === 'seat_cooler' || target === 'auto_seat_climate') {
      setSeats(next.vehicle, target, seats, value)
    } else if (target === 'steering_wheel_heater') {
      next.vehicle.steeringWheelHeater = value
      if (!value) next.vehicle.steeringWheelHeatLevel = 0
      else if (!next.vehicle.steeringWheelHeatLevel) next.vehicle.steeringWheelHeatLevel = 2
    } else if (target === 'steering_wheel_heat_level') {
      next.vehicle.steeringWheelHeatLevel = value
      next.vehicle.steeringWheelHeater = value > 0 ? 1 : 0
    } else if (target === 'auto_steering_wheel_heat') {
      next.vehicle.autoSteeringWheelHeat = value
    }
  })
  const subject = target.startsWith('seat_') || target === 'auto_seat_climate'
    ? `${PART_LABELS[seat]}${PART_LABELS[target]}`
    : PART_LABELS[target]
  return changed(`已设置${subject}`, state)
}

function executeLight(args, context) {
  const { cockpitId, snapshot, store } = context
  const action = clean(args.action)
  const current = snapshot()
  if (!['open', 'close', 'flash'].includes(action)) return unchanged('灯光动作无效，请指定 open、close 或 flash', current)
  const state = updateVehicle(cockpitId, store, next => {
    if (action === 'flash') next.vehicle.flashLightsCount = (next.vehicle.flashLightsCount || 0) + 1
    else next.vehicle.headlights = action === 'open' ? 1 : 0
  })
  if (action === 'flash') return changed('已闪灯', state)
  return changed(`已${action === 'open' ? '打开' : '关闭'}大灯`, state)
}

function executeSound(args, context) {
  const { cockpitId, snapshot, store } = context
  const action = clean(args.action)
  const current = snapshot()
  if (!['honk', 'boombox'].includes(action)) return unchanged('声音动作无效，请指定 honk 或 boombox', current)
  const state = updateVehicle(cockpitId, store, next => {
    next.vehicle.lastSoundAction = action
    if (action === 'honk') next.vehicle.hornCount = (next.vehicle.hornCount || 0) + 1
    else next.vehicle.boomboxSound = clean(args.soundId) || 'locate'
  })
  return changed(action === 'honk' ? '已鸣笛' : '已播放外部定位提示音', state)
}

function executeCharging(args, context) {
  const { cockpitId, snapshot, store, random } = context
  const action = clean(args.action)
  const current = snapshot()
  let value
  try {
    if (action === 'set_limit') value = integerInRange(args.limitPercent, CHARGE_LIMITS, 'limitPercent')
    else if (action === 'set_amps') value = integerInRange(args.amps, CHARGING_AMP_LIMITS, 'amps')
    else if (![
      'start',
      'stop',
      'standard',
      'max_range',
      'add_schedule',
      'remove_schedule',
      'set_scheduled',
    ].includes(action)) throw new Error(`Unknown charging action: ${action}`)
  } catch {
    return unchanged('充电参数无效，请检查充电上限、电流或计划参数', current)
  }
  const state = updateVehicle(cockpitId, store, next => {
    if (action === 'start') next.vehicle.charging = 1
    else if (action === 'stop') next.vehicle.charging = 0
    else if (action === 'set_limit') next.vehicle.chargeLimit = value
    else if (action === 'set_amps') next.vehicle.chargingAmps = value
    else if (action === 'standard') {
      next.vehicle.chargeMode = 'standard'
      next.vehicle.chargeLimit = Math.min(next.vehicle.chargeLimit, 80)
    } else if (action === 'max_range') {
      next.vehicle.chargeMode = 'max_range'
      next.vehicle.chargeLimit = 100
    } else if (action === 'add_schedule' || action === 'set_scheduled') {
      const schedule = args.schedule && typeof args.schedule === 'object' ? args.schedule : {}
      const id = clean(schedule.id) || `charge-${Math.floor((random?.() || Math.random()) * 1_000_000)}`
      next.vehicle.chargeSchedules = [
        ...next.vehicle.chargeSchedules.filter(item => item.id !== id),
        { enabled: true, ...schedule, id },
      ]
    } else if (action === 'remove_schedule') {
      const id = clean(args.scheduleId)
      next.vehicle.chargeSchedules = id
        ? next.vehicle.chargeSchedules.filter(item => item.id !== id)
        : []
    }
  })
  return changed(`已更新充电设置，${chargingText(state.vehicle)}`, state)
}

export function executeVehicleTool(name, args, context) {
  const { cockpitId, snapshot, store } = context
  if (name === 'vehicle_location_query') {
    const state = snapshot()
    const location = state.location
    const prefix = location.source === 'demo-default'
      ? '演示车辆当前定位为'
      : '车辆当前位于'
    return toolResult(`${prefix}${vehicleLocationText(location)}`, state, [], { location })
  }
  if (name === 'vehicle_state_query') {
    const state = context.snapshot()
    return toolResult(stateText(clean(args.part) || 'all', state.vehicle), state, [], {
      vehicle: state.vehicle,
    })
  }
  if (name === 'vehicle_climate_control') return executeClimate(args, context)
  if (name === 'vehicle_temperature_control') return executeTemperature(args, context)
  if (name === 'vehicle_window_control') return executeWindow(args, context)
  if (name === 'vehicle_sunroof_control') return executeSunroof(args, context)
  if (name === 'vehicle_closure_control') return executeClosure(args, context)
  if (name === 'vehicle_comfort_control') return executeComfort(args, context)
  if (name === 'vehicle_light_control') return executeLight(args, context)
  if (name === 'vehicle_sound_control') return executeSound(args, context)
  if (name === 'vehicle_charging_control') return executeCharging(args, context)
  throw new Error(`Unknown vehicle tool: ${name}`)
}
