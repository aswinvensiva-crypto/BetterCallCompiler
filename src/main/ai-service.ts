import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import type { AiContext, AiDone, AiMode, AiStarted, AiStreamDelta } from '../shared/types'
import { readSecret } from './secrets'
import { loadSettings } from './settings'

/**
 * Claude, in the main process only.
 *
 * The key never crosses the bridge — `readSecret` is main-only and no handler
 * returns it — and the renderer's CSP is `connect-src 'none'`, so the renderer
 * could not reach the API even if it held one.
 *
 * Everything above the transport is a pure function of the request: the prompt
 * builders and the context renderer below take data and return strings, so the
 * exact text sent to the model can be shown to the user *and* asserted in tests
 * without a network call or an API key.
 */

/* ------------------------------------------------------------------ *
 * Provider seam
 * ------------------------------------------------------------------ */

/**
 * The narrow surface the rest of the app depends on.
 *
 * Deliberately not "an Anthropic client": a second backend — a local Ollama, the
 * strategic bet — has to drop in without the renderer or the IPC table
 * changing. Everything Anthropic-specific is confined to `anthropicProvider`.
 */
export interface AiProvider {
  readonly id: string
  /** Streams text deltas; resolves when the model stops. */
  readonly stream: (request: ProviderRequest) => Promise<ProviderResult>
}

export interface ProviderRequest {
  readonly model: string
  readonly system: string
  readonly user: string
  readonly maxTokens: number
  readonly onText: (delta: string) => void
  readonly signal: AbortSignal
}

export interface ProviderResult {
  readonly stopReason: string | null
}

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPTS: Readonly<Record<AiMode, string>> = {
  explain:
    'You are a precise code explainer embedded in an IDE. Explain what the ' +
    'selected code does: its inputs and outputs, its control flow, and any ' +
    'non-obvious behaviour or edge case. Be concise and concrete. Do not ' +
    'restate the code line by line, and do not suggest changes unless the ' +
    'behaviour is genuinely surprising.',

  // The instruction to say "no defects found" is load-bearing. Without it a
  // model asked to find bugs will reliably invent them, and a review tool that
  // cries wolf is one the user stops reading.
  'find-bugs':
    'You are a rigorous code reviewer embedded in an IDE. Report concrete ' +
    'defects in the selected code: incorrect logic, unhandled errors, race ' +
    'conditions, resource leaks, off-by-one errors, and security issues. For ' +
    'each, give the line number, a severity of high, medium or low, and what ' +
    'input or state triggers it. Do not report style preferences. If the code ' +
    'has no defects, reply exactly "No defects found." and nothing else — ' +
    'never invent a problem to seem useful.',

  improve:
    'You are a careful refactoring assistant embedded in an IDE. Rewrite the ' +
    'selected code to be clearer and more correct, preserving its behaviour ' +
    'and its public interface. Reply with the rewritten block in a single ' +
    'fenced code block, followed by a short bulleted rationale listing what ' +
    'you changed and why. Do not include the surrounding code in the block — ' +
    'it replaces the selection exactly.'
}

/** Ceilings per mode. Improve returns code, so it needs the most room. */
const MAX_TOKENS: Readonly<Record<AiMode, number>> = {
  explain: 1500,
  'find-bugs': 2000,
  improve: 4000
}

/**
 * Renders the context into the exact text the model receives.
 *
 * This string is what the "Context sent" panel displays, character for
 * character. Building it once and using it for both is the whole mechanism:
 * a panel that reconstructs its own approximation of the prompt would drift,
 * and the transparency claim would quietly become false.
 */
export function renderContext(context: AiContext): string {
  const parts: string[] = []

  parts.push(`File: ${context.relativePath}`)
  parts.push(`Language: ${context.languageId}`)
  parts.push(
    `Selection: lines ${context.selection.startLine}-${context.selection.endLine}`
  )

  if (context.imports.length > 0) {
    parts.push('', 'Imports in this file:', ...context.imports.map((line) => `  ${line}`))
  }

  if (context.enclosingSymbol !== null) {
    parts.push(
      '',
      `Enclosing ${context.enclosingSymbol.kind}: ${context.enclosingSymbol.name}`,
      '```' + context.languageId,
      context.enclosingSymbol.text,
      '```'
    )
  }

  parts.push('', 'Selected code:', '```' + context.languageId, context.selection.text, '```')

  return parts.join('\n')
}

export function buildPrompt(mode: AiMode, context: AiContext): { system: string; user: string } {
  return { system: SYSTEM_PROMPTS[mode], user: renderContext(context) }
}

/**
 * Identifies a request without storing it.
 *
 * The provenance journal records what was asked without embedding the user's
 * source in a file that outlives the edit — the hash is enough to prove two log
 * entries came from the same prompt, which is what an audit needs.
 */
export function hashPrompt(system: string, user: string): string {
  return createHash('sha256').update(system).update('\u0000').update(user).digest('hex').slice(0, 16)
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Maps SDK failures onto sentences a user can act on.
 *
 * Exported and tested by status code rather than by class, because what the
 * user needs to know is "your key is wrong" or "you are rate limited", and the
 * class name never says that.
 */
export function describeAiError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status

  if (status === 401) {
    return 'Anthropic rejected the API key (401). Check it in Settings.'
  }
  if (status === 403) {
    return 'That key is not permitted to use this model (403).'
  }
  if (status === 429) {
    return 'Rate limited by Anthropic (429). Wait a moment and try again.'
  }
  if (status !== undefined && status >= 500) {
    return `Anthropic had a server error (${status}). Try again shortly.`
  }

  const name = (error as { name?: string } | null)?.name
  if (name === 'APIConnectionTimeoutError') return 'The request to Anthropic timed out.'
  if (name === 'APIConnectionError') {
    return 'Could not reach Anthropic. Check your network connection.'
  }

  if (error instanceof Error && error.message !== '') return error.message
  return 'The request to Anthropic failed.'
}

