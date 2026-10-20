import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const VALID = 'let total: int = 0;\nprint total;\n'
const MISSING_SEMICOLON = 'fn add(a: int, b: int) -> int {\n  return a + b\n}\n'

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'substrate-e2e-'))
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await writeFile(join(fixture, 'examples', 'valid.bcc'), VALID)
  await writeFile(join(fixture, 'examples', 'broken.bcc'), MISSING_SEMICOLON)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('substrate'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()

  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(message.text())
  })
  window.on('pageerror', (error) => consoleProblems.push(error.message))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  })
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

async function openFile(name: string): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()
  if ((await row(name).count()) === 0) await row('examples').click()
  await row(name).click()
  await window.locator('.monaco-editor .view-lines').first().waitFor()
}

async function openSubstrate(): Promise<void> {
  const verdict = window.locator('.substrate__verdict')
  // The activity item toggles the dock, so a second click would close it.
  if (!(await verdict.isVisible())) {
    await window.locator('.activity-bar__item[data-view-id="substrate"]').click()
  }
  await expect(verdict).toBeVisible()
}

function stage(id: string) {
  return window.locator(`.substrate__stage[data-stage-id="${id}"]`)
}

/** The selected stage's pane, as opposed to the Source pane beside it. */
function projection() {
  return window.locator('.substrate__pane', { hasNot: window.locator('.substrate__source') })
}

test('a valid program is verified, with every front-end stage passing', async () => {
  await openFile('valid.bcc')
  await openSubstrate()

  await expect(window.locator('.substrate__verdict')).toContainText('verified — SSA sound')
  for (const id of ['tokens', 'ast', 'symbols', 'types']) {
    await expect(stage(id)).toHaveAttribute('data-state', 'ok')
  }
})

test('a missing semicolon halts at AST, and Types reads not reached rather than clean', async () => {
  await openFile('broken.bcc')
  await openSubstrate()

  await expect(window.locator('.substrate__verdict')).toContainText('pipeline halted at 02')
  await expect(stage('tokens')).toHaveAttribute('data-state', 'ok')
  await expect(stage('ast')).toHaveAttribute('data-state', 'error')
  await expect(stage('ast')).toContainText('1 err')
  await expect(stage('types')).toHaveAttribute('data-state', 'blocked')
  await expect(stage('types')).toContainText('not reached')
})

test('the syntax error is listed under AST, never under Types', async () => {
  await stage('types').click()
  await expect(projection()).toContainText('Types')
  await expect(projection()).not.toContainText('BCC0003')

  await stage('ast').click()
  await expect(projection()).toContainText('BCC0003')
  await expect(projection()).toContainText("expected ';'")
})

test('raises no console errors', () => {
  expect(consoleProblems).toEqual([])
})
