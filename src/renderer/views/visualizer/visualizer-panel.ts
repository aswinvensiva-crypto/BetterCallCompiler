import type { CodeGraph, CodeGraphNode, GraphMode } from '../../../shared/code-graph'
import { buildFileGraph, buildSelectionGraph } from '../../editor/code-graph'
import { hideRightDock, isRightDockVisible, showRightDock } from '../../workbench/right-dock'
import { mountSplitter } from '../../workbench/splitter'
import { setVisualizerStatus } from '../../workbench/status-bar'
import { mountCanvas, type CanvasHandle } from './visualizer-canvas'
import { mountInspector, type InspectorHandle } from './visualizer-inspector'
import { layoutGraph, type GraphLayout } from './visualizer-layout'
import {
  mountToolbar,
  type ToolbarHandle,
  type ToolbarMetrics,
  type VisualizerWindowState
} from './visualizer-toolbar'

/**
 * The Visualizer panel: the assembly that turns four independent modules into a
 * feature.
 *
 * Everything below it — the graph builder, the layout engine, the canvas, the
 * toolbar, the inspector — is deliberately ignorant of the others. This is the
 * only file that knows they exist together, so it is the only file that can
 * answer the questions that span them: which graph is current, which node is
 * selected, and what an editor cursor at line 42 has to do with any of it.
 *
 * THE TWO COSTS. Every change arriving from the editor is one of exactly two
 * things, and conflating them is what made the old Mermaid panel feel like it
 * never settled:
 *
 *   - A cursor move inside an already-drawn graph is CHEAP. The graph is still
 *     correct; all that changed is which node the caret is standing in. That is
 *     a scan of `layout.nodes` and a class toggle — no parse, no layout, no
 *     re-render — so it runs immediately (`highlightVisualizerLine`).
 *   - A selection or a content change is EXPENSIVE: a full Babel parse, a
 *     relayout and a wholesale SVG rebuild. That one stays behind the 300ms
 *     debounce main.ts owns (`renderVisualizer`).
 *
 * The sliders are a third case and cheaper still: depth and fan-out change how
 * much of the graph is drawn, never what the graph *is*, so they relayout the
 * `CodeGraph` already in hand and never reparse.
 *
 * WHAT IS DEFERRED. Parsing for a panel nobody is looking at is pure waste, so
 * `renderVisualizer` records the request and returns when the panel is not live.
 * `mountVisualizer` and `onVisualizerShown` replay it, which is why opening the
 * dock never shows a blank canvas waiting for the next keystroke.
 *
 * WHAT IS NOT HERE YET. `.viz-inspector__cfg` — the inspector's embedded
 * thumbnail container — is left empty on purpose. The inspector creates it once
 * and never touches it precisely so an integrator can own it, and the same is
 * true of `setVisualizerFloatHandler`: both are holes cut for the floating-window
 * step, and filling them with a guess now would be work that step has to undo.
 */

/* ------------------------------ tuning knobs ----------------------------- */

/** Below this the property tree's key column collapses and the values wrap to nothing. */
const INSPECTOR_MIN_WIDTH = 200
/** The canvas the splitter must always leave behind — roughly one node column. */
const CANVAS_MIN_WIDTH = 160
/** Fallback for `--bcc-viz-inspector-width`, if the token is ever renamed away. */
const INSPECTOR_FALLBACK_WIDTH = 280

/**
 * Below this the panel drops the inspector entirely rather than showing a
 * canvas and a property tree that are both too narrow to read — it is exactly
 * the width at which the splitter has nowhere left to travel.
 *
 * The dock ships at 460px and cannot be dragged below 280, so this only ever
 * fires in the bottom third of that range. Getting it wrong in the other
 * direction would be far worse: a threshold above the shipped width would hide
 * the inspector by default and nobody would ever see it.
 */
const NARROW_PANEL_WIDTH = CANVAS_MIN_WIDTH + INSPECTOR_MIN_WIDTH

