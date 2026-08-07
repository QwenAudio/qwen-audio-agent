const translations = {
  '待命': 'Standby',
  '正在听': 'Listening',
  '思考中': 'Thinking',
  '正在说': 'Speaking',
  '正在处理任务': 'Working on a task',
  '等待你的确认': 'Waiting for your confirmation',
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
  '正在理解': 'Understanding',
  '正在回复': 'Replying',
  '正在处理': 'Processing',
  '正在处理 · {seconds} 秒': 'Processing · {seconds}s',
  '项目正在执行': 'Project running',
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
  '退出': 'Quit',
  '正在提交': 'Submitting',
  '始终允许': 'Always allow',
  '拒绝': 'Deny',
  '你': 'You',
  '已打断': 'Interrupted',
  '打开 {label}': 'Open {label}',
  '选择前台语音引擎': 'Select voice frontend engine',
  '前台：默认（{label}）': 'Frontend: default ({label})',
  '前台：{label}': 'Frontend: {label}',
  '新会话': 'New session',
  '关闭语音': 'Disable voice',
  '取消等待': 'Cancel waiting',
  '开启语音': 'Enable voice',
  '语音交互': 'Voice interaction',
  '你说，我来调度。': 'You speak, I orchestrate.',
  '试着说': 'Try saying',
  '“帮我查一下今天的 AI 新闻，并整理成三点摘要。”': '"Look up today\'s AI news and summarize it in three points."',
  '处理失败': 'Failed',
  '连接已中断': 'Connection lost',
  '正在整理结果': 'Organizing results',
  '后台正在请求执行权限': 'Backend is requesting permission to proceed',
  '这项工作已停止': 'This task has stopped',
  '正在继续处理：{title}': 'Resuming: {title}',
  '正在等待项目任务完成': 'Waiting for project tasks to finish',
  '项目结果已返回，协调 Agent 正在整理': 'Project results returned, coordinator agent is organizing them',
  '正在等待后台确认停止': 'Waiting for backend to confirm cancellation',
  '结果已经返回，正在准备语音回复': 'Results returned, preparing voice reply',
  '结果已经发送': 'Results delivered',
  '正在等待与后台重新连接': 'Waiting to reconnect to backend',
  '正在连接后台 Agent': 'Connecting to backend agent',
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
  '无法初始化实时语音播放': 'Could not initialize realtime voice playback',
  '加载远程图片': 'Load remote image',
  '加载远程音频': 'Load remote audio',
  '加载远程视频': 'Load remote video',
  '打开链接': 'Open link',
}

function currentLanguage() {
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
