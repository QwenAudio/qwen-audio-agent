import { t } from './i18n.js'

export function resultLabel(message) {
  const title = String(message?.title || '').trim()
  return title || t('执行结果')
}
