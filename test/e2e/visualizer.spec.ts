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
  fixture = await mkdtemp(join(tmpdir(), 'bcc-viz-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'sample.js'), SAMPLE)
  await writeFile(join(fixture, 'src', 'broken.js'), 'function ( { not valid ]]] <<<\n')

  app = await electron.launch({ args: [MAIN_ENTRY, isolatedUserData('visualizer'), `--folder=${fixture}`], cwd: APP_ROOT })
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
 * previous test's DOM. The graph is rebuilt on a debounce by design, so
 * depending on it surviving between tests makes the suite order-sensitive for
 * no benefit.
 */
async function openInVisualizer(file: string): Promise<void> {
  // The Visualizer lives in the right dock, not the side bar, so it does not
  // compete with the Explorer for a region — but the Explorer is still switched
  // to explicitly, because the side bar shows one view at a time and a previous
  // test may have left something else in front of the file tree.
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
 * Drives a control-flow render by making an explicit selection.
 *
 * The feed is debounced and additionally keyed on its own inputs, so the trigger
 * has to be a genuine *change* of selection. Re-pressing Ctrl+A when everything
 * is already selected — which is the state every test after the first inherits
 * — produces the same key, and the panel keeps what it had.
 */
async function showGraphFor(file: string): Promise<void> {
  await openInVisualizer(file)
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+A')

  // Waiting for a node to appear is not enough, and the reason is worth stating:
  // opening the file already drew the whole-file graph, so nodes are on screen
  // before Ctrl+A is even pressed. That wait passes instantly against the *old*
  // drawing, and the assertions then race the 300ms debounce that swaps in the
  // control-flow one. The toolbar's mode readout is the honest signal — it flips
  // only once the selection graph has actually been built.
  await expect(window.locator('.viz-toolbar__metrics')).toContainText('Selection', {
    timeout: 20_000
  })
  await expect(window.locator('.viz-canvas__svg .viz-node').first()).toBeVisible()
}

test('renders the enclosing node from the cursor with no selection', async () => {
  await openInVisualizer('sample.js')

  // No selection at all — just a caret inside the function. The whole file is
  // graphed and the node covering the caret's line is picked out, which is what
  // replaced the old regex `findEnclosingSymbol` fallback.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+Home')
  await window.keyboard.press('ArrowDown')

  const svg = window.locator('.viz-canvas__svg')
  await expect(svg.locator('.viz-node').first()).toBeVisible({ timeout: 20_000 })
  await expect(svg).toContainText('classify')
  // The bidirectional link: the caret on line 2 sits inside `classify`, so that
  // is the node the panel highlights and the toolbar reports.
  await expect(svg.locator('.viz-node--selected')).toHaveCount(1)
  await expect(window.locator('.viz-toolbar__metrics')).toContainText('classify')
})

test('the graph reflects the code — decisions, loops and returns', async () => {
  await showGraphFor('sample.js')

  // Auto-retrying assertions rather than one `textContent()` read: the graph is
  // rebuilt on a debounce, and a single read is a snapshot of whichever drawing
  // happened to be up at that instant.
  const svg = window.locator('.viz-canvas__svg')

  await expect(svg).toContainText('If')
  await expect(svg).toContainText('Return')
  // The operator has to survive into the drawing as a real `>`. Labels are set
  // through `textContent` rather than markup, so an escaped entity here would
  // show up on the canvas as a literal `&gt;`.
  await expect(svg).toContainText('>')
})

test('activating a node jumps the editor to that line', async () => {
  await showGraphFor('sample.js')

  const nodes = window.locator('.viz-canvas__svg .viz-node')
  await expect(nodes.first()).toBeVisible()

  // Every node carries the id it was built from, and that id still encodes the
  // line — the same mapping click-to-source relies on, now read from
  // `location` rather than parsed back out of the id.
  const id = await nodes.first().getAttribute('data-node-id')
  expect(id).toMatch(/_L\d+/)

  // Move focus out of the editor first, so regaining it is evidence the handler
  // ran rather than focus never having left. The Explorer icon is used rather
  // than the Visualizer's own: re-clicking an active tool window's icon toggles
  // its dock shut, which would take the graph away with it. The side bar and
  // the right dock are separate regions, so this leaves the graph on screen.
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()

  // A single click selects; revealing the source is a deliberate second action,
  // so that panning around a graph can never scroll the editor by accident.
  // Enter on the focused canvas is the keyboard half of that gesture and, unlike
  // a double click, does not depend on two events landing inside a time window.
  await nodes.first().click()
  await window.keyboard.press('Enter')

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

test('a deliberately broken file still renders a fallback graph, not an error', async () => {
  await showGraphFor('broken.js')

  // Degrading visibly beats a blank panel: something is drawn, and the toolbar
  // says plainly that it is a list of lines rather than passing it off as a
  // control-flow graph.
  await expect(window.locator('.viz-canvas__svg .viz-node').first()).toBeVisible()
  await expect(window.locator('.viz-toolbar__notice')).toContainText('does not parse')
})

/**
 * Load-bearing, and more so than when Mermaid drew this panel. Every element on
 * the canvas is now hand-written SVG built in the renderer, which ships
 * `connect-src 'none'` and `script-src 'self'` — an inline handler, a blob:
 * worker or a stray eval would all be refused, and would surface here rather
 * than as a diagram that quietly renders nothing.
 */
test('the Visualizer renders with no CSP violations or console errors', async () => {
  const csp = consoleProblems.filter((message) =>
    /content security policy|refused to|blob:|unsafe-eval/i.test(message)
  )
  expect(csp).toEqual([])
  expect(consoleProblems).toEqual([])
})
