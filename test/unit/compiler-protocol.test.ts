import { describe, expect, it } from 'vitest'
import {
  coalesceBatches,
  countSeverities,
  emptyLanguageQueryAnswer,
  isWorkerMessage,
  isWorkerRequest,
  type WorkerMessage,
  type WorkerRequest
} from '../../src/shared/compiler-protocol'
import type { DiagnosticMessage, FileDiagnostics } from '../../src/shared/types'

function diagnostic(overrides: Partial<DiagnosticMessage> = {}): DiagnosticMessage {
  return {
    relativePath: 'src/a.ts',
    path: 'C:/ws/src/a.ts',
    severity: 'error',
    code: 'TS2345',
    message: 'nope',
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 2,
    source: 'typescript',
    ...overrides
  }
}

function fileDiagnostics(
  relativePath: string,
  version: number,
  diagnostics: DiagnosticMessage[] = [diagnostic({ relativePath })]
): FileDiagnostics {
  return { relativePath, path: `C:/ws/${relativePath}`, diagnostics, version }
}

describe('coalesceBatches', () => {
  it('keeps only the latest entry per file', () => {
    const result = coalesceBatches([
      fileDiagnostics('a.ts', 1),
      fileDiagnostics('a.ts', 2, [diagnostic({ relativePath: 'a.ts', code: 'TS9999' })])
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.version).toBe(2)
    expect(result[0]?.diagnostics[0]?.code).toBe('TS9999')
  })

  it('preserves first-appearance order across files', () => {
    const result = coalesceBatches([
      fileDiagnostics('z.ts', 1),
      fileDiagnostics('a.ts', 1),
      fileDiagnostics('z.ts', 2)
    ])

    // Not sorted — reshuffling the Problems panel between batches is noise.
    expect(result.map((entry) => entry.relativePath)).toEqual(['z.ts', 'a.ts'])
  })

  /**
   * The single rule most likely to be "optimised" away. An empty array is the
   * "this file is now clean" signal; dropping it as an empty payload is exactly
   * how a fixed error keeps its squiggle until some unrelated edit.
   */
  it('keeps an entry whose diagnostics array is empty', () => {
    const result = coalesceBatches([fileDiagnostics('a.ts', 3, [])])

    expect(result).toHaveLength(1)
    expect(result[0]?.diagnostics).toEqual([])
  })

  it('lets a later empty set clear an earlier non-empty one', () => {
    const result = coalesceBatches([
      fileDiagnostics('a.ts', 1),
      fileDiagnostics('a.ts', 2, [])
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.diagnostics).toEqual([])
  })

  it('drops an out-of-order batch with a lower version', () => {
    // Without the version guard, a late-arriving older result resurrects
    // diagnostics the user has already fixed.
    const result = coalesceBatches([
      fileDiagnostics('a.ts', 5, []),
      fileDiagnostics('a.ts', 2)
    ])

    expect(result[0]?.version).toBe(5)
    expect(result[0]?.diagnostics).toEqual([])
  })

  it('accepts an equal version as a replacement', () => {
    const result = coalesceBatches([
      fileDiagnostics('a.ts', 4),
      fileDiagnostics('a.ts', 4, [])
    ])

    expect(result[0]?.diagnostics).toEqual([])
  })

  it('returns nothing for an empty queue', () => {
    expect(coalesceBatches([])).toEqual([])
  })

  it('collapses a large burst to one entry per file', () => {
    const burst: FileDiagnostics[] = []
    for (let i = 0; i < 40; i++) burst.push(fileDiagnostics('a.ts', i))
    for (let i = 0; i < 40; i++) burst.push(fileDiagnostics('b.ts', i))

    const result = coalesceBatches(burst)

    expect(result).toHaveLength(2)
    expect(result.every((entry) => entry.version === 39)).toBe(true)
  })
})

describe('countSeverities', () => {
  it('counts errors and warnings separately and ignores info/hint', () => {
    const counts = countSeverities([
      fileDiagnostics('a.ts', 1, [
        diagnostic({ severity: 'error' }),
        diagnostic({ severity: 'warning' }),
        diagnostic({ severity: 'info' }),
        diagnostic({ severity: 'hint' })
      ]),
      fileDiagnostics('b.ts', 1, [diagnostic({ severity: 'error' })])
    ])

    expect(counts).toEqual({ errorCount: 2, warningCount: 1 })
  })

  it('returns zeroes for no files', () => {
    expect(countSeverities([])).toEqual({ errorCount: 0, warningCount: 0 })
  })
})

/**
 * The one thing TypeScript does not check for us.
 *
 * Both guards enumerate their type strings by hand, so adding a member to
 * either union compiles cleanly and is then silently dropped on the floor — a
 * new message that never arrives, with nothing pointing at the cause. The
 * `Record<Union['type'], ...>` tables below close it: a new member makes this
 * file fail to compile until it has an entry, and the assertions then make the
 * guards admit it.
 *
 * Previously these were bare string arrays, which is the same test with the
 * compile-time half missing — `languageQuery` was added to the protocol and
 * these lists would have stayed green without it.
 */
const MESSAGE_TYPES: Record<WorkerMessage['type'], true> = {
  ready: true,
  state: true,
  diagnostics: true,
  dependentsResult: true,
  languageQueryResult: true,
  pong: true,
  pass: true,
  failure: true
}

const REQUEST_TYPES: Record<WorkerRequest['type'], true> = {
  boot: true,
  filesChanged: true,
  openDocument: true,
  closeDocument: true,
  dependents: true,
  languageQuery: true,
  ping: true
}

describe('message guards', () => {
  it('accepts every worker message type', () => {
    for (const type of Object.keys(MESSAGE_TYPES)) {
      expect(isWorkerMessage({ type }), type).toBe(true)
    }
  })

  it('accepts every request type', () => {
    for (const type of Object.keys(REQUEST_TYPES)) {
      expect(isWorkerRequest({ type }), type).toBe(true)
    }
  })

  it('has an empty answer for every language query kind', () => {
    // `emptyLanguageQueryAnswer` is what every "no answer" path returns — a
    // daemon that is down, a timeout, a position the program knows nothing
    // about. A kind missing from it would be an undefined reaching Monaco.
    for (const kind of ['definition', 'references'] as const) {
      expect(emptyLanguageQueryAnswer(kind).kind).toBe(kind)
    }
  })

  /**
   * A worker can post anything — including an uncaught rejection's payload.
   * The supervisor must narrow before use rather than crash on a shape it does
   * not recognise.
   */
  it('rejects anything that is not a known message', () => {
    for (const value of [
      null,
      undefined,
      42,
      'ready',
      [],
      {},
      { type: 'nonsense' },
      { type: 'languagequery' },
      { type: 'LanguageQuery' },
      { type: 'languageQueries' }
    ]) {
      expect(isWorkerMessage(value)).toBe(false)
      expect(isWorkerRequest(value)).toBe(false)
    }
  })
})