/** Tooltip offset from the pointer, and the gap it keeps from the window edge. */
const TOOLTIP_OFFSET_X = 14
const TOOLTIP_OFFSET_Y = 18
const TOOLTIP_MARGIN = 8
/** A doc comment is prose and can be a paragraph; a tooltip is a glance. */
const TOOLTIP_DOC_MAX_CHARS = 220

/* ------------------------------- module state ---------------------------- */

/**
 * The panel is a module singleton, like every other view in this workbench —
 * the registry mounts it once and main.ts addresses it by imported function
 * rather than by holding a handle. Keeping that shape is what makes the call
 * sites in main.ts a rename rather than a restructure.
 */
let panelRoot: HTMLElement | null = null
let toolbar: ToolbarHandle | null = null
let canvas: CanvasHandle | null = null
let inspector: InspectorHandle | null = null
let tooltip: HTMLElement | null = null

const EMPTY_GRAPH: CodeGraph = {
  mode: 'file',
  nodes: [],
  edges: [],
  source: 'fallback',
  error: null,
  rootIds: []
}

let graph: CodeGraph = EMPTY_GRAPH
let layout: GraphLayout | null = null
let selectedId: string | null = null
let windowState: VisualizerWindowState = 'docked'

/** The last thing main.ts asked for, kept so a deferred parse can be replayed. */
interface GraphRequest {
  readonly code: string
  readonly startLine: number
  readonly mode: GraphMode
}
let request: GraphRequest | null = null
/** True when `request` has changed since the last parse. */
let stale = false

/**
 * The editor caret, remembered across rebuilds.
 *
 * Node ids embed a counter, so every id in the file renumbers when a line is
 * added above — a selection can never survive a rebuild by id. A line number
 * can, which is why the highlight is re-derived from this after every relayout
 * instead of being carried over.
 */
let cursorLine: number | null = null

/** Set by main.ts; jumps the editor to a line. */
let revealLine: ((line: number) => void) | null = null
/** Injected by the floating-window step; null until then. */
let floatWindow: (() => void) | null = null

/** Notified after a parse, so a detached window can be fed the same graph. */
const graphListeners = new Set<(graph: CodeGraph, selectedNodeId: string | null) => void>()

/** Only rebuilt when the hovered node changes; hover fires on every pointer move. */
let tooltipNodeId: string | null = null

let inspectorWidth = INSPECTOR_FALLBACK_WIDTH

/* ------------------------------- DOM helper ------------------------------ */

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

/* -------------------------------- lookups -------------------------------- */

function nodeById(id: string): CodeGraphNode | undefined {
  return graph.nodes.find((node) => node.id === id)
}

function isLaidOut(id: string): boolean {
  return layout !== null && layout.nodes.some((laid) => laid.node.id === id)
}

function drawnCount(): number {
  if (layout === null) return 0
  return layout.nodes.filter((laid) => !laid.isOverflow).length
}

/**
 * THE LINE → NODE RESOLUTION, and it is the whole bidirectional link.
 *
 * Locations nest: a `return` on line 4 sits inside an `if` that sits inside a
 * function that spans lines 1–10, so line 4 is covered by three nodes at once
 * and picking any of them is defensible. The smallest span wins because that is
 * what the caret is *in* — highlighting the enclosing function while the caret
 * sits on one specific return says nothing the file tree does not already say.
 *
 * Ties go to the LAST match. Both graph builders emit outer constructs before
 * the constructs inside them, so among two nodes covering the same single line
 * the later one is the more deeply nested. (A `for` header and the call on the
 * same line is the everyday case.)
 *
 * The search is over the LAID-OUT nodes rather than over `graph.nodes`, so it
 * can only ever return something the user can actually see: a node the depth or
 * fan-out limit removed would otherwise be selected, dim the entire drawing to
 * highlight nothing, and look exactly like a rendering bug.
 */
