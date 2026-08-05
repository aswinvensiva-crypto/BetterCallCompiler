import { parentPort } from 'node:worker_threads'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import {
  isWorkerRequest,
  type WorkerMessage,
  type WorkerRequest
} from '../shared/compiler-protocol'
import {
  assignComponents,
  createGraph,
  cycleFor,
  dependentsOf,
  edgeCount,
  removeNode,
  upsertNode,
  type Cycle
} from '../shared/dependency-graph'
import type { BuildGraphSummary, CompilerDaemonState, DependencyNode } from '../shared/types'

/**
 * The compiler daemon, running in a worker_thread.
 *
 * Never imports electron. It is a plain Node worker spawned by the main
 * process, which is the entire point: `ts.LanguageService` calls are
 * synchronous and would freeze the window for as long as a check takes.
 *
 * This step builds the dependency graph and reports cycles. Diagnostics land in
 * the next one — proving the graph on its own keeps the failure surface small
 * while the TypeScript integration is still unproven.
 */

const port = parentPort

function post(message: WorkerMessage): void {
  port?.postMessage(message)
}

/** Mirrors fs-service's UNWATCHED so both sides agree what "the workspace" is. */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.bettercallcompiler',
  'dist',
  'out',
  '.next'
])

/** Same ceiling as fs-service's listFiles, for the same reason. */
const MAX_WALKED_FILES = 20_000

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

let workspaceRoot: string | null = null
let graph = createGraph()
let cycles: Cycle[] = []
let truncated = false
let lastBuildMs = 0
let tsconfigRelativePath: string | null = null
let compilerOptions: ts.CompilerOptions = {}

/** Unsaved buffers, preferred over disk when the LanguageService lands. */
const overlays = new Map<string, { content: string; version: number }>()

let busySince: number | null = null

function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10
}

function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  return rel === '' ? '' : rel.split(sep).join('/')
}

function toAbsolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/* ------------------------------ config ----------------------------------- */

/**
 * Adopts the workspace tsconfig, or falls back to permissive defaults.
 *
 * `checkJs: false` in the fallback is deliberate: without a tsconfig, a plain
 * JavaScript project would otherwise sprout a wall of type errors nobody asked
 * for on first open.
 */
function loadConfig(root: string): void {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')

  if (configPath === undefined) {
    tsconfigRelativePath = null
    compilerOptions = {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      noEmit: true,
      skipLibCheck: true
    }
    return
  }

  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, root)

  tsconfigRelativePath = toRelative(root, configPath)
  compilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true }
}

/* ------------------------------- walking --------------------------------- */

function walk(root: string): string[] {
  const found: string[] = []
  const queue: string[] = [root]
  truncated = false

  while (queue.length > 0 && !truncated) {
    const directory = queue.shift()
    if (directory === undefined) break

    // Deliberately uninitialised-then-inferred rather than annotated:
    // `ReturnType<typeof readdirSync>` resolves to the Buffer overload and
    // every entry.name then types as a Buffer.
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      const absolute = join(directory, entry.name)

      if (entry.isDirectory()) {
        queue.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(extensionOf(entry.name))) continue

      if (found.length >= MAX_WALKED_FILES) {
        truncated = true
        break
      }
      found.push(absolute)
    }
  }

  return found
}

/* -------------------------------- imports -------------------------------- */

const resolutionCache = (): ts.ModuleResolutionCache | undefined =>
  workspaceRoot === null
    ? undefined
    : ts.createModuleResolutionCache(workspaceRoot, (name) => name, compilerOptions)

let moduleCache = resolutionCache()

/**
 * Resolved workspace-relative imports for one file.
 *
 * `preProcessFile` rather than a full parse: it is a scanner, not a parser, and
 * indexing 20 000 files with the real parser is the difference between a second
 * and a minute.
 *
 * A specifier that does not resolve, or resolves outside the workspace or into
 * node_modules, is DROPPED rather than guessed at. A fabricated edge invalidates
 * the wrong files, which is worse than a missing one.
 */
function importsOf(root: string, absolute: string, text: string): string[] {
  const pre = ts.preProcessFile(text, true, true)
  const out: string[] = []

  for (const reference of pre.importedFiles) {
    const resolved = ts.resolveModuleName(
      reference.fileName,
      absolute,
      compilerOptions,
      ts.sys,
      moduleCache
    ).resolvedModule

    if (resolved === undefined) continue
    if (resolved.isExternalLibraryImport === true) continue
    if (resolved.resolvedFileName.includes('node_modules')) continue

    const relativePath = toRelative(root, resolved.resolvedFileName)
    // `relative()` yields a leading '..' for anything outside the root.
    if (relativePath === '' || relativePath.startsWith('..')) continue

    out.push(relativePath)
  }

  return out
}

