import { Octokit } from '@octokit/rest'
import { graphql } from '@octokit/graphql'
import type { ContributionCalendar, GitCommit, GithubInsights, RateLimit } from '../shared/types'
import { log as gitLog, originRepository } from './git-service'
import { readSecret } from './secrets'
import { findOnPath, spawnExecutable } from './toolchains'
import { loadSettings } from './settings'

/**
 * GitHub insights.
 *
 * All network access lives here, in main. The renderer's CSP is
 * `connect-src 'none'` — it could not reach github.com if it tried, which is
 * the point: the token never leaves this process.
 */

/* ------------------------------------------------------------------ *
 * Token discovery
 * ------------------------------------------------------------------ */

export type TokenSource = 'gh-cli' | 'settings' | 'none'

interface ResolvedToken {
  readonly token: string | null
  readonly source: TokenSource
}

/**
 * Asks the GitHub CLI for its token.
 *
 * Preferred over a stored PAT because it is the credential the user already
 * maintains — it rotates, it has the scopes `gh` negotiated, and we never have
 * to store it. Never prompts: `gh auth token` either answers immediately or
 * exits non-zero, and a hung prompt inside the main process would freeze the
 * window.
 */
async function tokenFromGhCli(): Promise<string | null> {
  const gh = findOnPath('gh')
  if (gh === null) return null

  return await new Promise<string | null>((resolve) => {
    let stdout = ''
    let child
    try {
      child = spawnExecutable(gh, ['auth', 'token'])
    } catch {
      resolve(null)
      return
    }

    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, 3000)

    const settle = (value: string | null): void => {
      clearTimeout(timer)
      resolve(value)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => settle(null))
    child.on('close', (code) => {
      const token = stdout.trim()
      settle(code === 0 && token !== '' ? token : null)
    })
  })
}

/** Order is locked by the spec: gh CLI first, then a PAT from Settings. */
export async function resolveToken(): Promise<ResolvedToken> {
  const fromCli = await tokenFromGhCli()
  if (fromCli !== null) return { token: fromCli, source: 'gh-cli' }

  const stored = await readSecret('github')
  if (stored !== null && stored !== '') return { token: stored, source: 'settings' }

  return { token: null, source: 'none' }
}

/* ------------------------------------------------------------------ *
 * GraphQL: the contribution calendar
 * ------------------------------------------------------------------ */

/**
 * The calendar is GraphQL-only. There is no REST endpoint for it — the
 * often-cited `/users/:user/events` is a 90-day activity feed, not the
 * contribution graph, and building the grid from it produces a chart that
 * disagrees with the one on github.com.
 */
const CALENDAR_QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { date contributionCount }
          }
        }
      }
    }
  }
