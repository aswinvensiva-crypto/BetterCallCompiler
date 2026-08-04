import type { CodeGraphNode, GraphNodeKind } from '../../../shared/code-graph'
import type { LaidOutNode } from './visualizer-layout'

/**
 * The Visualizer's node vocabulary: one `LaidOutNode` in, one SVG `<g>` out.
 *
 * This is split from `visualizer-canvas.ts` so that file can be about
 * *interaction* — transforms, pointers, keys — and this one about what a node
 * looks like. The two change for completely different reasons: the pan/zoom
 * maths is finished the day it works, whereas the node design is the part
 * anyone will actually want to argue about.
 *
 * Hand-built SVG is the whole point of the exercise. Mermaid drew every node as
 * the same box because its node vocabulary is fixed; here a node can carry a
 * badge, a metric and a corner radius that means something, at the cost of
 * having to do the text fitting by hand — see `fitText`.
 *
 * NO COLOUR, NO FONT, NO STROKE is set here. `category` reaches CSS as a
 * `viz-node--<category>` class and stops there; if you find yourself wanting a
 * hex value in this file, the answer is another class name, not an attribute.
 * The only attributes written are geometry, which cannot live in a stylesheet:
 * an SVG `x` cannot come from a custom property.
 *
 * The consequence — and it is a real one — is that every size decision below is
 * made against an *estimate* of text metrics rather than a measurement. CSS owns
 * the font, so this file cannot know it. The estimates are deliberately generous
 * in the direction where being wrong is invisible; each says which way and why.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/* ------------------------------ DOM helpers ------------------------------ */

/**
 * The SVG counterpart of the `el` helper every view in this codebase keeps a
 * local copy of. It is not the same function: SVG elements need a namespace, and
 * `element.className = x` silently does nothing on them because `className` is a
 * read-only `SVGAnimatedString` — a mistake that costs an afternoon exactly once.
 */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  if (className !== undefined) node.setAttribute('class', className)
  if (text !== undefined) node.textContent = text
  return node
}

/** Geometry attributes come in clusters of five or six; naming each one is noise. */
export function setAttrs(
  element: SVGElement,
  attrs: Readonly<Record<string, string | number>>
): void {
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value))
}

/**
 * Two decimals, for the same reason `visualizer-layout.ts` rounds: attribute
 * strings full of `41.66666666666667` are pure payload, and the difference is
 * invisible at any scale this canvas allows.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Walks up from an event target to the owning node group.
 *
 * It lives here rather than in the canvas because this file is what writes
 * `data-node-id`; a reader in another file is one rename away from silently
 * returning null forever. Walking past the SVG root is harmless — nothing else
 * in the workbench carries that attribute — and cheaper than threading a stop
 * element through every call site.
 */
export function findNodeId(target: EventTarget | null): string | null {
  let element: Element | null = target instanceof Element ? target : null
  while (element !== null) {
    // `dataset` comes from the HTMLOrSVGElement mixin, which a bare `Element`
    // does not implement — hence the instanceof rather than a cast.
    if (element instanceof SVGElement) {
      const id = element.dataset['nodeId']
      if (id !== undefined && id !== '') return id
    }
    element = element.parentElement
  }
  return null
}

/* ------------------------------- geometry -------------------------------- */

/**
 * These mirror numbers in `visualizer-layout.ts`, which exports none of them and
 * which this agent may not modify. Duplicating them is the lesser evil: the
 * alternative is guessing the interior of a box whose exterior was sized by
 * those exact constants, and a label budget that disagrees with the box it sits
 * in is the one failure that is guaranteed to be visible.
 *
 * If layout's `LABEL_PADDING_X` or `METRIC_ROW_HEIGHT` ever change, these change
 * with them; nothing enforces that, which is the price of the split.
 */
const PAD_X = 13 // half of layout's LABEL_PADDING_X
const FOOTER_HEIGHT = 16 // layout's METRIC_ROW_HEIGHT, reserved when metrics !== null

/**
 * Label advance width, matching layout's `CHAR_WIDTH` exactly.
 *
 * Matching matters more than accuracy: layout sized every box as
 * `label.length * 6.6 + padding`, so using the same figure here makes truncation
 * a no-op precisely where layout gave the label enough room, and makes it bite
 * precisely where `MAX_NODE_WIDTH` clamped the box or a badge took a bite out of
 * the row. Both are over-estimates of a ~12px UI font (real lower-case Latin is
 * nearer 6.0), which errs towards an ellipsis that was not strictly needed —
 * invisible — rather than a label running out through the side of its box.
 */
