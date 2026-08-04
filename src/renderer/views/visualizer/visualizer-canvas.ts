import type { CodeGraphEdge } from '../../../shared/code-graph'
import type { GraphLayout, LaidOutNode } from './visualizer-layout'
import { buildNode, findNodeId, round2, setAttrs, svgEl } from './visualizer-node'

/**
 * The Visualizer's canvas: a `GraphLayout` painted as SVG, plus everything
 * needed to move around it.
 *
 * This replaces Mermaid and svg-pan-zoom together, and the second half of that
 * is not incidental. svg-pan-zoom binds its own mouse handlers to the root SVG
 * and the browser never delivers a usable `click` through them — `topography.ts`
 * had to reconstruct clicks from `mousedown`/`mouseup` pairs to work around it.
 * It also fits on init and has no notion of preserving a view, which is fatal
 * here: `render` runs on a keystroke debounce, and a canvas that snaps back to
 * fit every time the user types a character is a canvas nobody can use. About
 * 150 lines of transform arithmetic buys zoom-about-the-pointer, a preserved
 * view across re-renders, and a click that works.
 *
 * The transform lives on ONE `<g>`. Nothing else moves, nothing is re-projected
 * per node, and the DOM the layout produces is in graph coordinates throughout —
 * so `revealNode` and hit-testing both reduce to arithmetic on three numbers.
 *
 * There is deliberately NO `viewBox` on the SVG. With one, user units and CSS
 * pixels differ by an implicit factor that every pointer calculation would have
 * to unpick, and getting it wrong is a canvas that pans at the wrong speed and
 * zooms towards the wrong point. Without one, 1 user unit is 1 px and
 * `clientX - rect.left` is directly comparable to a graph coordinate divided by
 * the scale. The cost is that CSS must give `.viz-canvas__svg` a size; the
 * `width`/`height="100%"` presentation attributes below are a floor, not the
 * intent, and CSS overrides them for free.
 *
 * Re-render is wholesale: every `render` rebuilds every element. Diffing an SVG
 * scene against a fresh layout is a real amount of code to save a millisecond on
 * a graph of at most a few hundred nodes, and the layout module already
 * re-derives everything anyway. What is NOT rebuilt is the view — see
 * `isDifferentGraph`.
 *
 * Renderer-side only: no Node, no network, no `window` globals.
 */

/* ------------------------------- public API ------------------------------ */

export interface CanvasCallbacks {
  readonly onSelect: (nodeId: string) => void
  /** Click-to-source: the panel maps the node back to a line and reveals it. */
  readonly onActivate: (nodeId: string) => void
  /** null when the pointer leaves every node. Coordinates are viewport px, for tooltip placement. */
  readonly onHover: (nodeId: string | null, clientX: number, clientY: number) => void
}

export interface CanvasHandle {
  readonly render: (layout: GraphLayout) => void
  readonly setSelected: (nodeId: string | null) => void
  /** Pans so a node is on screen — used when the editor cursor moves. */
  readonly revealNode: (nodeId: string) => void
  readonly fit: () => void
  readonly zoomBy: (factor: number) => void
  readonly resetZoom: () => void
  /** Called when the dock is resized or shown. */
  readonly resize: () => void
  readonly destroy: () => void
}

/* ------------------------------ tuning knobs ----------------------------- */

/** Below 0.15 a node is a smudge; above 4 the type is bigger than the panel. */
const MIN_SCALE = 0.15
const MAX_SCALE = 4
/**
 * `fit` never enlarges past 1:1. A three-node selection blown up to 4x fills the
 * dock with two enormous pills and reads as a rendering bug rather than a graph.
 */
const FIT_MAX_SCALE = 1
const FIT_MARGIN_PX = 18

/**
 * Pointer travel above this was a pan, not a click. `topography.ts` uses the
 * same 4px for the same reason and there is no case for two thresholds.
 */
const DRAG_THRESHOLD_PX = 4
/** Two clicks on the same node inside this window are a double-click. */
const DOUBLE_CLICK_MS = 320

/** Exponential so a zoom step feels the same at 0.2 as at 3. */
const WHEEL_ZOOM_RATE = 0.0015
/** `deltaMode === DOM_DELTA_LINE` reports lines; this is what a line is worth. */
const LINE_DELTA_PX = 16

const KEY_PAN_PX = 56
const KEY_PAN_BOOST = 4
const KEY_ZOOM_STEP = 1.2

