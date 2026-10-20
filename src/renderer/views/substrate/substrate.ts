import { activeDocument, onDocumentsChanged } from '../../editor/models'
import { activeRightDockView, isRightDockVisible } from '../../workbench/right-dock'
import {
  FRONT_STAGES,
  compile,
  type CompileResult,
  type DiagnosticRecord,
  type FrontStage,
  type FunctionRecord,
  type InstructionRecord
} from './compile'
import { provenanceAt, type Provenance } from './provenance'

/**
 * The Substrate view.
 *
 * Every other tool window answers a question about a FILE — its diagnostics,
 * its history, its diff. This one answers a question about a CONSTRUCT: click
 * anything in the open file and see what it became at every one of the seven
 * stages, at once, live off the real compiler.
 *
 * It mirrors the active document's text read-only rather than hosting its own
 * Monaco instance — editing still happens in the tab, which is the one place
 * undo history, save state and the language server already live. This view
 * recompiles from that text on every change and never writes back to it.
 */

interface Stage {
  readonly id: 'tokens' | 'ast' | 'symbols' | 'types' | 'ir' | 'ssa' | 'verify'
  readonly name: string
  readonly idx: string
}

const STAGES: readonly Stage[] = [
  { id: 'tokens', name: 'Tokens', idx: '01' },
  { id: 'ast', name: 'AST', idx: '02' },
  { id: 'symbols', name: 'Symbols', idx: '03' },
  { id: 'types', name: 'Types', idx: '04' },
  { id: 'ir', name: 'IR', idx: '05' },
  { id: 'ssa', name: 'SSA', idx: '06' },
  { id: 'verify', name: 'Verify', idx: '07' }
]

const KEYWORDS = new Set(['let', 'if', 'else', 'while', 'fn', 'return', 'print'])
const BOOLS = new Set(['true', 'false'])

let bodyHost: HTMLElement | null = null
let unsubscribeDocs: (() => void) | null = null

interface State {
  relativePath: string | null
  source: string
  result: CompileResult | null
  prov: Provenance | null
  offset: number
  stage: Stage['id']
}

const state: State = {
  relativePath: null,
  source: '',
  result: null,
  prov: null,
  offset: 0,
  stage: 'ssa'
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
/** The file the current tree was rendered for. Scroll positions carry only within one file. */
let renderedPath: string | null = null

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function dur(ms: number | undefined): string {
  if (ms === undefined) return ''
  return ms < 0.05 ? '<0.1ms' : `${ms.toFixed(1)}ms`
}

function isFrontStage(id: Stage['id']): id is FrontStage {
  return (FRONT_STAGES as readonly string[]).includes(id)
}

function errorsIn(r: CompileResult, stage: FrontStage): DiagnosticRecord[] {
  return r.diagnostics.filter((d) => d.stage === stage)
}

/** The first front-end stage that reported an error, or null when the front end is clean. */
function haltedFront(r: CompileResult): FrontStage | null {
  return FRONT_STAGES.find((stage) => errorsIn(r, stage).length > 0) ?? null
}

/** The stage the pipeline stopped at, for the header and the blocked notices. */
function haltedAt(r: CompileResult): Stage {
  const id = haltedFront(r) ?? 'types'
  return STAGES.find((s) => s.id === id)!
}

/* --------------------------------- syncing --------------------------------- */

function isBccFile(path: string): boolean {
  return path.endsWith('.bcc')
}

/** Re-reads the active document and recompiles. Called on open/switch/edit. */
function sync(): void {
  const doc = activeDocument()
  const path = doc?.node.relativePath ?? null
  const isBcc = path !== null && isBccFile(path)

  // An offset means nothing in another file: kept across a tab switch, it
  // would trace whatever construct happens to sit at that position there.
  const next = isBcc ? path : null
  if (next !== state.relativePath) state.offset = 0
  state.relativePath = next
  state.source = isBcc ? (doc?.model.getValue() ?? '') : ''

  if (!isBcc) {
    state.result = null
    state.prov = null
    render()
    return
  }

  recompile()
}

function recompile(): void {
  state.result = compile(state.source)
  state.prov = provenanceAt(state.result, state.offset)
  render()
}

function setOffset(offset: number): void {
  state.offset = offset
  if (state.result) state.prov = provenanceAt(state.result, offset)
  render()
}

function scheduleRecompile(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    const doc = activeDocument()
    if (!doc || !isBccFile(doc.node.relativePath)) return
    state.source = doc.model.getValue()
    recompile()
  }, 90)
}

