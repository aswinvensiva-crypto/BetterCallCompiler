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
 * Explanations, end to end.
 *
 * The model call itself is not exercised — there is no API key in CI, and the
 * provider seam is already covered by the AI suite. Everything AROUND it is,
 * because that is where this feature actually lives: an explanation that
 * persists across a restart, cites code you can click, knows when that code has
 * changed underneath it, and carries a comment thread.
 *
 * Artifacts are created through the bridge rather than through the editor
 * action for the same reason: the action's only job is to start a stream, and a
 * stream needs a key.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const SOURCE = ['export function greet(name: string) {', '  return `hi ${name}`', '}', ''].join('\n')

const MARKDOWN = [
  'The module exposes one greeting helper.',
  '',
  '## What it does',
  'It formats a greeting. [[src/lib.ts:1-3 greet]]',
  '',
  '## Edge cases',
  'An empty name yields a trailing space. [[src/lib.ts:2]]'
].join('\n')

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-artifacts-e2e-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'lib.ts'), SOURCE)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('artifacts'), `--folder=${fixture}`],
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

async function openArtifacts(): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="artifacts"]').click()
  await expect(window.locator('.side-bar__view[data-view-id="artifacts"]')).toBeVisible()
}

/**
 * Opens the panel and makes sure the LIST is showing.
 *
 * The view deliberately remembers which document you were reading — that is the
 * tool-window registry's stated contract, and re-clicking the activity icon
 * does not reset it. So a test that wants the list has to say so rather than
 * assuming a fresh panel, and one that does not ends up asserting against
 * whatever the previous test left on screen.
 */
async function openList(): Promise<void> {
  await openArtifacts()
  const back = window.locator('.artifact-back')
  if (await back.isVisible()) await back.click()
  await expect(window.locator('.artifact-list, .explorer__empty-text').first()).toBeVisible()
}

/** Opens the artifact whose row title matches, from the list. */
async function openArtifactRow(index = 0): Promise<void> {
  await openList()
  await window.locator('.artifact-row').nth(index).click()
  await expect(window.locator('.artifact-title')).toBeVisible()
}

/** Writes an artifact through the bridge, exactly as the renderer does. */
async function createArtifact(markdown = MARKDOWN, supersedes: string | null = null) {
  return window.evaluate(
    async ([body, prior]) => {
      const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
        artifact: {
          create: (r: Record<string, unknown>) => Promise<{
            ok: boolean
            value?: { artifact: { id: string; sections: { id: string }[] } }
            error?: { message: string }
          }>
        }
      }
      return bridge.artifact.create({
        kind: 'explanation',
        title: 'greet in src/lib.ts',
        model: 'claude-sonnet-5',
        promptHash: 'deadbeefdeadbeef',
        contextSent: 'File: src/lib.ts\nSelection: lines 1-3',
        markdown: body,
        supersedes: prior,
        answersCommentId: null
      })
    },
    [markdown, supersedes] as const
  )
}

test('the panel explains how to make one before any exist', async () => {
  await openArtifacts()

  const view = window.locator('.side-bar__view[data-view-id="artifacts"]')
  await expect(view.locator('.explorer__empty-text')).toContainText('Explain as Artifact')
})

test('a stored explanation renders with clickable, hash-checked citations', async () => {
  const created = await createArtifact()
  expect(created.ok).toBe(true)

  await openArtifactRow()

  await expect(window.locator('.artifact-title')).toHaveText('greet in src/lib.ts')

  // The leading summary before the first heading survived, and both headings
  // became sections.
  await expect(window.locator('.artifact-section')).toHaveCount(3)
  await expect(window.locator('.artifact-para').first()).toContainText(
    'The module exposes one greeting helper.'
  )

  const anchors = window.locator('.artifact-anchor')
  await expect(anchors).toHaveCount(2)
  await expect(anchors.first()).toHaveText(/src\/lib\.ts:1-3/)
  // Nothing has changed yet, so both anchors are current.
  await expect(window.locator('.artifact-anchor--stale')).toHaveCount(0)
})

