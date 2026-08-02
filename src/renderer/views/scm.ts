import { describeChange, type GitCommit, type GitFileChange, type GitStatus } from '../../shared/types'
import { showDiff } from '../editor/diff'
import { setBadge } from '../workbench/activity-bar'
import { notify, notifyError } from '../workbench/notifications'
import { emptyState } from '../workbench/side-bar'

/**
 * The source-control view.
 *
 * Reads real `git status` through simple-git in main; nothing here shells out.
 * The list is split the way git thinks about it — staged changes are what the
 * next commit will contain, everything else is not — because collapsing the two
 * is how users end up committing half of what they meant to.
 */

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null

let status: GitStatus = {
  isRepository: false,
  branch: null,
  tracking: null,
  ahead: 0,
  behind: 0,
  changes: []
}
let commits: GitCommit[] = []
let message = ''
let busy = false
/** Path currently shown in the diff editor, so the row can stay highlighted. */
let openDiffPath: string | null = null

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

/* --------------------------------- data ---------------------------------- */

/**
 * Cheap identity of what is on screen.
 *
 * The `.git` watch fires for reasons that change nothing the view shows — a
 * `git status` run in the terminal touches the index mtime, a fetch rewrites
 * refs. Re-rendering anyway replaces the DOM under the user's cursor, so a
 * hovered row's Stage button can vanish mid-click.
 */
let renderedSignature = ''

function signatureOf(): string {
  return JSON.stringify([
    status.isRepository,
    status.branch,
    status.ahead,
    status.behind,
    status.changes.map((change) => [change.path, change.indexStatus, change.workingStatus]),
    commits.map((commit) => commit.hash),
    openDiffPath,
    message,
    busy
  ])
}

export async function refresh(): Promise<void> {
  const result = await window.aperture.git.status({})
  if (!result.ok) {
    status = { isRepository: false, branch: null, tracking: null, ahead: 0, behind: 0, changes: [] }
    render()
    return
  }
  status = result.value.status
  setBadge('scm', status.changes.length)

  if (status.isRepository) {
    const history = await window.aperture.git.log({ limit: 50 })
    commits = history.ok ? history.value.commits : []
  } else {
    commits = []
  }

  if (signatureOf() === renderedSignature) return
  render()
}

/* ------------------------------- rendering ------------------------------- */

function iconButton(label: string, path: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'icon-button')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML =
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

function renderTitle(): void {
  if (titleHost === null) return
  titleHost.replaceChildren()

  const heading = el('span', 'side-bar__heading', 'Source Control')
  titleHost.append(heading)

  const actions = el('div', 'side-bar__actions')
  actions.append(
    iconButton('Refresh', 'M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3', () => void refresh())
  )
  titleHost.append(actions)
}

async function openDiff(change: GitFileChange, staged: boolean): Promise<void> {
  const result = await window.aperture.git.diff({ path: change.absolutePath, staged })
  if (!result.ok) {
    notifyError(`Could not diff ${change.path}: ${result.error.message}`)
    return
  }
  openDiffPath = change.path
  showDiff(result.value.diff)
  render()
}

function changeRow(change: GitFileChange, staged: boolean): HTMLElement {
  const row = el('div', 'scm-row')
  if (openDiffPath === change.path) row.classList.add('scm-row--selected')
  row.dataset['path'] = change.path
  row.title = change.path

  const name = change.path.slice(change.path.lastIndexOf('/') + 1)
  const directory = change.path.slice(0, change.path.length - name.length).replace(/\/$/, '')

  row.append(el('span', 'scm-row__name', name))
  if (directory !== '') row.append(el('span', 'scm-row__dir', directory))

  const actions = el('div', 'scm-row__actions')
  actions.append(
    staged
      ? iconButton('Unstage', 'M3 8h10', () => void stagePaths([change], false))
      : iconButton('Stage', 'M8 3v10M3 8h10', () => void stagePaths([change], true))
  )
  row.append(actions)

  const letter = describeChange(change)
  const badge = el('span', `scm-row__status scm-row__status--${letter.toLowerCase()}`, letter)
  badge.title = `index "${change.indexStatus}", working tree "${change.workingStatus}"`
  row.append(badge)

  row.addEventListener('click', () => void openDiff(change, staged))
  return row
}

function section(
  label: string,
  entries: readonly GitFileChange[],
  staged: boolean,
  action?: { label: string; icon: string; run: () => void }
): HTMLElement {
  const wrap = el('div', 'scm-section')

  const header = el('div', 'scm-section__header')
  header.append(el('span', 'scm-section__label', label))
  header.append(el('span', 'scm-section__count', String(entries.length)))
  if (action !== undefined) {
    header.append(iconButton(action.label, action.icon, action.run))
  }
  wrap.append(header)

  for (const change of entries) wrap.append(changeRow(change, staged))
  return wrap
}

