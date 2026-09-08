/**
 * A textual proxy for the import graph, used only to rank retrieval
 * candidates.
 *
 * This is NOT what navigation-providers.ts uses — that answers "where is this
 * defined" from the real `ts.LanguageService` because a wrong answer there
 * corrupts a jump or a rename. Nothing here is asked to be that precise: a
 * missed or extra neighbor costs the semantic index one candidate's ranking a
 * few places, not a broken file. Regex-based specifier extraction, matching
 * the standard `collectImports` in `code-context.ts` already sets for
 * retrieval-shaped uses of "what does this file import".
 */

const RELATIVE_IMPORT = /(?:from|require\()\s*['"](\.[^'"]+)['"]/g

/** Every `from './x'` / `require('../y')` specifier in the source, in order of appearance. */
export function extractRelativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  RELATIVE_IMPORT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = RELATIVE_IMPORT.exec(source)) !== null) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.push(specifier)
  }
  return specifiers
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']

/** Resolves a relative specifier against the importing file's directory, in POSIX path arithmetic only — no disk access. */
function candidatePathsFor(fromRelativePath: string, specifier: string): string[] {
  const dir = fromRelativePath.split('/').slice(0, -1)
  const stack = [...dir]

  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }

  const base = stack.join('/')
  return CANDIDATE_SUFFIXES.map((suffix) => `${base}${suffix}`)
}

/**
 * Every path in `allPaths` that `source` (at `fromRelativePath`) appears to
 * import. "Appears to" is load-bearing: without a tsconfig or a resolver this
 * cannot see path aliases or `node_modules`, and a specifier that resolves to
 * a file outside the indexed set is silently dropped rather than guessed at.
 */
export function resolveImportNeighbors(
  fromRelativePath: string,
  source: string,
  allPaths: ReadonlySet<string>
): string[] {
  const neighbors = new Set<string>()
  for (const specifier of extractRelativeImportSpecifiers(source)) {
    for (const candidate of candidatePathsFor(fromRelativePath, specifier)) {
      if (allPaths.has(candidate)) neighbors.add(candidate)
    }
  }
  return [...neighbors]
}

/**
 * Symmetrizes a forward import map into an undirected adjacency: if A imports
 * B, both A and B end up in each other's neighbor list. A file that imports
 * a helper and the helper itself are both "about" the same change, so the
 * proximity boost in `semantic-scoring.ts` should not care which direction
 * the `import` statement pointed.
 */
export function buildNeighborMap(
  forward: ReadonlyMap<string, readonly string[]>
): Record<string, string[]> {
  const adjacency = new Map<string, Set<string>>()

  const link = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    adjacency.get(a)?.add(b)
  }

  for (const [path, targets] of forward) {
    for (const target of targets) {
      link(path, target)
      link(target, path)
    }
  }

  const result: Record<string, string[]> = {}
  for (const [path, neighbors] of adjacency) result[path] = [...neighbors]
  return result
}
