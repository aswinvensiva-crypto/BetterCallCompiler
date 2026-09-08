import { describe, expect, it } from 'vitest'
import {
  classifyMessage,
  flattenHoverContents,
  fromFileUri,
  toDiagnosticMessage,
  toFileUri,
  toLspPosition,
  toSourceRange,
  type LspDiagnostic
} from '../../src/shared/lsp-protocol'
import { diagnosticMessageSchema } from '../../src/shared/types'

/**
 * The LSP boundary.
 *
 * Two things here are worth more than the rest put together: the zero-to-one
 * based conversion, and the URI form. Both are silent when wrong — a diagnostic
 * underlining the character before the problem, or a server that returns
 * nothing because it did not recognise the path it was sent — and both are
 * cheap to pin.
 */

const range = (
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number
) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter }
})

describe('positions', () => {
  it('converts zero-based LSP to one-based ours', () => {
    // LSP's line 0, character 0 is our line 1, column 1 — the first character
    // of the file, said two ways.
    expect(toSourceRange(range(0, 0, 0, 5))).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 6
    })
  })

  it('converts one-based ours back to zero-based LSP', () => {
    expect(toLspPosition(1, 1)).toEqual({ line: 0, character: 0 })
    expect(toLspPosition(12, 30)).toEqual({ line: 11, character: 29 })
  })

  it('round trips', () => {
    const original = range(11, 29, 11, 34)
    const ours = toSourceRange(original)
    expect(toLspPosition(ours.startLine, ours.startColumn)).toEqual(original.start)
  })

  it('clamps a position a server should not have sent', () => {
    /*
     * `sourceRangeSchema` requires positive integers, and clangd has been known
     * to emit -1 for a diagnostic with no real location. Without clamping that
     * payload fails validation at the IPC boundary and takes the whole batch
     * with it — so one bad diagnostic would cost the file's other diagnostics
     * rather than only itself.
     */
    expect(toSourceRange(range(-1, -5, -1, -5))).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1
    })
  })

  it('never emits a position the schema would reject', () => {
    const nasty = [
      range(-1, -1, -1, -1),
      range(0, 0, 0, 0),
      range(1.7, 2.2, 3.9, 4.4),
      range(Number.NaN, Number.NaN, Number.NaN, Number.NaN)
    ]

    for (const candidate of nasty) {
      const converted = toSourceRange(candidate)
      const parsed = diagnosticMessageSchema.safeParse({
        relativePath: 'a.py',
        path: '/w/a.py',
        severity: 'error',
        code: 'E1',
        message: 'x',
        ...converted,
        source: 'lsp'
      })
      expect(parsed.success, JSON.stringify(candidate)).toBe(true)
    }
  })
})

describe('file URIs', () => {
  it('converts a POSIX path', () => {
    expect(toFileUri('/home/user/a b.py')).toBe('file:///home/user/a%20b.py')
  })

  it('converts a Windows path to the form servers accept', () => {
    /*
     * `C:\a\b` has two encodings in the wild — `file:///c%3A/a/b` and
     * `file:///C:/a/b` — and servers vary in which they accept. This produces
     * the second: three slashes, an unescaped colon, the drive letter's case
     * left as given. A server that does not recognise the path it was sent
     * answers with nothing, which reads as "no definition here" rather than as
     * a path bug.
     */
    expect(toFileUri('C:\\Users\\me\\a.py')).toBe('file:///C:/Users/me/a.py')
  })

  it('round trips both platforms', () => {
    for (const path of ['/home/user/a.py', '/home/user/a b.py', 'C:\\Users\\me\\a.py']) {
      const back = fromFileUri(toFileUri(path))
      // Windows comes back POSIX-separated, which every consumer here accepts.
      expect(back).toBe(path.replace(/\\/g, '/'))
    }
  })

  it('escapes what has to be escaped and not the drive colon', () => {
    expect(toFileUri('/w/a#b.py')).toContain('%23')
    expect(toFileUri('C:/w/a.py')).not.toContain('%3A')
  })

  it('returns null for a URI that is not a file', () => {
    expect(fromFileUri('untitled:Untitled-1')).toBeNull()
    expect(fromFileUri('https://example.com/a.py')).toBeNull()
  })
})

