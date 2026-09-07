import type { AiContext, AiLogEntry, AiMode, AiStarted } from '../../shared/types'
import { AI_ACTION_EVENT, type AiActionDetail } from '../editor/ai-actions'
import { extractCodeBlock, spliceSelection } from '../editor/code-context'
import { hideDiff, showDiff } from '../editor/diff'
import { activeDocument, reloadFromDisk } from '../editor/models'
import { setSelected } from '../workbench/activity-bar'
import { notify, notifyError } from '../workbench/notifications'
import { emptyState, showSideBarView } from '../workbench/side-bar'

/**
 * The assistant panel.
 *
 * Two product requirements shape this file, and neither is a nicety:
 *
 *   1. What went to the model is inspectable. The "Context sent" section shows
 *      the exact strings main sent, not a reconstruction, and it is present
 *      before the first token rather than after the answer.
 *   2. No AI edit is a silent write. Improve produces a diff the user reads and
 *      applies deliberately; applying journals the edit and keeps a snapshot so
 *      it can be undone byte for byte.
 */

const MODE_LABELS: Readonly<Record<AiMode, string>> = {
  explain: 'Explain',
  'find-bugs': 'Find bugs',
  improve: 'Improve',
  // Journal entries from a multi-file agent batch carry this mode — the log
  // here shows both kinds of edit side by side, so it needs a real label.
  agent: 'Agent'
}

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null

let started: AiStarted | null = null
let context: AiContext | null = null
let answer = ''
let streaming = false
let doneError: string | null = null
let hasKey = false
let entries: AiLogEntry[] = []
/** The rewrite Improve proposed, once the stream ends and a block is found. */
let proposal: { original: string; modified: string; range: string } | null = null

let listenersBound = false

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

/* ------------------------------------------------------------------ *
 * Improve: turning an answer into a proposed file
 * ------------------------------------------------------------------ */

async function prepareProposal(): Promise<void> {
  proposal = null
  if (started === null || started.mode !== 'improve' || context === null) return

  const block = extractCodeBlock(answer)
  if (block === null) return

  const current = await window.betterCallCompiler.fs.readFile({ path: context.filePath })
  if (!current.ok) return

  proposal = {
    original: current.value.content,
    modified: spliceSelection(current.value.content, context.selection, block),
    range: `${context.selection.startLine}-${context.selection.endLine}`
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderTitle(): void {
  if (titleHost === null) return
  titleHost.replaceChildren(el('span', 'side-bar__heading', 'Assistant'))

  const actions = el('div', 'side-bar__actions')
  const clear = el('button', 'icon-button')
  clear.type = 'button'
  clear.title = 'Clear'
  clear.setAttribute('aria-label', 'Clear assistant')
  clear.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h10M6 5V3h4v2M5 5l.7 9h4.6L11 5" ' +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  clear.addEventListener('click', () => {
    started = null
    context = null
    answer = ''
    doneError = null
    proposal = null
    hideDiff()
    render()
  })
  actions.append(clear)
  titleHost.append(actions)
}

/** The collapsible that makes the claim of transparency checkable. */
function renderContextSent(): HTMLElement {
  const details = el('details', 'ai-context')
  details.id = 'ai-context-sent'

  const summary = el('summary', 'ai-context__summary', 'Context sent')
  details.append(summary)

  const meta = el('div', 'ai-context__meta')
  meta.append(el('span', 'ai-badge', started?.model ?? ''))
  meta.append(el('span', 'ai-context__hash', `prompt ${started?.promptHash ?? ''}`))
  details.append(meta)

  details.append(el('h4', 'ai-context__label', 'System'))
  details.append(el('pre', 'ai-context__block', started?.systemPrompt ?? ''))

  details.append(el('h4', 'ai-context__label', 'Message'))
  details.append(el('pre', 'ai-context__block', started?.contextSent ?? ''))

  return details
}

function renderProposal(): HTMLElement {
  const wrap = el('div', 'ai-proposal')
  wrap.append(
    el(
      'p',
      'ai-proposal__note',
      'Applying writes the file, records the edit in .bettercallcompiler/ai-log.jsonl, and keeps a snapshot you can revert to.'
    )
  )

  const row = el('div', 'ai-proposal__actions')

  const review = el('button', 'button', 'Review diff')
  review.type = 'button'
  review.addEventListener('click', () => {
    if (proposal === null || context === null) return
    // `void`: this is a synchronous click handler, and showDiff is now async.
    void showDiff({
      path: context.relativePath,
      original: proposal.original,
      modified: proposal.modified,
      originalLabel: 'Current',
      modifiedLabel: 'Proposed'
    })
  })
  row.append(review)

  const apply = el('button', 'button button--primary', 'Apply')
  apply.type = 'button'
  apply.addEventListener('click', () => void applyProposal())
  row.append(apply)

  wrap.append(row)
  return wrap
}

function renderLog(): HTMLElement {
  const wrap = el('div', 'scm-section')
  const header = el('div', 'scm-section__header')
  header.append(el('span', 'scm-section__label', 'Edit journal'))
  header.append(el('span', 'scm-section__count', String(entries.length)))
  wrap.append(header)

  if (entries.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No AI edits in this workspace.'))
    return wrap
  }

  const reverted = new Set(entries.map((entry) => entry.revertOf).filter((id) => id !== null))

  // Newest first: the entry a user wants to undo is the one they just made.
  for (const entry of [...entries].reverse()) {
    if (!entry.applied) continue

    const row = el('div', 'ai-log-row')
    row.title = `${entry.timestamp}\nprompt ${entry.promptHash}\nmodel ${entry.model}`

    row.append(el('span', 'ai-badge', MODE_LABELS[entry.mode]))
    row.append(el('span', 'ai-log-row__file', `${entry.file}:${entry.range}`))

    if (reverted.has(entry.id)) {
      row.append(el('span', 'ai-log-row__state', 'reverted'))
    } else {
      const revert = el('button', 'button ai-log-row__revert', 'Revert')
      revert.type = 'button'
      revert.addEventListener('click', () => void revertEntry(entry.id))
      row.append(revert)
    }

    wrap.append(row)
  }

  return wrap
}

