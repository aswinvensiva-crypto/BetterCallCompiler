import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const VALID = 'let total: int = 0;\nprint total;\n'
const MISSING_SEMICOLON = 'fn add(a: int, b: int) -> int {\n  return a + b\n}\n'

/**
 * The workbench as the design draws it: one selection per region on the
 * activity bar, error counts where the reader looks, a status bar that reports
 * what the compiler made of the file, and a right dock that floats over the
 * editor on a narrow window instead of squeezing it.
 */

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'workbench-design-e2e-'))
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await writeFile(join(fixture, 'examples', 'valid.bcc'), VALID)
  await writeFile(join(fixture, 'examples', 'broken.bcc'), MISSING_SEMICOLON)
  await writeFile(join(fixture, 'notes.md'), '# notes\n')

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('workbench-design'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()
  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(message.text())
  })
  window.on('pageerror', (error) => consoleProblems.push(error.message))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
  await widen()
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

/** Mirrors the stylesheet: at or below this width the right dock floats. */
const DOCK_FLOATS_AT = 1180

function innerWidth(): Promise<number> {
  return window.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
}

/**
 * Sizes the page, not the window. Bounds include the frame, so on Windows a
 * 1440px window is a 1424px page; and the CI runner's work area is 1024x768,
 * which the OS may clamp a window to. What a test needs is which side of the
 * dock's breakpoint the page is on, so that is what these wait for.
 */
async function setContentSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setPosition(0, 0)
      win?.setContentSize(size.width, size.height)
    },
    { width, height }
  )
}

async function widen(): Promise<void> {
  await setContentSize(1440, 900)
  await expect.poll(innerWidth).toBeGreaterThan(DOCK_FLOATS_AT)
}

async function narrow(): Promise<void> {
  await setContentSize(1024, 730)
  await expect.poll(innerWidth).toBeLessThanOrEqual(DOCK_FLOATS_AT)
}

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

async function openFile(name: string): Promise<void> {
  if ((await row(name).count()) === 0) await row('examples').click()
  await row(name).click()
  await window.locator('.monaco-editor .view-lines').first().waitFor()
}

function activity(id: string) {
  return window.locator(`.activity-bar__item[data-view-id="${id}"]`)
}

function status(segment: string) {
  return window.locator(`#status-bar .status-bar__item--${segment}`)
}

test('the activity bar lights the side bar view and the dock view together', async () => {
  await activity('substrate').click()
  await expect(window.locator('.substrate')).toBeVisible()

  await expect(activity('explorer')).toHaveAttribute('aria-selected', 'true')
  await expect(activity('substrate')).toHaveAttribute('aria-selected', 'true')

  // Closing the dock takes its highlight with it; the side bar's stays.
  await activity('substrate').click()
  await expect(activity('substrate')).toHaveAttribute('aria-selected', 'false')
  await expect(activity('explorer')).toHaveAttribute('aria-selected', 'true')
})

test('the file tree colours files by type and counts each file’s errors', async () => {
  await row('examples').click()
  await expect(row('broken.bcc').locator('.tree__icon')).toHaveAttribute('data-ext', 'bcc')
  await expect(row('notes.md').locator('.tree__icon')).toHaveAttribute('data-ext', 'md')

  await expect(row('broken.bcc').locator('.tree__err')).toHaveText('1')
  await expect(row('valid.bcc').locator('.tree__err')).toHaveCount(0)
})

test('errors are counted in red on the Problems item and the Problems tab', async () => {
  const badge = activity('problems').locator('.activity-bar__badge')
  await expect(badge).toHaveText('1')
  await expect(badge).toHaveClass(/activity-bar__badge--error/)

  await activity('problems').click()
  const tab = window.locator('.panel-view-tab[data-view-id="problems"]')
  await expect(tab).toHaveAttribute('data-count', '1')
  // The count is drawn, not written: the tab is still called Problems.
  await expect(tab).toHaveText('Problems')
})

test('the status bar reports the compiler’s verdict and where the caret is', async () => {
  await openFile('valid.bcc')
  await expect(status('verdict')).toHaveText('✓ verified')
  await expect(status('verdict')).toHaveAttribute('data-state', 'pass')
  await expect(status('counts')).toHaveText(/\d+ tokens · \d+ nodes/)
  await expect(status('path')).toHaveText('examples/valid.bcc')
  await expect(status('language')).toHaveText('BCC')
  await expect(status('position')).toHaveText('1:1')

  await window.locator('.monaco-editor .view-lines').first().click({ position: { x: 40, y: 10 } })
  await window.keyboard.press('Control+Home')
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('End')
  await expect(status('position')).toHaveText('2:13')

  await openFile('broken.bcc')
  await expect(status('verdict')).toHaveText('✗ 1 error')
  await expect(status('verdict')).toHaveAttribute('data-state', 'fail')
})

test('the status bar’s buttons open the palette, Problems and Substrate', async () => {
  await status('commands').click()
  await expect(window.locator('.quick-pick')).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(window.locator('.quick-pick')).toBeHidden()

  await status('substrate').click()
  await expect(window.locator('.substrate')).toBeVisible()
  await status('substrate').click()
  await expect(window.locator('.substrate')).toBeHidden()

  await status('verdict').click()
  await expect(window.locator('.panel-view-tab--active')).toHaveText('Problems')
})

test('a hidden status item takes no room', async () => {
  // The AI spend is hidden until a request has been made.
  const hidden = window.locator('#status-bar .status-bar__item[hidden]')
  expect(await hidden.count()).toBeGreaterThan(0)
  for (const item of await hidden.all()) await expect(item).toBeHidden()
})

test('on a narrow window the dock floats over the editor instead of squeezing it', async () => {
  await narrow()
  const editorWidth = (): Promise<number> =>
    window.locator('#editor-area').evaluate((element) => element.getBoundingClientRect().width)

  const before = await editorWidth()
  await activity('substrate').click()
  await expect(window.locator('.substrate')).toBeVisible()

  await expect(window.locator('#right-dock')).toHaveCSS('position', 'fixed')
  expect(await editorWidth()).toBe(before)

  await activity('substrate').click()
  await expect(window.locator('.substrate')).toBeHidden()
  await widen()
})

test('raises no console errors', () => {
  expect(consoleProblems).toEqual([])
})
