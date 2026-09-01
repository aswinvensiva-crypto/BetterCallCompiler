import {
  BUDGET_MS,
  chartScaleOf,
  describePass,
  describeWhy,
  explainOutcome,
  hotspotsOf,
  isInteractive,
  latencyOf,
  whyChecked,
  workOf
} from '../../shared/pass-analysis'
import type { CompilerPass, CompilerTraceEvent, DiagnosticSeverity } from '../../shared/types'
import { openFile } from '../editor/models'
import { WHY_FILE_EVENT, navigateToWorstDiagnostic, type WhyFileDetail } from './problems'
import { activeRightDockView, isRightDockVisible } from '../workbench/right-dock'

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

/**
 * Error/warning counts, kept independently of the Problems panel rather than
 * read out of it — this view only ever consumes daemon events, and reaching
 * into another view's module state would make that a lie the first time
 * Problems changed its internal representation.
 */
let diagnosticCounts: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 0,
  info: 0,
  hint: 0
}
/** Kept only to fold incremental `onDiagnosticsChanged` batches — see `tallyDiagnostics`. */
let diagFiles: readonly { relativePath: string; version: number; diagnostics: readonly { severity: DiagnosticSeverity }[] }[] = []
let unsubscribeDiagnostics: (() => void) | null = null

/**
 * Folds an incremental diagnostics batch into the running set and returns
 * fresh per-severity totals.
 *
 * `onDiagnosticsChanged` delivers only the files that changed, not a full
 * snapshot, so the previous file list is kept and merged the same way
 * Problems does it — a newer version replaces an older one, a version that
 * has gone stale is dropped in favour of what is already held.
 */
function tallyDiagnostics(
  incoming: readonly { relativePath: string; version: number; diagnostics: readonly { severity: DiagnosticSeverity }[] }[]
): Readonly<Record<DiagnosticSeverity, number>> {
  const byPath = new Map(diagFiles.map((file) => [file.relativePath, file]))
  for (const file of incoming) {
    const existing = byPath.get(file.relativePath)
    if (existing !== undefined && existing.version > file.version) continue
    byPath.set(file.relativePath, file)
  }
  diagFiles = [...byPath.values()]

  const totals = { error: 0, warning: 0, info: 0, hint: 0 }
  for (const file of diagFiles) {
    for (const diagnostic of file.diagnostics) totals[diagnostic.severity]++
  }
  return totals
}
/**
 * The file the Why tab is answering about, and the chain back to the edit.
 *
 * `chain` arrives asynchronously from the daemon, so it starts empty and the tab
 * re-renders when it lands. Null means "show the whole trace", which is the tab's
 * original behaviour and is kept intact.
 */
let focus: { relativePath: string; chain: readonly string[] } | null = null
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

/**
 * The "is it safe to ship this" summary at the top of the Live tab.
 *
 * Everything below it is the raw material an engineer already knows how to
 * read; this is the one-glance answer for the moment they do not want to read
 * it. Blocking is defined as outstanding errors, not warnings — a warning has
 * never once stopped a build.
 */
function renderVerdict(): HTMLElement {
  const blocking = diagnosticCounts.error
  const safe = blocking === 0

  const card = el('div', `ci-verdict ci-verdict--${safe ? 'safe' : 'blocked'}`)

  const badge = el('div', 'ci-verdict__badge', safe ? 'OK' : String(blocking))
  card.append(badge)

  const copy = el('div', 'ci-verdict__copy')
  copy.append(
    el(
      'p',
      'ci-verdict__title',
      safe ? 'Safe to ship' : `${blocking} blocking error${blocking === 1 ? '' : 's'}`
    )
  )
  copy.append(
    el(
      'p',
      'ci-verdict__subtitle',
      safe
        ? 'No outstanding errors in the workspace.'
        : diagnosticCounts.warning > 0
          ? `Plus ${diagnosticCounts.warning} warning${diagnosticCounts.warning === 1 ? '' : 's'} that will not block you.`
          : 'Nothing else outstanding.'
    )
  )
  card.append(copy)

  if (!safe) {
    const button = el('button', 'button ci-verdict__action', 'Take me to the blocker')
    button.type = 'button'
    button.addEventListener('click', () => void navigateToWorstDiagnostic())
    card.append(button)
  }

  return card
}

