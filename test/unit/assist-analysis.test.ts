import { describe, expect, it } from 'vitest'
import {
  buildSnippet,
  computeMetrics,
  detectConcepts,
  explain,
  findIssues,
  type AssistSelection
} from '../../src/renderer/editor/assist-analysis'

function selection(overrides: Partial<AssistSelection> = {}): AssistSelection {
  return {
    text: '',
    languageId: 'typescript',
    startLine: 1,
    endLine: 1,
    relativePath: 'src/example.ts',
    ...overrides
  }
}

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id)

describe('detectConcepts', () => {
  it('finds async/await and states the loop gotcha, not a definition', () => {
    const found = detectConcepts(
      selection({ text: 'async function go() { await fetchIt() }' })
    )
    const async = found.find((c) => c.id === 'async-await')
    expect(async).toBeDefined()
    // The value is in the gotcha; a restatement of "async means asynchronous"
    // would be useless.
    expect(async?.gotcha).toMatch(/loop/i)
  })

  it('scopes language-specific concepts to their language', () => {
    const python = { text: 'def f(items=[]):\n    pass', languageId: 'python' }
    expect(ids(detectConcepts(selection(python)))).toContain('py-mutable-default')

    // The same text in TypeScript must not report a Python concept.
    expect(ids(detectConcepts(selection({ ...python, languageId: 'typescript' })))).not.toContain(
      'py-mutable-default'
    )
  })

  it('reports TypeScript-only concepts only for TypeScript', () => {
    const text = 'const x: any = y as any'
    expect(ids(detectConcepts(selection({ text, languageId: 'typescript' })))).toContain('ts-any')
    expect(ids(detectConcepts(selection({ text, languageId: 'javascript' })))).not.toContain(
      'ts-any'
    )
  })

  it('reports language-agnostic concepts regardless of language', () => {
    const found = ids(
      detectConcepts(selection({ text: 'malloc(10);', languageId: 'c' }))
    )
    expect(found).toContain('c-malloc')
  })

  it('returns nothing for text with no recognised construct', () => {
    expect(detectConcepts(selection({ text: 'const a = 1' })).length).toBe(0)
  })
})

describe('computeMetrics', () => {
  it('counts source lines, ignoring blanks and comments', () => {
    const metrics = computeMetrics(['// a comment', '', 'const a = 1', '# another', 'const b = 2'].join('\n'))
    expect(metrics.sloc).toBe(2)
    expect(metrics.lines).toBe(5)
  })

  it('measures nesting depth without counting a closing brace as a level', () => {
    const code = ['function a() {', '  if (x) {', '    while (y) {', '    }', '  }', '}'].join('\n')
    expect(computeMetrics(code).maxNesting).toBe(3)
  })

  it('counts branch points for complexity, starting at one', () => {
    expect(computeMetrics('const a = 1').complexity).toBe(1)
    const branchy = 'if (a) {} else if (b) {} for (;;) {} while (c) {}'
    expect(computeMetrics(branchy).complexity).toBeGreaterThan(4)
  })
})

describe('findIssues', () => {
  it('flags an empty catch block', () => {
    const found = findIssues(selection({ text: 'try { go() } catch (e) {}' }))
    expect(ids(found)).toContain('empty-catch')
  })

  it('flags a bare except in Python', () => {
    const found = findIssues(selection({ text: 'try:\n    go()\nexcept:\n    pass', languageId: 'python' }))
    expect(ids(found)).toContain('bare-except')
  })

  it('flags assignment inside a condition', () => {
    expect(ids(findIssues(selection({ text: 'if (x = 5) { go() }' })))).toContain(
      'assignment-in-condition'
    )
  })

  it('flags the classic off-by-one bound', () => {
    expect(ids(findIssues(selection({ text: 'for (let i = 0; i <= arr.length; i++) {}' })))).toContain(
      'off-by-one'
    )
  })

  it('reports findings at absolute file lines, not offsets into the selection', () => {
    const found = findIssues(
      selection({ text: 'const a = 1\nconst b = 2\ntry { x() } catch (e) {}', startLine: 100 })
    )
    const empty = found.find((f) => f.id === 'empty-catch')
    // Third line of a selection starting at 100 is line 102.
    expect(empty?.line).toBe(102)
  })

  it('flags deep nesting with the measured depth in the message', () => {
    const deep = ['a {', ' b {', '  c {', '   d {', '    e {', '    }', '   }', '  }', ' }', '}'].join('\n')
    const found = findIssues(selection({ text: deep }))
    const nesting = found.find((f) => f.id === 'deep-nesting')
    expect(nesting).toBeDefined()
    expect(nesting?.message).toMatch(/\d+ levels deep/)
  })

  it('stays quiet on clean code', () => {
    const clean = 'export function add(a: number, b: number): number {\n  return a + b\n}'
    expect(findIssues(selection({ text: clean }))).toEqual([])
  })
})

