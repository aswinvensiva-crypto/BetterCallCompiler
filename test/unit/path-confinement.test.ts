import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { confinePath, isWithin } from '../../src/main/fs-service'
import { BetterCallCompilerServiceError } from '../../src/shared/ipc-contract'

/**
 * Fixture layout:
 *
 *   <base>/workspace/         <- the root
 *   <base>/workspace/a.txt
 *   <base>/workspace/sub/b.txt
 *   <base>/workspace/escape   -> <base>/outside   (directory junction)
 *   <base>/outside/secret.txt
 *   <base>/workspace-evil/    <- sibling sharing a name prefix
 */
let base = ''
let root = ''
let outside = ''
let junctionCreated = false

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'bettercallcompiler-confine-')))
  root = join(base, 'workspace')
  outside = join(base, 'outside')

  await mkdir(join(root, 'sub'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(join(base, 'workspace-evil'), { recursive: true })

  await writeFile(join(root, 'a.txt'), 'inside')
  await writeFile(join(root, 'sub', 'b.txt'), 'inside')
  await writeFile(join(outside, 'secret.txt'), 'SECRET')

  // Plain symlinks need elevation or Developer Mode on Windows; junctions do
  // not, and `realpath` resolves both identically. A junction is the realistic
  // escape shape on this platform, so it is what the confinement must survive.
  try {
    await symlink(outside, join(root, 'escape'), 'junction')
    junctionCreated = true
  } catch {
    junctionCreated = false
  }
})

afterAll(async () => {
  if (base !== '') await rm(base, { recursive: true, force: true })
})

async function expectRejection(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(BetterCallCompilerServiceError)
  await promise.catch((error: unknown) => {
    expect((error as BetterCallCompilerServiceError).code).toBe(code)
  })
}

describe('isWithin', () => {
  it('accepts the root itself and anything under it', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c/d.txt')).toBe(true)
  })

  it('rejects a sibling that merely shares a name prefix', () => {
    // The bug a naive startsWith() check would have.
    expect(isWithin('/a/b', '/a/bb')).toBe(false)
    expect(isWithin('/a/b', '/a/b-evil')).toBe(false)
  })

  it('rejects parents and unrelated paths', () => {
    expect(isWithin('/a/b', '/a')).toBe(false)
    expect(isWithin('/a/b', '/x/y')).toBe(false)
  })
})

describe('confinePath', () => {
  it('resolves ordinary paths inside the workspace', async () => {
    await expect(confinePath(root, 'a.txt')).resolves.toBe(join(root, 'a.txt'))
    await expect(confinePath(root, 'sub/b.txt')).resolves.toBe(join(root, 'sub', 'b.txt'))
  })

  it('accepts the workspace root itself', async () => {
    await expect(confinePath(root, root)).resolves.toBe(root)
  })

  it('accepts a path that does not exist yet, so create and rename can validate first', async () => {
    await expect(confinePath(root, 'brand-new.txt')).resolves.toBe(join(root, 'brand-new.txt'))
    await expect(confinePath(root, 'sub/deeper/still/new.txt')).resolves.toBe(
      join(root, 'sub', 'deeper', 'still', 'new.txt')
    )
  })

  it('rejects ../ traversal', async () => {
    await expectRejection(confinePath(root, '../outside/secret.txt'), 'PATH_ESCAPES_WORKSPACE')
    await expectRejection(confinePath(root, '../../'), 'PATH_ESCAPES_WORKSPACE')
    await expectRejection(confinePath(root, 'sub/../../outside/secret.txt'), 'PATH_ESCAPES_WORKSPACE')
    await expectRejection(
      confinePath(root, 'sub/../../../../../../Windows/System32/drivers/etc/hosts'),
      'PATH_ESCAPES_WORKSPACE'
    )
  })

  it('rejects an absolute path outside the workspace', async () => {
    await expectRejection(confinePath(root, join(outside, 'secret.txt')), 'PATH_ESCAPES_WORKSPACE')
    await expectRejection(confinePath(root, resolve('/')), 'PATH_ESCAPES_WORKSPACE')
  })

  it('rejects a sibling directory sharing the root name prefix', async () => {
    await expectRejection(
      confinePath(root, join(base, 'workspace-evil', 'x.txt')),
      'PATH_ESCAPES_WORKSPACE'
    )
  })

  it('rejects a junction whose target escapes the workspace', async () => {
    // This is the case a lexical-only check would pass: the path *looks* like
    // it is inside the root, and only realpath reveals otherwise.
    expect(junctionCreated, 'junction fixture could not be created').toBe(true)
    await expectRejection(confinePath(root, 'escape/secret.txt'), 'PATH_ESCAPES_WORKSPACE')
    await expectRejection(confinePath(root, 'escape'), 'PATH_ESCAPES_WORKSPACE')
  })

  it('refuses to resolve anything without a workspace', async () => {
    await expectRejection(confinePath('', 'a.txt'), 'NO_WORKSPACE')
  })
})
