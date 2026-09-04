import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

/**
 * Everything two TypeScript workers have to agree about.
 *
 * There are two of them from A5 onwards: the check worker, whose
 * `getSemanticDiagnostics` is slow and interruptible, and the interactive
 * worker, which answers hover, completions and signature help and must never be
 * interrupted — cancelling the check on every keystroke would mean diagnostics
 * never converge while typing, so they cannot share one.
 *
 * What they must not disagree about is what the workspace IS. Two walks with
 * different ignore lists, two tsconfig lookups with different fallbacks, or two
 * `LanguageServiceHost`s with different overlay precedence would produce two
 * pictures of the same program — and the failure would show up as hover
 * describing a type the checker does not believe in, which reads as the IDE
 * being confused rather than as a duplicated constant.
 *
 * So the rules live here once and the state stays in each worker. This module
 * holds no mutable module-level state at all; every function takes what it
 * needs. That is what makes it safe for two threads to import.
 */

/** What counts as source. Shared so both walks find the same files. */
export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/** Mirrors fs-service's UNWATCHED so every side agrees what "the workspace" is. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.bettercallcompiler',
  'dist',
  'out',
  '.next'
])

/** Same ceiling as fs-service's listFiles, for the same reason. */
export const MAX_WALKED_FILES = 20_000

export function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  return rel === '' ? '' : rel.split(sep).join('/')
}

export function toAbsolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

export interface WalkResult {
  readonly files: string[]
  /** True when the ceiling was hit — a sampled workspace must say so. */
  readonly truncated: boolean
}

export function walkSources(root: string): WalkResult {
  const files: string[] = []
  const queue: string[] = [root]
  let truncated = false

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

      if (files.length >= MAX_WALKED_FILES) {
        truncated = true
        break
      }
      files.push(absolute)
    }
  }

  return { files, truncated }
}

export interface WorkspaceConfig {
  readonly options: ts.CompilerOptions
  /** The tsconfig actually adopted, or null when the fallback is in use. */
  readonly tsconfigRelativePath: string | null
}

/**
 * Adopts the workspace tsconfig, or falls back to permissive defaults.
 *
 * `checkJs: false` in the fallback is deliberate: without a tsconfig, a plain
 * JavaScript project would otherwise sprout a wall of type errors nobody asked
 * for on first open.
 */
export function loadWorkspaceConfig(root: string): WorkspaceConfig {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')

  if (configPath === undefined) {
    return {
      tsconfigRelativePath: null,
      options: {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        noEmit: true,
        skipLibCheck: true
      }
    }
  }

  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, root)

  return {
    tsconfigRelativePath: toRelative(root, configPath),
    options: { ...parsed.options, noEmit: true, skipLibCheck: true }
  }
}

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
 * free of any electron import — these are plain Node threads and must stay so.
 */
export function defaultLibPath(options: ts.CompilerOptions): string {
  const packaged = join(
    process.resourcesPath ?? '',
    'typescript-lib',
    ts.getDefaultLibFileName(options)
  )
  try {
    if (process.resourcesPath !== undefined && statSync(packaged).isFile()) return packaged
  } catch {
    // Not a packaged build, or the resource is missing; fall through.
  }
  return ts.getDefaultLibFilePath(options)
}

/**
 * What a worker has to supply for a host to be built over its own state.
 *
 * Deliberately small, and deliberately all functions: the check worker answers
 * `textOf` from a query engine that owns the authoritative copy, while the
 * interactive worker answers it from a plain map. Passing the STATE instead
 * would mean this module owning both, which is the coupling the two threads
 * exist to avoid.
 */
export interface LanguageHostState {
  readonly root: string
  /** Absolute paths, the whole program. */
  scriptFileNames(): string[]
  compilerOptions(): ts.CompilerOptions
  /**
   * The current text of a file, or null when there is none.
   *
   * Takes the ABSOLUTE path TypeScript asked about, not a workspace-relative
   * one, and that is load-bearing rather than a style choice. Most of what the
   * service asks for is inside the workspace, but `lib.es2022.d.ts` is not —
   * it lives beside the typescript package, or under `process.resourcesPath` in
   * a packaged build. Handing the caller a relative path would mean it had to
   * rebuild the absolute one to read the file, and `join(root, relative(root,
   * x))` is only the identity while both are on the same volume: on Windows
   * with the workspace on D: and the app on C:, `relative` returns `D:\ts\…`
   * and joining it onto the root produces `C:\app\D:\ts\…`. Every lib file
   * fails to load and the whole program is untyped.
   *
   * The overlay-beats-disk rule stays in the caller, because what an overlay IS
   * differs: the check worker holds the engine's copy so the service and the
   * memos can never disagree within a pass, and the interactive worker holds
   * only the buffer.
   */
  textOf(fileName: string): string | null
  /**
   * A version string that changes whenever the text does. Absolute path, for
   * the same reason as `textOf`.
   *
   * NOT mtime. The filesystem clock is coarse on some volumes and a save inside
   * one tick would produce the same version for different content, leaving the
   * service serving a stale snapshot.
   */
  versionOf(fileName: string): string
  /** Polled by the checker at its own checkpoints; omit for an uncancellable host. */
  isCancellationRequested?(): boolean
}

/**
 * One `LanguageServiceHost`, built over whichever worker's state.
 *
 * The rules that must not diverge are all here: which text wins, what a version
 * string looks like, where the lib files are, and which file system calls are
 * delegated to `ts.sys`. A second hand-written host was the alternative, and a
 * second host is two chances to answer "what does this file say" differently.
 */
export function createLanguageServiceHost(state: LanguageHostState): ts.LanguageServiceHost {
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => state.scriptFileNames(),
    getScriptVersion: (fileName) => state.versionOf(fileName),
    getScriptSnapshot: (fileName) => {
      const text = state.textOf(fileName)
      return text === null ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => state.root,
    getCompilationSettings: () => state.compilerOptions(),
    getDefaultLibFileName: (options) => defaultLibPath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  }

  const cancellation = state.isCancellationRequested
  if (cancellation !== undefined) {
    // Polled by the checker at its own checkpoints, so the latency of stopping
    // is bounded by one checkpoint rather than by the whole file.
    host.getCancellationToken = () => ({ isCancellationRequested: cancellation })
  }

  return host
}
