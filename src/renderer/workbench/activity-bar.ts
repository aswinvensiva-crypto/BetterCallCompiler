import { activeSideBarView, showSideBarView } from './side-bar'
import {
  activeRightDockView,
  hideRightDock,
  isRightDockVisible,
  showRightDockView
} from './right-dock'

/**
 * The activity bar.
 *
 * Step 1 rendered these icons as decoration. Now that the side bar has more
 * than one view they become the switcher, and the bar owns the selected-state
 * bookkeeping so no individual view has to know about its neighbours.
 */

/**
 * Where an item's view lives.
 *
 * Previously this was a Set of the ids that happened to be side-bar views, with
 * everything else falling through to a callback named `onOther`. That worked
 * while "everything else" meant Run. With a second dock the implicit rule stops
 * being readable: an item's region is a fact about the item, so it is written
 * on the item.
 */
export type ActivityRegion = 'sidebar' | 'rightdock' | 'other'

export interface ActivityItem {
  readonly id: string
  readonly label: string
  /** 24x24 stroke-only path data. */
  readonly icon: string
  /** Views not yet built are rendered disabled rather than silently inert. */
  readonly enabled: boolean
  readonly region: ActivityRegion
}

export const ACTIVITY_ITEMS: readonly ActivityItem[] = [
  { id: 'explorer', label: 'Explorer', icon: 'M3 5h6l2 2h10v12H3z', enabled: true, region: 'sidebar' },
  {
    id: 'search',
    label: 'Search',
    icon: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.9-4.9',
    enabled: true,
    region: 'sidebar'
  },
  {
    id: 'scm',
    label: 'Source Control',
    icon: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v3a5 5 0 0 1-5 5H9',
    enabled: true,
    region: 'sidebar'
  },
  { id: 'run', label: 'Run', icon: 'M8 5v14l11-7z', enabled: true, region: 'other' },
  {
    // `region: 'other'` like Run: both open a bottom-panel view rather than a
    // side-bar one, so main.ts routes them through the panel instead of the
    // tool-window registry.
    id: 'problems',
    label: 'Problems',
    icon: 'M12 9v4M12 17h.01M10.3 4.3 2.5 18a1.7 1.7 0 0 0 1.5 2.5h16a1.7 1.7 0 0 0 1.5-2.5L13.7 4.3a1.7 1.7 0 0 0-3 0z',
    enabled: true,
    region: 'other'
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    enabled: true,
    region: 'sidebar'
  },
  {
    id: 'ai',
    label: 'Assistant',
    icon: 'M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2z',
    enabled: true,
    region: 'sidebar'
  },
  {
    // "Assist" is the local static-analysis panel; "Assistant" above is the AI
    // one. Distinct names, distinct icons, and no shared code between them.
    id: 'assist',
    label: 'Assist',
    icon: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z',
    enabled: true,
    region: 'sidebar'
  },
  {
    // The one right-dock item, and the reason that region exists: a
    // control-flow graph needs width the side bar does not have.
    id: 'visualizer',
    label: 'Visualizer',
    icon: 'M12 3v4M12 17v4M5.6 7.6l2.8 2.8M15.6 13.6l2.8 2.8M4 12h4M16 12h4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    enabled: true,
    region: 'rightdock'
  },
  {
    // "Explanations" is the durable artifact panel; "Assistant" above is the
    // streamed chat one. Distinct names and distinct icons, the same rule the
    // Assist/Assistant pair already follows.
    id: 'artifacts',
    label: 'Explanations',
    icon: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h5',
    enabled: true,
    region: 'sidebar'
  },
  {
    // The second right-dock item, and for the same reason as the first: a trace
    // list and a latency chart need width the side bar does not have.
    id: 'compiler',
    label: 'Compiler Intelligence',
    icon: 'M4 17l4-6 3 4 3-7 3 5M3 3v18h18',
    enabled: true,
    region: 'rightdock'
  },
  {
    id: 'settings',
    label: 'Settings',
    icon:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z',
    enabled: true,
    region: 'sidebar'
  }
]

let host: HTMLElement | null = null
const buttons = new Map<string, HTMLButtonElement>()

/** Activity items belonging to no dock (Run) route somewhere else. */
let onNonSideBarSelect: ((id: string) => void) | null = null

/**
 * Handles a click on an item, given where its view lives.
 *
 * The right-dock branch is the only one that can *close* something. That is
 * IntelliJ's behaviour for its tool-window stripes and it is the useful one:
 * the button that opened a 460px region is the obvious place to reach for when
 * you want the editor width back, and re-showing an already-showing view is a
 * click that does nothing.
 */
function activate(item: ActivityItem): void {
  if (item.region === 'sidebar') {
    setSelected(item.id)
    void showSideBarView(item.id)
    return
  }

  if (item.region === 'rightdock') {
    if (isRightDockVisible() && activeRightDockView() === item.id) {
      hideRightDock()
      // Selection follows the region that is still on screen, so the stripe
      // does not go on highlighting a tool window that is no longer there.
      const showing = activeSideBarView()
      if (showing !== null) setSelected(showing)
      return
    }
    setSelected(item.id)
    void showRightDockView(item.id)
    return
  }

  onNonSideBarSelect?.(item.id)
}

export function setSelected(id: string): void {
  for (const [itemId, button] of buttons) {
    button.setAttribute('aria-selected', String(itemId === id))
  }
}

export function mountActivityBar(
  activityBar: HTMLElement,
  onOther: (id: string) => void
): void {
  host = activityBar
  onNonSideBarSelect = onOther
  host.replaceChildren()
  buttons.clear()

  for (const item of ACTIVITY_ITEMS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'activity-bar__item'
    button.title = item.enabled ? item.label : `${item.label} — not in this milestone`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-label', item.label)
    button.setAttribute('aria-selected', String(item.id === 'explorer'))
    button.dataset['viewId'] = item.id
    button.disabled = !item.enabled
    button.innerHTML =
      `<svg viewBox="0 0 24 24" aria-hidden="true">` +
      `<path d="${item.icon}" stroke-linecap="round" stroke-linejoin="round" /></svg>`

    if (item.enabled) {
      button.addEventListener('click', () => activate(item))
    }

    buttons.set(item.id, button)
    host.append(button)
  }
}

/** Draws the SCM badge — the count of changed files, VS Code style. */
export function setBadge(id: string, count: number): void {
  const button = buttons.get(id)
  if (button === undefined) return

  button.querySelector('.activity-bar__badge')?.remove()
  if (count <= 0) return

  const badge = document.createElement('span')
  badge.className = 'activity-bar__badge'
  badge.textContent = count > 99 ? '99+' : String(count)
  button.append(badge)
}
