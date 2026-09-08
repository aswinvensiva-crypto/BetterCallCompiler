import { describe, expect, it } from 'vitest'
import { renderWalkthroughContext } from '../../src/main/walkthrough-service'

describe('renderWalkthroughContext', () => {
  it('opens with the instruction', () => {
    const text = renderWalkthroughContext({
      instruction: 'Rename parseConfig to loadConfig.',
      files: [{ path: 'src/a.ts', before: 'old', after: 'new' }]
    })
    expect(text.startsWith('Instruction that was carried out: Rename parseConfig to loadConfig.')).toBe(
      true
    )
  })

  it('includes both before and after content for every file, fenced', () => {
    const text = renderWalkthroughContext({
      instruction: 'x',
      files: [
        { path: 'src/a.ts', before: 'const a = 1', after: 'const a = 2' },
        { path: 'src/b.ts', before: 'const b = 1', after: 'const b = 2' }
      ]
    })

    expect(text).toContain('### FILE: src/a.ts')
    expect(text).toContain('### FILE: src/b.ts')
    expect(text).toContain('const a = 1')
    expect(text).toContain('const a = 2')
    expect(text).toContain('const b = 1')
    expect(text).toContain('const b = 2')
    expect(text).toContain('Before:')
    expect(text).toContain('After:')
  })

  it('preserves file order', () => {
    const text = renderWalkthroughContext({
      instruction: 'x',
      files: [
        { path: 'z.ts', before: '', after: '' },
        { path: 'a.ts', before: '', after: '' }
      ]
    })
    expect(text.indexOf('### FILE: z.ts')).toBeLessThan(text.indexOf('### FILE: a.ts'))
  })
})