const LABEL_CHAR_WIDTH = 6.6

/**
 * Badge and metric text are a caption size that only CSS knows. 5.0 assumes
 * roughly a 10px font and is again a deliberate over-estimate: over-estimating
 * drops a badge that would have fitted, which nobody notices, while
 * under-estimating overlaps two strings, which everybody does.
 */
const SMALL_CHAR_WIDTH = 5.0

const BADGE_HEIGHT = 14
const BADGE_PAD_X = 5
/** Clear space between the badge and whatever it sits beside. */
const BADGE_GAP = 6
/** A label squeezed below this by a badge loses the badge instead. */
const MIN_LABEL_WIDTH = 34
/** Room for `cx 9`. Below this the metric is unreadable and the badge is dropped. */
const MIN_METRIC_WIDTH = 26

const ELLIPSIS = '…'

/**
 * Corner radius by kind — the one piece of shape vocabulary that survives.
 *
 * Rejected: a distinct silhouette per kind, the flowchart convention (diamond
 * for `if`, stadium for terminals, parallelogram for I/O). Two things kill it.
 * The layout module hands over a *rectangle* — width and height computed from
 * the label — and a diamond that encloses that rectangle is roughly twice as
 * wide, so either the label overflows the slanted sides or every decision node
 * blows a hole in the column. And the shapes would have to be drawn by hand per
 * kind, which is a lot of path arithmetic to say something the label ("if",
 * "return x") already says in words.
 *
 * Radius says the same thing quietly and inside the allocated box: declarations
 * are squarish and solid, control constructs are softer, terminals and calls are
 * full pills. `FULL_PILL` is infinite because the cap is `height / 2` anyway —
 * writing the height in here would just be a second place to get it wrong.
 */
const FULL_PILL = Number.POSITIVE_INFINITY
const KIND_RADIUS: Readonly<Record<GraphNodeKind, number>> = {
  entry: 8,
  function: 8,
  method: 8,
  class: 8,
  if: 12,
  switch: 12,
  case: 12,
  for: 12,
  while: 12,
  dowhile: 12,
  try: 12,
  catch: 12,
  finally: 12,
  return: FULL_PILL,
  throw: FULL_PILL,
  call: FULL_PILL,
  leaf: FULL_PILL,
  merge: FULL_PILL
}
const FALLBACK_RADIUS = 8

/* --------------------------------- text ---------------------------------- */

/**
 * Truncates to a pixel budget by counting characters.
 *
 * This exists because an SVG `<text>` does none of it: it does not wrap, it does
 * not ellipsise, and there is no `text-overflow`. Given a string too long for its
 * box it draws the whole thing, straight out through the side and over whatever
 * is next to it. So the budget has to be worked out here, before the string
 * reaches the DOM.
 *
 * Rejected: measuring for real with `getComputedTextLength()`, which is exact.
 * It forces a synchronous layout per node, and `render` runs on a debounce while
 * the user types — a hundred forced reflows per keystroke to save the odd
 * character is a bad trade. Rejected too: an offscreen `<canvas>` and
 * `measureText`, which needs the resolved font, which means `getComputedStyle`
 * per node, which is the same reflow with more steps.
 *
 * `trimEnd` keeps "handle …" from happening when the cut lands on a space.
 */
function fitText(text: string, maxWidth: number, charWidth: number): string {
  if (maxWidth <= 0 || text === '') return ''
  const budget = Math.floor(maxWidth / charWidth)
  if (budget >= text.length) return text
  if (budget <= 1) return ELLIPSIS
  return `${text.slice(0, budget - 1).trimEnd()}${ELLIPSIS}`
}

/** What a string of small text wants, in px. */
function smallTextWidth(text: string): number {
  return text.length * SMALL_CHAR_WIDTH
}

function badgeWidth(text: string): number {
  return smallTextWidth(text) + BADGE_PAD_X * 2
}

/* --------------------------------- badge --------------------------------- */

