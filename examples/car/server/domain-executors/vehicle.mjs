const WINDOW_PARTS = ['windowFL', 'windowFR', 'windowRL', 'windowRR']
const ALL_PARTS = [...WINDOW_PARTS, 'sunroof', 'headlights']

const PART_LABELS = {
  windowFL: '主驾车窗',
  windowFR: '副驾车窗',
  windowRL: '左后车窗',
  windowRR: '右后车窗',
  windows: '全部车窗',
  sunroof: '天窗',
  headlights: '大灯',
  ac: '空调',
  all: '全部可控部件',
}

function expandParts(part, action) {
  if (part === 'windows') return WINDOW_PARTS
  if (part === 'all' && (action === 'open' || action === 'close')) return ALL_PARTS
  return [part]
}

function vehicleStateText(part = 'all', context = {}) {
  const state = context.vehicleState || {}
  if (part === 'windows') part = 'all'

  if (part === 'all') {
    return Object.entries(PART_LABELS)
      .filter(([key]) => key !== 'windows' && key !== 'all')
      .map(([key, label]) => {
        if (key === 'ac') {
          return `${label}: ${state.ac ? '开启' : '关闭'}，模式 ${state.acMode === 'heat' ? '制热' : '制冷'}，温度 ${state.acTemp ?? 25}°C，风量 ${state.acFan ?? 3} 档`
        }
        return `${label}: ${state[key] ? '开启' : '关闭'}`
      })
      .join(', ')
  }

  if (part === 'ac') {
    return `空调当前状态: ${state.ac ? '开启' : '关闭'}，模式 ${state.acMode === 'heat' ? '制热' : '制冷'}，温度 ${state.acTemp ?? 25}°C，风量 ${state.acFan ?? 3} 档`
  }

  const label = PART_LABELS[part] || part
  return `${label}当前状态: ${state[part] ? '开启' : '关闭'}`
}

function buildVehicleAction(params) {
  if (params.part === 'ac') {
    if (params.action === 'set_temp') {
      const temp = params.temperature
      if (temp == null) return { result: '请指定目标温度' }
      if (temp < 16 || temp > 32) return { result: `温度超出范围，空调温度需在 16~32°C 之间，当前设置 ${temp}°C 无效` }
      return {
        result: `已将空调温度设置为 ${temp}°C`,
        action: { type: 'car_control', part: 'ac', state: 1, temperature: temp },
      }
    }
    if (params.action === 'set_mode') {
      const mode = params.mode
      if (!mode) return { result: '请指定空调模式（cool 或 heat）' }
      const modeLabel = mode === 'cool' ? '制冷' : '制热'
      return {
        result: `已将空调切换为${modeLabel}模式`,
        action: { type: 'car_control', part: 'ac', state: 1, mode },
      }
    }
    if (params.action === 'set_fan') {
      const fan = params.fan
      if (fan == null) return { result: '请指定风量档位' }
      if (fan < 1 || fan > 5) return { result: `风量超出范围，需在 1~5 档之间，当前设置 ${fan} 档无效` }
      return {
        result: `已将空调风量设置为 ${fan} 档`,
        action: { type: 'car_control', part: 'ac', state: 1, fan },
      }
    }
  }

  if (params.action !== 'open' && params.action !== 'close') {
    return { result: '未知车控操作' }
  }

  const label = PART_LABELS[params.part] || params.part
  const actionLabel = params.action === 'open' ? '打开' : '关闭'
  return {
    result: `已${actionLabel}${label}`,
    action: {
      type: 'car_control',
      part: params.part,
      state: params.action === 'open' ? 1 : 0,
    },
  }
}

async function executeVehicleControl(params, context) {
  const stateText = vehicleStateText(params.part, context)

  if (params.action === 'query') {
    return { result: stateText }
  }

  if ((params.action === 'set_temp' || params.action === 'set_mode' || params.action === 'set_fan') && params.part !== 'ac') {
    return { result: '温度、模式和风量只能用于空调控制' }
  }

  const parts = expandParts(params.part, params.action)
  const actions = []
  const results = []

  for (const part of parts) {
    const args = {
      part,
      action: params.action,
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
      ...(params.fan != null ? { fan: params.fan } : {}),
    }
    const result = buildVehicleAction(args)
    results.push(result.result)
    if (result.action) actions.push(result.action)
  }

  const target = PART_LABELS[params.part] || params.part
  return {
    result: `${target}处理完成：${results.join('；')}`,
    actions,
  }
}

export default {
  'vehicle.state_query': (params, context) => executeVehicleControl({ action: 'query', part: params?.part || 'all' }, context),
  'vehicle.window_control': (params, context) => executeVehicleControl({ action: params?.action, part: params?.window || 'windows' }, context),
  'vehicle.sunroof_control': (params, context) => executeVehicleControl({ action: params?.action, part: 'sunroof' }, context),
  'vehicle.headlights_control': (params, context) => executeVehicleControl({ action: params?.action, part: 'headlights' }, context),
  'vehicle.climate_control': (params, context) => executeVehicleControl({
    action: params?.action,
    part: 'ac',
    ...(params?.temperature != null ? { temperature: params.temperature } : {}),
    ...(params?.mode ? { mode: params.mode } : {}),
    ...(params?.fan != null ? { fan: params.fan } : {}),
  }, context),
}
