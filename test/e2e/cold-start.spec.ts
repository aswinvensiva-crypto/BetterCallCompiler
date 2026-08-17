import { test, expect, _electron as electron } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

/**
 * Cold start, defended by a number rather than by a claim.
 *
 * Three assertions, ordered by how much each one can flake. The bundle budget is
 * deterministic and is the real defence — it cannot be affected by a loaded
 * runner, and it is what catches a static `import * as monaco` creeping back in.
 * The ordering assertion is structural. The wall-clock ceilings are generous on
 * purpose; a tight bound on a shared Windows runner becomes the spec everyone
 * skips.
 *
 * Deliberately NOT asserted here: time to first diagnostic. That is a separate
 * and much larger number — essentially all ts program and checker construction —
 * and it belongs to the memo-cache work, not to a bundle split.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')
const ASSETS = join(APP_ROOT, 'out', 'renderer', 'assets')

/**
 * Generous, and overridable for a slow runner.
 *
 * Measured 2848-3500 ms spawn-to-ready over three warm launches on the machine
 * this was written on, with Monaco statically linked. A windows-latest runner is
 * slower and noisier than that.
 */
const READY_CEILING_MS = Number(process.env['BCC_COLD_START_CEILING_MS'] ?? 8000)
const SHELL_CEILING_MS = READY_CEILING_MS / 2

/**
 * The budget the split bought, with room for what is genuinely left.
 *
 * The entry was 10,175,482 bytes before Monaco moved out and is 2,574,744 after.
 * What remains is dominated by xterm, not Monaco. 3.5 MB leaves headroom for
 * ordinary growth while staying far below any regression that let the editor back
 * in — Monaco's core alone is over 7 MB, so a static import would blow through
 * this immediately rather than creeping up on it.
 */
const ENTRY_BUDGET_BYTES = 3_500_000

/**
 * Resolves the entry chunk the way the browser does.
 *
 * NOT by globbing `index-*.js`: since the split there are two files matching
 * that, the real entry and a Vite dependency-map preload helper that is also
 * named index. Reading the script tag is the only way to know which one actually
 * loads, and it is what a regression would have to lie about to pass.
 */
async function entryChunk(): Promise<{ name: string; source: string }> {
  const html = await readFile(join(APP_ROOT, 'out', 'renderer', 'index.html'), 'utf8')
  const match = /src="\.\/assets\/(index-[^"]+\.js)"/.exec(html)
  expect(match, 'index.html should load an entry chunk from ./assets').not.toBeNull()

  const name = match?.[1] ?? ''
  return { name, source: await readFile(join(ASSETS, name), 'utf8') }
}

test('the renderer entry chunk stays within its budget and carries no editor', async () => {
  const { name, source } = await entryChunk()
  const bytes = Buffer.byteLength(source, 'utf8')

  console.log(`cold-start: entry chunk ${name} is ${bytes} bytes`)
  expect(bytes).toBeLessThan(ENTRY_BUDGET_BYTES)

  // `monaco-list-row` is emitted by Monaco's list widget and appears nowhere in
  // src/renderer, so unlike 'monaco-editor', 'suggestWidget' or
  // 'editorHoverWidget' it cannot false-positive on our own source — those last
  // two are in the theme colour table and legitimately stay in the entry.
  expect(source).not.toContain('monaco-list-row')
  // The editor widget classes themselves, for the same reason.
  expect(source).not.toContain('StandaloneCodeEditor')
  expect(source).not.toContain('CodeEditorWidget')

  // And it did not simply vanish from the build: it moved.
  const siblings = await readdir(ASSETS)
  const carriers: string[] = []
  for (const file of siblings) {
    if (!file.endsWith('.js') || file === name) continue
    const contents = await readFile(join(ASSETS, file), 'utf8')
    if (contents.includes('monaco-list-row')) carriers.push(file)
  }
  expect(carriers.length, `expected a sibling chunk to carry Monaco, got ${carriers.join()}`)
    .toBeGreaterThan(0)
})

test('the shell is interactive before the editor finishes loading', async ({}, testInfo) => {
  const spawnedAt = Date.now()
  const app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('cold-start')],
    cwd: APP_ROOT
  })

  try {
    const window = await app.firstWindow()

    await window.waitForSelector('html[data-bettercallcompiler-shell="true"]', {
      timeout: READY_CEILING_MS
    })
    const shellMs = Date.now() - spawnedAt

    await window.waitForSelector('html[data-bettercallcompiler-ready="true"]', {
      timeout: READY_CEILING_MS
    })
    const readyMs = Date.now() - spawnedAt

    // Typed structurally: this file compiles under tsconfig.node.json, which
    // carries no DOM lib, so `Performance` and `PerformanceEntry` are not names
    // here. Same reason the bridge lookups in the other specs are written this way.
    const firstPaintMs = await window.evaluate(() => {
      const perf = (
        globalThis as unknown as {
          performance: {
            getEntriesByType(type: string): { name: string; startTime: number }[]
          }
        }
      ).performance

      return (
        perf.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint')
          ?.startTime ?? null
      )
    })

    console.log(
      `cold-start: shell ${shellMs}ms, ready ${readyMs}ms, first-contentful-paint ${
        firstPaintMs === null ? 'absent' : `${Math.round(firstPaintMs)}ms`
      }`
    )
    await testInfo.attach('cold-start.json', {
      body: JSON.stringify({ shellMs, readyMs, firstPaintMs }, null, 2),
      contentType: 'application/json'
    })

    // The ordering is the claim: the shell is up first, and the editor follows.
    expect(shellMs).toBeLessThanOrEqual(readyMs)

    // Paint happened, and happened before the shell marker rather than being
    // starved behind the module script the way it was when Monaco was static.
    expect(firstPaintMs).not.toBeNull()
    expect(firstPaintMs ?? Number.POSITIVE_INFINITY).toBeLessThan(shellMs)

    expect(shellMs).toBeLessThan(SHELL_CEILING_MS)
    expect(readyMs).toBeLessThan(READY_CEILING_MS)
  } finally {
    await app.close()
  }
})
