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
 */
export const PRODUCTION_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
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
  /** Origin the packaged renderer is served from, e.g. `app://aperture`. */
  appOrigin?: string | undefined
  /** Absolute path of the directory holding the built renderer. */
  rendererRoot?: string | undefined
}

/**
 * Compares scheme + host rather than `origin`.
 *
 * `new URL('app://aperture/x').origin` serialises to the string `"null"` for
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
