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
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let window: Page

/** Step 12: command palette, quick open, and workspace search. */
test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bettercallcompiler-chrome-'))
  await mkdir(join(fixture, 'src', 'views'), { recursive: true })

  await writeFile(join(fixture, 'readme.md'), '# Fixture\n\nthe needle is here\n')
  await writeFile(join(fixture, 'src', 'index.ts'), 'export const answer = 42\n')
  await writeFile(
    join(fixture, 'src', 'views', 'run.ts'),
    'export function run() {\n  return "needle"\n}\n'
  )
  // Must never appear in quick open or search results.
  await mkdir(join(fixture, 'node_modules', 'junk'), { recursive: true })
  await writeFile(join(fixture, 'node_modules', 'junk', 'index.ts'), 'needle needle needle\n')

  app = await electron.launch({ args: [MAIN_ENTRY, isolatedUserData('chrome'), `--folder=${fixture}`], cwd: APP_ROOT })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

/* ------------------------------ quick open ------------------------------- */

test('Ctrl+P opens a fuzzy file picker over the workspace', async () => {
  await window.keyboard.press('Control+P')

  const picker = window.locator('.quick-pick')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.quick-pick__input')).toHaveAttribute('placeholder', 'Go to file')

  // Every workspace file, and nothing from node_modules.
  const labels = await picker.locator('.quick-pick__label').allInnerTexts()
  expect(labels).toContain('src/views/run.ts')
  expect(labels.some((label) => label.includes('node_modules'))).toBe(false)
})

test('typing filters fuzzily and highlights what matched', async () => {
  await window.locator('.quick-pick__input').fill('viewsrun')

  const first = window.locator('.quick-pick__item').first()
  await expect(first).toContainText('src/views/run.ts')
  // The matched characters are marked, which is what makes the ranking legible.
  await expect(first.locator('.quick-pick__hit').first()).toBeVisible()
})

test('Enter opens the highlighted file', async () => {
  await window.keyboard.press('Enter')

  await expect(window.locator('.quick-pick')).toHaveCount(0)
  await expect(window.locator('.tab--active')).toContainText('run.ts')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('export function run')
})

test('Escape dismisses the picker without opening anything', async () => {
  await window.keyboard.press('Control+P')
  await expect(window.locator('.quick-pick')).toBeVisible()

  await window.keyboard.press('Escape')
  await expect(window.locator('.quick-pick')).toHaveCount(0)
  await expect(window.locator('.tab--active')).toContainText('run.ts')
})

/* --------------------------- command palette ----------------------------- */

test('Ctrl+Shift+P opens the command palette', async () => {
  await window.keyboard.press('Control+Shift+P')

  const picker = window.locator('.quick-pick')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.quick-pick__input')).toHaveAttribute(
    'placeholder',
    'Type a command name'
  )

  const labels = await picker.locator('.quick-pick__label').allInnerTexts()
  expect(labels).toContain('Go to File…')
  expect(labels).toContain('View: Source Control')
  expect(labels).toContain('Toolchains: Rescan')
})

test('a command runs when accepted', async () => {
  await window.locator('.quick-pick__input').fill('source control')
  await window.keyboard.press('Enter')

  await expect(window.locator('.quick-pick')).toHaveCount(0)
  await expect(window.locator('.side-bar__view[data-view-id="scm"]')).toBeVisible()
})

// `when` exists so the palette never offers something that would just fail.
test('commands that do not apply are hidden', async () => {
  await window.keyboard.press('Control+Shift+P')
  const labels = await window.locator('.quick-pick__label').allInnerTexts()

  // Nothing is running, so Cancel must not be offered.
  expect(labels).not.toContain('Run: Cancel')
  await window.keyboard.press('Escape')
})

/* -------------------------------- search --------------------------------- */

test('the search view finds matches across the workspace', async () => {
  await window.locator('.activity-bar__item[data-view-id="search"]').click()
  await expect(window.locator('.side-bar__view[data-view-id="search"]')).toBeVisible()

  await window.locator('.search-input').fill('needle')
  await window.keyboard.press('Enter')

  await expect(window.locator('.search-summary')).toContainText('result', { timeout: 15_000 })

  const files = await window.locator('.search-file__name').allInnerTexts()
  expect(files).toContain('readme.md')
  expect(files).toContain('src/views/run.ts')
  // node_modules is excluded from the walk, not just from the tree.
  expect(files.some((file) => file.includes('node_modules'))).toBe(false)

  // The matched run is marked within the line.
  await expect(window.locator('.search-match__hit').first()).toHaveText('needle')
})

test('clicking a result reveals it in the editor', async () => {
  await window
    .locator('.search-file', { has: window.locator('.search-file__name:text-is("readme.md")') })
    .locator('.search-match')
    .first()
    .click()

  await expect(window.locator('.tab--active')).toContainText('readme.md')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('the needle is here')
})

test('an invalid regular expression is reported in place, not thrown', async () => {
  await window.locator('.activity-bar__item[data-view-id="search"]').click()

  // Turn on regex mode, then type something half-finished.
  await window.locator('.search-toggle[title="Use regular expression"]').click()
  await window.locator('.search-input').fill('([unclosed')
  await window.keyboard.press('Enter')

  await expect(window.locator('.insights-notice')).toContainText('invalid regular expression')
  // A half-typed pattern is the normal state of a search box, not a toast.
  await expect(window.locator('.toast')).toHaveCount(0)
})

test('search finds nothing gracefully', async () => {
  await window.locator('.search-toggle[title="Use regular expression"]').click()
  await window.locator('.search-input').fill('zzz-not-present-anywhere')
  await window.keyboard.press('Enter')

  await expect(window.locator('.side-bar__view[data-view-id="search"]')).toContainText('No results')
})