describe('explain', () => {
  it('separates what the selection declares from what it depends on', () => {
    const text = [
      'export function render(items: Item[]) {',
      '  const total = sumAll(items)',
      '  return formatter.format(total)',
      '}'
    ].join('\n')

    const result = explain(selection({ text }))

    expect(result.declares).toContain('render')
    expect(result.declares).toContain('total')
    expect(result.dependsOn).toContain('sumAll')
    expect(result.dependsOn).toContain('formatter')
    // Something it declares is never also a dependency.
    expect(result.dependsOn).not.toContain('render')
  })

  it('excludes keywords and built-ins from dependencies', () => {
    const text = 'if (Math.max(a, b)) { console.log(JSON.stringify(a)) }'
    const result = explain(selection({ text }))
    for (const noise of ['if', 'Math', 'console', 'JSON']) {
      expect(result.dependsOn).not.toContain(noise)
    }
  })

  it('orders reading by how often a symbol is referenced', () => {
    const text = [
      'function helper() { return 1 }',
      'function main() { return helper() + helper() + helper() }'
    ].join('\n')
    const result = explain(selection({ text }))
    expect(result.readingOrder[0]).toBe('helper')
  })

  it('handles an empty selection without throwing', () => {
    expect(explain(selection({ text: '' }))).toEqual({
      declares: [],
      dependsOn: [],
      readingOrder: []
    })
  })
})

describe('buildSnippet', () => {
  const sel = selection({
    text: 'const a = 1',
    startLine: 10,
    endLine: 12,
    relativePath: 'src/main/thing.ts'
  })

  it('builds a resolvable GitHub blob permalink', () => {
    const { permalink } = buildSnippet(sel, {
      repository: { owner: 'aswinvensiva-crypto', repo: 'BetterCallCompiler' },
      branch: 'main'
    })
    expect(permalink).toBe(
      'https://github.com/aswinvensiva-crypto/BetterCallCompiler/blob/main/src/main/thing.ts#L10-L12'
    )
  })

  it('returns null rather than a fabricated URL when there is no remote', () => {
    const { permalink, markdown } = buildSnippet(sel, { repository: null, branch: 'main' })
    // An unresolvable link is worse than no link.
    expect(permalink).toBeNull()
    expect(markdown).not.toContain('http')
  })

  it('uses a single-line anchor when start and end match', () => {
    const single = { ...sel, endLine: 10 }
    const { permalink } = buildSnippet(single, {
      repository: { owner: 'o', repo: 'r' },
      branch: 'main'
    })
    expect(permalink?.endsWith('#L10')).toBe(true)
  })

  it('percent-encodes branch and path segments with spaces', () => {
    const spaced = { ...sel, relativePath: 'src/my folder/a b.ts' }
    const { permalink } = buildSnippet(spaced, {
      repository: { owner: 'o', repo: 'r' },
      branch: 'feature/my branch'
    })
    expect(permalink).toContain('feature%2Fmy%20branch')
    expect(permalink).toContain('my%20folder/a%20b.ts')
    expect(permalink).not.toMatch(/ /)
  })

  it('fences the code with the tag GitHub understands', () => {
    const { markdown } = buildSnippet(sel, { repository: null, branch: null })
    expect(markdown).toContain('```ts')
    expect(markdown).toContain('const a = 1')
    expect(markdown.trimEnd().endsWith('```')).toBe(true)
  })
})
