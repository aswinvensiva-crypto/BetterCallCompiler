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
  invalidationSet,
  removeNode,
  upsertNode,
  type Cycle
} from '../shared/dependency-graph'
import { lineStartsOf, rangeFromSpan } from '../shared/diagnostic-position'
import {
  QueryCycleError,
  createEngine,
  queryKey,
  type Engine,
  type QueryTrace
} from '../shared/query-engine'
import { isMemoReuse } from '../shared/pass-analysis'
import { moduleSignature } from './module-signature'
import type {
  BuildGraphSummary,
  CompilerDaemonState,
  CompilerPass,
  CompilerTraceEvent,
  DependencyNode,
  DiagnosticMessage,
  DiagnosticSeverity,
  FileDiagnostics
} from '../shared/types'

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

  // Every memo describes a workspace that no longer exists, and the compiler
  // options may have changed underneath them. Inputs go too, because this walk
  // re-seeds all of them.
  engine.clear()
  engineTexts.clear()
  // Versions are deliberately NOT cleared. They must stay monotonic across a
  // re-index or the LanguageService, whose document registry outlives this
  // call, sees a version it has already cached and keeps a stale snapshot.
  for (const [path, version] of textVersions) textVersions.set(path, version + 1)

  for (const absolute of walk(root)) {
    const text = readIfPossible(absolute)
    if (text === null) continue

    const relativePath = toRelative(root, absolute)
    upsertNode(graph, {
      relativePath,
      imports: importsOf(root, absolute, text),
      mtimeMs: mtimeOf(absolute)
    })

    // Seeded, not computed. Writing an input is the cheap half; nothing is
    // checked until something asks.
    writeText(relativePath, text)
  }

  cycles = assignComponents(graph)
  lastBuildMs = Date.now() - started

  // The program changed shape, so any cached service is describing a different
  // workspace.
  service = null

  busySince = null
  reportState('idle')
}

function applyChanges(
  root: string,
  changed: readonly string[],
  removed: readonly string[],
  reason: CompilerPass['reason'] = 'watch'
): void {
  if (changed.length === 0 && removed.length === 0) return

  busySince = Date.now()
  reportState('checking')

  /**
   * Who imported the files that are going away.
   *
   * Captured BEFORE the nodes are removed, and that ordering is the entire
   * point. `dependentsOf` starts from `graph.nodes.get(relativePath)`, so once
   * `removeNode` has run it returns an empty array — the reverse edges die with
   * the node. Removing first and asking afterwards, which is what this function
   * used to do, meant deleting a file never invalidated anything that imported
   * it, and the importers never got their "Cannot find module" until some
   * unrelated edit happened to touch them.
   */
  const orphanedDependents: string[] = []
  for (const relativePath of removed) {
    orphanedDependents.push(...dependentsOf(graph, relativePath))
  }

  for (const relativePath of removed) {
    removeNode(graph, relativePath)
    engine.removeInput(queryKey(Q_TEXT, relativePath))
  }

  for (const relativePath of changed) {
    if (!SOURCE_EXTENSIONS.has(extensionOf(relativePath))) continue
    const absolute = toAbsolute(root, relativePath)
    const text = overlays.get(relativePath)?.content ?? readIfPossible(absolute)
    if (text === null) {
      // Reported as changed but unreadable — treat it as gone rather than
      // leaving a node describing content nobody can read. Same capture-first
      // rule as the removals above: this is a deletion by another name.
      orphanedDependents.push(...dependentsOf(graph, relativePath))
      removeNode(graph, relativePath)
      engine.removeInput(queryKey(Q_TEXT, relativePath))
      continue
    }

    upsertNode(graph, {
      relativePath,
      imports: importsOf(root, absolute, text),
      mtimeMs: mtimeOf(absolute)
    })

    // Returns false when the bytes are identical, which a watcher reports far
    // more often than people expect — a save with no edit, a touch, an editor
    // rewriting a file on focus loss. Nothing downstream is invalidated then.
    setTextInput(root, relativePath)
  }

  if (graph.dirty) cycles = assignComponents(graph)

  // A changed file invalidates itself and everything that transitively imports
  // it — that reverse walk is the whole point of the graph, and what makes a
  // squiggle appear in a dependent file the user never touched.
  //
  // The walk still names the same files it always did. What changed is what
  // asking about them costs: a dependent whose imports' SIGNATURES have not
  // moved is answered from memo, so a body edit no longer drags the type
  // checker across the transitive closure.
  const affected = invalidationSet(graph, [
    ...changed,
    ...removed,
    ...orphanedDependents
  ]).filter((file) => graph.nodes.has(file))
  // Capped, because a git checkout coalesced by the watcher can name hundreds of
  // paths and this rides the same structured clone as the trace sample.
  checkFiles(root, affected, reason, [...changed, ...removed].slice(0, MAX_TRIGGER_PATHS))

  busySince = null
  reportState('idle', affected.length)
}