/**
 * WHICH NODES GET A BADGE, and why most do not.
 *
 * A badge on every node is not a badge, it is a second label — the eye stops
 * being able to use it to find anything. So the rule is: badge only what the
 * rest of the drawing has already lost.
 *
 *   `gen` / `async` — nothing else shows these. Crucially, `category` cannot:
 *       its precedence puts `exported` above `async`, so an exported async
 *       function is coloured "exported" and its asyncness disappears entirely.
 *       The badge is where it comes back. This is also the only badge the layout
 *       module reserves width for (`BADGE_WIDTH`, on `isAsync || isGenerator`).
 *   `ext` — an unresolved call. Worth flagging because it is the one node kind
 *       where click-to-source cannot go anywhere; the badge sets that
 *       expectation before the click rather than after.
 *   `export` — the module's surface, the thing you scan a file graph looking
 *       for. Colour carries it too, but colour is carrying six categories and a
 *       theme; a word is unambiguous.
 *
 * NOT badged: `internal` (the default — a badge on four nodes in five is noise),
 * `control` and `terminal` (the label already reads "if", "catch", "return x";
 * a badge would repeat it in smaller type).
 *
 * One slot, so an `async function*` shows `gen` alone — the generator-ness is
 * the rarer and more structural of the two, and `async*` does not fit anywhere
 * the width budget allows.
 */
function badgeText(node: CodeGraphNode): string | null {
  if (node.isGenerator) return 'gen'
  if (node.isAsync) return 'async'
  if (node.category === 'external') return 'ext'
  if (node.category === 'exported') return 'export'
  return null
}

/**
 * The complexity figure, in whatever room the footer has.
 *
 * `cx` rather than "complexity" because the row is 16px tall in a box that is
 * often 84px wide, and an abbreviation that fits beats a word that is ellipsised
 * into `complex…`. The line count rides along only when it is free.
 */
function metricText(complexity: number, lineCount: number, maxWidth: number): string {
  const long = `cx ${complexity} · ${lineCount} ln`
  const short = `cx ${complexity}`
  const text = smallTextWidth(long) <= maxWidth ? long : short
  return fitText(text, maxWidth, SMALL_CHAR_WIDTH)
}

/* -------------------------------- assembly ------------------------------- */

function groupClass(laid: LaidOutNode): string {
  const classes = ['viz-node', `viz-node--${laid.node.category}`]
  // Overflow nodes stand for hidden siblings and must not read as real code —
  // they have no source location, so every affordance the others have (reveal,
  // inspect, complexity) is a lie on them. The class is how CSS says so; the
  // canvas separately refuses to select or activate them.
  if (laid.isOverflow) classes.push('viz-node--overflow')
  return classes.join(' ')
}

/**
 * Places a badge, or reports that it could not be afforded.
 *
 * THE BADGE IS A PASSENGER. It rides in whatever space the label and the metric
 * leave and is dropped — not shrunk, not overlapped — when there is none. That
 * rule exists because the layout module reserves 22px for a badge and only for
 * async/generator nodes, while `export` at a caption size wants nearer 40. Any
 * other policy trades a readable name for a decoration: `handleReq…` with a
 * neat "export" tag beside it is a worse node than `handleRequest` with none.
 */
function appendBadge(group: SVGGElement, text: string, right: number, centreY: number): void {
  const width = badgeWidth(text)
  const rect = svgEl('rect', 'viz-node__badge')
  setAttrs(rect, {
    x: round2(right - width),
    y: round2(centreY - BADGE_HEIGHT / 2),
    width: round2(width),
    height: BADGE_HEIGHT,
    rx: BADGE_HEIGHT / 2,
    ry: BADGE_HEIGHT / 2
  })

  const label = svgEl('text', 'viz-node__badge-text', text)
  setAttrs(label, {
    x: round2(right - width / 2),
    y: round2(centreY),
    'text-anchor': 'middle',
    // The row's height is known here; the font size inside it is not, and CSS
    // owns it. `dominant-baseline` hands the vertical centring to the renderer,
    // which is the only party that knows both numbers.
    'dominant-baseline': 'central'
  })

  group.append(rect, label)
}

/**
 * Builds one node.
 *
 * ANATOMY — two zones, because the layout module already gave us two:
 *
 *   ┌───────────────────────────────────┐
 *   │ label…                    [badge] │  label row (full height when no metrics)
 *   │ cx 7 · 24 ln              [badge] │  footer row, present iff metrics !== null
 *   └───────────────────────────────────┘
 *
 * The footer is not invented space: `nodeHeight` in the layout module adds
 * exactly `METRIC_ROW_HEIGHT` when `metrics !== null`, so a node with metrics
 * has a 16px strip that is otherwise reserved and empty. Putting the badge there
 * too is what keeps it off the label row, where it would cost characters.
 *
 * The metric is drawn iff `metrics !== null` — not "iff kind is function or
 * method", even though today those are the same set. The reserved strip is keyed
 * off `metrics`, so keying the content off anything else eventually leaves a
 * blank 16px band at the bottom of a node for no visible reason.
 */
