import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

/**
 * The step-boundary launch check: the app must start, paint the workbench, and
 * do it without a single console error. Listeners are attached before any
 * navigation completes so start-up failures cannot slip past.
 */
test('app launches and renders the workbench with a clean console', async () => {
  const app = await electron.launch({ args: [MAIN_ENTRY, isolatedUserData('launch')], cwd: APP_ROOT })

  try {
    const problems: string[] = []
    const window = await app.firstWindow()

    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
    })
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

    await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')

    expect(await window.title()).toBe('BetterCallCompiler')

    // Every workbench region declared in index.html is present.
    for (const id of ['activity-bar', 'side-bar', 'editor-area', 'status-bar']) {
      await expect(window.locator(`#${id}`)).toBeAttached()
    }

    // The renderer actually ran: these nodes are created in main.ts, not markup.
    // Assist, Visualizer and Problems brought this to 10; Compiler Intelligence
    // makes 11.
    await expect(window.locator('.activity-bar__item')).toHaveCount(11)
    await expect(window.locator('.editor-placeholder__mark')).toHaveText('BetterCallCompiler')

    // With step 12 done, every activity item is live. The bar renders anything
    // not yet built as disabled rather than silently inert, so this doubles as
    // the check that nothing was left half-wired.
    for (const id of [
      'explorer',
      'search',
      'scm',
      'run',
      'insights',
      'ai',
      'assist',
      'visualizer',
      'problems',
      'compiler',
      'settings'
    ]) {
      await expect(window.locator(`.activity-bar__item[data-view-id="${id}"]`)).toBeEnabled()
    }

    // The preload bridge was installed and reached the renderer.
    await expect(window.locator('#status-bar')).toContainText('Bridge connected')

    expect(problems).toEqual([])
  } finally {
    await app.close()
  }
})
