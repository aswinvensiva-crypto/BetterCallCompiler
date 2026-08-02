import { highlightSegments, rankFuzzy } from './fuzzy'

/**
 * The overlay behind both `Ctrl+P` (quick open) and `Ctrl+Shift+P` (the command
 * palette).
 *
 * One widget rather than two, because they are the same interaction — type,
 * filter, arrow, Enter — and duplicating it is how the two drift into behaving
 * subtly differently under the keyboard.
 */

export interface QuickPickItem {
  readonly id: string
  /** What the fuzzy matcher scores and what is highlighted. */
  readonly label: string
  /** Dimmed, to the right. Not matched against. */
  readonly detail?: string
  /** Shown at the far right, e.g. a keybinding. */
  readonly hint?: string
}

export interface QuickPickOptions<T extends QuickPickItem> {
  readonly placeholder: string
  readonly items: readonly T[]
  readonly onAccept: (item: T) => void
  /** Live preview as the highlight moves, e.g. quick open peeking a file. */
  readonly onHighlight?: (item: T) => void
}

let overlay: HTMLElement | null = null
let closeCurrent: (() => void) | null = null

export function isQuickPickOpen(): boolean {
  return overlay !== null
}

export function closeQuickPick(): void {
  closeCurrent?.()
}

export function openQuickPick<T extends QuickPickItem>(options: QuickPickOptions<T>): void {
  // Opening one picker over another would leave the first's key handler live.
  closeQuickPick()

  const root = document.createElement('div')
  root.className = 'quick-pick-overlay'

  const panel = document.createElement('div')
  panel.className = 'quick-pick'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', options.placeholder)

  const input = document.createElement('input')
  input.className = 'quick-pick__input'
  input.type = 'text'
  input.placeholder = options.placeholder
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-controls', 'quick-pick-list')
  panel.append(input)

  const list = document.createElement('ul')
  list.className = 'quick-pick__list'
  list.id = 'quick-pick-list'
  list.setAttribute('role', 'listbox')
  panel.append(list)

  root.append(panel)
  document.body.append(root)
  overlay = root

  let visible: Array<{ item: T; positions: readonly number[] }> = []
  let selected = 0

  const close = (): void => {
    document.removeEventListener('keydown', onKeyDown, true)
    root.remove()
    overlay = null
    closeCurrent = null
  }
  closeCurrent = close

  function renderList(): void {
    list.replaceChildren()

    if (visible.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'quick-pick__empty'
      empty.textContent = 'No matching results'
      list.append(empty)
      return
    }

    visible.forEach((entry, index) => {
      const row = document.createElement('li')
      row.className = `quick-pick__item${index === selected ? ' quick-pick__item--selected' : ''}`
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === selected))

      const label = document.createElement('span')
      label.className = 'quick-pick__label'
      // Built from text nodes, never innerHTML: these strings are file names
      // and command titles, and one of those comes off the user's disk.
      for (const segment of highlightSegments(entry.item.label, entry.positions)) {
        const span = document.createElement('span')
        if (segment.matched) span.className = 'quick-pick__hit'
        span.textContent = segment.text
        label.append(span)
      }
      row.append(label)

      if (entry.item.detail !== undefined && entry.item.detail !== '') {
        const detail = document.createElement('span')
        detail.className = 'quick-pick__detail'
        detail.textContent = entry.item.detail
        row.append(detail)
      }

      if (entry.item.hint !== undefined && entry.item.hint !== '') {
        const hint = document.createElement('span')
        hint.className = 'quick-pick__hint'
        hint.textContent = entry.item.hint
        row.append(hint)
      }

      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        accept(index)
      })
      list.append(row)
    })

    list.children[selected]?.scrollIntoView({ block: 'nearest' })
  }

  function refilter(): void {
    const query = input.value.trim()
    visible = rankFuzzy(query, options.items, (item) => item.label, 200).map((ranked) => ({
      item: ranked.item,
      positions: ranked.positions
    }))
    selected = 0
    renderList()
  }

  function move(delta: number): void {
    if (visible.length === 0) return
    selected = (selected + delta + visible.length) % visible.length
    renderList()
    const entry = visible[selected]
    if (entry !== undefined) options.onHighlight?.(entry.item)
  }

  function accept(index: number): void {
    const entry = visible[index]
    if (entry === undefined) return
    // Close first: the handler may open a file, and the picker must not be
    // sitting over the editor it just revealed.
    close()
    options.onAccept(entry.item)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      accept(selected)
    }
  }

  input.addEventListener('input', refilter)
  // Capture, so Escape and the arrows are ours before anything else sees them.
  document.addEventListener('keydown', onKeyDown, true)
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close()
  })

  refilter()
  input.focus()
}
