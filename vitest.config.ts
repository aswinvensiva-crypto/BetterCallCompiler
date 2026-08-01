import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      // Main-process modules import `electron`, which only exists inside the
      // Electron runtime. Aliasing it to a recording stub lets the registry,
      // the services and the contract be unit tested in plain Node.
      electron: resolve(__dirname, 'test/fixtures/electron-stub.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    // E2E is Playwright's job; keep it out of the unit run.
    exclude: ['test/e2e/**', 'node_modules/**', 'out/**', 'dist/**']
  }
})
