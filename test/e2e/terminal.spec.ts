import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let fixture = ''
let app: ElectronApplication
let window: Page

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bettercallcompiler-terminal-'))
  app = await electron.launch({ args: [MAIN_ENTRY, `--folder=${fixture}`], cwd: APP_ROOT })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

function terminalText() {
  return window.locator('.terminal-instance:not([hidden]) .xterm-rows')
}

/**
 * This is the check that proves node-pty's Node-API prebuild really loads
 * inside Electron's main process — no compiler, no @electron/rebuild.
 */
test('Ctrl+` opens a real shell that reaches a prompt', async () => {
  await expect(window.locator('#panel')).toBeHidden()

  await window.keyboard.press('Control+`')

  await expect(window.locator('#panel')).toBeVisible()
  await expect(window.locator('.terminal-instance')).toHaveCount(1)
  await expect(window.locator('.xterm')).toBeVisible()

  // A prompt means the shell process actually started and wrote to the PTY.
  await expect(terminalText()).toContainText(/>|\$|#/, { timeout: 20_000 })
})

test('runs a command and shows its output', async () => {
  await window.locator('.terminal-instance:not([hidden])').click()
  await window.keyboard.type('node -v')
  await window.keyboard.press('Enter')

  // `node -v` prints vXX.Y.Z — proof the PTY is a working shell, not an echo box.
  await expect(terminalText()).toContainText(/v\d+\.\d+\.\d+/, { timeout: 25_000 })
})

test('opens a second session and switches between them', async () => {
  await window.locator('.icon-button[aria-label="New Terminal"]').click()

  await expect(window.locator('.terminal-instance')).toHaveCount(2)
  await expect(window.locator('.terminal-instance:not([hidden])')).toHaveCount(1)
  await expect(window.locator('.panel-tab')).toHaveCount(2)
  await expect(window.locator('.panel-tab--active')).toHaveCount(1)

  await window.locator('.panel-tab').first().click()
  await expect(window.locator('.panel-tab--active')).toHaveText(/pwsh|powershell|cmd|bash|zsh/)
})

test('reports the shell it chose', async () => {
  const sessions = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      terminal: { list: (r: Record<string, never>) => Promise<unknown> }
    }
    return (await bridge.terminal.list({})) as {
      ok: boolean
      value?: { sessions: Array<{ id: string; shellName: string; shellPath: string }> }
    }
  })

  expect(sessions.ok).toBe(true)
  expect(sessions.value?.sessions.length).toBe(2)
  // Windows must prefer PowerShell over cmd.
  const first = sessions.value?.sessions[0]
  expect(first?.shellName).toMatch(/pwsh|powershell|bash|zsh|sh/)
  expect(first?.shellPath.length).toBeGreaterThan(0)
})

test('closes a session and disposes its PTY', async () => {
  await window.locator('.icon-button[aria-label="Close Terminal"]').click()

  await expect(window.locator('.terminal-instance')).toHaveCount(1)
  await expect(window.locator('.panel-tab')).toHaveCount(1)

  const remaining = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['betterCallCompiler'] as {
      terminal: { list: (r: Record<string, never>) => Promise<unknown> }
    }
    return (await bridge.terminal.list({})) as { ok: boolean; value?: { sessions: unknown[] } }
  })
  expect(remaining.value?.sessions.length).toBe(1)
})

test('Ctrl+` toggles the panel closed again', async () => {
  await window.keyboard.press('Control+`')
  await expect(window.locator('#panel')).toBeHidden()
})
