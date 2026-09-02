// 敏感内容闸门 —— 记忆写入侧的共同底线。
//
// 三条写入链路（抽取器、画像观察器、会话摘要）各自的 prompt 里都写了「绝不提取
// 密码/密钥/验证码」，但 prompt 是软约束。这里是它们背后的硬闸门。
//
// 之所以必须单一来源：这类规则一旦分散成多份副本，日后给其中一处补了新模式而
// 漏掉另一处，就是一个静默的泄漏口。宁可误伤一条候选，也不要把秘密攒进磁盘。
//
// 设计取向刻意保守：
//   · 误判（false positive）的代价是丢掉一条记忆，用户再说一次就好
//   · 漏判（false negative）的代价是秘密被持久化，且很难发现

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd)/i,
  /(?:密码|密钥|口令|验证码|令牌|证件号|身份证)/,
  /\bsk-[A-Za-z0-9]{8,}/,
  // 长数字串：银行卡、证件号、手机号拼接
  /\b\d{11,19}\b/,
  // base64 风格的长串：多半是被贴进来的凭据
  /[A-Za-z0-9+/]{40,}={0,2}/,
]

export function containsSensitiveContent(value) {
  const text = String(value || '')
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(text))
}

export { SENSITIVE_PATTERNS }
