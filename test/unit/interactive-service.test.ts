import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeInteractiveDocument,
  interactiveCompletionDetail,
  interactiveCompletions,
  interactiveHover,
  interactiveSignatureHelp,
  isInteractiveReady,
  notifyInteractiveWatchEvent,
  openInteractiveDocument,
  resetInteractiveForTests,
  setInteractiveReadyListener,
  setInteractiveWorkerFactory,
  startInteractive,
  stopInteractive,
  type InteractiveWorkerHandle
} from '../../src/main/interactive-service'
import {
  emptyInteractiveAnswer,
  isInteractiveMessage,
  isInteractiveRequest,
  type InteractiveMessage,
  type InteractiveQueryRequest,
  type InteractiveRequest
} from '../../src/shared/interactive-protocol'
import type { FsWatchEvent } from '../../src/shared/types'

/**
 * The interactive supervisor, and the one bit the renderer reads from it.
 *
 * The behaviour worth pinning is the readiness gate. Hover, completions and
 * signature help are answered by Monaco's own worker until this daemon says it
 * is up, and by the daemon afterwards — never both, because two providers
 * answering the same question means Monaco merges the lists and every
 * completion appears twice. So "ready" has to mean INDEXED rather than
 * "spawned", and it has to go false again the moment the worker dies.
 */

class FakeWorker implements InteractiveWorkerHandle {
  readonly sent: InteractiveRequest[] = []
  terminated = false
  answersPings = true

  private readonly listeners = new Map<string, ((value: never) => void)[]>()

