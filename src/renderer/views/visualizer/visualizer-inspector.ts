import type { CodeGraph, CodeGraphNode } from '../../../shared/code-graph'
import { notify, notifyError } from '../../workbench/notifications'
import { emptyState } from '../../workbench/side-bar'

/**
 * The Visualizer's inspector drawer: everything the graph builder knows about
 * one node, as a property tree.
 *
 * The canvas can only show a name and a colour — a box 180px wide cannot carry a
 * signature, a doc comment and a call list, and a tooltip that tried would be a
 * wall of text that vanishes when you reach for it. So the drawer is where the
 * detail goes, and its one rule is that everything in it is a fact the parser
 * actually established. There is no type checker behind any of this: a parameter
 * with no annotation says "no type annotation" rather than guessing `any`, and a
 * caller id that is not in this graph is printed raw rather than being resolved
 * to a plausible-looking name. Null and empty fields are omitted entirely, which
 * is the only reason absence can be read as information here.
 *
 * Rows are built as a DATA MODEL first (`PropGroup[]`) and then rendered twice —
 * once into the DOM, once into the clipboard text. That indirection buys one
 * specific thing: Copy cannot drift from what is on screen. The obvious
 * alternative, walking the rendered DOM back out with `textContent`, would keep
 * them in sync too, but it copies whatever the stylesheet happened to do
 * (collapsed groups, ellipses) rather than the record, and it makes the
 * clipboard format hostage to markup changes.
 *
 * This module writes NO CSS and sets no colours or sizes. It sets pinned class
 * names, ARIA state, and the `d`/`viewBox` of the disclosure chevron — geometry
 * has nowhere else to live. `fill="none" stroke="currentColor"` on that path is
 * not a colour: `.viz-prop__chevron` styles size and rotation only, so an
 * unqualified path renders as a filled black wedge, and `currentColor` hands the
 * actual value back to `.viz-prop__group`'s `color`. It is the same idiom
 * `explorer.ts` uses for the file-tree chevron this one deliberately mirrors.
 */

/* ------------------------------- public API ------------------------------ */

export interface InspectorCallbacks {
  /** A caller/callee chip was clicked — select that node. */
  readonly onNavigate: (nodeId: string) => void
  /** Jump the editor to a line. */
  readonly onReveal: (line: number) => void
}

export interface InspectorHandle {
  readonly show: (node: CodeGraphNode, graph: CodeGraph) => void
  readonly clear: () => void
  readonly destroy: () => void
}

/* ------------------------------- row model ------------------------------- */

interface PropChip {
  readonly id: string
  /** The target node's label, or the raw id when the graph does not contain it. */
  readonly label: string
  readonly resolved: boolean
}

type PropValue =
  | { readonly kind: 'text'; readonly text: string; readonly mono: boolean }
  | { readonly kind: 'line'; readonly text: string; readonly line: number }
  | { readonly kind: 'chips'; readonly chips: readonly PropChip[] }

interface PropRow {
  readonly key: string
  readonly value: PropValue
}

interface PropGroup {
  /** Stable across nodes — it is the key the collapse state is remembered under. */
  readonly id: string
  readonly label: string
  readonly rows: readonly PropRow[]
}

function textRow(key: string, text: string, mono = false): PropRow {
  return { key, value: { kind: 'text', text, mono } }
}

/* -------------------------------- helpers -------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Points right; `.viz-prop__chevron` rotates it 90° while the group is expanded. */
const CHEVRON_PATH = 'M6 4l4 4-4 4'
/** Two sheets of paper, the front one overlapping the back. */
const COPY_PATH = 'M6 6h7v7H6zM10 6V3H3v7h3'

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

/** SVG `className` is a read-only `SVGAnimatedString`; assigning it fails silently. */
function svg<K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  if (className !== undefined) node.setAttribute('class', className)
  return node
}

function strokedIcon(className: string | undefined, path: string, strokeWidth: string): SVGSVGElement {
  const root = svg('svg', className)
  root.setAttribute('viewBox', '0 0 16 16')
  root.setAttribute('aria-hidden', 'true')

  const shape = svg('path')
  shape.setAttribute('d', path)
  shape.setAttribute('fill', 'none')
  shape.setAttribute('stroke', 'currentColor')
  shape.setAttribute('stroke-width', strokeWidth)
  shape.setAttribute('stroke-linecap', 'round')
  shape.setAttribute('stroke-linejoin', 'round')
  root.append(shape)
  return root
}

/**
 * Written in the positive direction on purpose. A `value is null` predicate
 * would narrow the *true* branch to `null` while happily returning true for
 * `''`, which is a false assertion the compiler then trusts. This one only
 * asserts on the branch where the value is used, and there it is sound.
 */
