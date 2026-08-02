import type { ContributionCalendar, GithubInsights } from '../../shared/types'
import { notifyError } from '../workbench/notifications'
import { emptyState } from '../workbench/side-bar'

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
  refresh.addEventListener('click', () => void load(true))
  actions.append(refresh)
  titleHost.append(actions)

  bodyHost.replaceChildren()

  if (loading) {
    bodyHost.append(el('p', 'explorer__empty-text', 'Loading…'))
    return
  }

  if (insights === null) {
    bodyHost.append(emptyState('Insights are unavailable.', { label: 'Retry', run: () => void load(true) }))
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
}

/* ---------------------------------- data --------------------------------- */

async function load(force: boolean): Promise<void> {
  loading = true
  render()

  const result = await window.aperture.github.insights({ force })
  loading = false

  if (!result.ok) {
    insights = null
    notifyError(`Insights failed: ${result.error.message}`)
  } else {
    insights = result.value.insights
  }
  render()
}

export async function mountInsights(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body
  // Served from the 10-minute cache on every visit after the first.
  await load(false)
}

export function onInsightsShown(): void {
  if (insights === null && !loading) void load(false)
}
