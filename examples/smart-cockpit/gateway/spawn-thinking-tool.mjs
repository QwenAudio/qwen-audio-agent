import { COCKPIT_SURFACE_ROUTING } from '../service/tools/registry.mjs'

const DOMAIN_LABELS = Object.freeze({
  vehicle: '车控',
  music: '音乐',
  navigation: '导航',
  weather: '天气',
  flashbuy: '闪购',
  'custom-skills': '自定义座舱技能',
})

function domainLabels(routing, surface) {
  return Object.entries(routing.domains)
    .filter(([, value]) => value === surface)
    .map(([domain]) => DOMAIN_LABELS[domain] || domain)
}

export function createCockpitSpawnThinkingDescription({
  routing = COCKPIT_SURFACE_ROUTING,
} = {}) {
  const backendDomains = domainLabels(routing, 'backend')
  const frontendDomains = domainLabels(routing, 'frontend')
  return [
    '将需要座舱 Agent 执行的任务异步提交到后台。',
    backendDomains.length
      ? `当前配置为后台执行的领域：${backendDomains.join('、')}。这些领域的用户明确指令应提交给后台。`
      : '当前没有配置为后台执行的座舱领域，通常不要使用本工具处理单次座舱指令。',
    frontendDomains.length
      ? `当前配置为前台执行的领域：${frontendDomains.join('、')}。这些领域由前台工具直接执行，不要提交到后台。`
      : '',
    '复杂、多步骤、跨领域或包含多个地点的座舱指令，如果涉及任何后台领域，也应提交给后台，不要由前台自行判断不支持。',
    '用户要求创建、更新或运行自定义座舱技能时，如果自定义座舱技能配置为后台执行，应提交给后台；objective 必须保留技能名称、触发语义和完整步骤。',
    '闪购的搜索、加购预览和确认下单是不同任务；必须在 objective 中忠实保留用户选定的商品和当前动作，不要把加购改写为搜索。',
    '工作受理后只作一次与当前动作相关的简短自然衔接；不说“好的，已为你提交”，不提“提交”“已受理”“后台”“任务”，不固定话术，也不把未完成说成已完成。',
    '不要用它处理普通闲聊，也不要声称它具备桌面文件、屏幕、代码或其他未列出的能力。',
  ].filter(Boolean).join('')
}

export const COCKPIT_SPAWN_THINKING_DESCRIPTION = createCockpitSpawnThinkingDescription()
