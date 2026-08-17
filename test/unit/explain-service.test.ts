import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  renderExplainContext,
  renderNeighbours,
  buildExplainPrompt,
  renderRegionDiagnostics,
  selectRegionDiagnostics,
  type RegionDiagnostics
} from '../../src/main/explain-service'
import {
  resetCompilerForTests,
  setCompilerEmitters,
  setWorkerFactory,
  startCompiler,
  type WorkerHandle
} from '../../src/main/compiler-service'
import type { WorkerMessage, WorkerRequest } from '../../src/shared/compiler-protocol'
import { titleForExplanation } from '../../src/shared/artifact-format'
import type {
  AiContext,
  Artifact,
  DiagnosticMessage,
  FileDiagnostics
} from '../../src/shared/types'

function context(overrides: Partial<AiContext> = {}): AiContext {
  return {
    filePath: 'C:/ws/src/runner.ts',
    relativePath: 'src/runner.ts',
    languageId: 'typescript',
    selection: {
      text: 'export function planRun() {}',
      startLine: 117,
      startColumn: 1,
      endLine: 140,
      endColumn: 2
    },
    enclosingSymbol: { name: 'planRun', kind: 'function', text: 'export function planRun() {}' },
    imports: ["import { join } from 'node:path'"],
    ...overrides
  }
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'ex-a-1',
    kind: 'explanation',
    title: 'planRun in src/runner.ts',
    createdAt: '2026-08-11T00:00:00.000Z',
    model: 'claude-sonnet-5',
    promptHash: 'abc',
    contextSent: '',
    sections: [
      { id: 'planning-1', heading: 'Planning', markdown: 'It picks a recipe.', anchors: [] }
    ],
    comments: [],
    supersedes: null,
    ...overrides
  }
}