/* ---------------------------- language service ---------------------------- */

/**
 * Where `lib.*.d.ts` actually live.
 *
 * `ts.getDefaultLibFilePath` resolves relative to the typescript package, which
 * is correct in development. In a packaged build those files are NOT beside the
 * package: electron-builder appends `!**\/*.{…,d.ts,…}` as its last file
 * pattern, so every one of the 99 lib files is stripped from app.asar and no
 * `files` entry can re-include them. They are shipped via `extraResources` to
 * `resources/typescript-lib` instead, which is a separate pipeline that the
 * filter does not touch.
 *
 * Probing for the file rather than branching on `app.isPackaged` keeps this
 * worker free of any electron import — it is a plain Node thread and must stay
 * one.
 */
function defaultLibPath(options: ts.CompilerOptions): string {
  const packaged = join(process.resourcesPath ?? '', 'typescript-lib', ts.getDefaultLibFileName(options))
  try {
    if (process.resourcesPath !== undefined && statSync(packaged).isFile()) return packaged
  } catch {
    // Not a packaged build, or the resource is missing; fall through.
  }
  return ts.getDefaultLibFilePath(options)
}

let service: ts.LanguageService | null = null

/** Bumped per file on every edit so the host knows a snapshot is stale. */
const documentVersions = new Map<string, number>()

/** Files that had diagnostics last pass — the clean-sweep set. */
let previouslyDirty = new Set<string>()

/** Monotonic per file, so the renderer can discard an out-of-order batch. */
const emittedVersions = new Map<string, number>()

function bumpVersion(relativePath: string): void {
  documentVersions.set(relativePath, (documentVersions.get(relativePath) ?? 0) + 1)
}

/**
 * The file list handed to the LanguageService.
 *
 * Seeded from the walked graph, NOT from the tsconfig alone. This repository's
 * own root tsconfig.json is an include-less stub that resolves to no files;
 * trusting it would produce an empty program and a daemon that reports
 * everything as clean because it checked nothing.
 */
function scriptFileNames(root: string): string[] {
  const names = new Set<string>()
  for (const relativePath of graph.nodes.keys()) {
    names.add(toAbsolute(root, relativePath))
  }
  return [...names]
}

function createService(root: string): ts.LanguageService {
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => scriptFileNames(root),
    getScriptVersion: (fileName) => {
      const relativePath = toRelative(root, fileName)
      const overlay = overlays.get(relativePath)
      if (overlay !== undefined) return `o${overlay.version}`
      // A counter the daemon controls, NOT mtime. See `textVersions` for why
      // the filesystem clock is not usable as a change signal here.
      return `d${textVersions.get(relativePath) ?? documentVersions.get(relativePath) ?? 0}`
    },
    getScriptSnapshot: (fileName) => {
      const relativePath = toRelative(root, fileName)

      // Overlay first: the daemon must check the buffer the user is looking at,
      // not the last thing written to disk.
      const overlay = overlays.get(relativePath)
      if (overlay !== undefined) return ts.ScriptSnapshot.fromString(overlay.content)

      // Then the engine's own copy, which is what every query was computed
      // against. Reading disk here instead would let the service and the engine
      // disagree about the same file within one pass.
      const held = engineTexts.get(relativePath)
      if (held !== undefined) return ts.ScriptSnapshot.fromString(held)

      const text = readIfPossible(fileName)
      return text === null ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => defaultLibPath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  }

  return ts.createLanguageService(host, ts.createDocumentRegistry())
}

const SEVERITY_BY_CATEGORY: Readonly<Record<ts.DiagnosticCategory, DiagnosticSeverity>> = {
  [ts.DiagnosticCategory.Error]: 'error',
  [ts.DiagnosticCategory.Warning]: 'warning',
  [ts.DiagnosticCategory.Suggestion]: 'hint',
  [ts.DiagnosticCategory.Message]: 'info'
}

