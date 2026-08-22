export const SENSITIVE_MEMORY = /(?:pass(?:word)?|secret|api[_ -]?key|access[_ -]?token|credential|验证码|密码|密钥|令牌|\bsk-[a-z0-9_-]+)/i

export function containsSensitiveMemory(value) {
  return SENSITIVE_MEMORY.test(String(value || ''))
}
