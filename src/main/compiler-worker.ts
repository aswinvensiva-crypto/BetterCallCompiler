import { parentPort } from 'node:worker_threads'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'
import {
  SOURCE_EXTENSIONS,
  createLanguageServiceHost,
  defaultLibPath,
  extensionOf,
  loadWorkspaceConfig,
  toAbsolute,
  toRelative,
  walkSources
} from './ts-workspace'
import {
  emptyLanguageQueryAnswer,
  isWorkerRequest,
  type LanguageQueryAnswer,
  type LanguageQueryRequest,
  type WorkerMessage,
  type WorkerRequest
} from '../shared/compiler-protocol'
import {
  assignComponents,
  createGraph,
  cycleFor,
  dependentsOf,
  edgeCount,
  importPathTo,
  invalidationSet,
  removeNode,
  upsertNode,
  type Cycle
} from '../shared/dependency-graph'
import { lineStartsOf, rangeFromSpan } from '../shared/diagnostic-position'
import {
  QueryCycleError,
  argumentOf,
  createEngine,
  namespaceOf,
  queryKey,
  type Durability,
  type Engine,
  type QueryTrace
} from '../shared/query-engine'
import { isMemoReuse } from '../shared/pass-analysis'
import {
  SMALL_PASS_FILES,
  createLedger,
  departed,
  nextDrain,
  noteAbandoned,
  noteChecked,
  noteDeferred,
  planPass,
  type CheckLedger
} from '../shared/check-ledger'
import { moduleSignature } from './module-signature'
import {
  computeCacheKey,
  readCache,
  writeCache,
  type CachedFileRecord
} from './memo-cache'
import {
  MAX_CODE_ACTIONS,
  MAX_REFERENCE_RESULTS,
  type BuildGraphSummary,
  type CodeAction,
  type CompilerDaemonState,
  type CompilerPass,
  type CompilerTraceEvent,
  type DependencyNode,
  type DiagnosticMessage,
  type DiagnosticSeverity,
  type DocumentOverlay,
  type FileDiagnostics,
  type FileEdit,
  type LanguageLocation,
  type TextEdit
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

/* ------------------------------ cancellation ------------------------------ */

/**
 * The shared slot main writes to when it wants the current check to stop.
 *
 * Null until `boot` delivers one, and a null flag means checks simply cannot be
 * cancelled — which is the right behaviour for a supervisor that never supplied
 * a buffer rather than a reason to refuse to work.
 */
let cancellationFlag: Int32Array | null = null

function isCancellationRequested(): boolean {
  return cancellationFlag !== null && Atomics.load(cancellationFlag, 0) === 1
}

/**
 * Stands the flag down.
 *
 * Called the instant the worker starts answering a query, and not before. The
 * flag means "someone is waiting for an answer", so clearing it any earlier
 * would let the check it was raised against run to completion — and clearing it
 * any later would have the query itself throw `OperationCanceledException`,
 * because the LanguageService polls the same token for every call.
 */
function clearCancellation(): void {
  if (cancellationFlag !== null) Atomics.store(cancellationFlag, 0, 0)
}

/**
 * True for the exception a cancelled `ts.LanguageService` call throws.
 *
 * Checked by `instanceof` against the class TypeScript exports rather than by
 * message, because the message is not part of its API and the consequence of
 * getting this wrong is severe in one direction: a cancellation mistaken for an
 * ordinary failure publishes an EMPTY diagnostic set, which the clean sweep
 * reads as "this file is now clean" and every squiggle in it disappears.
 */
function isCancellation(error: unknown): boolean {
  return error instanceof ts.OperationCanceledException
}

function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10
}

/* ------------------------------ config ----------------------------------- */

/** Adopts the workspace tsconfig, or the permissive fallback. See ts-workspace. */
function loadConfig(root: string): void {
  const config = loadWorkspaceConfig(root)
  compilerOptions = config.options
  tsconfigRelativePath = config.tsconfigRelativePath
}

/* ------------------------------- walking --------------------------------- */

/** Walks the workspace for source files. See ts-workspace for the rules. */
function walk(root: string): string[] {
  const result = walkSources(root)
  truncated = result.truncated
  return result.files
}

/* -------------------------------- imports -------------------------------- */

const resolutionCache = (): ts.ModuleResolutionCache | undefined =>
  workspaceRoot === null
    ? undefined
    : ts.createModuleResolutionCache(workspaceRoot, (name) => name, compilerOptions)

let moduleCache = resolutionCache()

/* --------------------------- module resolution ----------------------------- */

/**
 * The `mod:` namespace: `ts.resolveModuleName`, cached through the engine as an
 * INPUT rather than recomputed on every walk.
 *
 * Before this, every `importsOf` call re-resolved every specifier from scratch,
 * and the durability tiers the engine offers (`workspace` / `external` /
 * `lib`) were never exercised for anything but file text — `durableSkips`
 * stayed at zero regardless of how much of the graph bottomed out in
 * node_modules or lib.d.ts. Modelling a resolution as an input keyed on
 * `(specifier, containing directory)` lets the same durability short-circuit
 * that skips re-validating `lib.d.ts` skip re-resolving `react` on every
 * keystroke in a file that never touches it.
 */
const Q_MOD = 'mod'

function moduleResolutionKey(specifier: string, containingDir: string): string {
  return queryKey(Q_MOD, `${specifier}::${containingDir}`)
}