/* -------------------------------- provenance -------------------------------- */

/**
 * A front-end stage's card: its own error count when it has one, "not reached"
 * when an earlier stage halted the pipeline (so a stage that never got its
 * input cannot read as passing), otherwise what it produced.
 */
function frontStat(r: CompileResult, stage: FrontStage, count: string, timing: string): { n: string; t: string; badState: string } {
  const errors = errorsIn(r, stage).length
  if (errors) return { n: `${errors} err`, t: timing, badState: 'error' }
  const halt = haltedFront(r)
  if (halt !== null && FRONT_STAGES.indexOf(stage) > FRONT_STAGES.indexOf(halt)) {
    return { n: 'not reached', t: '', badState: 'blocked' }
  }
  return { n: count, t: timing, badState: 'ok' }
}

function stageStat(stage: Stage['id']): { n: string; t: string; badState: string } {
  const r = state.result
  if (!r) return { n: '', t: '', badState: '' }
  switch (stage) {
    case 'tokens':
      return frontStat(r, 'tokens', String(r.tokens.length), dur(r.timings['tokens']))
    case 'ast':
      return frontStat(r, 'ast', String(r.ast.length), dur(r.timings['ast']))
    case 'symbols':
      return frontStat(r, 'symbols', String(r.symbols.length), dur(r.timings['resolve']))
    case 'types':
      return frontStat(r, 'types', 'clean', dur(r.timings['types']))
    case 'ir':
    case 'ssa': {
      if (r.blocked) return { n: 'blocked', t: '', badState: 'blocked' }
      const fns = stage === 'ir' ? r.ir : r.ssa
      const blocks = fns.reduce((n, fn) => n + fn.blocks.length, 0)
      return { n: `${blocks} blocks`, t: dur(r.timings[stage]), badState: 'ok' }
    }
    case 'verify':
      if (r.blocked) return { n: 'blocked', t: '', badState: 'blocked' }
      return {
        n: r.violations.length ? `${r.violations.length} viol` : 'sound',
        t: dur(r.timings['verify']),
        badState: r.violations.length ? 'error' : 'ok'
      }
  }
}

function provStages(): Partial<Record<Stage['id'], true>> {
  const pv = state.prov
  const on: Partial<Record<Stage['id'], true>> = {}
  if (!pv) return on
  if (pv.token) on.tokens = true
  if (pv.node) {
    on.ast = true
    if (pv.node.type) on.types = true
  }
  if (pv.symbol) {
    on.symbols = true
    if (pv.symbol.type) on.types = true
  }
  if (pv.ir.length) on.ir = true
  if (pv.ssa.length) on.ssa = true
  return on
}

/* ---------------------------------- render ---------------------------------- */

function renderVerdict(): HTMLElement {
  const bar = el('div', 'substrate__verdict')
  const dot = el('span', 'dot')
  const text = el('span')
  const r = state.result

  if (!r) {
    bar.dataset['state'] = 'idle'
    text.textContent = 'no source'
  } else if (r.blocked) {
    bar.dataset['state'] = 'fail'
    text.textContent = `${r.diagnostics.length} error${r.diagnostics.length === 1 ? '' : 's'} — pipeline halted at ${haltedAt(r).idx}`
  } else if (r.violations.length) {
    bar.dataset['state'] = 'fail'
    text.textContent = `${r.violations.length} IR violation${r.violations.length === 1 ? '' : 's'}`
  } else {
    bar.dataset['state'] = 'pass'
    text.textContent = 'verified — SSA sound'
  }

  bar.append(dot, text)
  if (state.relativePath) {
    const file = el('span', 'substrate__verdict-file', state.relativePath)
    bar.append(file)
  }
  return bar
}

