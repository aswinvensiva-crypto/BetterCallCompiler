import {
  buildSnippet,
  computeMetrics,
  detectConcepts,
  explain,
  findIssues,
  type AssistMode,
  type AssistSelection
} from '../editor/assist-analysis'
import { ASSIST_ACTION_EVENT, type AssistActionDetail } from '../editor/assist-popup'
import { notify, notifyError } from '../workbench/notifications'
import { emptyState } from '../workbench/side-bar'

/**
 * The Assist panel.
 *
 * Holds the last result so there is a reviewable record after the floating
 * popup has gone — the popup triggers, this remembers. Everything shown here is
 * computed locally and synchronously; there is no loading state because there
 * is nothing to wait for.
 */

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null
let mode: AssistMode = 'learn'
let selection: AssistSelection | null = null
let repository: { owner: string; repo: string } | null = null
let branch: string | null = null

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

const MODE_LABELS: Readonly<Record<AssistMode, string>> = {
  learn: 'Learn',
  debug: 'Debug',
  explain: 'Explain',
  snippet: 'Snippet'
}

/* ------------------------------ renderers -------------------------------- */

function renderLearn(current: AssistSelection): HTMLElement {
  const wrap = el('div', 'assist-result')
  const concepts = detectConcepts(current)

  if (concepts.length === 0) {
    wrap.append(
      el(
        'p',
        'explorer__empty-text',
        'No tracked language constructs in this selection. The glossary covers JavaScript, TypeScript, Python, C and C++.'
      )
    )
    return wrap
  }

  for (const concept of concepts) {
    const card = el('div', 'assist-card')
    card.append(el('h3', 'assist-card__title', concept.title))
    card.append(el('p', 'assist-card__summary', concept.summary))
    const gotcha = el('p', 'assist-card__gotcha')
    gotcha.append(el('strong', 'assist-card__gotcha-label', 'Gotcha: '))
    gotcha.append(document.createTextNode(concept.gotcha))
    card.append(gotcha)
    wrap.append(card)
  }
  return wrap
}

function renderDebug(current: AssistSelection): HTMLElement {
  const wrap = el('div', 'assist-result')
  const metrics = computeMetrics(current.text)
  const findings = findIssues(current)

  const grid = el('div', 'assist-metrics')
  const stat = (label: string, value: string, warn = false): void => {
    const cell = el('div', `assist-metric${warn ? ' assist-metric--warn' : ''}`)
    cell.append(el('span', 'assist-metric__value', value))
    cell.append(el('span', 'assist-metric__label', label))
    grid.append(cell)
  }
  stat('lines', String(metrics.sloc))
  stat('nesting', String(metrics.maxNesting), metrics.maxNesting > 4)
  stat('complexity', String(metrics.complexity), metrics.complexity > 10)
  wrap.append(grid)

  if (findings.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No static findings in this selection.'))
    return wrap
  }

  for (const finding of findings) {
    const row = el('div', `assist-finding assist-finding--${finding.severity}`)
    row.append(el('span', 'assist-finding__line', `L${finding.line}`))
    row.append(el('span', 'assist-finding__message', finding.message))
    wrap.append(row)
  }

  // v1 is static only; saying so beats letting someone assume it ran the code.
  wrap.append(
    el('p', 'assist-footnote', 'Static analysis only — this selection was not executed.')
  )
  return wrap
}

function renderExplain(current: AssistSelection): HTMLElement {
  const wrap = el('div', 'assist-result')
  const result = explain(current)

  const list = (label: string, items: readonly string[], empty: string): void => {
    const block = el('div', 'assist-block')
    block.append(el('h3', 'assist-card__title', label))
    if (items.length === 0) {
      block.append(el('p', 'explorer__empty-text', empty))
    } else {
      const chips = el('div', 'assist-chips')
      for (const item of items) chips.append(el('span', 'assist-chip', item))
      block.append(chips)
    }
    wrap.append(block)
  }

  list('Declares', result.declares, 'Declares nothing — this is a statement, not a definition.')
  list('Depends on', result.dependsOn, 'No external symbols; this selection is self-contained.')

  if (result.readingOrder.length > 1) {
    const block = el('div', 'assist-block')
    block.append(el('h3', 'assist-card__title', 'Reading order'))
    const ordered = el('ol', 'assist-order')
    for (const name of result.readingOrder) ordered.append(el('li', 'assist-order__item', name))
    block.append(ordered)
    wrap.append(block)
  }
  return wrap
}

