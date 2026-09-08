import type { AiStarted } from '../shared/types'
import { startPromptStream } from './ai-service'

/**
 * The Walkthrough artifact: a durable, code-anchored summary of a multi-file
 * change that was just applied.
 *
 * The storage half of this already existed — `artifactKindSchema` has
 * carried `'walkthrough'` since the Explain artifact was built, and
 * `artifact-store.ts` already prefixes its ids `wt-` — but nothing produced
 * one. This is that producer: same transport as Explain
 * (`startPromptStream`), same citation syntax (`[[path:start-end]]`, parsed
 * by the same `artifact-format.ts` the Artifacts panel already renders), so
 * a walkthrough is not a new kind of document the panel has to learn to
 * show — it is the same kind of document Explain already makes, pointed at
 * a diff instead of a selection.
 *
 * Deliberately separate from `explain-service.ts` rather than a mode flag on
 * it: an Explain prompt is built from one file's compiler diagnostics and
 * import neighbours; a walkthrough is built from N files' before/after
 * content and has no selection to diagnose. Forcing both into one function
 * would mean every future change to either has to reason about the other.
 */

export interface WalkthroughFileChange {
  readonly path: string
  readonly before: string
  readonly after: string
}

export interface WalkthroughRequest {
  readonly instruction: string
  readonly files: readonly WalkthroughFileChange[]
}

/** Same ceiling as Explain: a document meant to be stored and re-read, not an inline answer. */
const MAX_TOKENS = 3000

const SYSTEM_PROMPT =
  'You are producing a WALKTHROUGH document for a multi-file code change ' +
  'that has just been applied. You are given the instruction that was ' +
  'carried out and, for each file touched, its content before and after. ' +
  'You are producing a DOCUMENT that will be stored and re-read, not a chat ' +
  'reply.\n\n' +
  'Structure it with markdown headings (##), one per file changed, in a ' +
  'sensible reading order — usually the file a reader should look at first, ' +
  'first. Open with one plain sentence summarizing the change as a whole, ' +
  'before the first heading.\n\n' +
  'For each file, explain WHAT changed and WHY, in the context of the ' +
  'instruction — do not restate the diff line by line. Cite the changed ' +
  'code using this exact syntax, inline, wherever you refer to a specific ' +
  'place:\n' +
  '  [[relative/path.ts:12-20 symbolName]]\n' +
  '  [[relative/path.ts:12]]\n' +
  'Line numbers refer to the file AFTER the change. The path must be one of ' +
  'the files listed below. Cite the code you are describing rather than ' +
  'decorating every sentence — an uncited claim is better than a wrong ' +
  'citation, because a reader will click the line you name.'

/**
 * Everything the model is told, verbatim — what the artifact's stored
 * `contextSent` field will show, exactly as `renderExplainContext` is for
 * Explain.
 */
export function renderWalkthroughContext(request: WalkthroughRequest): string {
  const parts = [`Instruction that was carried out: ${request.instruction}`, '']

  for (const file of request.files) {
    parts.push(
      `### FILE: ${file.path}`,
      'Before:',
      '```',
      file.before,
      '```',
      'After:',
      '```',
      file.after,
      '```',
      ''
    )
  }

  return parts.join('\n').trimEnd()
}

/**
 * Starts a walkthrough stream and returns what was sent — same shape as
 * `startExplain`: the renderer accumulates the deltas and calls
 * `artifact:create` with `kind: 'walkthrough'` once the stream settles.
 *
 * Labelled `'agent'` on the wire (`AiStarted.mode`) rather than earning a
 * fifth `AiMode`: this stream is never journaled in `ai-log.ts` — nothing
 * here writes a file — so the label only has to be honest about which
 * feature produced it, and a walkthrough only ever follows an agent batch.
 */
export async function startWalkthrough(request: WalkthroughRequest): Promise<AiStarted> {
  const user = renderWalkthroughContext(request)
  return startPromptStream('agent', SYSTEM_PROMPT, user, MAX_TOKENS)
}
