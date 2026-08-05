import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let window: Page

/** What the probe found on the machine running the suite. */
let toolchains: Array<{ id: string; kind: string }> = []

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bettercallcompiler-run-'))

  await writeFile(
    join(fixture, 'hello.py'),
    'import sys\nprint("hello from python")\nprint("to stderr", file=sys.stderr)\n'
  )
  await writeFile(join(fixture, 'boom.py'), 'def boom():\n    raise ValueError("nope")\n\nboom()\n')
  await writeFile(
    join(fixture, 'page.html'),
    '<!doctype html><html><body><h1 id="headline">Bundled preview</h1></body></html>\n'
  )
  await writeFile(join(fixture, 'main.rs'), 'fn main() { println!("hi"); }\n')

  app = await electron.launch({ args: [MAIN_ENTRY, isolatedUserData('run'), `--folder=${fixture}`], cwd: APP_ROOT })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')

  toolchains = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      toolchain: { list: (r: Record<string, never>) => Promise<unknown> }
    }
    const result = (await bridge.toolchain.list({})) as {
      ok: boolean
      value?: { toolchains: Array<{ id: string; kind: string }> }
    }
    return result.value?.toolchains ?? []
  })
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

function kindOf(id: string): string {
  return toolchains.find((toolchain) => toolchain.id === id)?.kind ?? 'missing'
}

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

function consoleText() {
  return window.locator('#run-console .xterm-rows')
}

/** Opens a file from the explorer and runs it with Ctrl+F5. */
async function runFixture(name: string): Promise<void> {
  await row(name).click()
  await window.locator('.monaco-editor .view-lines').first().waitFor()
  await window.keyboard.press('Control+F5')
  await expect(window.locator('#panel')).toBeVisible()
  await expect(window.locator('#panel-output-view')).toBeVisible()
}

test('the panel exposes Terminal and Output as separate views', async () => {
  await expect(window.locator('#panel')).toBeHidden()

  await window.keyboard.press('Control+`')
  // Terminal, Output and Problems.
  await expect(window.locator('.panel-view-tab')).toHaveCount(3)
  await expect(window.locator('.panel-view-tab--active')).toHaveText('Terminal')

  await window.locator('.panel-view-tab', { hasText: 'Output' }).click()
  await expect(window.locator('.panel-view-tab--active')).toHaveText('Output')
  await expect(window.locator('#run-console')).toBeVisible()

  // Step 5's session tabs must keep their own class; the view tabs are not them.
  await expect(window.locator('#panel-output-view .panel-tab')).toHaveCount(0)
})

test('names the file type it cannot run instead of showing an empty console', async () => {
  await runFixture('main.rs')

  const banner = window.locator('#run-banner')
  await expect(banner).toBeVisible()
  await expect(banner.locator('.run-banner__badge')).toHaveText('unavailable')
  await expect(banner).toHaveClass(/run-banner--unsupported/)
  await expect(banner.locator('.run-banner__text')).toContainText('.rs')
})

test('runs HTML on the bundled web pack with no toolchain installed', async () => {
  await runFixture('page.html')

  const banner = window.locator('#run-banner')
  await expect(banner.locator('.run-banner__badge')).toHaveText('bundled')
  await expect(banner).toHaveClass(/run-banner--bundled/)

  // The preview really rendered the markup, inside a sandboxed frame.
  const frame = window.locator('#run-preview .run-preview__frame')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('sandbox', '')
  await expect(window.frameLocator('.run-preview__frame').locator('#headline')).toHaveText(
    'Bundled preview'
  )

  await expect(consoleText()).toContainText('bundled web runtime')
  // Being explicit that scripts do not run is the product requirement, not a
  // caveat to bury.
  await expect(consoleText()).toContainText('Scripts are not executed')
})

test('runs a Python file on the real interpreter and streams both pipes', async () => {
  test.skip(kindOf('python') !== 'real', 'no usable Python on this machine')

  await runFixture('hello.py')

  const banner = window.locator('#run-banner')
  await expect(banner.locator('.run-banner__badge')).toHaveText('toolchain')
  await expect(banner).toHaveClass(/run-banner--real/)
  // The banner shows the resolved argv, not the word "python".
  await expect(banner.locator('.run-banner__text')).toContainText('hello.py')

  await expect(consoleText()).toContainText('hello from python', { timeout: 20_000 })
  await expect(consoleText()).toContainText('to stderr')
  await expect(consoleText()).toContainText('exited cleanly')
})

test('reports a non-zero exit rather than reporting success', async () => {
  test.skip(kindOf('python') !== 'real', 'no usable Python on this machine')

  await runFixture('boom.py')

  await expect(consoleText()).toContainText('ValueError', { timeout: 20_000 })
  await expect(consoleText()).toContainText('exited with code 1')
})

test('a traceback location is clickable and reveals the line in Monaco', async () => {
  test.skip(kindOf('python') !== 'real', 'no usable Python on this machine')

  await runFixture('boom.py')
  await expect(consoleText()).toContainText('ValueError', { timeout: 20_000 })

  // xterm paints text into spans but handles the mouse on `.xterm-screen`, which
  // sits on top of them — so a Playwright click on the span itself is
  // intercepted. Drive real mouse coordinates instead, over the *traceback*
  // frame rather than the dimmed header that merely repeats the file name.
  const frameRow = window
    .locator('#run-console .xterm-rows > div')
    .filter({ hasText: 'line 2' })
    .first()
  const target = frameRow.getByText(/boom\.py/).first()

  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2

  // Hovering is what makes xterm resolve the link under the cursor.
  await window.mouse.move(x, y)
  await window.mouse.click(x, y)

  // The traceback's deepest frame is the `raise` on line 2.
  await expect(window.locator('.tab--active')).toContainText('boom.py')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('raise ValueError')

  // One tab, not two. The run view assembles the path from what the tool
  // printed, so it is forward-slashed where the explorer's is not — if the
  // editor keyed documents on the raw string, this would open a second tab
  // sharing the first one's model.
  await expect(window.locator('.tab', { hasText: 'boom.py' })).toHaveCount(1)
})

test('a Store stub produces the guidance banner rather than a generic failure', async () => {
  test.skip(kindOf('python') !== 'store-stub', 'Python on this machine is not the Store stub')

  await runFixture('hello.py')

  const banner = window.locator('#run-banner')
  await expect(banner.locator('.run-banner__badge')).toHaveText('unavailable')
  await expect(banner.locator('.run-banner__text')).toContainText(
    'Microsoft Store alias stub'
  )
  await expect(banner.locator('.run-banner__text')).toContainText('python.org')
})

test('Cancel is offered only while a run is in flight', async () => {
  // The unsupported path finishes synchronously, so the button must be gone.
  await runFixture('main.rs')
  await expect(window.locator('.run-action', { hasText: 'Cancel' })).toBeHidden()
  await expect(window.locator('.run-action', { hasText: 'Run' })).toBeEnabled()
})

test('Clear empties the console', async () => {
  await runFixture('page.html')
  await expect(consoleText()).toContainText('bundled web runtime')

  await window.locator('.icon-button[aria-label="Clear Output"]').click()
  await expect(consoleText()).not.toContainText('bundled web runtime')
  await expect(window.locator('#run-preview')).toBeHidden()
})
