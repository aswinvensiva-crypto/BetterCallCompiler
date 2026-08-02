import { describe, expect, it } from 'vitest'
import { parseRemote } from '../../src/main/git-service'
import { describeChange, gitStatusSchema, type GitFileChange } from '../../src/shared/types'

/**
 * The two pieces of git-service that are pure: the remote parser (shared with
 * the GitHub service, which is why it must not drift) and the porcelain
 * translation. Everything else drives a real `git` and belongs in E2E.
 */

describe('remote parsing', () => {
  it('handles the https form, with and without .git', () => {
    expect(parseRemote('https://github.com/octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world'
    })
    expect(parseRemote('https://github.com/octocat/hello-world')).toEqual({
      owner: 'octocat',
      repo: 'hello-world'
    })
  })

  it('handles the scp-style ssh form git actually writes', () => {
    expect(parseRemote('git@github.com:octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world'
    })
  })

  it('handles the ssh:// URL form', () => {
    expect(parseRemote('ssh://git@github.com/octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world'
    })
  })

  it('ignores credentials embedded in the URL', () => {
    expect(parseRemote('https://user:token@github.com/octocat/hello-world.git')).toEqual({
      owner: 'octocat',
      repo: 'hello-world'
    })
  })

  it('takes the last two segments on a self-hosted host with a path prefix', () => {
    expect(parseRemote('https://git.example.com/team/group/project.git')).toEqual({
      owner: 'group',
      repo: 'project'
    })
  })

  it('tolerates trailing slashes and whitespace', () => {
    expect(parseRemote('  https://github.com/octocat/hello-world/  ')).toEqual({
      owner: 'octocat',
      repo: 'hello-world'
    })
  })

  it('returns null for anything that is not owner/repo', () => {
    expect(parseRemote('')).toBeNull()
    expect(parseRemote('https://github.com/octocat')).toBeNull()
    expect(parseRemote('not a url')).toBeNull()
  })
})

describe('porcelain translation', () => {
  function change(overrides: Partial<GitFileChange>): GitFileChange {
    return {
      path: 'src/a.ts',
      absolutePath: 'C:\\work\\src\\a.ts',
      indexStatus: ' ',
      workingStatus: 'M',
      staged: false,
      unstaged: true,
      untracked: false,
      conflicted: false,
      ...overrides
    }
  }

  it('shows the working-tree letter for an unstaged change', () => {
    expect(describeChange(change({ workingStatus: 'M' }))).toBe('M')
    expect(describeChange(change({ workingStatus: 'D' }))).toBe('D')
  })

  // A staged file's interesting status is what the *index* holds, not what the
  // working tree happens to say — showing the latter mislabels `git add` of a
  // new file as unmodified.
  it('shows the index letter for a staged change', () => {
    expect(
      describeChange(change({ indexStatus: 'A', workingStatus: ' ', staged: true, unstaged: false }))
    ).toBe('A')
  })

  it('marks untracked and conflicted distinctly', () => {
    expect(describeChange(change({ untracked: true, indexStatus: '?', workingStatus: '?' }))).toBe(
      'U'
    )
    expect(describeChange(change({ conflicted: true, indexStatus: 'U', workingStatus: 'U' }))).toBe(
      'C'
    )
  })
})

describe('the status contract', () => {
  it('allows a null branch, which is what an unborn HEAD reports', () => {
    const parsed = gitStatusSchema.safeParse({
      isRepository: true,
      branch: null,
      tracking: null,
      ahead: 0,
      behind: 0,
      changes: []
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a status missing its change list rather than defaulting it', () => {
    const parsed = gitStatusSchema.safeParse({
      isRepository: true,
      branch: 'main',
      tracking: null,
      ahead: 0,
      behind: 0
    })
    expect(parsed.success).toBe(false)
  })
})