/* ------------------------------------------------------------------ *
 * The Anthropic provider
 * ------------------------------------------------------------------ */

const anthropicProvider: AiProvider = {
  id: 'anthropic',
  async stream(request: ProviderRequest): Promise<ProviderResult> {
    const apiKey = await readSecret('anthropic')
    if (apiKey === null || apiKey === '') {
      throw new BetterCallCompilerServiceError('NO_API_KEY', 'no Anthropic API key is configured')
    }

    const client = new Anthropic({ apiKey })

    const stream = client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }]
    })

    // The caller owns cancellation; the SDK exposes `abort()` on the stream.
    const onAbort = (): void => stream.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })

    stream.on('text', (delta) => request.onText(delta))

    try {
      const message = await stream.finalMessage()
      return { stopReason: message.stop_reason ?? null }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

let provider: AiProvider = anthropicProvider

/** Swaps the backend. The seam a local model drops into, and a test hook. */
export function setAiProvider(next: AiProvider): void {
  provider = next
}

export function activeProviderId(): string {
  return provider.id
}

/* ------------------------------------------------------------------ *
 * Streams
 * ------------------------------------------------------------------ */

interface ActiveStream {
  readonly streamId: string
  readonly controller: AbortController
  cancelled: boolean
  finished: boolean
}

const active = new Map<string, ActiveStream>()
let sequence = 0

let emitDelta: ((payload: AiStreamDelta) => void) | null = null
let emitDone: ((payload: AiDone) => void) | null = null

export function setAiEmitters(
  onDelta: (payload: AiStreamDelta) => void,
  onDone: (payload: AiDone) => void
): void {
  emitDelta = onDelta
  emitDone = onDone
}

function finish(stream: ActiveStream, done: Omit<AiDone, 'streamId'>): void {
  if (stream.finished) return
  stream.finished = true
  active.delete(stream.streamId)
  emitDone?.({ streamId: stream.streamId, ...done })
}

/**
 * Starts a stream and returns immediately with what was sent.
 *
 * The response carries the rendered context and the prompt hash so the panel
 * can show "Context sent" *before* the first token arrives — transparency that
 * only appears after the answer is transparency the user has already stopped
 * looking for.
 */
export async function startAiStream(mode: AiMode, context: AiContext): Promise<AiStarted> {
  const { system, user } = buildPrompt(mode, context)
  return startPromptStream(mode, system, user, MAX_TOKENS[mode])
}

/**
 * Streams an arbitrary prompt through the same provider, transport and event
 * channels as the three built-in modes.
 *
 * Extracted from `startAiStream` unchanged so the Explain artifact can have its
 * own prompt shape — which asks for headings and citations, and would be wrong
 * for the inline panel — without a second copy of the abort handling, the
 * cancellation bookkeeping and the delta plumbing. Those are the parts where a
 * divergent copy goes wrong quietly.
 *
 * `mode` is still one of the three: it labels the stream for the log and the
 * panel, and an artifact request is an `explain` by any reading.
 */
export async function startPromptStream(
  mode: AiMode,
  system: string,
  user: string,
  maxTokens: number
): Promise<AiStarted> {
  const settings = await loadSettings()
  const promptHash = hashPrompt(system, user)

  const streamId = `ai-${++sequence}`
  const controller = new AbortController()
  const record: ActiveStream = { streamId, controller, cancelled: false, finished: false }
  active.set(streamId, record)

  const started: AiStarted = {
    streamId,
    mode,
    model: settings.aiModel,
    provider: provider.id,
    promptHash,
    systemPrompt: system,
    contextSent: user
  }

  void (async () => {
    try {
      const result = await provider.stream({
        model: settings.aiModel,
        system,
        user,
        maxTokens,
        signal: controller.signal,
        onText: (delta) => {
          if (record.finished) return
          emitDelta?.({ streamId, text: delta })
        }
      })
      finish(record, { stopReason: result.stopReason, error: null, cancelled: record.cancelled })
    } catch (error) {
      if (record.cancelled) {
        finish(record, { stopReason: null, error: null, cancelled: true })
        return
      }
      finish(record, { stopReason: null, error: describeAiError(error), cancelled: false })
    }
  })()

  return started
}

export function cancelAiStream(streamId: string): boolean {
  const stream = active.get(streamId)
  if (stream === undefined) return false
  stream.cancelled = true
  stream.controller.abort()
  return true
}

/** Every stream must die with the window. */
export function cancelAllAiStreams(): void {
  for (const streamId of [...active.keys()]) cancelAiStream(streamId)
}

/* ------------------------------------------------------------------ *
 * Improve: extracting the rewritten block
 * ------------------------------------------------------------------ */

/**
 * Pulls the rewritten code out of an `improve` answer.
 *
 * The model is told to reply with one fenced block followed by a rationale, but
 * a prompt is a request, not a guarantee. This takes the *first* fenced block
 * and ignores the rest, and returns null when there is none — in which case the
 * UI must not offer to apply anything, rather than writing prose into a source
 * file.
 */
export function extractCodeBlock(answer: string): string | null {
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(answer)
  const body = fence?.[1]
  if (body === undefined) return null

  // Keep interior blank lines; drop only the trailing newline the fence adds.
  const trimmed = body.replace(/\n$/, '')
  return trimmed.trim() === '' ? null : trimmed
}