function render(): void {
  if (bodyHost === null) return
  renderTitle()
  bodyHost.replaceChildren()

  // No key is an affordance, not an error. The panel says what to do and
  // offers the one click that does it.
  if (!hasKey) {
    bodyHost.append(
      emptyState('Add your Anthropic key in Settings to use the assistant.', {
        label: 'Open Settings',
        run: () => {
          setSelected('settings')
          void showSideBarView('settings')
        }
      })
    )
    bodyHost.append(renderLog())
    return
  }

  if (started === null) {
    bodyHost.append(
      el(
        'p',
        'explorer__empty-text',
        'Select code in the editor, then press Ctrl+K or use the right-click menu.'
      )
    )
    bodyHost.append(renderLog())
    return
  }

  const header = el('div', 'ai-header')
  header.append(el('span', 'ai-badge ai-badge--mode', MODE_LABELS[started.mode]))
  header.append(el('span', 'ai-header__file', `${context?.relativePath ?? ''}`))
  bodyHost.append(header)

  bodyHost.append(renderContextSent())

  const output = el('div', 'ai-answer')
  output.id = 'ai-answer'
  output.textContent = answer
  bodyHost.append(output)

  if (streaming) {
    const cancel = el('button', 'button ai-cancel', 'Stop')
    cancel.type = 'button'
    cancel.addEventListener('click', () => void cancelStream())
    bodyHost.append(cancel)
  }

  if (doneError !== null) {
    bodyHost.append(el('p', 'insights-notice', doneError))
  }

  if (proposal !== null) bodyHost.append(renderProposal())

  bodyHost.append(renderLog())
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function refreshKey(): Promise<void> {
  const result = await window.betterCallCompiler.secrets.hasKey({})
  hasKey = result.ok && result.value.secrets.anthropic
}

async function refreshLog(): Promise<void> {
  const result = await window.betterCallCompiler.ai.log({})
  entries = result.ok ? result.value.entries : []
}

export async function runAiAction(mode: AiMode, next: AiContext): Promise<void> {
  await refreshKey()
  if (!hasKey) {
    render()
    return
  }

  hideDiff()
  context = next
  answer = ''
  doneError = null
  proposal = null
  streaming = true
  render()

  const result = await window.betterCallCompiler.ai.start({ mode, context: next })
  if (!result.ok) {
    streaming = false
    started = null
    // NO_API_KEY is the affordance path, not a toast.
    if (result.error.code === 'NO_API_KEY') {
      hasKey = false
    } else {
      doneError = result.error.message
    }
    render()
    return
  }

  started = result.value.started
  render()
}

async function cancelStream(): Promise<void> {
  if (started === null) return
  await window.betterCallCompiler.ai.cancel({ streamId: started.streamId })
}

async function applyProposal(): Promise<void> {
  if (proposal === null || started === null || context === null) return

  const result = await window.betterCallCompiler.ai.apply({
    path: context.filePath,
    content: proposal.modified,
    mode: started.mode,
    model: started.model,
    promptHash: started.promptHash,
    range: proposal.range
  })

  if (!result.ok) {
    notifyError(result.error.message)
    return
  }

  hideDiff()
  proposal = null
  notify(`Applied to ${result.value.entry.file}. Revert from the edit journal.`, 'info')
  await reloadFromDisk(context.filePath)
  await refreshLog()
  render()
}

async function revertEntry(id: string): Promise<void> {
  const result = await window.betterCallCompiler.ai.revert({ id })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }

  notify(`Reverted ${result.value.entry.file}.`, 'info')
  const doc = activeDocument()
  if (doc !== null) await reloadFromDisk(doc.node.path)
  await refreshLog()
  render()
}

function bindStreamEvents(): void {
  if (listenersBound) return
  listenersBound = true

  window.betterCallCompiler.ai.onDelta((payload) => {
    if (started === null || payload.streamId !== started.streamId) return
    answer += payload.text
    const output = document.getElementById('ai-answer')
    // Append to the existing node rather than re-rendering: a full render on
    // every token would collapse the "Context sent" details the user opened.
    if (output !== null) {
      output.textContent = answer
      output.scrollTop = output.scrollHeight
    } else {
      render()
    }
  })

  window.betterCallCompiler.ai.onDone((payload) => {
    if (started === null || payload.streamId !== started.streamId) return
    streaming = false
    doneError = payload.error
    void prepareProposal().then(() => {
      void refreshLog().then(render)
    })
  })
}

/* --------------------------------- mount --------------------------------- */

export async function mountAi(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body

  bindStreamEvents()
  await refreshKey()
  await refreshLog()
  render()
}

export function onAiShown(): void {
  void refreshKey().then(() => void refreshLog().then(render))
}

/** Wires the editor actions to this view. Called once at boot. */
export function listenForAiActions(): void {
  document.addEventListener(AI_ACTION_EVENT, (event) => {
    const detail = (event as CustomEvent<AiActionDetail>).detail
    setSelected('ai')
    void showSideBarView('ai').then(() => void runAiAction(detail.mode, detail.context))
  })
}