interface ModuleResolutionValue {
  readonly resolvedFileName: string | null
  readonly isExternalLibraryImport: boolean
}

/**
 * How stable a resolution is expected to be.
 *
 * A specifier that resolves inside the workspace can move on every edit — a
 * sibling file can appear or disappear — so it stays at `workspace` tier. One
 * that resolves into node_modules only moves when dependencies are (re)installed,
 * which is common enough to still revalidate but rare enough to skip most of the
 * time: `external`. One that fails to resolve at all is treated as `lib`
 * durability — TypeScript's own libs are the common case that never resolves
 * differently — and is only reconsidered when `invalidateModuleResolutions`
 * runs, which is what a tsconfig or lockfile edit triggers.
 */
function moduleDurability(resolved: ts.ResolvedModuleFull | undefined): Durability {
  if (resolved === undefined) return 'lib'
  if (resolved.isExternalLibraryImport === true || resolved.resolvedFileName.includes('node_modules')) {
    return 'external'
  }
  return 'workspace'
}

/**
 * Resolves a specifier through the engine's cache, falling back to
 * `ts.resolveModuleName` only when nothing valid is on file.
 *
 * `engine.isValid` rather than a bare `engine.get`, because `get` on an input
 * namespace with no memo yet falls through to `compute` — and no compute
 * function is registered for `mod:`, since every value here is written, never
 * derived. Checking validity first is what keeps this a plain cache read on the
 * hot path.
 */
function resolveModuleCached(
  specifier: string,
  absolute: string
): ts.ResolvedModuleFull | undefined {
  const key = moduleResolutionKey(specifier, dirname(absolute))

  if (engine.isValid(key)) {
    const cached = engine.get<ModuleResolutionValue>(key)
    if (cached.resolvedFileName === null) return undefined
    return {
      resolvedFileName: cached.resolvedFileName,
      isExternalLibraryImport: cached.isExternalLibraryImport,
      extension: ts.Extension.Ts
    } as ts.ResolvedModuleFull
  }

  const resolved = ts.resolveModuleName(specifier, absolute, compilerOptions, ts.sys, moduleCache)
    .resolvedModule

  engine.setInput(
    key,
    {
      resolvedFileName: resolved?.resolvedFileName ?? null,
      isExternalLibraryImport: resolved?.isExternalLibraryImport === true
    } satisfies ModuleResolutionValue,
    moduleDurability(resolved)
  )

  return resolved
}

/**
 * Drops every cached resolution.
 *
 * Called when the tsconfig or a lockfile changes — either can change what a
 * specifier resolves to (a new `paths` mapping, a package that got installed or
 * removed) and a stale resolution is silently wrong: it keeps pointing an import
 * at a file that is no longer the right answer, or keeps reporting "cannot find
 * module" for one that now exists.
 */
function invalidateModuleResolutions(): void {
  for (const key of engine.keys()) {
    if (namespaceOf(key) === Q_MOD) engine.removeInput(key)
  }
}

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
    const resolved = resolveModuleCached(reference.fileName, absolute)

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

/**
 * How many files in the current graph have a diagnostics memo that is still
 * valid, i.e. have actually been checked and not since invalidated.
 *
 * NOT `affected.length` — that is the invalidation set for the pass that just
 * ran, which is a completely different number: it can be 1 while 4000 files
 * remain checked from earlier passes, or 4000 the moment a leaf-module edit
 * invalidates half the graph even though nothing has been rechecked yet. The
 * "N of M files checked" figure in the Problems panel is a cumulative claim —
 * how much of the workspace the daemon can currently vouch for — and only a
 * count of live `diag:` memos answers that.
 */
function checkedFileCount(): number {
  let count = 0
  for (const relativePath of graph.nodes.keys()) {
    if (engine.isValid(queryKey(Q_DIAG, relativePath))) count++
  }
  return count
}

function reportState(state: CompilerDaemonState, checked = checkedFileCount()): void {
  post({ type: 'state', state, graph: summary(), checkedFileCount: checked })
}

/**
 * The cache key for the workspace currently loaded, or null before the first
 * `indexWorkspace`. Computed once per boot/re-index and reused by the write
 * side in `checkFiles`, so a cold pass does not have to recompute compiler
 * identity for the write it may schedule.
 */
let memoCacheKey: string | null = null
/** True once this boot's cache has been written, so it is written at most once. */
let memoCacheWritten = false

/**
 * True when every file the cache recorded is still on disk, at the same
 * path, with the same mtime, and nothing new has appeared in the walk.
 *
 * The cache KEY (ts.version, compilerOptions, lib identity, tsconfig,
 * workspace root) proves the compiler is the one that produced these
 * diagnostics. It says nothing about whether the files it was run against are
 * still the files on disk — a workspace edited while the daemon was not
 * running would otherwise have its stale diagnostics served as current ones,
 * which is the exact failure this whole feature exists not to cause. mtime
 * is the same signal `dependency-graph`'s own `mtimeMs` already trusts for
 * display; here it gates whether the cache is trusted at all.
 */
function cacheMatchesDisk(root: string, files: readonly CachedFileRecord[], walked: readonly string[]): boolean {
  const walkedRelative = new Set(walked.map((absolute) => toRelative(root, absolute)))
  if (walkedRelative.size !== files.length) return false

  for (const record of files) {
    if (!walkedRelative.has(record.relativePath)) return false
    if (mtimeOf(toAbsolute(root, record.relativePath)) !== record.mtimeMs) return false
  }
  return true
}

