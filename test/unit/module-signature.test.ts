import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { exportedTypeLines, moduleSignature } from '../../src/main/module-signature'

/**
 * The claim under test: a signature changes when and only when something a
 * DEPENDENT could observe changes. Every case below is phrased as "edit X, does
 * the signature move?", because that is the question the engine asks to decide
 * whether to recheck importers.
 *
 * A false negative here (signature unchanged when it should move) means stale
 * diagnostics — a clean-looking file that does not compile. A false positive
 * just costs a recheck. The tests are weighted accordingly.
 */

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true
}

/** An in-memory program: no temp directories, no cleanup, no flakes. */
function programFrom(files: Record<string, string>): ts.Program {
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = files[fileName] ?? ts.sys.readFile(fileName)
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true)
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => fileName in files || ts.sys.fileExists(fileName),
    readFile: (fileName) => files[fileName] ?? ts.sys.readFile(fileName)
  }

  return ts.createProgram(Object.keys(files), OPTIONS, host)
}

function signatureOf(files: Record<string, string>, entry: string): string {
  const program = programFrom(files)
  const sourceFile = program.getSourceFile(entry)
  if (sourceFile === undefined) throw new Error(`no source file for ${entry}`)
  return moduleSignature(program.getTypeChecker(), sourceFile)
}

function linesOf(files: Record<string, string>, entry: string): string[] {
  const program = programFrom(files)
  const sourceFile = program.getSourceFile(entry)
  if (sourceFile === undefined) throw new Error(`no source file for ${entry}`)
  return exportedTypeLines(program.getTypeChecker(), sourceFile)
}

