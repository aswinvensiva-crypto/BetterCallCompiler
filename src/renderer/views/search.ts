import type { SearchMatch } from '../../shared/types'
import { revealLocation } from '../editor/models'
import { notifyError } from '../workbench/notifications'

/**
 * Workspace text search.
 *
 * Results are grouped by file, the way every editor presents them, because a
 * flat list of 200 lines gives no sense of *where* the matches are. Clicking one
 * reveals it in Monaco through the same path the output console's error links
 * use.
 */

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null

let query = ''
let caseSensitive = false
let isRegex = false
let matches: SearchMatch[] = []
let searching = false
let ran = false
let error: string | null = null

let debounce: ReturnType<typeof setTimeout> | null = null

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/* --------------------------------- search -------------------------------- */

async function run(): Promise<void> {
  if (query.trim() === '') {
    matches = []
    ran = false
    error = null
    render()
    return
  }

  searching = true
  error = null
  render()

  const result = await window.betterCallCompiler.fs.search({ query, caseSensitive, isRegex })
  searching = false
  ran = true

  if (!result.ok) {
    matches = []
    // A half-typed regex is the normal state of a search box, so it is shown
    // in place rather than thrown as a toast.
    error = result.error.message
  } else {
    matches = result.value.matches
  }
  render()
}

function scheduleRun(): void {
  if (debounce !== null) clearTimeout(debounce)
  // Every keystroke walks the workspace; 250ms is the difference between a
  // search box and a fan.
  debounce = setTimeout(() => {
    debounce = null
    void run()
  }, 250)
}

/* -------------------------------- rendering ------------------------------ */

function toggle(label: string, title: string, active: boolean, onClick: () => void): HTMLElement {
  const button = el('button', `search-toggle${active ? ' search-toggle--active' : ''}`, label)
  button.type = 'button'
  button.title = title
  button.setAttribute('aria-pressed', String(active))
  button.addEventListener('click', onClick)
  return button
}

/** Splits the preview so the matched run can be marked without innerHTML. */
function previewNodes(match: SearchMatch): HTMLElement {
  const wrap = el('span', 'search-match__preview')
  const start = Math.max(0, match.column - 1)
  const end = start + match.matchLength

  // Long leading context pushes the match off the right edge; trim it.
  const lead = match.preview.slice(0, start)
  const trimmedLead = lead.length > 40 ? `…${lead.slice(-40)}` : lead

  wrap.append(document.createTextNode(trimmedLead))
  const hit = el('span', 'search-match__hit', match.preview.slice(start, end))
  wrap.append(hit)
  wrap.append(document.createTextNode(match.preview.slice(end)))
  return wrap
}

function render(): void {
  if (bodyHost === null || titleHost === null) return

  titleHost.replaceChildren(el('span', 'side-bar__heading', 'Search'))

  bodyHost.replaceChildren()

  const form = el('div', 'search-form')

  const input = el('input', 'settings-input search-input')
  input.type = 'text'
  input.placeholder = 'Search'
  input.value = query
  input.spellcheck = false
  input.addEventListener('input', () => {
    query = input.value
    scheduleRun()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (debounce !== null) clearTimeout(debounce)
      void run()
    }
  })
  form.append(input)

  const toggles = el('div', 'search-toggles')
  toggles.append(
    toggle('Aa', 'Match case', caseSensitive, () => {
      caseSensitive = !caseSensitive
      void run()
    }),
    toggle('.*', 'Use regular expression', isRegex, () => {
      isRegex = !isRegex
      void run()
    })
  )
  form.append(toggles)
  bodyHost.append(form)

  if (error !== null) {
    bodyHost.append(el('p', 'insights-notice', error))
    return
  }

  if (searching) {
    bodyHost.append(el('p', 'explorer__empty-text', 'Searching…'))
    return
  }

  if (!ran) {
    bodyHost.append(el('p', 'explorer__empty-text', 'Type to search across the workspace.'))
    return
  }

  if (matches.length === 0) {
    bodyHost.append(el('p', 'explorer__empty-text', 'No results.'))
    return
  }

  const summary = el(
    'div',
    'search-summary',
    `${matches.length} result${matches.length === 1 ? '' : 's'}`
  )
  bodyHost.append(summary)

  // Grouped by file, preserving the order search returned them in.
  const byFile = new Map<string, SearchMatch[]>()
  for (const match of matches) {
    const list = byFile.get(match.relativePath) ?? []
    list.push(match)
    byFile.set(match.relativePath, list)
  }

  for (const [relativePath, group] of byFile) {
    const section = el('div', 'search-file')

    const header = el('div', 'search-file__header')
    header.append(el('span', 'search-file__name', relativePath))
    header.append(el('span', 'scm-section__count', String(group.length)))
    header.title = relativePath
    section.append(header)

    for (const match of group) {
      const row = el('div', 'search-match')
      row.append(el('span', 'search-match__line', String(match.line)))
      row.append(previewNodes(match))
      row.addEventListener('click', () => {
        void revealLocation(
          {
            name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
            path: match.path,
            relativePath,
            kind: 'file'
          },
          match.line,
          match.column
        ).then((ok) => {
          if (!ok) notifyError(`Could not open ${relativePath}`)
        })
      })
      section.append(row)
    }

    bodyHost.append(section)
  }
}

/* --------------------------------- mount --------------------------------- */

export function mountSearch(title: HTMLElement, body: HTMLElement): void {
  titleHost = title
  bodyHost = body
  render()
}

export function onSearchShown(): void {
  render()
  // Focusing on show is what makes Ctrl+Shift+F feel like a search box rather
  // than a panel you then have to click into.
  window.setTimeout(() => {
    const input = bodyHost?.querySelector<HTMLInputElement>('.search-input')
    input?.focus()
    input?.select()
  }, 0)
}

/** Seeds the box from the editor selection, the way Ctrl+Shift+F should. */
export function setSearchQuery(next: string): void {
  query = next
  if (next.trim() !== '') void run()
  else render()
}
