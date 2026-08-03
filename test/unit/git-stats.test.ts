import { describe, expect, it } from 'vitest'
import { parseNumstatLog } from '../../src/main/git-service'

/**
 * `parseNumstatLog` is pure, so it is tested against captured `git log
 * --numstat` output rather than a real repository. Every fixture below is a
 * shape git actually emits; the interesting cases are the ones that are easy to
 * get silently wrong (binary files, renames, commits that touch nothing).
 */

const MARKER = '@@@'

function commit(hash: string, author: string, iso: string, body: string[] = []): string {
  return [`${MARKER}${hash}|${author}|${iso}`, ...body].join('\n')
}

describe('parseNumstatLog', () => {
  it('aggregates code frequency into weeks starting on Sunday', () => {
    // 2026-08-05 is a Wednesday; its week starts Sunday 2026-08-02.
    const raw = [
      commit('a1', 'Ada', '2026-08-05T10:00:00+00:00', ['10\t2\tsrc/a.ts']),
      commit('a2', 'Ada', '2026-08-07T10:00:00+00:00', ['5\t1\tsrc/b.ts'])
    ].join('\n')

    const stats = parseNumstatLog(raw)

    expect(stats.codeFrequency).toEqual([{ weekStart: '2026-08-02', added: 15, deleted: 3 }])
  })

  it('sorts weeks oldest first', () => {
    const raw = [
      commit('c1', 'Ada', '2026-08-05T10:00:00+00:00', ['1\t0\tz.ts']),
      commit('c2', 'Ada', '2026-07-01T10:00:00+00:00', ['2\t0\ta.ts'])
    ].join('\n')

    const weeks = parseNumstatLog(raw).codeFrequency.map((w) => w.weekStart)
    expect(weeks).toEqual([...weeks].sort())
    expect(weeks[0]).toBe('2026-06-28')
  })

  it('counts a binary file as churn without producing NaN', () => {
    // git reports `-` for both counts on a binary blob.
    const raw = commit('b1', 'Ada', '2026-08-05T10:00:00+00:00', [
      '-\t-\tresources/icon.png',
      '4\t1\tsrc/a.ts'
    ])

    const stats = parseNumstatLog(raw)

    expect(stats.codeFrequency[0]?.added).toBe(4)
    expect(Number.isNaN(stats.codeFrequency[0]?.added ?? NaN)).toBe(false)
    // The binary file still registers as touched.
    expect(stats.churn.find((f) => f.path === 'resources/icon.png')).toEqual({
      path: 'resources/icon.png',
      commits: 1,
      added: 0,
      deleted: 0
    })
  })

  it('attributes a rename to the new path, in both spellings git uses', () => {
    const raw = [
      commit('r1', 'Ada', '2026-08-05T10:00:00+00:00', ['3\t1\told.ts => new.ts']),
      commit('r2', 'Ada', '2026-08-05T10:00:00+00:00', ['2\t0\tsrc/{a => b}/f.ts'])
    ].join('\n')

    const paths = parseNumstatLog(raw).churn.map((f) => f.path)

    expect(paths).toContain('new.ts')
    expect(paths).toContain('src/b/f.ts')
    expect(paths).not.toContain('old.ts => new.ts')
    expect(paths.some((p) => p.includes('=>'))).toBe(false)
  })

  it('ranks churn by total lines changed and caps the list', () => {
    const body: string[] = []
    for (let i = 0; i < 30; i++) body.push(`${i}\t${i}\tsrc/file-${i}.ts`)
    const stats = parseNumstatLog(commit('x', 'Ada', '2026-08-05T10:00:00+00:00', body))

    expect(stats.churn.length).toBe(20)
    expect(stats.churn[0]?.path).toBe('src/file-29.ts')
    const totals = stats.churn.map((f) => f.added + f.deleted)
    expect(totals).toEqual([...totals].sort((a, b) => b - a))
  })

  it('counts commits per author even when a commit changes no files', () => {
    const raw = [
      commit('e1', 'Ada', '2026-08-05T10:00:00+00:00'), // empty commit: header only
      commit('e2', 'Ada', '2026-08-05T10:00:00+00:00', ['1\t1\ta.ts']),
      commit('e3', 'Grace', '2026-08-05T10:00:00+00:00', ['7\t0\tb.ts'])
    ].join('\n')

    const stats = parseNumstatLog(raw)

    expect(stats.totalCommits).toBe(3)
    expect(stats.contributors).toEqual([
      { name: 'Ada', commits: 2, added: 1, deleted: 1 },
      { name: 'Grace', commits: 1, added: 7, deleted: 0 }
    ])
  })

  it('ranks contributors by commit count, most first', () => {
    const raw = [
      commit('p1', 'Solo', '2026-08-05T10:00:00+00:00', ['1\t0\ta.ts']),
      commit('p2', 'Busy', '2026-08-05T10:00:00+00:00', ['1\t0\tb.ts']),
      commit('p3', 'Busy', '2026-08-05T10:00:00+00:00', ['1\t0\tc.ts'])
    ].join('\n')

    expect(parseNumstatLog(raw).contributors.map((c) => c.name)).toEqual(['Busy', 'Solo'])
  })

  it('returns empty results for empty input rather than throwing', () => {
    expect(parseNumstatLog('')).toEqual({
      codeFrequency: [],
      churn: [],
      contributors: [],
      totalCommits: 0
    })
  })

  it('ignores malformed lines instead of corrupting the totals', () => {
    const raw = [
      commit('m1', 'Ada', '2026-08-05T10:00:00+00:00', [
        'not-a-numstat-line',
        'x\ty\tbroken.ts', // non-numeric counts
        '6\t2\tgood.ts'
      ])
    ].join('\n')

    const stats = parseNumstatLog(raw)

    expect(stats.churn).toEqual([{ path: 'good.ts', commits: 1, added: 6, deleted: 2 }])
    expect(stats.codeFrequency[0]).toEqual({ weekStart: '2026-08-02', added: 6, deleted: 2 })
  })

  it('survives an unparseable commit date without dropping the file churn', () => {
    const raw = commit('d1', 'Ada', 'not-a-date', ['4\t4\ta.ts'])
    const stats = parseNumstatLog(raw)

    // No week to attribute it to, but the file and author still count.
    expect(stats.codeFrequency).toEqual([])
    expect(stats.churn[0]?.path).toBe('a.ts')
    expect(stats.contributors[0]?.commits).toBe(1)
  })
})