function isPresent(value: string | null): value is string {
  return value !== null && value.trim() !== ''
}

/* ------------------------------ row building ----------------------------- */

function describeVisibility(visibility: CodeGraphNode['visibility']): string | null {
  switch (visibility) {
    case 'exported':
      return 'exported'
    case 'default-exported':
      return 'default export'
    case 'internal':
      return 'internal'
    case null:
      return null
  }
}

/**
 * `kind` leads the group even though it is not part of any signature, because it
 * is the only fact that is present on *every* node and it is the one that makes
 * the rest legible — "if" versus "function" is the difference between a drawer
 * with one row and a drawer that looks broken. Rejected: a separate one-row
 * "Node" group (a tree of one-row groups is a list wearing a costume) and
 * putting it in the header (that space belongs to the label, which is already
 * fighting for it).
 *
 * Parameters sit between the signature and the return type — reading order of
 * the thing they belong to. Each key is the parameter's own name, so a reader
 * scanning the key column sees the call shape without having to parse the
 * signature string. The cost is that a parameter named `Returns` would look like
 * a property row; that is acceptable and the alternative (prefixing every one)
 * is noise on every function to guard against a name nobody writes.
 */
function signatureRows(node: CodeGraphNode): readonly PropRow[] {
  const rows: PropRow[] = [textRow('Kind', node.kind)]

  if (isPresent(node.signature)) rows.push(textRow('Signature', node.signature, true))

  for (let index = 0; index < node.params.length; index++) {
    const param = node.params[index]
    if (param === undefined) continue
    // A destructured or otherwise unnameable parameter still occupies a
    // position, and the position is the useful part.
    const name = param.name.trim() === '' ? `parameter ${index + 1}` : param.name
    if (isPresent(param.type)) {
      rows.push(textRow(name, param.type, true))
    } else {
      // Never invent one. There is no inference behind this panel, and a guessed
      // type presented in the same slot as a declared one is a lie with a
      // monospace font on.
      rows.push(textRow(name, 'no type annotation'))
    }
  }

  if (isPresent(node.returnType)) rows.push(textRow('Returns', node.returnType, true))

  // Only when true. "Async: no" on every synchronous node is a row that carries
  // no information and pushes the ones that do off the bottom; absence already
  // means exactly what the false value would say.
  if (node.isAsync) rows.push(textRow('Async', 'yes'))
  if (node.isGenerator) rows.push(textRow('Generator', 'yes'))

  const visibility = describeVisibility(node.visibility)
  if (visibility !== null) rows.push(textRow('Visibility', visibility))

  return rows
}

/**
 * Every real position in this app is 1-based, so line 0 is not a line — it is
 * the sentinel the layout's "+N more" placeholder carries, and that node stands
 * for hidden siblings rather than for any source at all. Offering a link would
 * scroll the editor to nowhere and look like a bug in click-to-source.
 */
function locationRows(node: CodeGraphNode): readonly PropRow[] {
  const { startLine, endLine } = node.location
  if (startLine < 1) return [textRow('Lines', 'not in the source')]

  const text = endLine > startLine ? `${startLine}–${endLine}` : String(startLine)
  return [{ key: 'Lines', value: { kind: 'line', text, line: startLine } }]
}

function metricsRows(node: CodeGraphNode): readonly PropRow[] {
  const metrics = node.metrics
  // The whole group disappears rather than showing three empty rows. Only
  // functions and methods carry metrics; for everything else there is nothing
  // being withheld, so there is nothing to explain.
  if (metrics === null) return []
  return [
    textRow('Cyclomatic complexity', String(metrics.cyclomaticComplexity)),
    textRow('Line count', String(metrics.lineCount)),
    textRow('Param count', String(metrics.paramCount))
  ]
}

/**
 * Chips resolve ids to labels through the graph they came from. An id with no
 * node — reachable in selection mode, where the callee lives outside the
 * highlighted range — renders as the raw id instead of crashing on
 * `undefined.label`, and still navigates: whether that target can be *selected*
 * is the canvas's business, and hard-coding the answer here would bake in an
 * assumption about a component this file does not own. The title says which
 * ones those are, so the chip is not quietly lying about being a name.
 */
function callChips(ids: readonly string[], labels: ReadonlyMap<string, string>): readonly PropChip[] {
  const chips: PropChip[] = []
  for (const id of ids) {
    const label = labels.get(id)
    chips.push({ id, label: label ?? id, resolved: label !== undefined })
  }
  return chips
}

