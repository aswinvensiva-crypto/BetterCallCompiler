import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import type {
  AgentContext,
  AiContext,
  AiDone,
  AiMode,
  AiStarted,
  AiStreamDelta,
  AiUsage,
  AiUsageTotals
} from '../shared/types'
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
  /** Null for a provider that cannot report usage — a local model, for one. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null
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
    'it replaces the selection exactly.',

  // The `### FILE:` format is parsed by `parseAgentPlan` in shared/agent-plan.ts
  // — changing this shape without changing that parser breaks every plan
  // silently, so the two are meant to be read together.
  agent:
    'You are a multi-file coding agent embedded in an IDE. You are given an ' +
    'instruction and the full contents of one or more files. Propose the ' +
    'edits needed to carry out the instruction across ALL the files it ' +
    'touches, not just the first one. Reply with a short plan summary in ' +
    'prose, then for EVERY file you change, a block in exactly this form:\n\n' +
    '### FILE: <path exactly as given>\n' +
    '```\n' +
    '<the full new contents of that file>\n' +
    '```\n\n' +
    'Repeat the block for each file. Always output the WHOLE file, not a ' +
    'diff or a partial excerpt — an omitted unchanged line is deleted, not ' +
    'preserved. Only include files you are given; never invent a new file ' +
    'path. If a file needs no change, omit its block entirely. Preserve each ' +
    "file's existing style and formatting conventions."
}

/** Ceilings per mode. Agent returns whole files across a batch, so it needs by far the most room. */
const MAX_TOKENS: Readonly<Record<AiMode, number>> = {
  explain: 1500,
  'find-bugs': 2000,
  improve: 4000,
  agent: 8000
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
 * The multi-file equivalent of `renderContext`: the instruction, then every
 * attached file in full, each fenced and labelled with the exact path the
 * model must echo back in its `### FILE:` markers — the same path string in
 * both directions is what lets `parseAgentPlan`'s output map cleanly onto
 * `applyAgentBatch`'s `path` field with no renderer-side guessing.
 */
export function renderAgentContext(context: AgentContext): string {
  const parts: string[] = [`Instruction: ${context.instruction}`, '']

  for (const file of context.files) {
    parts.push(`### FILE: ${file.path}`, '```', file.content, '```', '')
  }

  return parts.join('\n').trimEnd()
}

export function buildAgentPrompt(context: AgentContext): { system: string; user: string } {
  return { system: SYSTEM_PROMPTS.agent, user: renderAgentContext(context) }
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
 * Token & cost accounting
 * ------------------------------------------------------------------ */

/**
 * Dollars per million tokens, input and output. Static rather than fetched:
 * there is no authenticated "what does this cost" endpoint, and a number that
 * is occasionally stale is a better product than a spend counter that goes
 * blank whenever the network does.
 *
 * Keyed by prefix match against the model id (`claude-sonnet-5-...` matches
 * `claude-sonnet-5`) so a dated snapshot id still prices correctly. Falls back
 * to the cheapest known tier for an unrecognised id rather than refusing to
 * estimate at all — an approximate number beats none in a cost counter.
 */
const PRICING_PER_MILLION: ReadonlyArray<{
  readonly prefix: string
  readonly inputUsd: number
  readonly outputUsd: number
}> = [
  { prefix: 'claude-opus', inputUsd: 15, outputUsd: 75 },
  { prefix: 'claude-sonnet', inputUsd: 3, outputUsd: 15 },
  { prefix: 'claude-haiku', inputUsd: 0.8, outputUsd: 4 },
  { prefix: 'claude-fable', inputUsd: 3, outputUsd: 15 }
]
const FALLBACK_PRICING = { inputUsd: 3, outputUsd: 15 }

function pricingFor(model: string): { inputUsd: number; outputUsd: number } {
  const entry = PRICING_PER_MILLION.find((row) => model.startsWith(row.prefix))
  return entry ?? FALLBACK_PRICING
}

/** A local provider (Ollama) is free — no network spend to estimate. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (model.startsWith('ollama:')) return 0
  const rate = pricingFor(model)
  return (inputTokens / 1_000_000) * rate.inputUsd + (outputTokens / 1_000_000) * rate.outputUsd
}

const totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number } = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0
}

function recordUsage(usage: AiUsage): void {
  totals.requests += 1
  totals.inputTokens += usage.inputTokens
  totals.outputTokens += usage.outputTokens
  totals.costUsd += usage.costUsd
}

/** Cumulative spend across every stream this process has run, for the status bar. */
export function getAiUsageTotals(): AiUsageTotals {
  return { ...totals }
}

/** Test hook: totals are session state, same shape as `resetAiLogForTests`. */
export function resetAiUsageForTests(): void {
  totals.requests = 0
  totals.inputTokens = 0
  totals.outputTokens = 0
  totals.costUsd = 0
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
      return {
        stopReason: message.stop_reason ?? null,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens
        }
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

/* ------------------------------------------------------------------ *
 * The Ollama provider — local, private, free
 * ------------------------------------------------------------------ */

/**
 * A local model over Ollama's HTTP API.
 *
 * `request.model` here is the provider-qualified id (`ollama:llama3.1`, see
 * `resolveProviderAndModel`) so the log and the "Context sent" panel can tell
 * a local answer from a cloud one at a glance; the `ollama:` prefix is
 * stripped before it reaches the server.
 *
 * Ollama's `/api/chat` streams newline-delimited JSON objects, not SSE — each
 * line is a complete `JSON.parse`-able chunk, the last one carrying
 * `done: true` and the eval counts this reads as token usage. No API key: a
 * local server has nothing to authenticate.
 */
function ollamaProviderFor(host: string): AiProvider {
  return {
    id: 'ollama',
    async stream(request: ProviderRequest): Promise<ProviderResult> {
      const model = request.model.startsWith('ollama:') ? request.model.slice(7) : request.model

      let response: Response
      try {
        response = await fetch(`${host.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: request.signal,
          body: JSON.stringify({
            model,
            stream: true,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user }
            ]
          })
        })
      } catch (error) {
        if (request.signal.aborted) throw error
        throw new BetterCallCompilerServiceError(
          'HANDLER_FAILED',
          `Could not reach Ollama at ${host}. Is it running (\`ollama serve\`)?`
        )
      }

      if (!response.ok || response.body === null) {
        throw new BetterCallCompilerServiceError(
          'HANDLER_FAILED',
          `Ollama returned ${response.status} for model "${model}". Is it pulled (\`ollama pull ${model}\`)?`
        )
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let promptEvalCount = 0
      let evalCount = 0
      let doneReason: string | null = null

      // Chunks arrive on arbitrary byte boundaries, not line boundaries — the
      // trailing partial line is held back in `buffer` until the next read
      // completes it, the same shape as parsing any line-delimited stream.
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.trim() === '') continue
          const chunk: unknown = JSON.parse(line)
          const message = (chunk as { message?: { content?: string } }).message
          if (typeof message?.content === 'string' && message.content !== '') {
            request.onText(message.content)
          }
          const isDone = (chunk as { done?: boolean }).done
          if (isDone === true) {
            const stats = chunk as { prompt_eval_count?: number; eval_count?: number }
            promptEvalCount = stats.prompt_eval_count ?? 0
            evalCount = stats.eval_count ?? 0
            doneReason = 'end_turn'
          }
        }
      }

      return {
        stopReason: doneReason,
        usage: { inputTokens: promptEvalCount, outputTokens: evalCount }
      }
    }
  }
}

let overrideProvider: AiProvider | null = null

/** Swaps the backend unconditionally. A test hook, and Ollama's escape hatch. */
export function setAiProvider(next: AiProvider | null): void {
  overrideProvider = next
}

/**
 * Picks the provider for one request from settings, unless a test has forced
 * one with `setAiProvider`. Returns the model id to send — for Ollama this is
 * `ollama:<model>` so downstream code (the log, cost estimation, the "Context
 * sent" panel) can see which backend actually answered without a second field
 * threaded through every call site.
 */
function resolveProviderAndModel(settings: {
  aiProvider: 'anthropic' | 'ollama'
  aiModel: string
  ollamaModel: string
  ollamaHost: string
}): { provider: AiProvider; model: string } {
  if (overrideProvider !== null) return { provider: overrideProvider, model: settings.aiModel }
  if (settings.aiProvider === 'ollama') {
    return { provider: ollamaProviderFor(settings.ollamaHost), model: `ollama:${settings.ollamaModel}` }
  }
  return { provider: anthropicProvider, model: settings.aiModel }
}

export function activeProviderId(): string {
  return overrideProvider?.id ?? 'settings-driven'
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

/** The multi-file counterpart: same transport, `buildAgentPrompt` instead of `buildPrompt`. */
export async function startAgentStream(context: AgentContext): Promise<AiStarted> {
  const { system, user } = buildAgentPrompt(context)
  return startPromptStream('agent', system, user, MAX_TOKENS.agent)
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
  const { provider, model } = resolveProviderAndModel(settings)

  const streamId = `ai-${++sequence}`
  const controller = new AbortController()
  const record: ActiveStream = { streamId, controller, cancelled: false, finished: false }
  active.set(streamId, record)

  const started: AiStarted = {
    streamId,
    mode,
    model,
    provider: provider.id,
    promptHash,
    systemPrompt: system,
    contextSent: user
  }

  void (async () => {
    try {
      const result = await provider.stream({
        model,
        system,
        user,
        maxTokens,
        signal: controller.signal,
        onText: (delta) => {
          if (record.finished) return
          emitDelta?.({ streamId, text: delta })
        }
      })
      const usage: AiUsage | null =
        result.usage == null
          ? null
          : {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              costUsd: estimateCostUsd(model, result.usage.inputTokens, result.usage.outputTokens)
            }
      if (usage !== null) recordUsage(usage)
      finish(record, { stopReason: result.stopReason, error: null, cancelled: record.cancelled, usage })
    } catch (error) {
      if (record.cancelled) {
        finish(record, { stopReason: null, error: null, cancelled: true, usage: null })
        return
      }
      finish(record, { stopReason: null, error: describeAiError(error), cancelled: false, usage: null })
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
 * Ghost text — single-suggestion inline completion
 * ------------------------------------------------------------------ */

export interface GhostCompletionRequest {
  readonly languageId: string
  readonly prefix: string
  readonly suffix: string
}

const GHOST_SYSTEM_PROMPT =
  'You are an inline code completion engine embedded in an IDE, in the style ' +
  'of GitHub Copilot. Given the code immediately before and after the cursor, ' +
  'output ONLY the text that should be inserted at the cursor to continue it ' +
  'naturally. Never repeat the prefix. Never use markdown or code fences. ' +
  'Stop after a few lines or one complete statement — a short, confident ' +
  'completion beats a long, likely-wrong one. If nothing sensible continues ' +
  'the code, output nothing at all.'

function buildGhostPrompt(request: GhostCompletionRequest): string {
  return (
    `Language: ${request.languageId}\n\n` +
    `Code before the cursor:\n${request.prefix}\n\n` +
    `Code after the cursor:\n${request.suffix}\n\n` +
    'Completion:'
  )
}

let ghostController: AbortController | null = null

/**
 * One suggestion, not a stream — ghost text needs the whole completion before
 * there is anything useful to paint ahead of the cursor.
 *
 * Only one request is ever in flight. Starting a new one aborts whatever came
 * before it: that is what "cancel immediately on any new keystroke" means at
 * this layer, and it is why the caller never has to track its own token —
 * an in-flight request that loses the race is simply never awaited to
 * completion, its network call torn down rather than left to finish unread.
 *
 * Never throws. No key configured, a rate limit, a downed Ollama — every
 * failure here is "no suggestion right now", not a dialog interrupting typing.
 */
export async function requestGhostCompletion(request: GhostCompletionRequest): Promise<string | null> {
  ghostController?.abort()
  const controller = new AbortController()
  ghostController = controller

  try {
    const settings = await loadSettings()
    // A later request may already have aborted `controller` during the await
    // above — before `provider.stream` gets a chance to attach its own abort
    // listener, which would otherwise never fire for an event that already
    // happened. Bail out here rather than starting a network call for a
    // suggestion nothing will ever read.
    if (controller.signal.aborted) return null
    const { provider, model } = resolveProviderAndModel(settings)

    let text = ''
    await provider.stream({
      model,
      system: GHOST_SYSTEM_PROMPT,
      user: buildGhostPrompt(request),
      maxTokens: 200,
      signal: controller.signal,
      onText: (delta) => {
        text += delta
      }
    })

    if (controller.signal.aborted) return null
    const trimmed = text.trim()
    return trimmed === '' ? null : trimmed
  } catch {
    return null
  } finally {
    if (ghostController === controller) ghostController = null
  }
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
