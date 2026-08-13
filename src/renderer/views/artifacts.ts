import {
  EXPLAIN_ARTIFACT_EVENT,
  type ExplainArtifactDetail
} from '../editor/ai-actions'
import { openFile, revealLocation } from '../editor/models'
import { notify, notifyError } from '../workbench/notifications'
import { parseAnchors, titleForExplanation } from '../../shared/artifact-format'
import type {
  AiContext,
  AiStarted,
  Artifact,
  ArtifactSummary,
  CodeAnchorRecord,
  FileNode
} from '../../shared/types'

/**
 * The Artifacts panel — durable, code-anchored explanations.
 *
 * The contract being reproduced is Antigravity's: an explanation is not a chat
 * message that scrolls away, it is a document that persists, cites specific
 * code, and can be commented on — and a comment steers the agent rather than
 * starting a fresh conversation. Their docs describe the walkthrough artifact
 * as what gets you up to speed "in case you were not strictly following it the
 * whole time", which only works if the thing outlives the conversation.
 *
 * Built entirely on this project's own ai-service and artifact-store. Two
 * things are added that the original does not have: every anchor knows whether
 * the code it describes has changed since it was written, and the exact context
 * sent to the model is stored with the document rather than being reconstructed
 * for display.
 */

const api = window.betterCallCompiler

type Mode =
  | { readonly kind: 'list' }
  | { readonly kind: 'reading'; readonly id: string }
  | { readonly kind: 'generating' }

let bodyHost: HTMLElement | null = null
let titleHost: HTMLElement | null = null

let mode: Mode = { kind: 'list' }
let summaries: ArtifactSummary[] = []
let current: Artifact | null = null
let anchorStates: Record<string, string> = {}
let workspaceRoot: string | null = null
let listenersBound = false

/** In-flight generation state. */
let started: AiStarted | null = null
let streamText = ''
let streamError: string | null = null
let pendingContext: AiContext | null = null
let pendingSupersedes: string | null = null
let pendingCommentId: string | null = null
let pendingIsRevision = false

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

