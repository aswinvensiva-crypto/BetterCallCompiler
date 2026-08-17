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
 * The Compiler Intelligence view, end to end.
 *
 * The claim under test is the one that distinguishes this IDE: a body-only edit
 * to a module with a dependent must be REPORTED, in the UI, as having
 * type-checked fewer files than the invalidation walk named. Not "the panel
 * renders" — the panel showing a saving that actually occurred.
 *
 * Nothing is stubbed: real worker_thread, real LanguageService, real signature
 * hashing, real IPC. test/query/run-cutoff-proof.mjs proves the same mechanism
 * at the protocol level; this proves it survives the trip to the screen.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const LIB_ORIGINAL = 'export function greet(name: string): string {\n  return `hi ${name}`\n}\n'

/**
 * Two further versions, both with the SAME exported type and both textually
 * distinct from each other and from the original.
 *
 * Distinct bytes matter: rewriting a file with identical content does not
 * reliably produce a chokidar change event, so a warm-up write that only
 * restores the original silently does nothing and the test then asserts a
 * saving on a pass that never happened.
 */
const LIB_WARM = '// warm\nexport function greet(name: string): string {\n  return `hi ${name}`\n}\n'
const LIB_BODY_EDIT =
  '// warm\nexport function greet(name: string): string {\n  return `good evening, ${name}`\n}\n'
const APP_TS = "import { greet } from './lib'\nconsole.log(greet('world'))\n"

/**
 * Breaks the exported type, so app.ts — which the user never opened — reports a
 * real TS2345. That is precisely the case the Why feature exists for: an error in
 * a file you did not edit, needing an explanation of how your edit reached it.
 */
const LIB_SIGNATURE_EDIT =
  '// warm\nexport function greet(name: number): string {\n  return `hi ${name}`\n}\n'

let fixture = ''
let app: ElectronApplication
let window: Page

/** Indexing plus a full check takes real time on a cold worker. */
const DAEMON_TIMEOUT = 25_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-ci-'))
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
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_ORIGINAL)
  await writeFile(join(fixture, 'src', 'app.ts'), APP_TS)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('compiler-intelligence'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

async function openCompilerIntelligence(): Promise<void> {
  const view = window.locator('.right-dock__view[data-view-id="compiler"]')
  // Clicking the activity item TOGGLES the right dock, so a second click on an
  // already-open view would close it — the same guard the Visualizer specs use.
  if (!(await view.isVisible())) {
    await window.locator('.activity-bar__item[data-view-id="compiler"]').click()
  }
  await expect(view).toBeVisible()
}

function tab(label: string) {
  return window.locator('.ci-tabs__tab', { hasText: label })
}

interface PassSummary {
  readonly reason: string
  readonly trigger: readonly string[]
  readonly requested: number
  readonly recomputed: number
  readonly reused: number
  readonly events: readonly unknown[]
}

/** Reads the daemon's pass history through the bridge — the source of truth. */
async function passHistory(): Promise<PassSummary[]> {
  const result = await window.evaluate(() => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      compiler: {
        passes: (r: Record<string, never>) => Promise<{
          ok: boolean
          value?: { passes: PassSummary[] }
        }>
      }
    }
    return bridge.compiler.passes({})
  })
  return result.ok ? (result.value?.passes ?? []) : []
}

/**
 * Polls until the history satisfies `predicate`.
 *
 * Necessary rather than fussy. A DOM assertion on `.ci-stat` is satisfied by
 * ANY pass, including the cold one chokidar fires while the fixture is being
 * created — so waiting on the DOM and then reading history reads it before the
 * pass under test has happened. That race is what made the first version of
 * this spec fail against a daemon that was behaving correctly.
 */
async function waitForPass(
  predicate: (passes: PassSummary[]) => boolean,
  timeoutMs = DAEMON_TIMEOUT
): Promise<PassSummary[]> {
  const deadline = Date.now() + timeoutMs
  let latest: PassSummary[] = []

  while (Date.now() < deadline) {
    latest = await passHistory()
    if (predicate(latest)) return latest
    await window.waitForTimeout(250)
  }

  return latest
}

test('opens in the right dock with a working tab strip', async () => {
  await openCompilerIntelligence()

  await expect(window.locator('.right-dock__title-slot[data-view-id="compiler"]')).toContainText(
    'Compiler Intelligence'
  )
  await expect(window.locator('.ci-tabs__tab')).toHaveCount(4)
  await expect(tab('Live')).toHaveAttribute('aria-selected', 'true')
})

test('a body-only edit is reported as fewer files checked than requested', async () => {
  await openCompilerIntelligence()

  // Warm the memo table first. The very first check of these files is a cold
  // miss by definition, and asserting a saving on it would be asserting
  // something that cannot be true.
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_WARM)
  const warmed = await waitForPass((passes) => passes.length > 0)
  expect(warmed.length).toBeGreaterThan(0)

  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_BODY_EDIT)

  // Waited for by content, not by elapsed time: a pass in which the type
  // checker was skipped for at least one file.
  const history = await waitForPass((passes) => passes.some((pass) => pass.reused > 0))

  const reusing = history.filter((pass) => pass.reused > 0)
  expect(reusing.length).toBeGreaterThan(0)

  // A reusing pass must have checked strictly fewer files than it was asked
  // about. That inequality IS the feature.
  for (const pass of reusing) {
    expect(pass.recomputed).toBeLessThan(pass.requested)
  }

  // And it must reach the screen, not just the bridge. The headline sentence is
  // the user-visible form of the same claim.
  await expect(window.locator('.ci-headline')).toContainText('answered from memo', {
    timeout: DAEMON_TIMEOUT
  })
})

