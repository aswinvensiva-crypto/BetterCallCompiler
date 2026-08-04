import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let window: Page

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bettercallcompiler-explorer-'))
  await mkdir(join(fixture, 'src', 'nested'), { recursive: true })
  await writeFile(join(fixture, 'readme.md'), '# fixture\n')
  await writeFile(join(fixture, 'alpha.txt'), 'a\n')
  await writeFile(join(fixture, 'src', 'index.js'), 'console.log(1)\n')
  await writeFile(join(fixture, 'src', 'nested', 'deep.txt'), 'deep\n')

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('explorer'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

test('lists the opened folder, directories first', async () => {
  await expect(window.locator('.tree__row')).toHaveCount(3)

  const labels = await window.locator('.tree__label').allTextContents()
  expect(labels).toEqual(['src', 'alpha.txt', 'readme.md'])

  // The workspace name is shown as the side bar heading.
  await expect(window.locator('.side-bar__heading')).toHaveText(fixture.split(/[\\/]/).pop() ?? '')
})

test('expands a directory lazily and collapses it again', async () => {
  await row('src').click()

  await expect(window.locator('.tree__label')).toHaveCount(5)
  const labels = await window.locator('.tree__label').allTextContents()
  expect(labels).toEqual(['src', 'nested', 'index.js', 'alpha.txt', 'readme.md'])

  await row('src').click()
  await expect(window.locator('.tree__label')).toHaveCount(3)
})

test('creates a file through the toolbar and picks it up from the watcher', async () => {
  await window.locator('.icon-button[aria-label="New File"]').click()

  const input = window.locator('.tree__input')
  await expect(input).toBeVisible()
  await input.fill('created-by-test.ts')
  await input.press('Enter')

  await expect(row('created-by-test.ts')).toHaveCount(1)
})

test('renames a file from the context menu', async () => {
  await row('alpha.txt').click({ button: 'right' })
  await window.locator('.context-menu__item:text-is("Rename")').click()

  const input = window.locator('.tree__input')
  await expect(input).toBeVisible()
  await input.fill('renamed.txt')
  await input.press('Enter')

  await expect(row('renamed.txt')).toHaveCount(1)
  await expect(row('alpha.txt')).toHaveCount(0)
})

test('deletes a file after confirmation', async () => {
  await row('renamed.txt').click({ button: 'right' })
  await window.locator('.context-menu__item:text-is("Delete")').click()

  await expect(window.locator('.modal__title')).toContainText('Delete renamed.txt?')
  await window.locator('.button--danger').click()

  await expect(row('renamed.txt')).toHaveCount(0)
})

test('refuses a path that escapes the workspace', async () => {
  // Drives the bridge directly: the UI never offers this, but a compromised
  // renderer would, and confinement must hold at the boundary rather than in
  // the view layer.
  const result = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      fs: { readFile: (r: { path: string }) => Promise<unknown> }
    }
    return (await bridge.fs.readFile({
      path: '../../../../../../Windows/System32/drivers/etc/hosts'
    })) as { ok: boolean; error?: { code: string } }
  })

  expect(result.ok).toBe(false)
  expect(result.error?.code).toBe('PATH_ESCAPES_WORKSPACE')
})
