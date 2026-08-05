/**
 * The Visualizer's toolbar: the two limits that decide how much of the graph is
 * drawn, a readout that admits what those limits cost, and the window controls.
 *
 * The sliders are the whole reason this file exists. `layoutGraph` will happily
 * lay out a 600-node file graph, and the result is unreadable — so depth and
 * fan-out are not preferences, they are the only thing standing between the
 * canvas and a wall of boxes. Fan-out replaces the "show top actions /
 * branching" pair from the reference design, which is a game-AI idea: a
 * behaviour tree can be asked to show only its best-scoring options because it
 * *ranks* them, whereas a control-flow graph has no such ordering — every branch
 * happens under some input, so hiding "the unlikely ones" would be inventing
 * information. Capping siblings per rank is the honest version of the same
 * control: it is explicitly arbitrary, and it says so by reporting the count it
 * removed.
 *
 * Which is the second reason this file exists. Both limits silently delete real
 * code from the picture, so `hiddenCount` is reported in a notice the user
 * cannot miss, next to the sliders that caused it. A panel that truncates
 * quietly is worse than no panel: the reader believes they have seen the
 * function.
 *
 * This module owns NO styling. Every colour, size and font comes from
 * `visualizer.css`; the only DOM properties set here are class names from the
 * pinned vocabulary, ARIA state, and `d`/`viewBox` on the icons — path geometry
 * has nowhere else to live. The one apparent exception, `fill="none"
 * stroke="currentColor"` on icon paths, hardcodes no colour at all:
 * `currentColor` defers it to whatever `.icon-button` / `--active` resolve
 * `color` to, and it is the idiom every other icon in this codebase already
 * uses (`explorer.ts`, `insights.ts`). `.icon-button svg` in workbench.css sets
 * width and height and nothing else, so a path without those two attributes
 * renders as a solid black blob.
 */

/* ------------------------------- public API ------------------------------ */

export type VisualizerWindowState = 'docked' | 'maximized' | 'minimized' | 'floating'

export interface ToolbarCallbacks {
  readonly onMaxDepthChange: (value: number) => void
  readonly onFanOutChange: (value: number) => void
  readonly onWindowStateChange: (next: VisualizerWindowState) => void
  readonly onFit: () => void
  /** Multiplicative: 1.2 zooms in one step, 1/1.2 zooms back out to exactly where it was. */
  readonly onZoom: (factor: number) => void
}

export interface ToolbarMetrics {
  readonly mode: 'file' | 'selection'
  readonly nodeCount: number
  readonly depth: number
  readonly hiddenCount: number
  readonly activeLabel: string | null
  /** Set when the graph fell back to a line list, so the toolbar can say why. */
  readonly degradedReason: string | null
}

export interface ToolbarHandle {
  readonly setMetrics: (metrics: ToolbarMetrics) => void
  readonly setWindowState: (state: VisualizerWindowState) => void
  readonly maxDepth: () => number
  readonly fanOut: () => number
  readonly destroy: () => void
}

/* ------------------------------ tuning knobs ----------------------------- */

/** Mirrors `layoutGraph`'s clamps. If these drift the slider lies about its own effect. */
const MIN_DEPTH = 1
const MAX_DEPTH = 10
const MIN_FAN_OUT = 1
const MAX_FAN_OUT = 40

/**
 * Openers, not limits. Six ranks and twelve siblings covers an ordinary function
 * whole — the common case, where the notice should stay away entirely — while
 * still cutting a 4,000-line file down to something the eye can enter. Starting
 * at the maximum would mean the first thing most users see is the wall of boxes
 * the limits exist to prevent; starting at the minimum would mean the notice
 * fires on every trivial function and is therefore ignored by the second day.
 */
const DEFAULT_DEPTH = 6
const DEFAULT_FAN_OUT = 12

/**
 * Zoom is multiplicative and the out-step is the reciprocal, so in-then-out
 * returns to the original scale. An additive step (±0.2) does not: it is a
 * larger proportional jump at 0.4x than at 4x, and it walks away from where it
 * started, which is maddening on a diagram you are trying to hold still.
 */
const ZOOM_STEP = 1.2

