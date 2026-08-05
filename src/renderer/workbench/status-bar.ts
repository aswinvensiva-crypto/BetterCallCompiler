import type { Toolchain } from '../../shared/types'
import { notify, notifyError } from './notifications'

/**
 * The status bar.
 *
 * Step 1 built this inline in `main.ts` as a bridge-liveness readout. Step 6
 * gives it a second job — the toolchain indicator — so it moves to the module
 * the target layout names.
 */

let host: HTMLElement | null = null

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

/* --------------------------- toolchain indicator ------------------------- */

let toolchains: readonly Toolchain[] = []
let indicator: HTMLButtonElement | null = null
let indicatorDot: HTMLElement | null = null
let indicatorLabel: Text | null = null
let popover: HTMLElement | null = null

/** Tools that can actually run something. */
function readyCount(list: readonly Toolchain[]): number {
  return list.filter((toolchain) => toolchain.kind === 'real').length
}

/** Anything present but not usable is actionable, and says so in colour. */
function hasActionableProblem(list: readonly Toolchain[]): boolean {
  return list.some((toolchain) => toolchain.kind === 'store-stub' || toolchain.kind === 'unusable')
}

function describeKind(toolchain: Toolchain): string {
  switch (toolchain.kind) {
    case 'real':
      return toolchain.version ?? 'installed'
    case 'store-stub':
      return 'Microsoft Store alias stub'
    case 'unusable':
      return 'found, but not usable'
    case 'missing':
      return 'not on PATH'
  }
}

function renderIndicator(): void {
  if (indicator === null || indicatorDot === null || indicatorLabel === null) return

  if (toolchains.length === 0) {
    indicatorLabel.textContent = 'Toolchains…'
    indicatorDot.className = 'status-bar__dot'
    return
  }

  indicatorLabel.textContent = `Toolchains ${readyCount(toolchains)}/${toolchains.length}`
  indicatorDot.className = `status-bar__dot ${
    hasActionableProblem(toolchains)
      ? 'status-bar__dot--warn'
      : readyCount(toolchains) > 0
        ? 'status-bar__dot--ok'
        : 'status-bar__dot--error'
  }`

  const stub = toolchains.find((toolchain) => toolchain.kind === 'store-stub')
  indicator.title =
    stub?.guidance ?? 'Detected language toolchains. Click for details and to rescan.'
}

function closePopover(): void {
  popover?.remove()
  popover = null
}

function buildPopover(): HTMLElement {
  const panel = el('div', 'toolchains-popover')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Toolchains')

  const header = el('div', 'toolchains-popover__header')
  header.append(el('span', 'toolchains-popover__title', 'Toolchains'))

  const rescan = el('button', 'button', 'Rescan')
  rescan.type = 'button'
  rescan.addEventListener('click', (event) => {
    event.stopPropagation()
    rescan.disabled = true
    rescan.textContent = 'Scanning…'
    void rescanToolchains().then(() => {
      closePopover()
      openPopover()
    })
  })
  header.append(rescan)
  panel.append(header)

  const list = el('ul', 'toolchains-popover__list')
  for (const toolchain of toolchains) {
    const row = el('li', `toolchains-row toolchains-row--${toolchain.kind}`)

    const top = el('div', 'toolchains-row__top')
    top.append(el('span', 'toolchains-row__name', toolchain.label))
    top.append(el('span', 'toolchains-row__status', describeKind(toolchain)))
    row.append(top)

    if (toolchain.path !== null) {
      const path = el('div', 'toolchains-row__path', toolchain.path)
      path.title = toolchain.path
      row.append(path)
    }

    // The Store-stub wording is the whole point of the probe; show it in full
    // rather than truncating it to a tooltip.
    if (toolchain.guidance !== null) {
      row.append(el('p', 'toolchains-row__guidance', toolchain.guidance))
    }

    list.append(row)
  }
  panel.append(list)

  return panel
}

