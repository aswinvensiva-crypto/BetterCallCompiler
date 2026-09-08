import type * as monacoNs from 'monaco-editor'

/**
 * Ghost text — Cursor/Copilot-style inline suggestions.
 *
 * Registered once for every language via `pattern: '**'`, the same way
 * Monaco's own providers are language-agnostic when the thing they answer is.
 * The debounce lives here, not in main: Monaco calls
 * `provideInlineCompletions` on essentially every relevant editor event, and
 * without a deliberate wait a suggestion request would fire per keystroke.
 *
 * Cancellation is two-layered. Monaco's own `CancellationToken` fires the
 * moment a newer request supersedes this one — that is what makes the
 * debounce abortable rather than merely delayed — and `ai-service.ts` on the
 * main side aborts the network call underneath a request that a still-newer
 * one has already superseded, so a stale suggestion never has a chance to
 * outrace a fresh keystroke back into the editor.
 */

const DEBOUNCE_MS = 200
const MAX_CONTEXT_CHARS = 4000

/** Resolves `true` after the debounce, or `false` if the token cancels first. */
function debounce(ms: number, token: monacoNs.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      subscription.dispose()
      resolve(true)
    }, ms)
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** Registers the provider for every language. Returns the disposable to tear it down. */
export function registerGhostTextProvider(monaco: typeof monacoNs): monacoNs.IDisposable {
  return monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      async provideInlineCompletions(model, position, _context, token) {
        const proceed = await debounce(DEBOUNCE_MS, token)
        if (!proceed || token.isCancellationRequested) return { items: [] }

        const offset = model.getOffsetAt(position)
        const full = model.getValue()
        const prefix = full.slice(Math.max(0, offset - MAX_CONTEXT_CHARS), offset)
        const suffix = full.slice(offset, offset + MAX_CONTEXT_CHARS)

        const result = await window.betterCallCompiler.ai.ghostCompletion({
          languageId: model.getLanguageId(),
          prefix,
          suffix
        })
        if (token.isCancellationRequested) return { items: [] }
        if (!result.ok || result.value.text === null) return { items: [] }

        const insertPosition = position
        return {
          items: [
            {
              insertText: result.value.text,
              range: monaco.Range.fromPositions(insertPosition, insertPosition)
            }
          ]
        }
      },
      // Nothing owned per-completion is held past the call — no cache to release.
      disposeInlineCompletions() {}
    }
  )
}
