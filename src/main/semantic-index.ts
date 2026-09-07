import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import { chunkSource } from '../shared/code-chunker'
import { embed } from '../shared/lexical-embedding'
import { buildNeighborMap, resolveImportNeighbors } from '../shared/import-graph'
import { scoreChunks, type ScoredChunkInput } from '../shared/semantic-scoring'
import type { SemanticIndexStatus, SemanticMatch } from '../shared/types'
import { getWorkspace, listFiles, readFile as readWorkspaceFile } from './fs-service'

/**
 * The offline chunker and embedding index the plan asks for, stored inside
 * `.bettercallcompiler/` alongside the AI log and the artifact store.
 *
 * This module is orchestration only — walking the workspace, reading files,
 * persisting JSON. The actual chunking (`code-chunker.ts`), embedding
 * (`lexical-embedding.ts`), import-proximity resolution (`import-graph.ts`)
 * and ranking (`semantic-scoring.ts`) all live in `shared/` as pure
 * functions, so the algorithm a retrieval bug would live in can be unit
 * tested without a workspace, a build, or a real repository on disk.
 *
 * Built on demand (`index:build`), not watched: see the note on the
 * `index:build` channel for why a live-updating index is not worth its
 * constant re-embedding cost for a feature only ever consulted once, right
 * before a prompt is sent.
 */

const BETTERCALLCOMPILER_DIR = '.bettercallcompiler'
const INDEX_FILE = 'semantic-index.json'

/** Only source-shaped files are worth chunking; a lockfile or a binary asset is not "codebase". */
const INDEXABLE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'bcc',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'md',
  'json'
])

/** A repository large enough to need this feature is exactly the one this cap protects the build from stalling on. */
const MAX_INDEXED_FILES = 500
/** Skips generated bundles and lockfiles that would otherwise dominate the vocabulary. */
const MAX_FILE_BYTES = 200_000
const MAX_CHUNKS_TOTAL = 8000

interface StoredChunk {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly preview: string
  readonly vector: readonly number[]
}

interface StoredIndex {
  readonly version: 1
  readonly builtAt: string
  readonly files: readonly string[]
  readonly chunks: readonly StoredChunk[]
  /** File path -> its import-graph neighbors (`buildNeighborMap`), for the proximity boost. */
  readonly fileNeighbors: Readonly<Record<string, readonly string[]>>
}

let cache: StoredIndex | null = null

function requireRoot(): string {
  const root = getWorkspace().root
  if (root === null) throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'no folder is open')
  return root
}

function indexPath(root: string): string {
  return join(root, BETTERCALLCOMPILER_DIR, INDEX_FILE)
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
}

function statusOf(index: StoredIndex | null): SemanticIndexStatus {
  if (index === null) return { built: false, builtAt: null, fileCount: 0, chunkCount: 0 }
  return {
    built: true,
    builtAt: index.builtAt,
    fileCount: index.files.length,
    chunkCount: index.chunks.length
  }
}

async function loadFromDisk(root: string): Promise<StoredIndex | null> {
  try {
    const raw = await fsp.readFile(indexPath(root), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    // Minimal shape check rather than a full zod schema: this file is never
    // shown to a user and never crosses IPC — `index:status`/`index:query`
    // read the derived, already-validated `SemanticIndexStatus` /
    // `SemanticMatch` shapes instead. A corrupt cache file is treated the
    // same as no cache: rebuild rather than crash.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as StoredIndex).chunks) &&
      Array.isArray((parsed as StoredIndex).files)
    ) {
      return parsed as StoredIndex
    }
    return null
  } catch {
    return null
  }
}

/**
 * Walks the workspace, chunks every indexable file, embeds every chunk, and
 * resolves the import-adjacency map — then persists all of it in one JSON
 * file and caches it in memory for the queries that follow.
 */
export async function buildSemanticIndex(): Promise<SemanticIndexStatus> {
  const root = requireRoot()

  const nodes = (await listFiles()).filter((node) => INDEXABLE_EXTENSIONS.has(extOf(node.relativePath)))
  const selected = nodes.slice(0, MAX_INDEXED_FILES)

  const sources = new Map<string, string>()
  for (const node of selected) {
    try {
      const content = await readWorkspaceFile(node.relativePath)
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) continue
      sources.set(node.relativePath, content)
    } catch {
      // Unreadable file — permissions, a symlink that broke — skipped rather
      // than failing the whole build over one file nothing else needs.
    }
  }

  const allPaths = new Set(sources.keys())
  const forward = new Map<string, readonly string[]>()
  for (const [path, content] of sources) {
    forward.set(path, resolveImportNeighbors(path, content, allPaths))
  }
  const fileNeighbors = buildNeighborMap(forward)

  const chunks: StoredChunk[] = []
  outer: for (const [path, content] of sources) {
    for (const piece of chunkSource(content)) {
      // Filename tokens join the embedded text — legitimately lexical
      // (a file named `retry-policy.ts` is relevant to "retry" even if the
      // word never appears inside it) — but nothing about the import graph
      // enters the vector itself; proximity is a separate signal applied at
      // query time in `semantic-scoring.ts`, not folded in here.
      const vector = embed(`${path.replace(/[/_.-]/g, ' ')}\n${piece.text}`)
      chunks.push({
        path,
        startLine: piece.startLine,
        endLine: piece.endLine,
        preview: piece.text.split('\n').slice(0, 4).join('\n'),
        vector
      })
      if (chunks.length >= MAX_CHUNKS_TOTAL) break outer
    }
  }

  const index: StoredIndex = {
    version: 1,
    builtAt: new Date().toISOString(),
    files: [...sources.keys()],
    chunks,
    fileNeighbors
  }

  await fsp.mkdir(join(root, BETTERCALLCOMPILER_DIR), { recursive: true })
  await fsp.writeFile(indexPath(root), JSON.stringify(index), 'utf8')
  cache = index

  return statusOf(index)
}

/** The last built index's stats, without rebuilding — reads the on-disk cache if this process has not built one yet. */
export async function getSemanticIndexStatus(): Promise<SemanticIndexStatus> {
  const root = requireRoot()
  if (cache === null) cache = await loadFromDisk(root)
  return statusOf(cache)
}

/**
 * Ranked candidates for an instruction. Empty — never an error — when no
 * index has been built yet: querying before building is a caller mistake the
 * UI should prevent with a "Build index" affordance, not a `NO_WORKSPACE`-shaped
 * failure the user has no way to act on from a query box.
 */
export async function querySemanticIndex(instruction: string, limit: number): Promise<SemanticMatch[]> {
  const root = requireRoot()
  if (cache === null) cache = await loadFromDisk(root)
  if (cache === null || cache.chunks.length === 0) return []

  const queryVector = embed(instruction)
  const inputs: ScoredChunkInput[] = cache.chunks.map((chunk) => ({
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    preview: chunk.preview,
    vector: chunk.vector
  }))

  return scoreChunks(queryVector, inputs, { limit, fileNeighbors: cache.fileNeighbors })
}

/** Test hook: the in-memory cache is module state, exactly like every other main-side service here. */
export function resetSemanticIndexForTests(): void {
  cache = null
}
