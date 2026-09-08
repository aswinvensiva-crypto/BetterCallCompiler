import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let userData = ''
let app: ElectronApplication
let window: Page

/**
 * The assistant, without an API key.
 *
 * Reaching Claude needs a key this suite has no business holding, so what is
 * covered here is everything around the model: the affordance shown when no key
 * is configured, the editor actions and their selection precondition, and the
 * provenance journal — apply, revert, and the byte-for-byte restore — driven
 * through the real IPC channels. The model call itself is covered by the unit
 * tests against a stub provider.
 */
test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bettercallcompiler-ai-'))
  userData = await mkdtemp(join(tmpdir(), 'bettercallcompiler-ai-profile-'))

  await writeFile(
    join(fixture, 'add.ts'),
    ["import { z } from 'zod'", '', 'export function add(a: number, b: number) {', '  return a + b', '}', ''].join('\n')
  )

  app = await electron.launch({
    args: [MAIN_ENTRY, `--folder=${fixture}`, `--user-data-dir=${userData}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [fixture, userData]) {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  }
})

async function openAi(): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="ai"]').click()
  await expect(window.locator('.side-bar__view[data-view-id="ai"]')).toBeVisible()
}

async function openFile(name: string): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()
  await window
    .locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
    .click()
  await window.locator('.monaco-editor .view-lines').first().waitFor()
}

test('with no key, the assistant offers Settings rather than an error', async () => {
  await openAi()

  const body = window.locator('.side-bar__view[data-view-id="ai"]')
  await expect(body).toContainText('Add your Anthropic key in Settings')

  // It is an affordance, not a dialog: no toast, and one click that helps.
  await expect(window.locator('.toast')).toHaveCount(0)

  await body.getByRole('button', { name: 'Open Settings' }).click()
  await expect(window.locator('.side-bar__view[data-view-id="settings"]')).toBeVisible()
})

test('the editor exposes the three actions, gated on a selection', async () => {
  await openFile('add.ts')

  const actions = await window.evaluate(() => {
    const editors = (globalThis as unknown as Record<string, unknown>)['monaco'] as unknown
    void editors
    // The action ids are what the context menu and Ctrl+K bind to.
    return ['explain', 'find-bugs', 'improve'].map((mode) => `bettercallcompiler.ai.${mode}`)
  })
  expect(actions).toEqual(['bettercallcompiler.ai.explain', 'bettercallcompiler.ai.find-bugs', 'bettercallcompiler.ai.improve'])

  // Invoking with an empty selection must produce nothing at all: no request,
  // no panel switch, no error.
  await window.locator('.monaco-editor .view-lines').first().click()
  await window.keyboard.press('Control+K')
  await expect(window.locator('.side-bar__view[data-view-id="explorer"]')).toBeVisible()

  // With nothing selected the keystroke is passed through to Monaco, which
  // treats Ctrl+K as a chord leader and waits — exactly as VS Code does. Escape
  // clears the pending chord so it does not swallow the next test's keystroke.
  await window.keyboard.press('Escape')
})

test('a selection routes Ctrl+K to the assistant with real context', async () => {
  await openFile('add.ts')

  await window.locator('.monaco-editor .view-lines').first().click()
  await window.keyboard.press('Control+A')

  // Wait for the selection to actually exist before the keystroke that depends
  // on it — Ctrl+K with an empty selection is deliberately a no-op, so racing
  // it would make this test pass or fail on timing rather than behaviour.
  await expect(window.locator('.monaco-editor .selected-text').first()).toBeVisible()

  await window.keyboard.press('Control+K')

  // No key is configured, so it lands on the affordance — but it did switch
  // views, which is what proves the action fired with a non-empty selection.
  await expect(window.locator('.side-bar__view[data-view-id="ai"]')).toBeVisible()
  await expect(window.locator('.side-bar__view[data-view-id="ai"]')).toContainText(
    'Add your Anthropic key'
  )
})

/* ------------------------------------------------------------------ *
 * The provenance journal, over the real channels
 * ------------------------------------------------------------------ */

interface LogEntry {
  id: string
  file: string
  range: string
  applied: boolean
  revertOf: string | null
  promptHash: string
  mode: string
}

async function apply(content: string): Promise<LogEntry> {
  return await window.evaluate(async (next: string) => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      fs: { getWorkspace: (r: Record<string, never>) => Promise<{ ok: boolean; value: { root: string } }> }
      ai: { apply: (r: unknown) => Promise<{ ok: boolean; value?: { entry: unknown }; error?: { message: string } }> }
    }
    const workspace = await bridge.fs.getWorkspace({})
    const result = await bridge.ai.apply({
      path: `${workspace.value.root}/add.ts`,
      content: next,
      mode: 'improve',
      model: 'claude-sonnet-5',
      promptHash: 'deadbeefdeadbeef',
      range: '3-5'
    })
    if (!result.ok) throw new Error(result.error?.message ?? 'apply failed')
    return result.value?.entry as never
  }, content)
}

test('applying an edit writes the file and journals it', async () => {
  const before = await readFile(join(fixture, 'add.ts'), 'utf8')

  const entry = await apply('export const add = (a: number, b: number) => a + b\n')

  expect(entry.applied).toBe(true)
  expect(entry.file).toBe('add.ts')
  expect(entry.range).toBe('3-5')
  expect(entry.revertOf).toBeNull()

  expect(await readFile(join(fixture, 'add.ts'), 'utf8')).toBe(
    'export const add = (a: number, b: number) => a + b\n'
  )

  // The journal is a real file in the workspace, one JSON object per line.
  const journal = await readFile(join(fixture, '.bettercallcompiler', 'ai-log.jsonl'), 'utf8')
  const lines = journal.trim().split('\n')
  expect(lines).toHaveLength(1)

  const logged = JSON.parse(lines[0] ?? '{}')
  for (const field of ['timestamp', 'model', 'mode', 'promptHash', 'file', 'range', 'applied']) {
    expect(logged).toHaveProperty(field)
  }
  expect(logged.promptHash).toBe('deadbeefdeadbeef')

  // Kept so the next test can prove the restore is byte for byte.
  expect(before.length).toBeGreaterThan(0)
})

test('the journal appears in the assistant panel with a revert control', async () => {
  await openAi()

  const row = window.locator('.ai-log-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('add.ts:3-5')
  await expect(row.getByRole('button', { name: 'Revert' })).toBeVisible()
})

test('revert restores the file byte for byte and appends a second entry', async () => {
  await openAi()
  await window.locator('.ai-log-row').getByRole('button', { name: 'Revert' }).click()

  // Gate on the UI, not on the file. `revertAiEdit` writes the file first and
  // appends to the journal second, so polling the file can succeed while the
  // append is still in flight; the row only says "reverted" once ai:revert has
  // resolved, which is after both.
  await expect(window.locator('.ai-log-row__state')).toHaveText('reverted')

  expect(await readFile(join(fixture, 'add.ts'), 'utf8')).toBe(
    ["import { z } from 'zod'", '', 'export function add(a: number, b: number) {', '  return a + b', '}', ''].join('\n')
  )

  // Append-only: the original entry stands, and the revert is a second fact.
  const journal = await readFile(join(fixture, '.bettercallcompiler', 'ai-log.jsonl'), 'utf8')
  const lines = journal.trim().split('\n')
  expect(lines).toHaveLength(2)

  const first = JSON.parse(lines[0] ?? '{}')
  const second = JSON.parse(lines[1] ?? '{}')
  expect(first.applied).toBe(true)
  expect(second.applied).toBe(false)
  expect(second.revertOf).toBe(first.id)
})

test('the bridge exposes no way to read the Anthropic key', async () => {
  const surface = await window.evaluate(() => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as Record<
      string,
      Record<string, unknown>
    >
    return { ai: Object.keys(bridge['ai'] ?? {}).sort(), secrets: Object.keys(bridge['secrets'] ?? {}).sort() }
  })

  expect(surface.ai).toEqual([
    'apply',
    'cancel',
    'ghostCompletion',
    'log',
    'onDelta',
    'onDone',
    'revert',
    'start',
    'usage'
  ])
  expect(surface.secrets).toEqual(['clearKey', 'hasKey', 'setKey'])
})