/** Long enough to identify a function, short enough not to shove the buttons onto a second row. */
const MAX_ACTIVE_LABEL_CHARS = 32

/** Shown before the first `setMetrics`. A blank slot reads as a broken readout. */
const UNKNOWN = '—'

/* --------------------------------- icons --------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg'

const ICON_ZOOM_IN = 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9M10.3 10.3 13.5 13.5M5 7h4M7 5v4'
const ICON_ZOOM_OUT = 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9M10.3 10.3 13.5 13.5M5 7h4'
/** Four corners pulling inward: "make it all fit", not "make it bigger". */
const ICON_FIT = 'M2.5 6V2.5H6M14 6V2.5h-3.5M2.5 10v3.5H6M14 10v3.5h-3.5'
const ICON_MINIMIZE = 'M3.5 12.5h9'
const ICON_MAXIMIZE = 'M2.5 3.5h11v9h-11z'
/** A framed panel with a divider — the dock this thing came out of. */
const ICON_RESTORE = 'M2.5 3.5h11v9h-11zM9.5 3.5v9'
/** The standard "opens in its own window" arrow. */
const ICON_FLOAT = 'M9.5 2.5h4v4M13.5 2.5 8 8M11 9v4.5H2.5V5H7'

/* -------------------------------- helpers -------------------------------- */

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

/**
 * SVG needs the namespaced constructor, and its `className` is a read-only
 * `SVGAnimatedString` rather than a settable string — hence `setAttribute`.
 * Assigning `.className` on an SVG element fails silently, which is the sort of
 * bug that survives review because the code looks identical to the HTML case.
 */
function svg<K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  if (className !== undefined) node.setAttribute('class', className)
  return node
}

function icon(path: string): SVGSVGElement {
  const root = svg('svg')
  root.setAttribute('viewBox', '0 0 16 16')
  // Every button here carries an aria-label; letting AT walk into the path data
  // as well would announce the decoration twice.
  root.setAttribute('aria-hidden', 'true')

  const shape = svg('path')
  shape.setAttribute('d', path)
  shape.setAttribute('fill', 'none')
  shape.setAttribute('stroke', 'currentColor')
  shape.setAttribute('stroke-width', '1.3')
  shape.setAttribute('stroke-linecap', 'round')
  shape.setAttribute('stroke-linejoin', 'round')
  root.append(shape)
  return root
}

function iconButton(label: string, path: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'icon-button viz-toolbar__button')
  button.type = 'button'
  // Both, deliberately: `title` is the sighted user's hover hint and `aria-label`
  // is the accessible name. An icon with neither is a mystery box, and this
  // codebase labels every one of them.
  button.title = label
  button.setAttribute('aria-label', label)
  button.append(icon(path))
  button.addEventListener('click', onClick)
  return button
}

/**
 * A slider is only useful if it can be read as well as dragged, so the group is
 * label + range + live readout. The readout is not decoration: `<input
 * type="range">` shows no value of its own, and "depth 6" is exactly the number
 * the user needs when the hidden-node notice appears next to it.
 *
 * The label is a `<span>` with a separate `aria-label` on the input rather than
 * a `<label for>` pair, because `for` needs a document-unique id and this panel
 * can legitimately exist twice at once — the docked toolbar and a floated copy.
 * Two elements sharing an id is the kind of breakage that only shows up in the
 * second instance, where nobody looks.
 */
function sliderGroup(
  labelText: string,
  ariaLabel: string,
  min: number,
  max: number,
  initial: number,
  onChange: (next: number) => void
): { readonly root: HTMLElement; readonly input: HTMLInputElement } {
  const root = el('div', 'viz-toolbar__group')
  root.append(el('span', 'viz-toolbar__label', labelText))

  const input = el('input', 'viz-toolbar__slider')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = '1'
  input.value = String(initial)
  input.setAttribute('aria-label', ariaLabel)
  root.append(input)

  const readout = el('span', 'viz-toolbar__value', String(initial))
  root.append(readout)

  // `input`, not `change`. `change` fires only when the thumb is released, which
  // makes the whole control feel dead while you drag it — and relayout is a few
  // milliseconds on the graphs this panel draws, so there is nothing to save by
  // waiting.
  input.addEventListener('input', () => {
    const next = readSlider(input, initial)
    readout.textContent = String(next)
    onChange(next)
  })

  return { root, input }
}

