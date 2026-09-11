import { COCKPIT_AGENT_PROMPT } from '../../agent/executor.mjs'
import { CockpitService } from '../../service/cockpit-service.mjs'
import { CockpitStateStore } from '../../service/state-store.mjs'
import {
  COCKPIT_TOOL_DEFINITIONS,
  surfaceForCockpitTool,
} from '../../service/tools/registry.mjs'

export const BENCHMARK_DOMAINS = Object.freeze([
  'vehicle',
  'music',
  'navigation',
  'weather',
])

const PLACES = new Map([
  ['西湖', '120.151,30.254'],
  ['灵隐寺', '120.102,30.241'],
  ['杭州东站', '120.212,30.291'],
  ['黄龙体育中心', '120.137,30.272'],
  ['城西银泰', '120.092,30.307'],
  ['萧山机场', '120.432,30.236'],
  ['机场', '120.432,30.236'],
  ['西溪湿地', '120.064,30.266'],
  ['滨江家', '120.205,30.188'],
  ['滨江公司', '120.215,30.211'],
  ['龙湖滨江天街', '120.210,30.208'],
  ['阿里西溪园区', '120.030,30.286'],
])

const WEATHER = Object.freeze({
  '杭州': Object.freeze({ city: '杭州市', dayweather: '多云', daytemp: '28', nighttemp: '21', daywind: '东', daypower: '3' }),
  '杭州市': Object.freeze({ city: '杭州市', dayweather: '多云', daytemp: '28', nighttemp: '21', daywind: '东', daypower: '3' }),
  '上海': Object.freeze({ city: '上海市', dayweather: '小雨', daytemp: '25', nighttemp: '20', daywind: '东南', daypower: '4' }),
  '上海市': Object.freeze({ city: '上海市', dayweather: '小雨', daytemp: '25', nighttemp: '20', daywind: '东南', daypower: '4' }),
  '北京': Object.freeze({ city: '北京市', dayweather: '晴', daytemp: '8', nighttemp: '1', daywind: '北', daypower: '3' }),
  '北京市': Object.freeze({ city: '北京市', dayweather: '晴', daytemp: '8', nighttemp: '1', daywind: '北', daypower: '3' }),
  '深圳': Object.freeze({ city: '深圳市', dayweather: '阵雨', daytemp: '31', nighttemp: '26', daywind: '南', daypower: '3' }),
  '深圳市': Object.freeze({ city: '深圳市', dayweather: '阵雨', daytemp: '31', nighttemp: '26', daywind: '南', daypower: '3' }),
})

export const MAX_MODEL_ROUNDS_PER_TURN = 8

export function parseRunnerArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (!raw.startsWith('--')) continue
    const key = raw.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args.set(key, true)
      continue
    }
    args.set(key, next)
    index += 1
  }
  return args
}

export function numberArg(args, key, fallback) {
  const value = Number(args.get(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function openAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.title || tool.name,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }
}

export function parseToolArguments(call) {
  try {
    return JSON.parse(call?.function?.arguments || '{}')
  } catch {
    return {}
  }
}

export function createBenchmarkService() {
  let timestamp = 1_700_000_000_000
  return new CockpitService({
    store: new CockpitStateStore({ now: () => timestamp++ }),
    now: () => timestamp++,
    random: () => 0.42,
    services: {
      async vehicleLocation() {
        return {
          name: 'benchmark origin',
          city: '杭州市',
          district: '西湖区',
          address: '文三路',
          lng: 120.120,
          lat: 30.270,
        }
      },
      async resolvePlace(name) {
        return PLACES.get(name)
          || `120.${Math.max(100, String(name).length * 17)},30.${Math.max(100, String(name).length * 13)}`
      },
      async searchPlaces(query) {
        return [{ name: `${query}1号店`, location: '120.188,30.266' }]
      },
      async searchNearbyPlaces({ keywords }) {
        return [{ name: `${keywords}1号店`, location: '120.188,30.266', distance: 700 }]
      },
      async drivingRoute(origin, destination, strategy) {
        return {
          origin,
          destination,
          strategy,
          distance: 12_000,
          duration: 1_200,
          polyline: `${origin};${destination}`,
          trafficSegments: [],
        }
      },
      async weather(city) {
        const key = String(city || '杭州').trim()
        return structuredClone(WEATHER[key] || {
          city: key.endsWith('市') ? key : `${key}市`,
          dayweather: '多云',
          daytemp: '26',
          nighttemp: '19',
          daywind: '东',
          daypower: '3',
        })
      },
    },
  })
}

export function benchmarkTools({
  domains = BENCHMARK_DOMAINS,
} = {}) {
  const prefixes = new Set(domains.map(domain => `${domain}_`))
  const includeWeather = domains.includes('weather')
  return COCKPIT_TOOL_DEFINITIONS
    .filter(tool => (
      [...prefixes].some(prefix => tool.name.startsWith(prefix))
      || (includeWeather && tool.name === 'weather')
    ))
    .map(openAiTool)
}

export function navigationTools() {
  return benchmarkTools({ domains: ['navigation'] })
}

export function cockpitBenchmarkPrompt({
  domains = BENCHMARK_DOMAINS,
} = {}) {
  const labels = {
    vehicle: '车控',
    music: '音乐',
    navigation: '导航',
    weather: '天气',
  }
  const domainText = domains.map(domain => labels[domain] || domain).join('、')
  return `${COCKPIT_AGENT_PROMPT}

当前评测只关注${domainText}领域。普通闲聊、背景讨论、情绪表达、玩笑或没有可执行意图的感叹不要触发工具；等用户给出明确车控、音乐、导航或天气意图时再调用对应工具。跨领域干扰时只执行用户当前明确要求的领域。`
}

export function navigationBenchmarkPrompt() {
  return cockpitBenchmarkPrompt({ domains: ['navigation'] })
}

export async function setupBenchmarkCase(caseItem, { service, cockpitId }) {
  for (const call of caseItem.setup_calls || []) {
    await service.execute(call.name, call.arguments || {}, { cockpitId })
  }
}

export async function executeBenchmarkTool({
  service,
  cockpitId,
  calls,
  turnIndex,
  name,
  args,
}) {
  const path = surfaceForCockpitTool(name) || 'backend'
  calls.push({
    turn_index: turnIndex,
    path,
    name,
    arguments: args,
  })
  return service.execute(name, args, { cockpitId })
}
