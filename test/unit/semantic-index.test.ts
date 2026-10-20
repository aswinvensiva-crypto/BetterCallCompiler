import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetForTests, setWorkspace } from '../../src/main/fs-service'
import {
  buildSemanticIndex,
  getSemanticIndexStatus,
  querySemanticIndex,
  resetSemanticIndexForTests
} from '../../src/main/semantic-index'

describe('semantic index', () => {
  let workspace = ''

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'bettercallcompiler-semindex-'))
    resetSemanticIndexForTests()
  })

  afterEach(async () => {
    await resetForTests()
    if (workspace !== '') await rm(workspace, { recursive: true, force: true })
  })

  async function seed(name: string, content: string): Promise<void> {
    const path = join(workspace, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  it('reports unbuilt before any build', async () => {
    await setWorkspace(workspace)
    const status = await getSemanticIndexStatus()
    expect(status.built).toBe(false)
    expect(status.fileCount).toBe(0)
  })

  it('builds an index over the workspace and reports its stats', async () => {
    await seed('src/retry.ts', 'export function retryWithBackoff() {\n  // exponential backoff\n}\n')
    await seed('src/render.ts', 'export function renderSidebar() {\n  // paints the sidebar\n}\n')
    await setWorkspace(workspace)

    const status = await buildSemanticIndex()
    expect(status.built).toBe(true)
    expect(status.fileCount).toBe(2)
    expect(status.chunkCount).toBeGreaterThan(0)
    expect(status.builtAt).not.toBeNull()
  })

  it('ranks the file whose vocabulary matches the instruction above an unrelated one', async () => {
    await seed(
      'src/retry.ts',
      'export function retryWithExponentialBackoff(attempt) {\n  return attempt * 2\n}\n'
    )
    await seed(
      'src/render.ts',
      'export function renderActivityBarIcon(context) {\n  return context.icon\n}\n'
    )
    await setWorkspace(workspace)
    await buildSemanticIndex()

    const matches = await querySemanticIndex('exponential backoff retry attempt', 5)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]?.path).toBe('src/retry.ts')
  })

  it('boosts a related file over an equally-unrelated one when it imports the top match', async () => {
    await seed(
      'src/policy.ts',
      "import { computeBackoff } from './backoff'\nexport function retryPolicy() {\n  return computeBackoff()\n}\n"
    )
    await seed('src/backoff.ts', 'export function computeBackoff() {\n  return 100\n}\n')
    await seed('src/unrelated.ts', 'export function paintStatusBar() {\n  return null\n}\n')
    await setWorkspace(workspace)
    await buildSemanticIndex()

    const matches = await querySemanticIndex('retry policy backoff', 10)
    const paths = matches.map((match) => match.path)
    const policyIndex = paths.indexOf('src/policy.ts')
    const backoffIndex = paths.indexOf('src/backoff.ts')
    const unrelatedIndex = paths.indexOf('src/unrelated.ts')

    expect(policyIndex).toBeGreaterThanOrEqual(0)
    expect(backoffIndex).toBeGreaterThanOrEqual(0)
    // backoff.ts shares no vocabulary with "retry policy" beyond "backoff",
    // but is a neighbor of policy.ts — the top match — so it should still
    // outrank a file with no relation to the query at all.
    if (unrelatedIndex >= 0) expect(backoffIndex).toBeLessThan(unrelatedIndex)
  })

  it('returns nothing rather than throwing when queried before any build', async () => {
    await setWorkspace(workspace)
    expect(await querySemanticIndex('anything', 5)).toEqual([])
  })

  it('excludes files with no code extension', async () => {
    await seed('src/a.ts', 'export const a = 1')
    await seed('README.notes', 'this is not indexed')
    await setWorkspace(workspace)

    const status = await buildSemanticIndex()
    expect(status.fileCount).toBe(1)
  })
})
