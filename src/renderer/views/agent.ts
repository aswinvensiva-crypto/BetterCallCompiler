import { extractAgentSummary, parseAgentPlan, type AgentFileEdit } from '../../shared/agent-plan'
import type { AiStarted, SemanticIndexStatus, SemanticMatch } from '../../shared/types'
import { requestOpenArtifact } from '../workbench/artifact-events'
import { hideDiff, showDiff } from '../editor/diff'
import { openDocuments, openFile, reloadFromDisk } from '../editor/models'
import { setSelected } from '../workbench/activity-bar'
import { notify, notifyError } from '../workbench/notifications'
import { emptyState, showSideBarView } from '../workbench/side-bar'

/**
 * The multi-file agent panel.
 *
 * `ai.ts` upgrades one selection in one file. This is the batch version: an
 * instruction plus a handful of attached files goes to the model, which comes
 * back with a whole-file rewrite per file it touches — parsed by
 * `parseAgentPlan`, the same pure function `ai-service.ts` on the main side
 * builds the prompt format around, so what the panel shows is exactly what
 * `agent:apply` will write, never an approximation of it.
 *
 * Every proposed file starts ACCEPTED and can be individually unchecked
 * before Apply — "per-hunk accept/reject" at file granularity, which is what
 * a whole-file rewrite naturally supports; `applyAiEdit`'s snapshot-then-write
 * discipline is what makes the file-level version safe, not a line-level diff
 * algorithm the plan does not ask for.
 *
 * One click undoes the whole thing: every file in a batch shares a
 * `batchId`, and `agent:revert` restores every one of that batch's snapshots
 * in a single call.
 */

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null

let instruction = ''
let selectedPaths = new Set<string>()

let started: AiStarted | null = null
/** `path -> original content sent`, so a rejected/never-returned file can still show a diff against nothing. */
let sentFiles = new Map<string, string>()
let answer = ''
let streaming = false
let doneError: string | null = null
let hasKey = true

let summary = ''
let plan: AgentFileEdit[] = []
let accepted = new Set<string>()

let applying = false
let appliedBatchId: string | null = null
let appliedFiles: string[] = []

/** Walkthrough auto-generated after a multi-file apply. Separate stream id from `started`. */
let walkthroughStarted: AiStarted | null = null
let walkthroughText = ''
let walkthroughStreaming = false
let walkthroughArtifactId: string | null = null

let workspaceRoot: string | null = null
let indexStatus: SemanticIndexStatus | null = null
let indexBuilding = false
let suggestions: SemanticMatch[] = []
let suggesting = false

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

function resetRun(): void {
  started = null
  sentFiles = new Map()
  answer = ''
  doneError = null
  summary = ''
  plan = []
  accepted = new Set()
  applying = false
  appliedBatchId = null
  appliedFiles = []
  walkthroughStarted = null
  walkthroughText = ''
  walkthroughStreaming = false
  walkthroughArtifactId = null
  suggestions = []
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderTitle(): void {
  if (titleHost === null) return
  titleHost.replaceChildren(el('span', 'side-bar__heading', 'Agent'))

  const actions = el('div', 'side-bar__actions')
  const clear = el('button', 'icon-button')
  clear.type = 'button'
  clear.title = 'New request'
  clear.setAttribute('aria-label', 'New request')
  clear.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5h10M6 5V3h4v2M5 5l.7 9h4.6L11 5" ' +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  clear.addEventListener('click', () => {
    resetRun()
    hideDiff()
    render()
  })
  actions.append(clear)
  titleHost.append(actions)
}

function renderFilePicker(): HTMLElement {
  const wrap = el('div', 'agent-files')
  wrap.append(el('h4', 'ai-context__label', 'Files'))

  const docs = openDocuments()
  if (docs.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'Open the files you want the agent to see and edit.'))
  } else {
    const list = el('div', 'agent-files__list')
    for (const doc of docs) {
      const row = el('label', 'agent-files__row')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = selectedPaths.has(doc.node.relativePath)
      box.addEventListener('change', () => {
        if (box.checked) selectedPaths.add(doc.node.relativePath)
        else selectedPaths.delete(doc.node.relativePath)
      })
      row.append(box, el('span', 'agent-files__path', doc.node.relativePath))
      list.append(row)
    }
    wrap.append(list)
  }

  wrap.append(renderIndexControls())
  return wrap
}