describe('renderNeighbours', () => {
  /**
   * What the model actually lacks is knowing the file has dependents at all. A
   * function is explained very differently when fourteen files import it than
   * when nothing does, and that fact costs a line while the contents would cost
   * the whole budget.
   */
  it('names imports and importers in both directions', () => {
    const text = renderNeighbours(['src/a.ts', 'src/b.ts'], ['src/app.ts'])

    expect(text).toContain('This file imports: src/a.ts, src/b.ts')
    expect(text).toContain('Imported by: src/app.ts')
  })

  /**
   * "Imported by 3 files" and "imported by 200 files" call for different
   * explanations. A list silently cut to twelve reads as the former in both
   * cases, so the remainder is stated.
   */
  it('states the remainder rather than truncating silently', () => {
    const many = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`)
    const text = renderNeighbours([], many)

    expect(text).toContain('and 28 more')
    expect(text).toContain('wide fan-in')
  })

  it('says nothing at all for an isolated file', () => {
    expect(renderNeighbours([], [])).toBe('')
  })
})

describe('renderExplainContext', () => {
  /**
   * The citation syntax is only useful if the model knows which path string to
   * put in it. Without being told, it guesses at the repository layout and
   * cites paths that do not resolve.
   */
  it('tells the model exactly how to cite this file, with a worked example', () => {
    const text = renderExplainContext(context(), '', '', null, null)

    expect(text).toContain('Cite this file as: src/runner.ts')
    expect(text).toContain('[[src/runner.ts:117-140 planRun]]')
  })

  it('builds on renderContext so the stored prompt matches the AI panel’s', () => {
    const text = renderExplainContext(context(), '', '', null, null)

    // These lines come from `renderContext`, not from this module. A second
    // renderer would drift, and the "context sent" claim would become false.
    expect(text).toContain('File: src/runner.ts')
    expect(text).toContain('Language: typescript')
    expect(text).toContain('Selection: lines 117-140')
  })

  it('omits the neighbour section when there are no neighbours', () => {
    expect(renderExplainContext(context(), '', '', null, null)).not.toContain('import graph')
  })

  it('includes the prior explanation and the comment when revising', () => {
    const text = renderExplainContext(
      context(),
      '',
      '',
      artifact(),
      'Why does it prefer the bundled runtime?'
    )

    expect(text).toContain('The explanation you wrote earlier:')
    expect(text).toContain('## Planning')
    expect(text).toContain('It picks a recipe.')
    expect(text).toContain('Why does it prefer the bundled runtime?')
  })

  it('ignores a blank comment rather than sending an empty question', () => {
    expect(renderExplainContext(context(), '', '', null, '   ')).not.toContain('reader')
  })

  it('falls back to the selection line when there is no enclosing symbol', () => {
    const text = renderExplainContext(context({ enclosingSymbol: null }), '', '', null, null)
    expect(text).toContain('[[src/runner.ts:117-140]]')
  })
})

describe('titleForExplanation', () => {
  it('names the symbol and file, which is what a person recognises later', () => {
    expect(titleForExplanation('src/runner.ts', 117, 'planRun', false)).toBe(
      'planRun in src/runner.ts'
    )
  })

  it('falls back to file and line with no symbol', () => {
    expect(titleForExplanation('src/runner.ts', 117, null, false)).toBe('src/runner.ts:117')
  })

  /**
   * Marked in the title as well as in the record. Two similarly-named entries
   * with no way to tell which answered which is how a history stops being
   * usable.
   */
  it('marks a revision', () => {
    expect(titleForExplanation('src/runner.ts', 117, 'planRun', true)).toBe(
      'planRun in src/runner.ts — revised'
    )
  })
})

function diag(overrides: Partial<DiagnosticMessage> = {}): DiagnosticMessage {
  return {
    relativePath: 'src/runner.ts',
    path: 'C:/ws/src/runner.ts',
    severity: 'error',
    code: 'TS2345',
    message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
    startLine: 120,
    startColumn: 5,
    endLine: 120,
    endColumn: 11,
    source: 'typescript',
    ...overrides
  }
}

const fileDiags = (diagnostics: DiagnosticMessage[]): FileDiagnostics => ({
  relativePath: 'src/runner.ts',
  path: 'C:/ws/src/runner.ts',
  diagnostics,
  version: 1
})

/** The context fixture selects lines 117-140. */
const SELECTION_START = 117
const SELECTION_END = 140

describe('selectRegionDiagnostics', () => {
  it('reports nothing known when the daemon has never checked the file', () => {
    expect(selectRegionDiagnostics([], 'src/runner.ts', SELECTION_START, SELECTION_END)).toEqual({
      known: false
    })
  })

  it('is still unknown when the daemon has only checked some other file', () => {
    const other: FileDiagnostics = { ...fileDiags([]), relativePath: 'src/other.ts' }

    expect(
      selectRegionDiagnostics([other], 'src/runner.ts', SELECTION_START, SELECTION_END).known
    ).toBe(false)
  })

  it('treats a checked-but-clean file as known, not as unknown', () => {
    const region = selectRegionDiagnostics(
      [fileDiags([])],
      'src/runner.ts',
      SELECTION_START,
      SELECTION_END
    )

    // The assertion that stops "nothing was checked" collapsing into "nothing
    // is wrong". They are opposite claims and only one of them is information.
    expect(region.known).toBe(true)
    if (!region.known) return
    expect(region.inRegion).toEqual([])
    expect(region.elsewhere).toEqual([])
  })

  it('counts a diagnostic straddling the top of the selection as in region', () => {
    const straddling = diag({ startLine: 115, endLine: 118 })
    const region = selectRegionDiagnostics(
      [fileDiags([straddling])],
      'src/runner.ts',
      SELECTION_START,
      SELECTION_END
    )

    if (!region.known) throw new Error('expected known')
    expect(region.inRegion).toHaveLength(1)
  })

  it('counts a diagnostic straddling the bottom of the selection as in region', () => {
    const straddling = diag({ startLine: 139, endLine: 145 })
    const region = selectRegionDiagnostics(
      [fileDiags([straddling])],
      'src/runner.ts',
      SELECTION_START,
      SELECTION_END
    )

    if (!region.known) throw new Error('expected known')
    expect(region.inRegion).toHaveLength(1)
  })

  it('files a diagnostic entirely outside the selection under elsewhere', () => {
    const above = diag({ startLine: 5, endLine: 5 })
    const below = diag({ startLine: 200, endLine: 200 })
    const region = selectRegionDiagnostics(
      [fileDiags([above, below])],
      'src/runner.ts',
      SELECTION_START,
      SELECTION_END
    )

    if (!region.known) throw new Error('expected known')
    expect(region.inRegion).toEqual([])
    expect(region.elsewhere).toHaveLength(2)
  })

  it('sorts errors ahead of warnings, then by line', () => {
    const warning = diag({ severity: 'warning', startLine: 118, code: 'TS-CYCLE' })
    const lateError = diag({ startLine: 130 })
    const earlyError = diag({ startLine: 120 })
    const region = selectRegionDiagnostics(
      [fileDiags([warning, lateError, earlyError])],
      'src/runner.ts',
      SELECTION_START,
      SELECTION_END
    )

    if (!region.known) throw new Error('expected known')
    expect(region.inRegion.map((d) => d.startLine)).toEqual([120, 130, 118])
  })

  it('caps the listing and reports the remainder', () => {
    const many = Array.from({ length: 15 }, (_, i) => diag({ startLine: 118 + i, endLine: 118 + i }))
    const region = selectRegionDiagnostics(
      [fileDiags(many)],
      'src/runner.ts',
      SELECTION_START,
      SELECTION_END
    )

    if (!region.known) throw new Error('expected known')
    expect(region.inRegion).toHaveLength(10)
    expect(region.truncated).toBe(5)
  })
})

describe('renderRegionDiagnostics', () => {
  const known = (
    inRegion: DiagnosticMessage[],
    elsewhere: DiagnosticMessage[] = [],
    truncated = 0
  ): RegionDiagnostics => ({ known: true, inRegion, elsewhere, truncated })

  it('says nothing at all when the daemon has not checked the file', () => {
    // toBe rather than toContain: a stray newline here would push an empty
    // section into the prompt and break the byte-identity guarantee.
    expect(renderRegionDiagnostics({ known: false }, SELECTION_START, SELECTION_END)).toBe('')
  })

  it('renders position, severity, code and message on one line', () => {
    const text = renderRegionDiagnostics(
      known([diag({ startLine: 41, startColumn: 12 })]),
      SELECTION_START,
      SELECTION_END
    )

    expect(text).toContain('  41:12 error TS2345: Argument of type')
  })

  it('reports a clean file as clean rather than as silence', () => {
    expect(renderRegionDiagnostics(known([]), SELECTION_START, SELECTION_END)).toContain(
      'no problems anywhere in this file'
    )
  })

  it('summarises the rest of the file without listing it', () => {
    const elsewhere = [
      diag({ startLine: 5, message: 'first stray error' }),
      diag({ startLine: 6, message: 'second stray error' }),
      diag({ startLine: 7, severity: 'warning', message: 'a stray warning' })
    ]
    const text = renderRegionDiagnostics(known([diag()], elsewhere), SELECTION_START, SELECTION_END)

    expect(text).toContain('Elsewhere in this file: 2 errors, 1 warning.')
    expect(text).not.toContain('first stray error')
  })

  it('says the region is clean when only the rest of the file is dirty', () => {
    const text = renderRegionDiagnostics(
      known([], [diag({ startLine: 5 })]),
      SELECTION_START,
      SELECTION_END
    )

    expect(text).toContain('The compiler reports nothing for lines 117-140.')
    expect(text).toContain('Elsewhere in this file: 1 error.')
  })

  it('states the remainder when the listing was capped', () => {
    expect(
      renderRegionDiagnostics(known([diag()], [], 5), SELECTION_START, SELECTION_END)
    ).toContain('(and 5 more)')
  })

  it('never uses the words the context assertions forbid', () => {
    // Asserted here, on the function that owns the wording, so a later reword
    // fails with an obvious message instead of breaking a test three describes
    // away that is checking something else entirely.
    const text = renderRegionDiagnostics(known([diag()], [diag({ startLine: 5 })], 2), 1, 2)

    expect(text).not.toContain('reader')
    expect(text).not.toContain('import graph')
  })
})

describe('renderExplainContext with diagnostics', () => {
  /**
   * The guarantee that makes this feature free when the daemon has nothing to
   * say. Spelled out rather than snapshotted, so that adding an unconditional
   * header fails here with a readable diff.
   */
  it('is byte-identical to the ungrounded prompt when the daemon knows nothing', () => {
    const withoutDiagnostics = renderExplainContext(context(), '', '', null, null)

    expect(withoutDiagnostics).not.toContain('the compiler reports')
    expect(withoutDiagnostics).not.toContain('What the compiler')
    // Nothing empty was pushed: no run of three newlines anywhere.
    expect(withoutDiagnostics).not.toMatch(/\n\n\n/)
  })

  it('places the diagnostics after the neighbours and before the citation instruction', () => {
    const neighbours = 'imports: src/lib.ts'
    const diagnostics = 'What the compiler reports for lines 117-140 (from the daemon)'
    const text = renderExplainContext(context(), neighbours, diagnostics, null, null)

    expect(text.indexOf(neighbours)).toBeLessThan(text.indexOf(diagnostics))
    expect(text.indexOf(diagnostics)).toBeLessThan(text.indexOf('Cite this file as:'))
  })

  it('carries the diagnostics through into a revision prompt', () => {
    const text = renderExplainContext(
      context(),
      '',
      'What the compiler reports for lines 117-140: TS2345',
      artifact(),
      'Why does it prefer the bundled runtime?'
    )

    expect(text).toContain('TS2345')
    expect(text).toContain('The explanation you wrote earlier:')
    expect(text).toContain('Why does it prefer the bundled runtime?')
  })
})

/**
 * Drives the real compiler-service through its existing fake-worker seam rather
 * than mocking the module. The suite has no `vi.mock` anywhere and this is why:
 * the thing worth proving is that a diagnostic emitted by the daemon reaches the
 * prompt through the real `diagnosticsByPath` map, and a mock would assert only
 * that the code is the code.
 */
class StubWorker implements WorkerHandle {
  private readonly listeners: ((value: never) => void)[] = []

  postMessage(message: WorkerRequest): void {
    // Answered synchronously, which is safe because `dependentsOf` registers its
    // pending callback BEFORE it sends.
    if (message.type === 'dependents') {
      this.emit({
        type: 'dependentsResult',
        requestId: message.requestId,
        query: { node: null, dependents: [], cycle: null }
      })
    }
  }

  terminate(): void {}

  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): void {
    if (event === 'message') this.listeners.push(listener)
  }

  emit(message: WorkerMessage): void {
    for (const listener of this.listeners) (listener as (value: unknown) => void)(message)
  }
}

describe('buildExplainPrompt', () => {
  let stub: StubWorker

  const emitDiagnosticsFor = (diagnostics: DiagnosticMessage[]): void => {
    stub.emit({
      type: 'diagnostics',
      files: [{ ...fileDiags(diagnostics) }],
      settled: true
    })
  }

  const promptFor = async (): Promise<string> =>
    (await buildExplainPrompt({ context: context(), priorArtifact: null, question: null })).user

  beforeEach(() => {
    resetCompilerForTests()
    stub = new StubWorker()
    setWorkerFactory(() => stub)
    setCompilerEmitters(
      () => {},
      () => {}
    )
    startCompiler('C:/ws')
  })

  afterEach(() => {
    resetCompilerForTests()
    setWorkerFactory(null)
  })

  it('carries a real diagnostic from the daemon into the prompt', async () => {
    emitDiagnosticsFor([diag({ startLine: 120, startColumn: 5 })])

    expect(await promptFor()).toContain('120:5 error TS2345')
  })

  it('leaves the prompt untouched for a file the daemon has never checked', async () => {
    // Nothing emitted, so diagnosticsFor returns []. End to end through the real
    // map, this is the (a) outcome: no opinion, and therefore no section.
    expect(await promptFor()).toBe(renderExplainContext(context(), '', '', null, null))
  })

  it('summarises a diagnostic outside the selection rather than listing it', async () => {
    emitDiagnosticsFor([diag({ startLine: 5, endLine: 5, message: 'a stray error elsewhere' })])
    const prompt = await promptFor()

    expect(prompt).toContain('Elsewhere in this file: 1 error.')
    expect(prompt).not.toContain('a stray error elsewhere')
  })

  it('says so when the daemon checked the file and found nothing', async () => {
    emitDiagnosticsFor([])

    expect(await promptFor()).toContain('no problems anywhere in this file')
  })
})