function renderCommitBox(): HTMLElement {
  const wrap = el('div', 'scm-commit')

  const input = el('textarea', 'scm-commit__message')
  input.placeholder = status.branch === null ? 'Message' : `Message (commit on ${status.branch})`
  input.rows = 2
  input.value = message
  input.spellcheck = false
  input.addEventListener('input', () => {
    message = input.value
    button.disabled = !canCommit()
  })
  // Ctrl+Enter commits, matching VS Code.
  input.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void doCommit()
    }
  })
  wrap.append(input)

  const button = el('button', 'button button--primary scm-commit__button', 'Commit')
  button.type = 'button'
  button.disabled = !canCommit()
  button.addEventListener('click', () => void doCommit())
  wrap.append(button)

  return wrap
}

function canCommit(): boolean {
  return !busy && message.trim() !== '' && status.changes.some((change) => change.staged)
}

function renderHistory(): HTMLElement {
  const wrap = el('div', 'scm-section')
  const header = el('div', 'scm-section__header')
  header.append(el('span', 'scm-section__label', 'History'))
  header.append(el('span', 'scm-section__count', String(commits.length)))
  wrap.append(header)

  if (commits.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No commits yet.'))
    return wrap
  }

  for (const commit of commits) {
    const row = el('div', 'scm-commit-row')
    row.title = `${commit.hash}\n${commit.author}\n${commit.date}`
    row.append(el('span', 'scm-commit-row__hash', commit.shortHash))
    row.append(el('span', 'scm-commit-row__message', commit.message))
    wrap.append(row)
  }

  return wrap
}

function render(): void {
  if (bodyHost === null) return
  renderedSignature = signatureOf()
  renderTitle()
  bodyHost.replaceChildren()

  if (!status.isRepository) {
    bodyHost.append(
      emptyState('This folder is not a Git repository.')
    )
    setBadge('scm', 0)
    return
  }

  const staged = status.changes.filter((change) => change.staged)
  const unstaged = status.changes.filter((change) => change.unstaged)

  // Branch line: what a user checks before committing anything.
  const branch = el('div', 'scm-branch')
  branch.append(el('span', 'scm-branch__name', status.branch ?? 'no branch yet'))
  if (status.tracking !== null && (status.ahead > 0 || status.behind > 0)) {
    branch.append(el('span', 'scm-branch__sync', `↑${status.ahead} ↓${status.behind}`))
  }
  bodyHost.append(branch)

  bodyHost.append(renderCommitBox())

  if (staged.length > 0) {
    bodyHost.append(
      section('Staged Changes', staged, true, {
        label: 'Unstage All',
        icon: 'M3 8h10',
        run: () => void stagePaths(staged, false)
      })
    )
  }

  if (unstaged.length > 0) {
    bodyHost.append(
      section('Changes', unstaged, false, {
        label: 'Stage All',
        icon: 'M8 3v10M3 8h10',
        run: () => void stagePaths(unstaged, true)
      })
    )
  }

  if (staged.length === 0 && unstaged.length === 0) {
    bodyHost.append(el('p', 'explorer__empty-text scm-clean', 'No changes.'))
  }

  bodyHost.append(renderHistory())
}

/* -------------------------------- actions -------------------------------- */

async function stagePaths(changes: readonly GitFileChange[], stage: boolean): Promise<void> {
  const paths = changes.map((change) => change.absolutePath)
  if (paths.length === 0) return

  const result = stage
    ? await window.aperture.git.stage({ paths })
    : await window.aperture.git.unstage({ paths })

  if (!result.ok) {
    notifyError(result.error.message)
    return
  }
  await refresh()
}

async function doCommit(): Promise<void> {
  if (!canCommit()) return
  busy = true
  render()

  const result = await window.aperture.git.commit({ message })
  busy = false

  if (!result.ok) {
    notifyError(result.error.message)
    render()
    return
  }

  notify(`Committed ${result.value.commit.shortHash}`, 'info')
  message = ''
  await refresh()
}

/* --------------------------------- mount --------------------------------- */

export function clearDiffSelection(): void {
  if (openDiffPath === null) return
  openDiffPath = null
  render()
}

export async function mountScm(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body

  // A commit made in the terminal must show up here without the user hunting
  // for a refresh button.
  window.aperture.git.onChanged(() => void refresh())

  await refresh()
}

export function onScmShown(): void {
  void refresh()
}
