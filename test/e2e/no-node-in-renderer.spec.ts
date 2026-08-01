import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'node:path'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

/**
 * Security invariant #2 and #3, asserted against the real shipped bundle.
 *
 * `evaluate` callbacks deliberately reach for `globalThis` rather than `window`
 * so this file needs no DOM lib in the Node-side tsconfig.
 */
test('the renderer has no Node access and no generic IPC escape hatch', async () => {
  const app = await electron.launch({ args: [MAIN_ENTRY], cwd: APP_ROOT })

  try {
    const window = await app.firstWindow()
    await window.waitForSelector('html[data-aperture-ready="true"]')

    const probe = await window.evaluate(() => {
      const g = globalThis as unknown as Record<string, unknown>
      const bridge = g['aperture'] as Record<string, unknown> | undefined

      return {
        requireType: typeof g['require'],
        processType: typeof g['process'],
        moduleType: typeof g['module'],
        globalType: typeof g['global'],
        bufferType: typeof g['Buffer'],
        bridgeType: typeof bridge,
        bridgeFrozen: bridge !== undefined && Object.isFrozen(bridge),
        bridgeKeys: bridge === undefined ? [] : Object.keys(bridge),
        // A generic escape hatch under any of its likely names.
        escapeHatches: bridge === undefined
          ? []
          : ['invoke', 'send', 'ipcRenderer', 'ipc', 'require'].filter((k) => k in bridge),
        appNamespaceFrozen:
          bridge !== undefined && Object.isFrozen(bridge['app'] as object)
      }
    })

    expect(probe.requireType).toBe('undefined')
    expect(probe.processType).toBe('undefined')
    expect(probe.moduleType).toBe('undefined')
    expect(probe.globalType).toBe('undefined')
    expect(probe.bufferType).toBe('undefined')

    expect(probe.bridgeType).toBe('object')
    expect(probe.bridgeFrozen).toBe(true)
    expect(probe.appNamespaceFrozen).toBe(true)
    expect(probe.escapeHatches).toEqual([])
    expect(probe.bridgeKeys).toContain('app')
  } finally {
    await app.close()
  }
})

test('app:ping round-trips through the bridge and returns a Result', async () => {
  const app = await electron.launch({ args: [MAIN_ENTRY], cwd: APP_ROOT })

  try {
    const window = await app.firstWindow()
    await window.waitForSelector('html[data-aperture-ready="true"]')

    const result = await window.evaluate(async () => {
      const g = globalThis as unknown as Record<string, unknown>
      const bridge = g['aperture'] as { app: { ping: (r: unknown) => Promise<unknown> } }
      return (await bridge.app.ping({})) as { ok: boolean; value?: { pong: boolean } }
    })

    expect(result.ok).toBe(true)
    expect(result.value?.pong).toBe(true)
  } finally {
    await app.close()
  }
})
