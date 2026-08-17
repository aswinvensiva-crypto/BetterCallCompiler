import { formatAnchor } from '../shared/artifact-format'
import type {
  AiContext,
  AiStarted,
  Artifact,
  DiagnosticMessage,
  DiagnosticSeverity,
  FileDiagnostics
} from '../shared/types'
import { hashPrompt, renderContext, startPromptStream } from './ai-service'
import { dependentsOf, diagnosticsFor } from './compiler-service'

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

/**
 * How many diagnostics from the selected lines are listed individually.
 *
 * Past this the model is being handed a compiler log rather than context, and
 * a selection with fifty errors in it is usually one broken thing reported
 * fifty times. The remainder is counted rather than dropped silently.
 */
const MAX_REGION_DIAGNOSTICS = 10

/** Errors first: what stops the build outranks what merely warns about it. */
const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3
}

/**
 * What the daemon has to say about the selected lines.
 *
 * The three outcomes are deliberately distinct, and conflating the first two is
 * the mistake this type exists to prevent:
 *
 *   `known: false`      — the daemon has never checked this file. It has NO
 *                         opinion. Reporting that as "no problems" would tell
 *                         the model a file is clean when nothing looked at it.
 *   `known: true`, empty — checked, and genuinely clean. That is information.
 *   `known: true`, full  — checked, and here is what is wrong.
 */
export type RegionDiagnostics =
  | { readonly known: false }
  | {
      readonly known: true
      readonly inRegion: readonly DiagnosticMessage[]
      readonly elsewhere: readonly DiagnosticMessage[]
      readonly truncated: number
    }

/**
 * Splits one file's diagnostics into those describing the selection and the rest.
 *
 * Lives here rather than in `src/shared` because the cap, the ordering and the
 * definition of "the region" are Explain's policy rather than shared facts —
 * the same reason `renderNeighbours` is here and not in dependency-graph.ts.
 *
 * Takes `FileDiagnostics[]` because that is exactly what `diagnosticsFor`
 * returns, so the caller has no reshaping to get wrong.
 */
export function selectRegionDiagnostics(
  files: readonly FileDiagnostics[],
  relativePath: string,
  startLine: number,
  endLine: number
): RegionDiagnostics {
  const entry = files.find((file) => file.relativePath === relativePath)
  if (entry === undefined) return { known: false }

  const inRegion: DiagnosticMessage[] = []
  const elsewhere: DiagnosticMessage[] = []

  for (const diagnostic of entry.diagnostics) {
    // Overlap, not containment. A diagnostic whose range straddles the top or
    // the bottom of the selection is describing the selected code — requiring
    // full containment would drop exactly the multi-line errors that are
    // hardest to read.
    const overlaps = diagnostic.startLine <= endLine && diagnostic.endLine >= startLine
    if (overlaps) inRegion.push(diagnostic)
    else elsewhere.push(diagnostic)
  }

  // Deterministic, so the same daemon state produces the same prompt — which is
  // what makes `hashPrompt` meaningful and lets the tests assert exact strings.
  inRegion.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.startLine - b.startLine ||
      a.startColumn - b.startColumn ||
      a.code.localeCompare(b.code)
  )

  return {
    known: true,
    inRegion: inRegion.slice(0, MAX_REGION_DIAGNOSTICS),
    elsewhere,
    truncated: Math.max(0, inRegion.length - MAX_REGION_DIAGNOSTICS)
  }
}

/** `2 errors, 1 warning` — counts only, because the rest is not being listed. */
function summarise(diagnostics: readonly DiagnosticMessage[]): string {
  const counts = new Map<DiagnosticSeverity, number>()
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.severity, (counts.get(diagnostic.severity) ?? 0) + 1)
  }

  const order: readonly DiagnosticSeverity[] = ['error', 'warning', 'info', 'hint']
  return order
    .filter((severity) => (counts.get(severity) ?? 0) > 0)
    .map((severity) => {
      const n = counts.get(severity) ?? 0
      return `${n} ${n === 1 ? severity : `${severity}s`}`
    })
    .join(', ')
}

