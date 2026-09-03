import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDocument,
  compilerStatus,
  definitionAt,
  dependentsOf,
  referencesAt,
  diagnosticsFor,
  notifyWatchEvent,
  openDocument,
  resetCompilerForTests,
  setCompilerEmitters,
  setWorkerFactory,
  startCompiler,
  stopCompiler,
  type WorkerHandle
} from '../../src/main/compiler-service'
import type { WorkerMessage, WorkerRequest } from '../../src/shared/compiler-protocol'
import type { DiagnosticsBatch, FileDiagnostics, FsWatchEvent } from '../../src/shared/types'

/**
 * A worker that never runs. Every test drives it explicitly, so the supervisor's
 * behaviour — heartbeats, restarts, batching — is deterministic rather than
 * dependent on a real thread's timing.
 */
class FakeWorker implements WorkerHandle {
  readonly sent: WorkerRequest[] = []
  terminated = false
  /** Set false to model a wedged worker that never answers a ping. */
  answersPings = true
  /** Reported on each pong; non-null models a long synchronous check. */
  busySince: number | null = null

  private readonly listeners = new Map<string, ((value: never) => void)[]>()

  postMessage(message: WorkerRequest): void {
    this.sent.push(message)
    if (message.type === 'ping' && this.answersPings) {
      this.emit({
        type: 'pong',
        nonce: message.nonce,
        heapUsedMb: 42,
        busySince: this.busySince
      })
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

  /** Pushes a message from worker to supervisor. */
  emit(message: WorkerMessage): void {
    for (const listener of this.listeners.get('message') ?? []) {
      ;(listener as (value: unknown) => void)(message)
    }
  }

  crash(reason = 'boom'): void {
    for (const listener of this.listeners.get('error') ?? []) {
      ;(listener as (value: Error) => void)(new Error(reason))
    }
  }

  exit(code = 1): void {
    for (const listener of this.listeners.get('exit') ?? []) {
      ;(listener as (value: number) => void)(code)
    }
  }
}

let workers: FakeWorker[] = []
let batches: DiagnosticsBatch[] = []

function newestWorker(): FakeWorker {
  const last = workers[workers.length - 1]
  if (last === undefined) throw new Error('no worker was created')
  return last
}

function fileDiagnostics(
  relativePath: string,
  version: number,
  count = 1
): FileDiagnostics {
  return {
    relativePath,
    path: `C:/ws/${relativePath}`,
    version,
    diagnostics: Array.from({ length: count }, () => ({
      relativePath,
      path: `C:/ws/${relativePath}`,
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

const watchEvent = (relativePath: string, type: FsWatchEvent['type']): FsWatchEvent => ({
  type,
  path: `C:/ws/${relativePath}`,
  relativePath,
  parentRelativePath: ''
})

beforeEach(() => {
  vi.useFakeTimers()
  workers = []
  batches = []
  resetCompilerForTests()
  setWorkerFactory(() => {
    const created = new FakeWorker()
    workers.push(created)
    return created
  })
  setCompilerEmitters(
    (batch) => batches.push(batch),
    () => undefined
  )
})

afterEach(() => {
  resetCompilerForTests()
  vi.useRealTimers()
})

describe('lifecycle', () => {
  it('stays stopped with no workspace and spawns nothing', () => {
    startCompiler(null)

    expect(compilerStatus().state).toBe('stopped')
    expect(workers).toHaveLength(0)
  })

  it('spawns and boots when given a workspace', () => {
    startCompiler('C:/ws')

    expect(workers).toHaveLength(1)
    expect(newestWorker().sent[0]).toEqual({ type: 'boot', workspaceRoot: 'C:/ws' })
  })

  it('adopts the state the worker reports', () => {
    startCompiler('C:/ws')
    newestWorker().emit({
      type: 'state',
      state: 'idle',
      graph: {
        fileCount: 12,
        edgeCount: 20,
        cycles: [],
        truncated: false,
        lastBuildMs: 5,
        tsconfigRelativePath: 'tsconfig.json'
      },
      checkedFileCount: 12
    })

    const status = compilerStatus()
    expect(status.state).toBe('idle')
    expect(status.graph.fileCount).toBe(12)
    expect(status.graph.tsconfigRelativePath).toBe('tsconfig.json')
  })

  it('terminates the worker and clears state on stop', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()
    worker.emit({ type: 'diagnostics', files: [fileDiagnostics('a.ts', 1)], settled: true })

    stopCompiler()

    expect(worker.terminated).toBe(true)
    expect(compilerStatus().state).toBe('stopped')
    expect(diagnosticsFor(null)).toEqual([])
  })
})

describe('diagnostics batching', () => {
  it('coalesces a burst into a single emit', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()

    for (let i = 0; i < 40; i++) {
      worker.emit({ type: 'diagnostics', files: [fileDiagnostics(`f${i}.ts`, 1)], settled: false })
    }
    expect(batches).toHaveLength(0) // nothing emitted yet — still inside the window

    vi.advanceTimersByTime(50)

    expect(batches).toHaveLength(1)
    expect(batches[0]?.files).toHaveLength(40)
  })

  it('keeps only the newest entry per file within a batch', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()

    worker.emit({ type: 'diagnostics', files: [fileDiagnostics('a.ts', 1, 3)], settled: false })
    worker.emit({ type: 'diagnostics', files: [fileDiagnostics('a.ts', 2, 1)], settled: false })
    vi.advanceTimersByTime(50)

    expect(batches[0]?.files).toHaveLength(1)
    expect(batches[0]?.files[0]?.version).toBe(2)
    expect(batches[0]?.files[0]?.diagnostics).toHaveLength(1)
  })

  /**
   * The map is authoritative and updated immediately, even though the emit is
   * debounced — a Problems panel mounting between batches must not see stale
   * or missing data.
   */
  it('answers a pull immediately, before the batch is emitted', () => {
    startCompiler('C:/ws')
    newestWorker().emit({
      type: 'diagnostics',
      files: [fileDiagnostics('a.ts', 1)],
      settled: false
    })

    expect(batches).toHaveLength(0)
    expect(diagnosticsFor('a.ts')).toHaveLength(1)
    expect(diagnosticsFor(null)).toHaveLength(1)
  })

  it('reports an empty diagnostics set as clean rather than dropping it', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()

    worker.emit({ type: 'diagnostics', files: [fileDiagnostics('a.ts', 1)], settled: false })
    vi.advanceTimersByTime(50)
    worker.emit({ type: 'diagnostics', files: [fileDiagnostics('a.ts', 2, 0)], settled: true })
    vi.advanceTimersByTime(50)

    // Without this, a fixed error keeps its squiggle forever.
    expect(batches[1]?.files[0]?.diagnostics).toEqual([])
    expect(compilerStatus().errorCount).toBe(0)
  })

  it('counts errors and warnings across files', () => {
    startCompiler('C:/ws')
    newestWorker().emit({
      type: 'diagnostics',
      files: [fileDiagnostics('a.ts', 1, 2), fileDiagnostics('b.ts', 1, 3)],
      settled: true
    })

    expect(compilerStatus().errorCount).toBe(5)
  })
})

describe('watch coalescing', () => {
  it('collapses many file events into one worker message', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()
    worker.sent.length = 0

    for (let i = 0; i < 40; i++) notifyWatchEvent(watchEvent(`f${i}.ts`, 'change'))
    expect(worker.sent).toHaveLength(0)

    vi.advanceTimersByTime(50)

    const changes = worker.sent.filter((m) => m.type === 'filesChanged')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ type: 'filesChanged' })
  })

  it('separates removals from changes', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()
    worker.sent.length = 0

    notifyWatchEvent(watchEvent('gone.ts', 'unlink'))
    notifyWatchEvent(watchEvent('kept.ts', 'change'))
    vi.advanceTimersByTime(50)

    const message = worker.sent.find((m) => m.type === 'filesChanged')
    expect(message).toMatchObject({ changed: ['kept.ts'], removed: ['gone.ts'] })
  })

