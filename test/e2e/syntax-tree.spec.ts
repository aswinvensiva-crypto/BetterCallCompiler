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
 * Tree-sitter under the real Content Security Policy.
 *
 * This is the whole risk of the incremental-parsing work, and it is a risk that
 * only exists at runtime: the types compile, the unit tests pass on plain
 * objects, and none of that says whether a `.wasm` can actually be compiled
 * inside a renderer running `script-src 'self' 'wasm-unsafe-eval'` and
 * `connect-src 'none'`.
 *
 * Two claims, and they pull in opposite directions:
 *
 *   1. WebAssembly handed over IPC compiles and runs.
 *   2. WebAssembly fetched from anywhere is still refused.
 *
 * The second is the one that would rot quietly. `'wasm-unsafe-eval'` is a
 * narrow grant, and this asserts it stayed narrow.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

/**
 * Two top-level functions, deliberately.
 *
 * With no selection the Visualizer draws one node per top-level function — the
 * detailed decision/loop/return graph is selection mode, and the cutoff being
 * tested here only applies to file mode. A single function would make the
 * whole diagram one node, which is a graph that cannot tell a redraw from a
 * no-op by counting.
 */
const SOURCE = [
  'export function classify(n: number): string {',
  '  if (n < 0) {',
  '    return "negative"',
  '  }',
  '  for (let i = 0; i < n; i++) {',
  '    if (i === 3) return "three"',
  '  }',
  '  return "other"',
  '}',
  '',
  'export function describe(n: number): string {',
  '  return classify(n).toUpperCase()',
  '}',
  ''
].join('\n')

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

/**
 * Console output this file causes ON PURPOSE.
 *
 * One test proves the CSP still refuses a fetch, and proving it means
 * triggering it — which logs two violations per URL. Those land in the same
 * shared list every other test asserts is empty, so without this the file
 * fails itself: the test that demonstrates the policy works makes the tests
 * that check for policy failures go red.
 *
 * Matched on the fabricated URLs rather than on the CSP wording, so a REAL
 * violation from anywhere else still counts.
 */
const DELIBERATE = ['example.com/evil.wasm', 'assets/anything.wasm']

function unexpectedProblems(): string[] {
  return consoleProblems.filter(
    (message) => !DELIBERATE.some((fragment) => message.includes(fragment))
  )
}

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-syntax-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'classify.ts'), SOURCE)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('syntax'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
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

/**
 * Opens a file from the tree, idempotently.
 *
 * The `src` folder is expanded only when the file is not already on screen.
 * Clicking it unconditionally TOGGLES it, so the second call in a run collapsed
 * the folder and then waited thirty seconds for a row it had just hidden.
 */
async function openFile(name: string): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()

  const row = window.locator('.tree__row', {
    has: window.locator(`.tree__label:text-is("${name}")`)
  })

  if ((await row.count()) === 0) {
    await window
      .locator('.tree__row', { has: window.locator('.tree__label:text-is("src")') })
      .click()
  }

  await row.click()
  await window.locator('.monaco-editor .view-lines').first().waitFor()
}

/** Shows the Visualizer dock, without toggling it shut if it is already up. */
async function openVisualizer(): Promise<void> {
  const view = window.locator('.right-dock__view[data-view-id="visualizer"]')
  if (!(await view.isVisible())) {
    await window.locator('.activity-bar__item[data-view-id="visualizer"]').click()
  }
  await expect(view).toBeVisible()
}

test('the wasm bytes reach the renderer over IPC', async () => {
  const result = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      wasm: {
        read: (r: { name: string }) => Promise<{ ok: boolean; value?: { base64: string } }>
      }
    }
    const runtime = await bridge.wasm.read({ name: 'tree-sitter' })
    const grammar = await bridge.wasm.read({ name: 'tree-sitter-typescript' })
    return {
      runtimeOk: runtime.ok,
      runtimeBytes: runtime.value?.base64.length ?? 0,
      grammarOk: grammar.ok,
      grammarBytes: grammar.value?.base64.length ?? 0
    }
  })

  expect(result.runtimeOk).toBe(true)
  expect(result.grammarOk).toBe(true)
  expect(result.runtimeBytes).toBeGreaterThan(1000)
  expect(result.grammarBytes).toBeGreaterThan(1000)
})

/**
 * The claim `'wasm-unsafe-eval'` was added for. Without that token this throws
 * a CompileError citing the CSP, and the whole approach is dead.
 */
test('WebAssembly compiles from a buffer under the production CSP', async () => {
  const result = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      wasm: { read: (r: { name: string }) => Promise<{ ok: boolean; value?: { base64: string } }> }
    }
    const read = await bridge.wasm.read({ name: 'tree-sitter' })
    if (!read.ok || read.value === undefined) return { compiled: false, error: 'no bytes' }

    const binary = atob(read.value.base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)

    // Reached through globalThis: this callback is typechecked by
    // tsconfig.node.json, which has no DOM lib, but it RUNS in the renderer.
    const wasm = (globalThis as unknown as {
      WebAssembly: { compile: (bytes: Uint8Array) => Promise<unknown> }
    }).WebAssembly

    try {
      const module = await wasm.compile(bytes)
      return { compiled: module !== null && module !== undefined, error: null }
    } catch (error) {
      return { compiled: false, error: error instanceof Error ? error.message : 'unknown' }
    }
  })

  expect(result.error).toBeNull()
  expect(result.compiled).toBe(true)
})

