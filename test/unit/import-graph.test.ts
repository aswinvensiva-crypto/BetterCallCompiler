import { describe, expect, it } from 'vitest'
import {
  buildNeighborMap,
  extractRelativeImportSpecifiers,
  resolveImportNeighbors
} from '../../src/shared/import-graph'

describe('extractRelativeImportSpecifiers', () => {
  it('extracts an ES import specifier', () => {
    expect(extractRelativeImportSpecifiers("import { foo } from './foo'")).toEqual(['./foo'])
  })

  it('extracts a require() specifier', () => {
    expect(extractRelativeImportSpecifiers("const x = require('../lib/x')")).toEqual(['../lib/x'])
  })

  it('ignores a bare package specifier', () => {
    expect(extractRelativeImportSpecifiers("import { z } from 'zod'")).toEqual([])
  })

  it('collects every specifier across multiple lines', () => {
    const source = ["import a from './a'", "import b from './b'", "import c from 'pkg'"].join('\n')
    expect(extractRelativeImportSpecifiers(source)).toEqual(['./a', './b'])
  })
})

describe('resolveImportNeighbors', () => {
  it('resolves a sibling-directory specifier against the indexed file set', () => {
    const allPaths = new Set(['src/main/a.ts', 'src/main/b.ts'])
    const neighbors = resolveImportNeighbors('src/main/a.ts', "import { b } from './b'", allPaths)
    expect(neighbors).toEqual(['src/main/b.ts'])
  })

  it('resolves a parent-directory specifier', () => {
    const allPaths = new Set(['src/shared/util.ts', 'src/main/a.ts'])
    const neighbors = resolveImportNeighbors(
      'src/main/a.ts',
      "import { util } from '../shared/util'",
      allPaths
    )
    expect(neighbors).toEqual(['src/shared/util.ts'])
  })

  it('resolves an index import', () => {
    const allPaths = new Set(['src/lib/index.ts'])
    const neighbors = resolveImportNeighbors('src/main/a.ts', "import { x } from '../lib'", allPaths)
    expect(neighbors).toEqual(['src/lib/index.ts'])
  })

  it('drops a specifier that does not resolve into the indexed set', () => {
    const allPaths = new Set(['src/main/a.ts'])
    const neighbors = resolveImportNeighbors('src/main/a.ts', "import { x } from './missing'", allPaths)
    expect(neighbors).toEqual([])
  })

  it('returns nothing for a file with no relative imports', () => {
    const allPaths = new Set(['src/main/a.ts'])
    expect(resolveImportNeighbors('src/main/a.ts', "import { z } from 'zod'", allPaths)).toEqual([])
  })
})

describe('buildNeighborMap', () => {
  it('symmetrizes a one-directional import into a two-directional neighbor list', () => {
    const forward = new Map<string, readonly string[]>([
      ['a.ts', ['b.ts']],
      ['b.ts', []]
    ])
    const map = buildNeighborMap(forward)
    expect(map['a.ts']).toEqual(['b.ts'])
    expect(map['b.ts']).toEqual(['a.ts'])
  })

  it('merges neighbors from both directions when both files import each other', () => {
    const forward = new Map<string, readonly string[]>([
      ['a.ts', ['b.ts']],
      ['b.ts', ['a.ts']]
    ])
    const map = buildNeighborMap(forward)
    expect(map['a.ts']).toEqual(['b.ts'])
    expect(map['b.ts']).toEqual(['a.ts'])
  })

  it('does not duplicate a neighbor named by more than one importer', () => {
    const forward = new Map<string, readonly string[]>([
      ['a.ts', ['shared.ts']],
      ['b.ts', ['shared.ts']]
    ])
    const map = buildNeighborMap(forward)
    expect(map['shared.ts']).toEqual(['a.ts', 'b.ts'])
  })
})