  it('lets a later delete win over an earlier change to the same file', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()
    worker.sent.length = 0

    notifyWatchEvent(watchEvent('a.ts', 'change'))
    notifyWatchEvent(watchEvent('a.ts', 'unlink'))
    vi.advanceTimersByTime(50)

    const message = worker.sent.find((m) => m.type === 'filesChanged')
    expect(message).toMatchObject({ changed: [], removed: ['a.ts'] })
  })

  it('ignores directory events', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()
    worker.sent.length = 0

    notifyWatchEvent(watchEvent('src', 'addDir'))
    notifyWatchEvent(watchEvent('src', 'unlinkDir'))
    vi.advanceTimersByTime(50)

    expect(worker.sent.filter((m) => m.type === 'filesChanged')).toHaveLength(0)
  })
})

describe('heartbeat and restart', () => {
  it('pings on the interval and clears the miss count on a pong', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()

    vi.advanceTimersByTime(5_000)
    expect(worker.sent.some((m) => m.type === 'ping')).toBe(true)

    // Answered, so many more intervals must not kill it.
    vi.advanceTimersByTime(5_000 * 10)
    expect(worker.terminated).toBe(false)
    expect(workers).toHaveLength(1)
  })

  it('terminates and restarts a worker that stops answering', () => {
    startCompiler('C:/ws')
    const first = newestWorker()
    first.answersPings = false

    vi.advanceTimersByTime(5_000 * 5)
    expect(first.terminated).toBe(true)

    vi.advanceTimersByTime(1_000)
    expect(workers.length).toBeGreaterThan(1)
    expect(compilerStatus().restarts).toBeGreaterThan(0)
  })

  /**
   * getSemanticDiagnostics is synchronous and uninterruptible, so a busy worker
   * legitimately misses pings. Killing it would be the supervisor destroying
   * healthy work.
   */
  it('does not kill a worker that is busy rather than wedged', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()
    worker.answersPings = false
    worker.busySince = Date.now()

    // Report busy once so the supervisor knows.
    worker.emit({ type: 'pong', nonce: 1, heapUsedMb: 10, busySince: Date.now() })

    vi.advanceTimersByTime(5_000 * 5)

    expect(worker.terminated).toBe(false)
  })

  it('restarts on a crash and replays open documents', () => {
    startCompiler('C:/ws')
    openDocument('a.ts', 'const a = 1', 1)

    newestWorker().crash('worker died')
    vi.advanceTimersByTime(1_000)

    expect(workers).toHaveLength(2)
    const replacement = newestWorker()
    expect(replacement.sent.some((m) => m.type === 'boot')).toBe(true)
    // Otherwise the restarted daemon checks stale disk contents while the user
    // is looking at an edited buffer.
    expect(
      replacement.sent.some((m) => m.type === 'openDocument' && m.relativePath === 'a.ts')
    ).toBe(true)
  })

  it('clears diagnostics on a crash so no stale markers survive', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()
    worker.emit({ type: 'diagnostics', files: [fileDiagnostics('a.ts', 1)], settled: true })
    vi.advanceTimersByTime(50)
    expect(diagnosticsFor(null)).toHaveLength(1)

    worker.crash()

    expect(diagnosticsFor(null)).toEqual([])
  })

  it('gives up after exhausting the restart budget rather than looping forever', () => {
    startCompiler('C:/ws')

    for (let i = 0; i < 5; i++) {
      newestWorker().crash(`crash ${i}`)
      vi.advanceTimersByTime(10_000)
    }

    const status = compilerStatus()
    expect(status.state).toBe('failed')
    expect(status.detail).toMatch(/gave up/i)
  })

  it('reports a worker failure message as failed with its detail verbatim', () => {
    startCompiler('C:/ws')
    newestWorker().emit({ type: 'failure', detail: 'tsconfig is unreadable' })

    expect(compilerStatus().state).toBe('failed')
    expect(compilerStatus().detail).toBe('tsconfig is unreadable')
  })

  it('fails visibly when the worker cannot be created at all', () => {
    setWorkerFactory(() => {
      throw new Error('compiler-worker.js missing from the build')
    })
    startCompiler('C:/ws')

    expect(compilerStatus().state).toBe('failed')
    expect(compilerStatus().detail).toMatch(/missing from the build/)
  })
})

