import { showSideBarView } from './side-bar'

/**
 * The activity bar.
 *
 * Step 1 rendered these icons as decoration. Now that the side bar has more
 * than one view they become the switcher, and the bar owns the selected-state
 * bookkeeping so no individual view has to know about its neighbours.
 */

export interface ActivityItem {
  readonly id: string
  readonly label: string
  /** 24x24 stroke-only path data. */
  readonly icon: string
  /** Views not yet built are rendered disabled rather than silently inert. */
  readonly enabled: boolean
}

export const ACTIVITY_ITEMS: readonly ActivityItem[] = [
  { id: 'explorer', label: 'Explorer', icon: 'M3 5h6l2 2h10v12H3z', enabled: true },
  {
    id: 'search',
    label: 'Search',
    icon: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.9-4.9',
    // Step 12.
    enabled: false
  },
  {
    id: 'scm',
    label: 'Source Control',
    icon: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v3a5 5 0 0 1-5 5H9',
    enabled: true
  },
  { id: 'run', label: 'Run', icon: 'M8 5v14l11-7z', enabled: true },
  { id: 'insights', label: 'Insights', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2', enabled: true },
  {
    id: 'ai',
    label: 'Assistant',
    icon: 'M12 3l2.2 5.6L20 10.8l-5.8 2.2L12 19l-2.2-6L4 10.8l5.8-2.2z',
    // Step 11.
    enabled: false
  },
  {
    id: 'settings',
    label: 'Settings',
    icon:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z',
    enabled: true
  }
]

/** Views that live in the side bar, as opposed to the panel. */
const SIDE_BAR_VIEWS = new Set(['explorer', 'scm', 'insights', 'settings'])

let host: HTMLElement | null = null
const buttons = new Map<string, HTMLButtonElement>()

/** Non-side-bar activity items (Run) route somewhere else. */
let onNonSideBarSelect: ((id: string) => void) | null = null

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
      button.addEventListener('click', () => {
        if (SIDE_BAR_VIEWS.has(item.id)) {
          setSelected(item.id)
          void showSideBarView(item.id)
        } else {
          onNonSideBarSelect?.(item.id)
        }
      })
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