/**
 * `valueAsNumber` is `NaN` for an empty or non-numeric range input. That should
 * be unreachable with min/max/step set, but the fallback costs one comparison
 * and the alternative is `NaN` reaching `layoutGraph`, which clamps unparseable
 * options to the *maximum* — a slider showing "1" while the canvas draws depth
 * 10.
 */
function readSlider(input: HTMLInputElement, fallback: number): number {
  const raw = input.valueAsNumber
  return Number.isFinite(raw) ? Math.round(raw) : fallback
}

function metricSlot(labelText: string): { readonly root: HTMLElement; readonly value: HTMLElement } {
  const root = el('div', 'viz-toolbar__metric')
  root.append(el('span', 'viz-toolbar__metric-label', labelText))
  const value = el('span', 'viz-toolbar__metric-value', UNKNOWN)
  root.append(value)
  return { root, value }
}

/** Truncation is content, not style, so it belongs here — `nowrap` cannot ellipsise a flex pill. */
function clip(text: string): string {
  return text.length <= MAX_ACTIVE_LABEL_CHARS ? text : `${text.slice(0, MAX_ACTIVE_LABEL_CHARS - 1)}…`
}

function pluralNodes(count: number): string {
  return count === 1 ? '1 node' : `${count} nodes`
}

interface WindowControl {
  readonly state: VisualizerWindowState
  readonly button: HTMLButtonElement
}

/* ------------------------------- the mount ------------------------------- */

