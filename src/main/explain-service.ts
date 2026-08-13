import { formatAnchor } from '../shared/artifact-format'
import type { AiContext, AiStarted, Artifact } from '../shared/types'
import { hashPrompt, renderContext, startPromptStream } from './ai-service'
import { dependentsOf } from './compiler-service'

/**
 * The Explain artifact: prompt, context, and the graph walk that feeds it.
 *
 * Separate from ai-service.ts because it wants a different answer shape. The
 * inline `explain` mode produces prose to read once and dismiss; this produces
 * a document with headings and citations that will be stored, re-read, and
 * commented on. Same provider, same transport — different question.
 *
 * The behaviour being matched is Antigravity's: an explanation is an artifact
 * that persists, cites specific code, and can be commented on, where the
 * comment steers the agent rather than starting a fresh conversation. None of
 * their code, prompts or assets are used.
 */

/** Artifacts are longer than an inline answer, and are read more than once. */
const MAX_TOKENS = 3000

/**
 * How far to walk the import graph for neighbour context.
 *
 * One hop, and named rather than inlined. RepoGraph (arXiv:2410.14684) and
 * RANGER (arXiv:2509.25257) both use the repository graph as the retrieval
 * index instead of an embedding store, which is exactly the shape already
 * maintained here by dependency-graph.ts — so the graph is walked rather than
 * a second index being built.
 *
 * Two hops was tempting and is wrong at this budget: it spends the token
 * allowance on files the selection cannot reach directly, and the model is
 * better served by knowing accurately what depends on this file than vaguely
 * what depends on that.
 */
const NEIGHBOUR_LIMIT = 12

const SYSTEM_PROMPT =
  'You are a precise code explainer embedded in an IDE. You are producing a ' +
  'DOCUMENT that will be stored and re-read, not a chat reply.\n\n' +
  'Structure it with markdown headings (##). Open with one plain sentence of ' +
  'summary before the first heading. Cover what the code does, how control ' +
  'flows through it, and any non-obvious behaviour or edge case. Do not ' +
  'restate the code line by line.\n\n' +
  'Cite specific code using this exact syntax, inline, wherever you refer to ' +
  'a particular place:\n' +
  '  [[relative/path.ts:12-20 symbolName]]\n' +
  '  [[relative/path.ts:12]]\n' +
  'The path must be one of the files listed in the context. Line numbers must ' +
  'be real lines of that file. Cite the code you are describing rather than ' +
  'decorating every sentence — an uncited claim is better than a wrong ' +
  'citation, because a reader will check the line you name.\n\n' +
  'Do not suggest changes unless the behaviour is genuinely surprising.'

/**
 * The follow-up prompt, used when a comment on an artifact is answered.
 *
 * Written as a revision of a document rather than a reply in a thread. The
 * reply is a new artifact that stands alone, so the reader of the answer must
 * not have to fetch the question to make sense of it.
 */
const REVISION_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  '\n\nYou are REVISING an explanation you wrote earlier, in response to a ' +
  'reader’s comment. Produce a complete replacement document, not a diff and ' +
  'not a reply — it will be read on its own by someone who has not seen the ' +
  'earlier version. Address the comment directly and specifically; if the ' +
  'comment rests on a misunderstanding, say so plainly rather than agreeing.'

/**
 * Neighbours of the selection's file, by name.
 *
 * Names and directions only, not contents. What the model actually lacks is
 * knowing that this file has dependents at all — a function is explained very
 * differently when fourteen files import it than when nothing does — and the
 * token cost of that fact is a line, while the cost of the contents is the
 * whole budget.
 */
export function renderNeighbours(
  imports: readonly string[],
  importedBy: readonly string[]
): string {
  const parts: string[] = []

  if (imports.length > 0) {
    parts.push(`This file imports: ${imports.slice(0, NEIGHBOUR_LIMIT).join(', ')}`)
    if (imports.length > NEIGHBOUR_LIMIT) {
      parts.push(`  (and ${imports.length - NEIGHBOUR_LIMIT} more)`)
    }
  }

  if (importedBy.length > 0) {
    parts.push(`Imported by: ${importedBy.slice(0, NEIGHBOUR_LIMIT).join(', ')}`)
    if (importedBy.length > NEIGHBOUR_LIMIT) {
      // Stated rather than silently truncated. "Imported by 3 files" and
      // "imported by 200 files" call for different explanations, and a list cut
      // to twelve with no note reads as the former in both cases.
      parts.push(`  (and ${importedBy.length - NEIGHBOUR_LIMIT} more — this file has wide fan-in)`)
    }
  }

  return parts.join('\n')
}

/**
 * Everything the model is told, verbatim.
 *
 * Built on `renderContext` rather than beside it: that function is what the
 * "Context sent" panel already shows character for character, and a second
 * renderer would drift from it. The artifact-specific parts are appended.
 */
export function renderExplainContext(
  context: AiContext,
  neighbours: string,
  priorArtifact: Artifact | null,
  question: string | null
): string {
  const parts = [renderContext(context)]

  if (neighbours !== '') {
    parts.push('', 'Where this file sits in the import graph:', neighbours)
  }

  // Told explicitly, because the citation syntax is only useful if the model
  // knows which path string to put in it. Without this it guesses at the
  // repository layout and cites paths that do not resolve.
  parts.push(
    '',
    `Cite this file as: ${context.relativePath}`,
    `The selection is lines ${context.selection.startLine}-${context.selection.endLine} of that file, ` +
      `e.g. ${formatAnchor({
        relativePath: context.relativePath,
        startLine: context.selection.startLine,
        endLine: context.selection.endLine,
        symbol: context.enclosingSymbol?.name ?? null,
        snapshotHash: ''
      })}`
  )

  if (priorArtifact !== null) {
    parts.push(
      '',
      'The explanation you wrote earlier:',
      '---',
      priorArtifact.sections
        .map((section) => (section.heading === '' ? section.markdown : `## ${section.heading}\n${section.markdown}`))
        .join('\n\n'),
      '---'
    )
  }

  if (question !== null && question.trim() !== '') {
    parts.push('', 'The reader’s comment:', question.trim())
  }

  return parts.join('\n')
}

export interface ExplainRequest {
  readonly context: AiContext
  /** The artifact being revised, when this is an answer to a comment. */
  readonly priorArtifact: Artifact | null
  readonly question: string | null
}

/**
 * Starts an Explain stream and returns what was sent.
 *
 * Streams rather than resolving with the finished document, for the same reason
 * the AI panel does: a silent twenty-second wait reads as a hang. The renderer
 * accumulates the deltas and asks for the artifact to be stored when the stream
 * completes — the same division of labour as `ai:apply`, where the renderer
 * sends the finished result and main records it.
 */
export async function startExplain(request: ExplainRequest): Promise<AiStarted> {
  const query = await dependentsOf(request.context.relativePath)
  const neighbours = renderNeighbours(query.node?.imports ?? [], query.dependents)

  const user = renderExplainContext(
    request.context,
    neighbours,
    request.priorArtifact,
    request.question
  )
  const system = request.priorArtifact === null ? SYSTEM_PROMPT : REVISION_SYSTEM_PROMPT

  return startPromptStream('explain', system, user, MAX_TOKENS)
}

/** Re-exported so the IPC layer has one import for the whole flow. */
export { hashPrompt }