function callsRows(node: CodeGraphNode, graph: CodeGraph): readonly PropRow[] {
  if (node.callees.length === 0 && node.callers.length === 0) return []

  const labels = new Map<string, string>()
  for (const other of graph.nodes) labels.set(other.id, other.label)

  const rows: PropRow[] = []
  if (node.callees.length > 0) {
    rows.push({ key: 'Calls', value: { kind: 'chips', chips: callChips(node.callees, labels) } })
  }
  if (node.callers.length > 0) {
    rows.push({ key: 'Called by', value: { kind: 'chips', chips: callChips(node.callers, labels) } })
  }
  return rows
}

function docRows(node: CodeGraphNode): readonly PropRow[] {
  if (!isPresent(node.jsDoc)) return []
  return [textRow('Summary', node.jsDoc)]
}

function buildGroups(node: CodeGraphNode, graph: CodeGraph): readonly PropGroup[] {
  const candidates: readonly PropGroup[] = [
    { id: 'signature', label: 'Signature', rows: signatureRows(node) },
    { id: 'location', label: 'Location', rows: locationRows(node) },
    { id: 'metrics', label: 'Metrics', rows: metricsRows(node) },
    { id: 'calls', label: 'Calls', rows: callsRows(node, graph) },
    { id: 'doc', label: 'Doc', rows: docRows(node) }
  ]
  return candidates.filter((group) => group.rows.length > 0)
}

/* -------------------------------- clipboard ------------------------------ */

function valueText(value: PropValue): string {
  switch (value.kind) {
    case 'text':
      return value.text
    case 'line':
      return value.text
    case 'chips':
      return value.chips.map((chip) => chip.label).join(', ')
  }
}

/**
 * Plain text, and every group regardless of whether it is collapsed. Collapse is
 * a view state — someone who folded "Calls" away to read a signature has not
 * asked for a truncated copy, and a clipboard that silently drops sections is
 * the same failure as a graph that silently drops nodes.
 */
function toPlainText(node: CodeGraphNode, groups: readonly PropGroup[]): string {
  const lines: string[] = [node.label]
  for (const group of groups) {
    lines.push('', group.label)
    for (const row of group.rows) lines.push(`  ${row.key}: ${valueText(row.value)}`)
  }
  return lines.join('\n')
}

/* -------------------------------- rendering ------------------------------ */

function renderValue(row: PropRow, callbacks: InspectorCallbacks): HTMLElement {
  const value = row.value

  if (value.kind === 'line') {
    const link = el('button', 'viz-prop__link', value.text)
    link.type = 'button'
    link.title = 'Reveal in the editor'
    link.addEventListener('click', () => callbacks.onReveal(value.line))
    return link
  }

  if (value.kind === 'chips') {
    // `.viz-prop__chips` spans both grid columns, so the chips land on their own
    // full-width band under the key rather than being squeezed into the value
    // column — which is what makes a list of fifteen callers readable at 280px.
    const wrap = el('div', 'viz-prop__chips')
    for (const chip of value.chips) {
      const button = el('button', 'viz-prop__chip', chip.label)
      button.type = 'button'
      button.title = chip.resolved ? chip.id : `${chip.id} — not in the current graph`
      button.addEventListener('click', () => callbacks.onNavigate(chip.id))
      wrap.append(button)
    }
    return wrap
  }

  // Monospace only for things that are literally source text. A prose fallback
  // like "no type annotation" in a code font reads as a type called
  // "no type annotation".
  return el('span', value.mono ? 'viz-prop__value viz-prop__value--mono' : 'viz-prop__value', value.text)
}

/**
 * One collapsible group: a disclosure button followed by its rows.
 *
 * The rows are a SIBLING of the button, not a child of a wrapper, because
 * `.viz-prop__rows` is a two-column grid and `.viz-prop__key` / `.viz-prop__value`
 * have to be its direct children for the key column to line up down the whole
 * panel. Wrapping each pair in a row element — which is what the class list
 * suggests at first read — makes every pair a single grid item and the alignment
 * evaporates.
 *
 * Collapse toggles `hidden` on the rows. Unlike the toolbar's notice, that works
 * here: the stylesheet declares `.viz-prop__rows[hidden] { display: none }`
 * explicitly, and it drives the chevron rotation off `aria-expanded` on the
 * button, so the two are one state rather than two that can disagree. No `--open`
 * modifier exists in the pinned vocabulary and inventing one is not on the table.
 */