export function mountToolbar(host: HTMLElement, callbacks: ToolbarCallbacks): ToolbarHandle {
  const root = el('div', 'viz-toolbar')

  const depth = sliderGroup(
    'Depth',
    'Maximum graph depth',
    MIN_DEPTH,
    MAX_DEPTH,
    DEFAULT_DEPTH,
    callbacks.onMaxDepthChange
  )
  const fan = sliderGroup(
    'Fan-out',
    'Maximum sibling nodes per column',
    MIN_FAN_OUT,
    MAX_FAN_OUT,
    DEFAULT_FAN_OUT,
    callbacks.onFanOutChange
  )
  root.append(depth.root, fan.root)

  const metricsHost = el('div', 'viz-toolbar__metrics')
  const modeSlot = metricSlot('Mode')
  const nodeSlot = metricSlot('Nodes')
  const depthSlot = metricSlot('Depth')
  // Detached until there is something to focus on. An empty "FOCUS —" slot in
  // file mode is a column of nothing that pushes the real numbers left.
  const focusSlot = metricSlot('Focus')
  metricsHost.append(modeSlot.root, nodeSlot.root, depthSlot.root)
  root.append(metricsHost)

  const spacer = el('div', 'viz-toolbar__spacer')
  root.append(spacer)

  const zoomGroup = el('div', 'viz-toolbar__group')
  zoomGroup.setAttribute('role', 'group')
  zoomGroup.setAttribute('aria-label', 'Zoom')
  zoomGroup.append(
    iconButton('Zoom out', ICON_ZOOM_OUT, () => callbacks.onZoom(1 / ZOOM_STEP)),
    iconButton('Zoom in', ICON_ZOOM_IN, () => callbacks.onZoom(ZOOM_STEP)),
    iconButton('Fit graph to view', ICON_FIT, callbacks.onFit)
  )
  root.append(zoomGroup)

  const windowGroup = el('div', 'viz-toolbar__group')
  windowGroup.setAttribute('role', 'group')
  windowGroup.setAttribute('aria-label', 'Panel layout')

  /**
   * Four "go to this state" buttons rather than three toggles. Each one is
   * idempotent and fires even when it is already active: suppressing the call
   * would make the toolbar the authority on what state the panel is *really* in,
   * and it is not — `setWindowState` is, and the integrator can be told
   * otherwise by a drag, a keyboard shortcut or the OS closing a floated window.
   */
  const control = (
    state: VisualizerWindowState,
    label: string,
    path: string
  ): WindowControl => ({
    state,
    button: iconButton(label, path, () => callbacks.onWindowStateChange(state))
  })

  const controls: readonly WindowControl[] = [
    control('minimized', 'Minimize Visualizer', ICON_MINIMIZE),
    control('docked', 'Restore Visualizer to the dock', ICON_RESTORE),
    control('maximized', 'Maximize Visualizer', ICON_MAXIMIZE),
    control('floating', 'Open Visualizer in a floating window', ICON_FLOAT)
  ]
  for (const entry of controls) windowGroup.append(entry.button)
  root.append(windowGroup)

  host.append(root)

  /**
   * Notices are created and destroyed rather than hidden, and that is forced by
   * the stylesheet: `.viz-toolbar__notice` declares `display: flex`, which beats
   * the user-agent rule behind the `hidden` attribute, so a hidden pill would
   * stay on screen. (`.viz-prop__rows` and `.viz-tooltip` *do* carry explicit
   * `[hidden]` rules — those are safe to toggle, this one is not.)
   */
  let notices: HTMLElement[] = []
  /** Rebuilds are skipped when the text is unchanged — see `applyNotices`. */
  let noticeKey = ''

  const buildNotice = (text: string, detail: string | null): HTMLElement => {
    const pill = el('div', 'viz-toolbar__notice', text)
    pill.setAttribute('role', 'status')
    if (detail !== null) pill.title = detail
    return pill
  }

  const applyNotices = (next: ToolbarMetrics): void => {
    const hiddenText =
      next.hiddenCount > 0 ? `${pluralNodes(next.hiddenCount)} hidden by these limits` : ''
    const degraded = next.degradedReason
    const key = `${degraded ?? ''}\u0000${hiddenText}`
    // setMetrics runs on every debounced rebuild, i.e. constantly while typing.
    // Re-creating an identical `role="status"` pill each time would have a screen
    // reader announce "3 nodes hidden" on every keystroke.
    if (key === noticeKey) return
    noticeKey = key

    for (const pill of notices) pill.remove()
    notices = []

    if (degraded !== null && degraded !== '') {
      // Deliberately not the raw parser message. `degradedReason` is usually
      // "Unexpected token (14:3)" from a line the user is halfway through
      // typing; printed as-is in a toolbar it reads as a crash. The sentence
      // says what is true and what the panel is doing instead, and the exact
      // reason lives one hover away for whoever actually wants it.
      notices.push(
        buildNotice('This code does not parse right now — showing lines in source order', degraded)
      )
    }
    if (hiddenText !== '') {
      notices.push(buildNotice(hiddenText, 'Raise Depth or Fan-out to show more of the graph.'))
    }

    // Before the spacer, so the notices stay beside the metrics that caused them
    // rather than drifting over next to the window buttons.
    for (const pill of notices) root.insertBefore(pill, spacer)
  }

  const setMetrics = (next: ToolbarMetrics): void => {
    modeSlot.value.textContent = next.mode === 'file' ? 'File' : 'Selection'
    nodeSlot.value.textContent = String(next.nodeCount)
    depthSlot.value.textContent = String(next.depth)

    const active = next.activeLabel
    if (active === null || active === '') {
      focusSlot.root.remove()
    } else {
      focusSlot.value.textContent = clip(active)
      // The clipped label is the readable one; the full text stays reachable.
      focusSlot.value.title = active
      metricsHost.append(focusSlot.root)
    }

    applyNotices(next)
  }

  const setWindowState = (state: VisualizerWindowState): void => {
    for (const entry of controls) {
      const active = entry.state === state
      entry.button.classList.toggle('viz-toolbar__button--active', active)
      // `aria-pressed` and the class say the same thing to two different
      // audiences. Neither is optional: the class is invisible to a screen
      // reader and the attribute is invisible to everyone else.
      entry.button.setAttribute('aria-pressed', String(active))
    }
  }

  setWindowState('docked')

  return {
    setMetrics,
    setWindowState,
    maxDepth: () => readSlider(depth.input, DEFAULT_DEPTH),
    fanOut: () => readSlider(fan.input, DEFAULT_FAN_OUT),
    // Only our own subtree goes; the host may hold the canvas as a sibling.
    // Listeners are all on nodes inside `root`, so they are collected with it.
    destroy: () => root.remove()
  }
}
