import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let userData = ''
let app: ElectronApplication
let window: Page

/**
 * Insights against a repository with local history and no GitHub token.
 *
 * That is the degraded path, and it is the one worth guarding: the acceptance
 * criterion is that the view "degrades to local `git log` without a token", and
 * a degraded view that looks healthy is worse than an empty one.
 *
 * `--user-data-dir` keeps any stored token out of the real profile of whoever
 * runs the suite.
 */
/**
 * Launch environment with the GitHub CLI removed from PATH.
 *
 * `--user-data-dir` isolates a *stored* PAT, but `resolveToken()` asks the `gh`
 * CLI first, so on a machine where `gh` is authenticated this suite took the
 * healthy path and never exercised the degradation it exists to guard — it
 * failed asserting "No GitHub token" while the app was, correctly, showing real
 * data. Dropping gh from PATH makes the degraded path deterministic on every
 * machine without adding a test-only backdoor to production code.
 *
 * The PATH key is rebuilt rather than overridden: Windows environment variables
 * are case-insensitive, so spreading `process.env` (which may carry `Path`) and
 * then setting `PATH` would leave two competing entries.
 */
function envWithoutGhCli(): Record<string, string> {
  const ghExecutable = process.platform === 'win32' ? 'gh.exe' : 'gh'

  // Playwright's `env` takes Record<string, string>; `process.env` values are
  // `string | undefined`, so unset keys are dropped rather than passed through.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() !== 'PATH') env[key] = value
  }

  env['PATH'] = (process.env['PATH'] ?? process.env['Path'] ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && !existsSync(join(dir, ghExecutable)))
    .join(delimiter)

  return env
}

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bettercallcompiler-insights-'))
  userData = await mkdtemp(join(tmpdir(), 'bettercallcompiler-insights-profile-'))

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: fixture, encoding: 'utf8', windowsHide: true })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'bettercallcompiler@example.com')
  git('config', 'user.name', 'BetterCallCompiler Test')
  git('config', 'commit.gpgsign', 'false')
  await writeFile(join(fixture, 'readme.md'), '# fixture\n')
  git('add', 'readme.md')
  git('commit', '-m', 'Local history only')

  app = await electron.launch({
    args: [MAIN_ENTRY, `--folder=${fixture}`, `--user-data-dir=${userData}`],
    cwd: APP_ROOT,
    env: envWithoutGhCli()
  })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [fixture, userData]) {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  }
})

async function openView(id: string): Promise<void> {
  await window.locator(`.activity-bar__item[data-view-id="${id}"]`).click()
  await expect(window.locator(`.side-bar__view[data-view-id="${id}"]`)).toBeVisible()
}

test('degrades to local git history with no token, and says so', async () => {
  await openView('insights')

  const badge = window.locator('.insights-badge')
  await expect(badge).toBeVisible({ timeout: 20_000 })

  // No `gh` on the machine and no PAT stored, so the honest answer is local.
  await expect(badge).toHaveText('local git')

  // Degradation is stated, never implied by an empty panel.
  await expect(window.locator('.insights-notice')).toContainText('No GitHub token')

  // The local commit really is listed.
  await expect(window.locator('.scm-commit-row__message').first()).toHaveText('Local history only')

  // And no calendar is drawn, because there is no data for one.
  await expect(window.locator('.calendar__grid')).toHaveCount(0)
})

test('the renderer makes no network requests of its own', async () => {
  // Security invariant 6: connect-src 'none'. All GitHub traffic goes through
  // main, so the renderer must not have issued a single external request.
  const external: string[] = []
  window.on('request', (request) => {
    const url = request.url()
    if (!url.startsWith('app://') && !url.startsWith('devtools://') && !url.startsWith('data:')) {
      external.push(url)
    }
  })

  await openView('explorer')
  await openView('insights')
  await window.locator('.side-bar__title-slot[data-view-id="insights"] .icon-button').click()
  await expect(window.locator('.insights-badge')).toBeVisible()

  expect(external).toEqual([])
})
