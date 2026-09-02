const TrashIcon = () => (
  <svg className="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v9h-2V9Zm4 0h2v9h-2V9ZM7 9h2v10h8V9h2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Z" fill="currentColor" /></svg>
)

export default function MemoryTab({ items, loading, error, onDelete, onRefresh }) {
  return (
    <div className="memory-scroll">
      <div className="memory-toolbar">
        <span>与前台对话共用的长期记忆</span>
        <button className="collapse-link" onClick={onRefresh} disabled={loading}>
          {loading ? '同步中' : '刷新'}
        </button>
      </div>
      {error && <p className="settings-error" role="status">{error}</p>}
      <ul className="memory-list" aria-label="智能体记忆列表">
        {items.map(item => (
          <li key={item.id} className="memory-item">
            <span>
              <strong>{item.text}</strong>
              <span className="memory-meta">
                {item.scopeLabel}{item.section ? ` · ${item.section}` : ''}
              </span>
            </span>
            <button
              className="trash-btn"
              aria-label={`删除记忆：${item.text}`}
              onClick={() => onDelete(item)}
            >
              <TrashIcon />
            </button>
          </li>
        ))}
      </ul>
      {!loading && items.length === 0 && !error && (
        <div className="empty-state" style={{ display: 'block' }}>暂无智能体记忆</div>
      )}
    </div>
  )
}
