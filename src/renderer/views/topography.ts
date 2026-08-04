import mermaid from 'mermaid'
import svgPanZoom from 'svg-pan-zoom'
import { generateDiagram, lineFromNodeId, type Diagram } from '../editor/ast-parser'
import { emptyState } from '../workbench/side-bar'

/**
 * The Visualizer panel: a live control-flow topography of the current selection.
 *
 * Everything here is local and deterministic — Babel parses, Mermaid draws.
 * Mermaid is bundled through Vite rather than loaded from a CDN, which is not a
 * preference: the renderer ships `connect-src 'none'`, so a CDN fetch would be
 * blocked outright. Only `graph TD` is used, which keeps Mermaid's ELK layout
 * chunk — the one part of the library that spawns a Worker — out of the bundle.
 */

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null
let diagramHost: HTMLElement | null = null
let current: Diagram | null = null
let panZoom: SvgPanZoom.Instance | null = null
let initialised = false
let renderToken = 0

/** Set by main.ts; jumps the editor to a line when a diagram node is clicked. */
let revealLine: ((line: number) => void) | null = null

export function setTopographyRevealHandler(handler: (line: number) => void): void {
  revealLine = handler
}

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

function ensureMermaid(): void {
  if (initialised) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
    fontFamily: 'var(--bcc-font-ui)',
    flowchart: { curve: 'basis', htmlLabels: false },
    themeVariables: {
      // Matched to the near-black workbench theme rather than Mermaid's default
      // slate, which reads as a foreign widget dropped into the panel.
      background: '#121314',
      primaryColor: '#1a1c1e',
      primaryTextColor: '#bcbec4',
      primaryBorderColor: '#3574f0',
      lineColor: '#6f737a',
      secondaryColor: '#232629',
      tertiaryColor: '#0e0f10'
    }
  })
  initialised = true
}

/**
 * `htmlLabels: false` above matters for CSP as well as looks: the HTML-label
 * path injects markup through `foreignObject`, and the SVG path avoids that
 * entirely while still rendering the operators we escape as entities.
 */
export async function renderTopography(code: string, startLine: number): Promise<void> {
  if (diagramHost === null) return

  const token = ++renderToken
  current = generateDiagram(code, startLine)

  ensureMermaid()

  // Render BEFORE touching the DOM. Clearing first and then awaiting means any
  // superseded render — and on a 300ms debounce they supersede constantly —
  // returns early having already blanked the panel, which leaves the
  // Visualizer permanently empty until the next keystroke happens to win.
  let svg: string
  try {
    const result = await mermaid.render(`bcc-topo-${token}`, current.definition)
    svg = result.svg
  } catch (error) {
    if (token !== renderToken) return
    // Mermaid refused the definition. Say so plainly rather than leaving a
    // blank panel that reads as the feature being broken.
    panZoom?.destroy()
    panZoom = null
    diagramHost.replaceChildren(
      el(
        'p',
        'explorer__empty-text',
        `Could not draw this selection: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    )
    renderMeta()
    return
  }

  // A later render already won; leave its output alone.
  if (token !== renderToken) return

  // Only now is the previous diagram replaced. svg-pan-zoom holds listeners on
  // the SVG being discarded, so it is destroyed in the same step.
  panZoom?.destroy()
  panZoom = null
  diagramHost.innerHTML = svg
  const element = diagramHost.querySelector('svg')
  if (element === null) return

  element.removeAttribute('height')
  element.style.width = '100%'
  element.style.height = '100%'
  element.style.maxWidth = 'none'

  try {
    panZoom = svgPanZoom(element, {
      zoomEnabled: true,
      controlIconsEnabled: false,
      fit: true,
      center: true,
      minZoom: 0.2,
      maxZoom: 8
    })
  } catch {
    // Pan/zoom is an enhancement; a static diagram is still useful without it.
  }

  attachNodeClicks(element)
  renderMeta()
}

/**
 * Click-to-source. The line is recovered from the node id (`n3_L42`) rather
 * than from a global callback that Mermaid would have to call by name — this
 * codebase registers listeners explicitly and keeps nothing on `window`.
 */
function attachNodeClicks(svg: SVGElement): void {
  for (const node of svg.querySelectorAll('.node')) {
    const line = lineFromNodeId(node.id)
    if (line === null) continue

    const target = node as SVGElement
    target.classList.add('topo-node--clickable')

    // Not a `click` listener. svg-pan-zoom binds its own mouse handlers to the
    // SVG for panning and the browser never delivers a usable click through
    // them, so navigation silently did nothing. Tracking the press instead —
    // and requiring the pointer to have stayed put — keeps a pan from being
    // mistaken for a click, and a click from being eaten by the panner.
    let downX = 0
    let downY = 0

    target.addEventListener('mousedown', (event) => {
      const mouse = event as MouseEvent
      downX = mouse.clientX
      downY = mouse.clientY
    })

    target.addEventListener('mouseup', (event) => {
      const mouse = event as MouseEvent
      const moved =
        Math.abs(mouse.clientX - downX) > DRAG_THRESHOLD_PX ||
        Math.abs(mouse.clientY - downY) > DRAG_THRESHOLD_PX
      if (moved) return
      mouse.stopPropagation()
      revealLine?.(line)
    })
  }
}

/** Pointer travel above this is a pan, not a click. */
const DRAG_THRESHOLD_PX = 4

function renderMeta(): void {
  if (bodyHost === null || current === null) return
  bodyHost.querySelector('.topo-meta')?.remove()

  const meta = el('div', 'topo-meta')
  meta.append(
    el('span', 'topo-meta__count', `${current.nodeCount} node${current.nodeCount === 1 ? '' : 's'}`)
  )

  if (current.source === 'fallback') {
    const badge = el('span', 'topo-meta__badge', 'sequential')
    badge.title =
      current.error !== null && current.error !== ''
        ? `Could not build a control-flow graph: ${current.error}`
        : 'Nothing branch-like in this selection; showing it in source order.'
    meta.append(badge)
  }
  bodyHost.append(meta)
}

export function mountTopography(title: HTMLElement, body: HTMLElement): void {
  titleHost = title
  bodyHost = body

  titleHost.replaceChildren()
  titleHost.append(el('span', 'right-dock__heading', 'Visualizer'))

  bodyHost.replaceChildren()
  diagramHost = el('div', 'topo-canvas')
  bodyHost.append(diagramHost)

  if (current === null) {
    diagramHost.append(
      emptyState('Select code, or put the cursor inside a function, to see its flow.')
    )
  }
}

export function onTopographyShown(): void {
  // The panel had no size while hidden, so the fitted diagram is stale.
  panZoom?.resize()
  panZoom?.fit()
  panZoom?.center()
}
