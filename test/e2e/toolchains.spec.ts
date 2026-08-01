import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

let app: ElectronApplication
let window: Page

/**
 * The toolchain probe reports whatever is installed on the machine running the
 * suite, so nothing here asserts that a particular tool was found. What is
 * asserted is the contract: six tools are always reported, every record is
 * well-formed, and the classification is one the renderer knows how to draw.
 */
test.beforeAll(async () => {
  app = await electron.launch({ args: [MAIN_ENTRY], cwd: APP_ROOT })
  window = await app.firstWindow()
  await window.waitForSelector('html[data-aperture-ready="true"]')
})

test.afterAll(async () => {
  await app?.close()
})

const EXPECTED_IDS = ['node', 'python', 'gcc', 'g++', 'tsc', 'docker']

interface ToolchainRecord {
  id: string
  label: string
  found: boolean
  path: string | null
  version: string | null
  kind: string
  guidance: string | null
}

async function probe(channel: 'list' | 'rescan'): Promise<ToolchainRecord[]> {
  return await window.evaluate(async (method: 'list' | 'rescan') => {
    const bridge = (globalThis as unknown as Record<string, unknown>)['aperture'] as {
      toolchain: Record<string, (r: Record<string, never>) => Promise<unknown>>
    }
    const call = bridge.toolchain[method]
    if (call === undefined) throw new Error(`no toolchain.${method}`)
    const result = (await call({})) as {
      ok: boolean
      value?: { toolchains: unknown[] }
    }
    if (!result.ok) throw new Error('probe failed')
    return result.value?.toolchains as never
  }, channel)
}

test('probes every declared toolchain and returns well-formed records', async () => {
  const toolchains = await probe('list')

  expect(toolchains.map((toolchain) => toolchain.id)).toEqual(EXPECTED_IDS)

  for (const toolchain of toolchains) {
    expect(['real', 'store-stub', 'unusable', 'missing']).toContain(toolchain.kind)
    expect(toolchain.label.length).toBeGreaterThan(0)

    // found and path agree, in both directions.
    expect(toolchain.found).toBe(toolchain.path !== null)
    expect(toolchain.found).toBe(toolchain.kind !== 'missing')

    // A missing tool has nothing to say about itself.
    if (toolchain.kind === 'missing') {
      expect(toolchain.version).toBeNull()
      expect(toolchain.guidance).toBeNull()
    }

    // Anything present but not usable must explain itself, or the indicator is
    // just a red dot the user cannot act on.
    if (toolchain.kind === 'store-stub' || toolchain.kind === 'unusable') {
      expect(toolchain.guidance).not.toBeNull()
      expect((toolchain.guidance ?? '').length).toBeGreaterThan(20)
    }

    if (toolchain.kind === 'real') {
      expect(toolchain.version).not.toBeNull()
      expect(toolchain.guidance).toBeNull()
    }
  }
})

test('serves a cached result, and rescan returns the same shape', async () => {
  const first = await probe('list')
  const second = await probe('list')
  expect(second).toEqual(first)

  const rescanned = await probe('rescan')
  expect(rescanned.map((toolchain) => toolchain.id)).toEqual(EXPECTED_IDS)
})

test('a Store alias stub carries the exact python.org guidance', async () => {
  const toolchains = await probe('list')
  const python = toolchains.find((toolchain) => toolchain.id === 'python')
  expect(python).toBeDefined()

  // Only meaningful on a machine where the alias is the disabled stub; where it
  // is not, there is nothing to assert and the check is skipped rather than
  // faked.
  test.skip(python?.kind !== 'store-stub', 'no Store stub on this machine')

  expect(python?.guidance).toBe(
    'Python on your PATH is the Microsoft Store alias stub, not a real interpreter. ' +
      'Install Python from python.org, or turn the alias off in ' +
      'Settings → Apps → App execution aliases.'
  )
  expect(python?.version).toBeNull()
})

test('the status bar indicator reports the probe and opens a detail popover', async () => {
  const indicator = window.locator('#toolchain-indicator')
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveText(/Toolchains \d+\/6/)

  await indicator.click()

  const popover = window.locator('.toolchains-popover')
  await expect(popover).toBeVisible()
  await expect(popover.locator('.toolchains-row')).toHaveCount(6)

  // Every row names its tool and says something about its state.
  for (const label of ['Node.js', 'Python', 'GCC', 'G++', 'TypeScript', 'Docker']) {
    await expect(popover.locator('.toolchains-row__name', { hasText: label })).toHaveCount(1)
  }

  await window.keyboard.press('Escape')
  await expect(popover).toBeHidden()
})

test('the Rescan command re-probes without reloading the window', async () => {
  await window.locator('#toolchain-indicator').click()

  const popover = window.locator('.toolchains-popover')
  await expect(popover).toBeVisible()

  await popover.getByRole('button', { name: 'Rescan' }).click()

  // The popover is rebuilt in place; six rows again means the rescan completed
  // rather than leaving a half-rendered panel behind.
  await expect(window.locator('.toolchains-popover .toolchains-row')).toHaveCount(6)
  await expect(window.locator('#toolchain-indicator')).toHaveText(/Toolchains \d+\/6/)

  await window.keyboard.press('Escape')
})
