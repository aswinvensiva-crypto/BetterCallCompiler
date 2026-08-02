import { simpleGit, type SimpleGit } from 'simple-git'
import { watch, type FSWatcher } from 'chokidar'
import { join, relative, sep } from 'node:path'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import type {
  GitBranches,
  GitCommit,
  GitFileChange,
  GitFileDiff,
  GitStatus
} from '../shared/types'
import { confinePath, getWorkspace } from './fs-service'

/**
 * simple-git wrapper.
 *
 * Every entry point re-reads the workspace root rather than caching a client,
 * because the user can open a different folder at any time and a stale client
 * would quietly report the previous repository's status.
 */

let client: SimpleGit | null = null
let clientRoot: string | null = null

function gitFor(root: string): SimpleGit {
  if (client === null || clientRoot !== root) {
    client = simpleGit({ baseDir: root, maxConcurrentProcesses: 4 })
    clientRoot = root
  }
  return client
}

function requireRoot(): string {
  const root = getWorkspace().root
  if (root === null) {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'no folder is open')
  }
  return root
}

/** Git speaks POSIX paths everywhere, including on Windows. */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

export async function isRepository(): Promise<boolean> {
  const root = getWorkspace().root
  if (root === null) return false
  try {
    // `false` restricts the check to this directory rather than walking up: a
    // folder inside some unrelated repository is not "a repository we opened".
    return await gitFor(root).checkIsRepo('root' as never)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/**
 * simple-git reports index and working-tree state as two separate porcelain
 * characters, exactly as `git status --porcelain` does. Translating them here —
 * rather than in the renderer — keeps the meaning of `' '`, `'?'` and `'R'` in
 * one place.
 */
function toChange(root: string, entry: { path: string; index: string; working_dir: string }): GitFileChange {
  const indexStatus = entry.index === '' ? ' ' : entry.index
  const workingStatus = entry.working_dir === '' ? ' ' : entry.working_dir
  const untracked = indexStatus === '?' || workingStatus === '?'

  return {
    path: toPosix(entry.path),
    absolutePath: join(root, entry.path),
    indexStatus,
    workingStatus,
    // An untracked file is never "staged", whatever the porcelain says.
    staged: !untracked && indexStatus !== ' ',
    unstaged: untracked || workingStatus !== ' ',
    untracked,
    conflicted: indexStatus === 'U' || workingStatus === 'U'
  }
}

export async function status(): Promise<GitStatus> {
  const root = requireRoot()
  if (!(await isRepository())) {
    return {
      isRepository: false,
      branch: null,
      tracking: null,
      ahead: 0,
      behind: 0,
      changes: []
    }
  }

  const result = await gitFor(root).status()

  return {
    isRepository: true,
    // `current` is null on an unborn branch (a repo with no commits yet).
    branch: result.current,
    tracking: result.tracking,
    ahead: result.ahead,
    behind: result.behind,
    changes: result.files.map((file) => toChange(root, file))
  }
}

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

/**
 * Reads a blob at a revision, or `''` when it does not exist there.
 *
 * A file added in the working tree has no HEAD version, and `git show` exits
 * non-zero for it. That is the normal case for a new file, not an error, so it
 * becomes an empty "before" side rather than a failed request.
 */
async function showBlob(git: SimpleGit, revision: string): Promise<string> {
  try {
    return await git.raw(['show', revision])
  } catch {
    return ''
  }
}

/**
 * The two sides of a diff, as text for Monaco's `DiffEditor`.
 *
 * Which two sides depends on what the user clicked, and getting this wrong is
 * the classic SCM bug — showing HEAD vs working tree for a staged file hides
 * the fact that some of the change is already staged:
 *
 *   staged   → HEAD  vs index    (what the commit will contain)
 *   unstaged → index vs worktree (what staging would add)
 *   untracked→ empty vs worktree (all of it is new)
 */
export async function diff(requestedPath: string, staged: boolean): Promise<GitFileDiff> {
  const root = requireRoot()
  const absolute = await confinePath(root, requestedPath)
  const relativePath = toPosix(relative(root, absolute))
  const git = gitFor(root)

  const changes = (await status()).changes
  const change = changes.find((candidate) => candidate.path === relativePath) ?? null
  const untracked = change?.untracked ?? false

  if (untracked) {
    return {
      path: relativePath,
      original: '',
      modified: await readWorkingCopy(absolute),
      originalLabel: 'Untracked',
      modifiedLabel: 'Working tree'
    }
  }

  if (staged) {
    return {
      path: relativePath,
      original: await showBlob(git, `HEAD:${relativePath}`),
      modified: await showBlob(git, `:${relativePath}`),
      originalLabel: 'HEAD',
      modifiedLabel: 'Staged'
    }
  }

  return {
    path: relativePath,
    original: await showBlob(git, `:${relativePath}`),
    modified: await readWorkingCopy(absolute),
    originalLabel: 'Staged',
    modifiedLabel: 'Working tree'
  }
}

async function readWorkingCopy(absolute: string): Promise<string> {
  const { promises: fsp } = await import('node:fs')
  try {
    return await fsp.readFile(absolute, 'utf8')
  } catch {
    // Deleted in the working tree: the "after" side is genuinely empty.
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * Staging and committing
 * ------------------------------------------------------------------ */

/** Confines every path before it reaches git, exactly as the fs service does. */
async function confineAll(root: string, paths: readonly string[]): Promise<string[]> {
  const resolved: string[] = []
  for (const path of paths) {
    const absolute = await confinePath(root, path)
    resolved.push(toPosix(relative(root, absolute)))
  }
  return resolved
}

export async function stage(paths: readonly string[]): Promise<void> {
  const root = requireRoot()
  const targets = await confineAll(root, paths)
  if (targets.length === 0) return
  await gitFor(root).add(targets)
}

export async function unstage(paths: readonly string[]): Promise<void> {
  const root = requireRoot()
  const targets = await confineAll(root, paths)
  if (targets.length === 0) return

  try {
    await gitFor(root).reset(['--', ...targets])
  } catch (error) {
    // `git reset` fails on a repository with no commits — there is no HEAD to
    // reset against. `rm --cached` is the equivalent there.
    try {
      await gitFor(root).raw(['rm', '--cached', '-r', '--', ...targets])
    } catch {
      throw new BetterCallCompilerServiceError(
        'IO_ERROR',
        `could not unstage: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    }
  }
}

export async function commit(message: string): Promise<GitCommit> {
  const root = requireRoot()
  const trimmed = message.trim()
  if (trimmed === '') {
    throw new BetterCallCompilerServiceError('BAD_REQUEST', 'a commit needs a message')
  }

  const current = await status()
  if (!current.changes.some((change) => change.staged)) {
    throw new BetterCallCompilerServiceError('BAD_REQUEST', 'nothing is staged')
  }

  let result
  try {
    result = await gitFor(root).commit(trimmed)
  } catch (error) {
    // Missing user.name/user.email is the overwhelmingly common failure here,
    // and git's own message already says exactly what to run.
    throw new BetterCallCompilerServiceError(
      'IO_ERROR',
      error instanceof Error ? error.message : 'commit failed'
    )
  }

  return {
    hash: result.commit,
    shortHash: result.commit.slice(0, 7),
    message: trimmed.split('\n')[0] ?? trimmed,
    author: '',
    date: new Date().toISOString(),
    refs: ''
  }
}

/* ------------------------------------------------------------------ *
 * Branches and history
 * ------------------------------------------------------------------ */

export async function branches(): Promise<GitBranches> {
  const root = requireRoot()
  if (!(await isRepository())) return { current: null, all: [] }

  try {
    const summary = await gitFor(root).branch(['--list'])
    return { current: summary.current === '' ? null : summary.current, all: summary.all }
  } catch {
    return { current: null, all: [] }
  }
}

export async function log(limit = 50): Promise<GitCommit[]> {
  const root = requireRoot()
  if (!(await isRepository())) return []

  try {
    const result = await gitFor(root).log({ maxCount: limit })
    return result.all.map((entry) => ({
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      message: entry.message,
      author: entry.author_name,
      date: entry.date,
      refs: entry.refs
    }))
  } catch {
    // A repository with no commits has no log; that is not an error.
    return []
  }
}

/**
 * `owner/repo` parsed from the `origin` remote, or null.
 *
 * Shared with the GitHub service (step 9), which needs the same parse and must
 * not grow its own subtly different copy.
 */
export async function originRepository(): Promise<{ owner: string; repo: string } | null> {
  const root = getWorkspace().root
  if (root === null) return null

  let url: string | undefined
  try {
    const remotes = await gitFor(root).getRemotes(true)
    url = remotes.find((remote) => remote.name === 'origin')?.refs.fetch
  } catch {
    return null
  }
  if (url === undefined || url === '') return null

  return parseRemote(url)
}

/**
 * Handles both remote spellings git actually produces:
 * `https://github.com/owner/repo.git` and `git@github.com:owner/repo.git`.
 * Exported for the unit tests.
 */
export function parseRemote(url: string): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/, '').replace(/\/+$/, '')

  const ssh = /^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/](.+)$/.exec(cleaned)
  const https = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/.exec(cleaned)
  const match = https ?? ssh
  if (match === null) return null

  const parts = (match[2] ?? '').split('/').filter((part) => part !== '')
  if (parts.length < 2) return null

  const repo = parts[parts.length - 1]
  const owner = parts[parts.length - 2]
  if (owner === undefined || repo === undefined) return null

  return { owner, repo }
}

/* ------------------------------------------------------------------ *
 * Watching .git
 * ------------------------------------------------------------------ */

let gitWatcher: FSWatcher | null = null
let emitChanged: (() => void) | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null

export function setGitChangeEmitter(emit: () => void): void {
  emitChanged = emit
}

/**
 * Watches `.git/` for the files that actually mean "the repository moved":
 * HEAD, the index, and the refs. Watching the whole directory would fire
 * hundreds of times during a fetch as pack files land, and watching nothing
 * would leave the view stale after a commit made in the terminal.
 */
export async function startGitWatch(root: string): Promise<void> {
  await stopGitWatch()

  const gitDir = join(root, '.git')
  gitWatcher = watch(gitDir, {
    ignoreInitial: true,
    depth: 3,
    ignored: (target: string) =>
      /[\\/](objects|lfs|modules)[\\/]/.test(target) || target.endsWith('.lock'),
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 }
  })

  const bump = (): void => {
    if (notifyTimer !== null) clearTimeout(notifyTimer)
    // A single `git commit` touches HEAD, the index and a ref; coalesce.
    notifyTimer = setTimeout(() => {
      notifyTimer = null
      emitChanged?.()
    }, 150)
  }

  gitWatcher.on('add', bump)
  gitWatcher.on('change', bump)
  gitWatcher.on('unlink', bump)
  gitWatcher.on('error', () => undefined)
}

export async function stopGitWatch(): Promise<void> {
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer)
    notifyTimer = null
  }
  if (gitWatcher === null) return
  const current = gitWatcher
  gitWatcher = null
  await current.close()
}

/** Test hook: drop the cached client between cases. */
export function resetGitForTests(): void {
  client = null
  clientRoot = null
}