describe('documents and queries', () => {
  it('forwards an open document and forgets it on close', () => {
    startCompiler('C:/ws')
    const worker = newestWorker()

    openDocument('a.ts', 'x', 1)
    expect(worker.sent.some((m) => m.type === 'openDocument')).toBe(true)

    closeDocument('a.ts')
    expect(worker.sent.some((m) => m.type === 'closeDocument')).toBe(true)

    // A closed document must not be replayed into a restarted worker.
    worker.crash()
    vi.advanceTimersByTime(1_000)
    expect(newestWorker().sent.some((m) => m.type === 'openDocument')).toBe(false)
  })

  it('resolves a dependents query from the worker', async () => {
    startCompiler('C:/ws')
    const worker = newestWorker()

    const pending = dependentsOf('a.ts')
    const request = worker.sent.find((m) => m.type === 'dependents')
    expect(request).toBeDefined()

    worker.emit({
      type: 'dependentsResult',
      requestId: (request as { requestId: number }).requestId,
      query: { node: null, dependents: ['b.ts'], chain: [], cycle: null }
    })

    await expect(pending).resolves.toMatchObject({ dependents: ['b.ts'] })
  })

  it('resolves empty rather than hanging when the daemon never answers', async () => {
    startCompiler('C:/ws')

    const pending = dependentsOf('a.ts', [], 1_000)
    vi.advanceTimersByTime(1_000)

    await expect(pending).resolves.toEqual({
      node: null,
      dependents: [],
      chain: [],
      cycle: null
    })
  })

  it('resolves empty when there is no worker at all', async () => {
    await expect(dependentsOf('a.ts')).resolves.toEqual({
      node: null,
      dependents: [],
      chain: [],
      cycle: null
    })
  })
})

/* -------------------------------------------------------------------------- */
/*  Navigation                                                                 */
/* -------------------------------------------------------------------------- */

