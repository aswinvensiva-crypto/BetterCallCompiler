import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Module-format note (load-bearing, see README):
// package.json deliberately has no `"type": "module"`, so main and preload build
// as CommonJS. A preload running under `sandbox: true` cannot use ESM import
// syntax — it executes in a restricted context whose only module access is a
// synchronous `require('electron')`. The renderer is still authored and bundled
// as ES modules, because Vite serves it to Chromium where `<script type=module>`
// is native.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },

  preload: {
    // Deliberately NOT externalizeDepsPlugin(). A sandboxed preload has no
    // module resolver — its only synchronous import is `require('electron')`.
    // Externalising package dependencies would emit `require('zod')` here and
    // the bridge would die on load. Everything except electron gets inlined.
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { bridge: resolve(__dirname, 'src/preload/bridge.ts') },
        output: { format: 'cjs' },
        external: ['electron']
      }
    }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