function toDiagnosticMessage(
  root: string,
  relativePath: string,
  lineStarts: readonly number[],
  diagnostic: ts.Diagnostic
): DiagnosticMessage {
  const range = rangeFromSpan(lineStarts, diagnostic.start ?? 0, diagnostic.length ?? 0)

  return {
    relativePath,
    path: toAbsolute(root, relativePath),
    severity: SEVERITY_BY_CATEGORY[diagnostic.category] ?? 'error',
    code: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    ...range,
    source: 'typescript'
  }
}

/** A cycle warning, anchored on the file rather than an arbitrary line. */
function cycleDiagnostic(root: string, relativePath: string, cycle: Cycle): DiagnosticMessage {
  const others = cycle.members.filter((member) => member !== relativePath)
  return {
    relativePath,
    path: toAbsolute(root, relativePath),
    severity: 'warning',
    code: 'TS-CYCLE',
    message: `Import cycle: this file and ${others.join(', ')} import each other.`,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 2,
    source: 'graph'
  }
}

/* ------------------------------ query layer ------------------------------- */

/**
 * Query namespaces.
 *
 * `text` is the only input; everything else is derived and therefore lazy.
 * Short names because they appear in every trace line and in the Compiler
 * Intelligence view, where `diag:src/app.ts` reads and
 * `semanticDiagnostics:src/app.ts` does not.
 */
const Q_TEXT = 'text'
const Q_SIG = 'sig'
const Q_DIAG = 'diag'

/** Trace lines for the pass currently in flight. */
let passEvents: QueryTrace[] = []
let passCounter = 0

/**
 * Capped, because a cold index over 20 000 files would otherwise build a
 * 60 000-entry array and structured-clone it across the port. The panel shows
 * the most expensive work, so the cap drops the tail rather than the head —
 * and `stats` on the pass still counts everything, so the totals stay honest
 * even when the list is truncated.
 */
/**
 * Two budgets, not one, because the two kinds of event are not worth the same.
 *
 * A `diag:` event is one file's answer and is the ONLY thing the Why tab can look
 * up. `text:` and `sig:` events are supporting detail. Under a single shared cap
 * the ordering in checkFiles — open files first — meant that on a pass over
 * roughly 160 files the diag event for the file you did NOT edit was the one
 * dropped, which is exactly the file anyone asks "why was this rechecked?" about.
 *
 * The cap still exists for the reason it always did: a cold pass over a large
 * workspace would otherwise structured-clone a vast array across the port. It is
 * the allocation between kinds that was wrong, not the existence of a limit.
 */
/** Enough to name the edit; a coalesced batch is summarised by its first few. */
const MAX_TRIGGER_PATHS = 20

const MAX_DIAG_TRACE_EVENTS = 2000
const MAX_OTHER_TRACE_EVENTS = 500

/**
 * Per-pass totals, counted here rather than derived from `passEvents`.
 *
 * They have to be. The cap below is applied BEFORE the push, so a pass over
 * more than about 160 files — three events each — silently stops recording, and
 * anything counted by walking the array afterwards would report the size of the
 * cap rather than the size of the work. The panel's headline sentence is built
 * from these numbers, so it would have quietly understated every large pass.
 *
 * Counted for `diag:` keys only, which is exactly the set of files the pass was
 * asked about: `diag:` is never pulled as a dependency — the queries reach for
 * `text:` and `sig:` and nothing else — so every diagnostics trace is a
 * top-level get, one per file.
 */
let passRecomputed = 0
let passReused = 0
let diagKept = 0
let otherKept = 0

const engine: Engine = createEngine({
  onTrace: (trace) => {
    const isDiag = trace.key.startsWith(`${Q_DIAG}:`)

    // Counted before any cap test, so the totals are exact regardless of what
    // the sample keeps. `isMemoReuse` is shared with hotspotsOf so the panel
    // cannot disagree with itself about what counts as reuse.
    if (isDiag) {
      if (isMemoReuse(trace.outcome)) passReused++
      else passRecomputed++
    }

    // Interleaved in one array on purpose: the Why tab reads a file's events in
    // the order they happened (text -> sig -> diag), so splitting the storage
    // would lose that.
    if (isDiag) {
      if (diagKept < MAX_DIAG_TRACE_EVENTS) {
        passEvents.push(trace)
        diagKept++
      }
      return
    }
    if (otherKept < MAX_OTHER_TRACE_EVENTS) {
      passEvents.push(trace)
      otherKept++
    }
  }
})

