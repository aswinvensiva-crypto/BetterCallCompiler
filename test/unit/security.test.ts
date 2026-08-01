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
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'"
    )
  })

  it('uses the production policy whenever not in dev', () => {
    expect(buildCspHeader(false)).toBe(PRODUCTION_CSP)
    expect(buildCspHeader(true)).toBe(DEVELOPMENT_CSP)
  })

  it('never lets the renderer reach the network in production', () => {
    expect(PRODUCTION_CSP).toContain("connect-src 'none'")
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval')
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
    const appOrigin = 'app://aperture'
    expect(isInternalNavigation('app://aperture/index.html', { appOrigin })).toBe(true)
    expect(isInternalNavigation('app://aperture/assets/main.js', { appOrigin })).toBe(true)
  })

  it('refuses a different app:// host', () => {
    // `new URL(...).origin` is the string "null" for every non-special scheme,
    // so an origin-equality check would wrongly treat these as the same site.
    const appOrigin = 'app://aperture'
    expect(isInternalNavigation('app://evil/index.html', { appOrigin })).toBe(false)
    expect(isInternalNavigation('app2://aperture/index.html', { appOrigin })).toBe(false)
  })

  it('refuses remote origins when no dev server is configured', () => {
    expect(isInternalNavigation('https://evil.example/', { rendererRoot })).toBe(false)
    expect(isInternalNavigation('http://localhost:5173/', { rendererRoot })).toBe(false)
  })
})
