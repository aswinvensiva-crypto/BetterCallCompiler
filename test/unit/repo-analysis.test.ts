import { describe, expect, it } from 'vitest'
import {
  colourForLanguage,
  evaluateRepoHealth,
  formatBytes,
  toLanguageSlices,
  type HealthInput
} from '../../src/renderer/views/repo-analysis'

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return { paths: [], readme: null, packageJson: null, ...overrides }
}

const check = (checks: ReturnType<typeof evaluateRepoHealth>, id: string) =>
  checks.find((c) => c.id === id)

describe('evaluateRepoHealth', () => {
  it('passes a well-kept repository on every check', () => {
    const checks = evaluateRepoHealth(
      input({
        paths: ['README.md', 'LICENSE', '.gitignore', '.github/workflows/ci.yml', 'src/a.ts'],
        readme: 'x'.repeat(500),
        packageJson: JSON.stringify({ scripts: { test: 'vitest run' } })
      })
    )
    expect(checks.every((c) => c.passed)).toBe(true)
  })

  it('fails a README that exists but is a stub', () => {
    const checks = evaluateRepoHealth(input({ paths: ['README.md'], readme: '# hi\n' }))
    const readme = check(checks, 'readme')
    expect(readme?.passed).toBe(false)
    // The reason has to be actionable, not just "failed".
    expect(readme?.detail).toMatch(/too short/i)
  })

  it("treats npm's placeholder test script as no test script", () => {
    // `npm init -y` writes exactly this; counting it as a pass is the precise
    // false positive this check exists to avoid.
    const checks = evaluateRepoHealth(
      input({
        packageJson: JSON.stringify({
          scripts: { test: 'echo "Error: no test specified" && exit 1' }
        })
      })
    )
    const test = check(checks, 'test-script')
    expect(test?.passed).toBe(false)
    expect(test?.detail).toMatch(/placeholder/i)
  })

  it('accepts a real test script', () => {
    const checks = evaluateRepoHealth(
      input({ packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }) })
    )
    expect(check(checks, 'test-script')?.passed).toBe(true)
  })

  it('does not throw on malformed package.json', () => {
    const checks = evaluateRepoHealth(input({ packageJson: '{ not json' }))
    const test = check(checks, 'test-script')
    expect(test?.passed).toBe(false)
    expect(test?.detail).toMatch(/not valid JSON/i)
  })

  it('recognises LICENSE in its several spellings', () => {
    for (const path of ['LICENSE', 'LICENSE.md', 'licence.txt', 'license']) {
      expect(check(evaluateRepoHealth(input({ paths: [path] })), 'license')?.passed).toBe(true)
    }
  })

  it('accepts both .yml and .yaml workflows, and only under .github/workflows', () => {
    expect(
      check(evaluateRepoHealth(input({ paths: ['.github/workflows/ci.yaml'] })), 'ci')?.passed
    ).toBe(true)
    // A yaml file elsewhere is not CI.
    expect(check(evaluateRepoHealth(input({ paths: ['config/ci.yml'] })), 'ci')?.passed).toBe(false)
  })

  it('reports every check on a completely empty workspace without throwing', () => {
    const checks = evaluateRepoHealth(input())
    expect(checks).toHaveLength(5)
    expect(checks.every((c) => !c.passed)).toBe(true)
    expect(checks.every((c) => c.detail.length > 0)).toBe(true)
  })
})

describe('toLanguageSlices', () => {
  it('computes percentages that sum to about 100', () => {
    const slices = toLanguageSlices(
      [
        { language: 'TypeScript', extension: 'ts', bytes: 750, files: 3 },
        { language: 'CSS', extension: 'css', bytes: 250, files: 1 }
      ],
      1000
    )
    expect(slices.map((s) => s.percent)).toEqual([75, 25])
  })

  it('returns nothing for a zero-byte workspace rather than dividing by zero', () => {
    expect(
      toLanguageSlices([{ language: 'TypeScript', extension: 'ts', bytes: 0, files: 0 }], 0)
    ).toEqual([])
  })
})

describe('presentation helpers', () => {
  it('gives a known language a stable colour and an unknown one a fallback', () => {
    expect(colourForLanguage('TypeScript', 0)).toBe(colourForLanguage('TypeScript', 5))
    expect(colourForLanguage('Brainfuck', 0)).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('scales byte counts to a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
