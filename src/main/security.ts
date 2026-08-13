/**
 * Pure, dependency-free security policy for the main process.
 *
 * This file exists (it is not in the original target layout) so the CSP strings
 * and the navigation predicates can be unit-tested without importing `electron`
 * — importing `src/main/index.ts` would drag in the whole app lifecycle.
 * Nothing here may import electron or node built-ins with side effects.
 */

/**
 * The exact policy required by the security invariants. Shipped builds get this
 * string verbatim; a unit test asserts it character-for-character.
 *
 * `'wasm-unsafe-eval'` is the one addition tree-sitter forces, and it is worth
 * being precise about what it does and does not permit.
 *
 * It permits exactly one thing: compiling and instantiating a WebAssembly
 * module from a buffer. It does NOT enable `eval`, `new Function`, or inline
 * scripts — that is `'unsafe-eval'`, a strictly larger grant which this does not
 * include and which the development policy uses only because Vite's HMR client
 * requires it. The token exists in the spec precisely so that a page needing
 * WebAssembly does not have to ask for JavaScript evaluation as well.
 *
 * The bytes it compiles never come from the network. `connect-src 'none'` is
 * unchanged, so the renderer still cannot fetch anything from anywhere; the
 * `.wasm` files are read by main from `resources/tree-sitter/` and handed over
 * IPC (see wasm-assets.ts). The grant is therefore "run the WebAssembly the
 * main process chose to give you", not "run WebAssembly from wherever".
 */
export const PRODUCTION_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'none'"

/**
 * Development-only relaxation. Vite's dev client needs a websocket back to the
 * dev server for HMR and fetches modules over http, both of which
 * `connect-src 'none'` forbids. This policy is never used in a packaged app —
 * `buildCspHeader` selects it only when `isDev` is true.
 */
export const DEVELOPMENT_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "worker-src 'self' blob:; " +
  "connect-src 'self' ws://localhost:* http://localhost:*"

export function buildCspHeader(isDev: boolean): string {
  return isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP
}

/**
 * Schemes that may be handed to `shell.openExternal`. The invariant is an
 * https-only allow-list: no http, no file, no custom schemes, and no URLs
 * carrying embedded credentials (a classic phishing shape).
 */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.hostname === '') return false
  return true
}

export interface NavigationContext {
  /** Origin of the Vite dev server, e.g. `http://localhost:5173`. Dev only. */
  devServerOrigin?: string | undefined
  /** Origin the packaged renderer is served from, e.g. `app://bettercallcompiler`. */
  appOrigin?: string | undefined
  /** Absolute path of the directory holding the built renderer. */
  rendererRoot?: string | undefined
}

/**
 * Compares scheme + host rather than `origin`.
 *
 * `new URL('app://bettercallcompiler/x').origin` serialises to the string `"null"` for
 * any non-special scheme, so an origin equality test would either reject every
 * app:// navigation or — worse — treat two different opaque origins as equal.
 */
function sameSchemeAndHost(url: URL, expected: string): boolean {
  let reference: URL
  try {
    reference = new URL(expected)
  } catch {
    return false
  }
  return url.protocol === reference.protocol && url.host === reference.host
}

/**
 * True only for navigations that stay inside the application itself. Everything
 * else must be cancelled — a renderer that can be navigated to arbitrary remote
 * content is a renderer whose CSP and preload guarantees no longer mean anything.
 */
export function isInternalNavigation(raw: string, ctx: NavigationContext): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (ctx.devServerOrigin !== undefined && ctx.devServerOrigin !== '') {
    if (sameSchemeAndHost(url, ctx.devServerOrigin)) return true
  }

  if (ctx.appOrigin !== undefined && ctx.appOrigin !== '') {
    if (sameSchemeAndHost(url, ctx.appOrigin)) return true
  }

  if (url.protocol === 'file:' && ctx.rendererRoot !== undefined && ctx.rendererRoot !== '') {
    const target = normalizePath(decodeURIComponent(url.pathname))
    const root = normalizePath(ctx.rendererRoot)
    return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
  }

  return false
}

/** Lower-cases and forward-slashes a path so Windows comparisons behave. */
function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/')
  // file:// pathnames on Windows arrive as "/C:/Users/..." — drop the lead slash.
  if (/^\/[a-zA-Z]:\//.test(out)) out = out.slice(1)
  return out.toLowerCase()
}