function indexWorkspace(root: string): void {
  const started = Date.now()
  performance.mark('daemon-init-start')
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

  memoCacheWritten = false
  memoCacheKey = computeCacheKey({
    tsVersion: ts.version,
    compilerOptions,
    defaultLibPath: defaultLibPath(compilerOptions),
    tsconfigRelativePath,
    workspaceRoot: root
  })

  const walked = walk(root)
  const cached = readCache(root, memoCacheKey)

  if (cached !== null && cacheMatchesDisk(root, cached.files, walked)) {
    for (const record of cached.files) {
      upsertNode(graph, { relativePath: record.relativePath, imports: [...record.imports], mtimeMs: record.mtimeMs })
    }

    engine.hydrate(cached.snapshot)
    // The engine's memos are restored, but `engineTexts`/`textVersions` are
    // this worker's own bookkeeping on top of the engine and are not part of
    // its snapshot — rebuilt here from the rehydrated `text:` inputs so the
    // LanguageService host and the engine cannot disagree about a file's
    // content, same invariant `writeText` keeps on the live path.
    for (const key of engine.keys()) {
      if (namespaceOf(key) !== Q_TEXT) continue
      const relativePath = argumentOf(key)
      engineTexts.set(relativePath, engine.get<string>(key))
      textVersions.set(relativePath, (textVersions.get(relativePath) ?? 0) + 1)
    }

    cycles = assignComponents(graph)
    lastBuildMs = Date.now() - started
    service = null

    console.debug(
      `[compiler-worker] cache hit: ${graph.nodes.size} files, ${engine.stats().memoCount} memos restored`
    )

    performance.mark('daemon-init-end')
    performance.measure('daemon-init', 'daemon-init-start', 'daemon-init-end')
    busySince = null
    reportState('idle')
    return
  }

  for (const absolute of walked) {
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

  performance.mark('daemon-init-end')
  performance.measure('daemon-init', 'daemon-init-start', 'daemon-init-end')
  const [initMeasure] = performance.getEntriesByName('daemon-init')
  if (initMeasure !== undefined) {
    console.debug(`[compiler-worker] init: ${initMeasure.duration.toFixed(1)}ms (${graph.nodes.size} files)`)
  }

  busySince = null
  reportState('idle')
}

/**
 * Light instrumentation, boot → first diagnostics.
 *
 * Only ever measured once per worker lifetime — the number that matters is
 * time-to-first-signal after opening a workspace, not every subsequent pass,
 * which already has its own `totalMs` on the `pass` message.
 */
let firstDiagnosticsMarked = false

function markFirstDiagnostics(): void {
  if (firstDiagnosticsMarked) return
  firstDiagnosticsMarked = true

  performance.mark('first-diagnostics')
  if (performance.getEntriesByName('daemon-init-start').length === 0) return

  performance.measure('daemon-init-to-first-diagnostics', 'daemon-init-start', 'first-diagnostics')
  const [measure] = performance.getEntriesByName('daemon-init-to-first-diagnostics')
  if (measure !== undefined) {
    console.debug(`[compiler-worker] init -> first diagnostics: ${measure.duration.toFixed(1)}ms`)
  }
}

/**
 * True for a file whose change can move what a specifier resolves to.
 *
 * Matched on basename rather than a fixed relative path, because
 * `tsconfigRelativePath` can point at a tsconfig anywhere `ts.findConfigFile`
 * walked up to, and a monorepo can have more than one lockfile in play.
 */
function isModuleResolutionConfig(relativePath: string): boolean {
  const base = relativePath.split('/').pop() ?? relativePath
  return (
    base === 'tsconfig.json' ||
    base === 'package-lock.json' ||
    base === 'yarn.lock' ||
    base === 'pnpm-lock.yaml'
  )
}

/**
 * A tsconfig or lockfile moved: re-adopt the config, drop every cached
 * resolution, and recheck whatever the user is actually looking at so the
 * Problems panel does not sit on diagnostics computed against a program that no
 * longer exists.
 *
 * Reported as `'index'`, not `'watch'` — this pass exists because the
 * WORKSPACE's shape changed, not because of an edit to any one file, and the
 * latency panel already has a distinct bucket for it (see `pass-analysis.ts`).
 */
function reindexForConfigChange(root: string): void {
  loadConfig(root)
  moduleCache = resolutionCache()
  invalidateModuleResolutions()
  // The program's shape may have moved (compilerOptions changed), so nothing
  // cached against the old one can be trusted — same reasoning as the `service`
  // reset after a full `indexWorkspace`.
  engine.invalidateDerived()
  service = null

  // The compiler options are part of the cache key, so a config change makes
  // whatever key this boot was using stale. Recompute it and allow one fresh
  // write under the new identity — writing under the OLD key here would cache
  // post-config-change diagnostics under a key that no longer describes this
  // workspace's compiler identity, and the next boot with the OLD config
  // would then hydrate diagnostics computed under the NEW one.
  memoCacheWritten = false
  memoCacheKey = computeCacheKey({
    tsVersion: ts.version,
    compilerOptions,
    defaultLibPath: defaultLibPath(compilerOptions),
    tsconfigRelativePath,
    workspaceRoot: root
  })

  const openFiles = [...overlays.keys()].filter((file) => graph.nodes.has(file))
  if (openFiles.length > 0) {
    busySince = Date.now()
    reportState('checking')
    checkFiles(root, openFiles, 'index', [])
    if (resumeScheduled) return
  }

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

  if ([...changed, ...removed].some(isModuleResolutionConfig)) {
    reindexForConfigChange(root)
    return
  }

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

  // A cancelled check owes a resume, and `oweCheck` reports idle when that
  // lands. Saying idle here as well would have the panel flick to idle in the
  // gap between getting out of the way and coming back — the one window in
  // which the daemon most obviously IS still working.
  if (resumeScheduled) return

  busySince = null
  reportState('idle')
}

/* ---------------------------- language service ---------------------------- */

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
  // One host, built by `ts-workspace.ts`, so this worker and the interactive
  // one cannot disagree about what a file says or when it changed. What stays
  // here is the part that is genuinely this worker's: the engine holds the
  // authoritative copy of every file's text, and reading disk instead would let
  // the service and the memos disagree about the same file within one pass.
  const host = createLanguageServiceHost({
    root,
    scriptFileNames: () => scriptFileNames(root),
    compilerOptions: () => compilerOptions,
    textOf: (fileName) => {
      const relativePath = toRelative(root, fileName)

      // Overlay first: the daemon must check the buffer the user is looking at,
      // not the last thing written to disk.
      const overlay = overlays.get(relativePath)
      if (overlay !== undefined) return overlay.content

      // Then the engine's own copy, which is what every query was computed
      // against. Reading disk here instead would let the service and the engine
      // disagree about the same file within one pass.
      const held = engineTexts.get(relativePath)
      if (held !== undefined) return held

      // The path TypeScript ASKED about, not one rebuilt from the root. Most of
      // what it asks for is inside the workspace, but `lib.es2022.d.ts` is not.
      return readIfPossible(fileName)
    },
    versionOf: (fileName) => {
      const relativePath = toRelative(root, fileName)
      const overlay = overlays.get(relativePath)
      if (overlay !== undefined) return `o${overlay.version}`
      // A counter the daemon controls, NOT mtime. See `textVersions` for why
      // the filesystem clock is not usable as a change signal here.
      return `d${textVersions.get(relativePath) ?? documentVersions.get(relativePath) ?? 0}`
    },
    isCancellationRequested
  })

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
    } catch (error) {
      // The carve-out that has to exist in the same commit as cancellation.
      //
      // A bare `catch { return [] }` was correct while nothing could interrupt
      // this: a file the program cannot load yields nothing rather than
      // abandoning the pass. The moment a check can be cancelled,
      // `OperationCanceledException` lands here too — and returning [] would
      // MEMOISE an empty result, publish it, and have the clean sweep read it
      // as "this file is now clean". Every squiggle in the file disappears, and
      // stays gone until its text changes.
      //
      // Rethrowing leaves the engine untouched: `compute` creates or updates no
      // memo when the function throws, so the file is simply not answered and
      // the resumed pass asks again.
      if (isCancellation(error)) throw error
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

  // Open files first, then the rest — `planPass` also decides, above
  // `SMALL_PASS_FILES`, how much of that ordering this pass is guaranteed to
  // check. Below the threshold `guaranteed` is the whole list and nothing
  // changes from the old behaviour.
  const plan = planPass(files, (file) => overlays.has(file))
  const ordered =
    plan.ordered.length > SMALL_PASS_FILES ? plan.ordered.slice(0, plan.guaranteed) : plan.ordered
  const deferredNow =
    plan.ordered.length > SMALL_PASS_FILES ? plan.ordered.slice(plan.guaranteed) : []

  const produced: FileDiagnostics[] = []
  const nowDirty = new Set<string>()

  passEvents = []
  passRecomputed = 0
  passReused = 0
  diagKept = 0
  otherKept = 0
  const startedAt = Date.now()
  const before = engine.stats()

  /** Files this pass never got to, because it was cancelled part-way. */
  let unfinished: string[] = []

  // Files skipped because their own `diag:` query cycled back on itself. Not
  // "unfinished" in the cancellation sense — nothing owes them a resume, since
  // asking again would cycle again — but they did NOT get an answer this pass
  // either, and `settled` must say so rather than claim the pass is complete.
  const cycled: string[] = []

  for (let index = 0; index < ordered.length; index++) {
    const relativePath = ordered[index] as string
    const absolute = toAbsolute(root, relativePath)

    let diagnostics: DiagnosticMessage[]
    try {
      diagnostics = engine.get<DiagnosticMessage[]>(queryKey(Q_DIAG, relativePath))
    } catch (error) {
      // Someone is waiting for an interactive answer. Everything already
      // computed is real and goes out; the rest is owed and comes back.
      if (isCancellation(error)) {
        unfinished = ordered.slice(index)
        break
      }
      // A query cycle is a bug in the dependency wiring rather than in the
      // user's code, and it must not cost them the rest of the pass — but it
      // is also not answered, so it is tracked rather than merely skipped.
      if (!(error instanceof QueryCycleError)) throw error
      cycled.push(relativePath)
      noteAbandoned(ledger, relativePath)
      continue
    }

    const version = (emittedVersions.get(relativePath) ?? 0) + 1
    emittedVersions.set(relativePath, version)

    produced.push({ relativePath, path: absolute, diagnostics, version })
    if (diagnostics.length > 0) nowDirty.add(relativePath)
    noteChecked(ledger, relativePath, diagnostics.length > 0)
  }

  // Everything this pass chose not to check at all (the large-pass tail) is
  // owed a check later — unioned into the ledger, never dropped, and drained
  // in the background as `'idle'` passes below.
  if (deferredNow.length > 0) noteDeferred(ledger, deferredNow)

  const cancelled = unfinished.length > 0
  // Every file this pass owed an answer to and did not get one, cancellation
  // and proactive deferral both included — the set `settled` is computed from.
  const unanswered = cancelled || cycled.length > 0 || deferredNow.length > 0

  // NOTE: the pass is reported at the END of this function, after the
  // diagnostics have gone out. Announcing "the pass is done" before its results
  // are on the wire is a lie a consumer can act on — and did: the first version
  // of run-cutoff-proof.mjs read the pass, looked for the diagnostics that had
  // not been sent yet, and reported a correctness failure that was purely
  // ordering. Diagnostics are the payload; the pass is the receipt.

  // Clean sweep: anything that had diagnostics last pass but was not re-checked
  // this pass gets an explicit empty set, or its squiggles never clear.
  //
  // SKIPPED on a cancelled pass, and that is the whole hazard. `nowDirty` is a
  // partial answer when the pass stopped part-way, so sweeping against it would
  // publish empty sets for files nobody looked at — the same erasure the
  // `Q_DIAG` carve-out prevents one level down. `previouslyDirty` is left alone
  // for the same reason: it is the record of what is owed a sweep, and
  // overwriting it with a partial set forgets the rest.
  if (!unanswered) {
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
  }

  // `settled` stops being a literal here. It was `true` on every batch ever
  // sent, which `compiler-service.ts` accumulates correctly and was therefore
  // fed a constant — a lie the moment anything is left undone. A cancelled pass
  // is that moment.
  if (produced.length > 0) {
    post({ type: 'diagnostics', files: produced, settled: !unanswered })
    markFirstDiagnostics()
  }

  // `requested` stays the size of what this pass was ASKED for, cancelled or
  // not. Reporting only what it managed would make a cancellation look like a
  // small pass rather than an interrupted one.
  // `cold` still wins over an ordinary `watch`/`buffer` pass — the point of the
  // tag is to keep language-service warm-up cost out of ordinary latency
  // figures. It does NOT win over `'index'`: that reason already means "the
  // workspace's shape changed", which is a more specific and more useful fact
  // than "the service happened to be cold at the time", and a config-triggered
  // reindex nulls `service` itself, so it would otherwise always lose its own
  // reason to this fallback.
  // `files.length`, not `ordered.length`: the latter is only the guaranteed
  // head a large pass actually answered this time. `requested` reports what
  // this pass was ASKED for, deferral included — the same reasoning as the
  // cancellation case just below it.
  reportPass(cold && reason !== 'index' ? 'cold' : reason, files.length, startedAt, before, trigger)

  if (cancelled) oweCheck(root, unfinished, reason)
  if (deferredNow.length > 0) scheduleDrain(root)

  // Write the memo cache once per boot, and only once this pass is fully
  // settled — cancelled, cycled or deferred all disqualify it. Writing a
  // partial pass would cache a state this very worker considers unfinished,
  // and the next boot would hydrate believing it complete.
  if (!memoCacheWritten && memoCacheKey !== null && !unanswered && !cancelled) {
    memoCacheWritten = true
    scheduleCacheWrite(root, memoCacheKey)
  }
}