function ensureService(root: string): ts.LanguageService {
  if (service === null) service = createService(root)
  return service
}

/**
 * Pulls the signatures a file's imports contribute, recording the edges.
 *
 * The subtlety is import cycles, which are ordinary TypeScript. Inside a
 * strongly-connected component, asking for a member's signature would ask for
 * this file's signature again and the engine would report a query cycle. So
 * within a component the dependency is on the raw TEXT of the other members —
 * an input, so it terminates — and only edges leaving the component use
 * signatures. Across components the import graph is a DAG by construction, so
 * that half can never cycle.
 *
 * `componentId` is already maintained by `assignComponents`; this reuses it
 * rather than re-deriving cycle membership.
 */
function pullImportSignatures(relativePath: string, ctx: { get<T>(key: string): T }): void {
  const node = graph.nodes.get(relativePath)
  if (node === undefined) return

  for (const imported of node.imports) {
    const target = graph.nodes.get(imported)
    // An edge pointing at nothing is a deleted or unresolved file. Its
    // diagnostics are the dependent's problem to report, and there is no
    // signature to depend on.
    if (target === undefined) continue

    if (target.componentId === node.componentId) {
      ctx.get(queryKey(Q_TEXT, imported))
    } else {
      ctx.get(queryKey(Q_SIG, imported))
    }
  }
}

/**
 * A module's public type surface.
 *
 * Depends on its own text AND on its imports' signatures, which is what makes
 * the chain transitive: C changes, so B's signature is revalidated, and only if
 * B's own exported types actually moved does A get rechecked. Depending on text
 * alone would leave a hole exactly where a file re-exports or infers from
 * something it imports.
 */
engine.defineQuery(Q_SIG, (relativePath, ctx) => {
  // A module that has left the graph has no public surface, and asking for its
  // text would be worse than useless: `text:` is an INPUT, so once
  // `removeInput` has dropped it there is no compute function behind that
  // namespace and resolving it throws.
  //
  // The engine already refuses to VALIDATE against a vanished dependency
  // (query-engine.ts treats a missing memo as a change), which is what makes a
  // dependent recompute. This is the other half: the recompute itself must not
  // walk back into the file that is gone. Returning a distinct constant rather
  // than 'absent' matters — a signature that CHANGED is what forces every
  // importer to recheck and discover its now-unresolvable import.
  if (!graph.nodes.has(relativePath)) return 'deleted'

  ctx.get(queryKey(Q_TEXT, relativePath))
  pullImportSignatures(relativePath, ctx)

  const root = workspaceRoot
  if (root === null) return 'no-root'

  const program = ensureService(root).getProgram()
  const sourceFile = program?.getSourceFile(toAbsolute(root, relativePath))
  if (program === undefined || sourceFile === undefined) return 'absent'

  return moduleSignature(program.getTypeChecker(), sourceFile)
})

/**
 * One file's diagnostics.
 *
 * The dependency set is the whole point: own text, plus the SIGNATURES of the
 * imports — not their text. An edit to a function body in an imported module
 * moves that module's text and not its signature, the signature query cuts off,
 * and this memo validates without the type checker running at all. That is the
 * saving, and on a wide graph it is the difference between one check and
 * hundreds.
 */
engine.defineQuery(
  Q_DIAG,
  (relativePath, ctx) => {
    ctx.get(queryKey(Q_TEXT, relativePath))
    pullImportSignatures(relativePath, ctx)

    const root = workspaceRoot
    if (root === null) return []

    const absolute = toAbsolute(root, relativePath)
    const languageService = ensureService(root)

    let raw: ts.Diagnostic[]
    try {
      const semantic = languageService.getSemanticDiagnostics(absolute)
      // Skipped for files with an overlay: Monaco's own bundled TS worker
      // already reports these instantly and locally for open models, and
      // reporting them here too would draw every syntax error twice.
      const syntactic = overlays.has(relativePath)
        ? []
        : languageService.getSyntacticDiagnostics(absolute)
      raw = [...semantic, ...syntactic]
    } catch {
      // A file the program cannot load yields nothing rather than abandoning
      // the pass — the same tolerance the imperative version had.
      return []
    }

    const text = overlays.get(relativePath)?.content ?? readIfPossible(absolute) ?? ''
    const lineStarts = lineStartsOf(text)

    const diagnostics = raw.map((diagnostic) =>
      toDiagnosticMessage(root, relativePath, lineStarts, diagnostic)
    )

    const cycle = cycleFor(cycles, relativePath)
    if (cycle !== null) diagnostics.push(cycleDiagnostic(root, relativePath, cycle))

    return diagnostics
  },
  // Structural equality, not Object.is. Every pass builds fresh objects, so
  // reference equality would never cut off and the mechanism would be dead on
  // the one query it matters most for.
  (a, b) => JSON.stringify(a) === JSON.stringify(b)
)

