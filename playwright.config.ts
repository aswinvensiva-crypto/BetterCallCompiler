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
  /**
   * One retry on CI, none locally.
   *
   * Not a way to make a failing test pass: Playwright reports a spec that only
   * survived its retry as FLAKY rather than green, so the signal is kept rather
   * than hidden. What it buys is that a genuine intermittent — a slow runner
   * losing a race against the single-instance lock, or a worker thread taking
   * longer to boot than it does on a developer's machine — does not turn the
   * whole pipeline red and teach everyone to ignore it.
   *
   * Locally it stays at zero, because a flake you can reproduce is one you can
   * fix, and a retry there would just hide it.
   */
  retries: process.env['CI'] !== undefined ? 1 : 0,
  reporter: [['list']]
})