function languageQueriesSent() {
  return newestWorker().sent.filter((message) => message.type === 'languageQuery')
}

describe('navigation queries', () => {
  it('carries the buffer, so an answer describes what the user can see', async () => {
    // `pushOverlay` debounces 300ms, so without this the daemon answers against
    // text the user edited a third of a second ago and the definition points at
    // the wrong token.
    startCompiler('C:/ws')
    const pending = definitionAt('a.ts', 42, { content: 'export const x = 1', version: 7 })

    const [sent] = languageQueriesSent()
    expect(sent).toMatchObject({
      kind: 'definition',
      relativePath: 'a.ts',
      offset: 42,
      overlay: { content: 'export const x = 1', version: 7 }
    })

    newestWorker().emit({
      type: 'languageQueryResult',
      requestId: (sent as { requestId: number }).requestId,
      result: {
        kind: 'definition',
        locations: [
          {
            relativePath: 'lib.ts',
            path: 'C:/ws/lib.ts',
            range: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 20 }
          }
        ]
      }
    })

    // The wire discriminant is stripped: every response schema is a
    // strictObject, so a stray `kind` would come back as BAD_RESPONSE.
    await expect(pending).resolves.toEqual({
      locations: [
        {
          relativePath: 'lib.ts',
          path: 'C:/ws/lib.ts',
          range: { startLine: 3, startColumn: 14, endLine: 3, endColumn: 20 }
        }
      ]
    })
  })

  it('correlates answers that come back out of order', async () => {
    startCompiler('C:/ws')
    const first = referencesAt('a.ts', 1, null)
    const second = definitionAt('b.ts', 2, null)

    const sent = languageQueriesSent()
    expect(sent).toHaveLength(2)

    newestWorker().emit({
      type: 'languageQueryResult',
      requestId: (sent[1] as { requestId: number }).requestId,
      result: { kind: 'definition', locations: [] }
    })
    newestWorker().emit({
      type: 'languageQueryResult',
      requestId: (sent[0] as { requestId: number }).requestId,
      result: { kind: 'references', locations: [], truncated: true }
    })

    await expect(second).resolves.toEqual({ locations: [] })
    await expect(first).resolves.toEqual({ locations: [], truncated: true })
  })

  it('shares one id space with the dependents query', async () => {
    // Two counters could collide, and an answer would then settle the wrong
    // caller's promise from the wrong map.
    startCompiler('C:/ws')
    void dependentsOf('a.ts')
    void definitionAt('a.ts', 0, null)

    const worker = newestWorker()
    const ids = worker.sent
      .filter((m) => m.type === 'dependents' || m.type === 'languageQuery')
      .map((m) => (m as { requestId: number }).requestId)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('discards an answer of the wrong kind rather than handing it over', async () => {
    startCompiler('C:/ws')
    const pending = referencesAt('a.ts', 0, null)
    newestWorker().emit({
      type: 'languageQueryResult',
      requestId: (languageQueriesSent()[0] as { requestId: number }).requestId,
      result: { kind: 'definition', locations: [] }
    })
    await expect(pending).resolves.toEqual({ locations: [], truncated: false })
  })

  it('resolves empty on timeout instead of rejecting', async () => {
    startCompiler('C:/ws')
    const pending = definitionAt('a.ts', 0, null)
    vi.advanceTimersByTime(6_000)
    await expect(pending).resolves.toEqual({ locations: [] })
  })

  it('resolves empty when there is no daemon at all', async () => {
    await expect(referencesAt('a.ts', 0, null)).resolves.toEqual({
      locations: [],
      truncated: false
    })
  })

  /**
   * The leak the plan names by hand: `pendingLanguageQueries` must be cleared
   * beside `pendingDependents.clear()`, or a crash during a Find All References
   * hangs the invoke until its timeout and leaks the resolver until exit.
   */
  it('settles every in-flight query when the worker crashes', async () => {
    startCompiler('C:/ws')
    const pending = referencesAt('a.ts', 0, null)
    newestWorker().crash()
    await expect(pending).resolves.toEqual({ locations: [], truncated: false })
  })

  /**
   * The same hole, and it was already open before any of this.
   *
   * `scheduleRestart` cleared the diagnostics but not the resolver maps, so a
   * crash left every in-flight `dependentsOf` to resolve five seconds later on
   * its own timeout — the Why button opening blank after a daemon crash, with
   * nothing saying why.
   */
  it('settles an in-flight dependents query when the worker crashes', async () => {
    startCompiler('C:/ws')
    const pending = dependentsOf('a.ts')
    newestWorker().crash()
    await expect(pending).resolves.toEqual({
      node: null,
      dependents: [],
      chain: [],
      cycle: null
    })
  })
})
