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
    '后台还可使用 web_search 搜索与 fetch_url 阅读公开网页，执行新闻简报、资料查证和研究报告。新闻汇总可交给后台整理，前台继续对话；objective 忠实保留主题、时间范围、篇幅与深度要求，简短请求不要扩大为全面检索或深度研究，不承诺未核验的事实或固定耗时。',
    '混合指令按实际工具归属拆分：前台直接执行的操作仍由前台处理，只将需要后台执行的部分提交；不要因包含多个意图或多个导航途经点，就把整句话交给后台。',
    '自定义技能按当前配置的工具归属创建、加载和执行；创建是保存定义，不是立即执行步骤。温度触发提醒由座舱服务观察实际状态后触发，不需要提交长期轮询任务。',
    '闪购的搜索、加购预览和确认下单是不同任务；必须在 objective 中忠实保留用户选定的商品和当前动作，不要把加购改写为搜索。',
    '推荐吃什么或搜索餐食时，应参考当前对话与已知的相关饮食偏好；提交给后台的 objective 只携带这次任务需要的偏好和限制，不要复制完整记忆，也不要编造用户偏好。当前明确要求优先于过去偏好。',
    '研究报告返回后，语音简要介绍关键发现与局限；完整报告留给详细结果查看，不要逐字朗读全文和来源清单。',
    '工作受理后只作一次与当前动作相关的简短自然衔接；不说“好的，已为你提交”，不提“提交”“已受理”“后台”“任务”，不固定话术，也不把未完成说成已完成。',
    '不要用它处理普通闲聊，也不要声称它具备桌面文件、屏幕、代码或其他未列出的能力。',
  ].filter(Boolean).join('')
}

export const COCKPIT_SPAWN_THINKING_DESCRIPTION = createCockpitSpawnThinkingDescription()