function renderSpine(): HTMLElement {
  const spine = el('div', 'substrate__spine')
  spine.setAttribute('role', 'tablist')
  spine.setAttribute('aria-label', 'Compiler pipeline')
  const on = provStages()

  for (const stage of STAGES) {
    const stat = stageStat(stage.id)
    const button = el('button', 'substrate__stage')
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(state.stage === stage.id))
    button.dataset['state'] = stat.badState
    button.dataset['prov'] = String(Boolean(on[stage.id]))
    button.dataset['stageId'] = stage.id

    const idx = el('span', 'substrate__stage-idx', stage.idx)
    const nm = el('span', 'substrate__stage-nm', stage.name)
    const ct = el('span', 'substrate__stage-ct')
    ct.append(el('span', undefined, stat.n), el('span', undefined, stat.t))

    button.append(idx, nm, ct)
    button.addEventListener('click', () => {
      state.stage = stage.id
      render()
    })
    spine.append(button)
  }
  return spine
}

function renderSource(): HTMLElement {
  const pane = el('div', 'substrate__source')
  pane.dataset['scrollKey'] = 'source'
  const inner = el('div', 'substrate__source-inner')
  const gutter = el('div', 'substrate__gutter')
  const code = el('pre', 'substrate__code')

  const r = state.result
  if (!r) return pane

  const mark = state.prov?.span ?? null
  let html = ''
  let cursor = 0
  for (const tok of r.tokens) {
    if (tok.span.offset > cursor) html += esc(state.source.slice(cursor, tok.span.offset))
    const text = esc(state.source.substr(tok.span.offset, tok.span.length))
    const cls = KEYWORDS.has(tok.kind)
      ? 'substrate-tk-kw'
      : BOOLS.has(tok.kind)
        ? 'substrate-tk-bool'
        : tok.kind === 'int'
          ? 'substrate-tk-num'
          : tok.kind === 'identifier'
            ? 'substrate-tk-id'
            : tok.kind === 'error'
              ? 'substrate-tk-err'
              : 'substrate-tk-punct'
    const inMark =
      mark !== null && tok.span.offset >= mark.offset && tok.span.offset + tok.span.length <= mark.offset + Math.max(mark.length, 1)
    const span = `<span class="${cls}">${text}</span>`
    html += inMark ? `<mark>${span}</mark>` : span
    cursor = tok.span.offset + tok.span.length
  }
  if (cursor < state.source.length) html += esc(state.source.slice(cursor))
  code.innerHTML = `${html}\n`

  const lines = state.source.split('\n')
  const provLines = new Set<number>()
  if (mark) for (let ln = mark.startLine; ln <= mark.endLine; ln++) provLines.add(ln)
  const diagLines = new Set(r.diagnostics.map((d) => d.span.startLine))

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1
    const item = el('i', undefined, String(ln))
    if (provLines.has(ln)) item.dataset['prov'] = 'true'
    if (diagLines.has(ln)) item.dataset['diag'] = 'true'
    gutter.append(item)
  }

  code.addEventListener('click', (event) => {
    const offset = offsetFromClick(event, code, state.source)
    if (offset !== null) setOffset(offset)
  })

  inner.append(gutter, code)
  pane.append(inner)
  return pane
}

/** Maps a click inside the mirrored `<pre>` back to a source offset by walking
 * text nodes — there is no real caret here, only a click target. */
function offsetFromClick(event: MouseEvent, container: HTMLElement, source: string): number | null {
  const doc = container.ownerDocument
  let node: Node | null = null
  let charOffset = 0
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(event.clientX, event.clientY)
    if (!pos) return null
    node = pos.offsetNode
    charOffset = pos.offset
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(event.clientX, event.clientY)
    if (!range) return null
    node = range.startContainer
    charOffset = range.startOffset
  } else {
    return null
  }
  if (!node || !container.contains(node)) return null

  // Walk preceding text nodes to accumulate the offset within the whole source.
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let total = 0
  let current = walker.nextNode()
  while (current) {
    if (current === node) return Math.min(source.length, total + charOffset)
    total += current.textContent?.length ?? 0
    current = walker.nextNode()
  }
  return null
}

function rowsHtml(rows: string[]): HTMLElement {
  const wrap = el('div', 'substrate__rows')
  wrap.innerHTML = rows.join('')
  return wrap
}

function attachRowClicks(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('[data-off]').forEach((rowEl) => {
    rowEl.addEventListener('click', () => {
      const off = Number(rowEl.dataset['off'])
      if (!Number.isNaN(off)) setOffset(off)
    })
  })
}