function readIfPossible(absolute: string): string | null {
  try {
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

function mtimeOf(absolute: string): number {
  try {
    return statSync(absolute).mtimeMs
  } catch {
    return 0
  }
}

/* ------------------------------ graph build ------------------------------- */

function summary(): BuildGraphSummary {
  return {
    fileCount: graph.nodes.size,
    edgeCount: edgeCount(graph),
    cycles: cycles.map((cycle) => ({ id: cycle.id, members: [...cycle.members] })),
    truncated,
    lastBuildMs,
    tsconfigRelativePath
  }
}

function reportState(state: CompilerDaemonState, checkedFileCount = 0): void {
  post({ type: 'state', state, graph: summary(), checkedFileCount })
}

function indexWorkspace(root: string): void {
  const started = Date.now()
  busySince = started
  reportState('indexing')

  graph = createGraph()
  loadConfig(root)
  moduleCache = resolutionCache()

  for (const absolute of walk(root)) {
    const text = readIfPossible(absolute)
    if (text === null) continue

    upsertNode(graph, {
      relativePath: toRelative(root, absolute),
      imports: importsOf(root, absolute, text),
      mtimeMs: mtimeOf(absolute)
    })
  }

  cycles = assignComponents(graph)
  lastBuildMs = Date.now() - started
  busySince = null
  reportState('idle')
}

function applyChanges(root: string, changed: readonly string[], removed: readonly string[]): void {
  if (changed.length === 0 && removed.length === 0) return

  busySince = Date.now()
  reportState('checking')

  for (const relativePath of removed) removeNode(graph, relativePath)

  for (const relativePath of changed) {
    if (!SOURCE_EXTENSIONS.has(extensionOf(relativePath))) continue
    const absolute = toAbsolute(root, relativePath)
    const text = overlays.get(relativePath)?.content ?? readIfPossible(absolute)
    if (text === null) {
      // Reported as changed but unreadable — treat it as gone rather than
      // leaving a node describing content nobody can read.
      removeNode(graph, relativePath)
      continue
    }

    upsertNode(graph, {
      relativePath,
      imports: importsOf(root, absolute, text),
      mtimeMs: mtimeOf(absolute)
    })
  }

  if (graph.dirty) cycles = assignComponents(graph)
  busySince = null
  reportState('idle')
}

function describeNode(root: string, relativePath: string): DependencyNode | null {
  const node = graph.nodes.get(relativePath)
  if (node === undefined) return null

  return {
    relativePath: node.relativePath,
    path: toAbsolute(root, node.relativePath),
    imports: [...node.imports],
    importedBy: [...node.importedBy],
    mtimeMs: node.mtimeMs,
    componentId: node.componentId
  }
}

/* -------------------------------- dispatch -------------------------------- */

function handle(request: WorkerRequest): void {
  switch (request.type) {
    case 'ping':
      post({ type: 'pong', nonce: request.nonce, heapUsedMb: heapUsedMb(), busySince })
      return

    case 'boot':
      workspaceRoot = request.workspaceRoot
      indexWorkspace(request.workspaceRoot)
      return

    case 'filesChanged':
      if (workspaceRoot === null) return
      applyChanges(workspaceRoot, request.changed, request.removed)
      return

    case 'openDocument':
      overlays.set(request.relativePath, {
        content: request.content,
        version: request.version
      })
      if (workspaceRoot !== null) applyChanges(workspaceRoot, [request.relativePath], [])
      return

    case 'closeDocument':
      overlays.delete(request.relativePath)
      return

    case 'dependents': {
      const root = workspaceRoot
      if (root === null) {
        post({
          type: 'dependentsResult',
          requestId: request.requestId,
          query: { node: null, dependents: [], cycle: null }
        })
        return
      }

      // `Cycle.members` is readonly internally; the wire type is a plain
      // array, so it is copied rather than cast.
      const cycle = cycleFor(cycles, request.relativePath)
      post({
        type: 'dependentsResult',
        requestId: request.requestId,
        query: {
          node: describeNode(root, request.relativePath),
          dependents: dependentsOf(graph, request.relativePath),
          cycle: cycle === null ? null : { id: cycle.id, members: [...cycle.members] }
        }
      })
      return
    }
  }
}

if (port !== null) {
  port.on('message', (raw: unknown) => {
    if (!isWorkerRequest(raw)) return
    try {
      handle(raw)
    } catch (error) {
      // A throw here kills the thread and trips the supervisor's restart
      // budget. Reporting keeps the daemon alive and the reason visible.
      busySince = null
      post({
        type: 'failure',
        detail: error instanceof Error ? error.message : 'unknown worker error'
      })
    }
  })

  post({ type: 'ready' })
}
