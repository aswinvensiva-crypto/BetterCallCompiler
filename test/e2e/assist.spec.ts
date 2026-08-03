import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let window: Page

/** Deliberately contains an await-in-loop and an empty catch for Debug to find. */
const SAMPLE = `export async function loadAll(ids) {
  const out = []
  for (const id of ids) {
    await fetchOne(id)
  }
  try {
    finish(out)
  } catch (e) {}
  return out
}
`

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-assist-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'load.js'), SAMPLE)

  app = await electron.launch({ args: [MAIN_ENTRY, `--folder=${fixture}`], cwd: APP_ROOT })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')

  await window
    .locator('.tree__row', { has: window.locator('.tree__label:text-is("src")') })
    .click()
  await window
    .locator('.tree__row', { has: window.locator('.tree__label:text-is("load.js")') })
    .click()
  await window.waitForSelector('.monaco-editor .view-lines')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

/** Selects the whole file, which is what raises the floating toolbar. */
async function selectAll(): Promise<void> {
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+A')
}

async function runMode(label: string): Promise<void> {
  await selectAll()
  await expect(window.locator('.assist-popup')).toBeVisible({ timeout: 10_000 })
  await window.locator('.assist-popup__button', { hasText: label }).click()
  await expect(window.locator('.side-bar__view[data-view-id="assist"]')).toBeVisible()
}

/**
 * Declared first on purpose: it is the only assertion that needs a window where
 * nothing has been selected yet, and `beforeAll` opens a file without selecting
 * anything. Launching a second Electron instance to get a clean window trips
 * the single-instance lock.
 */
test('the Assist panel says what to do before anything is selected', async () => {
  await window.locator('.activity-bar__item[data-view-id="assist"]').click()

  await expect(window.locator('.side-bar__view[data-view-id="assist"]')).toBeVisible()
  await expect(window.locator('.explorer__empty-text')).toContainText('Select code')

  // Back to the explorer so the remaining tests start from a known view.
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()
})

test('selecting code raises the floating Assist toolbar', async () => {
  await selectAll()

  const popup = window.locator('.assist-popup')
  await expect(popup).toBeVisible({ timeout: 10_000 })
  await expect(popup.locator('.assist-popup__button')).toHaveCount(4)
  await expect(popup).toContainText('Learn')
  await expect(popup).toContainText('Debug')
  await expect(popup).toContainText('Explain')
  await expect(popup).toContainText('Snippet')
})

test('Learn explains the constructs actually present, with their gotchas', async () => {
  await runMode('Learn')

  const result = window.locator('.assist-result')
  await expect(result).toBeVisible()
  // The sample is async with a for-of, so async/await must be reported.
  await expect(result).toContainText('async / await')
  // The gotcha is the point of the feature, not a definition.
  await expect(window.locator('.assist-card__gotcha-label').first()).toContainText('Gotcha')
})

test('Debug reports metrics and finds the planted defects', async () => {
  await runMode('Debug')

  await expect(window.locator('.assist-metric')).toHaveCount(3)
  const result = window.locator('.assist-result')
  await expect(result).toContainText('complexity')

  // Both are really in the fixture.
  await expect(result).toContainText('Empty catch block')
  await expect(result).toContainText('await inside a loop')

  // v1 does not execute anything, and says so rather than letting the user assume.
  await expect(window.locator('.assist-footnote')).toContainText('not executed')
})

test('Debug findings point at real line numbers', async () => {
  await runMode('Debug')

  const line = await window.locator('.assist-finding__line').first().textContent()
  expect(line).toMatch(/^L\d+$/)
  expect(Number((line ?? 'L0').slice(1))).toBeGreaterThan(0)
})

test('Explain separates what the selection declares from what it depends on', async () => {
  await runMode('Explain')

  const result = window.locator('.assist-result')
  await expect(result).toContainText('Declares')
  await expect(result).toContainText('Depends on')
  await expect(result).toContainText('loadAll')
  // fetchOne is called but not defined here.
  await expect(window.locator('.assist-chip', { hasText: 'fetchOne' })).toBeVisible()
})

test('Snippet produces a fenced block with a file:line reference', async () => {
  await runMode('Snippet')

  const snippet = window.locator('.assist-snippet')
  await expect(snippet).toBeVisible()
  await expect(snippet).toContainText('```')
  await expect(snippet).toContainText('src/load.js:L1')
  await expect(window.locator('.assist-actions button', { hasText: 'Copy markdown' })).toBeVisible()
})

test('Snippet says there is no permalink rather than inventing one', async () => {
  await runMode('Snippet')

  // The fixture workspace is a bare directory with no git remote, so a blob URL
  // cannot be resolved. An unresolvable link would be worse than none.
  await expect(window.locator('.assist-footnote')).toContainText('No permalink')
  await expect(
    window.locator('.assist-actions button', { hasText: 'Copy blob URL' })
  ).toHaveCount(0)
})

test('switching tabs re-renders the same selection in another mode', async () => {
  await runMode('Learn')

  await window.locator('.assist-tab', { hasText: 'Explain' }).click()
  await expect(window.locator('.assist-result')).toContainText('Declares')

  await window.locator('.assist-tab', { hasText: 'Debug' }).click()
  await expect(window.locator('.assist-metric')).toHaveCount(3)
})