function when(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/* -------------------------------- navigation ------------------------------ */

async function revealAnchor(anchor: CodeAnchorRecord): Promise<void> {
  if (workspaceRoot === null) {
    notifyError('No folder is open.')
    return
  }

  const node: FileNode = {
    name: anchor.relativePath.slice(anchor.relativePath.lastIndexOf('/') + 1),
    // The store keeps workspace-relative paths; the editor opens absolute ones.
    path: `${workspaceRoot}/${anchor.relativePath}`,
    relativePath: anchor.relativePath,
    kind: 'file'
  }

  const opened = await openFile(node)
  if (!opened) {
    notifyError(`Could not open ${anchor.relativePath}`)
    return
  }
  await revealLocation(node, anchor.startLine, 1)
}

/* --------------------------------- rendering ------------------------------ */

/**
 * Renders markdown with citations turned into buttons.
 *
 * Deliberately not a markdown renderer. The CSP forbids inline scripts and the
 * panel has no sanitiser, so the text is inserted as TEXT and only the
 * citations become elements — the one transformation worth the risk, because a
 * citation you cannot click is just a line number to type out by hand.
 */
function renderBody(markdown: string, anchors: readonly CodeAnchorRecord[]): HTMLElement {
  const wrap = el('div', 'artifact-body')
  const byKey = new Map(
    anchors.map((anchor) => [`${anchor.relativePath}:${anchor.startLine}-${anchor.endLine}`, anchor])
  )

  for (const paragraph of markdown.split(/\n{2,}/)) {
    if (paragraph.trim() === '') continue
    const block = el('p', 'artifact-para')

    let cursor = 0
    for (const parsed of parseAnchors(paragraph)) {
      const key = `${parsed.relativePath}:${parsed.startLine}-${parsed.endLine}`
      const stored = byKey.get(key)
      // Locate the citation in the raw text so the surrounding prose is placed
      // in the right order; a citation the store never saw is left as text.
      const marker = paragraph.indexOf('[[', cursor)
      if (marker < 0) break
      const close = paragraph.indexOf(']]', marker)
      if (close < 0) break

      block.append(document.createTextNode(paragraph.slice(cursor, marker)))
      block.append(stored === undefined ? document.createTextNode(paragraph.slice(marker, close + 2)) : anchorChip(stored))
      cursor = close + 2
    }
    block.append(document.createTextNode(paragraph.slice(cursor)))
    wrap.append(block)
  }

  return wrap
}

function anchorChip(anchor: CodeAnchorRecord): HTMLElement {
  const key = anchorKeyOf(anchor)
  const state = anchorStates[key] ?? 'current'

  const button = el('button', `artifact-anchor artifact-anchor--${state}`)
  button.type = 'button'
  const range =
    anchor.startLine === anchor.endLine
      ? String(anchor.startLine)
      : `${anchor.startLine}-${anchor.endLine}`
  button.textContent = `${anchor.relativePath}:${range}`

  // The whole reason for storing a hash. An explanation read a week later
  // should say that it is describing code that has moved on, rather than
  // pointing confidently at whatever now occupies those lines.
  button.title =
    state === 'current'
      ? 'The code here is unchanged since this was written.'
      : state === 'stale'
        ? 'These lines have changed since this was written — verify before trusting it.'
        : 'These lines no longer exist.'

  if (state !== 'current') button.append(el('span', 'artifact-anchor__flag', state))
  button.addEventListener('click', () => void revealAnchor(anchor))
  return button
}

/** Matches the key the store computes: `sectionId:anchorIndex`. */
let anchorKeys = new Map<CodeAnchorRecord, string>()
function anchorKeyOf(anchor: CodeAnchorRecord): string {
  return anchorKeys.get(anchor) ?? ''
}

function renderList(): HTMLElement {
  const wrap = el('div', 'artifact-list')

  if (summaries.length === 0) {
    wrap.append(
      el(
        'p',
        'explorer__empty-text',
        'No explanations yet. Select code in the editor, right-click, and choose “Explain as Artifact”.'
      )
    )
    return wrap
  }

  for (const summary of summaries) {
    const row = el('div', 'artifact-row')
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.dataset['artifactId'] = summary.id

    row.append(el('div', 'artifact-row__title', summary.title))

    const meta = el('div', 'artifact-row__meta')
    meta.append(el('span', undefined, when(summary.createdAt)))
    meta.append(el('span', undefined, `${summary.sectionCount} sections`))
    if (summary.commentCount > 0) {
      meta.append(el('span', undefined, `${summary.commentCount} comments`))
    }
    // A revision is marked in the list, not only inside the document. Two
    // similarly-titled entries with no way to tell which answered which is how
    // a history stops being usable.
    if (summary.supersedes !== null) meta.append(el('span', 'artifact-badge', 'revision'))
    if (summary.unansweredCommentCount > 0) {
      meta.append(
        el('span', 'artifact-badge artifact-badge--open', `${summary.unansweredCommentCount} unanswered`)
      )
    }
    row.append(meta)

    const open = (): void => void show(summary.id)
    row.addEventListener('click', open)
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })
    wrap.append(row)
  }

  return wrap
}

function renderGenerating(): HTMLElement {
  const wrap = el('div', 'artifact-generating')
  wrap.append(el('div', 'artifact-generating__label', 'Writing the explanation…'))

  if (streamError !== null) {
    wrap.append(el('p', 'artifact-error', streamError))
    return wrap
  }

  // The raw stream, shown as it arrives. It is not the artifact yet — the
  // document is parsed and anchored only once the model stops — but a silent
  // twenty-second wait reads as a hang.
  const output = el('pre', 'artifact-stream')
  output.id = 'artifact-stream'
  output.textContent = streamText === '' ? '…' : streamText
  wrap.append(output)

  const cancel = el('button', 'button', 'Cancel')
  cancel.type = 'button'
  cancel.addEventListener('click', () => {
    if (started !== null) void api.ai.cancel({ streamId: started.streamId })
  })
  wrap.append(cancel)
  return wrap
}

