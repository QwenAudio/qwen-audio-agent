import { clean, toolResult } from '../shared.mjs'
import { vehicleLocationText } from '../../vehicle-location.mjs'

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

function stateText(part = 'all', vehicle) {
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
    const state = snapshot()
    return toolResult(stateText(args.part, state.vehicle), state, [], {
      vehicle: state.vehicle,
    })
  }

  if (name === 'vehicle_climate_control') {
    const action = clean(args.action)
    const current = snapshot()
    if (action === 'set_temp') {
      const temperature = Number(args.temperature)
      if (!Number.isFinite(temperature) || temperature < 16 || temperature > 32) {
        return toolResult('温度超出范围，空调温度需在 16~32°C 之间', current, [])
      }
    }
    if (action === 'set_fan') {
      const fan = Number(args.fan)
      if (!Number.isInteger(fan) || fan < 1 || fan > 5) {
        return toolResult('风量超出范围，需在 1~5 档之间', current, [])
      }
    }
    if (action === 'set_mode' && !['cool', 'heat'].includes(args.mode)) {
      return toolResult('请指定空调模式（cool 或 heat）', current, [])
    }
    const state = store.update(cockpitId, ['vehicle'], next => {
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
    return toolResult(stateText('ac', state.vehicle), state, ['vehicle'], {
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
  const state = store.update(cockpitId, ['vehicle'], next => {
    for (const part of parts) next.vehicle[part] = stateValue
  })
  const target = name === 'vehicle_window_control'
    ? PART_LABELS[args.window || 'windows']
    : PART_LABELS[parts[0]]
  return toolResult(`已${action === 'open' ? '打开' : '关闭'}${target}`, state, ['vehicle'], {
    vehicle: state.vehicle,
  })
}
