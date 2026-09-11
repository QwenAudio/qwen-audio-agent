import { defineConfig } from 'vitepress'

const repoUrl = 'https://github.com/QwenAudio/qwen-audio-agent'

// Source pairs remain page.md + page.zh.md; sync-docs-site generates the locale trees.
function editPattern({ relativePath }) {
  const source = relativePath.startsWith('zh/')
    ? relativePath.slice(3).replace(/\.md$/, '.zh.md')
    : relativePath
  return `https://github.com/QwenAudio/qwen-audio-agent/edit/main/docs/${source}`
}

function sidebar(prefix = '') {
  const t = (zh, en) => prefix ? zh : en
  const page = (zh, en, path) => ({ text: t(zh, en), link: `${prefix}/${path}` })
  return [
    {
      text: t('快速开始', 'Getting Started'), collapsed: false,
      items: [
        page('选择使用方式', 'Choose Your Setup', 'getting-started/quickstart'),
        page('安装与升级', 'Install & Update', 'getting-started/install'),
      ],
    },
    {
      text: t('客户端', 'Clients'), collapsed: true,
      items: [
        page('TUI 终端', 'TUI', 'getting-started/tui'),
        page('WebUI 浏览器', 'WebUI', 'getting-started/webui'),
        page('移动端', 'Mobile', 'getting-started/mobile'),
        page('桌面版', 'Desktop', 'desktop/overview'),
        page('桌宠皮肤', 'Pet Skins', 'desktop/pet-skin-spec'),
      ],
    },
    {
      text: t('功能指南', 'Features'), collapsed: true,
      items: [
        page('对话与附件', 'Conversation & Attachments', 'guides/conversation'),
        page('后台工作与授权', 'Work & Permissions', 'guides/tasks'),
        page('联网搜索', 'Web Search', 'guides/web-search'),
        page('资料库', 'Knowledge Library', 'guides/knowledge'),
        page('助手画像与偏好', 'Personalization', 'reference/personalization'),
        page('长期记忆', 'Memory', 'reference/memory'),
        page('后台 Skills', 'Backend Skills', 'guides/skills'),
        page('MCP 工具配置', 'MCP Tools', 'reference/frontend-mcp'),
        page('OpenAPI 工具配置', 'OpenAPI Tools', 'reference/frontend-openapi'),
      ],
    },
    {
      text: t('配置与运行', 'Configuration & Operation'), collapsed: true,
      items: [
        page('配置总览', 'Configuration Overview', 'configuration'),
        {
          text: t('语音前台', 'Voice Frontend'), link: `${prefix}/configuration/frontend`,
          collapsed: true,
          items: [
            page('Qwen Audio Realtime', 'Qwen Audio Realtime', 'voice-frontends/qwen-audio-realtime'),
            page('Qwen Omni Realtime', 'Qwen Omni Realtime', 'voice-frontends/qwen-omni-realtime'),
            page('Speech-to-Speech', 'Speech-to-Speech', 'voice-frontends/speech-to-speech'),
            page('MiniCPM-o', 'MiniCPM-o', 'voice-frontends/minicpm-o'),
          ],
        },
        {
          text: t('后台 Agent', 'Backend Agent'), link: `${prefix}/backends/overview`,
          collapsed: true,
          items: [
            page('通用设置', 'Common Settings', 'configuration/backend'),
            page('各后台详细配置', 'Backend-Specific Settings', 'backends/configuration'),
          ],
        },
        page('Gateway 运行与常驻', 'Run the Gateway', 'operations/gateway'),
        page('远程连接与配对', 'Remote Connections', 'operations/remote-access'),
        page('高级设置与日志', 'Advanced Settings & Logs', 'configuration/advanced'),
      ],
    },
    {
      text: t('故障排查', 'Troubleshooting'), collapsed: true,
      items: [page('连接、音频与诊断', 'Connections, Audio & Diagnostics', 'operations/troubleshooting')],
    },
    {
      text: t('开发者', 'Developers'), collapsed: true,
      items: [
        page('扩展总览', 'Extension Overview', 'extensions'),
        page('架构总览', 'Architecture Overview', 'architecture/overview'),
        page('详细架构', 'Architecture Deep Dive', 'architecture/deep-dive'),
        page('稳定性契约', 'Gateway Contract', 'contract'),
        page('客户端协议', 'Client Protocol', 'gateway-protocol'),
        page('桌面动画对接', 'Desktop Animations', 'reference/desktop-animations'),
        page('接入新后台', 'Add a Backend', 'backends/extend'),
        page('Backend Adapter SDK', 'Backend Adapter SDK', 'reference/backend-adapter-sdk'),
        page('A2A Adapter', 'A2A Adapter', 'reference/a2a-backend-adapter'),
        page('Realtime Provider', 'Realtime Provider', 'voice-frontends/custom-provider'),
        page('Memory Provider', 'Memory Provider', 'reference/memory-provider'),
        page('Knowledge Provider', 'Knowledge Provider', 'reference/knowledge'),
        page('前台 Profile', 'Frontend Profile', 'reference/frontend-profile'),
        page('偏好学习机制', 'Preference Learning', 'reference/preference-learning'),
        page('运行时评估', 'Runtime Evaluations', 'reference/frontend-evaluations'),
      ],
    },
    {
      text: t('示例与参考', 'Examples & Resources'), collapsed: true,
      items: [
        page('智能座舱', 'Smart Cockpit', 'scenarios/smart-cockpit'),
        page('AI Passport 语音客户端', 'AI Passport Voice Client', 'scenarios/ai-passport'),
        page('VoiceMem', 'VoiceMem', 'scenarios/voicemem'),
        page('LightRAG', 'LightRAG', 'scenarios/lightrag'),
        page('演示文稿', 'Presentations', 'resources/presentations'),
        page('规划记录', 'Planning Records', 'resources/planning'),
        page('参考论文', 'Papers', 'resources/papers'),
      ],
    },
  ]
}

