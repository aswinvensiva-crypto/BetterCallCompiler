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
 * The compiler daemon, end to end.
 *
 * The claim under test is the one the whole feature exists for: editing one
 * file makes an error appear in a DIFFERENT file that imports it, without that
 * file being opened, edited or saved. Nothing here is stubbed — real chokidar,
 * real worker_thread, real TypeScript LanguageService, real Monaco markers.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const LIB_OK = 'export function greet(name: string): string {\n  return `hi ${name}`\n}\n'
const LIB_BROKEN = 'export function greet(name: number): string {\n  return `hi ${name}`\n}\n'
const APP_TS = "import { greet } from './lib'\nconsole.log(greet('world'))\n"

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

/** Diagnostics are debounced and a full check takes real time. */
const DAEMON_TIMEOUT = 25_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-problems-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(
    join(fixture, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler'
      },
      include: ['src']
    })
  )
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_OK)
  await writeFile(join(fixture, 'src', 'app.ts'), APP_TS)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('problems'), `--folder=${fixture}`],
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

async function openProblems(): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="problems"]').click()
  await expect(window.locator('#panel-problems-view')).toBeVisible()
}

const problemRows = () => window.locator('.problems-row')
const problemGroups = () => window.locator('.problems-group__path')

test('indexes the workspace and reports a clean project', async () => {
  await openProblems()

  await expect(window.locator('.problems-chip')).toHaveText('idle', {
    timeout: DAEMON_TIMEOUT
  })
  await expect(problemGroups()).toHaveCount(0)

  const status = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)[
      'betterCallCompiler'
    ] as { compiler: { status: (r: Record<string, never>) => Promise<unknown> } }
    return (await bridge.compiler.status({})) as {
      ok: boolean
      value?: { status: { graph: { fileCount: number; tsconfigRelativePath: string | null } } }
    }
  })

  expect(status.ok).toBe(true)
  // The file list is seeded from the walked graph, so an include-less or
  // otherwise unhelpful tsconfig cannot leave the program empty.
  expect(status.value?.status.graph.fileCount).toBeGreaterThan(0)
  expect(status.value?.status.graph.tsconfigRelativePath).toBe('tsconfig.json')
})

/**
 * The proof. `src/app.ts` is never opened, edited or saved — only `lib.ts`
 * changes, and only on disk.
 */
test('an edit to one file reports an error in its dependent', async () => {
  await openProblems()
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_BROKEN)

  await expect(problemGroups()).toHaveText(['src/app.ts'], { timeout: DAEMON_TIMEOUT })
  await expect(window.locator('.problems-row__code')).toHaveText(['TS2345'])
  await expect(window.locator('.problems-summary')).toContainText('1 error')
})

test('clicking a row opens the file and moves the caret to the diagnostic', async () => {
  await openProblems()
  await expect(problemRows().first()).toBeVisible({ timeout: DAEMON_TIMEOUT })

  const position = await window.locator('.problems-row__position').first().textContent()
  expect(position).toMatch(/^\d+:\d+$/)

  await problemRows().first().click()

  // The file opens even though it was never touched by the user.
  await expect(window.locator('.tab', { hasText: 'app.ts' })).toHaveCount(1)
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('greet')
})

test('the diagnostic is drawn as a marker in the editor', async () => {
  // Squiggles are Monaco's own rendering of the markers the daemon published.
  await expect(window.locator('.monaco-editor .squiggly-error').first()).toBeVisible({
    timeout: DAEMON_TIMEOUT
  })
})

/**
 * The half everyone forgets. An empty diagnostics array is the "now clean"
 * signal; if it is treated as an empty batch and skipped, the squiggle and the
 * Problems row survive the fix forever.
 */
test('fixing the error clears both the row and the squiggle', async () => {
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_OK)

  await openProblems()
  await expect(problemGroups()).toHaveCount(0, { timeout: DAEMON_TIMEOUT })
  await expect(window.locator('.monaco-editor .squiggly-error')).toHaveCount(0, {
    timeout: DAEMON_TIMEOUT
  })
})

test('reports an import cycle as a warning naming both files', async () => {
  await writeFile(join(fixture, 'src', 'x.ts'), "import './y'\nexport const x = 1\n")
  await writeFile(join(fixture, 'src', 'y.ts'), "import './x'\nexport const y = 1\n")

  await openProblems()

  const cycleQuery = async (): Promise<number> =>
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as Record<string, unknown>)[
        'betterCallCompiler'
      ] as { compiler: { status: (r: Record<string, never>) => Promise<unknown> } }
      const result = (await bridge.compiler.status({})) as {
        value?: { status: { graph: { cycles: unknown[] } } }
      }
      return result.value?.status.graph.cycles.length ?? 0
    })

  await expect.poll(cycleQuery, { timeout: DAEMON_TIMEOUT }).toBeGreaterThan(0)
  await expect(window.locator('.problems-row__code', { hasText: 'TS-CYCLE' }).first()).toBeVisible({
    timeout: DAEMON_TIMEOUT
  })
})

test('restarting the daemon re-derives diagnostics rather than orphaning them', async () => {
  await rm(join(fixture, 'src', 'x.ts'), { force: true })
  await rm(join(fixture, 'src', 'y.ts'), { force: true })
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_BROKEN)
  await openProblems()
  await expect(problemGroups()).toHaveText(['src/app.ts'], { timeout: DAEMON_TIMEOUT })

  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)[
      'betterCallCompiler'
    ] as { compiler: { restart: (r: Record<string, never>) => Promise<unknown> } }
    await bridge.compiler.restart({})
  })

  // Markers are cleared on restart and rebuilt from the new worker, so their
  // reappearance proves they were re-derived rather than left behind.
  await expect(window.locator('.problems-chip')).toHaveText('idle', { timeout: DAEMON_TIMEOUT })
  await expect(problemGroups()).toHaveText(['src/app.ts'], { timeout: DAEMON_TIMEOUT })
})

/**
 * The daemon is a Node worker_thread in the MAIN process, not a web worker in
 * the renderer. If anyone "simplifies" it into the renderer later, the CSP
 * (`script-src 'self'`, `connect-src 'none'`) will reject it and this fails.
 */
test('runs with no CSP violations or console errors', async () => {
  const csp = consoleProblems.filter((message) =>
    /content security policy|refused to|worker-src|blob:/i.test(message)
  )
  expect(csp).toEqual([])
  expect(consoleProblems).toEqual([])
})
