const translations = {
  '待命': 'Standby',
  '正在听': 'Listening',
  '正在说': 'Speaking',
  '正在处理任务': 'Working on a task',
  '等待你的确认': 'Waiting for your confirmation',
  '正在启动': 'Starting',
  '正在连接语音前台': 'Connecting voice frontend',
  '其他入口正在使用': 'In use by another client',
  '已隐藏': 'Hidden',
  '正在显示': 'Showing',
  '桌面端': 'Desktop',
  '终端': 'Terminal',
  '其他入口': 'another client',
  '正在检查后台 Agent': 'Checking backend agent',
  '请求失败（{status}）': 'Request failed ({status})',
  '没有提交成功：{message}': 'Submission failed: {message}',
  'Gateway 已连接': 'Gateway connected',
  '能力服务尚未连接': 'Backend service not connected',
  'qwen-audio-agent Gateway 尚未连接': 'qwen-audio-agent Gateway not connected',
  '正在听你说': 'Listening',
  'qwen-audio-agent Gateway 已断开，正在重连': 'qwen-audio-agent Gateway disconnected, reconnecting',
  '网关重连后未找到这次后台执行，请重新提交。': 'This background task was not found after the gateway reconnected. Please submit it again.',
  '{holder}正在使用语音': '{holder} is using voice',
  '正在接入语音': 'Connecting voice',
  '正在回复': 'Replying',
  '正在处理': 'Processing',
  '排队中': 'Queued',
  '进行中': 'In progress',
  '正在处理 · {seconds} 秒': 'Processing · {seconds}s',
  '正在整理项目结果': 'Finalizing project results',
  '正在取消': 'Cancelling',
  '正在继续处理': 'Resuming',
  '正在准备回复': 'Preparing reply',
  '处理完成': 'Completed',
  '后台失败：{error}': 'Background task failed: {error}',
  '已取消': 'Cancelled',
  '已创建新会话': 'New session created',
  '等待{holder}释放语音': 'Waiting for {holder} to release voice',
  '正在显示悬浮球': 'Showing the orb',
  '连接异常': 'Connection error',
  '语音控制': 'Voice controls',
  '麦克风静音': 'Mute microphone',
  '取消等待语音': 'Cancel waiting for voice',
  '开启麦克风': 'Enable microphone',
  '设置': 'Settings',
  '打开对话': 'Open conversation',
  '收起': 'Collapse',
  '收起为悬浮球': 'Collapse to orb',
  '退出': 'Quit',
  '后台任务': 'Background tasks',
  '折叠后台任务': 'Collapse background tasks',
  '展开后台任务': 'Expand background tasks',
  '正在提交': 'Submitting',
  '本次允许': 'Allow once',
  '本会话始终允许': 'Always allow in this session',
  '拒绝': 'Deny',
  '你': 'You',
  '已打断': 'Interrupted',
  '来源': 'Sources',
  '打开 {label}': 'Open {label}',
  '选择前台语音引擎': 'Select voice frontend engine',
  '前台：默认（{label}）': 'Frontend: default ({label})',
  '前台：{label}': 'Frontend: {label}',
  '模型支持：{modes}': 'Model supports: {modes}',
  'Web 传输：{modes}': 'Web transport: {modes}',
  '模型信息不可用': 'Model information unavailable',
  '模型能力信息不可用': 'Model capability information unavailable',
  '已恢复为服务器默认前台': 'Restored the server default frontend',
  '文字': 'text',
  '语音': 'audio',
  '图片': 'image',
  '视频': 'video',
  '画面观察': 'visual observation',
  '原生视频': 'native video',
  '新会话': 'New session',
  '资料库': 'Library',
  '把本机的手册、规章、教材交给助手': 'Hand local manuals, policies and textbooks to the assistant',
  '粘贴本机文件路径，例如 /Users/me/手册.md': 'Paste a local file path, e.g. /Users/me/manual.md',
  '加入资料库': 'Add to library',
  '支持 Markdown、txt 等文本；PDF、Word 会先交给后台提取文字。': 'Text files such as Markdown and txt are read directly; PDF and Word are handed to the backend to extract their text first.',
  '还没有资料。加进来之后，助手就知道该去查哪一份。': 'No documents yet. Once added, the assistant knows which one to consult.',
  '资料库功能未开启。': 'The document library is not enabled.',
  '读不到资料列表': 'Cannot read the document list',
  '正在提取文字…': 'Extracting text…',
  '正在后台提取文字，完成后会自动收进资料库': 'Extracting text in the background; it will be added to the library automatically',
  '已收进资料库：{name}': 'Added to the library: {name}',
  '已移除：{name}': 'Removed: {name}',
  '“{name}” 已提取并收进资料库': '“{name}” was extracted and added to the library',
  '“{name}” 提取失败': 'Could not extract “{name}”',
  '导入失败（{status}）': 'Import failed ({status})',
  '导入失败，请稍后再试': 'Import failed, please try again later',
  '移除失败，请稍后再试': 'Could not remove it, please try again later',
  '待摘要': 'summary pending',
  '移除': 'Remove',
  '关闭语音': 'Disable voice',
  '取消等待': 'Cancel waiting',
  '开启语音': 'Enable voice',
  '语音交互': 'Voice interaction',
  '你说，我来调度。': 'You speak, I orchestrate.',
  '试着说': 'Try saying',
  '“帮我查一下今天的 AI 新闻，并整理成三点摘要。”': '"Look up today\'s AI news and summarize it in three points."',
  '输入文字，或粘贴、拖入图片和文件': 'Type a message, or paste and drop images and files',
  '输入文字或图片': 'Type text or add an image',
  '添加图片或文件': 'Add images or files',
  '移除附件': 'Remove attachment',
  '发送': 'Send',
  'Gateway 尚未连接': 'Gateway is not connected yet',
  '无法读取文件': 'Unable to read file',
  '文件 {name} 超过 8 MB 限制': 'File {name} exceeds the 8 MB limit',
  '处理失败': 'Failed',
  '连接已中断': 'Connection lost',
  '正在整理结果': 'Organizing results',
  '后台正在请求执行权限': 'Backend is requesting permission to proceed',
  '这项工作已停止': 'This task has stopped',
  '项目结果已返回，协调 Agent 正在整理': 'Project results returned, coordinator agent is organizing them',
  '正在等待后台确认停止': 'Waiting for backend to confirm cancellation',
  '结果已经返回，正在准备语音回复': 'Results returned, preparing voice reply',
  '结果已经发送': 'Results delivered',
  '正在等待与后台重新连接': 'Waiting to reconnect to backend',
  '正在连接后台 Agent': 'Connecting to backend agent',
  '当前模式：{mode}': 'Current mode: {mode}',
  '会话：{title}': 'Session: {title}',
  '未知': 'Unknown',
  '正在生成图片': 'Generating image',
  '正在查询相关信息': 'Searching for information',
  '正在读取相关内容': 'Reading content',
  '正在修改内容': 'Editing content',
  '一个处理步骤已完成，正在继续': 'A step completed, continuing',
  '正在执行任务': 'Running a task',
  '执行结果': 'Result',
  '当前浏览器不支持实时语音播放': 'This browser does not support realtime voice playback',
  '语音播放没有成功启用，请再点一次开启语音': 'Voice playback failed to start. Click "Enable voice" again.',
  '语音播放失败': 'Voice playback failed',
  '语音播放尚未启用': 'Voice playback is not enabled yet',
  '语音前台连接异常，正在重试': 'Voice frontend connection error, retrying',
  '实时语音连接中断，正在重连': 'Realtime voice connection lost, reconnecting',
  '无法打开麦克风': 'Could not open the microphone',
  '正在切换麦克风': 'Switching microphone',
  '未检测到可用麦克风，连接设备后会自动恢复': 'No microphone detected. Input will recover automatically when a device is connected.',
  '无法初始化实时语音播放': 'Could not initialize realtime voice playback',
  '加载远程图片': 'Load remote image',
  '加载远程音频': 'Load remote audio',
  '加载远程视频': 'Load remote video',
  '打开链接': 'Open link',
}

let runtimeLanguage = ''

export function setRuntimeLanguage(language = '') {
  runtimeLanguage = String(language || '').trim()
  if (typeof document !== 'undefined' && runtimeLanguage) {
    document.documentElement.lang = isChinese(runtimeLanguage) ? 'zh-CN' : 'en'
  }
}

function currentLanguage() {
  if (runtimeLanguage) return runtimeLanguage
  try {
    const requested = new URLSearchParams(globalThis.location?.search || '').get('lang')
    if (requested) return requested
  } catch {
    // Ignore malformed or unavailable locations.
  }
  try {
    const stored = globalThis.localStorage?.getItem('qwen-audio-lang')
    if (stored) return stored
  } catch {
    // localStorage can throw in privacy modes; fall through to navigator
  }
  return globalThis.navigator?.language || 'zh-CN'
}

function isChinese(language) {
  return /^zh(-|$)/i.test(language)
}

export function t(zh, params) {
  const text = isChinese(currentLanguage()) ? zh : (translations[zh] ?? zh)
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, key) => (
    key in params ? String(params[key]) : match
  ))
}

if (typeof document !== 'undefined' && !isChinese(currentLanguage())) {
  document.documentElement.lang = 'en'
}