/**
 * The semantic index: build it once per workspace, then use it to suggest
 * files for the instruction currently typed, beyond whatever happens to be
 * open in a tab already. This is what the plan calls "replacing the current
 * 12-name import-hop limit" — Explain's neighbour walk stays as it is
 * (`explain-service.ts`'s `NEIGHBOUR_LIMIT`), but the agent's file selection
 * is no longer bounded by which tabs a user happened to have open.
 */
function renderIndexControls(): HTMLElement {
  const wrap = el('div', 'agent-index')

  const status = el('div', 'agent-index__status')
  if (indexStatus === null || !indexStatus.built) {
    status.append(el('span', 'agent-index__hint', 'No semantic index built yet.'))
  } else {
    status.append(
      el(
        'span',
        'agent-index__hint',
        `Index: ${indexStatus.fileCount} files, ${indexStatus.chunkCount} chunks.`
      )
    )
  }
  wrap.append(status)

  const actions = el('div', 'agent-index__actions')

  const build = el('button', 'button', indexBuilding ? 'Building…' : 'Build/refresh index')
  build.type = 'button'
  build.disabled = indexBuilding
  build.addEventListener('click', () => void buildIndex())
  actions.append(build)

  if (indexStatus?.built === true) {
    const suggest = el('button', 'button', suggesting ? 'Searching…' : 'Suggest files')
    suggest.type = 'button'
    suggest.disabled = suggesting || instruction.trim() === ''
    suggest.title =
      instruction.trim() === '' ? 'Type an instruction first' : 'Find files related to the instruction'
    suggest.addEventListener('click', () => void suggestFiles())
    actions.append(suggest)
  }

  wrap.append(actions)

  if (suggestions.length > 0) {
    const list = el('div', 'agent-files__list')
    for (const match of suggestions) {
      const row = el('label', 'agent-files__row')
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = selectedPaths.has(match.path)
      box.addEventListener('change', () => void toggleSuggestion(match, box.checked))
      const label = el(
        'span',
        'agent-files__path',
        `${match.path} (${match.startLine}-${match.endLine}, score ${match.score.toFixed(2)})`
      )
      label.title = match.preview
      row.append(box, label)
      list.append(row)
    }
    wrap.append(list)
  }

  return wrap
}

function renderComposer(): HTMLElement {
  const wrap = el('div', 'agent-composer')

  wrap.append(
    el(
      'p',
      'explorer__empty-text',
      'Describe a change that spans multiple files. The agent proposes a rewrite for ' +
        'each file it touches; you review and accept or reject each one before anything is written.'
    )
  )

  wrap.append(renderFilePicker())

  const textarea = document.createElement('textarea')
  textarea.className = 'agent-instruction'
  textarea.placeholder = 'e.g. "Rename parseConfig to loadConfig and update every call site."'
  textarea.value = instruction
  textarea.rows = 4
  textarea.addEventListener('input', () => {
    instruction = textarea.value
  })
  wrap.append(textarea)

  if (!hasKey) {
    wrap.append(
      emptyState('Add your Anthropic key in Settings to use the agent.', {
        label: 'Open Settings',
        run: () => {
          setSelected('settings')
          void showSideBarView('settings')
        }
      })
    )
    return wrap
  }

  const send = el('button', 'button button--primary', 'Send')
  send.type = 'button'
  send.disabled = instruction.trim() === '' || selectedPaths.size === 0
  send.addEventListener('click', () => void startRun())
  wrap.append(send)

  return wrap
}

