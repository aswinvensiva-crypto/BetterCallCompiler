import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bettercallcompiler-editor-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'index.js'), 'const answer = 42\n')
  await writeFile(join(fixture, 'notes.md'), '# notes\n')

  app = await electron.launch({ args: [MAIN_ENTRY, isolatedUserData('editor'), `--folder=${fixture}`], cwd: APP_ROOT })
  window = await app.firstWindow()

  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(message.text())
  })
  window.on('pageerror', (error) => consoleProblems.push(error.message))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

function editorText() {
  return window.locator('.monaco-editor .view-lines')
}

/**
 * Monaco keeps focus on a 1px offscreen textarea that the rendered text layer
 * sits on top of, so clicking the textarea itself is intercepted. Clicking the
 * visible lines is what a user actually does, and it moves focus correctly.
 */
async function focusEditor(): Promise<void> {
  await editorText().first().click()
}

async function openFixtureFile(dir: string, name: string): Promise<void> {
  await row(dir).click()
  await row(name).click()
}

test('mounts Monaco and loads file contents', async () => {
  await openFixtureFile('src', 'index.js')

  await expect(window.locator('.monaco-editor')).toBeVisible()
  await expect(editorText()).toContainText('const answer = 42')
  await expect(window.locator('.tab', { hasText: 'index.js' })).toHaveCount(1)
})

test('marks the tab dirty on edit and clears it on Ctrl+S', async () => {
  await focusEditor()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('\nconst added = true')

  await expect(window.locator('.tab__close--dirty')).toHaveCount(1)

  await window.keyboard.press('Control+s')

  await expect(window.locator('.tab__close--dirty')).toHaveCount(0)

  const onDisk = await readFile(join(fixture, 'src', 'index.js'), 'utf8')
  expect(onDisk).toContain('const added = true')
})

test('keeps each file on its own model, with undo history surviving a tab switch', async () => {
  await row('notes.md').click()
  await expect(window.locator('.tab')).toHaveCount(2)
  await expect(editorText()).toContainText('# notes')

  // Back to the first file: its content is intact...
  await window.locator('.tab', { hasText: 'index.js' }).click()
  await expect(editorText()).toContainText('const added = true')

  // ...and so is its undo stack, which a per-switch model rebuild would lose.
  await focusEditor()
  await window.keyboard.press('Control+z')
  await expect(editorText()).not.toContainText('const added = true')
  await window.keyboard.press('Control+y')
  await expect(editorText()).toContainText('const added = true')
})

test('confirms before closing a tab with unsaved changes', async () => {
  await focusEditor()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('\n// unsaved trailer')
  await expect(window.locator('.tab__close--dirty')).toHaveCount(1)

  await window.locator('.tab--active .tab__close').click()

  await expect(window.locator('.modal__title')).toContainText('Save changes to index.js?')
  await window.locator('.button:text-is("Don\'t Save")').click()

  await expect(window.locator('.tab', { hasText: 'index.js' })).toHaveCount(0)

  // Discarded, not written.
  const onDisk = await readFile(join(fixture, 'src', 'index.js'), 'utf8')
  expect(onDisk).not.toContain('unsaved trailer')
})

/**
 * The whole reason the renderer is served from `app://` rather than `file://`.
 * A blocked worker or stylesheet shows up here as a CSP violation, so an empty
 * console is the real proof that Monaco runs under the required policy.
 */
test('runs Monaco with no CSP violations or console errors', async () => {
  const cspViolations = consoleProblems.filter((message) =>
    /content security policy|refused to/i.test(message)
  )
  expect(cspViolations).toEqual([])
  expect(consoleProblems).toEqual([])
})
