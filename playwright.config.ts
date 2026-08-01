import { defineConfig } from '@playwright/test'

/**
 * E2E runs against the *built* app in `out/`, not the dev server, so what is
 * verified is what would ship. Run `npm run build` first.
 *
 * Electron cannot be driven by more than one test worker at a time here — each
 * spec launches its own app instance and the app takes a single-instance lock.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: [['list']]
})