function blockedNotice(name: string, r: CompileResult): HTMLElement {
  const box = el('div', 'substrate__empty')
  box.innerHTML = `<b>${esc(name)} not built</b>The program has errors, and lowering a broken program would mean\ninventing an IR that no source justifies. Fix the errors in\nstage ${haltedAt(r).idx} and this stage rebuilds.`
  return box
}

function renderTokensProjection(): HTMLElement {
  const r = state.result!
  const pv = state.prov
  const rows = r.tokens.map((tok, i) => {
    const on = pv?.token === tok
    return (
      `<div class="substrate__row substrate__row--click" data-off="${tok.span.offset}"${on ? ' data-prov="true"' : ''}>` +
      `<span class="substrate__k">${String(i).padStart(3, '0')}</span>` +
      `<span class="substrate__v"><span class="substrate__op">${esc(tok.kind)}</span>` +
      `<span class="substrate__dim">  ·  </span>${esc(tok.text)}</span></div>`
    )
  })
  const wrap = rowsHtml(rows)
  attachRowClicks(wrap)
  return wrap
}

function renderAstProjection(): HTMLElement {
  const r = state.result!
  const pv = state.prov
  const rows = r.ast.map((n) => {
    const on = pv?.node?.id === n.id
    const pad = '  '.repeat(n.depth)
    const ty = n.type ? `<span class="substrate__ty">  : ${esc(n.type)}</span>` : ''
    return (
      `<div class="substrate__row substrate__row--click" data-off="${n.span?.offset ?? 0}"${on ? ' data-prov="true"' : ''}>` +
      `<span class="substrate__v">${esc(pad)}${esc(n.label)}${ty}</span></div>`
    )
  })
  const wrap = rowsHtml(rows)
  attachRowClicks(wrap)
  return wrap
}

function renderSymbolsProjection(): HTMLElement {
  const r = state.result!
  if (!r.symbols.length) {
    const box = el('div', 'substrate__empty')
    box.innerHTML = '<b>No bindings</b>Nothing is declared yet.'
    return box
  }
  const pv = state.prov
  const rows = r.symbols.map((s) => {
    const on = pv?.symbol === s
    const ty = s.type ? `<span class="substrate__ty">  : ${esc(s.type)}</span>` : ''
    return (
      `<div class="substrate__row substrate__row--click" data-off="${s.span?.offset ?? 0}"${on ? ' data-prov="true"' : ''}>` +
      `<span class="substrate__k">${esc(s.kind.slice(0, 3))}</span>` +
      `<span class="substrate__v">${'  '.repeat(s.depth)}${esc(s.name)}${ty}</span></div>`
    )
  })
  const wrap = rowsHtml(rows)
  attachRowClicks(wrap)
  return wrap
}

function renderTypesProjection(): HTMLElement {
  const r = state.result!
  const pv = state.prov
  const typed: string[] = []
  for (const n of r.ast) {
    if (!n.type) continue
    const on = pv?.node?.id === n.id
    typed.push(
      `<div class="substrate__row substrate__row--click" data-off="${n.span?.offset ?? 0}"${on ? ' data-prov="true"' : ''}>` +
        `<span class="substrate__v">${esc(n.label)}</span>` +
        `<span class="substrate__ty" style="margin-left:auto">${esc(n.type)}</span></div>`
    )
  }
  if (!typed.length) {
    const box = el('div', 'substrate__empty')
    box.innerHTML = '<b>Nothing typed</b>No expressions to check.'
    return box
  }
  const wrap = el('div')
  wrap.innerHTML = `<div class="substrate__rows">${typed.join('')}</div>`
  attachRowClicks(wrap)
  return wrap
}