function nodeCoveringLine(line: number): string | null {
  const current = layout
  if (current === null) return null

  let best: string | null = null
  let bestSpan = Number.POSITIVE_INFINITY

  for (const laid of current.nodes) {
    // The "+N more" placeholder carries an all-zero location and stands for no
    // source at all; line 0 exists nowhere, but the guard is explicit because a
    // silent match here would highlight a counter.
    if (laid.isOverflow) continue
    const { startLine, endLine } = laid.node.location
    if (startLine < 1) continue
    if (line < startLine || line > endLine) continue

    const span = endLine - startLine
    if (span <= bestSpan) {
      bestSpan = span
      best = laid.node.id
    }
  }

  return best
}

/* ------------------------------- selection ------------------------------- */

/**
 * The single place `selectedId`, the canvas highlight and the inspector are
 * brought into agreement.
 *
 * There is one case they can still drift: Escape on the canvas clears its own
 * highlight without reporting it, because `onSelect` has no way to say
 * "nothing". The canvas documents that; the consequence here is an inspector
 * that briefly describes a node that is no longer outlined, and it corrects
 * itself on the next click or cursor move. Fixing it properly means widening
 * `CanvasCallbacks`, which is not this step's file to widen.
 */
function select(nodeId: string | null, reveal: boolean): void {
  const node = nodeId === null ? undefined : nodeById(nodeId)
  selectedId = node === undefined ? null : nodeId

  canvas?.setSelected(selectedId)
  if (node === undefined) {
    inspector?.clear()
  } else {
    inspector?.show(node, graph)
    // Only pans when the node is off screen — see `revealNode`. This runs on
    // every cursor move, and a canvas that re-centres each time the caret
    // crosses a line is a canvas that twitches.
    if (reveal) canvas?.revealNode(node.id)
  }

  refreshReadouts()
}

/** The cheap path's body, also replayed after every rebuild. */
function applyCursorHighlight(): void {
  const line = cursorLine
  if (line === null) return

  const found = nodeCoveringLine(line)
  // No match means the caret is somewhere the graph does not describe — between
  // two functions, in an import block. The previous highlight is deliberately
  // left alone rather than cleared: scrolling through a file's preamble would
  // otherwise strobe the whole drawing in and out of dimming.
  if (found === null || found === selectedId) return
  select(found, true)
}

/* ------------------------------- readouts -------------------------------- */

function metrics(): ToolbarMetrics {
  const active = selectedId === null ? null : (nodeById(selectedId)?.label ?? null)
  return {
    mode: graph.mode,
    // The drawn count rather than `graph.nodes.length`, because it sits beside
    // the hidden count and the two have to add up to something the user can
    // reconcile with what is in front of them.
    nodeCount: drawnCount(),
    depth: layout?.depth ?? 0,
    hiddenCount: layout?.hiddenCount ?? 0,
    activeLabel: active,
    // `error` is null on the genuinely-empty graph, which is not a degradation
    // and has nothing to explain.
    degradedReason: graph.source === 'fallback' ? graph.error : null
  }
}

function pluralNodes(count: number): string {
  return count === 1 ? '1 node' : `${count} nodes`
}

/**
 * The status-bar foothold, which exists for exactly one state.
 *
 * A minimized Visualizer has hidden its whole region, so without this the panel
 * vanishes with no trace of what it was showing and no way back except finding
 * the right activity-bar icon. Every other state clears the entry rather than
 * leaving a duplicate readout of something already on screen.
 */
function updateStatusSummary(): void {
  if (windowState !== 'minimized') {
    setVisualizerStatus(null)
    return
  }

  const active = selectedId === null ? null : (nodeById(selectedId)?.label ?? null)
  setVisualizerStatus({
    label: active === null ? 'Visualizer' : `Visualizer · ${active}`,
    detail: pluralNodes(drawnCount()),
    onActivate: () => applyWindowState('docked')
  })
}

function refreshReadouts(): void {
  toolbar?.setMetrics(metrics())
  updateStatusSummary()
}