/**
 * The compiler's view of the selection, as prompt text.
 *
 * This is the part neither VS Code's nor Antigravity's explain does: the model
 * is told what the type system actually reports for these lines, so the
 * explanation is grounded in the checker rather than in the model's reading of
 * the syntax.
 *
 * An unknown region renders as the empty string, and the caller omits the
 * section entirely — so a file the daemon has never seen produces a prompt
 * byte-identical to the one this feature replaced.
 *
 * The provenance clause is load-bearing rather than decoration. `FileDiagnostics.version`
 * is an emission counter, not a document version, so nothing here can prove
 * these diagnostics describe the exact buffer the user just selected. Saying
 * which check they came from is the honest form of that limitation.
 */
export function renderRegionDiagnostics(
  region: RegionDiagnostics,
  startLine: number,
  endLine: number
): string {
  if (!region.known) return ''

  const lines: string[] = []

  if (region.inRegion.length > 0) {
    lines.push(
      `What the compiler reports for lines ${startLine}-${endLine} ` +
        `(from the daemon's most recent check of this file):`
    )
    for (const diagnostic of region.inRegion) {
      lines.push(
        `  ${diagnostic.startLine}:${diagnostic.startColumn} ${diagnostic.severity} ` +
          `${diagnostic.code}: ${diagnostic.message}`
      )
    }
    if (region.truncated > 0) lines.push(`  (and ${region.truncated} more)`)
    if (region.elsewhere.length > 0) {
      lines.push(`Elsewhere in this file: ${summarise(region.elsewhere)}.`)
    }
    lines.push('Explain what in this code produces these, rather than restating the messages.')
    return lines.join('\n')
  }

  if (region.elsewhere.length > 0) {
    return (
      `The compiler reports nothing for lines ${startLine}-${endLine}. ` +
      `Elsewhere in this file: ${summarise(region.elsewhere)}.`
    )
  }

  return 'The compiler reports no problems anywhere in this file.'
}

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
  diagnostics: string,
  priorArtifact: Artifact | null,
  question: string | null
): string {
  const parts = [renderContext(context)]

  if (neighbours !== '') {
    parts.push('', 'Where this file sits in the import graph:', neighbours)
  }

  // An already-rendered string, exactly like `neighbours`, so this function
  // keeps knowing nothing about DiagnosticMessage and stays a text assembler.
  //
  // Required rather than defaulted to '': a default would let a future caller
  // silently drop the compiler grounding and still typecheck, and the whole
  // point of the parameter is that the grounding is not optional when it exists.
  //
  // Placed here because what follows divides into facts about this file and
  // then instructions about how to answer. Diagnostics are a fact, so they join
  // the facts. No header is added — renderRegionDiagnostics emits its own.
  if (diagnostics !== '') {
    parts.push('', diagnostics)
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
  const { system, user } = await buildExplainPrompt(request)
  return startPromptStream('explain', system, user, MAX_TOKENS)
}

/**
 * Everything that decides what the model is asked, with nothing that talks to it.
 *
 * Split out of `startExplain` for the same reason `buildPrompt` is split out of
 * `startAiStream`: the assembly is the part worth testing and the transport is
 * the part that needs an API key. What is left in `startExplain` is one call it
 * would be perverse to get wrong.
 *
 * `diagnosticsFor` is a synchronous Map read, so grounding the prompt in the
 * compiler costs the Explain path nothing measurable — the `await dependentsOf`
 * round trip to the worker still dominates. The two path spaces join without
 * normalising: AiContext.relativePath and the daemon's keys are produced by
 * character-identical `toRelative` implementations.
 */
export async function buildExplainPrompt(
  request: ExplainRequest
): Promise<{ system: string; user: string }> {
  const { relativePath, selection } = request.context

  const query = await dependentsOf(relativePath)
  const neighbours = renderNeighbours(query.node?.imports ?? [], query.dependents)

  const region = selectRegionDiagnostics(
    diagnosticsFor(relativePath),
    relativePath,
    selection.startLine,
    selection.endLine
  )
  const diagnostics = renderRegionDiagnostics(region, selection.startLine, selection.endLine)

  const user = renderExplainContext(
    request.context,
    neighbours,
    diagnostics,
    request.priorArtifact,
    request.question
  )
  const system = request.priorArtifact === null ? SYSTEM_PROMPT : REVISION_SYSTEM_PROMPT

  return { system, user }
}

/** Re-exported so the IPC layer has one import for the whole flow. */
export { hashPrompt }