/**
 * The text the engine currently holds for each file, and a counter that moves
 * whenever it does.
 *
 * These exist because the LanguageService host used to derive its script
 * version from `mtimeMs`, and mtime is not a reliable change signal. Two writes
 * inside the same filesystem timestamp tick — which is a millisecond on NTFS,
 * and coarser on some volumes — produce the SAME version, so the service keeps
 * serving its cached snapshot and type-checks text that no longer exists.
 *
 * The symptom is diagnostics that lag exactly one pass behind: break a file and
 * nothing appears, fix it and the error from the previous edit shows up. Found
 * by test/query/run-cutoff-proof.mjs, which writes files milliseconds apart;
 * it is rarer at human typing speed but it is not rare enough to leave in.
 *
 * With the engine holding every file's text there is now a better source of
 * truth than the filesystem's clock, so the host reads from here and mtime is
 * off the correctness path entirely. It still feeds the graph's `mtimeMs`,
 * which is display only.
 */
const engineTexts = new Map<string, string>()
const textVersions = new Map<string, number>()

/** Writes text to the engine and to the host's view of it, together. */
function writeText(relativePath: string, text: string): boolean {
  const changed = engine.setInput(queryKey(Q_TEXT, relativePath), text, 'workspace')
  if (changed) {
    engineTexts.set(relativePath, text)
    textVersions.set(relativePath, (textVersions.get(relativePath) ?? 0) + 1)
  }
  return changed
}

/** Writes a file's text as an engine input. Returns true if it actually moved. */
function setTextInput(root: string, relativePath: string): boolean {
  const absolute = toAbsolute(root, relativePath)
  const text = overlays.get(relativePath)?.content ?? readIfPossible(absolute)

  if (text === null) {
    engineTexts.delete(relativePath)
    textVersions.set(relativePath, (textVersions.get(relativePath) ?? 0) + 1)
    return engine.removeInput(queryKey(Q_TEXT, relativePath))
  }

  return writeText(relativePath, text)
}

function toTraceEvent(trace: QueryTrace): CompilerTraceEvent {
  return {
    key: trace.key,
    outcome: trace.outcome,
    durability: trace.durability,
    ms: trace.ms,
    depth: trace.depth,
    depsWalked: trace.depsWalked
  }
}

/**
 * Publishes what the pass actually did.
 *
 * `recomputed` counts only `diag:` keys that reached the type checker, and
 * `reused` the ones served from memo. Those two are the headline pair: the gap
 * between them is the work the signature cutoff saved, and it is the number
 * worth putting in front of a user.
 *
 * Totals come from the counters incremented in `onTrace`, NOT from walking
 * `passEvents`. This used to walk the array and claimed in this very comment
 * that "a capped trace still reports accurate totals because the cap is applied
 * after these are counted" — which was backwards. The cap is applied on the way
 * in, so past roughly 160 files the array stops growing and the totals derived
 * from it stopped growing with it. The events list is a sample for the panel to
 * show; the counters are the measurement.
 */
function reportPass(
  reason: CompilerPass['reason'],
  requested: number,
  startedAt: number,
  before: ReturnType<Engine['stats']>,
  trigger: readonly string[]
): void {
  const recomputed = passRecomputed
  const reused = passReused

  const after = engine.stats()

  post({
    type: 'pass',
    pass: {
      id: ++passCounter,
      reason,
      trigger: [...trigger],
      requested,
      recomputed,
      reused,
      totalMs: Date.now() - startedAt,
      events: passEvents.map(toTraceEvent),
      stats: {
        revision: after.revision,
        memoCount: after.memoCount,
        // Deltas, not lifetime totals: the panel is showing one pass, and a
        // running total would make every pass look busier than the last.
        hits: after.hits - before.hits,
        misses: after.misses - before.misses,
        recomputes: after.recomputes - before.recomputes,
        cutoffs: after.cutoffs - before.cutoffs,
        durableSkips: after.durableSkips - before.durableSkips
      }
    }
  })

  passEvents = []
}

