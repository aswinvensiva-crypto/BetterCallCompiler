import { describe, expect, it } from 'vitest'
import { languageForFile } from '../../src/renderer/editor/language-id'

/**
 * Unit-testable at all only because this module imports nothing. While the table
 * lived in monaco-setup.ts, reaching it from a test meant loading Monaco.
 */
describe('languageForFile', () => {
  it('recognises a Dockerfile by name rather than by extension', () => {
    expect(languageForFile('Dockerfile')).toBe('dockerfile')
    expect(languageForFile('dockerfile')).toBe('dockerfile')
    expect(languageForFile('Dockerfile.dev')).toBe('dockerfile')
  })

  it('does not claim to know Makefile syntax', () => {
    // Monaco ships no makefile grammar, and pretending otherwise would colour it
    // as something it is not.
    expect(languageForFile('makefile')).toBe('plaintext')
    expect(languageForFile('Makefile')).toBe('plaintext')
  })

  it('maps the TypeScript family onto one language id', () => {
    for (const name of ['a.ts', 'a.tsx', 'a.mts', 'a.cts']) {
      expect(languageForFile(name)).toBe('typescript')
    }
  })

  it('is case-insensitive about the extension', () => {
    expect(languageForFile('A.TS')).toBe('typescript')
    expect(languageForFile('Main.PY')).toBe('python')
  })

  it('falls back to plaintext for a name with no extension', () => {
    expect(languageForFile('README')).toBe('plaintext')
    expect(languageForFile('LICENSE')).toBe('plaintext')
  })

  it('falls back to plaintext for an extension it does not know', () => {
    expect(languageForFile('x.unknownext')).toBe('plaintext')
  })

  it('takes the last dot, so a versioned name is not misread', () => {
    expect(languageForFile('app.config.json')).toBe('json')
    expect(languageForFile('lib.v2.ts')).toBe('typescript')
  })
})