/**
 * Persists the engine's memo state to `.bettercallcompiler/cache/`.
 *
 * Deferred one tick with `setImmediate` for the same reason the drain is:
 * this runs right after a pass has posted its diagnostics, and serializing
 * every memo plus writing a JSON file to disk should not be what stands
 * between that pass and the caller seeing it.
 */
function scheduleCacheWrite(root: string, key: string): void {
  setImmediate(() => {
    const files: CachedFileRecord[] = []
    for (const [relativePath, node] of graph.nodes) {
      files.push({ relativePath, imports: [...node.imports], mtimeMs: node.mtimeMs })
    }
    writeCache(root, key, { createdAt: Date.now(), files, snapshot: engine.serialize() })
  })
}

/**
 * Ledger-backed deferral for large passes.
 *
 * `checkFiles` guarantees a head of a large pass and unions the rest into
 * `ledger.pending`. This drains that tail in the background, one bounded
 * slice at a time, tagged `reason: 'idle'` so it never masquerades as
 * interactive latency.
 *
 * `setImmediate` between slices for the same reason `oweCheck` uses it: it
 * yields to the poll phase first, so a ping or an interactive query queued
 * while a drain slice was running gets answered before the next slice starts,
 * rather than a naive loop over thousands of files blocking the thread
 * outright.
 */