test('the Why tab explains each decision in words', async () => {
  await openCompilerIntelligence()
  // Data first, then the tab. Clicking into a tab before any pass exists
  // renders the empty state, and nothing re-renders it afterwards unless a
  // further pass happens to arrive — so the wait has to come first.
  await waitForPass((passes) => passes.some((pass) => pass.events.length > 0))
  await tab('Why').click()

  await expect(window.locator('.ci-trace__row').first()).toBeVisible({ timeout: DAEMON_TIMEOUT })

  // Every row carries a sentence, not just a tag and a number. The sentence is
  // the only part a person cannot reconstruct from the rest of the row.
  const first = window.locator('.ci-trace__row').first()
  await expect(first.locator('.ci-tag')).toBeVisible()
  await expect(first.locator('.ci-trace__key')).toContainText(':')
  await expect(first.locator('.ci-trace__why')).not.toHaveText('')
})

test('the Hotspots tab ranks files by time spent', async () => {
  await openCompilerIntelligence()
  await waitForPass((passes) => passes.some((pass) => pass.events.length > 0))
  await tab('Hotspots').click()

  await expect(window.locator('.ci-table__row').first()).toBeVisible({ timeout: DAEMON_TIMEOUT })
  await expect(window.locator('.ci-table__path').first()).toContainText('.ts')
})

test('the History tab lists passes newest first', async () => {
  await openCompilerIntelligence()
  await waitForPass((passes) => passes.length > 0)
  await tab('History').click()

  const rows = window.locator('.ci-history__row')
  await expect(rows.first()).toBeVisible({ timeout: DAEMON_TIMEOUT })

  const ids = await window.locator('.ci-history__id').allTextContents()
  const numeric = ids.map((text) => Number(text.replace('#', '')))
  const descending = [...numeric].sort((a, b) => b - a)
  expect(numeric).toEqual(descending)
})

test('the panel never asks the daemon to do work', async () => {
  // A view that could trigger a check would put itself on the typing hot path,
  // which is the one thing an observability panel must not do. The bridge
  // exposes exactly one compiler method this view calls, and it is a read.
  await openCompilerIntelligence()

  const before = await window.evaluate(() => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      compiler: { status: (r: Record<string, never>) => Promise<{ ok: boolean; value?: { status: { checkedFileCount: number } } }> }
    }
    return bridge.compiler.status({})
  })

  await tab('Live').click()
  await tab('Why').click()
  await tab('Hotspots').click()
  await tab('History').click()

  const after = await window.evaluate(() => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      compiler: { status: (r: Record<string, never>) => Promise<{ ok: boolean; value?: { status: { checkedFileCount: number } } }> }
    }
    return bridge.compiler.status({})
  })

  expect(after.value?.status.checkedFileCount).toBe(before.value?.status.checkedFileCount)
})

test('a diagnostic explains why its file was rechecked', async () => {
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB_SIGNATURE_EDIT)

  // Waited for by trigger, not by DOM. Any pass satisfies a DOM assertion,
  // including the cold one, so reading the panel first would race the pass under
  // test — the same mistake that made an earlier version of this file's specs pass
  // against a daemon doing nothing.
  await waitForPass((history) =>
    history.some((pass) => pass.trigger.includes('src/lib.ts') && pass.requested >= 2)
  )

  await window.locator('.activity-bar__item[data-view-id="problems"]').click()
  await expect(window.locator('#panel-problems-view')).toBeVisible()

  const appRow = window
    .locator('.problems-row')
    .filter({ has: window.locator('.problems-row__code', { hasText: 'TS2345' }) })
    .first()
  await expect(appRow).toBeVisible({ timeout: DAEMON_TIMEOUT })

  await appRow.locator('.problems-row__why').click()

  // The dock opens on the Why tab, focused on the file that was NOT edited.
  await expect(window.locator('.right-dock__view[data-view-id="compiler"]')).toBeVisible()
  await expect(tab('Why')).toHaveAttribute('aria-selected', 'true')
  await expect(window.locator('.ci-why__file')).toHaveText('src/app.ts')

  // The trigger sentence names the edit, whichever note it lands in and whether
  // or not this pass also happened to be the cold one. Asserted on the container
  // with the daemon timeout rather than on `.ci-note` first(): run in isolation the
  // signature edit IS the first check, so the sentence gains a clause and the note
  // order is not something this test should be pinning.
  const why = window.locator('.ci-why')
  await expect(why).toContainText('src/lib.ts', { timeout: DAEMON_TIMEOUT })

  const chain = window.locator('.ci-why__chain')
  await expect(chain).toContainText('src/lib.ts', { timeout: DAEMON_TIMEOUT })
  await expect(chain).toContainText('src/app.ts')

  // And the outcome sentence — the part of the answer that cannot be derived from
  // the numbers — is present rather than an empty list.
  await expect(window.locator('.ci-why .ci-trace__why').first()).not.toBeEmpty()

  // A hop opens that file, so the chain is navigation rather than decoration.
  await window.locator('.ci-why__hop', { hasText: 'src/lib.ts' }).click()
  await expect(window.locator('.tab--active')).toContainText('lib.ts')
})
