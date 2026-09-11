import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeLangDocument,
  langDefinition,
  langDocumentSymbols,
  langHover,
  langReferences,
  langRename,
  langStatus,
  notifyLangWatchEvent,
  openLangDocument,
  resetLangForTests,
  setLangEmitters,
  setLangWorkerFactory,
  startLang,
  stopLang,
  type LangWorkerHandle
} from '../../src/main/lang-service'
import {
  allDiagnostics,
  clearOwner,
  diagnosticCounts,
  diagnosticsForPath,
  publishDiagnostics,
  resetDiagnosticStore
} from '../../src/main/diagnostic-store'
import {
  emptyLangQueryResult,
  isLangMessage,
  isLangRequest,
  type LangMessage,
  type LangQueryRequest,
  type LangRequest
} from '../../src/shared/lang-protocol'
import {
  unsupportedObservatorySnapshot,
  type CompilerPass,
  type DiagnosticsBatch,
  type FileDiagnostics,
  type FsWatchEvent
} from '../../src/shared/types'

/**
 * The BCC supervisor and the store both compilers publish into.
 *
 * Driven through an injected fake worker, so restarts, heartbeats and batching
 * are deterministic rather than dependent on a real thread's timing — the same
 * approach `compiler-service.test.ts` takes, and for the same reason.
 */

class FakeWorker implements LangWorkerHandle {
  readonly sent: LangRequest[] = []
  terminated = false
  answersPings = true

  private readonly listeners = new Map<string, ((value: never) => void)[]>()

  postMessage(message: LangRequest): void {
    this.sent.push(message)
    if (message.type === 'ping' && this.answersPings) {
      this.emit({ type: 'pong', nonce: message.nonce, heapUsedMb: 3 })
    }
  }

  terminate(): void {
    this.terminated = true
  }

  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): void {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
  }

  emit(message: LangMessage): void {
    for (const listener of this.listeners.get('message') ?? []) {
      ;(listener as (value: unknown) => void)(message)
    }
  }

  crash(reason = 'boom'): void {
    for (const listener of this.listeners.get('error') ?? []) {
      ;(listener as (value: Error) => void)(new Error(reason))
    }
  }
}

let workers: FakeWorker[] = []
let batches: DiagnosticsBatch[] = []
let changedCount = 0

function newestWorker(): FakeWorker {
  const last = workers[workers.length - 1]
  if (last === undefined) throw new Error('no worker was spawned')
  return last
}

function bccFile(relativePath: string, count: number, version = 1): FileDiagnostics {
  return {
    relativePath,
    path: `/w/${relativePath}`,
    version,
    diagnostics: Array.from({ length: count }, (_, index) => ({
      relativePath,
      path: `/w/${relativePath}`,
      severity: 'error' as const,
      code: 'BCC0003',
      message: `problem ${index}`,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
      source: 'bcc' as const
    }))
  }
}

function tsFile(relativePath: string, count: number): FileDiagnostics {
  return {
    relativePath,
    path: `/w/${relativePath}`,
    version: 1,
    diagnostics: Array.from({ length: count }, () => ({
      relativePath,
      path: `/w/${relativePath}`,
      severity: 'error' as const,
      code: 'TS2345',
      message: 'nope',
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
      source: 'typescript' as const
    }))
  }
}

const watch = (type: FsWatchEvent['type'], relativePath: string): FsWatchEvent => ({
  type,
  relativePath,
  path: `/w/${relativePath}`,
  parentRelativePath: relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
    : ''
})

beforeEach(() => {
  vi.useFakeTimers()
  workers = []
  batches = []
  changedCount = 0
  resetLangForTests()
  resetDiagnosticStore()
  setLangWorkerFactory(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  })
  setLangEmitters(
    (batch) => batches.push(batch),
    () => {
      changedCount++
    }
  )
})

afterEach(() => {
  stopLang()
  resetLangForTests()
  resetDiagnosticStore()
  vi.useRealTimers()
})

/* -------------------------------------------------------------------------- */
/*  The store                                                                  */
/* -------------------------------------------------------------------------- */

