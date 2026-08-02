import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let window: Page

/**
 * Drives a real repository, not a mock. The whole value of the SCM view is that
 * it agrees with what `git` itself says, and only a real repo can prove that.
 */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: fixture, encoding: 'utf8', windowsHide: true })
}

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'aperture-scm-'))

  git('init', '-b', 'main')
  // Commit identity is repo-local so the suite never depends on, or touches,
  // the machine's global git config.
  git('config', 'user.email', 'aperture@example.com')
  git('config', 'user.name', 'Aperture Test')
  git('config', 'commit.gpgsign', 'false')

  await writeFile(join(fixture, 'tracked.txt'), 'original\n')
  git('add', 'tracked.txt')
  git('commit', '-m', 'Initial commit')

  // One modified tracked file and one untracked file: the two cases the view
  // has to keep apart.
  await writeFile(join(fixture, 'tracked.txt'), 'original\nmodified\n')
  await writeFile(join(fixture, 'fresh.txt'), 'brand new\n')

  app = await electron.launch({ args: [MAIN_ENTRY, `--folder=${fixture}`], cwd: APP_ROOT })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-aperture-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

async function openScm(): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="scm"]').click()
  await expect(window.locator('.side-bar__view[data-view-id="scm"]')).toBeVisible()
}

function row(name: string) {
  return window.locator('.scm-row', {
    has: window.locator(`.scm-row__name:text-is("${name}")`)
  })
}

test('the activity bar switches side-bar views', async () => {
  await expect(window.locator('.side-bar__view[data-view-id="explorer"]')).toBeVisible()

  await openScm()
  await expect(window.locator('.side-bar__view[data-view-id="explorer"]')).toBeHidden()
  await expect(window.locator('.side-bar__title-slot[data-view-id="scm"]')).toContainText(
    'Source Control'
  )

  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()
  await expect(window.locator('.side-bar__view[data-view-id="explorer"]')).toBeVisible()
})

test('shows the real branch and the real working-tree changes', async () => {
  await openScm()

  await expect(window.locator('.scm-branch__name')).toHaveText('main')

  // Both files, correctly classified: one modified, one untracked.
  await expect(row('tracked.txt')).toHaveCount(1)
  await expect(row('fresh.txt')).toHaveCount(1)
  await expect(row('tracked.txt').locator('.scm-row__status')).toHaveText('M')
  await expect(row('fresh.txt').locator('.scm-row__status')).toHaveText('U')

  // Nothing is staged yet, so there is no staged section at all.
  await expect(window.locator('.scm-section__label', { hasText: 'Staged Changes' })).toHaveCount(0)
})

test('the activity bar carries a badge with the change count', async () => {
  await expect(window.locator('.activity-bar__item[data-view-id="scm"] .activity-bar__badge')).toHaveText(
    '2'
  )
})

test('opens a diff in Monaco showing both revisions', async () => {
  await openScm()
  await row('tracked.txt').click()

  const diff = window.locator('#diff-surface')
  await expect(diff).toBeVisible()
  await expect(diff.locator('.diff-surface__title')).toContainText('tracked.txt')
  // Unstaged, so the comparison is index vs working tree.
  await expect(diff.locator('.diff-surface__title')).toContainText('Working tree')

  // Monaco's diff editor renders two editors; the added line is on the right.
  await expect(window.locator('#diff-body .monaco-diff-editor')).toBeVisible()
  await expect(window.locator('#diff-body')).toContainText('modified')

  await diff.locator('.icon-button[aria-label="Close diff"]').click()
  await expect(diff).toBeHidden()
})

test('stages a file, and the change moves to the staged section', async () => {
  await openScm()

  await row('tracked.txt').hover()
  await row('tracked.txt').locator('.icon-button[aria-label="Stage"]').click()

  const staged = window.locator('.scm-section', {
    has: window.locator('.scm-section__label:text-is("Staged Changes")')
  })
  await expect(staged).toBeVisible()
  await expect(staged.locator('.scm-row__name')).toHaveText('tracked.txt')

  // git itself must agree.
  expect(git('diff', '--cached', '--name-only')).toContain('tracked.txt')
})

test('unstages it again', async () => {
  await openScm()

  const staged = window.locator('.scm-section', {
    has: window.locator('.scm-section__label:text-is("Staged Changes")')
  })
  await staged.locator('.scm-row').first().hover()
  await staged.locator('.icon-button[aria-label="Unstage"]').first().click()

  await expect(window.locator('.scm-section__label', { hasText: 'Staged Changes' })).toHaveCount(0)
  expect(git('diff', '--cached', '--name-only').trim()).toBe('')
})

test('commits from the UI, and git records it', async () => {
  await openScm()

  // Commit is refused until something is staged.
  await expect(window.locator('.scm-commit__button')).toBeDisabled()

  await row('tracked.txt').hover()
  await row('tracked.txt').locator('.icon-button[aria-label="Stage"]').click()

  await window.locator('.scm-commit__message').fill('Change tracked.txt from the UI')
  await expect(window.locator('.scm-commit__button')).toBeEnabled()
  await window.locator('.scm-commit__button').click()

  // The history list picks it up...
  await expect(window.locator('.scm-commit-row__message').first()).toHaveText(
    'Change tracked.txt from the UI'
  )
  // ...and so does git.
  expect(git('log', '-1', '--pretty=%s').trim()).toBe('Change tracked.txt from the UI')

  // The message box is cleared so the next commit does not reuse it.
  await expect(window.locator('.scm-commit__message')).toHaveValue('')
})

test('picks up a commit made outside the app', async () => {
  await openScm()

  git('add', 'fresh.txt')
  git('commit', '-m', 'Committed from the terminal')

  // No refresh button pressed: the .git watch drives this.
  await expect(window.locator('.scm-commit-row__message').first()).toHaveText(
    'Committed from the terminal',
    { timeout: 15_000 }
  )
  await expect(window.locator('.scm-clean')).toBeVisible()
})