/* -------------------------------- tooltip -------------------------------- */

function clipDoc(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= TOOLTIP_DOC_MAX_CHARS
    ? flat
    : `${flat.slice(0, TOOLTIP_DOC_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * The facts the canvas had no room for. Kind is always present; the rest join
 * only when they exist, so absence in this line means "the parser established
 * nothing here" rather than "zero".
 */
function metaLine(node: CodeGraphNode): string {
  const parts: string[] = [node.kind]

  const { startLine, endLine } = node.location
  if (startLine >= 1) {
    parts.push(endLine > startLine ? `lines ${startLine}–${endLine}` : `line ${startLine}`)
  }

  const nodeMetrics = node.metrics
  if (nodeMetrics !== null) parts.push(`cx ${nodeMetrics.cyclomaticComplexity}`)

  return parts.join(' · ')
}

function positionTooltip(element: HTMLElement, clientX: number, clientY: number): void {
  // Measured after the content is in place, because the box is sized by its
  // text — reading the rect first would clamp against the previous node's
  // dimensions and let a taller tooltip run off the bottom of the window.
  const box = element.getBoundingClientRect()
  const left = Math.min(clientX + TOOLTIP_OFFSET_X, window.innerWidth - box.width - TOOLTIP_MARGIN)
  const top = Math.min(clientY + TOOLTIP_OFFSET_Y, window.innerHeight - box.height - TOOLTIP_MARGIN)
  element.style.left = `${Math.max(TOOLTIP_MARGIN, left)}px`
  element.style.top = `${Math.max(TOOLTIP_MARGIN, top)}px`
}

function showTooltip(nodeId: string | null, clientX: number, clientY: number): void {
  const element = tooltip
  if (element === null) return

  const node = nodeId === null ? undefined : nodeById(nodeId)
  if (node === undefined) {
    tooltipNodeId = null
    element.hidden = true
    return
  }

  // The canvas reports hover on every pointer move so the tooltip can track the
  // pointer; rebuilding the same three elements sixty times a second to say the
  // same thing is the part that has to be avoided, not the repositioning.
  if (node.id !== tooltipNodeId) {
    tooltipNodeId = node.id
    const rows: HTMLElement[] = [el('div', 'viz-tooltip__title', node.label)]
    const signature = node.signature
    if (signature !== null && signature !== '') {
      rows.push(el('div', 'viz-tooltip__signature', signature))
    }
    const doc = node.jsDoc
    if (doc !== null && doc.trim() !== '') rows.push(el('div', 'viz-tooltip__doc', clipDoc(doc)))
    rows.push(el('div', 'viz-tooltip__meta', metaLine(node)))
    element.replaceChildren(...rows)
  }

  element.hidden = false
  positionTooltip(element, clientX, clientY)
}

/* ------------------------------ reveal source ---------------------------- */

/**
 * Click-to-source. Refuses anything without a real location: the overflow
 * placeholder is a count of hidden siblings and its all-zero location would
 * scroll the editor to nowhere, which reads as click-to-source being broken
 * rather than as the node being inert.
 */
function revealNodeSource(nodeId: string): void {
  const node = nodeById(nodeId)
  if (node === undefined) return
  const line = node.location.startLine
  if (line < 1) return
  revealLine?.(line)
}

/* ------------------------------ graph pipeline --------------------------- */

/**
 * Whether a parse is worth paying for.
 *
 * Minimized deliberately counts as live: the status-bar summary is the entire
 * point of that state, and one that freezes the moment you minimize is worse
 * than none. A dock closed from the activity bar is a different statement —
 * nobody is reading anything — so the parse waits for `onVisualizerShown`.
 */
function isLive(): boolean {
  if (canvas === null) return false
  return isRightDockVisible() || windowState === 'minimized'
}

function rebuildGraph(): void {
  const pending = request
  if (pending === null) return
  stale = false

  graph =
    pending.mode === 'file'
      ? buildFileGraph(pending.code, pending.startLine)
      : buildSelectionGraph(pending.code, pending.startLine)

  // Ids renumber on every edit, so nothing carries over by id. The highlight is
  // re-derived from `cursorLine` at the end of `relayout`.
  selectedId = null
  inspector?.clear()
  relayout()

  // Only a *parse* is announced. A slider move relayouts the same graph, and a
  // detached window has its own sliders — re-pushing there would overwrite the
  // limits its user just chose with the ones this user is holding.
  for (const listener of graphListeners) listener(graph, selectedId)
}

/**
 * Re-runs layout against the toolbar's current limits and repaints.
 *
 * Called for a new graph *and* for a slider move, which is the point: the
 * sliders are a view over the same `CodeGraph` and must never trigger a parse.
 */
function relayout(): void {
  const view = canvas
  const bar = toolbar
  if (view === null || bar === null) return

  layout = layoutGraph(graph, { maxDepth: bar.maxDepth(), fanOut: bar.fanOut() })
  view.render(layout)

  // `render` silently drops a selection whose node the new limits hid. Mirror
  // it, or the inspector goes on describing a box that is no longer drawn.
  if (selectedId !== null && !isLaidOut(selectedId)) {
    selectedId = null
    inspector?.clear()
    view.setSelected(null)
  }
  // A re-render replaces every element, so a tooltip anchored to the old DOM is
  // pointing at nothing.
  showTooltip(null, 0, 0)

  applyCursorHighlight()
  refreshReadouts()
}

/* ------------------------------ window states ---------------------------- */

/**
 * Moves the panel between its four presentations.
 *
 * The four toolbar buttons are "go to this state" rather than toggles and fire
 * even when already active, so this has to be idempotent — which it is, since
 * every branch sets the full state rather than flipping it.
 */
function applyWindowState(next: VisualizerWindowState): void {
  const root = panelRoot
  if (root === null) return

  let resolved = next
  if (next === 'floating') {
    const handler = floatWindow
    // The float button must never be dead. Until the floating-window step lands
    // there is nothing to call, and 'maximized' is the honest neighbour — the
    // user asked for more room and gets more room. Silently doing nothing would
    // read as a broken button; disabling it would need the toolbar to know
    // about a capability it has no way to be told about.
    if (handler === null) resolved = 'maximized'
    else handler()
  }

  windowState = resolved
  root.classList.toggle('viz-panel--maximized', resolved === 'maximized')

  // Maximized is a `position: fixed` overlay that still lives inside the dock's
  // subtree, so a hidden dock takes it with it — it has to reopen the region as
  // much as 'docked' does.
  if (resolved === 'minimized') hideRightDock()
  else if (resolved !== 'floating') showRightDock()

  toolbar?.setWindowState(resolved)
  refreshReadouts()
  // Every transition above changes the canvas's box. An SVG fitted while its
  // container was collapsed fitted against a zero rect and is blank until
  // something asks it again; this is that something.
  canvas?.resize()
}

/* -------------------------------- the mount ------------------------------ */

/**
 * Reads the shipped inspector width out of the theme rather than repeating it.
 *
 * Same reasoning as `cssPixels` in main.ts: theme.css is where the sizes are
 * written down, and a second copy here is a second thing to keep in step. The
 * fallback covers the token being renamed out from under this call — zero would
 * collapse the inspector with no handle left to drag it back.
 */
function readInspectorWidth(): number {
  const parsed = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--bcc-viz-inspector-width')
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : INSPECTOR_FALLBACK_WIDTH
}

/**
 * The canvas, the splitter and the inspector are appended as DIRECT children of
 * `.viz-panel__main`, with no wrappers.
 *
 * That is forced by the stylesheet: `.viz-panel__main` is a three-column grid
 * and `.viz-panel--no-inspector` collapses it to one while hiding
 * `.viz-inspector` and `.viz-panel__splitter` by class. Wrapping either in a
 * host of our own leaves the wrapper as a grid item that nothing hides, and it
 * flows into an implicit second row underneath the canvas.
 */
function buildBody(body: HTMLElement): void {
  const root = el('div', 'viz-panel')
  panelRoot = root
  // Attached BEFORE anything is mounted into it, not after. Two things below
  // measure as they are built — the splitter clamps the inspector against
  // `root.clientWidth`, the canvas fits against its own rect — and a detached
  // subtree measures zero, which would clamp the inspector to its minimum on
  // every mount and leave the canvas owing a fit it has no reason to pay.
  body.replaceChildren(root)

  const bar = mountToolbar(root, {
    // Both sliders relayout and neither reparses. See the module header.
    onMaxDepthChange: () => relayout(),
    onFanOutChange: () => relayout(),
    onWindowStateChange: applyWindowState,
    onFit: () => canvas?.fit(),
    onZoom: (factor) => canvas?.zoomBy(factor)
  })
  toolbar = bar
  // The toolbar starts every mount reporting 'docked'; a panel remounted while
  // maximized would otherwise show the wrong button lit.
  bar.setWindowState(windowState)

  const main = el('div', 'viz-panel__main')
  root.append(main)

  canvas = mountCanvas(main, {
    onSelect: (nodeId) => select(nodeId, false),
    onActivate: revealNodeSource,
    onHover: showTooltip
  })

  const handle = el('div', 'viz-panel__splitter splitter splitter--vertical')
  main.append(handle)

  inspector = mountInspector(main, {
    onNavigate: (nodeId) => {
      // A chip can name a callee that is not in this graph at all — normal in
      // selection mode, where the callee lives outside the highlighted range.
      // `select` would clear the drawer; leaving it alone is better, and the
      // chip's own title already says the target is not here.
      if (nodeById(nodeId) === undefined) return
      select(nodeId, true)
    },
    onReveal: (line) => revealLine?.(line)
  })

  inspectorWidth = readInspectorWidth()
  root.style.setProperty('--bcc-viz-inspector-width', `${inspectorWidth}px`)
  mountSplitter(handle, {
    axis: 'x',
    min: INSPECTOR_MIN_WIDTH,
    max: () => Math.max(INSPECTOR_MIN_WIDTH, root.clientWidth - CANVAS_MIN_WIDTH),
    get: () => inspectorWidth,
    set: (px) => {
      inspectorWidth = px
      root.style.setProperty('--bcc-viz-inspector-width', `${px}px`)
    },
    // The inspector is anchored to the right edge, so the handle travelling
    // left is what makes it wider.
    invert: true,
    // Deliberately not persisted. `workbenchLayout` is a strict schema in
    // src/shared, and widening it for a panel-internal split is a change to a
    // contract this step does not own.
    onCommit: () => canvas?.resize()
  })

  tooltip = el('div', 'viz-tooltip')
  tooltip.hidden = true
  // Inside our own subtree rather than on `<body>`: `position: fixed` is
  // viewport-relative regardless, and nothing in the panel's ancestry
  // establishes a containing block for it (no transform, filter or contain), so
  // keeping it here costs nothing and leaves no orphan behind the panel.
  root.append(tooltip)

  /**
   * The dock is draggable down to 280px, at which point a canvas and a property
   * tree side by side are two things that are each too narrow to read. Dropping
   * the inspector gives the graph the whole region back; the property tree is
   * the half that has an alternative (hover), and the canvas is not.
   */
  const observer = new ResizeObserver(() => {
    const narrow = root.clientWidth > 0 && root.clientWidth < NARROW_PANEL_WIDTH
    if (narrow === root.classList.contains('viz-panel--no-inspector')) return
    root.classList.toggle('viz-panel--no-inspector', narrow)
    canvas?.resize()
  })
  observer.observe(root)
}

/* ------------------------------- public API ------------------------------ */

export function mountVisualizer(title: HTMLElement, body: HTMLElement): void {
  // The registry mounts a view exactly once, so this is defensive rather than
  // expected — but a second mount that leaked the first canvas's ResizeObserver
  // onto a detached node is the kind of bug that only shows up as a slow leak.
  canvas?.destroy()
  inspector?.destroy()
  toolbar?.destroy()
  canvas = null
  inspector = null
  toolbar = null

  title.replaceChildren(el('span', 'right-dock__heading', 'Visualizer'))
  buildBody(body)

  // Whatever the editor asked for while the panel did not exist yet. Without
  // this the first open is a blank canvas until the next keystroke.
  rebuildGraph()
}

/**
 * The region was just revealed. Two things are owed: a fit, because the canvas
 * was last measured while its column was collapsed, and a parse, if one was
 * skipped while nobody was looking.
 */
export function onVisualizerShown(): void {
  // Being shown contradicts 'minimized', and the state has to follow or the
  // toolbar reports a state the panel is visibly not in.
  if (windowState === 'minimized') applyWindowState('docked')

  canvas?.resize()
  if (stale) rebuildGraph()
  else applyCursorHighlight()
}

/**
 * Rebuilds the graph. `mode` is 'selection' for a live selection — a
 * control-flow graph of exactly the highlighted range — and 'file' for whole-file
 * structure and calls.
 *
 * Expensive by construction: this parses. main.ts keeps it behind a debounce and
 * behind a check that its own inputs actually changed, so a bare cursor move
 * never reaches here.
 */
export function renderVisualizer(code: string, startLine: number, mode: GraphMode): void {
  request = { code, startLine, mode }
  if (!isLive()) {
    stale = true
    return
  }
  rebuildGraph()
}

/** Click-to-source, set by main.ts. */
export function setVisualizerRevealHandler(handler: (line: number) => void): void {
  revealLine = handler
}

/**
 * Renders a graph built somewhere else — the detached window's only input.
 *
 * It deliberately never parses. The main window has already done that work, and
 * two parses of one buffer can disagree the moment the file changes underneath
 * them: a detached view is meant to be the *same* diagram in another window, not
 * a second opinion about it.
 *
 * Notably absent is a call to `graphListeners`. The window that receives a graph
 * must not announce it, or the push that fed it comes straight back.
 */
export function renderVisualizerGraph(next: CodeGraph, selectedNodeId: string | null): void {
  request = null
  stale = false
  graph = next
  selectedId = null
  inspector?.clear()
  relayout()

  // After `relayout`, because a node the current limits hid is not selectable
  // and `select` would otherwise point the inspector at an undrawn box.
  if (selectedNodeId !== null && isLaidOut(selectedNodeId)) select(selectedNodeId, false)
}

/** Fires after a parse only. Returns an unsubscribe. */
export function onVisualizerGraphChanged(
  listener: (graph: CodeGraph, selectedNodeId: string | null) => void
): () => void {
  graphListeners.add(listener)
  return () => graphListeners.delete(listener)
}

/** The graph on screen, so a window opening late can be handed the current one. */
export function currentVisualizerGraph(): { graph: CodeGraph; selectedNodeId: string | null } {
  return { graph, selectedNodeId: selectedId }
}

/**
 * Cursor moved in the editor: highlight the node covering this line.
 *
 * The cheap path, and it must stay cheap — no parse, no layout, no re-render.
 * The line is remembered even when the panel is not mounted, so the first thing
 * an opened panel does is point at where the user already is.
 */
export function highlightVisualizerLine(line: number): void {
  cursorLine = line
  applyCursorHighlight()
}

/**
 * Injected by the floating-window step. Passing null puts the float button back
 * on its 'maximized' fallback, which is what makes detaching and re-docking a
 * reversible operation rather than a one-way door.
 */
export function setVisualizerFloatHandler(handler: (() => void) | null): void {
  floatWindow = handler
  // A window that closed itself leaves the panel claiming to be floating while
  // it is visibly back in the dock.
  if (handler === null && windowState === 'floating') applyWindowState('docked')
}