describe('diagnostic store', () => {
  it('keeps both owners in one map', () => {
    publishDiagnostics('typescript', [tsFile('src/app.ts', 2)])
    publishDiagnostics('bcc', [bccFile('examples/fib.bcc', 3)])

    expect(allDiagnostics()).toHaveLength(2)
    expect(diagnosticCounts().errorCount).toBe(5)
  })

  /**
   * The claim the two-worker design exists to make, tested rather than
   * asserted in a comment.
   *
   * A crashing daemon's diagnostics must be dropped — they describe state
   * nobody is maintaining any more. If the store had no notion of ownership,
   * dropping them would mean clearing everything, and a TypeScript crash would
   * silently erase every BCC squiggle in the project. The two compilers would
   * then share a failure domain through the data structure even though they
   * run in separate threads.
   */
  it('lets one owner be cleared without touching the other', () => {
    publishDiagnostics('typescript', [tsFile('src/app.ts', 2)])
    publishDiagnostics('bcc', [bccFile('examples/fib.bcc', 3)])

    clearOwner('typescript')

    expect(allDiagnostics().map((file) => file.relativePath)).toEqual(['examples/fib.bcc'])
    expect(diagnosticCounts().errorCount).toBe(3)

    clearOwner('bcc')
    expect(allDiagnostics()).toEqual([])
  })

  it('keeps an empty set, because empty means clean', () => {
    // Deleting the row instead would leave the store disagreeing with what was
    // emitted — the renderer was told "clean", the store says "unknown".
    publishDiagnostics('bcc', [bccFile('a.bcc', 2)])
    publishDiagnostics('bcc', [bccFile('a.bcc', 0, 2)])

    expect(diagnosticsForPath('a.bcc')).toHaveLength(1)
    expect(diagnosticsForPath('a.bcc')[0]?.diagnostics).toEqual([])
    expect(diagnosticCounts().errorCount).toBe(0)
  })

  it('answers a pull for one path, and for all of them', () => {
    publishDiagnostics('bcc', [bccFile('a.bcc', 1)])
    publishDiagnostics('typescript', [tsFile('b.ts', 1)])

    expect(diagnosticsForPath('a.bcc')).toHaveLength(1)
    expect(diagnosticsForPath('missing.bcc')).toEqual([])
    expect(diagnosticsForPath(null)).toHaveLength(2)
  })
})

/* -------------------------------------------------------------------------- */
/*  The supervisor                                                             */
/* -------------------------------------------------------------------------- */

