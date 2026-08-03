import type {
  ContributionCalendar,
  GithubInsights,
  LanguageBreakdown,
  RepositoryStats
} from '../../shared/types'
import { notifyError } from '../workbench/notifications'
import { emptyState } from '../workbench/side-bar'
import {
  colourForLanguage,
  evaluateRepoHealth,
  formatBytes,
  toLanguageSlices,
  type HealthCheck
} from './repo-analysis'

/**
 * GitHub insights.
 *
 * The view's one hard rule: it must never look the same whether it is showing
 * GitHub's answer or a local `git log` fallback. A degraded view that looks
 * healthy is worse than an empty one, because the user trusts a number that is
 * not what they think it is.
 */

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null
let insights: GithubInsights | null = null
let loading = false

/**
 * Locally-derived state, kept deliberately separate from `insights`.
 *
 * These sections come from the workspace and `git log`, so they are the parts
 * that still answer when there is no token, no remote and no network. They must
 * therefore render even when the GitHub half fails outright.
 */
let stats: RepositoryStats | null = null
let breakdown: LanguageBreakdown | null = null
let health: HealthCheck[] | null = null
let localLoading = false

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/* -------------------------------- calendar -------------------------------- */

/** GitHub's own five buckets. Anything else looks wrong beside github.com. */
function intensity(count: number, max: number): number {
  if (count <= 0) return 0
  if (max <= 0) return 1
  const ratio = count / max
  if (ratio > 0.66) return 4
  if (ratio > 0.33) return 3
  if (ratio > 0.12) return 2
  return 1
}

function renderCalendar(calendar: ContributionCalendar): HTMLElement {
  const wrap = el('div', 'calendar')

  const heading = el('div', 'calendar__heading')
  heading.append(
    el('span', 'calendar__total', `${calendar.totalContributions} contributions`),
    el('span', 'calendar__period', 'past year')
  )
  wrap.append(heading)

  const max = calendar.weeks
    .flat()
    .reduce((highest, day) => (day.count > highest ? day.count : highest), 0)

  // A CSS grid flowing down each column reproduces the 53×7 layout without
  // positioning every cell by hand.
  const grid = el('div', 'calendar__grid')
  grid.setAttribute('role', 'img')
  grid.setAttribute(
    'aria-label',
    `${calendar.totalContributions} contributions in the past year`
  )

  for (const week of calendar.weeks) {
    const column = el('div', 'calendar__week')
    for (const day of week) {
      const cell = el('span', `calendar__day calendar__day--${intensity(day.count, max)}`)
      cell.title = `${day.count} on ${day.date}`
      column.append(cell)
    }
    grid.append(column)
  }
  wrap.append(grid)

  const legend = el('div', 'calendar__legend')
  legend.append(el('span', 'calendar__legend-label', 'Less'))
  for (let level = 0; level <= 4; level += 1) {
    legend.append(el('span', `calendar__day calendar__day--${level}`))
  }
  legend.append(el('span', 'calendar__legend-label', 'More'))
  wrap.append(legend)

  return wrap
}

/* --------------------------------- render -------------------------------- */

function sourceBadge(value: GithubInsights): HTMLElement {
  const badge = el('span', `insights-badge insights-badge--${value.source}`)
  badge.textContent =
    value.source === 'github' ? 'github' : value.source === 'local' ? 'local git' : 'no data'
  badge.title =
    value.source === 'github'
      ? `Live from the GitHub API (token via ${value.tokenSource})`
      : 'Degraded: showing local git history'
  return badge
}

/* ------------------------- locally-computed sections ---------------------- */

function section(label: string, count?: string): { wrap: HTMLElement; header: HTMLElement } {
  const wrap = el('div', 'scm-section')
  const header = el('div', 'scm-section__header')
  header.append(el('span', 'scm-section__label', label))
  if (count !== undefined) header.append(el('span', 'scm-section__count', count))
  wrap.append(header)
  return { wrap, header }
}

function renderLanguages(value: LanguageBreakdown): HTMLElement {
  const slices = toLanguageSlices(value.languages, value.totalBytes)
  const { wrap } = section('Languages', formatBytes(value.totalBytes))

  if (slices.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No source files found.'))
    return wrap
  }

  // One stacked bar, GitHub-style, then a legend with the real numbers.
  const bar = el('div', 'langbar')
  slices.forEach((slice, index) => {
    const part = el('span', 'langbar__part')
    part.style.width = `${slice.percent}%`
    part.style.background = colourForLanguage(slice.language, index)
    part.title = `${slice.language} — ${slice.percent}% (${formatBytes(slice.bytes)})`
    bar.append(part)
  })
  wrap.append(bar)

  const legend = el('div', 'langlegend')
  slices.forEach((slice, index) => {
    const row = el('span', 'langlegend__item')
    const dot = el('span', 'langlegend__dot')
    dot.style.background = colourForLanguage(slice.language, index)
    row.append(dot)
    row.append(el('span', 'langlegend__name', slice.language))
    row.append(el('span', 'langlegend__percent', `${slice.percent}%`))
    legend.append(row)
  })
  wrap.append(legend)

  if (value.truncated) {
    wrap.append(
      el('p', 'insights-notice', 'Sampled: the workspace exceeded the file scan limit.')
    )
  }
  return wrap
}