export function buildNode(laid: LaidOutNode): SVGGElement {
  const { node, x, y, width, height } = laid

  const group = svgEl('g', groupClass(laid))
  // Hit-testing and `revealNode` both start from this; it is the only link
  // between a DOM element and the graph it came from.
  group.dataset['nodeId'] = node.id

  // Annotated as possibly-undefined for the same reason `visualizer-layout.ts`
  // does it: the record covers every declared kind, but a graph that reached the
  // renderer without passing `codeGraphSchema` could carry one this build has
  // never heard of, and `undefined` in an `rx` attribute is an invalid value the
  // browser reports nowhere.
  const declared: number | undefined = KIND_RADIUS[node.kind]
  const radius = Math.min(declared ?? FALLBACK_RADIUS, height / 2, width / 2)

  const shape = svgEl('rect', 'viz-node__shape')
  setAttrs(shape, {
    x: round2(x),
    y: round2(y),
    width: round2(width),
    height: round2(height),
    rx: round2(radius),
    ry: round2(radius)
  })
  group.append(shape)

  const metrics = node.metrics
  const hasFooter = metrics !== null && !laid.isOverflow
  const labelCentreY = hasFooter ? y + (height - FOOTER_HEIGHT) / 2 : y + height / 2
  const inner = width - PAD_X * 2

  // Overflow placeholders are a count, not a step: centred, unadorned, and
  // deliberately missing everything that implies a real construct.
  if (laid.isOverflow) {
    const centred = svgEl('text', 'viz-node__label', fitText(node.label, inner, LABEL_CHAR_WIDTH))
    setAttrs(centred, {
      x: round2(x + width / 2),
      y: round2(labelCentreY),
      'text-anchor': 'middle',
      'dominant-baseline': 'central'
    })
    group.append(centred)
    return group
  }

  const badge = badgeText(node)
  let labelWidth = inner
  let footerBadge: string | null = null
  let rowBadge: string | null = null

  if (badge !== null) {
    if (hasFooter) {
      // Free real estate, unless the metric would be crushed by it.
      const remaining = inner - badgeWidth(badge) - BADGE_GAP
      if (remaining >= MIN_METRIC_WIDTH) footerBadge = badge
    } else {
      // No footer, so the badge has to come out of the label's row. It is worth
      // it only while the label can still be read: `min(floor, natural)` means a
      // three-character label never loses its badge for a rule aimed at long ones.
      const natural = node.label.length * LABEL_CHAR_WIDTH
      const remaining = inner - badgeWidth(badge) - BADGE_GAP
      if (remaining >= Math.min(MIN_LABEL_WIDTH, natural)) {
        labelWidth = remaining
        rowBadge = badge
      }
    }
  }

  const label = svgEl('text', 'viz-node__label', fitText(node.label, labelWidth, LABEL_CHAR_WIDTH))
  setAttrs(label, {
    x: round2(x + PAD_X),
    y: round2(labelCentreY),
    'dominant-baseline': 'central'
  })
  group.append(label)

  // No `<title>` element, deliberately. The full label is worth showing when it
  // has been ellipsised, but the canvas already reports hover so the panel can
  // draw `viz-tooltip` — and a native title tooltip fading in a second later, on
  // top of it, saying a subset of the same thing, is worse than not having it.
  if (rowBadge !== null) appendBadge(group, rowBadge, x + width - PAD_X, labelCentreY)

  // The second test is for the compiler, not the runtime: `hasFooter` already
  // implies it, but narrowing does not survive being stored in a boolean.
  if (hasFooter && metrics !== null) {
    const footerCentreY = y + height - FOOTER_HEIGHT / 2
    const badgeCost = footerBadge === null ? 0 : badgeWidth(footerBadge) + BADGE_GAP
    const metric = svgEl(
      'text',
      'viz-node__metric',
      metricText(metrics.cyclomaticComplexity, metrics.lineCount, inner - badgeCost)
    )
    setAttrs(metric, {
      x: round2(x + PAD_X),
      y: round2(footerCentreY),
      'dominant-baseline': 'central'
    })
    group.append(metric)

    if (footerBadge !== null) appendBadge(group, footerBadge, x + width - PAD_X, footerCentreY)
  }

  return group
}