describe('lang service', () => {
  it('boots the worker with the workspace root', () => {
    startLang('/w')
    expect(newestWorker().sent[0]).toEqual({ type: 'boot', workspaceRoot: '/w' })
  })

  it('does not spawn anything without a workspace', () => {
    startLang(null)
    expect(workers).toHaveLength(0)
    expect(langStatus().running).toBe(false)
  })

  it('reports running once the worker says it is ready', () => {
    startLang('/w')
    expect(langStatus().running).toBe(false)
    newestWorker().emit({ type: 'ready' })
    expect(langStatus().running).toBe(true)
  })

  it('records how many files were indexed', () => {
    startLang('/w')
    newestWorker().emit({ type: 'indexed', fileCount: 4 })
    // A count distinguishes "no .bcc files here" from "has not looked yet",
    // which otherwise look identical from the outside.
    expect(langStatus().fileCount).toBe(4)
  })

  it('publishes diagnostics into the store immediately and emits on a debounce', () => {
    startLang('/w')
    newestWorker().emit({ type: 'diagnostics', files: [bccFile('a.bcc', 1)], settled: true })

    // The store is authoritative, so a pull between batches must be accurate
    // even though the emit is still pending.
    expect(diagnosticsForPath('a.bcc')).toHaveLength(1)
    expect(batches).toHaveLength(0)

    vi.advanceTimersByTime(60)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.files.map((file) => file.relativePath)).toEqual(['a.bcc'])
  })

  it('signals that the status changed, so the counts do not go stale', () => {
    // Without this the Problems panel would show a new BCC error while the
    // status bar kept reporting the old total.
    startLang('/w')
    newestWorker().emit({ type: 'diagnostics', files: [bccFile('a.bcc', 1)], settled: true })
    vi.advanceTimersByTime(60)
    expect(changedCount).toBeGreaterThan(0)
  })

  it('coalesces repeated batches for one file to the newest', () => {
    startLang('/w')
    const worker = newestWorker()
    worker.emit({ type: 'diagnostics', files: [bccFile('a.bcc', 3, 1)], settled: true })
    worker.emit({ type: 'diagnostics', files: [bccFile('a.bcc', 0, 2)], settled: true })

    vi.advanceTimersByTime(60)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.files).toHaveLength(1)
    expect(batches[0]?.files[0]?.diagnostics).toEqual([])
  })

  /* ------------------------------- watching ------------------------------- */

  it('forwards only .bcc watch events', () => {
    startLang('/w')
    const worker = newestWorker()

    notifyLangWatchEvent(watch('change', 'src/app.ts'))
    vi.advanceTimersByTime(60)
    // A TypeScript-only workspace must never wake this thread.
    expect(worker.sent.filter((message) => message.type === 'filesChanged')).toHaveLength(0)

    notifyLangWatchEvent(watch('change', 'examples/fib.bcc'))
    vi.advanceTimersByTime(60)
    expect(worker.sent).toContainEqual({
      type: 'filesChanged',
      changed: ['examples/fib.bcc'],
      removed: []
    })
  })

  it('coalesces a burst of watch events into one message', () => {
    startLang('/w')
    const worker = newestWorker()

    notifyLangWatchEvent(watch('change', 'a.bcc'))
    notifyLangWatchEvent(watch('change', 'b.bcc'))
    notifyLangWatchEvent(watch('unlink', 'c.bcc'))
    vi.advanceTimersByTime(60)

    const messages = worker.sent.filter((message) => message.type === 'filesChanged')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      type: 'filesChanged',
      changed: ['a.bcc', 'b.bcc'],
      removed: ['c.bcc']
    })
  })

  it('lets a delete supersede an earlier change to the same file', () => {
    startLang('/w')
    const worker = newestWorker()

    notifyLangWatchEvent(watch('change', 'a.bcc'))
    notifyLangWatchEvent(watch('unlink', 'a.bcc'))
    vi.advanceTimersByTime(60)

    expect(worker.sent).toContainEqual({ type: 'filesChanged', changed: [], removed: ['a.bcc'] })
  })

  /* ------------------------------ documents ------------------------------- */

  it('forwards open and close buffers', () => {
    startLang('/w')
    openLangDocument('a.bcc', 'let x = 1;', 7)
    closeLangDocument('a.bcc')

    expect(newestWorker().sent).toContainEqual({
      type: 'openDocument',
      relativePath: 'a.bcc',
      content: 'let x = 1;',
      version: 7
    })
    expect(newestWorker().sent).toContainEqual({ type: 'closeDocument', relativePath: 'a.bcc' })
  })

  it('replays open buffers to a restarted worker', () => {
    // A restarted daemon must see what the user is looking at, not the last
    // thing written to disk.
    startLang('/w')
    openLangDocument('a.bcc', 'let x = 1;', 7)

    newestWorker().crash()
    vi.advanceTimersByTime(1_000)

    expect(workers.length).toBeGreaterThan(1)
    expect(newestWorker().sent).toContainEqual({
      type: 'openDocument',
      relativePath: 'a.bcc',
      content: 'let x = 1;',
      version: 7
    })
  })

  /* ------------------------------ restarting ------------------------------ */

  it('drops only its own diagnostics when the worker crashes', () => {
    startLang('/w')
    publishDiagnostics('typescript', [tsFile('src/app.ts', 2)])
    newestWorker().emit({ type: 'diagnostics', files: [bccFile('a.bcc', 1)], settled: true })
    vi.advanceTimersByTime(60)

    newestWorker().crash()

    // TypeScript's survive a BCC crash. This is the same claim as the store
    // test above, made through the real restart path rather than by calling
    // `clearOwner` directly.
    expect(allDiagnostics().map((file) => file.relativePath)).toEqual(['src/app.ts'])
  })

  it('gives up after the restart budget rather than respawning forever', () => {
    startLang('/w')
    for (let attempt = 0; attempt < 5; attempt++) {
      newestWorker().crash()
      vi.advanceTimersByTime(10_000)
    }

    expect(workers.length).toBeLessThanOrEqual(4)
    expect(langStatus().running).toBe(false)
    expect(langStatus().detail).toMatch(/gave up/)
  })

  it('kills a worker that stops answering heartbeats', () => {
    // There is no busy grace here, unlike the TypeScript supervisor: parsing a
    // BCC file is microseconds, so a missed heartbeat is never legitimate work
    // — it is a loop that does not terminate.
    startLang('/w')
    const worker = newestWorker()
    worker.emit({ type: 'ready' })
    worker.answersPings = false

    vi.advanceTimersByTime(5_000 * 5)

    expect(worker.terminated).toBe(true)
    expect(workers.length).toBeGreaterThan(1)
  })

  it('keeps answering heartbeats without restarting a healthy worker', () => {
    startLang('/w')
    const worker = newestWorker()
    worker.emit({ type: 'ready' })

    vi.advanceTimersByTime(5_000 * 10)

    expect(worker.terminated).toBe(false)
    expect(workers).toHaveLength(1)
  })

  it('clears its diagnostics when stopped', () => {
    startLang('/w')
    newestWorker().emit({ type: 'diagnostics', files: [bccFile('a.bcc', 1)], settled: true })
    vi.advanceTimersByTime(60)
    expect(allDiagnostics()).toHaveLength(1)

    stopLang()
    expect(allDiagnostics()).toEqual([])
  })

  it('survives a message it does not recognise', () => {
    // A worker can post anything, including an uncaught rejection's payload.
    startLang('/w')
    const worker = newestWorker()
    expect(() => worker.emit({ type: 'nonsense' } as unknown as LangMessage)).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/*  Navigation queries                                                         */
/* -------------------------------------------------------------------------- */

/** Every `query` the worker was sent, in order. */
function queriesSent(): LangQueryRequest[] {
  return newestWorker().sent.filter(
    (message): message is LangQueryRequest => message.type === 'query'
  )
}

describe('navigation queries', () => {
  it('carries the buffer, so an answer describes what the user can see', async () => {
    // The whole point of the overlay riding on the request. `pushOverlay`
    // debounces 300ms, so without this the daemon answers against text the user
    // edited a third of a second ago — and a RENAME against stale text rewrites
    // the wrong bytes.
    startLang('/w')
    const pending = langDefinition('a.bcc', 7, { content: 'let x = 1;', version: 4 })

    const [sent] = queriesSent()
    expect(sent?.kind).toBe('definition')
    expect(sent?.offset).toBe(7)
    expect(sent?.overlay).toEqual({ content: 'let x = 1;', version: 4 })

    newestWorker().emit({
      type: 'queryResult',
      requestId: sent!.requestId,
      result: { kind: 'definition', locations: [] }
    })
    await expect(pending).resolves.toEqual({ locations: [] })
  })

  it('correlates answers that come back out of order', async () => {
    startLang('/w')
    const first = langReferences('a.bcc', 1, null)
    const second = langHover('b.bcc', 2, null)

    const sent = queriesSent()
    expect(sent).toHaveLength(2)
    expect(sent[0]!.requestId).not.toBe(sent[1]!.requestId)

    // Second answered first, which is exactly what a worker under load does.
    newestWorker().emit({
      type: 'queryResult',
      requestId: sent[1]!.requestId,
      result: { kind: 'hover', contents: 'int', range: null }
    })
    newestWorker().emit({
      type: 'queryResult',
      requestId: sent[0]!.requestId,
      result: {
        kind: 'references',
        locations: [
          { relativePath: 'a.bcc', path: '/w/a.bcc', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }
        ],
        truncated: false
      }
    })

    await expect(second).resolves.toEqual({ contents: 'int', range: null })
    await expect((await first).locations).toHaveLength(1)
  })

  it('discards an answer of the wrong kind rather than handing it over', async () => {
    // A worker whose switch answered the wrong question is a bug in the worker,
    // and the caller must not read fields the shape does not have.
    startLang('/w')
    const pending = langHover('a.bcc', 0, null)
    newestWorker().emit({
      type: 'queryResult',
      requestId: queriesSent()[0]!.requestId,
      result: { kind: 'definition', locations: [] }
    })
    await expect(pending).resolves.toEqual({ contents: null, range: null })
  })

  it('resolves empty on timeout instead of rejecting', async () => {
    // Monaco logs a rejected provider as a console error and shows the user
    // nothing different, so a rejection buys a red line in the log and costs
    // the ability to tell "no answer" from "broken". Same choice dependentsOf
    // already makes.
    startLang('/w')
    const pending = langReferences('a.bcc', 0, null)
    vi.advanceTimersByTime(6_000)
    await expect(pending).resolves.toEqual({ locations: [], truncated: false })
  })

  it('resolves empty when there is no daemon at all', async () => {
    await expect(langDocumentSymbols('a.bcc', null)).resolves.toEqual({ symbols: [] })
  })

  /**
   * The leak the plan names by hand: `pendingQueries` must be cleared beside
   * `clearOwner('bcc')`, or a crash during a Find All References hangs the
   * invoke until its timeout and leaks the resolver until the process exits.
   */
  it('settles every in-flight query when the worker crashes', async () => {
    startLang('/w')
    const pending = langRename('a.bcc', 3, 'renamed', null)
    newestWorker().crash()

    await expect(pending).resolves.toEqual({
      target: null,
      placeholder: null,
      files: [],
      error: null
    })
  })

  it('settles every in-flight query when the daemon is stopped', async () => {
    startLang('/w')
    const pending = langDefinition('a.bcc', 0, null)
    stopLang()
    await expect(pending).resolves.toEqual({ locations: [] })
  })

  it('sends null for newName when asking only where the symbol is', () => {
    startLang('/w')
    void langRename('a.bcc', 3, null, null)
    expect(queriesSent()[0]?.newName).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Protocol guards                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The one thing TypeScript does not check for us.
 *
 * `isLangMessage` and `isLangRequest` enumerate their type strings by hand, so
 * adding a member to either union compiles cleanly and is then silently dropped
 * on the floor by the guard — a new message that never arrives, with nothing
 * pointing at the cause. The `Record<Union['type'], Union>` below is what closes
 * it: a new member makes this file fail to compile until a sample exists, and
 * the assertion then makes the guard admit it.
 */
describe('protocol guards', () => {
  const requests: Record<LangRequest['type'], LangRequest> = {
    boot: { type: 'boot', workspaceRoot: '/w' },
    filesChanged: { type: 'filesChanged', changed: [], removed: [] },
    openDocument: { type: 'openDocument', relativePath: 'a.bcc', content: '', version: 1 },
    closeDocument: { type: 'closeDocument', relativePath: 'a.bcc' },
    query: {
      type: 'query',
      requestId: 1,
      kind: 'definition',
      relativePath: 'a.bcc',
      offset: 0,
      newName: null,
      overlay: null
    },
    ping: { type: 'ping', nonce: 1 },
    observatory: { type: 'observatory', requestId: 1, relativePath: 'a.bcc', overlay: null }
  }

  const samplePass: CompilerPass = {
    id: 1,
    language: 'bcc',
    at: 0,
    reason: 'watch',
    trigger: [],
    requested: 1,
    recomputed: 1,
    reused: 0,
    totalMs: 1,
    events: [],
    stats: { revision: 1, memoCount: 0, hits: 0, misses: 0, recomputes: 0, cutoffs: 0, durableSkips: 0 }
  }

  const messages: Record<LangMessage['type'], LangMessage> = {
    ready: { type: 'ready' },
    diagnostics: { type: 'diagnostics', files: [], settled: true },
    pong: { type: 'pong', nonce: 1, heapUsedMb: 1 },
    indexed: { type: 'indexed', fileCount: 0 },
    queryResult: {
      type: 'queryResult',
      requestId: 1,
      result: { kind: 'definition', locations: [] }
    },
    observatoryResult: {
      type: 'observatoryResult',
      requestId: 1,
      snapshot: unsupportedObservatorySnapshot('a.bcc', '/w/a.bcc')
    },
    pass: { type: 'pass', pass: samplePass },
    failure: { type: 'failure', detail: 'no' }
  }

  it('accepts every request the union declares', () => {
    for (const [type, request] of Object.entries(requests)) {
      expect(isLangRequest(request), type).toBe(true)
    }
  })

  it('accepts every message the union declares', () => {
    for (const [type, message] of Object.entries(messages)) {
      expect(isLangMessage(message), type).toBe(true)
    }
  })

  it('rejects near-misses', () => {
    for (const value of [
      null,
      undefined,
      'query',
      42,
      {},
      { type: 'Query' },
      { type: 'queryresult' },
      { type: 'queries' },
      { type: '' }
    ]) {
      expect(isLangRequest(value), JSON.stringify(value) ?? 'undefined').toBe(false)
      expect(isLangMessage(value), JSON.stringify(value) ?? 'undefined').toBe(false)
    }
  })

  it('has an empty answer for every query kind', () => {
    // `emptyLangQueryResult` is what every "no answer" path returns — a daemon
    // that is down, a timeout, a file the worker has never heard of. A kind
    // missing from it would be an undefined reaching Monaco.
    for (const kind of ['definition', 'references', 'rename', 'documentSymbols', 'hover'] as const) {
      expect(emptyLangQueryResult(kind).kind).toBe(kind)
    }
  })
})
