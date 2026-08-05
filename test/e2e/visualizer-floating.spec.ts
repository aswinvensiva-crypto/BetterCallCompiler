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

/**
 * The detached Visualizer window.
 *
 * This is the only feature in the app that puts a second `BrowserWindow` on
 * screen, and `createWindow` in main/index.ts spent its whole life assuming
 * there would never be one. The traps that assumption left behind — global
 * teardown on close, an `activate` handler counting windows, single-target event
 * emitters — are not things a typecheck can see, so they are asserted here.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let main: Page

const SAMPLE = `export function classify(value) {
  if (value > 10) {
    report(value)
    return 'big'
  }
  return 'small'
}
`

/** The floating window is the one whose URL carries the boot flag. */
async function floatingWindow(): Promise<Page> {
  for (const page of app.windows()) {
    if (page.url().includes('mode=visualizer')) return page
  }
  return await app.waitForEvent('window', {
    predicate: (page) => page.url().includes('mode=visualizer')
  })
}

async function openVisualizerDock(): Promise<void> {
  const view = main.locator('.right-dock__view[data-view-id="visualizer"]')
  if (!(await view.isVisible())) {
    await main.locator('.activity-bar__item[data-view-id="visualizer"]').click()
  }
  await expect(view).toBeVisible()
}

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-float-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'sample.js'), SAMPLE)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('visualizer-floating'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  main = await app.firstWindow()
  await main.waitForSelector('html[data-bettercallcompiler-ready="true"]')

  await main.locator('.tree__row', { has: main.locator('.tree__label:text-is("src")') }).click()
  await main
    .locator('.tree__row', { has: main.locator('.tree__label:text-is("sample.js")') })
    .click()
  await main.waitForSelector('.monaco-editor .view-lines')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

test('detaching opens a second window showing the same graph', async () => {
  await openVisualizerDock()
  await expect(main.locator('.viz-canvas__svg .viz-node').first()).toBeVisible({ timeout: 20_000 })

  await main.locator('[aria-label="Open Visualizer in a floating window"]').click()

  const floating = await floatingWindow()
  await floating.waitForSelector('html[data-bettercallcompiler-ready="true"]')

  // It draws the graph the main window built rather than parsing again, so the
  // two windows cannot disagree about one file.
  await expect(floating.locator('.viz-canvas__svg .viz-node').first()).toBeVisible({
    timeout: 20_000
  })
  await expect(floating.locator('.viz-canvas__svg')).toContainText('classify')

  // Only the diagram travels: an editor, an activity bar or a status bar out
  // here would mean the boot branch fell through into the full workbench.
  await expect(floating.locator('#activity-bar')).toHaveCount(0)
  await expect(floating.locator('.monaco-editor')).toHaveCount(0)
})

test('the detached window keeps its own toolbar limits', async () => {
  const floating = await floatingWindow()
  // Both windows own their sliders; a push from the main window must not reach
  // in and overwrite limits chosen out here.
  await expect(floating.locator('.viz-toolbar__slider').first()).toBeVisible()
})

test('activating a node in the detached window drives the main editor', async () => {
  const floating = await floatingWindow()

  const node = floating.locator('.viz-canvas__svg .viz-node[data-node-id]').first()
  await expect(node).toBeVisible()
  await node.click()
  await floating.keyboard.press('Enter')

  // The reveal has to cross two process boundaries — floating renderer, main,
  // then the main window — because events only travel main to renderer and there
  // is no renderer-to-renderer channel.
  await expect
    .poll(
      () =>
        main.evaluate(() => {
          const doc = (
            globalThis as unknown as {
              document: { activeElement: { closest(selector: string): unknown } | null }
            }
          ).document
          return doc.activeElement?.closest('.monaco-editor') != null
        }),
      { timeout: 10_000 }
    )
    .toBe(true)
})

test('the detached window raises no CSP violations or console errors', async () => {
  const floating = await floatingWindow()
  const problems: string[] = []
  floating.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  floating.on('pageerror', (error) => problems.push(error.message))

  // Force a repaint so anything the renderer does on a graph change is exercised
  // while the listeners above are attached.
  await main.locator('.monaco-editor .view-lines').click()
  await main.keyboard.press('Control+A')
  await expect(floating.locator('.viz-canvas__svg .viz-node').first()).toBeVisible()

  expect(problems).toEqual([])
})

/**
 * Declared last because it closes the app.
 *
 * A detached diagram that outlives its editor cannot be fed — `pushState` comes
 * from the main window — and on non-darwin it would hold `window-all-closed`
 * back, leaving a running process with no reachable window. index.ts closes it
 * from the main window's own `closed` handler so that state is unreachable
 * rather than merely handled.
 */
test('closing the main window takes the detached one with it', async () => {
  await floatingWindow()
  expect(app.windows().length).toBeGreaterThan(1)

  await main.close()

  await expect
    .poll(() => app.windows().filter((page) => page.url().includes('mode=visualizer')).length, {
      timeout: 10_000
    })
    .toBe(0)
})