function renderReader(artifact: Artifact): HTMLElement {
  const wrap = el('div', 'artifact-reader')

  const back = el('button', 'button artifact-back', '← All explanations')
  back.type = 'button'
  back.addEventListener('click', () => {
    mode = { kind: 'list' }
    current = null
    render()
  })
  wrap.append(back)

  wrap.append(el('h2', 'artifact-title', artifact.title))
  wrap.append(
    el(
      'div',
      'artifact-meta',
      `${when(artifact.createdAt)} · ${artifact.model} · prompt ${artifact.promptHash}`
    )
  )

  if (artifact.supersedes !== null) {
    const link = el('button', 'artifact-supersedes', 'Revision of an earlier explanation — open it')
    link.type = 'button'
    link.addEventListener('click', () => void show(artifact.supersedes ?? ''))
    wrap.append(link)
  }

  for (const section of artifact.sections) {
    const block = el('section', 'artifact-section')
    block.dataset['sectionId'] = section.id
    if (section.heading !== '') block.append(el('h3', 'artifact-heading', section.heading))
    block.append(renderBody(section.markdown, section.anchors))

    const threads = artifact.comments.filter((comment) => comment.sectionId === section.id)
    for (const comment of threads) block.append(renderComment(comment.body, comment.respondedInArtifactId))
    block.append(commentBox(artifact.id, section.id))
    wrap.append(block)
  }

  const general = artifact.comments.filter((comment) => comment.sectionId === null)
  if (general.length > 0 || artifact.sections.length === 0) {
    const block = el('section', 'artifact-section')
    block.append(el('h3', 'artifact-heading', 'On the whole explanation'))
    for (const comment of general) block.append(renderComment(comment.body, comment.respondedInArtifactId))
    block.append(commentBox(artifact.id, null))
    wrap.append(block)
  } else {
    wrap.append(commentBox(artifact.id, null))
  }

  // Verbatim, straight from the record. The same guarantee the AI panel makes:
  // a viewer that rebuilds its own approximation of the prompt drifts, and the
  // transparency claim quietly becomes false.
  const details = el('details', 'artifact-context')
  details.append(el('summary', undefined, 'Context sent to the model'))
  details.append(el('pre', 'artifact-context__body', artifact.contextSent))
  wrap.append(details)

  return wrap
}

function renderComment(body: string, respondedIn: string | null): HTMLElement {
  const node = el('div', 'artifact-comment')
  node.append(el('div', 'artifact-comment__body', body))

  if (respondedIn === null) {
    node.append(el('div', 'artifact-comment__state', 'Not yet answered'))
    return node
  }

  const link = el('button', 'artifact-comment__link', 'Answered — open the revision')
  link.type = 'button'
  link.addEventListener('click', () => void show(respondedIn))
  node.append(link)
  return node
}

/**
 * The comment affordance.
 *
 * Two buttons, deliberately. "Comment" records a note against the document and
 * leaves it alone; "Comment & ask again" records it AND sends it back to the
 * model. Separating them means leaving a remark for yourself does not spend
 * tokens, and asking for a revision is never something that happens by
 * accident.
 */
function commentBox(artifactId: string, sectionId: string | null): HTMLElement {
  const box = el('div', 'artifact-commentbox')

  const input = el('textarea', 'artifact-commentbox__input')
  input.rows = 2
  input.placeholder =
    sectionId === null ? 'Comment on this explanation…' : 'Comment on this section…'
  box.append(input)

  const actions = el('div', 'artifact-commentbox__actions')

  const save = el('button', 'button', 'Comment')
  save.type = 'button'
  save.addEventListener('click', () => {
    void addComment(artifactId, sectionId, input.value, false)
  })

  const ask = el('button', 'button button--primary', 'Comment & ask again')
  ask.type = 'button'
  ask.addEventListener('click', () => {
    void addComment(artifactId, sectionId, input.value, true)
  })

  actions.append(save, ask)
  box.append(actions)
  return box
}

function render(): void {
  if (bodyHost === null) return

  const root = el('div', 'artifacts')
  if (mode.kind === 'generating') root.append(renderGenerating())
  else if (mode.kind === 'reading' && current !== null) root.append(renderReader(current))
  else root.append(renderList())

  bodyHost.replaceChildren(root)
}

/* ---------------------------------- actions ------------------------------- */

async function refreshList(): Promise<void> {
  const result = await api.artifact.list({})
  summaries = result.ok ? result.value.artifacts : []
}

async function show(id: string): Promise<void> {
  if (id === '') return

  const result = await api.artifact.get({ id })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }

  current = result.value.artifact
  anchorStates = result.value.anchorStates

  // Rebuilt on every load: the keys are positional, and holding them across a
  // reload would attach the previous document's staleness to this one's
  // anchors.
  anchorKeys = new Map()
  for (const section of current.sections) {
    for (const [index, anchor] of section.anchors.entries()) {
      anchorKeys.set(anchor, `${section.id}:${index}`)
    }
  }

  mode = { kind: 'reading', id }
  render()
}

