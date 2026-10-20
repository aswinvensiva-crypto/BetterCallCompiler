import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  createLanguageServiceHost,
  extensionOf,
  loadWorkspaceConfig,
  toAbsolute,
  toRelative,
  walkSources
} from '../../src/main/ts-workspace'

/**
 * The rules two TypeScript workers have to agree about.
 *
 * They exist as one module so the check worker and the interactive one cannot
 * end up with two pictures of the same program — and the assertions here are
 * the ones whose failure would be invisible until it was expensive.
 */

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bcc-workspace-'))
})

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('createLanguageServiceHost', () => {
  /**
   * The path TypeScript asked about reaches the caller UNCHANGED.
   *
   * This is not a style preference. Most of what the service asks for is inside
   * the workspace, but `lib.es2022.d.ts` is not — it lives beside the
   * typescript package, or under `process.resourcesPath` in a packaged build.
   * A host that handed the caller a workspace-relative path would force it to
   * rebuild the absolute one, and `join(root, relative(root, x))` is only the
   * identity while both are on the same volume: on Windows with the workspace
   * on D: and the app on C:, `relative` returns `D:\ts\…` and joining it onto
   * the root gives `C:\app\D:\ts\…`. Every lib file then fails to load and the
   * whole program is untyped — on Windows only, which is where CI runs and
   * where nothing else in this suite would have noticed.
   */
  it('asks about files by the exact path TypeScript named', () => {
    const asked: string[] = []
    const host = createLanguageServiceHost({
      root: '/workspace',
      scriptFileNames: () => [],
      compilerOptions: () => ({}),
      textOf: (fileName) => {
        asked.push(fileName)
        return null
      },
      versionOf: (fileName) => {
        asked.push(fileName)
        return '0'
      }
    })

    // Inside the workspace, outside it, and — the case that matters — a path
    // that shares no prefix with the root at all.
    for (const fileName of [
      '/workspace/src/app.ts',
      '/elsewhere/node_modules/typescript/lib/lib.es2022.d.ts',
      'D:/ts/lib.dom.d.ts'
    ]) {
      host.getScriptSnapshot(fileName)
      host.getScriptVersion(fileName)
    }

    expect(asked).toEqual([
      '/workspace/src/app.ts',
      '/workspace/src/app.ts',
      '/elsewhere/node_modules/typescript/lib/lib.es2022.d.ts',
      '/elsewhere/node_modules/typescript/lib/lib.es2022.d.ts',
      'D:/ts/lib.dom.d.ts',
      'D:/ts/lib.dom.d.ts'
    ])
  })

  it('turns text into a snapshot and null into no snapshot', () => {
    const host = createLanguageServiceHost({
      root: '/workspace',
      scriptFileNames: () => [],
      compilerOptions: () => ({}),
      textOf: (fileName) => (fileName === '/workspace/a.ts' ? 'let x = 1' : null),
      versionOf: () => '1'
    })

    expect(host.getScriptSnapshot('/workspace/a.ts')?.getText(0, 9)).toBe('let x = 1')
    // Undefined, not an empty snapshot: an empty one is a file that exists and
    // is blank, which is a different thing from a file that is not there.
    expect(host.getScriptSnapshot('/workspace/gone.ts')).toBeUndefined()
  })

  /**
   * Present only when the caller supplies one, because the two workers differ.
   * The interactive daemon is never interrupted — a request there is superseded
   * by the next keystroke rather than cancelled — and giving it a token would
   * buy nothing while costing the same `OperationCanceledException` hazard the
   * checker had to carve out for.
   */
  it('only has a cancellation token when one is supplied', () => {
    const without = createLanguageServiceHost({
      root: '/w',
      scriptFileNames: () => [],
      compilerOptions: () => ({}),
      textOf: () => null,
      versionOf: () => '0'
    })
    expect(without.getCancellationToken).toBeUndefined()

    let requested = false
    const withToken = createLanguageServiceHost({
      root: '/w',
      scriptFileNames: () => [],
      compilerOptions: () => ({}),
      textOf: () => null,
      versionOf: () => '0',
      isCancellationRequested: () => requested
    })

    expect(withToken.getCancellationToken?.().isCancellationRequested()).toBe(false)
    requested = true
    expect(withToken.getCancellationToken?.().isCancellationRequested()).toBe(true)
  })
})

describe('walkSources', () => {
  it('finds source files and ignores the directories nothing should index', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), '')
    writeFileSync(join(root, 'src', 'b.tsx'), '')
    writeFileSync(join(root, 'src', 'notes.md'), '')
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '')
    writeFileSync(join(root, 'dist', 'bundle.js'), '')

    const { files, truncated } = walkSources(root)
    expect(files.map((file) => toRelative(root, file)).sort()).toEqual(['src/a.ts', 'src/b.tsx'])
    expect(truncated).toBe(false)
  })
})

describe('loadWorkspaceConfig', () => {
  it('falls back permissively when there is no tsconfig', () => {
    const config = loadWorkspaceConfig(root)
    expect(config.tsconfigRelativePath).toBeNull()
    // Without a tsconfig, a plain JavaScript project would otherwise sprout a
    // wall of type errors nobody asked for on first open.
    expect(config.options.allowJs).toBe(true)
    expect(config.options.checkJs).toBe(false)
  })

  it('adopts the workspace tsconfig, and always adds noEmit', () => {
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020' } })
    )

    const config = loadWorkspaceConfig(root)
    expect(config.tsconfigRelativePath).toBe('tsconfig.json')
    expect(config.options.strict).toBe(true)
    expect(config.options.target).toBe(ts.ScriptTarget.ES2020)
    // The daemon never emits, whatever the project says.
    expect(config.options.noEmit).toBe(true)
  })
})

describe('paths', () => {
  it('round trips a workspace-relative path', () => {
    expect(toRelative(root, toAbsolute(root, 'src/deep/a.ts'))).toBe('src/deep/a.ts')
  })

  it('uses POSIX separators whatever the platform produced', () => {
    // Every side of the IPC boundary joins on this shape, so a backslash
    // leaking through would silently fail to match a path from the watcher.
    expect(toRelative(root, join(root, 'src', 'a.ts'))).toBe('src/a.ts')
  })

  it('reports the empty string for the root itself', () => {
    expect(toRelative(root, root)).toBe('')
  })

  it('lowercases the extension it reports', () => {
    expect(extensionOf('Component.TSX')).toBe('.tsx')
    expect(extensionOf('Makefile')).toBe('')
  })
})