function renderContextSent(): HTMLElement {
  const details = el('details', 'ai-context')
  const summaryEl = el('summary', 'ai-context__summary', 'Context sent')
  details.append(summaryEl)

  const meta = el('div', 'ai-context__meta')
  meta.append(el('span', 'ai-badge', started?.model ?? ''))
  meta.append(el('span', 'ai-context__hash', `prompt ${started?.promptHash ?? ''}`))
  meta.append(el('span', 'ai-context__hash', `${sentFiles.size} file(s) attached`))
  details.append(meta)

  details.append(el('h4', 'ai-context__label', 'System'))
  details.append(el('pre', 'ai-context__block', started?.systemPrompt ?? ''))

  details.append(el('h4', 'ai-context__label', 'Message'))
  details.append(el('pre', 'ai-context__block', started?.contextSent ?? ''))

  return details
}

function renderPlan(): HTMLElement {
  const wrap = el('div', 'agent-plan')

  if (summary !== '') wrap.append(el('p', 'agent-plan__summary', summary))

  if (plan.length === 0) {
    wrap.append(
      el(
        'p',
        'explorer__empty-text',
        'No file blocks were found in the answer above — nothing to apply.'
      )
    )
    return wrap
  }

  for (const edit of plan) {
    const row = el('div', 'agent-plan__row')

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = accepted.has(edit.path)
    box.addEventListener('change', () => {
      if (box.checked) accepted.add(edit.path)
      else accepted.delete(edit.path)
      render()
    })
    row.append(box)

    row.append(el('span', 'agent-plan__path', edit.path))

    const view = el('button', 'button', 'View diff')
    view.type = 'button'
    view.addEventListener('click', () => {
      void showDiff({
        path: edit.path,
        original: sentFiles.get(edit.path) ?? '',
        modified: edit.content,
        originalLabel: 'Current',
        modifiedLabel: 'Proposed'
      })
    })
    row.append(view)

    wrap.append(row)
  }

  const applyRow = el('div', 'ai-proposal__actions')
  const apply = el('button', 'button button--primary', applying ? 'Applying…' : 'Apply accepted')
  apply.type = 'button'
  apply.disabled = applying || accepted.size === 0
  apply.addEventListener('click', () => void applyPlan())
  applyRow.append(apply)
  wrap.append(applyRow)

  return wrap
}

function renderApplied(): HTMLElement {
  const wrap = el('div', 'agent-plan')
  wrap.append(
    el(
      'p',
      'agent-plan__summary',
      `Applied ${appliedFiles.length} file(s): ${appliedFiles.join(', ')}`
    )
  )
  const revert = el('button', 'button', 'Revert entire batch')
  revert.type = 'button'
  revert.addEventListener('click', () => void revertBatch())
  wrap.append(revert)

  wrap.append(renderWalkthrough())

  return wrap
}

/**
 * The interactive walkthrough: automatic once a batch of more than one file
 * is applied, matching the plan's own wording ("When an AI change touches
 * multiple files, it automatically generates a markdown breakdown"). A
 * single-file batch skips it — a one-file change is what the Assistant
 * panel's own journal already names plainly, and a walkthrough of one file
 * would just restate its own diff.
 */
function renderWalkthrough(): HTMLElement {
  const wrap = el('div', 'agent-walkthrough')

  if (walkthroughStreaming) {
    wrap.append(el('p', 'agent-plan__summary', 'Writing the walkthrough…'))
    return wrap
  }

  if (walkthroughArtifactId !== null) {
    const open = el('button', 'button button--primary', 'View walkthrough')
    open.type = 'button'
    open.addEventListener('click', () => {
      if (walkthroughArtifactId !== null) requestOpenArtifact(walkthroughArtifactId)
    })
    wrap.append(open)
  }

  return wrap
}