function renderIrLikeProjection(which: 'ir' | 'ssa'): HTMLElement {
  const r = state.result!
  if (r.blocked) return blockedNotice(which === 'ir' ? 'IR' : 'SSA', r)
  const fns: readonly FunctionRecord[] = which === 'ir' ? r.ir : r.ssa
  const hits: readonly InstructionRecord[] = which === 'ir' ? (state.prov?.ir ?? []) : (state.prov?.ssa ?? [])
  const parts: string[] = []

  for (const fn of fns) {
    parts.push(`<div class="substrate__fnhead">${esc(fn.name)}<span class="substrate__sig">  ${esc(fn.signature.replace(fn.name, ''))}</span></div>`)
    for (const block of fn.blocks) {
      parts.push(
        `<div class="substrate__blk"><div class="substrate__blk-head"><span class="substrate__lbl">b${block.id}</span>` +
          `<span>${esc(block.label)}</span>` +
          `<span class="substrate__succ">${block.successors.length ? `→ ${block.successors.map((s) => `b${s}`).join(' ')}` : 'exit'}</span></div>`
      )
      const body: string[] = []
      for (const ins of block.instructions) {
        const on = hits.includes(ins)
        body.push(
          `<div class="substrate__row substrate__row--click" data-off="${ins.span.offset}"${on ? ' data-prov="true"' : ''}>` +
            `<span class="substrate__v${ins.isPhi ? ' substrate__phi' : ''}">${esc(ins.text)}</span></div>`
        )
      }
      const t = block.terminator
      const ton = hits.includes(t)
      body.push(
        `<div class="substrate__row substrate__row--click" data-off="${t.span.offset}"${ton ? ' data-prov="true"' : ''}>` +
          `<span class="substrate__v substrate__op">${esc(t.text)}</span></div>`
      )
      parts.push(`<div class="substrate__rows">${body.join('')}</div></div>`)
    }
  }
  const wrap = el('div')
  wrap.innerHTML = parts.join('')
  attachRowClicks(wrap)
  return wrap
}

function renderVerifyProjection(): HTMLElement {
  const r = state.result!
  if (r.blocked) return blockedNotice('Verification', r)
  if (!r.violations.length) {
    let blocks = 0
    let instrs = 0
    let phis = 0
    for (const fn of r.ssa) {
      for (const block of fn.blocks) {
        blocks++
        instrs += block.instructions.length
        phis += block.instructions.filter((i) => i.isPhi).length
      }
    }
    const card = el('div', 'substrate__rulecard')
    card.innerHTML =
      '<b>SSA form holds</b>' +
      'Every value is defined once and dominates all of its uses.\n' +
      'Every phi has one argument per incoming edge, in edge order.\n' +
      'Every block ends in exactly one terminator.\n' +
      'No instruction references a value that no longer exists.\n\n' +
      `<span class="substrate__dim">checked</span>  ${r.ssa.length} functions · ${blocks} blocks · ${instrs} instructions · ${phis} phi nodes`
    return card
  }
  const wrap = el('div')
  wrap.innerHTML = r.violations
    .map(
      (v) =>
        `<div class="substrate__diag substrate__diag--viol">` +
        `<span class="substrate__code">${esc(v.rule)}</span>` +
        `<span class="substrate__v">${esc(v.message)}</span>` +
        `<span class="substrate__where">${esc(v.title)} · in ${esc(v.fn)}${v.block ? ` / ${esc(v.block)}` : ''}</span></div>`
    )
    .join('')
  return wrap
}

function diagRow(d: DiagnosticRecord): string {
  return (
    `<div class="substrate__diag" data-off="${d.span.offset}">` +
    `<span class="substrate__code">${esc(d.code)}</span>` +
    `<span class="substrate__v">${esc(d.message)}</span>` +
    `<span class="substrate__where">${esc(d.title)} · line ${d.span.startLine}, col ${d.span.startColumn}</span></div>`
  )
}

/** Only this stage's own errors, so a syntax error is never listed under Types. */
function stageErrorsBlock(stage: Stage['id']): HTMLElement | null {
  const r = state.result
  if (!r || !isFrontStage(stage)) return null
  const errors = errorsIn(r, stage)
  if (errors.length === 0) return null
  const wrap = el('div')
  wrap.innerHTML = errors.map(diagRow).join('')
  attachRowClicks(wrap)
  return wrap
}

const PROJECTIONS: Record<Stage['id'], () => HTMLElement> = {
  tokens: renderTokensProjection,
  ast: renderAstProjection,
  symbols: renderSymbolsProjection,
  types: renderTypesProjection,
  ir: () => renderIrLikeProjection('ir'),
  ssa: () => renderIrLikeProjection('ssa'),
  verify: renderVerifyProjection
}

