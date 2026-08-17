import {
  BUDGET_MS,
  describePass,
  explainOutcome,
  hotspotsOf,
  isInteractive,
  latencyOf,
  workOf
} from '../../shared/pass-analysis'
import type { CompilerPass, CompilerTraceEvent } from '../../shared/types'

/**
 * The Compiler Intelligence view.
 *
 * Every editor on the market will tell you what is wrong with your code. None
 * of them will tell you what the compiler just did about it. This view answers
 * the second question: which files the invalidation walk named, how many of
 * them the type checker actually ran on, why each of the others was skipped,
 * and where the time went.
 *
 * That is not a debug panel. The daemon already knows all of it and throws it
 * away every pass; the only reason no IDE shows it is that most of them have no
 * incremental model precise enough for the answer to be interesting.
 *
 * Strictly a consumer. It renders what arrives on `compiler:passCompleted` and
 * never asks the daemon to do anything, so it cannot appear on the typing hot
 * path — and it is lazily mounted, so an unopened panel costs nothing at all.
 */

const api = window.betterCallCompiler

type TabId = 'live' | 'why' | 'hotspots' | 'history'

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'why', label: 'Why' },
  { id: 'hotspots', label: 'Hotspots' },
  { id: 'history', label: 'History' }
]

let bodyHost: HTMLElement | null = null
let passes: CompilerPass[] = []
let activeTab: TabId = 'live'
let unsubscribe: (() => void) | null = null

/**
 * Same bound as the service's history. Holding more here would let a panel left
 * open all day outgrow the process that feeds it.
 */
const MAX_PASSES = 50

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

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
}

/* -------------------------------- renderers ------------------------------- */

function stat(label: string, value: string, tone?: 'good' | 'warn'): HTMLElement {
  const card = el('div', 'ci-stat')
  const figure = el('div', 'ci-stat__value', value)
  if (tone !== undefined) figure.classList.add(`ci-stat__value--${tone}`)
  card.append(figure, el('div', 'ci-stat__label', label))
  return card
}

function renderLive(): HTMLElement {
  const wrap = el('div', 'ci-section')
  const latest = passes[passes.length - 1]

  if (latest === undefined) {
    wrap.append(
      el(
        'p',
        'explorer__empty-text',
        'No check passes yet. Edit a file in the workspace and the daemon’s working will appear here.'
      )
    )
    return wrap
  }

  const latency = latencyOf(passes)
  const work = workOf(passes)

  const grid = el('div', 'ci-stats')
  grid.append(
    stat('files in last invalidation set', String(latest.requested)),
    stat(
      'type-checked',
      String(latest.recomputed),
      latest.recomputed < latest.requested ? 'good' : undefined
    ),
    stat('reused from memo', String(latest.reused), latest.reused > 0 ? 'good' : undefined),
    stat(
      'last pass',
      ms(latest.totalMs),
      latest.totalMs <= BUDGET_MS ? 'good' : 'warn'
    )
  )
  wrap.append(grid)

  // The headline claim, stated as a sentence rather than left for the reader to
  // derive from four numbers.
  const summary = el('p', 'ci-headline')
  summary.append(
    document.createTextNode('Across '),
    el('strong', undefined, `${passes.length} pass${passes.length === 1 ? '' : 'es'}`),
    document.createTextNode(', the invalidation walk named '),
    el('strong', undefined, String(work.requested)),
    document.createTextNode(' files and the type checker ran on '),
    el('strong', undefined, String(work.recomputed)),
    document.createTextNode(` — ${work.savedPercent}% answered from memo.`)
  )
  wrap.append(summary)

  const budget = el('div', 'ci-budget')
  budget.append(el('div', 'ci-budget__title', `Interactive latency (${BUDGET_MS}ms budget)`))

  const bars = el('div', 'ci-bars')
  for (const pass of passes.slice(-40)) {
    if (!isInteractive(pass)) continue
    const bar = el('div', 'ci-bar')
    // Scaled against 4x the budget so an outlier does not flatten everything
    // else into an unreadable strip of one-pixel bars.
    const height = Math.min(100, Math.round((pass.totalMs / (BUDGET_MS * 4)) * 100))
    bar.style.height = `${Math.max(height, 2)}%`
    if (pass.totalMs > BUDGET_MS) bar.classList.add('ci-bar--over')
    bar.title = `${describePass(pass)} — ${ms(pass.totalMs)}`
    bars.append(bar)
  }
  budget.append(bars)

  const legend = el(
    'div',
    'ci-budget__legend',
    latency.count === 0
      ? 'No interactive passes yet — the cold index is excluded on purpose.'
      : `p50 ${ms(latency.p50)} · p95 ${ms(latency.p95)} · worst ${ms(latency.worst)} · ` +
        `${latency.withinBudget} of ${latency.count} within budget`
  )
  budget.append(legend)
  wrap.append(budget)

  return wrap
}