function renderSnippet(current: AssistSelection): HTMLElement {
  const wrap = el('div', 'assist-result')
  const snippet = buildSnippet(current, { repository, branch })

  const pre = el('pre', 'assist-snippet')
  pre.append(el('code', undefined, snippet.markdown))
  wrap.append(pre)

  const actions = el('div', 'assist-actions')

  const copyMarkdown = el('button', 'button button--primary', 'Copy markdown')
  copyMarkdown.type = 'button'
  copyMarkdown.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(snippet.markdown)
      .then(() => notify('Markdown copied.'))
      .catch(() => notifyError('Could not copy to the clipboard.'))
  })
  actions.append(copyMarkdown)

  if (snippet.permalink !== null) {
    const copyLink = el('button', 'button', 'Copy blob URL')
    copyLink.type = 'button'
    copyLink.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(snippet.permalink ?? '')
        .then(() => notify('Permalink copied.'))
        .catch(() => notifyError('Could not copy to the clipboard.'))
    })
    actions.append(copyLink)
  }
  wrap.append(actions)

  if (snippet.permalink === null) {
    // Never fabricate a URL: an unresolvable link is worse than no link.
    wrap.append(
      el(
        'p',
        'assist-footnote',
        'No permalink: this workspace has no GitHub remote, or no current branch.'
      )
    )
  }
  return wrap
}

/* -------------------------------- shell ---------------------------------- */

function render(): void {
  if (titleHost === null || bodyHost === null) return

  titleHost.replaceChildren()
  titleHost.append(el('span', 'side-bar__heading', 'Assist'))

  bodyHost.replaceChildren()

  const tabs = el('div', 'assist-tabs')
  for (const key of Object.keys(MODE_LABELS) as AssistMode[]) {
    const tab = el('button', `assist-tab${key === mode ? ' assist-tab--active' : ''}`)
    tab.type = 'button'
    tab.textContent = MODE_LABELS[key]
    tab.dataset['mode'] = key
    tab.addEventListener('click', () => {
      mode = key
      render()
    })
    tabs.append(tab)
  }
  bodyHost.append(tabs)

  if (selection === null) {
    bodyHost.append(
      emptyState('Select code in the editor, then choose Learn, Debug, Explain or Snippet.')
    )
    return
  }

  const source = el(
    'p',
    'assist-source',
    `${selection.relativePath}:${selection.startLine}${
      selection.endLine === selection.startLine ? '' : `-${selection.endLine}`
    }`
  )
  bodyHost.append(source)

  switch (mode) {
    case 'learn':
      bodyHost.append(renderLearn(selection))
      break
    case 'debug':
      bodyHost.append(renderDebug(selection))
      break
    case 'explain':
      bodyHost.append(renderExplain(selection))
      break
    case 'snippet':
      bodyHost.append(renderSnippet(selection))
      break
  }
}

/**
 * Resolves the remote and branch once, so Snippet can build a real permalink.
 * Both are allowed to be absent — a repository with no remote still gets a
 * markdown block, just without a link.
 */
async function loadRepositoryContext(): Promise<void> {
  const [statusResult, branchesResult] = await Promise.all([
    window.betterCallCompiler.git.status({}),
    window.betterCallCompiler.git.branches({})
  ])

  branch = branchesResult.ok ? branchesResult.value.branches.current : null
  if (branch === null && statusResult.ok) branch = statusResult.value.status.branch

  const originResult = await window.betterCallCompiler.github.insights({ force: false })
  if (originResult.ok && originResult.value.insights.repository !== null) {
    const [owner, repo] = originResult.value.insights.repository.split('/')
    repository = owner !== undefined && repo !== undefined ? { owner, repo } : null
  }
}

export function listenForAssistActions(): void {
  document.addEventListener(ASSIST_ACTION_EVENT, (event) => {
    const detail = (event as CustomEvent<AssistActionDetail>).detail
    selection = detail.selection
    mode = detail.mode
    render()
    // Bring the panel forward, the same way the AI view surfaces its answer.
    void showAssistView()
  })
}

/** Set by main.ts so this module does not need to import the side-bar registry. */
let showAssistView: () => void | Promise<void> = () => undefined

export function setAssistViewActivator(activate: () => void | Promise<void>): void {
  showAssistView = activate
}

export async function mountAssist(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body
  render()
  await loadRepositoryContext()
  render()
}

export function onAssistShown(): void {
  render()
}