function render(): void {
  if (bodyHost === null) return
  renderTitle()
  bodyHost.replaceChildren()

  bodyHost.append(renderComposer())

  if (started === null) return

  bodyHost.append(renderContextSent())

  const output = el('div', 'ai-answer')
  output.id = 'agent-answer'
  output.textContent = answer
  bodyHost.append(output)

  if (streaming) {
    const cancel = el('button', 'button ai-cancel', 'Stop')
    cancel.type = 'button'
    cancel.addEventListener('click', () => void cancelStream())
    bodyHost.append(cancel)
    return
  }

  if (doneError !== null) {
    bodyHost.append(el('p', 'insights-notice', doneError))
    return
  }

  bodyHost.append(appliedBatchId !== null ? renderApplied() : renderPlan())
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function startRun(): Promise<void> {
  if (instruction.trim() === '' || selectedPaths.size === 0) return

  const docs = openDocuments().filter((doc) => selectedPaths.has(doc.node.relativePath))
  if (docs.length === 0) return

  resetRun()
  streaming = true
  hideDiff()
  render()

  const files = docs.map((doc) => ({ path: doc.node.relativePath, content: doc.model.getValue() }))
  for (const file of files) sentFiles.set(file.path, file.content)

  const result = await window.betterCallCompiler.agent.start({
    context: { instruction: instruction.trim(), files }
  })

  if (!result.ok) {
    streaming = false
    if (result.error.code === 'NO_API_KEY') hasKey = false
    else doneError = result.error.message
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

function settlePlan(): void {
  summary = extractAgentSummary(answer)
  plan = parseAgentPlan(answer)
  accepted = new Set(plan.map((edit) => edit.path))
}

async function applyPlan(): Promise<void> {
  if (started === null || applying) return
  const edits = plan.filter((edit) => accepted.has(edit.path))
  if (edits.length === 0) return

  applying = true
  render()

  const batchId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const result = await window.betterCallCompiler.agent.apply({
    batchId,
    edits,
    model: started.model,
    promptHash: started.promptHash
  })

  applying = false

  if (!result.ok) {
    notifyError(result.error.message)
    render()
    return
  }

  appliedBatchId = batchId
  appliedFiles = result.value.entries.map((entry) => entry.file)
  notify(`Applied ${appliedFiles.length} file(s). Revert the batch from here, or a file at a time from the Assistant journal.`, 'info')

  for (const file of edits) {
    const doc = openDocuments().find((candidate) => candidate.node.relativePath === file.path)
    if (doc !== undefined) await reloadFromDisk(doc.node.path)
  }

  render()

  if (edits.length > 1) void generateWalkthrough(edits)
}

/* ------------------------------------------------------------------ *
 * Walkthrough
 * ------------------------------------------------------------------ */

async function generateWalkthrough(edits: readonly AgentFileEdit[]): Promise<void> {
  walkthroughText = ''
  walkthroughArtifactId = null
  walkthroughStreaming = true
  render()

  const files = edits.map((edit) => ({
    path: edit.path,
    before: sentFiles.get(edit.path) ?? '',
    after: edit.content
  }))

  const result = await window.betterCallCompiler.walkthrough.start({ instruction, files })
  if (!result.ok) {
    walkthroughStreaming = false
    render()
    return
  }

  walkthroughStarted = result.value.started
  render()
}

async function finishWalkthrough(): Promise<void> {
  if (walkthroughStarted === null) return
  walkthroughStreaming = false

  if (walkthroughText.trim() === '') {
    render()
    return
  }

  const result = await window.betterCallCompiler.artifact.create({
    kind: 'walkthrough',
    title: `Walkthrough: ${instruction.trim().slice(0, 80)}`,
    model: walkthroughStarted.model,
    promptHash: walkthroughStarted.promptHash,
    contextSent: walkthroughStarted.contextSent,
    markdown: walkthroughText,
    supersedes: null,
    answersCommentId: null
  })

  walkthroughStarted = null

  if (!result.ok) {
    render()
    return
  }

  walkthroughArtifactId = result.value.artifact.id
  render()
}

/* ------------------------------------------------------------------ *
 * Semantic index
 * ------------------------------------------------------------------ */

async function buildIndex(): Promise<void> {
  indexBuilding = true
  render()

  const result = await window.betterCallCompiler.index.build({})
  indexBuilding = false

  if (!result.ok) {
    notifyError(result.error.message)
    render()
    return
  }

  indexStatus = result.value.status
  notify(`Index built: ${indexStatus.fileCount} files, ${indexStatus.chunkCount} chunks.`, 'info')
  render()
}

async function refreshIndexStatus(): Promise<void> {
  const result = await window.betterCallCompiler.index.status({})
  if (result.ok) indexStatus = result.value.status
}

async function suggestFiles(): Promise<void> {
  if (instruction.trim() === '') return
  suggesting = true
  render()

  const result = await window.betterCallCompiler.index.query({ instruction: instruction.trim(), limit: 8 })
  suggesting = false

  if (!result.ok) {
    notifyError(result.error.message)
    render()
    return
  }

  // Already-open, already-selected files add nothing a picker checkbox does
  // not already offer — the point of a suggestion is a file nobody had open.
  const openPaths = new Set(openDocuments().map((doc) => doc.node.relativePath))
  suggestions = result.value.matches.filter((match) => !openPaths.has(match.path))
  render()
}

async function toggleSuggestion(match: SemanticMatch, checked: boolean): Promise<void> {
  if (!checked) {
    selectedPaths.delete(match.path)
    render()
    return
  }

  if (workspaceRoot === null) {
    notifyError('No folder is open.')
    return
  }

  const opened = await openFile({
    name: match.path.slice(match.path.lastIndexOf('/') + 1),
    path: `${workspaceRoot}/${match.path}`,
    relativePath: match.path,
    kind: 'file'
  })
  if (!opened) {
    notifyError(`Could not open ${match.path}`)
    return
  }

  selectedPaths.add(match.path)
  render()
}

async function revertBatch(): Promise<void> {
  if (appliedBatchId === null) return

  const result = await window.betterCallCompiler.agent.revert({ batchId: appliedBatchId })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }

  notify(`Reverted ${result.value.entries.length} file(s).`, 'info')
  for (const entry of result.value.entries) {
    const doc = openDocuments().find((candidate) => candidate.node.relativePath === entry.file)
    if (doc !== undefined) await reloadFromDisk(doc.node.path)
  }

  appliedBatchId = null
  appliedFiles = []
  render()
}

function bindStreamEvents(): void {
  if (listenersBound) return
  listenersBound = true

  window.betterCallCompiler.ai.onDelta((payload) => {
    if (started !== null && payload.streamId === started.streamId) {
      answer += payload.text
      const output = document.getElementById('agent-answer')
      if (output !== null) {
        output.textContent = answer
        output.scrollTop = output.scrollHeight
      } else {
        render()
      }
      return
    }

    if (walkthroughStarted !== null && payload.streamId === walkthroughStarted.streamId) {
      walkthroughText += payload.text
    }
  })

  window.betterCallCompiler.ai.onDone((payload) => {
    if (started !== null && payload.streamId === started.streamId) {
      streaming = false
      doneError = payload.error
      if (doneError === null) settlePlan()
      render()
      return
    }

    if (walkthroughStarted !== null && payload.streamId === walkthroughStarted.streamId) {
      void finishWalkthrough()
    }
  })
}

/* --------------------------------- mount --------------------------------- */

async function refreshKey(): Promise<void> {
  const result = await window.betterCallCompiler.secrets.hasKey({})
  // Ollama needs no stored key; only block the composer when Anthropic is
  // the configured provider and no key is on file. `agent:start` still
  // reports NO_API_KEY on its own if this read is stale, so this is a
  // best-effort head start on the affordance, not the only place it fires.
  const settings = await window.betterCallCompiler.settings.get({})
  const usesOllama = settings.ok && settings.value.settings.aiProvider === 'ollama'
  hasKey = usesOllama || (result.ok && result.value.secrets.anthropic)
}

export async function mountAgent(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body

  const workspace = await window.betterCallCompiler.fs.getWorkspace({})
  workspaceRoot = workspace.ok ? workspace.value.root : null

  bindStreamEvents()
  await refreshKey()
  await refreshIndexStatus()
  render()
}

export function onAgentShown(): void {
  void refreshKey().then(render)
}