  postMessage(message: InteractiveRequest): void {
    this.sent.push(message)
    if (message.type === 'ping' && this.answersPings) {
      this.emit({ type: 'pong', nonce: message.nonce, heapUsedMb: 12 })
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

  emit(message: InteractiveMessage): void {
    for (const listener of this.listeners.get('message') ?? []) {
      ;(listener as (value: unknown) => void)(message)
    }
  }

  crash(): void {
    for (const listener of this.listeners.get('error') ?? []) {
      ;(listener as (value: Error) => void)(new Error('boom'))
    }
  }
}

let workers: FakeWorker[] = []
let readyChanges = 0

function newestWorker(): FakeWorker {
  const last = workers[workers.length - 1]
  if (last === undefined) throw new Error('no worker was spawned')
  return last
}

function queries(): InteractiveQueryRequest[] {
  return newestWorker().sent.filter(
    (message): message is InteractiveQueryRequest => message.type === 'query'
  )
}

/** Spawns, and walks the daemon all the way to usable. */
function bootReady(): FakeWorker {
  startInteractive('C:/ws')
  const worker = newestWorker()
  worker.emit({ type: 'ready' })
  worker.emit({ type: 'indexed', fileCount: 3 })
  return worker
}

const watch = (type: FsWatchEvent['type'], relativePath: string): FsWatchEvent => ({
  type,
  relativePath,
  path: `/w/${relativePath}`,
  parentRelativePath: ''
})

beforeEach(() => {
  vi.useFakeTimers()
  workers = []
  readyChanges = 0
  resetInteractiveForTests()
  setInteractiveWorkerFactory(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  })
  setInteractiveReadyListener(() => {
    readyChanges++
  })
})

afterEach(() => {
  stopInteractive()
  resetInteractiveForTests()
  vi.useRealTimers()
})

describe('readiness', () => {
  it('is not ready before a workspace is opened', () => {
    expect(isInteractiveReady()).toBe(false)
  })

  /**
   * `ready` alone is not enough. The worker posts it before it has walked
   * anything, so handing the providers over then would make the first
   * completion pay for building the whole program — which is exactly the pause
   * the second worker exists to avoid.
   */
  it('needs both ready and indexed', () => {
    startInteractive('C:/ws')
    const worker = newestWorker()

    worker.emit({ type: 'ready' })
    expect(isInteractiveReady()).toBe(false)

    worker.emit({ type: 'indexed', fileCount: 3 })
    expect(isInteractiveReady()).toBe(true)
  })

  it('tells the renderer exactly once per transition', () => {
    bootReady()
    expect(readyChanges).toBe(1)
  })

  it('stops being ready when the worker crashes', () => {
    bootReady()
    newestWorker().crash()
    expect(isInteractiveReady()).toBe(false)
    expect(readyChanges).toBe(2)
  })

  it('stops being ready when the daemon is stopped', () => {
    bootReady()
    stopInteractive()
    expect(isInteractiveReady()).toBe(false)
  })

  /**
   * A factory that throws must degrade rather than propagate: the renderer
   * keeps Monaco's providers, which is exactly what it had before this worker
   * existed.
   */
  it('survives a worker that cannot be spawned', () => {
    setInteractiveWorkerFactory(() => {
      throw new Error('no thread for you')
    })
    expect(() => startInteractive('C:/ws')).not.toThrow()
    expect(isInteractiveReady()).toBe(false)
  })
})

describe('documents and watching', () => {
  it('forwards buffers and forgets them on close', () => {
    bootReady()
    openInteractiveDocument('a.ts', 'x', 1)
    expect(newestWorker().sent.some((m) => m.type === 'openDocument')).toBe(true)

    closeInteractiveDocument('a.ts')
    expect(newestWorker().sent.some((m) => m.type === 'closeDocument')).toBe(true)

    // A closed document must not be replayed into a restarted worker.
    newestWorker().crash()
    vi.advanceTimersByTime(1_000)
    expect(newestWorker().sent.some((m) => m.type === 'openDocument')).toBe(false)
  })

  it('replays open buffers into a restarted worker', () => {
    bootReady()
    openInteractiveDocument('a.ts', 'let x = 1', 4)
    newestWorker().crash()
    vi.advanceTimersByTime(1_000)

    expect(newestWorker().sent).toContainEqual({
      type: 'openDocument',
      relativePath: 'a.ts',
      content: 'let x = 1',
      version: 4
    })
  })

  it('coalesces a burst of watch events into one message', () => {
    bootReady()
    notifyInteractiveWatchEvent(watch('change', 'a.ts'))
    notifyInteractiveWatchEvent(watch('change', 'b.ts'))
    notifyInteractiveWatchEvent(watch('unlink', 'c.ts'))
    vi.advanceTimersByTime(60)

    const changed = newestWorker().sent.filter((m) => m.type === 'filesChanged')
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ changed: ['a.ts', 'b.ts'], removed: ['c.ts'] })
  })
})

