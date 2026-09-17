// Small searchable chooser; it knows nothing about provider configuration or
// process lifecycle. Choice status is supplied by its caller, not inferred.
export function createSettingsPicker(root, { onSelect, translate = text => text }) {
  const document = root.ownerDocument
  const make = (tag, className) => {
    const node = document.createElement(tag)
    node.className = className
    return node
  }
  const trigger = make('button', 'settings-picker-trigger')
  trigger.id = `${root.id}-trigger`
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'dialog')
  const selection = make('span', 'settings-picker-selection')
  const name = make('span', 'settings-picker-name')
  const status = make('span', 'settings-picker-status')
  selection.append(name, status)
  const chevron = make('span', 'settings-picker-chevron')
  chevron.setAttribute('aria-hidden', 'true')
  trigger.append(selection, chevron)
  const popover = make('div', 'settings-picker-popover')
  popover.id = `${root.id}-popover`
  popover.setAttribute('role', 'dialog')
  trigger.setAttribute('aria-controls', popover.id)
  const searchWrap = make('div', 'settings-search-wrap')
  const search = make('input', 'settings-picker-search')
  search.type = 'search'
  search.autocomplete = 'off'
  search.spellcheck = false
  searchWrap.append(search)
  const list = make('div', 'settings-picker-list')
  list.setAttribute('role', 'listbox')
  const empty = make('p', 'settings-picker-empty')
  popover.append(searchWrap, list, empty)
  root.replaceChildren(trigger, popover)
  let choices = []
  let selected = ''
  let label = ''

  function setOpen(open, { focus = false } = {}) {
    popover.hidden = !open
    trigger.setAttribute('aria-expanded', String(open))
    if (open) {
      search.value = ''
      renderOptions()
    }
    if (focus) (open ? search : trigger).focus()
  }

  function renderOptions() {
    const query = search.value.trim().toLocaleLowerCase()
    const visible = choices.filter(choice =>
      `${choice.label} ${choice.value} ${choice.keywords || ''}`.toLocaleLowerCase().includes(query))
    list.replaceChildren(...visible.map(choice => {
      const row = make('button', 'settings-picker-option')
      row.type = 'button'
      row.dataset.value = choice.value
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(choice.value === selected))
      const title = make('span', 'settings-picker-name')
      title.textContent = choice.label
      const state = make('span', 'settings-picker-status')
      state.textContent = choice.status || ''
      row.append(title, state)
      row.addEventListener('click', () => {
        setOpen(false, { focus: true })
        onSelect(choice.value)
      })
      return row
    }))
    empty.hidden = visible.length > 0
  }

  trigger.addEventListener('click', () => setOpen(popover.hidden, { focus: true }))
  search.addEventListener('input', renderOptions)
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popover.hidden) {
      event.preventDefault()
      setOpen(false, { focus: true })
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      if (popover.hidden) setOpen(true)
      const rows = [...list.children]
      const current = rows.indexOf(document.activeElement)
      const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      rows[next]?.focus()
    }
  })
  document.addEventListener('pointerdown', event => {
    if (!root.contains(event.target)) setOpen(false)
  })
  root.addEventListener('focusout', event => {
    if (!root.contains(event.relatedTarget)) setOpen(false)
  })
  // Enter in the search box must choose a result, never submit settings.
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      list.firstElementChild?.click()
    }
  })
  setOpen(false)

  return {
    render({ options, value, title }) {
      choices = options
      selected = value
      label = title
      const choice = choices.find(choice => choice.value === value)
      name.textContent = choice?.label || value
      status.textContent = choice?.status || ''
      trigger.setAttribute('aria-label', `${label}: ${name.textContent}`)
      popover.setAttribute('aria-label', label)
      list.setAttribute('aria-label', label)
      search.placeholder = translate('搜索语音前台')
      search.setAttribute('aria-label', search.placeholder)
      empty.textContent = translate('没有匹配的服务')
      renderOptions()
    },
  }
}
