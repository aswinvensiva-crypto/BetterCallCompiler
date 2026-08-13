import { describe, expect, it } from 'vitest'
import {
  DEVELOPMENT_CSP,
  PRODUCTION_CSP,
  buildCspHeader,
  isAllowedExternalUrl,
  isInternalNavigation
} from '../../src/main/security'

describe('content security policy', () => {
  // Pinned character-for-character: this string is a security invariant, and a
  // well-meaning edit that "tidies" it is exactly what this test exists to catch.
  it('ships the exact required production policy', () => {
    expect(PRODUCTION_CSP).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'"
    )
  })

  it('uses the production policy whenever not in dev', () => {
    expect(buildCspHeader(false)).toBe(PRODUCTION_CSP)
    expect(buildCspHeader(true)).toBe(DEVELOPMENT_CSP)
  })

  it('never lets the renderer reach the network in production', () => {
    expect(PRODUCTION_CSP).toContain("connect-src 'none'")
  })

  /**
   * `'wasm-unsafe-eval'` is permitted; `'unsafe-eval'` is not.
   *
   * The original assertion here was `not.toContain('unsafe-eval')`, which now
   * matches `'wasm-unsafe-eval'` by substring and would have failed the moment
   * tree-sitter arrived. That is the test doing its job — but the fix is to say
   * what was actually meant, not to loosen it. The two tokens are different
   * grants: one compiles a WebAssembly module from a buffer, the other enables
   * `eval` and `new Function` on JavaScript. Only the first is wanted, and only
   * in production, where the bytes come from main over IPC rather than from
   * anywhere a page could reach.
   */
  it('permits WebAssembly compilation without permitting JavaScript eval', () => {
    expect(PRODUCTION_CSP).toContain("'wasm-unsafe-eval'")

    // Every `unsafe-eval` occurrence must be the wasm-prefixed one.
    const bare = PRODUCTION_CSP.match(/(^|[\s'])unsafe-eval/g) ?? []
    expect(bare).toEqual([])

    // And it is scoped to script-src rather than sprayed across the policy.
    const scriptSrc = /script-src ([^;]*)/.exec(PRODUCTION_CSP)?.[1] ?? ''
    expect(scriptSrc).toBe("'self' 'wasm-unsafe-eval'")
  })

  it('relaxes only localhost transports in dev', () => {
    expect(DEVELOPMENT_CSP).toContain('ws://localhost:*')
    // Dev must not become a blanket allow-list for arbitrary remote origins.
    expect(DEVELOPMENT_CSP).not.toContain('connect-src *')
    expect(DEVELOPMENT_CSP).not.toContain('default-src *')
  })
})

describe('external link allow-list', () => {
  it('permits plain https', () => {
    expect(isAllowedExternalUrl('https://github.com/anthropics')).toBe(true)
    expect(isAllowedExternalUrl('https://docs.anthropic.com/en/api')).toBe(true)
  })

  it('refuses every non-https scheme', () => {
    for (const url of [
      'http://example.com',
      'file:///C:/Windows/System32/cmd.exe',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'ms-settings:privacy',
      'smb://attacker/share'
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false)
    }
  })

  it('refuses embedded credentials', () => {
    expect(isAllowedExternalUrl('https://user:pass@evil.example/')).toBe(false)
    expect(isAllowedExternalUrl('https://user@evil.example/')).toBe(false)
  })

  it('refuses malformed input', () => {
    for (const url of ['', 'not a url', '://missing-scheme', 'https://']) {
      expect(isAllowedExternalUrl(url)).toBe(false)
    }
  })
})

describe('navigation containment', () => {
  const rendererRoot = 'C:/Users/dev/app/out/renderer'
  const devServerOrigin = 'http://localhost:5173'

  it('allows the dev server origin in dev', () => {
    expect(isInternalNavigation('http://localhost:5173/index.html', { devServerOrigin })).toBe(true)
    expect(isInternalNavigation('http://localhost:5173/', { devServerOrigin })).toBe(true)
  })

  it('refuses a different port or host even in dev', () => {
    expect(isInternalNavigation('http://localhost:9999/', { devServerOrigin })).toBe(false)
    expect(isInternalNavigation('http://evil.example/', { devServerOrigin })).toBe(false)
  })

  it('allows file URLs inside the renderer root', () => {
    expect(isInternalNavigation('file:///C:/Users/dev/app/out/renderer/index.html', { rendererRoot })).toBe(
      true
    )
  })

  it('refuses file URLs outside the renderer root', () => {
    expect(isInternalNavigation('file:///C:/Windows/System32/cmd.exe', { rendererRoot })).toBe(false)
    // A sibling directory sharing a name prefix must not be treated as inside.
    expect(isInternalNavigation('file:///C:/Users/dev/app/out/renderer-evil/x.html', { rendererRoot })).toBe(
      false
    )
  })

  it('allows the packaged app:// origin', () => {
    const appOrigin = 'app://bettercallcompiler'
    expect(isInternalNavigation('app://bettercallcompiler/index.html', { appOrigin })).toBe(true)
    expect(isInternalNavigation('app://bettercallcompiler/assets/main.js', { appOrigin })).toBe(true)
  })

  it('refuses a different app:// host', () => {
    // `new URL(...).origin` is the string "null" for every non-special scheme,
    // so an origin-equality check would wrongly treat these as the same site.
    const appOrigin = 'app://bettercallcompiler'
    expect(isInternalNavigation('app://evil/index.html', { appOrigin })).toBe(false)
    expect(isInternalNavigation('app2://bettercallcompiler/index.html', { appOrigin })).toBe(false)
  })

  it('refuses remote origins when no dev server is configured', () => {
    expect(isInternalNavigation('https://evil.example/', { rendererRoot })).toBe(false)
    expect(isInternalNavigation('http://localhost:5173/', { rendererRoot })).toBe(false)
  })
})
