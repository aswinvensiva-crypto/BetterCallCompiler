import { describe, expect, it } from 'vitest'
import { extractAgentSummary, normalizeAgentPath, parseAgentPlan } from '../../src/shared/agent-plan'

describe('parseAgentPlan', () => {
  it('extracts one file from a single block', () => {
    const answer = ['### FILE: src/a.ts', '```ts', 'export const a = 1', '```'].join('\n')
    expect(parseAgentPlan(answer)).toEqual([{ path: 'src/a.ts', content: 'export const a = 1' }])
  })

  it('extracts every file across several blocks, in order', () => {
    const answer = [
      'Renaming across the call sites.',
      '',
      '### FILE: src/a.ts',
      '```ts',
      'export function loadConfig() {}',
      '```',
      '### FILE: src/b.ts',
      '```ts',
      "import { loadConfig } from './a'",
      '```'
    ].join('\n')

    expect(parseAgentPlan(answer)).toEqual([
      { path: 'src/a.ts', content: 'export function loadConfig() {}' },
      { path: 'src/b.ts', content: "import { loadConfig } from './a'" }
    ])
  })

  it('keeps interior blank lines inside a file block', () => {
    const answer = ['### FILE: src/a.ts', '```', 'a', '', 'b', '```'].join('\n')
    expect(parseAgentPlan(answer)[0]?.content).toBe('a\n\nb')
  })

  it('keeps only the last block for a duplicated path', () => {
    const answer = [
      '### FILE: src/a.ts',
      '```',
      'draft',
      '```',
      '### FILE: src/a.ts',
      '```',
      'final',
      '```'
    ].join('\n')

    const plan = parseAgentPlan(answer)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toEqual({ path: 'src/a.ts', content: 'final' })
  })

  it('drops a marker whose fence never closes — a still-streaming answer', () => {
    const answer = ['### FILE: src/a.ts', '```ts', 'export const a = 1'].join('\n')
    expect(parseAgentPlan(answer)).toEqual([])
  })

  it('returns nothing for an answer with no file markers', () => {
    expect(parseAgentPlan('No changes needed.')).toEqual([])
  })

  it('drops a marker naming an unsafe path', () => {
    const answer = ['### FILE: ../../etc/passwd', '```', 'x', '```'].join('\n')
    expect(parseAgentPlan(answer)).toEqual([])
  })
})

describe('extractAgentSummary', () => {
  it('returns the prose before the first marker', () => {
    const answer = ['Plan: rename the function.', '', '### FILE: a.ts', '```', 'x', '```'].join('\n')
    expect(extractAgentSummary(answer)).toBe('Plan: rename the function.')
  })

  it('returns the whole trimmed answer when there is no marker', () => {
    expect(extractAgentSummary('  nothing to change  ')).toBe('nothing to change')
  })

  it('is empty when the answer opens directly with a marker', () => {
    const answer = ['### FILE: a.ts', '```', 'x', '```'].join('\n')
    expect(extractAgentSummary(answer)).toBe('')
  })
})

describe('normalizeAgentPath', () => {
  it('accepts a plain relative path', () => {
    expect(normalizeAgentPath('src/main/foo.ts')).toBe('src/main/foo.ts')
  })

  it('normalises backslashes to forward slashes', () => {
    expect(normalizeAgentPath('src\\main\\foo.ts')).toBe('src/main/foo.ts')
  })

  it('strips surrounding quotes and backticks the model sometimes adds', () => {
    expect(normalizeAgentPath('`src/a.ts`')).toBe('src/a.ts')
    expect(normalizeAgentPath('"src/a.ts"')).toBe('src/a.ts')
  })

  it('rejects an absolute path', () => {
    expect(normalizeAgentPath('/etc/passwd')).toBeNull()
  })

  it('rejects a Windows drive path', () => {
    expect(normalizeAgentPath('C:\\Windows\\System32\\config')).toBeNull()
  })

  it('rejects any path with a .. segment', () => {
    expect(normalizeAgentPath('src/../../../etc/passwd')).toBeNull()
    expect(normalizeAgentPath('../escape.ts')).toBeNull()
  })

  it('rejects an empty path', () => {
    expect(normalizeAgentPath('')).toBeNull()
    expect(normalizeAgentPath('   ')).toBeNull()
  })
})