/**
 * The other half, and the one that matters more over time. Permitting
 * WebAssembly compilation must not have quietly permitted the renderer to go
 * and get some.
 */
test('the renderer still cannot fetch anything, wasm included', async () => {
  const blocked = await window.evaluate(async () => {
    const attempts: string[] = []

    for (const url of [
      'https://example.com/evil.wasm',
      'app://bettercallcompiler/assets/anything.wasm'
    ]) {
      try {
        await fetch(url)
        attempts.push(`ALLOWED ${url}`)
      } catch {
        attempts.push(`blocked ${url}`)
      }
    }
    return attempts
  })

  expect(blocked.every((entry) => entry.startsWith('blocked'))).toBe(true)
})

test('opening a TypeScript file raises no CSP violation', async () => {
  await openFile('classify.ts')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('classify')

  // The syntax feed adopted the model on open; give the grammar a moment to
  // load, since it is ~2 MB across the bridge.
  await window.waitForTimeout(3000)

  const csp = unexpectedProblems().filter((message) =>
    /content security policy|refused to|wasm|CompileError/i.test(message)
  )
  expect(csp).toEqual([])
})

/**
 * The behaviour the whole layer exists for: an edit that cannot change the
 * diagram must not redraw it, and one that can must.
 *
 * Asserted through the Visualizer because that is the consumer — there is no
 * test hook in the renderer, and adding one would be shipping production code
 * that exists only for this file.
 */
test('an edit that changes no control flow does not redraw the graph', async () => {
  await openFile('classify.ts')
  await openVisualizer()

  // Scoped to the canvas SVG, as the Visualizer specs do. A bare `.viz-node`
  // also matches chrome outside the diagram, which is how the first version of
  // this test found exactly one "node" in a nine-line function.
  const nodes = window.locator('.viz-canvas__svg .viz-node')
  await expect(nodes.first()).toBeVisible({ timeout: 20_000 })
  const before = await nodes.count()
  expect(before).toBeGreaterThan(1)

  /**
   * A handle to a node that exists right now.
   *
   * Counting nodes before and after cannot tell "the graph was not rebuilt"
   * from "the graph was rebuilt and came out identical" — which is the entire
   * claim. The renderer redraws by replacing the canvas children, so a redraw
   * DETACHES this element from the document. `isConnected` therefore reports
   * the thing being asserted, and it needs no test-only hook in production
   * code to do it.
   */
  const survivor = await nodes.first().elementHandle()
  expect(survivor).not.toBeNull()

  // A real edit, inside a string literal: line 3 is `    return "negative"`.
  // One character lands inside the quotes, so no row moves and no branch,
  // loop or return changes.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+Home')
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('End')
  await window.keyboard.press('ArrowLeft')
  await window.keyboard.type('X')

  // Comfortably past the feed's 300ms debounce.
  await window.waitForTimeout(1500)

  await expect(window.locator('.monaco-editor .view-lines')).toContainText('negativeX')
  expect(await survivor?.evaluate((element) => element.isConnected)).toBe(true)
  expect(await nodes.count()).toBe(before)

  expect(unexpectedProblems()).toEqual([])
})

/**
 * The control for the test above. If the signature ignored something it should
 * not, the previous test would pass by never redrawing at all — so this proves
 * a change that DOES alter control flow still gets through.
 */
test('an edit that adds a branch does redraw the graph', async () => {
  // Re-established rather than inherited from the previous test: a spec that
  // only works when its predecessor passed reports two failures for one fault.
  await openFile('classify.ts')
  await openVisualizer()

  const nodes = window.locator('.viz-canvas__svg .viz-node')
  await expect(nodes.first()).toBeVisible({ timeout: 20_000 })
  const before = await nodes.count()
  const survivor = await nodes.first().elementHandle()

  // A new `if` on its own line: both the flow and every row below it move.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+Home')
  await window.keyboard.press('End')
  await window.keyboard.press('Enter')
  await window.keyboard.type('  if (n === 42) return "answer"')

  await window.waitForTimeout(1500)

  // Detachment is the assertion. In file mode the diagram is one node per
  // top-level function, so adding an `if` INSIDE one does not change the node
  // count — counting would report "no redraw" for a redraw that plainly
  // happened. `isConnected` reports the thing itself.
  expect(await survivor?.evaluate((element) => element.isConnected)).toBe(false)
  await expect(nodes.first()).toBeVisible({ timeout: 20_000 })
  expect(await nodes.count()).toBe(before)
})

test('raises no console errors overall', async () => {
  expect(unexpectedProblems()).toEqual([])
})