describe('queries', () => {
  it('carries the buffer and strips the wire discriminant', async () => {
    bootReady()
    const pending = interactiveHover('a.ts', 12, { content: 'let x = 1', version: 3 })

    const [sent] = queries()
    expect(sent).toMatchObject({
      kind: 'hover',
      offset: 12,
      overlay: { content: 'let x = 1', version: 3 }
    })

    newestWorker().emit({
      type: 'queryResult',
      requestId: sent!.requestId,
      result: { kind: 'hover', contents: 'string', range: null }
    })

    // No `kind`: every response schema is a strictObject, so a stray one comes
    // back as BAD_RESPONSE with nothing on screen and no clue why.
    await expect(pending).resolves.toEqual({ contents: 'string', range: null })
  })

  it('correlates answers that come back out of order', async () => {
    bootReady()
    const first = interactiveCompletions('a.ts', 1, null)
    const second = interactiveSignatureHelp('a.ts', 2, null)
    const sent = queries()

    newestWorker().emit({
      type: 'queryResult',
      requestId: sent[1]!.requestId,
      result: { kind: 'signatureHelp', signatures: [], activeSignature: 0, activeParameter: 2 }
    })
    newestWorker().emit({
      type: 'queryResult',
      requestId: sent[0]!.requestId,
      result: { kind: 'completions', items: [], incomplete: true }
    })

    await expect(second).resolves.toMatchObject({ activeParameter: 2 })
    await expect(first).resolves.toEqual({ items: [], incomplete: true })
  })

  /**
   * Two seconds, not the check daemon's five. A completion the user has already
   * typed past is worse than none — it arrives after the list is gone, and the
   * only thing a long timeout buys is a resolver held open for an answer nobody
   * will see.
   */
  it('gives up after two seconds rather than holding a resolver open', async () => {
    bootReady()
    const pending = interactiveCompletions('a.ts', 0, null)
    vi.advanceTimersByTime(2_500)
    await expect(pending).resolves.toEqual({ items: [], incomplete: false })
  })

  it('settles in-flight queries when the worker crashes', async () => {
    bootReady()
    const pending = interactiveSignatureHelp('a.ts', 0, null)
    newestWorker().crash()
    await expect(pending).resolves.toEqual({
      signatures: [],
      activeSignature: 0,
      activeParameter: 0
    })
  })

  it('resolves empty when there is no daemon at all', async () => {
    await expect(interactiveCompletions('a.ts', 0, null)).resolves.toEqual({
      items: [],
      incomplete: false
    })
  })

  it('carries the entry name and source on a detail request', () => {
    // `source` is the only thing separating two identically named auto-import
    // candidates from different modules.
    bootReady()
    void interactiveCompletionDetail('a.ts', 5, 'readFile', 'node:fs', null)
    expect(queries()[0]).toMatchObject({
      kind: 'completionDetail',
      entryName: 'readFile',
      entrySource: 'node:fs'
    })
  })
})

/**
 * The one thing TypeScript does not check for us: both guards enumerate their
 * type strings by hand, so a new union member compiles cleanly and is then
 * silently dropped on the floor.
 */
describe('protocol guards', () => {
  const requests: Record<InteractiveRequest['type'], InteractiveRequest> = {
    boot: { type: 'boot', workspaceRoot: '/w' },
    filesChanged: { type: 'filesChanged', changed: [], removed: [] },
    openDocument: { type: 'openDocument', relativePath: 'a.ts', content: '', version: 1 },
    closeDocument: { type: 'closeDocument', relativePath: 'a.ts' },
    query: {
      type: 'query',
      requestId: 1,
      kind: 'hover',
      relativePath: 'a.ts',
      offset: 0,
      entryName: null,
      entrySource: null,
      overlay: null
    },
    ping: { type: 'ping', nonce: 1 }
  }

  const messages: Record<InteractiveMessage['type'], InteractiveMessage> = {
    ready: { type: 'ready' },
    indexed: { type: 'indexed', fileCount: 0 },
    pong: { type: 'pong', nonce: 1, heapUsedMb: 1 },
    queryResult: {
      type: 'queryResult',
      requestId: 1,
      result: { kind: 'hover', contents: null, range: null }
    },
    failure: { type: 'failure', detail: 'no' }
  }

  it('accepts every request the union declares', () => {
    for (const [type, request] of Object.entries(requests)) {
      expect(isInteractiveRequest(request), type).toBe(true)
    }
  })

  it('accepts every message the union declares', () => {
    for (const [type, message] of Object.entries(messages)) {
      expect(isInteractiveMessage(message), type).toBe(true)
    }
  })

  it('rejects near-misses', () => {
    for (const value of [null, undefined, 7, 'ready', [], {}, { type: 'Query' }, { type: '' }]) {
      expect(isInteractiveRequest(value)).toBe(false)
      expect(isInteractiveMessage(value)).toBe(false)
    }
  })

  it('has an empty answer for every kind', () => {
    for (const kind of ['hover', 'completions', 'completionDetail', 'signatureHelp'] as const) {
      expect(emptyInteractiveAnswer(kind).kind).toBe(kind)
    }
  })
})