function renderGroup(
  group: PropGroup,
  collapsed: Set<string>,
  callbacks: InspectorCallbacks
): readonly HTMLElement[] {
  const open = !collapsed.has(group.id)

  const button = el('button', 'viz-prop__group')
  button.type = 'button'
  button.setAttribute('aria-expanded', String(open))
  button.append(strokedIcon('viz-prop__chevron', CHEVRON_PATH, '1.5'))
  button.append(el('span', 'viz-prop__group-label', group.label))

  const rows = el('div', 'viz-prop__rows')
  rows.hidden = !open
  for (const row of group.rows) {
    rows.append(el('span', 'viz-prop__key', row.key))
    rows.append(renderValue(row, callbacks))
  }

  button.addEventListener('click', () => {
    const opening = rows.hidden
    rows.hidden = !opening
    button.setAttribute('aria-expanded', String(opening))
    if (opening) collapsed.delete(group.id)
    else collapsed.add(group.id)
  })

  return [button, rows]
}

/* ------------------------------- the mount ------------------------------- */

export function mountInspector(host: HTMLElement, callbacks: InspectorCallbacks): InspectorHandle {
  const root = el('div', 'viz-inspector')

  const header = el('div', 'viz-inspector__header')
  const title = el('span', 'viz-inspector__title', 'Inspector')
  const actions = el('div', 'viz-inspector__actions')
  header.append(title, actions)

  const body = el('div', 'viz-inspector__body')

  /**
   * The embedded control-flow thumbnail belongs to the integrator, so it is
   * created once here and then never touched — not by `show`, not by `clear`.
   * Rebuilding it alongside the property tree would detach whatever they mounted
   * into it on every selection change, and they would have no way to notice
   * except by watching their canvas die.
   *
   * The heading is a SIBLING of the container rather than its first child for
   * the same reason: the container is theirs outright, and the first
   * `replaceChildren` on it would otherwise delete the label. It also matches
   * what the stylesheet expects — `.viz-inspector__cfg` is a fixed-height
   * bordered box and the label's padding lines up with the group labels above
   * it, not with anything inside a border.
   *
   * Both sit outside `.viz-inspector__body`, which is the scrolling region: a
   * 190px thumbnail pinned at the bottom keeps its own place while the
   * properties scroll past it.
   */
  const cfgLabel = el('div', 'viz-inspector__cfg-label', 'Control flow')
  const cfg = el('div', 'viz-inspector__cfg')

  root.append(header, body, cfgLabel, cfg)
  host.append(root)

  /**
   * Collapse state is per-drawer and outlives the selection. Someone who folds
   * "Doc" away is saying something about how they want to read this panel, not
   * about that one node; re-expanding it on the next click would make the
   * control useless exactly for the person who bothered to use it.
   */
  const collapsed = new Set<string>()

  const copyButton = el('button', 'icon-button')
  copyButton.type = 'button'
  copyButton.title = 'Copy details'
  copyButton.setAttribute('aria-label', 'Copy node details')
  copyButton.append(strokedIcon(undefined, COPY_PATH, '1.3'))

  /** The record backing the Copy button; null whenever nothing is selected. */
  let copyText: string | null = null

  copyButton.addEventListener('click', () => {
    const text = copyText
    if (text === null) return
    // The promise rejects on a denied permission or an unfocused document, and
    // both are silent failures otherwise — a button that appears to work and
    // leaves the clipboard holding whatever was there before is worse than one
    // that says it failed. Same toasts as `assist.ts`, so "copy" behaves the
    // same everywhere in the app.
    void navigator.clipboard
      .writeText(text)
      .then(() => notify('Node details copied.'))
      .catch(() => notifyError('Could not copy to the clipboard.'))
  })

  const show = (node: CodeGraphNode, graph: CodeGraph): void => {
    const groups = buildGroups(node, graph)
    copyText = toPlainText(node, groups)

    title.textContent = node.label
    // The title ellipsises at this width; the full label stays reachable.
    title.title = node.label
    if (!copyButton.isConnected) actions.append(copyButton)

    const tree = el('div', 'viz-prop')
    for (const group of groups) tree.append(...renderGroup(group, collapsed, callbacks))
    body.replaceChildren(tree)
    // A new node starts at its own top. Inheriting the previous node's scroll
    // offset lands the reader halfway down a shorter drawer, which looks like
    // the panel failed to update.
    body.scrollTop = 0
  }

  const clear = (): void => {
    copyText = null
    title.textContent = 'Inspector'
    title.removeAttribute('title')
    // Removed rather than disabled: there is nothing to copy, and a disabled
    // button in the header is a permanent invitation that never pays out.
    copyButton.remove()

    const empty = emptyState('Select a node in the graph to inspect it.')
    // Carries both classes on purpose — `emptyState` gives the shared structure
    // every empty state in this app uses, and `viz-inspector__empty` is the
    // Visualizer's own padding for it.
    empty.classList.add('viz-inspector__empty')
    body.replaceChildren(empty)
  }

  clear()

  return {
    show,
    clear,
    // Takes the integrator's `cfg` container with it, which is correct: it was
    // only ever a hole in our own subtree.
    destroy: () => root.remove()
  }
}