describe('classifying a JSON-RPC message', () => {
  /*
   * JSON-RPC carries no discriminator field, so the shape is the discriminator.
   * Getting it wrong means answering a notification — which servers reject — or
   * leaving a request unanswered, which hangs the server waiting for us.
   */

  it('tells the three shapes apart', () => {
    expect(classifyMessage({ jsonrpc: '2.0', id: 1, method: 'x' })).toBe('request')
    expect(classifyMessage({ jsonrpc: '2.0', method: 'x' })).toBe('notification')
    expect(classifyMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe('response')
  })

  it('treats a null id as a response, because the spec does', () => {
    // An error against a request the server could not even parse carries
    // `id: null`. Reading that as "no id" would classify it as unknown and
    // leave the caller waiting forever.
    expect(classifyMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'x' } })).toBe(
      'response'
    )
  })

  it('rejects what is not a message at all', () => {
    expect(classifyMessage(null)).toBe('unknown')
    expect(classifyMessage('hello')).toBe('unknown')
    expect(classifyMessage({ jsonrpc: '2.0' })).toBe('unknown')
  })
})

describe('diagnostics', () => {
  const base: LspDiagnostic = {
    range: range(4, 8, 4, 15),
    severity: 1,
    code: 'reportUndefinedVariable',
    message: '"foo" is not defined'
  }

  it('becomes the shape the Problems panel already renders', () => {
    // The point of the whole exercise: emitting the existing DiagnosticMessage
    // buys Problems, the marker mapping and the clean sweep unchanged.
    const message = toDiagnosticMessage(base, 'src/a.py', '/w/src/a.py', 'pyright')

    expect(diagnosticMessageSchema.parse(message)).toEqual({
      relativePath: 'src/a.py',
      path: '/w/src/a.py',
      severity: 'error',
      code: 'reportUndefinedVariable',
      message: '"foo" is not defined',
      startLine: 5,
      startColumn: 9,
      endLine: 5,
      endColumn: 16,
      source: 'lsp'
    })
  })

  it.each([
    [1, 'error'],
    [2, 'warning'],
    [3, 'info'],
    [4, 'hint']
  ] as const)('maps severity %i to %s', (severity, expected) => {
    expect(toDiagnosticMessage({ ...base, severity }, 'a.py', '/w/a.py', 'x').severity).toBe(expected)
  })

  it('treats a missing severity as an error rather than dropping it', () => {
    // The spec leaves it to the client and every editor decides "error". A
    // server that omits it is reporting something it considers a problem;
    // hiding it because a field was absent is the wrong failure.
    const { severity, ...withoutSeverity } = base
    expect(severity).toBe(1)
    expect(toDiagnosticMessage(withoutSeverity, 'a.py', '/w/a.py', 'x').severity).toBe('error')
  })

  it('falls back to the server name when there is no code', () => {
    const { code, ...withoutCode } = base
    expect(code).toBeDefined()
    // A Problems row must never read as blank in its code column.
    expect(toDiagnosticMessage(withoutCode, 'a.py', '/w/a.py', 'clangd').code).toBe('clangd')
  })

  it('stringifies a numeric code', () => {
    expect(toDiagnosticMessage({ ...base, code: 2304 }, 'a.py', '/w/a.py', 'x').code).toBe('2304')
  })
})

describe('hover contents', () => {
  /*
   * Four shapes across protocol versions, and servers in current use emit all
   * four. Handling one produces an empty tooltip against exactly the servers
   * that were not tested.
   */

  it('takes a plain string', () => {
    expect(flattenHoverContents('int')).toBe('int')
  })

  it('takes a markup object', () => {
    expect(flattenHoverContents({ kind: 'markdown', value: '**int**' })).toBe('**int**')
  })

  it('fences a language-tagged string', () => {
    expect(flattenHoverContents({ language: 'python', value: 'def f() -> int' })).toBe(
      '```python\ndef f() -> int\n```'
    )
  })

  it('joins an array of mixed shapes', () => {
    expect(
      flattenHoverContents([
        { language: 'go', value: 'func F() int' },
        'Returns an int.'
      ])
    ).toBe('```go\nfunc F() int\n```\n\nReturns an int.')
  })

  it('is empty rather than throwing on anything else', () => {
    expect(flattenHoverContents(null)).toBe('')
    expect(flattenHoverContents(undefined)).toBe('')
    expect(flattenHoverContents({ kind: 'markdown' })).toBe('')
    expect(flattenHoverContents([])).toBe('')
  })
})
