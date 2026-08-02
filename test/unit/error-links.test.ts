import { describe, expect, it } from 'vitest'
import { findErrorLinks, isAbsoluteLike, isLinkablePath } from '../../src/shared/error-links'

/**
 * Fixtures are real output, copied verbatim from the tools rather than
 * paraphrased. A regex that passes against a tidied-up sample and fails against
 * what the compiler actually prints is worse than no regex at all.
 */

/** Convenience: run the matcher over a multi-line fixture, line by line. */
function linksIn(fixture: string): Array<{ path: string; line: number; column: number | null }> {
  return fixture
    .split('\n')
    .flatMap((line) => findErrorLinks(line))
    .map(({ path, line, column }) => ({ path, line, column }))
}

describe('Node.js', () => {
  const UNCAUGHT = [
    'C:\\work\\app\\index.js:3',
    "  throw new Error('boom');",
    '  ^',
    '',
    'Error: boom',
    '    at Object.<anonymous> (C:\\work\\app\\index.js:3:9)',
    '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
    '    at Object..js (node:internal/modules/cjs/loader:1706:10)',
    '    at Module.load (node:internal/modules/cjs/loader:1288:32)'
  ].join('\n')

  it('finds the throw header and the user frame', () => {
    expect(linksIn(UNCAUGHT)).toEqual([
      { path: 'C:\\work\\app\\index.js', line: 3, column: null },
      { path: 'C:\\work\\app\\index.js', line: 3, column: 9 }
    ])
  })

  it('ignores node: internal frames, which are not files on disk', () => {
    expect(findErrorLinks('    at Module._compile (node:internal/modules/cjs/loader:1554:14)')).toEqual(
      []
    )
  })

  it('handles a frame with no enclosing function', () => {
    expect(linksIn('    at /home/dev/app/server.js:42:11')).toEqual([
      { path: '/home/dev/app/server.js', line: 42, column: 11 }
    ])
  })

  it('handles a path containing spaces', () => {
    expect(linksIn('    at run (C:\\Program Files\\my app\\main.js:7:3)')).toEqual([
      { path: 'C:\\Program Files\\my app\\main.js', line: 7, column: 3 }
    ])
  })

  it('links esm and typescript extensions too', () => {
    expect(linksIn('    at file (C:\\a\\b.mjs:1:1)')[0]?.path).toBe('C:\\a\\b.mjs')
    expect(linksIn('    at file (C:\\a\\b.ts:1:1)')[0]?.path).toBe('C:\\a\\b.ts')
  })
})

describe('Python', () => {
  const TRACEBACK = [
    'Traceback (most recent call last):',
    '  File "C:\\work\\app\\main.py", line 7, in <module>',
    '    boom()',
    '  File "C:\\work\\app\\main.py", line 4, in boom',
    "    raise ValueError('nope')",
    'ValueError: nope'
  ].join('\n')

  it('finds every frame in a traceback', () => {
    expect(linksIn(TRACEBACK)).toEqual([
      { path: 'C:\\work\\app\\main.py', line: 7, column: null },
      { path: 'C:\\work\\app\\main.py', line: 4, column: null }
    ])
  })

  it('handles a posix path and a relative path', () => {
    expect(linksIn('  File "/home/dev/app/main.py", line 12, in run')).toEqual([
      { path: '/home/dev/app/main.py', line: 12, column: null }
    ])
    expect(linksIn('  File "src/main.py", line 1, in <module>')).toEqual([
      { path: 'src/main.py', line: 1, column: null }
    ])
  })

  it('ignores frozen bootstrap frames', () => {
    expect(findErrorLinks('  File "<frozen importlib._bootstrap>", line 1360, in _find_and_load')).toEqual(
      []
    )
  })

  // A SyntaxError points at a caret line rather than a call.
  it('finds the file in a SyntaxError report', () => {
    expect(linksIn('  File "C:\\work\\bad.py", line 2')).toEqual([
      { path: 'C:\\work\\bad.py', line: 2, column: null }
    ])
  })
})

