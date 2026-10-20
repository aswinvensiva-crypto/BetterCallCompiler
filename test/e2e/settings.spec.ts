import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')
const OS_KEYRING = join(__dirname, 'helpers', 'os-keyring.cjs')

let userData = ''
let app: ElectronApplication
let window: Page

/**
 * Secrets and preferences.
 *
 * `--user-data-dir` is not optional here. Without it these tests would write
 * secrets and preferences into the real profile of whoever runs the suite.
 */
test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'bettercallcompiler-profile-'))

  app = await electron.launch({
    // The key-storage specs need real encryption, which Playwright's launch
    // switches off on Linux; see helpers/os-keyring.cjs.
    args: ['-r', OS_KEYRING, MAIN_ENTRY, `--user-data-dir=${userData}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  if (userData !== '') await rm(userData, { recursive: true, force: true })
})

async function openSettings(): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="settings"]').click()
  await expect(window.locator('.side-bar__view[data-view-id="settings"]')).toBeVisible()
}

test('shows key presence, never a value', async () => {
  await openSettings()

  const fields = window.locator('.settings-field')
  await expect(fields.filter({ hasText: 'Anthropic API key' })).toBeVisible()
  await expect(fields.filter({ hasText: 'GitHub personal access token' })).toBeVisible()

  // Nothing stored yet.
  await expect(
    fields.filter({ hasText: 'Anthropic API key' }).locator('.settings-badge')
  ).toHaveText('not set')
})

test('stores a key, reports it as stored, and never renders it back', async () => {
  await openSettings()

  const field = window.locator('.settings-field').filter({ hasText: 'Anthropic API key' })
  const secret = 'sk-ant-test-DO-NOT-LEAK-0123456789'

  await field.locator('.settings-input').fill(secret)
  await field.locator('.button--primary').click()

  await expect(field.locator('.settings-badge')).toHaveText('stored')

  // The input is cleared, so the plaintext does not linger in the DOM.
  await expect(field.locator('.settings-input')).toHaveValue('')
  // And the placeholder says what the field would do, not what is in it.
  await expect(field.locator('.settings-input')).toHaveAttribute(
    'placeholder',
    'Replace stored key…'
  )

  // The secret appears nowhere in the rendered document.
  expect(await window.locator('body').innerText()).not.toContain(secret)

  // It is on disk, and it is not plaintext there either.
  const stored = await readFile(join(userData, 'secrets.json'), 'utf8')
  expect(stored).toContain('anthropic')
  expect(stored).not.toContain(secret)
})

test('the bridge exposes no way to read a stored secret back', async () => {
  const surface = await window.evaluate(() => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as Record<
      string,
      Record<string, unknown>
    >
    return Object.keys(bridge['secrets'] ?? {}).sort()
  })

  // Security invariant 9, checked against the live bridge rather than the table.
  expect(surface).toEqual(['clearKey', 'hasKey', 'setKey'])
})

test('removes a stored key', async () => {
  await openSettings()

  const field = window.locator('.settings-field').filter({ hasText: 'Anthropic API key' })
  await field.getByRole('button', { name: 'Remove' }).click()

  await expect(field.locator('.settings-badge')).toHaveText('not set')

  const stored = await readFile(join(userData, 'secrets.json'), 'utf8')
  expect(stored).not.toContain('anthropic')
})

test('persists a non-secret preference to userData', async () => {
  await openSettings()

  const field = window.locator('.settings-field').filter({ hasText: 'GitHub username' })
  await field.locator('.settings-input').fill('octocat')
  await field.locator('.settings-input').press('Enter')

  // Written to settings.json, separate from secrets.json by design.
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).githubUser
      } catch {
        return null
      }
    })
    .toBe('octocat')

  const files = await readdir(userData)
  expect(files).toContain('settings.json')
})
