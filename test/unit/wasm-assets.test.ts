import { beforeEach, describe, expect, it } from 'vitest'
import {
  WASM_ASSET_NAMES,
  isWasmAssetName,
  readWasmAsset,
  resetWasmAssetsForTests
} from '../../src/main/wasm-assets'
import { BetterCallCompilerServiceError } from '../../src/shared/ipc-contract'

/**
 * The channel that hands WebAssembly to the renderer.
 *
 * It exists because `connect-src 'none'` forbids the renderer from fetching a
 * `.wasm` by any means, so these bytes cross IPC instead. That makes this the
 * one place where a renderer-supplied string could reach the filesystem, and
 * the allow-list is what stops it.
 */

beforeEach(() => {
  resetWasmAssetsForTests()
})

describe('the allow-list', () => {
  it('accepts every declared asset', () => {
    expect(WASM_ASSET_NAMES.length).toBeGreaterThan(0)
    for (const name of WASM_ASSET_NAMES) {
      expect(isWasmAssetName(name)).toBe(true)
    }
  })

  /**
   * The renderer names a KEY, never a location, so there is no path to
   * traverse. These are the shapes an attacker would try if it did take a path.
   */
  it('rejects anything that is not a declared name', () => {
    for (const name of [
      '../../../etc/passwd',
      'tree-sitter/../../../secret',
      'tree-sitter.wasm',
      'C:/Windows/System32/config/SAM',
      '',
      'toString',
      'constructor',
      '__proto__'
    ]) {
      expect(isWasmAssetName(name)).toBe(false)
    }
  })

  /**
   * `hasOwnProperty` rather than `in` or a bare property read. Object.prototype
   * carries `toString` and `constructor`, and a lookup that walked the
   * prototype chain would treat both as valid asset names.
   */
  it('does not admit inherited Object properties as names', () => {
    expect(isWasmAssetName('hasOwnProperty')).toBe(false)
    expect(isWasmAssetName('valueOf')).toBe(false)
  })
})

describe('reading', () => {
  it('returns base64 bytes for the tree-sitter runtime', async () => {
    const base64 = await readWasmAsset('tree-sitter')

    expect(base64.length).toBeGreaterThan(1000)
    // The WebAssembly magic number is 0x00 61 73 6D — "\0asm" — which base64
    // encodes with this prefix. Asserting on it proves a real module was read
    // rather than some other file that happened to be at the path.
    expect(Buffer.from(base64, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x00, 0x61, 0x73, 0x6d])
    )
  })

  it('returns a real grammar module too', async () => {
    const base64 = await readWasmAsset('tree-sitter-typescript')
    expect(Buffer.from(base64, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x00, 0x61, 0x73, 0x6d])
    )
  })

  it('serves the second read from cache', async () => {
    const first = await readWasmAsset('tree-sitter-python')
    const second = await readWasmAsset('tree-sitter-python')
    expect(second).toBe(first)
  })

  /**
   * Named rather than silently empty. A missing grammar that degrades to "this
   * language has no syntax tree" looks like a parser bug and costs an
   * afternoon — the same failure the absent lib.*.d.ts produced in the packaged
   * daemon.
   */
  it('throws a named error when an asset is genuinely absent', async () => {
    await expect(
      readWasmAsset('tree-sitter-nonexistent' as Parameters<typeof readWasmAsset>[0])
    ).rejects.toBeInstanceOf(BetterCallCompilerServiceError)
  })
})