function renderHealth(checks: readonly HealthCheck[]): HTMLElement {
  const passed = checks.filter((c) => c.passed).length
  const { wrap } = section('Repository health', `${passed}/${checks.length}`)

  for (const item of checks) {
    const row = el('div', `health-row${item.passed ? ' health-row--pass' : ''}`)
    row.append(el('span', 'health-row__mark', item.passed ? '✓' : '✗'))
    row.append(el('span', 'health-row__label', item.label))
    row.append(el('span', 'health-row__detail', item.detail))
    row.title = item.detail
    wrap.append(row)
  }
  return wrap
}

function renderCodeFrequency(value: RepositoryStats): HTMLElement {
  const weeks = value.codeFrequency.slice(-26)
  const { wrap } = section('Code frequency', `${weeks.length} wks`)

  if (weeks.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No commit history yet.'))
    return wrap
  }

  // Scaled against the busiest week so the shape is readable regardless of
  // whether this repo churns tens or tens of thousands of lines.
  const peak = Math.max(...weeks.map((w) => Math.max(w.added, w.deleted)), 1)
  const chart = el('div', 'freq')
  for (const week of weeks) {
    const column = el('div', 'freq__week')
    column.title = `${week.weekStart}: +${week.added} / −${week.deleted}`
    const added = el('span', 'freq__bar freq__bar--added')
    added.style.height = `${Math.round((week.added / peak) * 100)}%`
    const deleted = el('span', 'freq__bar freq__bar--deleted')
    deleted.style.height = `${Math.round((week.deleted / peak) * 100)}%`
    column.append(added, deleted)
    chart.append(column)
  }
  wrap.append(chart)
  return wrap
}

function renderChurn(value: RepositoryStats): HTMLElement {
  const top = value.churn.slice(0, 8)
  const { wrap } = section('Most-changed files', String(value.churn.length))

  if (top.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No file history yet.'))
    return wrap
  }

  const peak = Math.max(...top.map((f) => f.added + f.deleted), 1)
  for (const file of top) {
    const row = el('div', 'churn-row')
    row.title = `${file.path}\n${file.commits} commits, +${file.added} / −${file.deleted}`
    row.append(el('span', 'churn-row__path', file.path))
    const meter = el('span', 'churn-row__meter')
    const fill = el('span', 'churn-row__fill')
    fill.style.width = `${Math.round(((file.added + file.deleted) / peak) * 100)}%`
    meter.append(fill)
    row.append(meter)
    row.append(el('span', 'churn-row__count', String(file.commits)))
    wrap.append(row)
  }
  return wrap
}

function renderContributors(value: RepositoryStats): HTMLElement {
  const top = value.contributors.slice(0, 8)
  const { wrap } = section('Contributors', String(value.contributors.length))

  if (top.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No contributors yet.'))
    return wrap
  }

  for (const person of top) {
    const row = el('div', 'churn-row')
    row.title = `${person.name}: ${person.commits} commits, +${person.added} / −${person.deleted}`
    row.append(el('span', 'churn-row__path', person.name))
    row.append(el('span', 'churn-row__count', `${person.commits}`))
    wrap.append(row)
  }
  return wrap
}

/** Everything below the GitHub-backed sections, and independent of them. */
function appendLocalSections(host: HTMLElement): void {
  if (localLoading && breakdown === null && stats === null) {
    host.append(el('p', 'explorer__empty-text', 'Analysing workspace…'))
    return
  }
  if (breakdown !== null) host.append(renderLanguages(breakdown))
  if (health !== null) host.append(renderHealth(health))
  if (stats !== null && stats.isRepository) {
    host.append(renderCodeFrequency(stats))
    host.append(renderChurn(stats))
    host.append(renderContributors(stats))
  }
}

