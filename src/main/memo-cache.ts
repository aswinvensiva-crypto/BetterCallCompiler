import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import type { EngineSnapshot } from '../shared/query-engine'

/**
 * The on-disk memo cache.
 *
 * Cold start measures 2848–3500 ms, essentially all program and checker
 * construction — `ts.createLanguageService` building a `ts.Program` and then
 * `getSemanticDiagnostics` building the type checker on top of it, both of
 * which happen fresh every time the daemon boots even when nothing on disk
 * has moved since the last session. This persists the query engine's memo
 * state (`diag:`, `sig:`, `text:`, `mod:`) to `.bettercallcompiler/cache/` so
 * a second boot over an UNCHANGED workspace can validate those memos instead
 * of recomputing them.
 *
 * ## Why the key matters more than the speed-up
 *
 * A cache keyed on too little silently serves diagnostics computed by a
 * DIFFERENT compiler, or against DIFFERENT options, or against a workspace
 * that has moved since the snapshot was taken. That is the worst failure this
 * daemon can produce — clean-looking code that does not actually compile —
 * so every part of `CacheKeyInputs` exists because some part of "what a
 * diagnostic means" depends on it:
 *
 *   - `tsVersion`             — a different `typescript` build can check
 *                                differently even against identical options.
 *   - `compilerOptionsHash`   — `strict`, `target`, `paths`, all of it.
 *   - `defaultLibPath` + size + mtime — the packaged copy under
 *     `process.resourcesPath` and the `node_modules` copy can differ, and a
 *     path match alone does not prove the FILE match.
 *   - `tsconfigRelativePath`  — which config was even adopted.
 *   - `workspaceRoot` (case-folded) — two workspaces must never share a slot.
 *
 * Even with an exact key match, the cache is rejected unless every file the
 * cached graph named is still on disk, unchanged, and nothing new has
 * appeared — see `filesMatch` in compiler-worker.ts's caller. A key match
 * proves the COMPILER is the same; it says nothing about the WORKSPACE.
 */

export interface CacheKeyInputs {
  readonly tsVersion: string
  readonly compilerOptions: ts.CompilerOptions
  readonly defaultLibPath: string
  readonly tsconfigRelativePath: string | null
  readonly workspaceRoot: string
}

/** A stable hash regardless of key insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Stat-based identity for the default lib file, not just its path — two
 * files at different paths that happen to share a basename are not proof of
 * anything, but neither is a path alone: the packaged copy and the
 * `node_modules` copy of the SAME filename can differ in content across an
 * upgrade that only touched one of them.
 */
function libIdentity(path: string): string {
  try {
    const stat = statSync(path)
    return `${path}::${stat.size}::${stat.mtimeMs}`
  } catch {
    return `${path}::missing`
  }
}

/**
 * The cache key: a single opaque string, but every component that composed
 * it is deliberate — see the module doc comment for what each one guards
 * against.
 */
export function computeCacheKey(inputs: CacheKeyInputs): string {
  const parts = [
    `ts=${inputs.tsVersion}`,
    `opts=${sha256(stableStringify(inputs.compilerOptions))}`,
    `lib=${libIdentity(inputs.defaultLibPath)}`,
    `tsconfig=${inputs.tsconfigRelativePath ?? '(none)'}`,
    // Case-folded: Windows and macOS default to case-insensitive filesystems,
    // where two spellings of the same root are the same workspace.
    `root=${inputs.workspaceRoot.toLowerCase()}`
  ]
  return sha256(parts.join('|'))
}

export interface CachedFileRecord {
  readonly relativePath: string
  readonly imports: readonly string[]
  readonly mtimeMs: number
}

export interface CacheFile {
  readonly key: string
  readonly createdAt: number
  readonly files: readonly CachedFileRecord[]
  readonly snapshot: EngineSnapshot
}

function cacheDir(root: string): string {
  return join(root, '.bettercallcompiler', 'cache')
}

function cachePath(root: string, key: string): string {
  // The key is already a hash; using it as the filename keeps one slot per
  // (compiler identity, workspace) pair rather than accumulating a file per
  // boot.
  return join(cacheDir(root), `${key}.json`)
}

/**
 * Reads the cache for `key`, or null when there is none or it does not parse.
 *
 * A corrupt or foreign-shaped file is treated exactly like a miss — this is a
 * cache, not a source of truth, and refusing to boot over a bad cache file
 * would be a regression a mere disk hiccup should never cause.
 */
export function readCache(root: string, key: string): CacheFile | null {
  try {
    const raw = readFileSync(cachePath(root, key), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CacheFile>
    if (
      typeof parsed.key !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      !Array.isArray(parsed.files) ||
      typeof parsed.snapshot !== 'object' ||
      parsed.snapshot === null
    ) {
      return null
    }
    // The stored key must match the one just computed — belt and braces
    // alongside the caller comparing filenames, since a key collision in the
    // hash would otherwise serve the wrong workspace's cache unnoticed.
    if (parsed.key !== key) return null
    return parsed as CacheFile
  } catch {
    return null
  }
}

/**
 * Writes the cache for `key`, replacing whatever was there.
 *
 * Synchronous and best-effort: a write failure (read-only filesystem, no
 * space) must not crash the worker or interrupt checking — the cache is
 * purely an optimization, and every caller treats a failed write the same as
 * one that never happened.
 */
export function writeCache(root: string, key: string, file: Omit<CacheFile, 'key'>): void {
  try {
    const dir = cacheDir(root)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(cachePath(root, key), JSON.stringify({ key, ...file }), 'utf8')
  } catch {
    // Best-effort. See doc comment.
  }
}