function renderWhy(): HTMLElement {
  const wrap = el('div', 'ci-section')
  const latest = passes[passes.length - 1]

  if (latest === undefined || latest.events.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No trace for the last pass.'))
    return wrap
  }

  wrap.append(el('p', 'ci-note', describePass(latest)))

  const list = el('div', 'ci-trace')
  for (const event of latest.events) {
    list.append(renderTraceRow(event))
  }
  wrap.append(list)
  return wrap
}

function renderTraceRow(event: CompilerTraceEvent): HTMLElement {
  const row = el('div', 'ci-trace__row')

  const head = el('div', 'ci-trace__head')
  head.append(el('span', `ci-tag ci-tag--${event.outcome}`, event.outcome))
  head.append(el('code', 'ci-trace__key', event.key))
  head.append(el('span', 'ci-trace__ms', ms(event.ms)))
  row.append(head)

  // The sentence is the point of this tab. Truncating it to fit would remove
  // the only part a person cannot reconstruct from the numbers.
  row.append(el('div', 'ci-trace__why', explainOutcome(event)))
  return row
}

function renderHotspots(): HTMLElement {
  const wrap = el('div', 'ci-section')
  const hotspots = hotspotsOf(passes)

  if (hotspots.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No files checked yet.'))
    return wrap
  }

  wrap.append(
    el('p', 'ci-note', 'Ranked by total time spent checking, across every pass this session.')
  )

  const table = el('div', 'ci-table')
  for (const hotspot of hotspots) {
    const row = el('div', 'ci-table__row')
    row.append(el('code', 'ci-table__path', hotspot.path))
    row.append(el('span', 'ci-table__ms', ms(hotspot.totalMs)))
    row.append(
      el('span', 'ci-table__counts', `${hotspot.checks} checked · ${hotspot.reuses} reused`)
    )
    table.append(row)
  }
  wrap.append(table)
  return wrap
}

function renderHistory(): HTMLElement {
  const wrap = el('div', 'ci-section')

  if (passes.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No passes yet.'))
    return wrap
  }

  const list = el('div', 'ci-history')
  // Newest first: the thing that just happened is what a person is looking for.
  for (const pass of [...passes].reverse()) {
    const row = el('div', 'ci-history__row')
    row.append(el('span', 'ci-history__id', `#${pass.id}`))
    row.append(el('span', 'ci-history__text', describePass(pass)))
    row.append(
      el(
        'span',
        pass.totalMs > BUDGET_MS ? 'ci-history__ms ci-history__ms--over' : 'ci-history__ms',
        ms(pass.totalMs)
      )
    )
    list.append(row)
  }
  wrap.append(list)
  return wrap
}

const RENDERERS: Readonly<Record<TabId, () => HTMLElement>> = {
  live: renderLive,
  why: renderWhy,
  hotspots: renderHotspots,
  history: renderHistory
}

/* --------------------------------- mounting ------------------------------- */

function render(): void {
  if (bodyHost === null) return

  const root = el('div', 'ci')

  const strip = el('div', 'ci-tabs')
  for (const tab of TABS) {
    const button = el('button', 'ci-tabs__tab', tab.label)
    button.type = 'button'
    button.dataset['tabId'] = tab.id
    button.setAttribute('aria-selected', String(tab.id === activeTab))
    button.addEventListener('click', () => {
      activeTab = tab.id
      render()
    })
    strip.append(button)
  }
  root.append(strip)
  root.append(RENDERERS[activeTab]())

  bodyHost.replaceChildren(root)
}

export async function mountCompilerIntelligence(
  title: HTMLElement,
  body: HTMLElement
): Promise<void> {
  bodyHost = body
  title.replaceChildren(el('span', 'right-dock__title-text', 'Compiler Intelligence'))

  // Pulled as well as subscribed. This view is lazily mounted, so opening it
  // between passes must show the history the daemon already has rather than an
  // empty chart until the user happens to type.
  // A daemon that is stopped or failed answers with an error rather than
  // throwing; an empty view with a working tab strip is better than a blank
  // panel, so the failure is simply "no passes yet".
  const result = await api.compiler.passes({})
  passes = result.ok ? result.value.passes.slice(-MAX_PASSES) : []

  unsubscribe?.()
  unsubscribe = api.compiler.onPassCompleted((pass) => {
    passes.push(pass)
    if (passes.length > MAX_PASSES) passes = passes.slice(-MAX_PASSES)
    // Only re-render when the user is looking at it. A hidden panel that
    // re-rendered on every pass would put this view back on the hot path it was
    // designed to stay off.
    if (bodyHost !== null && bodyHost.hidden !== true) render()
  })

  render()
}

export function onCompilerIntelligenceShown(): void {
  render()
}
