import { createTerminal, hasTerminals, mountTerminals, refitActive } from '../terminal/xterm-view'
import { mountRunView, refitOutput, showRunActions } from '../views/run'
import { mountProblems, onProblemsShown } from '../views/problems'
import { mountDebugView, onDebugShown } from '../views/debug'

/**
 * The bottom panel.
 *
 * Step 5 gave it the terminal; step 7 adds the output console beside it, which
 * is why the tab strip is owned here rather than by either view. The two are
 * peers: each owns a body and a slot in the tab strip's action area, and the
 * panel only decides which is showing.
 *
 * The view tabs use `.panel-view-tab`, deliberately *not* `.panel-tab` — that
 * class belongs to terminal sessions, and reusing it would silently change what
 * step 5's E2E assertions are counting.
 */

/**
 * A closed union rather than an open registry: the panel has a fixed set of
 * views, each with its own body element created in `mountPanel`, and the tab
 * strip is meant to stay small enough to read at a glance.
 */
export type PanelViewId = 'terminal' | 'output' | 'problems' | 'debug'

interface PanelView {
  readonly id: PanelViewId
  readonly label: string
  readonly body: HTMLElement
  readonly actions: HTMLElement
  readonly onShow: () => void
}

let panelEl: HTMLElement | null = null
let onVisibilityChanged: ((visible: boolean) => void) | null = null

const views = new Map<PanelViewId, PanelView>()
let activeView: PanelViewId = 'terminal'
let viewTabStrip: HTMLElement | null = null

export function isPanelVisible(): boolean {
  return panelEl !== null && !panelEl.hidden
}

export function activeViewId(): PanelViewId {
  return activeView
}

function renderViewTabs(): void {
  if (viewTabStrip === null) return
  viewTabStrip.replaceChildren()

  for (const view of views.values()) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = `panel-view-tab${view.id === activeView ? ' panel-view-tab--active' : ''}`
    tab.dataset['viewId'] = view.id
    tab.textContent = view.label
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(view.id === activeView))
    tab.addEventListener('click', () => {
      void showPanelView(view.id)
    })
    viewTabStrip.append(tab)
  }
}

export async function showPanelView(id: PanelViewId): Promise<void> {
  const view = views.get(id)
  if (view === undefined) return

  activeView = id
  for (const candidate of views.values()) {
    const showing = candidate.id === id
    candidate.body.hidden = !showing
    candidate.actions.hidden = !showing
  }
  renderViewTabs()

  if (!isPanelVisible()) await showPanel()
  view.onShow()
}

export async function showPanel(): Promise<void> {
  if (panelEl === null) return
  panelEl.hidden = false
  onVisibilityChanged?.(true)

  if (activeView === 'terminal') {
    // Opening an empty panel with no terminal would be a dead box.
    if (!hasTerminals()) {
      await createTerminal()
    } else {
      // The panel had zero size while hidden, so xterm's cached dimensions are stale.
      refitActive()
    }
  } else {
    refitOutput()
  }
}

export function hidePanel(): void {
  if (panelEl === null) return
  panelEl.hidden = true
  onVisibilityChanged?.(false)
}

export async function togglePanel(): Promise<void> {
  if (isPanelVisible()) hidePanel()
  else await showPanel()
}

/** Opens the panel on the output console, creating no terminal on the way. */
export async function showOutput(): Promise<void> {
  await showPanelView('output')
}

export async function showProblems(): Promise<void> {
  await showPanelView('problems')
}

export async function showDebug(): Promise<void> {
  await showPanelView('debug')
}

export function mountPanel(
  panel: HTMLElement,
  tabs: HTMLElement,
  body: HTMLElement,
  onChange?: (visible: boolean) => void
): void {
  panelEl = panel
  onVisibilityChanged = onChange ?? null

  tabs.replaceChildren()
  body.replaceChildren()

  // Tab strip: [Terminal | Output]  ·  <active view's own tabs and actions>
  viewTabStrip = document.createElement('div')
  viewTabStrip.className = 'panel__views'
  viewTabStrip.setAttribute('role', 'tablist')
  viewTabStrip.setAttribute('aria-label', 'Panel views')

  const divider = document.createElement('span')
  divider.className = 'panel__divider'

  const terminalActions = document.createElement('div')
  terminalActions.className = 'panel__actions'
  terminalActions.id = 'panel-terminal-actions'

  const outputActions = document.createElement('div')
  outputActions.className = 'panel__actions'
  outputActions.id = 'panel-output-actions'
  outputActions.hidden = true

  const problemsActions = document.createElement('div')
  problemsActions.className = 'panel__actions'
  problemsActions.id = 'panel-problems-actions'
  problemsActions.hidden = true

  const debugActions = document.createElement('div')
  debugActions.className = 'panel__actions'
  debugActions.id = 'panel-debug-actions'
  debugActions.hidden = true

  tabs.append(viewTabStrip, divider, terminalActions, outputActions, problemsActions, debugActions)

  const terminalBody = document.createElement('div')
  terminalBody.className = 'panel__view'
  terminalBody.id = 'panel-terminal-view'

  const outputBody = document.createElement('div')
  outputBody.className = 'panel__view panel__view--output'
  outputBody.id = 'panel-output-view'
  outputBody.hidden = true

  const problemsBody = document.createElement('div')
  problemsBody.className = 'panel__view panel__view--problems'
  problemsBody.id = 'panel-problems-view'
  problemsBody.hidden = true

  const debugBody = document.createElement('div')
  debugBody.className = 'panel__view panel__view--debug'
  debugBody.id = 'panel-debug-view'
  debugBody.hidden = true

  body.append(terminalBody, outputBody, problemsBody, debugBody)

  views.set('terminal', {
    id: 'terminal',
    label: 'Terminal',
    body: terminalBody,
    actions: terminalActions,
    onShow: () => {
      if (!hasTerminals()) void createTerminal()
      else refitActive()
    }
  })
  views.set('output', {
    id: 'output',
    label: 'Output',
    body: outputBody,
    actions: outputActions,
    onShow: showRunActions
  })

  views.set('problems', {
    id: 'problems',
    label: 'Problems',
    body: problemsBody,
    actions: problemsActions,
    onShow: onProblemsShown
  })

  views.set('debug', {
    id: 'debug',
    label: 'Debug',
    body: debugBody,
    actions: debugActions,
    onShow: onDebugShown
  })

  mountTerminals(terminalBody, terminalActions)
  mountRunView(outputBody, outputActions)
  // Mounted eagerly, unlike the side-bar views: it subscribes to the daemon's
  // event stream, and a panel that only starts listening when first opened
  // would miss every diagnostic produced before that.
  mountProblems(problemsBody, problemsActions)
  // Also eager, for the same reason and one more: the session's `stopped`
  // events start arriving the moment Debug is pressed, and the command that
  // presses it can be run from the palette without the panel ever having been
  // opened. A view that subscribed on first show would miss the entry stop.
  mountDebugView(debugBody, debugActions)
  renderViewTabs()

  document.addEventListener('keydown', (event) => {
    // Ctrl+` — accept either signal. `event.key` is the character produced,
    // which varies by keyboard layout; `event.code` is the physical key, which
    // does not. Matching both covers non-US layouts and automation drivers that
    // synthesise only one of the two.
    if ((event.ctrlKey || event.metaKey) && (event.key === '`' || event.code === 'Backquote')) {
      event.preventDefault()
      // The backtick always means "the terminal", even from the output tab.
      if (isPanelVisible() && activeView === 'terminal') hidePanel()
      else void showPanelView('terminal')
    }
  })
}
