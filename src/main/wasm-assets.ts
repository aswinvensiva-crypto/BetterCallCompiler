import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'

/**
 * Serves WebAssembly bytes to the renderer.
 *
 * This exists because of the CSP, and the CSP is worth keeping. `connect-src
 * 'none'` means the renderer cannot fetch anything, from anywhere, by any
 * network-shaped API — which rules out every documented way of loading a
 * `.wasm`: `fetch`, `XMLHttpRequest`, and `WebAssembly.instantiateStreaming`
 * (which is a fetch wearing a hat). Serving the files over the `app://` scheme
 * would not help; the scheme is not the part being refused, the request is.
 *
 * So the bytes come over IPC instead, which is not a network request and is
 * already the trusted channel between the two processes. `connect-src 'none'`
 * survives untouched. The only CSP change tree-sitter forces is
 * `'wasm-unsafe-eval'` on `script-src`, which permits compiling a WebAssembly
 * module from a buffer we handed it — see security.ts.
 *
 * Base64 rather than a transferred `Uint8Array`: every IPC payload is validated
 * by the zod contract, a string is a shape zod describes precisely, and this is
 * a handful of one-time lazy loads rather than anything on a hot path. The 33%
 * inflation buys a boundary that stays uniform.
 */

/**
 * The complete set of assets that may be requested, by name.
 *
 * An allowlist, not a path. The renderer names a key and never a location, so
 * there is no traversal to defend against — `confinePath` guards paths the user
 * chooses, and this is a channel where no path should be user-chosen at all.
 */
const ASSETS = {
  'tree-sitter': 'web-tree-sitter.wasm',
  'tree-sitter-typescript': 'tree-sitter-typescript.wasm',
  'tree-sitter-tsx': 'tree-sitter-tsx.wasm',
  'tree-sitter-javascript': 'tree-sitter-javascript.wasm',
  'tree-sitter-python': 'tree-sitter-python.wasm'
} as const

export type WasmAssetName = keyof typeof ASSETS

export function isWasmAssetName(value: string): value is WasmAssetName {
  return Object.prototype.hasOwnProperty.call(ASSETS, value)
}

export const WASM_ASSET_NAMES = Object.keys(ASSETS) as WasmAssetName[]

/**
 * Where a given asset lives, packaged first.
 *
 * Two shapes, because the file moves between a shipped build and everything
 * else. `extraResources` puts them flat in `resources/tree-sitter/`; unpackaged,
 * the runtime and the grammars sit in two different packages under
 * `node_modules`. Probing rather than branching on `app.isPackaged` is the same
 * choice `defaultLibPath` makes in compiler-worker.ts, and it means the E2E
 * harness — which runs an unpackaged build out of `out/` — takes the code path
 * a user does rather than a special one.
 *
 * The repository root is derived from `__dirname`, NOT from `app.getAppPath()`.
 * That distinction cost an E2E run and is worth writing down: launched as
 * `electron out/main/index.js`, `getAppPath()` returns the SCRIPT'S DIRECTORY —
 * `<repo>/out/main` — so `join(appPath, 'node_modules', …)` pointed at
 * `out/main/node_modules`, which has never existed. Every read failed and the
 * renderer got no grammar at all.
 *
 * The unit test did not catch it because the electron stub had been taught to
 * answer `process.cwd()` for `getAppPath`, which made the test agree with the
 * code instead of with Electron. `__dirname` needs no stub: it is `src/main`
 * under vitest and `out/main` in a build, and the root is two levels up from
 * both.
 */
function candidatesFor(name: WasmAssetName): string[] {
  const file = ASSETS[name]
  // Belt as well as braces. The IPC handler validates the name before calling,
  // so this is unreachable through the channel — but the function is exported,
  // and without the guard an unknown name reaches `join(dir, undefined)` and
  // throws a TypeError from node:path instead of the named error this module
  // promises. Found by a test, and the fix is not to depend on the caller.
  if (file === undefined) return []

  const paths: string[] = []

  if (process.resourcesPath !== undefined) {
    paths.push(join(process.resourcesPath, 'tree-sitter', file))
  }

  const root = join(__dirname, '..', '..')
  paths.push(join(root, 'node_modules', 'web-tree-sitter', file))
  paths.push(join(root, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm', file))

  return paths
}

/** Read once per asset per session; the bytes never change under a build. */
const cache = new Map<WasmAssetName, string>()

export async function readWasmAsset(name: WasmAssetName): Promise<string> {
  const cached = cache.get(name)
  if (cached !== undefined) return cached

  for (const path of candidatesFor(name)) {
    try {
      const bytes = await fsp.readFile(path)
      const base64 = bytes.toString('base64')
      cache.set(name, base64)
      return base64
    } catch {
      // Wrong location for this build shape; try the next.
    }
  }

  // Named explicitly rather than returning empty. A silently absent grammar
  // degrades into "this language has no syntax tree", which looks like a parser
  // bug and costs an afternoon — the same failure mode the missing lib.*.d.ts
  // produced in the packaged daemon.
  throw new BetterCallCompilerServiceError(
    'NOT_FOUND',
    `the WebAssembly asset "${name}" is missing from this build`
  )
}

/** Test hook: the cache is session state. */
export function resetWasmAssetsForTests(): void {
  cache.clear()
}