/** `revealNode` leaves a node alone unless it is within this of an edge, or past it. */
const REVEAL_MARGIN_PX = 56

/**
 * Edge captions are usually 'true'/'false'/'catch', but a `case` label is an
 * arbitrary expression and the layout parks it mid-curve with nothing to clip
 * it. Long ones get cut here rather than laid across three nodes.
 */
const EDGE_LABEL_MAX_CHARS = 18

/** Anything smaller than this in either axis is a collapsed dock, not a canvas. */
const MIN_HOST_PX = 8

/** Below this share of surviving nodes, the graph is a different graph. See `isDifferentGraph`. */
const GRAPH_IDENTITY_OVERLAP = 0.5

const EMPTY_LAYOUT: GraphLayout = {
  nodes: [],
  edges: [],
  width: 0,
  height: 0,
  depth: 0,
  hiddenCount: 0
}

/**
 * Marker ids must be unique across the DOCUMENT, not the component. The
 * inspector embeds a second canvas on the same page, and two `<marker id="...">`
 * with the same id is not an error anyone reports — `url(#id)` resolves to
 * whichever came first, so one canvas quietly loses every arrowhead. A
 * module-level counter is enough because both canvases are built by this
 * function in this renderer.
 */
let markerSequence = 0

/* ------------------------------ DOM helpers ------------------------------ */

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

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/**
 * The identity of a graph, for the auto-fit decision.
 *
 * NOT the node ids. Ids are `n<counter>_L<line>`, so pressing Enter at the top
 * of a file renumbers every one of them — an id-based signature would call that
 * a brand new graph and refit the view out from under someone who only added a
 * blank line. The counter half is no better on its own: every file's ids start
 * at `n0`, so two different files look identical by it.
 *
 * Kind plus label survives editing elsewhere in the file, differs completely
 * between files, and costs one string per node.
 */
function identityKeys(layout: GraphLayout): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const laid of layout.nodes) {
    // The overflow placeholder is a count, not a construct; it changes whenever
    // the fan-out slider moves and would drag the identity with it.
    if (!laid.isOverflow) keys.add(`${laid.node.kind}|${laid.node.label}`)
  }
  return keys
}

/**
 * Fit only when the graph became a *different* graph.
 *
 * Equality of a whole-graph signature was the first attempt and it is too
 * brittle by an order of magnitude: renaming one variable changes one label,
 * which changes the signature, which refits — mid-keystroke. Overlap degrades
 * gracefully instead. Editing inside a function moves a handful of keys and the
 * view holds; switching files or toggling file/selection mode replaces nearly
 * all of them and the view refits, which is exactly when someone wants it to.
 *
 * An empty set on either side means there is no view worth preserving (or none
 * to preserve it from), so the first drawn graph always fits.
 */
function isDifferentGraph(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  if (previous.size === 0 || next.size === 0) return true
  let shared = 0
  for (const key of next) {
    if (previous.has(key)) shared++
  }
  return shared / Math.max(previous.size, next.size) < GRAPH_IDENTITY_OVERLAP
}

interface EdgeParts {
  readonly edge: CodeGraphEdge
  readonly path: SVGPathElement
  /** Null when the edge has no caption. Dims and highlights with its path. */
  readonly label: SVGTextElement | null
}

/* -------------------------------- mounting ------------------------------- */