/**
 * Checks a set of files and posts their diagnostics.
 *
 * Files with an overlay are checked first — they are what the user is looking
 * at, and getting a squiggle onto the visible file before the rest of the
 * workspace is what makes this feel live rather than batch.
 */
function checkFiles(
  root: string,
  files: readonly string[],
  reason: CompilerPass['reason'],
  trigger: readonly string[]
): void {
  // Captured BEFORE ensureService, because that call is what makes it false.
  //
  // The first check of a workspace costs seconds, and almost none of that is the
  // check: it is ts.createLanguageService building the program and the type
  // checker on the first getSemanticDiagnostics, which happens inside this
  // function. Left untagged it lands in the p50/p95 of a figure labelled
  // keystroke-to-diagnostic and drags it somewhere meaningless.
  //
  // Self-maintaining: indexWorkspace already nulls `service` when the program
  // changes shape, so a re-index re-arms the tag with no extra bookkeeping.
  const cold = service === null
  ensureService(root)

  const ordered = [
    ...files.filter((file) => overlays.has(file)),
    ...files.filter((file) => !overlays.has(file))
  ]

  const produced: FileDiagnostics[] = []
  const nowDirty = new Set<string>()

  passEvents = []
  passRecomputed = 0
  passReused = 0
  diagKept = 0
  otherKept = 0
  const startedAt = Date.now()
  const before = engine.stats()

  for (const relativePath of ordered) {
    const absolute = toAbsolute(root, relativePath)

    let diagnostics: DiagnosticMessage[]
    try {
      diagnostics = engine.get<DiagnosticMessage[]>(queryKey(Q_DIAG, relativePath))
    } catch (error) {
      // A query cycle is a bug in the dependency wiring rather than in the
      // user's code, and it must not cost them the rest of the pass.
      if (!(error instanceof QueryCycleError)) throw error
      continue
    }

    const version = (emittedVersions.get(relativePath) ?? 0) + 1
    emittedVersions.set(relativePath, version)

    produced.push({ relativePath, path: absolute, diagnostics, version })
    if (diagnostics.length > 0) nowDirty.add(relativePath)
  }

  // NOTE: the pass is reported at the END of this function, after the
  // diagnostics have gone out. Announcing "the pass is done" before its results
  // are on the wire is a lie a consumer can act on — and did: the first version
  // of run-cutoff-proof.mjs read the pass, looked for the diagnostics that had
  // not been sent yet, and reported a correctness failure that was purely
  // ordering. Diagnostics are the payload; the pass is the receipt.

  // Clean sweep: anything that had diagnostics last pass but was not re-checked
  // this pass gets an explicit empty set, or its squiggles never clear.
  for (const relativePath of previouslyDirty) {
    if (nowDirty.has(relativePath)) continue
    if (ordered.includes(relativePath)) continue
    if (!graph.nodes.has(relativePath)) {
      // Deleted: still emit an empty set so the Problems panel drops the row.
      const version = (emittedVersions.get(relativePath) ?? 0) + 1
      emittedVersions.set(relativePath, version)
      produced.push({
        relativePath,
        path: toAbsolute(root, relativePath),
        diagnostics: [],
        version
      })
    }
  }

  previouslyDirty = nowDirty

  if (produced.length > 0) post({ type: 'diagnostics', files: produced, settled: true })

  reportPass(cold ? 'cold' : reason, ordered.length, startedAt, before, trigger)
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
      bumpVersion(request.relativePath)
      if (workspaceRoot !== null) {
        applyChanges(workspaceRoot, [request.relativePath], [], 'buffer')
      }
      return

    case 'closeDocument':
      overlays.delete(request.relativePath)
      // The buffer is gone, so the next check must read disk rather than serve
      // a snapshot the host still thinks is current.
      bumpVersion(request.relativePath)
      // The engine's input must follow. Without this it keeps serving the
      // discarded buffer's text, and closing a tab with unsaved changes would
      // leave diagnostics describing text that exists nowhere.
      if (workspaceRoot !== null) setTextInput(workspaceRoot, request.relativePath)
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