function render(): void {
  if (bodyHost === null || titleHost === null) return

  titleHost.replaceChildren()
  titleHost.append(el('span', 'side-bar__heading', 'Insights'))
  const actions = el('div', 'side-bar__actions')
  const refresh = el('button', 'icon-button')
  refresh.type = 'button'
  refresh.title = 'Refresh'
  refresh.setAttribute('aria-label', 'Refresh insights')
  refresh.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" ' +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  refresh.addEventListener('click', () => {
    void load(true)
    void loadLocal()
  })
  actions.append(refresh)
  titleHost.append(actions)

  bodyHost.replaceChildren()

  if (loading) {
    bodyHost.append(el('p', 'explorer__empty-text', 'Loading…'))
    return
  }

  if (insights === null) {
    bodyHost.append(emptyState('Insights are unavailable.', { label: 'Retry', run: () => void load(true) }))
    // The locally-computed sections do not depend on GitHub at all, so a failed
    // fetch must not blank them — that is the whole point of computing them here.
    appendLocalSections(bodyHost)
    return
  }

  const header = el('div', 'insights-header')
  header.append(sourceBadge(insights))
  if (insights.login !== null) header.append(el('span', 'insights-header__login', insights.login))
  bodyHost.append(header)

  // The notice is where every degradation is explained: no token, no remote, a
  // 401, a rate limit. It is never hidden behind a tooltip.
  if (insights.notice !== null) {
    bodyHost.append(el('p', 'insights-notice', insights.notice))
  }

  if (insights.calendar !== null) {
    bodyHost.append(renderCalendar(insights.calendar))
  }

  const commitsSection = el('div', 'scm-section')
  const commitsHeader = el('div', 'scm-section__header')
  commitsHeader.append(
    el('span', 'scm-section__label', insights.repository ?? 'Commits')
  )
  commitsHeader.append(el('span', 'scm-section__count', String(insights.commits.length)))
  commitsSection.append(commitsHeader)

  if (insights.commits.length === 0) {
    commitsSection.append(el('p', 'explorer__empty-text', 'No commits found.'))
  } else {
    for (const commit of insights.commits) {
      const row = el('div', 'scm-commit-row')
      row.title = `${commit.hash}\n${commit.author}\n${commit.date}`
      row.append(el('span', 'scm-commit-row__hash', commit.shortHash))
      row.append(el('span', 'scm-commit-row__message', commit.message))
      commitsSection.append(row)
    }
  }
  bodyHost.append(commitsSection)

  // Quota is a real operational concern once the calendar refreshes often.
  if (insights.rateLimit !== null) {
    const quota = el(
      'p',
      'insights-quota',
      `API quota ${insights.rateLimit.remaining}/${insights.rateLimit.limit}`
    )
    if (insights.rateLimit.resetAt !== null) {
      quota.title = `resets ${new Date(insights.rateLimit.resetAt).toLocaleTimeString()}`
    }
    bodyHost.append(quota)
  }

  appendLocalSections(bodyHost)
}

/* ---------------------------------- data --------------------------------- */

async function load(force: boolean): Promise<void> {
  loading = true
  render()

  const result = await window.betterCallCompiler.github.insights({ force })
  loading = false

  if (!result.ok) {
    insights = null
    notifyError(`Insights failed: ${result.error.message}`)
  } else {
    insights = result.value.insights
  }
  render()
}

/**
 * Loads the sections that need no token.
 *
 * Runs independently of `load()` so a GitHub failure — or the absence of any
 * remote at all — cannot take these down with it. The three requests are
 * concurrent because none depends on another.
 */
async function loadLocal(): Promise<void> {
  localLoading = true
  render()

  const [statsResult, breakdownResult, filesResult] = await Promise.all([
    window.betterCallCompiler.git.stats({}),
    window.betterCallCompiler.fs.languageBreakdown({}),
    window.betterCallCompiler.fs.listFiles({})
  ])

  stats = statsResult.ok ? statsResult.value.stats : null
  breakdown = breakdownResult.ok ? breakdownResult.value.breakdown : null

  if (filesResult.ok) {
    const files = filesResult.value.files
    const find = (predicate: (name: string) => boolean): string | null =>
      files.find((file) => predicate(file.name.toLowerCase()))?.path ?? null

    const readmePath = find((name) => name.startsWith('readme'))
    const packagePath = find((name) => name === 'package.json')

    const [readme, packageJson] = await Promise.all([
      readTextOrNull(readmePath),
      readTextOrNull(packagePath)
    ])

    health = evaluateRepoHealth({
      paths: files.map((file) => file.relativePath),
      readme,
      packageJson
    })
  } else {
    health = null
  }

  localLoading = false
  render()
}

async function readTextOrNull(path: string | null): Promise<string | null> {
  if (path === null) return null
  const result = await window.betterCallCompiler.fs.readFile({ path })
  return result.ok ? result.value.content : null
}

export async function mountInsights(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body
  // Served from the 10-minute cache on every visit after the first. The local
  // half is not awaited alongside it: the GitHub call can be slow, and there is
  // no reason for a token-free section to wait on a network round trip.
  void loadLocal()
  await load(false)
}

export function onInsightsShown(): void {
  if (insights === null && !loading) void load(false)
  if (stats === null && breakdown === null && !localLoading) void loadLocal()
}