export function mountCanvas(host: HTMLElement, callbacks: CanvasCallbacks): CanvasHandle {
  const markerId = `viz-arrow-${++markerSequence}`

  const root = el('div', 'viz-canvas')
  const svg = svgEl('svg', 'viz-canvas__svg')
  setAttrs(svg, {
    width: '100%',
    height: '100%',
    // Focusable, because every other surface in this workbench is. Without it
    // the arrow/zoom keys below have no way of ever being delivered.
    tabindex: '0',
    'aria-label': 'Code graph'
  })

  const defs = svgEl('defs')
  const marker = svgEl('marker')
  setAttrs(marker, {
    id: markerId,
    viewBox: '0 0 8 8',
    // The tip sits on the path's endpoint, which is the target node's left face.
    refX: 7.4,
    refY: 4,
    markerWidth: 6,
    markerHeight: 6,
    orient: 'auto'
  })
  const head = svgEl('path')
  setAttrs(head, {
    d: 'M0.6 0.9 L7.4 4 L0.6 7.1 z',
    // The one paint value in this file, and it names no colour: `context-stroke`
    // resolves to the stroke of the path that referenced the marker, which CSS
    // sets per kind via `viz-edge--true`, `viz-edge--loop-back` and friends. One
    // shared marker with a literal fill could only ever be one colour, so either
    // every arrowhead disagrees with its line or there is a marker per kind and
    // a hex value in TypeScript. Requires Chromium's SVG2 marker context paint,
    // which the renderer has.
    fill: 'context-stroke'
  })
  marker.append(head)
  defs.append(marker)

  const viewport = svgEl('g', 'viz-canvas__viewport')
  svg.append(defs, viewport)
  root.append(svg)
  // Appended rather than `replaceChildren`, so a host shared with the toolbar or
  // the inspector keeps whatever else is in it.
  host.append(root)

  /* ------------------------------- state -------------------------------- */

  let layout: GraphLayout = EMPTY_LAYOUT
  let keys: ReadonlySet<string> = new Set<string>()
  const nodeElements = new Map<string, SVGGElement>()
  const boxes = new Map<string, LaidOutNode>()
  let edgeParts: readonly EdgeParts[] = []
  let emptyMessage: HTMLElement | null = null

  let scale = 1
  let translateX = 0
  let translateY = 0
  /**
   * Set when a fit was asked for while the host had no size. The dock is
   * measured while collapsed — during a layout transition, or before it is first
   * shown — and fitting against a 0x0 rect yields a division by zero, a NaN
   * transform, and a canvas that is blank forever after with nothing in the
   * console. `fit` refuses; this remembers that it owes one.
   */
  let pendingFit = true

  let selectedId: string | null = null
  let hoveredId: string | null = null

  let panning = false
  let activePointer: number | null = null
  let downX = 0
  let downY = 0
  let lastX = 0
  let lastY = 0
  let downNodeId: string | null = null
  let lastClickId: string | null = null
  let lastClickAt = 0

  /* ----------------------------- transform ------------------------------ */

  const applyTransform = (): void => {
    // A non-finite number here is not an error the browser reports: it discards
    // the whole attribute and the drawing disappears, which looks exactly like
    // "the graph failed to build". Same firewall reasoning as the layout
    // module's `round`, at the other end of the pipe.
    if (
      !Number.isFinite(scale) ||
      !Number.isFinite(translateX) ||
      !Number.isFinite(translateY) ||
      scale <= 0
    ) {
      scale = 1
      translateX = 0
      translateY = 0
    }
    viewport.setAttribute(
      'transform',
      `translate(${round2(translateX)} ${round2(translateY)}) scale(${round2(scale)})`
    )
  }

  /** Client rect of the drawing surface, or null while the dock has no size. */
  const surface = (): DOMRect | null => {
    const rect = svg.getBoundingClientRect()
    if (rect.width < MIN_HOST_PX || rect.height < MIN_HOST_PX) return null
    return rect
  }

  /**
   * Zoom about a point, in surface-local px.
   *
   * Zooming about the origin is the version everyone writes first and it makes a
   * large graph unusable: the thing under the cursor slides away, so every zoom
   * step has to be followed by a corrective pan. Holding the graph point under
   * the pointer fixed is two lines and removes the whole problem.
   */
  const zoomAbout = (px: number, py: number, factor: number): void => {
    const next = clampScale(scale * factor)
    if (next === scale) return
    const graphX = (px - translateX) / scale
    const graphY = (py - translateY) / scale
    scale = next
    translateX = px - graphX * scale
    translateY = py - graphY * scale
    applyTransform()
  }

  const zoomAboutCentre = (factor: number): void => {
    const rect = surface()
    if (rect === null) return
    zoomAbout(rect.width / 2, rect.height / 2, factor)
  }

  const fit = (): void => {
    const rect = surface()
    if (rect === null) {
      pendingFit = true
      return
    }
    pendingFit = false

    if (layout.nodes.length === 0 || layout.width <= 0 || layout.height <= 0) {
      scale = 1
      translateX = 0
      translateY = 0
      applyTransform()
      return
    }

    const usableWidth = rect.width - FIT_MARGIN_PX * 2
    const usableHeight = rect.height - FIT_MARGIN_PX * 2
    scale = clampScale(
      Math.min(usableWidth / layout.width, usableHeight / layout.height, FIT_MAX_SCALE)
    )
    // Centred rather than pinned top-left: a graph that is wider than it is tall
    // — which is most of them, the layout runs left to right — otherwise sits
    // against the top edge with all the slack below it.
    translateX = (rect.width - layout.width * scale) / 2
    translateY = (rect.height - layout.height * scale) / 2
    applyTransform()
  }

  /* ------------------------------ selection ----------------------------- */

  /**
   * Dim everything the selection does not touch.
   *
   * This is what `viz-node--dimmed` / `viz-edge--dimmed` / `viz-edge--highlighted`
   * are for, and it is the one thing this canvas does that Mermaid could not:
   * on a forty-node file graph, "which of these does the selected function
   * actually reach" is otherwise a manual trace along overlapping curves.
   *
   * The neighbour set is recomputed per call rather than cached. It is one pass
   * over the edges, and a cache would need invalidating on every render — a
   * stale one dims the wrong half of the drawing, which is worse than free.
   */
  const applySelection = (): void => {
    const target = selectedId
    if (target === null || !nodeElements.has(target)) {
      for (const element of nodeElements.values()) {
        element.classList.remove('viz-node--selected', 'viz-node--dimmed')
      }
      for (const parts of edgeParts) {
        parts.path.classList.remove('viz-edge--highlighted', 'viz-edge--dimmed')
        parts.label?.classList.remove('viz-edge--highlighted', 'viz-edge--dimmed')
      }
      return
    }

    const neighbours = new Set<string>([target])
    for (const laid of layout.edges) {
      if (laid.edge.source === target) neighbours.add(laid.edge.target)
      if (laid.edge.target === target) neighbours.add(laid.edge.source)
    }

    for (const [id, element] of nodeElements) {
      element.classList.toggle('viz-node--selected', id === target)
      element.classList.toggle('viz-node--dimmed', !neighbours.has(id))
    }
    for (const parts of edgeParts) {
      const incident = parts.edge.source === target || parts.edge.target === target
      parts.path.classList.toggle('viz-edge--highlighted', incident)
      parts.path.classList.toggle('viz-edge--dimmed', !incident)
      // The caption belongs to the edge and has to fade with it. It gets the
      // state modifier but NOT the base `viz-edge` class, so a stroke rule aimed
      // at paths can never end up outlining the text.
      parts.label?.classList.toggle('viz-edge--highlighted', incident)
      parts.label?.classList.toggle('viz-edge--dimmed', !incident)
    }
  }

  /* ------------------------------ rendering ----------------------------- */

  const renderEmptyState = (): void => {
    emptyMessage?.remove()
    emptyMessage = null
    if (layout.nodes.length > 0) return

    // A blank canvas and a broken canvas look the same. Saying which one this is
    // costs a line, and the two cases are genuinely different actions for the
    // reader: one is "put the cursor somewhere", the other is "your limits are
    // too tight" — the toolbar owns the sliders that fix it.
    emptyMessage = el(
      'p',
      'viz-empty',
      layout.hiddenCount > 0
        ? `All ${layout.hiddenCount} nodes are hidden at this depth. Raise the depth or fan-out limit to see them.`
        : 'Nothing to draw. Put the cursor inside a function, or select a range of code.'
    )
    root.append(emptyMessage)
  }

  const render = (next: GraphLayout): void => {
    const previousKeys = keys
    layout = next
    keys = identityKeys(next)

    nodeElements.clear()
    boxes.clear()
    const parts: EdgeParts[] = []
    const fragment = document.createDocumentFragment()

    // Edges first, so nodes sit on top of them. Painter's order is the only
    // z-ordering SVG has — there is no z-index — so this loop order IS the
    // layering, and swapping the two blocks buries every node under its arrows.
    for (const laid of next.edges) {
      const path = svgEl('path', `viz-edge viz-edge--${laid.edge.kind}`)
      setAttrs(path, { d: laid.path, 'marker-end': `url(#${markerId})` })
      fragment.append(path)

      let label: SVGTextElement | null = null
      const caption = laid.edge.label
      if (caption !== null && caption !== '') {
        const text =
          caption.length > EDGE_LABEL_MAX_CHARS
            ? `${caption.slice(0, EDGE_LABEL_MAX_CHARS - 1).trimEnd()}…`
            : caption
        label = svgEl('text', 'viz-edge__label', text)
        setAttrs(label, {
          x: round2(laid.labelX),
          y: round2(laid.labelY),
          'text-anchor': 'middle',
          'dominant-baseline': 'central'
        })
        fragment.append(label)
      }

      parts.push({ edge: laid.edge, path, label })
    }
    edgeParts = parts

    for (const laid of next.nodes) {
      const element = buildNode(laid)
      nodeElements.set(laid.node.id, element)
      boxes.set(laid.node.id, laid)
      fragment.append(element)
    }

    viewport.replaceChildren(fragment)
    renderEmptyState()

    // A selection that no longer exists cannot be shown and must not be
    // reported; the panel finds out on its next hover or click.
    if (selectedId !== null && !nodeElements.has(selectedId)) selectedId = null

    if (pendingFit || isDifferentGraph(previousKeys, keys)) fit()
    else applyTransform()

    applySelection()
  }

  /* ----------------------------- interaction ---------------------------- */

  /** Overflow placeholders are inert: no selection, no reveal, no tooltip. */
  const interactiveId = (id: string | null): string | null => {
    if (id === null) return null
    const laid = boxes.get(id)
    if (laid === undefined || laid.isOverflow) return null
    return id
  }

  const reportHover = (id: string | null, clientX: number, clientY: number): void => {
    // Fires on every move while over a node so the tooltip can track the
    // pointer, but only once on leaving — the panel would otherwise be told
    // "nothing" sixty times a second while someone reads the diagram.
    if (id === null && hoveredId === null) return
    hoveredId = id
    callbacks.onHover(id, clientX, clientY)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    // Read the target BEFORE capturing. `setPointerCapture` retargets every
    // subsequent pointer event — including the `pointerup` — at the SVG root, so
    // by the time the click is resolved the original element is unrecoverable.
    downNodeId = findNodeId(event.target)
    downX = event.clientX
    downY = event.clientY
    lastX = event.clientX
    lastY = event.clientY
    panning = true
    activePointer = event.pointerId
    svg.setPointerCapture(event.pointerId)
    // Clicking a canvas should let you then use the keys on it.
    svg.focus({ preventScroll: true })
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (panning && activePointer === event.pointerId) {
      translateX += event.clientX - lastX
      translateY += event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      applyTransform()
      // A tooltip anchored to a node that is sliding under the pointer is
      // nonsense, so hover is suppressed for the duration of the drag.
      if (
        Math.abs(event.clientX - downX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - downY) > DRAG_THRESHOLD_PX
      ) {
        reportHover(null, event.clientX, event.clientY)
      }
      return
    }
    reportHover(interactiveId(findNodeId(event.target)), event.clientX, event.clientY)
  }

  const endPointer = (event: PointerEvent): void => {
    if (activePointer !== event.pointerId) return
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId)
    panning = false
    activePointer = null
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (activePointer !== event.pointerId) return
    const travelled =
      Math.abs(event.clientX - downX) > DRAG_THRESHOLD_PX ||
      Math.abs(event.clientY - downY) > DRAG_THRESHOLD_PX
    endPointer(event)
    if (travelled) return

    const id = interactiveId(downNodeId)
    downNodeId = null
    if (id === null) return

    // Double-click is detected by hand rather than by listening for `dblclick`.
    // The native event is derived from the compatibility mouse sequence, which
    // pointer capture has already retargeted at the SVG root, so it arrives
    // pointing at the wrong element — the same class of problem `topography.ts`
    // hit from the other direction. Two timestamps are cheaper than unpicking it.
    const now = event.timeStamp
    if (id === lastClickId && now - lastClickAt < DOUBLE_CLICK_MS) {
      lastClickId = null
      callbacks.onActivate(id)
      return
    }
    lastClickId = id
    lastClickAt = now

    // Applied locally as well as reported. The panel is expected to echo it back
    // through `setSelected`, but a selection that only appears after a round trip
    // through a debounce feels broken, and re-applying the same id is a no-op.
    selectedId = id
    applySelection()
    callbacks.onSelect(id)
  }

  const onPointerLeave = (event: PointerEvent): void => {
    if (panning) return
    reportHover(null, event.clientX, event.clientY)
  }

  const onWheel = (event: WheelEvent): void => {
    const rect = surface()
    if (rect === null) return
    // Without this the dock scrolls, or the whole workbench zooms on ctrl+wheel.
    // Requires the listener to be registered non-passive.
    event.preventDefault()

    // Firefox and some mice report lines or pages rather than pixels; treating
    // those raw makes one notch of the wheel a 3x zoom.
    const raw = event.deltaY
    const pixels =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? raw * LINE_DELTA_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? raw * rect.height
          : raw

    zoomAbout(
      event.clientX - rect.left,
      event.clientY - rect.top,
      Math.exp(-pixels * WHEEL_ZOOM_RATE)
    )
  }

  const panBy = (dx: number, dy: number): void => {
    translateX += dx
    translateY += dy
    applyTransform()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    // Leave the workbench's own accelerators alone.
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const step = event.shiftKey ? KEY_PAN_PX * KEY_PAN_BOOST : KEY_PAN_PX

    switch (event.key) {
      // Arrows move the VIEW, not the transform: pressing Right shows what is to
      // the right, which means translating the content left.
      case 'ArrowLeft':
        panBy(step, 0)
        break
      case 'ArrowRight':
        panBy(-step, 0)
        break
      case 'ArrowUp':
        panBy(0, step)
        break
      case 'ArrowDown':
        panBy(0, -step)
        break
      case '+':
      case '=':
        zoomAboutCentre(KEY_ZOOM_STEP)
        break
      case '-':
      case '_':
        zoomAboutCentre(1 / KEY_ZOOM_STEP)
        break
      case '0':
        fit()
        break
      case 'Enter':
        if (selectedId !== null) callbacks.onActivate(selectedId)
        break
      case 'Escape':
        // Clears the highlight only. `onSelect` cannot express "nothing", so the
        // panel is not told — see the note in the module header of the panel
        // integration; this is the single place canvas and panel can disagree.
        selectedId = null
        applySelection()
        reportHover(null, 0, 0)
        break
      default:
        return
    }
    event.preventDefault()
  }

  svg.addEventListener('pointerdown', onPointerDown)
  svg.addEventListener('pointermove', onPointerMove)
  svg.addEventListener('pointerup', onPointerUp)
  svg.addEventListener('pointercancel', endPointer)
  svg.addEventListener('pointerleave', onPointerLeave)
  svg.addEventListener('wheel', onWheel, { passive: false })
  svg.addEventListener('keydown', onKeyDown)

  /**
   * The dock is shown, hidden and dragged wider by code this file never sees.
   * `resize()` on the handle covers the calls the panel remembers to make; the
   * observer covers the ones it does not, and specifically the case where the
   * canvas was rendered while collapsed. It only ever settles an owed fit — a
   * blanket refit on resize would throw away the user's pan every time they
   * dragged the dock divider.
   */
  const observer = new ResizeObserver(() => {
    if (pendingFit) fit()
  })
  observer.observe(root)

  /* -------------------------------- handle ------------------------------- */

  return {
    render,

    setSelected: (nodeId: string | null): void => {
      selectedId = nodeId
      applySelection()
    },

    revealNode: (nodeId: string): void => {
      const laid = boxes.get(nodeId)
      const rect = surface()
      if (laid === undefined || rect === null) return

      const centreX = translateX + (laid.x + laid.width / 2) * scale
      const centreY = translateY + (laid.y + laid.height / 2) * scale
      // Only move if it is actually out of the way. This runs on every cursor
      // move, and re-centring a node that is already comfortably on screen makes
      // the canvas twitch each time the caret crosses a line.
      const visible =
        centreX >= REVEAL_MARGIN_PX &&
        centreX <= rect.width - REVEAL_MARGIN_PX &&
        centreY >= REVEAL_MARGIN_PX &&
        centreY <= rect.height - REVEAL_MARGIN_PX
      if (visible) return

      translateX += rect.width / 2 - centreX
      translateY += rect.height / 2 - centreY
      applyTransform()
    },

    fit,

    zoomBy: (factor: number): void => {
      zoomAboutCentre(factor)
    },

    resetZoom: (): void => {
      const rect = surface()
      if (rect === null) return
      // Back to 1:1 about the middle of the panel, which keeps whatever was
      // being looked at roughly where it was. Jumping to the graph origin would
      // be "reset view", and there is already a control for that: `fit`.
      zoomAbout(rect.width / 2, rect.height / 2, 1 / scale)
    },

    resize: (): void => {
      // Nothing else to do: the transform is in px and independent of the
      // surface size, so a resize only matters if a fit is still owed.
      if (pendingFit) fit()
    },

    destroy: (): void => {
      observer.disconnect()
      svg.removeEventListener('pointerdown', onPointerDown)
      svg.removeEventListener('pointermove', onPointerMove)
      svg.removeEventListener('pointerup', onPointerUp)
      svg.removeEventListener('pointercancel', endPointer)
      svg.removeEventListener('pointerleave', onPointerLeave)
      svg.removeEventListener('wheel', onWheel)
      svg.removeEventListener('keydown', onKeyDown)
      nodeElements.clear()
      boxes.clear()
      edgeParts = []
      layout = EMPTY_LAYOUT
      root.remove()
    }
  }
}