function renderLive(): HTMLElement {
  const wrap = el('div', 'ci-section')
  wrap.append(renderVerdict())
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
  const scale = chartScaleOf(passes)
  // Sets the budget rule's position — see `.ci-bars::after`.
  bars.style.setProperty('--ci-budget-fraction', `${scale.budgetFraction}`)

  // Filtered BEFORE the slice. Slicing first and skipping afterwards drew fewer
  // than forty bars whenever the history held a cold or index pass, so the chart
  // silently showed less than it claimed.
  for (const pass of passes.filter(isInteractive).slice(-40)) {
    const bar = el('div', 'ci-bar')
    const height = Math.min(100, Math.round((pass.totalMs / scale.ceilingMs) * 100))
    // A 2% floor, so a sub-millisecond pass is still visible as a mark rather
    // than as a gap that reads like a missing pass.
    bar.style.height = `${Math.max(height, 2)}%`
    if (pass.totalMs > BUDGET_MS) bar.classList.add('ci-bar--over')
    // Clipped bars are marked, because otherwise every pass above the ceiling
    // looks identical to every other and the chart quietly lies about the worst
    // one.
    if (pass.totalMs > scale.ceilingMs) bar.classList.add('ci-bar--clipped')
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
  if (focus !== null) return renderWhyForFocus(focus.relativePath, focus.chain)

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

/**
 * One file's answer: what caused the pass, the route from the edit, and what the
 * daemon then did about this file.
 *
 * Reuses `renderTraceRow` for the file's own events rather than reformatting
 * them, so `explainOutcome`'s sentence — the part a person cannot reconstruct
 * from the numbers — is identical in both views of the same data.
 */
function renderWhyForFocus(relativePath: string, chain: readonly string[]): HTMLElement {
  const wrap = el('div', 'ci-section ci-why')

  const header = el('div', 'ci-why__header')
  header.append(el('code', 'ci-why__file', relativePath))
  const back = el('button', 'button ci-why__back', 'Show the whole trace')
  back.type = 'button'
  back.addEventListener('click', () => {
    focus = null
    render()
  })
  header.append(back)
  wrap.append(header)

  const record = whyChecked(passes, relativePath)
  if (record === null) {
    // Said out loud rather than rendered as an empty list. "Not in the retained
    // history" is a real answer and a different one from "nothing happened".
    wrap.append(
      el(
        'p',
        'explorer__empty-text',
        `${relativePath} has not been checked in the last ${MAX_PASSES} passes.`
      )
    )
    return wrap
  }

  wrap.append(el('p', 'ci-note', describeWhy(record)))

  if (chain.length > 1) {
    wrap.append(el('div', 'ci-why__label', 'The route from that edit to this file'))
    wrap.append(renderChain(chain))
  } else if (chain.length === 1) {
    wrap.append(el('p', 'ci-note', 'This is the file that was edited.'))
  }

  wrap.append(el('div', 'ci-why__label', 'What the daemon did about it'))
  const list = el('div', 'ci-trace')
  const pass = passes.find((candidate) => candidate.id === record.passId)
  for (const event of pass?.events ?? []) {
    if (event.key !== `sig:${relativePath}` && event.key !== `diag:${relativePath}`) continue
    list.append(renderTraceRow(event))
  }
  wrap.append(list)

  wrap.append(
    el(
      'p',
      'ci-why__totals',
      `That pass named ${record.requested} file${record.requested === 1 ? '' : 's'} and ` +
        `type-checked ${record.recomputed}.`
    )
  )

  return wrap
}

/** `lib.ts → util.ts → app.ts`, each hop opening the file. */
function renderChain(chain: readonly string[]): HTMLElement {
  const wrap = el('div', 'ci-why__chain')

  chain.forEach((path, index) => {
    if (index > 0) wrap.append(el('span', 'ci-why__arrow', '→'))

    const hop = el('button', 'ci-why__hop', path)
    hop.type = 'button'
    hop.title = `Open ${path}`
    hop.addEventListener('click', () => {
      void openHop(path)
    })
    wrap.append(hop)
  })

  return wrap
}

/**
 * Opens a chain hop in the editor.
 *
 * The chain carries workspace-relative paths and `openFile` needs the absolute
 * one, so the node is fetched rather than reconstructed — joining a root by hand
 * here would be a second, drifting implementation of a path the daemon already
 * knows. The round trip is pure graph lookup and cannot cause a check.
 */
async function openHop(relativePath: string): Promise<void> {
  const result = await api.compiler.dependents({ relativePath, from: [] })
  if (!result.ok) return

  const node = result.value.graph.node
  if (node === null) return

  await openFile({
    name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
    path: node.path,
    relativePath,
    kind: 'file'
  })
}

/**
 * Focuses the Why tab on one file.
 *
 * State is set BEFORE the daemon is asked, so the tab shows its answer
 * immediately and the chain fills in when it arrives. The guard on the late reply
 * matters: a user can click Why on a second file while the first request is still
 * in flight, and the stale chain must not overwrite the new focus.
 */
export function showWhyForFile(relativePath: string): void {
  activeTab = 'why'
  focus = { relativePath, chain: [] }
  render()

  void (async () => {
    // The history has to be here before a trigger can be read out of it, and on
    // the FIRST use of this feature it is not: the panel is lazily mounted, so a
    // Why click that arrives before it has ever been opened finds `passes` empty,
    // reads no trigger, asks for a chain from nowhere and gets nothing back. That
    // is the first thing every user does with this button.
    if (passes.length === 0) {
      const history = await api.compiler.passes({})
      if (history.ok) passes = history.value.passes.slice(-MAX_PASSES)
    }

    const trigger = whyChecked(passes, relativePath)?.trigger ?? []
    const result = await api.compiler.dependents({ relativePath, from: [...trigger] })
    if (!result.ok) return
    // A second Why click can land while this one is in flight; the stale chain
    // must not overwrite the newer focus.
    if (focus === null || focus.relativePath !== relativePath) return

    focus = { relativePath, chain: result.value.graph.chain }
    render()
  })()
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

  const snapshot = await api.compiler.diagnostics({ relativePath: null })
  if (snapshot.ok) diagnosticCounts = tallyDiagnostics(snapshot.value.files)

  unsubscribeDiagnostics?.()
  unsubscribeDiagnostics = api.compiler.onDiagnosticsChanged((batch) => {
    diagnosticCounts = tallyDiagnostics(batch.files)
    if (isRightDockVisible() && activeRightDockView() === 'compiler') render()
  })

  unsubscribe?.()
  unsubscribe = api.compiler.onPassCompleted((pass) => {
    passes.push(pass)
    if (passes.length > MAX_PASSES) passes = passes.slice(-MAX_PASSES)
    // Only re-render when the user is looking at it. A hidden panel that
    // re-rendered on every pass would put this view back on the hot path it was
    // designed to stay off.
    // `bodyHost.hidden` is only toggled when switching views WITHIN the dock, so
    // a dock closed from the activity bar left this panel rebuilding its whole
    // tab DOM on every pass — the exact hot-path cost the view exists to avoid.
    if (!isRightDockVisible() || activeRightDockView() !== 'compiler') return

    render()
  })

  render()
}

export function onCompilerIntelligenceShown(): void {
  render()
}

/** Set by main.ts so a Problems row can bring this panel to the front. */
let activate: (() => void | Promise<void>) | null = null

export function setCompilerViewActivator(fn: () => void | Promise<void>): void {
  activate = fn
}

/**
 * Bound once at start-up, not on first mount.
 *
 * The panel is lazily mounted like every other tool window, and a Why request made
 * before it has ever been opened must still be honoured. That works because the
 * focus state is set first and `render()` no-ops while bodyHost is null — the
 * mount's own render then picks the focus up.
 */
export function listenForWhyRequests(): void {
  document.addEventListener(WHY_FILE_EVENT, (event) => {
    const detail = (event as CustomEvent<WhyFileDetail>).detail
    showWhyForFile(detail.relativePath)
    void activate?.()
  })
}