`

interface CalendarResponse {
  user: {
    contributionsCollection: {
      contributionCalendar: {
        totalContributions: number
        weeks: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }>
      }
    }
  } | null
}

async function fetchCalendar(token: string, login: string): Promise<ContributionCalendar | null> {
  const response = await graphql<CalendarResponse>(CALENDAR_QUERY, {
    login,
    headers: { authorization: `token ${token}` }
  })

  const calendar = response.user?.contributionsCollection.contributionCalendar
  if (calendar === undefined) return null

  return {
    totalContributions: calendar.totalContributions,
    weeks: calendar.weeks.map((week) =>
      week.contributionDays.map((day) => ({ date: day.date, count: day.contributionCount }))
    )
  }
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

/** Locked by the spec. The calendar changes at most once per push. */
const CACHE_TTL_MS = 10 * 60 * 1000

interface CacheEntry {
  readonly key: string
  readonly at: number
  readonly value: GithubInsights
}

let cache: CacheEntry | null = null

function cacheKey(repository: string | null, login: string | null): string {
  return `${repository ?? '-'}::${login ?? '-'}`
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Octokit puts the HTTP status on the error; map the two that mean
    // something specific to the user rather than showing a raw 401.
    const status = (error as { status?: number }).status
    if (status === 401) return 'GitHub rejected the token (401). Check it in Settings.'
    if (status === 403) return 'GitHub rate limit or scope problem (403).'
    if (status === 404) return 'GitHub returned 404 — the repository may be private or renamed.'
    return error.message
  }
  return 'unknown error'
}

/** Local `git log`, mapped into the same shape the REST commits use. */
async function localCommits(): Promise<GitCommit[]> {
  try {
    return await gitLog(50)
  } catch {
    return []
  }
}

export async function fetchInsights(force = false): Promise<GithubInsights> {
  const origin = await originRepository()
  const repository = origin === null ? null : `${origin.owner}/${origin.repo}`
  const settings = await loadSettings()

  const { token, source: tokenSource } = await resolveToken()

  // Resolve the login before checking the cache: whose calendar we show can
  // change when the user edits Settings without the repository changing.
  let login: string | null = settings.githubUser.trim() === '' ? null : settings.githubUser.trim()
  let rateLimit: RateLimit | null = null
  let notice: string | null = null

  const key = cacheKey(repository, login ?? (token === null ? null : 'viewer'))
  if (!force && cache !== null && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value
  }

  // No token at all: degrade to local history rather than showing an empty view.
  if (token === null) {
    const value: GithubInsights = {
      source: repository === null && (await localCommits()).length === 0 ? 'none' : 'local',
      tokenSource: 'none',
      login,
      repository,
      calendar: null,
      commits: await localCommits(),
      rateLimit: null,
      notice:
        'No GitHub token. Showing local git history. Sign in with the GitHub CLI, ' +
        'or add a personal access token in Settings, to see your contribution calendar.',
      fetchedAt: new Date().toISOString()
    }
    cache = { key, at: Date.now(), value }
    return value
  }

  const octokit = new Octokit({ auth: token })

  // Whose calendar? An explicit setting wins; otherwise the token's own user.
  if (login === null) {
    try {
      const viewer = await octokit.rest.users.getAuthenticated()
      login = viewer.data.login
    } catch (error) {
      notice = describeError(error)
    }
  }

  let calendar: ContributionCalendar | null = null
  if (login !== null) {
    try {
      calendar = await fetchCalendar(token, login)
    } catch (error) {
      notice = notice ?? describeError(error)
    }
  }

  let commits: GitCommit[] = []
  let source: GithubInsights['source'] = 'github'

  if (origin !== null) {
    try {
      const response = await octokit.rest.repos.listCommits({
        owner: origin.owner,
        repo: origin.repo,
        per_page: 50
      })
      commits = response.data.map((entry) => ({
        hash: entry.sha,
        shortHash: entry.sha.slice(0, 7),
        message: (entry.commit.message ?? '').split('\n')[0] ?? '',
        author: entry.commit.author?.name ?? entry.author?.login ?? '',
        date: entry.commit.author?.date ?? '',
        refs: ''
      }))
    } catch (error) {
      notice = notice ?? describeError(error)
      commits = await localCommits()
      source = 'local'
    }
  } else {
    // No remote to ask about. Local history is the honest answer.
    commits = await localCommits()
    source = calendar === null ? 'local' : 'github'
    notice =
      notice ?? 'This folder has no `origin` remote, so commits come from local git history.'
  }

  try {
    const limits = await octokit.rest.rateLimit.get()
    const core = limits.data.resources.core
    rateLimit = {
      remaining: core.remaining,
      limit: core.limit,
      resetAt: new Date(core.reset * 1000).toISOString()
    }
  } catch {
    // A missing quota readout is cosmetic; never fail the view for it.
    rateLimit = null
  }

  const value: GithubInsights = {
    source,
    tokenSource,
    login,
    repository,
    calendar,
    commits,
    rateLimit,
    notice,
    fetchedAt: new Date().toISOString()
  }

  cache = { key, at: Date.now(), value }
  return value
}

/** Test hook, and what the view's Refresh button uses. */
export function clearInsightsCache(): void {
  cache = null
}
