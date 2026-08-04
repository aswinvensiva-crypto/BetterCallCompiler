/**
 * The drag-to-resize handle that sits on every region boundary in the workbench.
 *
 * Built on Pointer Events with `setPointerCapture` rather than the classic
 * document-level mousemove/mouseup pair. The reason is concrete rather than
 * stylistic: the regions either side of a handle install their own mouse
 * handlers — svg-pan-zoom does it over the Visualizer's SVG today (see
 * topography.ts), Monaco does it over the editor — and a 1px handle is a
 * surface the pointer leaves within the first few pixels of any drag. Capturing
 * the pointer routes every subsequent move back here regardless of what it is
 * over, so the drag cannot be swallowed halfway through.
 *
 * The handle owns no geometry of its own. `get`/`set` hand that to the caller,
 * which in this codebase means a CSS custom property on `.workbench`: the grid
 * template stays in the stylesheet instead of being reassembled in TypeScript
 * on every pointermove.
 */

export interface SplitterOptions {
  readonly axis: 'x' | 'y'
  readonly min: number
  readonly max: number | (() => number)
  /** Current size in px. */
  readonly get: () => number
  /** Live update during drag. */
  readonly set: (px: number) => void
  /** Debounced/committed at drag end — used for persistence. */
  readonly onCommit?: (px: number) => void
  /** True when dragging toward -axis grows the region (right/bottom-anchored regions). */
  readonly invert?: boolean
}

/** Arrow-key nudge, and the coarse variant Shift selects. */
const KEY_STEP_PX = 8
const KEY_STEP_COARSE_PX = 48

/**
 * Set on `<body>` while a drag is live. The cursor and `user-select` rules that
 * hang off these live in workbench.css — they have to apply to the whole
 * document, not to the handle, because the pointer spends the drag somewhere
 * else entirely.
 */
const RESIZING_CLASS = 'workbench--resizing'
const RESIZING_AXIS_CLASS = { x: 'workbench--resizing-x', y: 'workbench--resizing-y' } as const

/** Returns a disposer. */
export function mountSplitter(host: HTMLElement, options: SplitterOptions): () => void {
  const alongX = options.axis === 'x'
  const axisClass = RESIZING_AXIS_CLASS[options.axis]

  const resolveMax = (): number => (typeof options.max === 'function' ? options.max() : options.max)

  const clamp = (px: number): number => {
    // `max` is recomputed per call because it usually depends on the window
    // size and on whether the *other* regions are showing. Taking the larger of
    // the two bounds first keeps a window narrower than `min` from inverting
    // the clamp and collapsing the region to a max that is below its minimum.
    const upper = Math.max(options.min, resolveMax())
    return Math.round(Math.min(Math.max(px, options.min), upper))
  }

  host.setAttribute('role', 'separator')
  host.setAttribute('tabindex', '0')
  // A separator between two side-by-side regions is a *vertical* line even
  // though the measurement it changes is horizontal. Naming it after the drag
  // axis instead is the usual mistake here and it reads backwards to a screen
  // reader.
  host.setAttribute('aria-orientation', alongX ? 'vertical' : 'horizontal')
  // Declared here rather than in the stylesheet: without it a touch or pen
  // press is claimed by the browser as a scroll gesture and no pointermove ever
  // reaches this module, and that failure would be invisible until someone
  // mounted a splitter on an element that missed the class.
  host.style.touchAction = 'none'

  function apply(px: number, commit: boolean): void {
    const next = clamp(px)
    options.set(next)
    host.setAttribute('aria-valuenow', String(next))
    host.setAttribute('aria-valuemin', String(options.min))
    host.setAttribute('aria-valuemax', String(Math.max(options.min, resolveMax())))
    if (commit) options.onCommit?.(next)
  }

  // Normalises whatever the caller started with — a persisted size from a
  // wider window can already be out of range on this one — and seeds the aria
  // values. Deliberately not committed: nothing has changed by the user's hand.
  apply(options.get(), false)

  /**
   * Double-click restores the size the region was laid out with at boot, which
   * is the persisted preference when there is one and the stylesheet's token
   * when there is not. It is not "the shipped default": recovering that would
   * mean this module knowing about theme.css, and the size somebody opened the
   * app with is the one they will recognise as home anyway.
   */
  const initial = clamp(options.get())

  let dragPointer: number | null = null
  let dragOrigin = 0
  let dragStartSize = 0

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    dragPointer = event.pointerId
    dragOrigin = alongX ? event.clientX : event.clientY
    dragStartSize = clamp(options.get())
    host.setPointerCapture(event.pointerId)
    host.classList.add('splitter--dragging')
    document.body.classList.add(RESIZING_CLASS, axisClass)
    // Suppresses the text selection the browser would otherwise start from
    // wherever the press landed, which paints across the whole workbench.
    event.preventDefault()
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (dragPointer === null || event.pointerId !== dragPointer) return
    const travel = (alongX ? event.clientX : event.clientY) - dragOrigin
    apply(dragStartSize + (options.invert === true ? -travel : travel), false)
  }

  const onPointerEnd = (event: PointerEvent): void => {
    if (dragPointer === null || event.pointerId !== dragPointer) return
    dragPointer = null
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId)
    host.classList.remove('splitter--dragging')
    document.body.classList.remove(RESIZING_CLASS, axisClass)
    // One commit per drag rather than one per frame. This is the call that
    // reaches the disk, and a pointermove-rate write would be a settings file
    // rewritten sixty times a second.
    apply(options.get(), true)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? KEY_STEP_COARSE_PX : KEY_STEP_PX
    let travel = 0
    if (alongX && event.key === 'ArrowLeft') travel = -step
    else if (alongX && event.key === 'ArrowRight') travel = step
    else if (!alongX && event.key === 'ArrowUp') travel = -step
    else if (!alongX && event.key === 'ArrowDown') travel = step
    if (travel === 0) return

    event.preventDefault()
    // The arrow moves the *handle*, exactly as dragging it would — so on a
    // right-anchored region Left grows it. Mapping the keys to the value
    // instead would send the handle the opposite way from the arrow pressed,
    // which is the more literal reading of the ARIA convention and the more
    // confusing one to use.
    apply(clamp(options.get()) + (options.invert === true ? -travel : travel), true)
  }

  const onDoubleClick = (): void => {
    apply(initial, true)
  }

  host.addEventListener('pointerdown', onPointerDown)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerup', onPointerEnd)
  host.addEventListener('pointercancel', onPointerEnd)
  host.addEventListener('keydown', onKeyDown)
  host.addEventListener('dblclick', onDoubleClick)

  return () => {
    host.removeEventListener('pointerdown', onPointerDown)
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerup', onPointerEnd)
    host.removeEventListener('pointercancel', onPointerEnd)
    host.removeEventListener('keydown', onKeyDown)
    host.removeEventListener('dblclick', onDoubleClick)
    // Disposing mid-drag would otherwise leave the whole document stuck with a
    // resize cursor and no selection.
    document.body.classList.remove(RESIZING_CLASS, axisClass)
  }
}