function openPopover(): void {
  if (indicator === null) return
  closePopover()

  const panel = buildPopover()
  document.body.append(panel)
  popover = panel

  // Anchored to the indicator, then nudged back on screen if it would overflow.
  const anchor = indicator.getBoundingClientRect()
  const box = panel.getBoundingClientRect()
  panel.style.bottom = `${window.innerHeight - anchor.top + 6}px`
  panel.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`

  panel.addEventListener('click', (event) => event.stopPropagation())
}

function togglePopover(): void {
  if (popover !== null) closePopover()
  else openPopover()
}

/**
 * Re-probes and refreshes the indicator. Exported so the command palette
 * (step 12) can register "Rescan toolchains" against the same code path the
 * popover button uses.
 */
export async function rescanToolchains(): Promise<void> {
  const result = await window.betterCallCompiler.toolchain.rescan({})
  if (!result.ok) {
    notifyError(`Could not scan toolchains: ${result.error.message}`)
    return
  }
  toolchains = result.value.toolchains
  renderIndicator()

  const stubs = toolchains.filter((toolchain) => toolchain.kind === 'store-stub')
  const firstStub = stubs[0]
  if (firstStub?.guidance !== undefined && firstStub.guidance !== null) {
    notify(firstStub.guidance, 'warning', 12_000)
  }
}

async function loadToolchains(): Promise<void> {
  const result = await window.betterCallCompiler.toolchain.list({})
  if (!result.ok) {
    if (indicatorLabel !== null) indicatorLabel.textContent = 'Toolchains unavailable'
    return
  }
  toolchains = result.value.toolchains
  renderIndicator()
}

/* -------------------------- Visualizer foothold -------------------------- */

export interface VisualizerStatus {
  /** What the Visualizer is currently showing. */
  readonly label: string
  /** A short count beside it — nodes drawn. */
  readonly detail: string
  /** Restores the panel. The entry is useless if it is only a readout. */
  readonly onActivate: () => void
}

let visualizerSlot: HTMLButtonElement | null = null
let visualizerActivate: (() => void) | null = null

/**
 * The minimized Visualizer's one remaining trace, or null to remove it.
 *
 * A module-level export rather than a `StatusBarHandle` method for the same
 * reason `rescanToolchains` is one: the caller is a view that never sees the
 * handle — main.ts creates it, uses it for the bridge readout and drops it —
 * and threading it out to the Visualizer would couple three modules to move one
 * string.
 */
export function setVisualizerStatus(status: VisualizerStatus | null): void {
  const slot = visualizerSlot
  if (slot === null) return

  if (status === null) {
    visualizerActivate = null
    slot.replaceChildren()
    slot.hidden = true
    return
  }

  visualizerActivate = status.onActivate
  const strip = el('div', 'viz-status')
  strip.append(
    el('span', 'viz-status__label', status.label),
    el('span', 'viz-status__count', status.detail)
  )
  slot.replaceChildren(strip)
  slot.title = `${status.label} — minimized. Click to restore.`
  slot.hidden = false
}

/* --------------------------------- mount -------------------------------- */

export interface StatusBarHandle {
  /** Updates the bridge readout once `app:ping` answers. */
  readonly setBridge: (text: string, state: 'ok' | 'error') => void
  readonly setBuild: (text: string) => void
}

export function mountStatusBar(statusBar: HTMLElement): StatusBarHandle {
  host = statusBar
  host.replaceChildren()

  const bridge = el('span', 'status-bar__item')
  const bridgeDot = el('span', 'status-bar__dot')
  const bridgeLabel = document.createTextNode('Connecting…')
  bridge.append(bridgeDot, bridgeLabel)
  host.append(bridge)

  host.append(el('span', 'status-bar__spacer'))

  // Empty and hidden until the Visualizer is minimized. The listener is bound
  // once here rather than in `setVisualizerStatus`, which runs on every
  // debounced rebuild and would otherwise stack a handler per keystroke.
  visualizerSlot = el('button', 'status-bar__item status-bar__item--button')
  visualizerSlot.type = 'button'
  visualizerSlot.hidden = true
  visualizerSlot.setAttribute('aria-label', 'Restore the Visualizer')
  visualizerSlot.addEventListener('click', (event) => {
    event.stopPropagation()
    visualizerActivate?.()
  })
  host.append(visualizerSlot)

  indicator = el('button', 'status-bar__item status-bar__item--button')
  indicator.type = 'button'
  indicator.id = 'toolchain-indicator'
  indicator.setAttribute('aria-label', 'Toolchains')
  indicatorDot = el('span', 'status-bar__dot')
  indicatorLabel = document.createTextNode('Toolchains…')
  indicator.append(indicatorDot, indicatorLabel)
  indicator.addEventListener('click', (event) => {
    event.stopPropagation()
    togglePopover()
  })
  host.append(indicator)

  const build = el('span', 'status-bar__item', 'BetterCallCompiler')
  host.append(build)

  document.addEventListener('click', closePopover)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePopover()
  })

  // Probing spawns six processes; let the window paint first.
  void loadToolchains()

  return {
    setBridge: (text, state) => {
      bridgeLabel.textContent = text
      bridgeDot.className = `status-bar__dot status-bar__dot--${state}`
    },
    setBuild: (text) => {
      build.textContent = text
    }
  }
}