function renderProjectionPane(): HTMLElement {
  const pane = el('div', 'substrate__pane')
  const head = el('div', 'substrate__pane-head')
  const stage = STAGES.find((s) => s.id === state.stage)!
  const stat = stageStat(state.stage)
  head.append(el('span', undefined, stage.name), el('span', 'substrate__hint', [stat.n, stat.t].filter(Boolean).join(' · ')))

  const body = el('div', 'substrate__pane-body')
  // Keyed by stage: another stage's projection is a different document, and
  // should open at its top rather than at this one's scroll position.
  body.dataset['scrollKey'] = `projection:${state.stage}`
  const errors = stageErrorsBlock(state.stage)
  if (errors) body.append(errors)
  body.append(PROJECTIONS[state.stage]())

  pane.append(head, body)
  return pane
}

function renderSourcePane(): HTMLElement {
  const pane = el('div', 'substrate__pane')
  const head = el('div', 'substrate__pane-head')
  head.append(el('span', undefined, 'Source'), el('span', 'substrate__hint', 'click anything — the beam follows it downstream'))
  const body = el('div', 'substrate__pane-body')
  body.dataset['scrollKey'] = 'source-pane'
  body.style.padding = '0'
  body.append(renderSource())
  pane.append(head, body)
  return pane
}

function traceCell(name: string, on: boolean, html: string): string {
  return `<div class="substrate__cell" data-on="${on}"><div class="substrate__cell-name">${name}</div><div class="substrate__cell-val">${html}</div></div>`
}

function renderTrace(): HTMLElement {
  const trace = el('div', 'substrate__trace')
  const head = el('div', 'substrate__trace-head')
  const beam = el('span', 'beam')
  const what = el('span', 'substrate__trace-what')
  const strip = el('div', 'substrate__strip')
  strip.dataset['scrollKey'] = 'trace'

  const pv = state.prov
  const NONE = '<span class="substrate__dim">—</span>'

  if (!pv || (!pv.token && !pv.node)) {
    what.innerHTML = '<em>select something in the source</em>'
    const blank = ['Source', ...STAGES.map((s) => s.name)].map((name) => traceCell(name, false, NONE))
    strip.innerHTML = blank.join('')
  } else {
    what.textContent = pv.node ? pv.node.label : (pv.token?.text ?? '')

    const src = pv.span ? state.source.substr(pv.span.offset, pv.span.length) : ''
    const brief = (list: readonly InstructionRecord[]): string =>
      list.length ? list.map((x) => `<span${x.isPhi ? ' class="substrate__phi"' : ''}>${esc(x.text)}</span>`).join('\n') : NONE

    const tokCell = pv.token
      ? `<span class="substrate__op">${esc(pv.token.kind)}</span>` + (pv.token.text !== pv.token.kind ? `\n${esc(pv.token.text)}` : '')
      : NONE

    let tyCell = NONE
    if (pv.node?.type) tyCell = `<span class="substrate__ty">${esc(pv.node.type)}</span>`
    else if (pv.symbol?.type)
      tyCell = `<span class="substrate__ty">${esc(pv.symbol.type)}</span><span class="substrate__dim">\nof the binding</span>`
    else if (pv.diagnostics.length)
      tyCell = `<span style="color:var(--bcc-danger)">${esc(pv.diagnostics[0]!.code)}</span><span class="substrate__dim">\n${esc(pv.diagnostics[0]!.title)}</span>`

    const owner = pv.ssa[0]?.fn ?? pv.ir[0]?.fn ?? null
    let vCell = NONE
    let vOn = false
    if (state.result?.blocked) {
      vCell = '<span class="substrate__dim">not reached</span>'
    } else if (owner) {
      const mine = (state.result?.violations ?? []).filter((v) => v.fn === owner)
      vOn = true
      vCell = mine.length
        ? `<span style="color:var(--bcc-warning)">${esc(mine.map((v) => v.rule).join('\n'))}</span>`
        : `<span style="color:var(--bcc-success)">sound</span><span class="substrate__dim">\nin ${esc(owner)}</span>`
    }

    const cells = [
      traceCell(
        'Source',
        Boolean(src),
        src
          ? `${esc(src.length > 70 ? `${src.slice(0, 70)}…` : src)}<span class="substrate__dim">\nline ${pv.span!.startLine}:${pv.span!.startColumn}</span>`
          : NONE
      ),
      traceCell('Tokens', Boolean(pv.token), tokCell),
      traceCell('AST', Boolean(pv.node), pv.node ? esc(pv.node.label) : NONE),
      traceCell(
        'Symbols',
        Boolean(pv.symbol),
        pv.symbol ? `${esc(pv.symbol.kind)}\n<span class="substrate__dim">${esc(pv.symbol.type ?? '')}</span>` : NONE
      ),
      traceCell('Types', tyCell !== NONE, tyCell),
      traceCell('IR', Boolean(pv.ir.length), brief(pv.ir)),
      traceCell('SSA', Boolean(pv.ssa.length), brief(pv.ssa)),
      traceCell('Verify', vOn, vCell)
    ]
    strip.innerHTML = cells.join('')
  }

  head.append(beam, el('span', undefined, 'The Trace'), what)
  trace.append(head, strip)
  return trace
}

