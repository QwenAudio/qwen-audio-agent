import { t } from './i18n.js'

const decisions = [
  { value: 'task', label: '允许此任务', title: '允许此任务及后续操作，任务结束后失效' },
  { value: 'always', label: '始终允许', title: '本会话后续权限请求自动允许' },
  { value: 'reject', label: '拒绝', title: '拒绝当前操作' },
]

export default function PermissionActions({ authorization, onRespond }) {
  return <div className="permission-controls" aria-busy={Boolean(authorization.submitting)}>
    <div className="permission-actions" role="group" aria-label={t('权限决定')}>
      {decisions.map(({ value, label, title }) => <button
        key={value}
        type="button"
        className={`permission-${value}`}
        title={t(title)}
        aria-label={`${t(label)}：${t(title)}`}
        disabled={authorization.submitting}
        onClick={() => onRespond(value)}
      >{t(label)}</button>)}
    </div>
    {authorization.submitting && <small role="status">{t('正在提交')}</small>}
    {authorization.error && <small className="permission-error" role="alert">
      {authorization.error}
    </small>}
  </div>
}