const ledger: CheckLedger = createLedger()
let drainScheduled = false

function scheduleDrain(root: string): void {
  if (drainScheduled) return
  if (ledger.pending.size === 0) return
  drainScheduled = true

  setImmediate(() => {
    drainScheduled = false
    if (workspaceRoot === null) return

    // Files the ledger is still tracking that left the graph since they were
    // deferred. Reported empty so their squiggles clear rather than being
    // drained forever against a file that is gone — the one case
    // `noteChecked`'s invariant permits an empty result without a query.
    const gone = departed(ledger, (relativePath) => graph.nodes.has(relativePath))
    if (gone.length > 0) {
      const files: FileDiagnostics[] = gone.map((relativePath) => {
        const version = (emittedVersions.get(relativePath) ?? 0) + 1
        emittedVersions.set(relativePath, version)
        return { relativePath, path: toAbsolute(root, relativePath), diagnostics: [], version }
      })
      post({ type: 'diagnostics', files, settled: ledger.pending.size === 0 })
    }

    const slice = nextDrain(ledger, SMALL_PASS_FILES)
    if (slice.length === 0) {
      if (ledger.pending.size > 0) scheduleDrain(root)
      return
    }

    checkFiles(root, slice, 'idle', [])
    // A slice never exceeds SMALL_PASS_FILES, so it cannot itself re-defer —
    // but more may have piled into `pending` since (a fresh edit named more
    // files than the drain covered), so keep going until it is empty.
    if (ledger.pending.size > 0) scheduleDrain(root)
  })
}