function nav(prefix = '') {
  const t = (zh, en) => prefix ? zh : en
  return [
    { text: t('开始使用', 'Get Started'), link: `${prefix}/getting-started/quickstart` },
    {
      text: t('客户端', 'Clients'),
      items: [
        { text: 'TUI', link: `${prefix}/getting-started/tui` },
        { text: 'WebUI', link: `${prefix}/getting-started/webui` },
        { text: t('移动端', 'Mobile'), link: `${prefix}/getting-started/mobile` },
        { text: t('桌面版', 'Desktop'), link: `${prefix}/desktop/overview` },
      ],
    },
    { text: t('远程连接', 'Remote Access'), link: `${prefix}/operations/remote-access` },
    { text: t('开发者', 'Developers'), link: `${prefix}/extensions` },
    { text: t('下载', 'Downloads'), link: `${repoUrl}/releases/latest` },
  ]
}

export default defineConfig({
  title: 'Qwen Audio Agent',
  description: 'A realtime voice assistant connected to your own action-taking Agent.',
  base: process.env.DOCS_BASE || '/qwen-audio-agent/',
  cleanUrls: true,
  srcDir: '.vitepress/.site',
  themeConfig: {
    socialLinks: [{ icon: 'github', link: repoUrl }],
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详情',
                resetButtonTitle: '清除搜索',
                backButtonTitle: '返回',
                noResultsText: '没有找到相关内容',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
  },
  locales: {
    root: {
      label: 'English', lang: 'en',
      themeConfig: {
        nav: nav(), sidebar: sidebar(),
        editLink: { pattern: editPattern, text: 'Edit this page on GitHub' },
      },
    },
    zh: {
      label: '简体中文', lang: 'zh-CN', link: '/zh/',
      description: '一个可连接你自己的办事 Agent 的实时语音助手。',
      themeConfig: {
        nav: nav('/zh'), sidebar: sidebar('/zh'),
        editLink: { pattern: editPattern, text: '在 GitHub 上编辑此页' },
        outline: { label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        darkModeSwitchLabel: '深色模式',
        langMenuLabel: '切换语言',
        sidebarMenuLabel: '目录',
        returnToTopLabel: '回到顶部',
      },
    },
  },
})
