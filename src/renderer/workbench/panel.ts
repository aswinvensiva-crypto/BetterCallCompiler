import { createTerminal, hasTerminals, mountTerminals, refitActive } from '../terminal/xterm-view'

/**
 * The bottom panel. Step 5 gives it the terminal; step 7 adds the output
 * console beside it, which is why the tab strip is owned here rather than by
 * the terminal view.
 */
let panelEl: HTMLElement | null = null
let onVisibilityChanged: ((visible: boolean) => void) | null = null

export function isPanelVisible(): boolean {
  return panelEl !== null && !panelEl.hidden
}

export async function showPanel(): Promise<void> {
  if (panelEl === null) return
  panelEl.hidden = false
  onVisibilityChanged?.(true)

  // Opening an empty panel with no terminal would be a dead box.
  if (!hasTerminals()) {
    await createTerminal()
  } else {
    // The panel had zero size while hidden, so xterm's cached dimensions are stale.
    refitActive()
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

export function mountPanel(
  panel: HTMLElement,
  tabs: HTMLElement,
  body: HTMLElement,
  onChange?: (visible: boolean) => void
): void {
  panelEl = panel
  onVisibilityChanged = onChange ?? null
  mountTerminals(body, tabs)

  document.addEventListener('keydown', (event) => {
    // Ctrl+` — accept either signal. `event.key` is the character produced,
    // which varies by keyboard layout; `event.code` is the physical key, which
    // does not. Matching both covers non-US layouts and automation drivers that
    // synthesise only one of the two.
    if ((event.ctrlKey || event.metaKey) && (event.key === '`' || event.code === 'Backquote')) {
      event.preventDefault()
      void togglePanel()
    }
  })
}