describe('GCC and G++', () => {
  const DIAGNOSTICS = [
    'main.c: In function \u2018main\u2019:',
    "main.c:5:12: error: 'x' undeclared (first use in this function)",
    '    5 |     return x;',
    '      |            ^',
    'main.c:3:5: warning: unused variable \u2018y\u2019 [-Wunused-variable]',
    'main.c:9: error: expected declaration or statement at end of input'
  ].join('\n')

  it('finds errors and warnings, with and without a column', () => {
    expect(linksIn(DIAGNOSTICS)).toEqual([
      { path: 'main.c', line: 5, column: 12 },
      { path: 'main.c', line: 3, column: 5 },
      { path: 'main.c', line: 9, column: null }
    ])
  })

  it('does not link the "In function" line, which has no location', () => {
    expect(findErrorLinks('main.c: In function \u2018main\u2019:')).toEqual([])
  })

  it('handles fatal error and note', () => {
    expect(linksIn("hello.cpp:1:10: fatal error: iostrem: No such file or directory")).toEqual([
      { path: 'hello.cpp', line: 1, column: 10 }
    ])
    expect(linksIn('inc/util.h:12:3: note: candidate expects 2 arguments')).toEqual([
      { path: 'inc/util.h', line: 12, column: 3 }
    ])
  })

  it('handles an absolute path with a space', () => {
    expect(linksIn("C:\\my code\\main.cpp:8:1: error: expected ';'")).toEqual([
      { path: 'C:\\my code\\main.cpp', line: 8, column: 1 }
    ])
  })
})

describe('tsc', () => {
  it('finds the parenthesised line,column form', () => {
    expect(linksIn("src/main.ts(10,5): error TS2304: Cannot find name 'x'.")).toEqual([
      { path: 'src/main.ts', line: 10, column: 5 }
    ])
  })

  it('finds warnings too', () => {
    expect(linksIn('src/a.ts(1,1): warning TS6133: unused')).toEqual([
      { path: 'src/a.ts', line: 1, column: 1 }
    ])
  })
})

describe('offsets and overlap', () => {
  it('reports offsets that select the location text itself', () => {
    const line = '    at Object.<anonymous> (C:\\app\\index.js:3:9)'
    const [link] = findErrorLinks(line)
    expect(link).toBeDefined()
    expect(line.slice(link?.start, link?.end)).toBe('C:\\app\\index.js:3:9')
  })

  it('reports offsets for a gcc diagnostic', () => {
    const line = "main.c:5:12: error: 'x' undeclared"
    const [link] = findErrorLinks(line)
    expect(line.slice(link?.start, link?.end)).toBe('main.c:5:12')
  })

  it('emits one link per location, not one per matching pattern', () => {
    // The parenthesised and bare Node matchers both see this line.
    expect(findErrorLinks('    at run (C:\\a\\b.js:1:2)')).toHaveLength(1)
  })

  it('finds nothing in ordinary prose', () => {
    expect(findErrorLinks('Building project, please wait...')).toEqual([])
    expect(findErrorLinks('Ratio was 3:1 and time 12:30:45')).toEqual([])
    expect(findErrorLinks('')).toEqual([])
  })

  it('does not hang on pathological input', () => {
    const nasty = `${'('.repeat(500)}a.js:1:1${')'.repeat(500)}`
    const start = Date.now()
    findErrorLinks(nasty)
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('path helpers', () => {
  it('recognises absolute paths on both platforms', () => {
    expect(isAbsoluteLike('C:\\a\\b.js')).toBe(true)
    expect(isAbsoluteLike('c:/a/b.js')).toBe(true)
    expect(isAbsoluteLike('/home/dev/a.js')).toBe(true)
    expect(isAbsoluteLike('\\\\server\\share\\a.js')).toBe(true)
    expect(isAbsoluteLike('src/a.js')).toBe(false)
    expect(isAbsoluteLike('a.js')).toBe(false)
  })

  it('rejects synthetic frame names', () => {
    expect(isLinkablePath('node:fs')).toBe(false)
    expect(isLinkablePath('internal/process/task_queues.js')).toBe(false)
    expect(isLinkablePath('<anonymous>')).toBe(false)
    expect(isLinkablePath('')).toBe(false)
    expect(isLinkablePath('src/main.ts')).toBe(true)
  })
})