function renderFooter(): HTMLElement {
  const bar = el('div', 'substrate__footer')
  const r = state.result
  if (!r) {
    bar.append(el('span', 'seg', 'no compiler output'))
    return bar
  }
  const total = Object.values(r.timings).reduce((a, b) => a + b, 0)
  let blocks = 0
  for (const fn of r.ssa) blocks += fn.blocks.length
  bar.append(
    el('span', 'seg', `${r.tokens.length} tokens`),
    el('span', 'seg', `${r.ast.length} nodes`),
    el('span', 'seg', `${blocks} blocks`),
    el('span', 'seg', `${total.toFixed(1)}ms end-to-end`),
    el('span', 'seg', 'live off the file in the active tab — real compiler, no daemon round trip')
  )
  return bar
}

function render(): void {
  if (bodyHost === null) return

  if (!state.relativePath) {
    const root = el('div', 'substrate')
    const empty = el('div', 'substrate__empty')
    empty.innerHTML = '<b>No .bcc file open</b>Open a .bcc file in the editor — Substrate\nruns the real compiler on it live, stage by stage.'
    root.append(empty)
    bodyHost.replaceChildren(root)
    renderedPath = null
    return
  }

  const root = el('div', 'substrate')
  root.append(renderVerdict(), renderSpine())

  const workbench = el('div', 'substrate__workbench')
  workbench.append(renderSourcePane(), renderProjectionPane())
  root.append(workbench)

  root.append(renderTrace())
  root.append(renderFooter())

  // Every render replaces the whole tree, which would put each scroller back at
  // the top: clicking a construct below the fold would throw the reader up to
  // line 1. Carry positions over by key while the same file is showing.
  const kept = new Map<string, readonly [number, number]>()
  if (renderedPath === state.relativePath) {
    for (const n of bodyHost.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      kept.set(n.dataset['scrollKey']!, [n.scrollTop, n.scrollLeft])
    }
  }

  bodyHost.replaceChildren(root)
  renderedPath = state.relativePath

  for (const n of root.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
    const pos = kept.get(n.dataset['scrollKey']!)
    if (pos) [n.scrollTop, n.scrollLeft] = pos
  }
}

/* --------------------------------- mounting --------------------------------- */

export function mountSubstrate(title: HTMLElement, body: HTMLElement): void {
  bodyHost = body
  title.replaceChildren(el('span', 'right-dock__title-text', 'Substrate'))

  // Debounced re-render on content change, re-attached whenever the active
  // model changes — so an edit in a background tab never triggers this, and
  // switching files starts watching the new one.
  let disposeContentListener: (() => void) | null = null
  const rewatch = (): void => {
    disposeContentListener?.()
    disposeContentListener = null
    const doc = activeDocument()
    if (!doc || !isBccFile(doc.node.relativePath)) return
    const subscription = doc.model.onDidChangeContent(() => {
      // Only recompile while this view is actually visible — same guard the
      // Compiler Intelligence view uses to stay off the typing hot path when
      // nobody is looking at the dock.
      if (!isRightDockVisible() || activeRightDockView() !== 'substrate') return
      scheduleRecompile()
    })
    disposeContentListener = () => subscription.dispose()
  }

  unsubscribeDocs?.()
  unsubscribeDocs = onDocumentsChanged(() => {
    rewatch()
    sync()
  })

  rewatch()
  sync()
}

export function onSubstrateShown(): void {
  sync()
}