test('clicking a citation opens the file at that line', async () => {
  await openArtifactRow()
  await window.locator('.artifact-anchor').first().click()

  // The cited file is open and in front, not merely loaded somewhere.
  await expect(window.locator('.tab--active')).toContainText('lib.ts')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('export function greet')
})

/**
 * The claim that makes a durable explanation trustworthy. Without it, an
 * artifact read later points confidently at whatever now occupies those lines.
 */
test('an edit to the cited code marks the anchor stale, not silently wrong', async () => {
  await writeFile(
    join(fixture, 'src', 'lib.ts'),
    ['export function greet(name: string) {', '  return `good evening ${name}`', '}', ''].join('\n')
  )

  // Re-opened rather than merely re-rendered: anchor states are computed on
  // read, so the document has to be fetched again to notice.
  await openArtifactRow()

  await expect(window.locator('.artifact-anchor--stale')).toHaveCount(2)
  await expect(window.locator('.artifact-anchor--stale').first()).toContainText('stale')
})

test('a comment persists against the section it was left on', async () => {
  await openArtifactRow()

  const section = window.locator('.artifact-section').nth(1)
  await section.locator('.artifact-commentbox__input').fill('Does this handle an empty name?')
  await section.getByRole('button', { name: 'Comment', exact: true }).click()

  await expect(window.locator('.artifact-comment__body')).toHaveText(
    'Does this handle an empty name?'
  )
  // Unanswered until the agent replies — stated, not implied by absence.
  await expect(window.locator('.artifact-comment__state')).toHaveText('Not yet answered')

  // And it is on the record, not just on screen.
  const stored = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      artifact: {
        list: (r: Record<string, never>) => Promise<{
          ok: boolean
          value?: { artifacts: { commentCount: number; unansweredCommentCount: number }[] }
        }>
      }
    }
    return bridge.artifact.list({})
  })
  expect(stored.value?.artifacts[0]?.commentCount).toBe(1)
  expect(stored.value?.artifacts[0]?.unansweredCommentCount).toBe(1)
})

test('a revision is linked to what it supersedes, in both directions', async () => {
  const first = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      artifact: {
        list: (r: Record<string, never>) => Promise<{
          ok: boolean
          value?: { artifacts: { id: string }[] }
        }>
      }
    }
    return bridge.artifact.list({})
  })
  const originalId = first.value?.artifacts[0]?.id ?? ''
  expect(originalId).not.toBe('')

  const revision = await createArtifact('## Revised\nClearer now. [[src/lib.ts:1]]', originalId)
  expect(revision.ok).toBe(true)

  await openList()
  await expect(window.locator('.artifact-badge', { hasText: 'revision' })).toHaveCount(1)

  // Opening the revision offers a way back to what it replaced. It sorts first
  // because the list is newest-first.
  await openArtifactRow(0)
  await expect(window.locator('.artifact-supersedes')).toBeVisible()
  await window.locator('.artifact-supersedes').click()
  await expect(window.locator('.artifact-title')).toHaveText('greet in src/lib.ts')
})

/**
 * The guarantee the AI panel already makes, extended to a document that will be
 * read long after the conversation: what is shown is the stored string, not a
 * reconstruction that can drift from it.
 */
test('the exact context sent to the model is stored with the explanation', async () => {
  await openArtifactRow(1)

  await window.locator('.artifact-context summary').click()
  await expect(window.locator('.artifact-context__body')).toContainText('File: src/lib.ts')
})

test('explanations survive a reload of the window', async () => {
  await window.reload()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')

  await openList()
  await expect(window.locator('.artifact-row')).toHaveCount(2)
})

test('raises no console errors or CSP violations', async () => {
  const violations = consoleProblems.filter(
    (text) => text.includes('Content Security Policy') || text.includes('Refused to')
  )
  expect(violations).toEqual([])
  expect(consoleProblems).toEqual([])
})