async function addComment(
  artifactId: string,
  sectionId: string | null,
  body: string,
  askAgain: boolean
): Promise<void> {
  if (body.trim() === '') return

  const result = await api.artifact.comment({ id: artifactId, sectionId, body })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }

  current = result.value.artifact
  await refreshList()

  if (!askAgain) {
    notify('Comment saved.')
    render()
    return
  }

  const comment = [...result.value.artifact.comments].reverse()[0]
  if (comment === undefined) return
  await startExplain(null, artifactId, comment.id, body)
}

/**
 * Starts a generation.
 *
 * `context` is null when revising: main re-reads the stored artifact and its
 * own recorded context rather than trusting the renderer to hand back a
 * document it might have mutated. On a first explanation the renderer is the
 * only place the selection exists, so it supplies it.
 */
async function startExplain(
  context: AiContext | null,
  supersedes: string | null,
  commentId: string | null,
  question: string | null
): Promise<void> {
  const source = context ?? pendingContext
  if (source === null) {
    notifyError('Select the code to explain first.')
    return
  }

  pendingContext = source
  pendingSupersedes = supersedes
  pendingCommentId = commentId
  pendingIsRevision = supersedes !== null
  streamText = ''
  streamError = null
  mode = { kind: 'generating' }
  render()

  const result = await api.explain.start({ context: source, supersedes, commentId, question })
  if (!result.ok) {
    streamError =
      result.error.code === 'NO_API_KEY'
        ? 'No Anthropic API key is configured. Add one in Settings.'
        : result.error.message
    render()
    return
  }

  started = result.value.started
  render()
}

async function finishExplain(): Promise<void> {
  if (started === null || pendingContext === null) return

  if (streamText.trim() === '') {
    streamError = streamError ?? 'The model returned nothing.'
    render()
    return
  }

  const result = await api.artifact.create({
    kind: 'explanation',
    title: titleForExplanation(
      pendingContext.relativePath,
      pendingContext.selection.startLine,
      pendingContext.enclosingSymbol?.name ?? null,
      pendingIsRevision
    ),
    model: started.model,
    promptHash: started.promptHash,
    contextSent: started.contextSent,
    markdown: streamText,
    supersedes: pendingSupersedes,
    answersCommentId: pendingCommentId
  })

  started = null

  if (!result.ok) {
    streamError = result.error.message
    render()
    return
  }

  await refreshList()
  await show(result.value.artifact.id)
}

function bindEvents(): void {
  if (listenersBound) return
  listenersBound = true

  api.ai.onDelta((payload) => {
    if (started === null || payload.streamId !== started.streamId) return
    streamText += payload.text
    // Appended to the existing node rather than re-rendering. A full render per
    // token would rebuild the panel hundreds of times during one explanation.
    const output = document.getElementById('artifact-stream')
    if (output !== null) {
      output.textContent = streamText
      output.scrollTop = output.scrollHeight
    }
  })

  api.ai.onDone((payload) => {
    if (started === null || payload.streamId !== started.streamId) return

    if (payload.cancelled) {
      started = null
      mode = { kind: 'list' }
      render()
      return
    }
    if (payload.error !== null) {
      streamError = payload.error
      started = null
      render()
      return
    }
    void finishExplain()
  })

  api.artifact.onChanged(() => {
    void refreshList().then(() => {
      if (mode.kind === 'list') render()
    })
  })

  document.addEventListener(EXPLAIN_ARTIFACT_EVENT, (event) => {
    const detail = (event as CustomEvent<ExplainArtifactDetail>).detail
    activate?.()
    void startExplain(detail.context, null, null, null)
  })
}

/** Set by main.ts so an editor action can bring this panel to the front. */
let activate: (() => void) | null = null

export function setArtifactsViewActivator(fn: () => void): void {
  activate = fn
}

/**
 * Bound once at start-up, not on first mount.
 *
 * The panel is lazily mounted like every other tool window, and an explanation
 * requested before it has ever been opened must still be captured — otherwise
 * the first use of the feature streams into nothing.
 */
export function listenForExplainRequests(): void {
  bindEvents()
}

export async function mountArtifacts(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body
  title.replaceChildren(el('span', 'side-bar__title-text', 'Explanations'))

  const workspace = await api.fs.getWorkspace({})
  workspaceRoot = workspace.ok ? workspace.value.root : null

  bindEvents()
  await refreshList()
  render()
}

export function onArtifactsShown(): void {
  if (titleHost === null) return
  void refreshList().then(render)
}