/**
 * Files a cancelled pass still owes, and the resume that pays them.
 *
 * `setImmediate`, not `setTimeout(0)`: immediates run in the check phase, after
 * the poll phase where port messages are delivered, so the query that caused
 * the cancellation is guaranteed to be answered before the check restarts.
 * Reversing that order would have the resumed check cancelled by the same flag
 * and spin.
 *
 * The resumed pass keeps the reason it was interrupted from, because that is
 * what it is: a `watch` pass that got out of the way and came back. Workstream
 * B's `'idle'` reason is the right home for drained work once the enum grows
 * one — inventing it here would mean a schema change and three read-side
 * filters for a nuance nobody is showing yet.
 */
const owedFiles = new Set<string>()
let owedReason: CompilerPass['reason'] = 'watch'
let resumeScheduled = false

function oweCheck(
  root: string,
  files: readonly string[],
  reason: CompilerPass['reason']
): void {
  for (const relativePath of files) owedFiles.add(relativePath)
  owedReason = reason
  if (resumeScheduled) return
  resumeScheduled = true

  setImmediate(() => {
    resumeScheduled = false
    const files = [...owedFiles].filter((file) => graph.nodes.has(file))
    const reason = owedReason
    owedFiles.clear()
    if (files.length > 0) checkFiles(root, files, reason, [])
    // Only once the resume is done, so the panel does not flick to idle in the
    // gap between the cancellation and the work coming back.
    busySince = null
    reportState('idle')
  })
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

/* --------------------------- navigation queries --------------------------- */

/**
 * The two questions the daemon can answer better than anything in the renderer,
 * asked of the `ts.LanguageService` that was already built, already supervised
 * and already being asked exactly two others.
 *
 * `getSemanticDiagnostics` and `getSyntacticDiagnostics` were the whole of it.
 * Everything here is one method call on an object that has existed since the
 * first check pass.
 *
 * ## Why this is more correct than Monaco's
 *
 * Monaco's bundled worker has no tsconfig, no file system and no module
 * resolution, so it cannot follow `./lib` at all — its go-to-definition is
 * confined to the file you are looking at, and `configureLanguageDefaults`
 * turns its semantic validation off for exactly that reason. This service has
 * the real program. The cross-file answer is the whole justification for the
 * round trip.
 */

/**
 * Line tables for the files one answer touches, computed at most once each.
 *
 * A reference search over a large workspace returns hits in hundreds of files
 * and several hits per file. Without this, converting them would rescan the
 * text of every file once per hit — quadratic in the thing that is already the
 * biggest answer we ever send.
 */
function makeLineStartsCache(root: string): (relativePath: string) => readonly number[] {
  const cache = new Map<string, number[]>()

  return (relativePath: string): readonly number[] => {
    const held = cache.get(relativePath)
    if (held !== undefined) return held

    // The same precedence the LanguageService host uses, so the offsets it
    // reported and the text they are converted against cannot disagree: the
    // buffer, then the engine's copy, then disk.
    const text =
      overlays.get(relativePath)?.content ??
      engineTexts.get(relativePath) ??
      readIfPossible(toAbsolute(root, relativePath)) ??
      ''

    const starts = lineStartsOf(text)
    cache.set(relativePath, starts)
    return starts
  }
}

/**
 * True for a path inside the workspace.
 *
 * `relative()` returning something that starts with `..` is the check, and an
 * absolute result covers the Windows case where the two paths are on different
 * drives and there is no relative path between them at all.
 */
function isInsideWorkspace(relativePath: string): boolean {
  return (
    relativePath !== '' &&
    !relativePath.startsWith('../') &&
    !isAbsolute(relativePath)
  )
}

/**
 * Converts a TypeScript span list into wire locations, dropping what the
 * renderer could not open.
 *
 * A definition legitimately lands in `lib.dom.d.ts` or inside `node_modules`,
 * and those are dropped rather than sent. The renderer keys models on a
 * workspace-relative path and `fs:readFile` is confined to the workspace root,
 * so a location outside it is one nothing downstream can act on — and a
 * location that cannot be opened is worse than no location, because Monaco
 * turns a single result into a jump and two into a peek.
 */
function toLocations(
  root: string,
  spans: readonly { readonly fileName: string; readonly textSpan: ts.TextSpan }[]
): LanguageLocation[] {
  const lineStartsFor = makeLineStartsCache(root)
  const locations: LanguageLocation[] = []

  for (const span of spans) {
    if (locations.length >= MAX_REFERENCE_RESULTS) break

    const relativePath = toRelative(root, span.fileName)
    if (!isInsideWorkspace(relativePath)) continue

    locations.push({
      relativePath,
      path: toAbsolute(root, relativePath),
      range: rangeFromSpan(
        lineStartsFor(relativePath),
        span.textSpan.start,
        span.textSpan.length
      )
    })
  }

  return locations
}

/**
 * Adopts the caller's buffer WITHOUT scheduling a check.
 *
 * `openDocument` conflates two things — "this is what the file says now" and
 * "please re-check it" — which is why the renderer debounces it 300ms, and
 * therefore why the daemon can be a third of a second behind the buffer. An
 * interactive query needs the first and must not pay for the second: a
 * definition answered at a stale offset points at the wrong token.
 *
 * `bumpVersion` is what makes the LanguageService notice. Its host reads
 * `getScriptVersion` before deciding whether to re-parse, so setting the
 * overlay without bumping would leave the service serving the previous
 * snapshot and the fix would be invisible.
 */
function syncOverlay(root: string, relativePath: string, overlay: DocumentOverlay): void {
  const existing = overlays.get(relativePath)
  // Same monotonic-version rule as `openDocument`: an overlay that arrives out
  // of order is stale and must not overwrite a newer buffer.
  if (existing !== undefined && existing.version > overlay.version) return

  overlays.set(relativePath, { content: overlay.content, version: overlay.version })
  bumpVersion(relativePath)
  setTextInput(root, relativePath)
}

function answerLanguageQuery(
  root: string,
  request: LanguageQueryRequest
): LanguageQueryAnswer {
  const { kind, relativePath, offset } = request
  const absolute = toAbsolute(root, relativePath)
  const languageService = ensureService(root)

  switch (kind) {
    case 'definition': {
      // `getDefinitionAtPosition`, not `getDefinitionAndBoundSpan`: the bound
      // span describes the word under the cursor, which the renderer already
      // has, and asking for it costs a second walk for information nobody uses.
      const found = languageService.getDefinitionAtPosition(absolute, offset) ?? []
      return { kind, locations: toLocations(root, found) }
    }

    case 'references': {
      const found = languageService.getReferencesAtPosition(absolute, offset) ?? []
      const locations = toLocations(root, found)
      return { kind, locations, truncated: locations.length >= MAX_REFERENCE_RESULTS }
    }

    case 'rename':
      return answerRename(root, languageService, request)

    case 'codeActions':
      return answerCodeActions(root, languageService, request)
  }
}

/* --------------------------------- rename --------------------------------- */

/**
 * Both halves of a rename, from `getRenameInfo` and `findRenameLocations`.
 *
 * `newName === null` is Monaco asking where to draw the inline box when F2 is
 * pressed, before a new name exists. A name asks for the edits.
 */
function answerRename(
  root: string,
  languageService: ts.LanguageService,
  request: LanguageQueryRequest
): Extract<LanguageQueryAnswer, { kind: 'rename' }> {
  const kind = 'rename' as const
  const absolute = toAbsolute(root, request.relativePath)

  const info = languageService.getRenameInfo(absolute, request.offset, {
    // Off, both of them. A rename that also rewrites the word inside a string
    // or a comment is a find-and-replace wearing a rename's clothes, and it is
    // the behaviour people turn off first in every editor that defaults it on.
    providePrefixAndSuffixTextForRename: true
  })

  if (!info.canRename) {
    return {
      kind,
      target: null,
      placeholder: null,
      files: [],
      // TypeScript's own wording, which is more specific than anything this
      // could invent — "You cannot rename elements that are defined in a
      // library" rather than "there is nothing to rename here".
      error: info.localizedErrorMessage
    }
  }

  const lineStartsFor = makeLineStartsCache(root)
  const target = rangeFromSpan(
    lineStartsFor(request.relativePath),
    info.triggerSpan.start,
    info.triggerSpan.length
  )

  if (request.newName === null) {
    return { kind, target, placeholder: info.displayName, files: [], error: null }
  }

  const found =
    languageService.findRenameLocations(absolute, request.offset, false, false, {
      providePrefixAndSuffixTextForRename: true
    }) ?? []

  const byFile = new Map<string, TextEdit[]>()

  for (const location of found) {
    const relativePath = toRelative(root, location.fileName)
    if (!isInsideWorkspace(relativePath)) {
      // REFUSED, not dropped. Dropping a location silently produces a
      // half-renamed program, which is the worst outcome available: the code
      // still compiles nowhere and nothing said so. A rename reaching outside
      // the workspace means renaming a library symbol, which should be refused
      // anyway.
      return {
        kind,
        target,
        placeholder: info.displayName,
        files: [],
        error: `renaming this would also change ${relativePath}, which is outside the workspace`
      }
    }

    const edits = byFile.get(relativePath) ?? []
    edits.push({
      range: rangeFromSpan(
        lineStartsFor(relativePath),
        location.textSpan.start,
        location.textSpan.length
      ),
      // `prefixText` and `suffixText` are how TypeScript expands an object
      // shorthand: renaming `x` in `{ x }` has to produce `{ x: renamed }`, not
      // `{ renamed }`, or the object's key changes with it. Ignoring them
      // silently rewrites an API.
      newText: `${location.prefixText ?? ''}${request.newName}${location.suffixText ?? ''}`
    })
    byFile.set(relativePath, edits)
  }

  const files = [...byFile.entries()].map(([relativePath, edits]) => ({
    relativePath,
    path: toAbsolute(root, relativePath),
    edits: sortDescending(edits)
  }))

  return { kind, target, placeholder: info.displayName, files, error: null }
}

/**
 * Descending by position, so applying in order cannot move a range not yet
 * applied. Produced sorted rather than sorted at the point of use, because
 * every consumer would otherwise have to remember.
 */
function sortDescending(edits: readonly TextEdit[]): TextEdit[] {
  return [...edits].sort((a, b) =>
    a.range.startLine === b.range.startLine
      ? b.range.startColumn - a.range.startColumn
      : b.range.startLine - a.range.startLine
  )
}

/* ------------------------------ code actions ------------------------------ */

/**
 * Quick fixes for the diagnostics under the selection.
 *
 * The codes come from the renderer rather than being re-derived here, because
 * that is where the markers are and `getCodeFixesAtPosition` needs them: a fix
 * is a fix FOR something, and asking with an empty code list returns nothing
 * rather than everything.
 */
function answerCodeActions(
  root: string,
  languageService: ts.LanguageService,
  request: LanguageQueryRequest
): Extract<LanguageQueryAnswer, { kind: 'codeActions' }> {
  const kind = 'codeActions' as const
  if (request.diagnosticCodes.length === 0) return { kind, actions: [] }

  const absolute = toAbsolute(root, request.relativePath)
  const fixes = languageService.getCodeFixesAtPosition(
    absolute,
    request.offset,
    request.endOffset,
    [...request.diagnosticCodes],
    FORMAT_OPTIONS,
    {}
  )

  const lineStartsFor = makeLineStartsCache(root)
  const actions: CodeAction[] = []

  for (const fix of fixes) {
    if (actions.length >= MAX_CODE_ACTIONS) break

    const files: FileEdit[] = []
    let reachesOutside = false

    for (const change of fix.changes) {
      const relativePath = toRelative(root, change.fileName)
      if (!isInsideWorkspace(relativePath)) {
        reachesOutside = true
        break
      }
      // A fix that creates a file is a shape this cannot carry, and applying
      // half of it would be worse than offering nothing.
      if (change.isNewFile === true) {
        reachesOutside = true
        break
      }

      files.push({
        relativePath,
        path: toAbsolute(root, relativePath),
        edits: sortDescending(
          change.textChanges.map((textChange) => ({
            range: rangeFromSpan(
              lineStartsFor(relativePath),
              textChange.span.start,
              textChange.span.length
            ),
            newText: textChange.newText
          }))
        )
      })
    }

    if (reachesOutside || files.length === 0) continue

    actions.push({
      title: fix.description,
      kind: 'quickfix',
      // TypeScript marks the fix it would apply first; Monaco renders that one
      // as the default when the lightbulb is triggered with Ctrl+. and Enter.
      preferred: fix.fixAllDescription === undefined ? false : true,
      edits: files
    })
  }

  return { kind, actions }
}

/**
 * Formatting the fixes are rendered with.
 *
 * `getCodeFixesAtPosition` inserts real text — an import statement, a property
 * declaration — and formats it against these. They match the editor's own
 * options in `createEditor`, so a fix does not arrive indented differently from
 * the code around it.
 */
const FORMAT_OPTIONS: ts.FormatCodeSettings = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: '\n',
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true
}

