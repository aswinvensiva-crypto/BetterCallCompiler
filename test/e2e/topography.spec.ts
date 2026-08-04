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
const consoleProblems: string[] = []

const SAMPLE = `export function classify(value) {
  if (value > 10) {
    report(value)
    return 'big'
  }
  for (const item of list) {
    inspect(item)
  }
  return 'small'
}
`

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-topo-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'sample.js'), SAMPLE)
  await writeFile(join(fixture, 'src', 'broken.js'), 'function ( { not valid ]]] <<<\n')

  app = await electron.launch({ args: [MAIN_ENTRY, isolatedUserData('topography'), `--folder=${fixture}`], cwd: APP_ROOT })
  window = await app.firstWindow()

  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(message.text())
  })
  window.on('pageerror', (error) => consoleProblems.push(error.message))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
  // Expand `src` once. Clicking it again would collapse it, so this is done
  // here rather than per test.
  await window
    .locator('.tree__row', { has: window.locator('.tree__label:text-is("src")') })
    .click()
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

/**
 * Each test drives the panel to a known state itself rather than inheriting the
 * previous test's DOM. The diagram is re-rendered on a debounce by design, so
 * depending on it surviving between tests makes the suite order-sensitive for
 * no benefit.
 */
async function openInVisualizer(file: string): Promise<void> {
  // The Visualizer now lives in the right dock, not the side bar, so it no
  // longer competes with the Explorer for the same region — but the Explorer is
  // still switched to explicitly, because the side bar shows one view at a time
  // and a previous test may have left something else in front of the file tree.
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()
  await expect(window.locator('.side-bar__view[data-view-id="explorer"]')).toBeVisible()

  await window
    .locator('.tree__row', { has: window.locator(`.tree__label:text-is("${file}")`) })
    .click()
  await window.waitForSelector('.monaco-editor .view-lines')

  // Clicking the activity-bar icon toggles the dock, so it is only pressed when
  // the dock is not already open — a second click would close it.
  const view = window.locator('.right-dock__view[data-view-id="visualizer"]')
  if (!(await view.isVisible())) {
    await window.locator('.activity-bar__item[data-view-id="visualizer"]').click()
  }
  await expect(view).toBeVisible()
}

/**
 * Drives a render by making an explicit selection.
 *
 * The feed is debounced off `onDidChangeCursorSelection`, so the trigger has to
 * be a genuine *change*. Re-pressing Ctrl+Home when the caret is already there
 * — which is the state every test after the first inherits — fires nothing, and
 * the panel simply keeps whatever it had.
 */
async function showDiagramFor(file: string): Promise<void> {
  await openInVisualizer(file)
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+A')
  await expect(window.locator('.topo-canvas svg')).toBeVisible({ timeout: 20_000 })
}

test('renders a diagram from the enclosing function with no selection', async () => {
  await openInVisualizer('sample.js')

  // No selection at all — just a caret inside the function, which is the
  // common case and the one that needs findEnclosingSymbol.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+Home')
  await window.keyboard.press('ArrowDown')

  await expect(window.locator('.topo-canvas svg')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('.topo-canvas .node').first()).toBeVisible()
  await expect(window.locator('.topo-meta')).toContainText('node')
})

test('the diagram reflects the code — decisions, loops and returns', async () => {
  await showDiagramFor('sample.js')

  // `<svg>` is not an HTMLElement, so textContent is the right accessor here.
  const text = (await window.locator('.topo-canvas svg').textContent()) ?? ''

  expect(text).toContain('If')
  expect(text).toContain('Return')
  // The `>` is emitted as a numeric entity and must survive rendering as a real
  // operator — stripping it would draw a condition the code does not contain.
  expect(text).toContain('>')
})

test('clicking a node jumps the editor to that line', async () => {
  await showDiagramFor('sample.js')

  const nodes = window.locator('.topo-canvas .node')
  await expect(nodes.first()).toBeVisible()

  // Every node id encodes the line it came from; that mapping is what
  // click-to-source relies on.
  const id = await nodes.first().getAttribute('id')
  expect(id).toMatch(/_L\d+/)

  // Move focus out of the editor first, so regaining it is evidence the click
  // handler ran rather than focus never having left. The Explorer icon is used
  // rather than the Visualizer's own: re-clicking an active tool window's icon
  // now toggles its dock shut, which would take the diagram away with it. The
  // side bar and the right dock are separate regions, so this leaves the
  // diagram on screen.
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()
  await nodes.first().click()

  // Reaches through `globalThis` rather than naming `document`: this file is
  // compiled by the Node-side tsconfig, which has no DOM lib — the same reason
  // no-node-in-renderer.spec.ts does it this way.
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const doc = (
            globalThis as unknown as {
              document: { activeElement: { closest(selector: string): unknown } | null }
            }
          ).document
          return doc.activeElement?.closest('.monaco-editor') != null
        }),
      { timeout: 5000 }
    )
    .toBe(true)
})

test('a deliberately broken file still renders a fallback diagram, not an error', async () => {
  await showDiagramFor('broken.js')

  // Degrading visibly beats a blank panel: something is drawn, and it is
  // badged as sequential rather than passed off as a control-flow graph.
  await expect(window.locator('.topo-canvas svg')).toBeVisible()
  await expect(window.locator('.topo-meta__badge')).toHaveText('sequential')
})

/**
 * The reason Mermaid is bundled through Vite rather than loaded from a CDN.
 * The renderer ships `connect-src 'none'` and `script-src 'self'`, so a CDN
 * fetch, a blob: worker or an eval would all fail — and would surface here.
 */
test('Mermaid renders with no CSP violations or console errors', async () => {
  const csp = consoleProblems.filter((message) =>
    /content security policy|refused to|blob:|unsafe-eval/i.test(message)
  )
  expect(csp).toEqual([])
  expect(consoleProblems).toEqual([])
})