describe('signature is blind to what dependents cannot see', () => {
  /**
   * The single most valuable case, and the reason the whole engine exists.
   * Editing a body is what a keystroke usually is.
   */
  it('ignores a function body change', () => {
    const before = signatureOf({ '/a.ts': 'export function f(n: number): number { return n + 1 }' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export function f(n: number): number { return n * 2 + 0 }' }, '/a.ts')

    expect(after).toBe(before)
  })

  it('ignores comments and reformatting', () => {
    const before = signatureOf({ '/a.ts': 'export const x: number = 1' }, '/a.ts')
    const after = signatureOf(
      { '/a.ts': '// a comment nobody imports\n\nexport const x:number     = 1\n' },
      '/a.ts'
    )

    expect(after).toBe(before)
  })

  it('ignores a renamed local', () => {
    const before = signatureOf(
      { '/a.ts': 'const helper = 1\nexport function f(): number { return helper }' },
      '/a.ts'
    )
    const after = signatureOf(
      { '/a.ts': 'const renamed = 1\nexport function f(): number { return renamed }' },
      '/a.ts'
    )

    expect(after).toBe(before)
  })

  it('ignores a non-exported declaration being added', () => {
    const before = signatureOf({ '/a.ts': 'export const x: number = 1' }, '/a.ts')
    const after = signatureOf(
      { '/a.ts': 'function privateThing(): void {}\nexport const x: number = 1' },
      '/a.ts'
    )

    expect(after).toBe(before)
  })

  /**
   * Declaration order is not part of a module's contract. Without the sort,
   * tidying a file would look like a breaking change to every importer.
   */
  it('ignores export reordering', () => {
    const before = signatureOf({ '/a.ts': 'export const a: number = 1\nexport const b: string = "x"' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export const b: string = "x"\nexport const a: number = 1' }, '/a.ts')

    expect(after).toBe(before)
  })
})

describe('signature moves when a dependent could break', () => {
  it('notices a changed parameter type', () => {
    const before = signatureOf({ '/a.ts': 'export function f(n: string): void {}' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export function f(n: number): void {}' }, '/a.ts')

    expect(after).not.toBe(before)
  })

  /**
   * The case that rules out the cheap implementation. Hashing the AST with
   * bodies stripped gives these two an IDENTICAL signature, and the second
   * breaks every caller. An inferred return type is public surface and only the
   * checker knows it.
   */
  it('notices a changed INFERRED return type, with no annotation anywhere', () => {
    const before = signatureOf({ '/a.ts': 'export function f() { return 1 }' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export function f() { return "one" }' }, '/a.ts')

    expect(after).not.toBe(before)
    // Asserted by prefix rather than equality: the exact rendering carries an
    // expanded call signature too, and pinning the whole string here would make
    // this test fail for formatting reasons that have nothing to do with the
    // claim being made.
    expect(linesOf({ '/a.ts': 'export function f() { return 1 }' }, '/a.ts')[0]).toContain(
      'f:() => number'
    )
  })

  it('notices a new export', () => {
    const before = signatureOf({ '/a.ts': 'export const a: number = 1' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export const a: number = 1\nexport const b: string = "x"' }, '/a.ts')

    expect(after).not.toBe(before)
  })

  it('notices a removed export', () => {
    const before = signatureOf({ '/a.ts': 'export const a: number = 1\nexport const b: string = "x"' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export const a: number = 1' }, '/a.ts')

    expect(after).not.toBe(before)
  })

  it('notices an added optional property on an exported interface', () => {
    const before = signatureOf({ '/a.ts': 'export interface Shape { a: number }' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export interface Shape { a: number; b?: string }' }, '/a.ts')

    expect(after).not.toBe(before)
  })

  /**
   * An interface has no value side, so `getTypeOfSymbolAtLocation` answers
   * `any` for it. Without the declared-type fallback every interface in the
   * workspace hashes to the same thing and interface edits stop invalidating
   * anything at all.
   */
  it('distinguishes two different interfaces rather than calling both any', () => {
    const one = linesOf({ '/a.ts': 'export interface Shape { a: number }' }, '/a.ts')
    const two = linesOf({ '/a.ts': 'export interface Shape { b: string }' }, '/a.ts')

    expect(one).not.toEqual(two)
    expect(one.join()).not.toContain(':any')
  })

  it('notices a changed type alias', () => {
    const before = signatureOf({ '/a.ts': 'export type Id = string' }, '/a.ts')
    const after = signatureOf({ '/a.ts': 'export type Id = number' }, '/a.ts')

    expect(after).not.toBe(before)
  })
})

describe('re-exports and edges', () => {
  /**
   * `export { x } from './y'` makes y's type part of a's surface. If the alias
   * were not followed, a change in y would be invisible here and the
   * invalidation chain would have a hole in exactly the file that exists to
   * forward it.
   */
  it('follows an alias so a re-exported type change is visible', () => {
    const before = signatureOf(
      { '/y.ts': 'export const x: number = 1', '/a.ts': 'export { x } from "./y"' },
      '/a.ts'
    )
    const after = signatureOf(
      { '/y.ts': 'export const x: string = "1"', '/a.ts': 'export { x } from "./y"' },
      '/a.ts'
    )

    expect(after).not.toBe(before)
  })
})

describe('degenerate inputs', () => {
  it('reports a module with no exports as empty rather than hashing nothing', () => {
    expect(signatureOf({ '/a.ts': 'const x = 1' }, '/a.ts')).toBe('empty')
  })

  /**
   * A file mid-edit routinely fails to resolve. A signature query that threw
   * would take down the check for the file the user is actively typing in —
   * exactly when diagnostics matter most.
   */
  it('survives unresolvable references instead of throwing', () => {
    expect(() =>
      signatureOf({ '/a.ts': 'export const x: NotARealType = missingThing()' }, '/a.ts')
    ).not.toThrow()
  })

  it('is stable across repeated computation of identical text', () => {
    const text = { '/a.ts': 'export interface A { n: number }\nexport function f(a: A) { return a.n }' }
    expect(signatureOf(text, '/a.ts')).toBe(signatureOf(text, '/a.ts'))
  })
})