/**
 * Answers one query, and always answers.
 *
 * A throw here would otherwise reach the outer handler, be posted as a
 * `failure` — which trips the supervisor's restart budget — and leave the
 * caller's resolver pending until its timeout. `getReferencesAtPosition` on a
 * program mid-edit is exactly the kind of call that can throw, so a bug in one
 * navigation query must cost an empty answer rather than a restart.
 */
function respondToLanguageQuery(request: LanguageQueryRequest): void {
  // Before anything touches the LanguageService. The token this flag drives is
  // polled by EVERY call on it, not only by the checker, so answering with it
  // still raised would have the query cancel itself.
  clearCancellation()

  const root = workspaceRoot
  let result: LanguageQueryAnswer

  try {
    if (root === null) {
      result = emptyLanguageQueryAnswer(request.kind)
    } else {
      if (request.overlay !== null) syncOverlay(root, request.relativePath, request.overlay)
      result = answerLanguageQuery(root, request)
    }
  } catch {
    result = emptyLanguageQueryAnswer(request.kind)
  }

  post({ type: 'languageQueryResult', requestId: request.requestId, result })
}

/* -------------------------------- dispatch -------------------------------- */

function handle(request: WorkerRequest): void {
  switch (request.type) {
    case 'ping':
      post({ type: 'pong', nonce: request.nonce, heapUsedMb: heapUsedMb(), busySince })
      return

    case 'boot':
      workspaceRoot = request.workspaceRoot
      cancellationFlag =
        request.cancellation === undefined ? null : new Int32Array(request.cancellation)
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

    // The buffer rides on the request, and `respondToLanguageQuery` adopts it
    // without checking — see `syncOverlay`.
    case 'languageQuery':
      respondToLanguageQuery(request)
      return

    case 'dependents': {
      const root = workspaceRoot
      if (root === null) {
        post({
          type: 'dependentsResult',
          requestId: request.requestId,
          query: { node: null, dependents: [], chain: [], cycle: null }
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
          // Pure graph arithmetic — no engine.get anywhere on this path, so
          // answering "why" cannot cause a check.
          chain: importPathTo(graph, request.from, request.relativePath),
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
