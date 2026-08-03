import { BrowserWindow, dialog } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promises as fsp } from 'node:fs'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import type {
  FileNode,
  FsWatchEvent,
  FsWatchEventType,
  LanguageBreakdown,
  LanguageStat,
  SearchMatch,
  Workspace
} from '../shared/types'

/** Directories never walked by the watcher — cheap to skip, ruinous to watch. */
const UNWATCHED = new Set(['node_modules', '.git', '.bettercallcompiler', 'dist', 'out', '.next'])

/** Hidden from the explorer. `.git` is machinery, not content. */
const HIDDEN = new Set(['.git'])

let workspaceRoot: string | null = null
let watcher: FSWatcher | null = null
let emitWatchEvent: ((event: FsWatchEvent) => void) | null = null

/* ------------------------------------------------------------------ *
 * Path confinement — the security boundary
 * ------------------------------------------------------------------ */

/** Windows compares paths case-insensitively; Linux does not. */
function normalizeForCompare(target: string): string {
  const absolute = resolve(target)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * True when `target` is the root itself or lives underneath it.
 *
 * Deliberately uses `relative()` and inspects the first segment rather than a
 * `startsWith` prefix test: `startsWith` would happily accept
 * `/workspace-evil` for root `/workspace`.
 */
export function isWithin(root: string, target: string): boolean {
  const normalizedRoot = normalizeForCompare(root)
  const normalizedTarget = normalizeForCompare(target)
  if (normalizedRoot === normalizedTarget) return true

  const rel = relative(normalizedRoot, normalizedTarget)
  if (rel === '' || isAbsolute(rel)) return false

  const firstSegment = rel.split(sep)[0]
  return firstSegment !== undefined && firstSegment !== '..'
}

/**
 * `fs.realpath` fails on a path that does not exist yet, but create/rename need
 * to validate destinations *before* creating them. Resolve the deepest existing
 * ancestor — which is where any symlink or junction would be — then re-attach
 * the not-yet-existing tail.
 */
async function realpathAllowingMissing(target: string): Promise<string> {
  const missing: string[] = []
  let current = resolve(target)

  for (;;) {
    try {
      const real = await fsp.realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        throw new BetterCallCompilerServiceError('NOT_FOUND', `cannot resolve path: ${target}`)
      }
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolves an incoming path and refuses anything outside the workspace.
 *
 * Both halves matter. `resolve` collapses `..` traversal; `realpath` defeats
 * symlinks and Windows junctions that point outside the root while *looking*
 * like they are inside it. Checking only the lexical path would let
 * `workspace/link -> C:\Windows` through.
 *
 * Exported so the confinement tests can drive it directly against fixtures.
 */
export async function confinePath(root: string, candidate: string): Promise<string> {
  if (root === '') {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'no folder is open')
  }

  const realRoot = await fsp.realpath(resolve(root))
  const absolute = isAbsolute(candidate) ? candidate : resolve(realRoot, candidate)
  const resolved = await realpathAllowingMissing(absolute)

  if (!isWithin(realRoot, resolved)) {
    throw new BetterCallCompilerServiceError(
      'PATH_ESCAPES_WORKSPACE',
      `path resolves outside the workspace: ${candidate}`
    )
  }

  return resolved
}

function requireRoot(): string {
  if (workspaceRoot === null) {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'no folder is open')
  }
  return workspaceRoot
}

/** POSIX-separated path relative to the root; '' for the root itself. */
function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  return rel === '' ? '' : rel.split(sep).join('/')
}

function toNode(root: string, absolute: string, kind: FileNode['kind']): FileNode {
  return {
    name: basename(absolute),
    path: absolute,
    relativePath: toRelative(root, absolute),
    kind
  }
}

/* ------------------------------------------------------------------ *
 * Workspace lifecycle
 * ------------------------------------------------------------------ */

export function getWorkspace(): Workspace {
  return workspaceRoot === null
    ? { root: null, name: null }
    : { root: workspaceRoot, name: basename(workspaceRoot) }
}

export function setWatchEmitter(emit: (event: FsWatchEvent) => void): void {
  emitWatchEvent = emit
}

export async function openFolder(window: BrowserWindow | null): Promise<Workspace> {
  const result =
    window === null
      ? await dialog.showOpenDialog({ properties: ['openDirectory'] })
      : await dialog.showOpenDialog(window, { properties: ['openDirectory'] })

  const picked = result.filePaths[0]
  if (result.canceled || picked === undefined) return getWorkspace()

  await setWorkspace(picked)
  return getWorkspace()
}

/** Exposed separately from the dialog so tests can open a fixture directly. */
export async function setWorkspace(root: string): Promise<void> {
  workspaceRoot = await fsp.realpath(resolve(root))
  await startWatching(workspaceRoot)
}

async function startWatching(root: string): Promise<void> {
  await stopWatching()

  watcher = watch(root, {
    ignoreInitial: true,
    // chokidar 4 removed glob support; v5 wants a predicate.
    ignored: (target: string) =>
      target.split(/[\\/]/).some((segment) => UNWATCHED.has(segment)),
    // Editors write in several syscalls; without this a single save can emit
    // half a dozen change events and thrash the explorer.
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    depth: 16
  })

  const forward = (type: FsWatchEventType) => (target: string) => {
    if (emitWatchEvent === null || workspaceRoot === null) return
    const absolute = resolve(target)
    emitWatchEvent({
      type,
      path: absolute,
      relativePath: toRelative(workspaceRoot, absolute),
      parentRelativePath: toRelative(workspaceRoot, dirname(absolute))
    })
  }

  watcher.on('add', forward('add'))
  watcher.on('addDir', forward('addDir'))
  watcher.on('change', forward('change'))
  watcher.on('unlink', forward('unlink'))
  watcher.on('unlinkDir', forward('unlinkDir'))
  // A watch error must not take the app down — the tree simply goes stale.
  watcher.on('error', () => undefined)
}

export async function stopWatching(): Promise<void> {
  if (watcher === null) return
  const current = watcher
  watcher = null
  await current.close()
}

/* ------------------------------------------------------------------ *
 * Operations — every one of them confined
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Whole-workspace operations (step 12)
 * ------------------------------------------------------------------ */

/** Quick open needs the whole list; a monorepo must not hang the window. */
const MAX_LISTED_FILES = 20_000
/** Search reads file contents, so it is bounded more tightly than listing. */
const MAX_SEARCHED_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_RESULTS = 500

/**
 * Every file under the workspace, breadth-first.
 *
 * Breadth-first rather than depth-first on purpose: when the cap is hit, what
 * survives is the shallow files — `src/index.ts`, `README.md` — rather than
 * whatever happened to be deepest in the first directory walked. Quick open
 * with a truncated list should still contain the files people actually open.
 */
/**
 * Extension to display name. Only languages worth naming appear here; anything
 * else is aggregated under its bare extension, so an unknown filetype still
 * shows up honestly rather than being silently dropped.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  pyw: 'Python',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  md: 'Markdown',
  sh: 'Shell',
  bash: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  tf: 'Terraform',
  dockerfile: 'Dockerfile'
}

/**
 * Checked in, but not source. Binary assets are the ones that matter here: a
 * single 200 kB icon outweighs every stylesheet in the repository and would
 * appear in the bar as though `ico` were a programming language. SVG is kept —
 * it is text, it is edited by hand, and GitHub counts it too.
 */
const NOT_SOURCE = new Set([
  'lock',
  'log',
  'map',
  'snap',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'icns',
  'webp',
  'avif',
  'mp3',
  'mp4',
  'wav',
  'mov',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'pdf',
  'zip',
  'gz',
  'tar',
  '7z',
  'exe',
  'dll',
  'node',
  'pdb',
  'bin',
  'wasm'
])

/**
 * Bytes per language across the workspace.
 *
 * Aggregated here rather than in the renderer because it needs a `stat` per
 * file, and shipping a full sized file list across IPC just to sum it there
 * would be strictly more work for the same four numbers. Shares `listFiles`'
 * ignore set and ceiling so both views agree on what "the workspace" means.
 */
export async function languageBreakdown(): Promise<LanguageBreakdown> {
  const root = requireRoot()
  const byExtension = new Map<string, { bytes: number; files: number }>()

  let seen = 0
  let truncated = false
  let queue: string[] = [root]

  while (queue.length > 0 && !truncated) {
    const next: string[] = []
    for (const dir of queue) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (UNWATCHED.has(entry.name) || HIDDEN.has(entry.name)) continue
        const absolute = join(dir, entry.name)

        if (entry.isDirectory()) {
          next.push(absolute)
          continue
        }
        if (!entry.isFile()) continue

        if (seen >= MAX_LISTED_FILES) {
          truncated = true
          break
        }
        seen++

        const dot = entry.name.lastIndexOf('.')
        const extension =
          entry.name.toLowerCase() === 'dockerfile'
            ? 'dockerfile'
            : dot > 0
              ? entry.name.slice(dot + 1).toLowerCase()
              : ''
        if (extension === '' || NOT_SOURCE.has(extension)) continue

        let size: number
        try {
          size = (await fsp.stat(absolute)).size
        } catch {
          continue
        }

        const bucket = byExtension.get(extension) ?? { bytes: 0, files: 0 }
        bucket.bytes += size
        bucket.files++
        byExtension.set(extension, bucket)
      }
      if (truncated) break
    }
    queue = next
  }

  // Extensions that share a language are summed, so TypeScript is one bar
  // rather than four (.ts/.tsx/.mts/.cts).
  const byLanguage = new Map<string, LanguageStat>()
  for (const [extension, bucket] of byExtension) {
    const language = LANGUAGE_NAMES[extension] ?? extension
    const existing = byLanguage.get(language)
    if (existing === undefined) {
      byLanguage.set(language, { language, extension, bytes: bucket.bytes, files: bucket.files })
    } else {
      existing.bytes += bucket.bytes
      existing.files += bucket.files
    }
  }

  const languages = [...byLanguage.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12)
  const totalBytes = [...byLanguage.values()].reduce((sum, entry) => sum + entry.bytes, 0)

  return { languages, totalBytes, truncated }
}

export async function listFiles(): Promise<FileNode[]> {
  const root = requireRoot()
  const found: FileNode[] = []
  let queue: string[] = [root]

  while (queue.length > 0 && found.length < MAX_LISTED_FILES) {
    const next: string[] = []
    for (const dir of queue) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (UNWATCHED.has(entry.name) || HIDDEN.has(entry.name)) continue
        const absolute = join(dir, entry.name)

        if (entry.isDirectory()) {
          next.push(absolute)
        } else if (entry.isFile()) {
          found.push(toNode(root, absolute, 'file'))
          if (found.length >= MAX_LISTED_FILES) break
        }
      }
      if (found.length >= MAX_LISTED_FILES) break
    }
    queue = next
  }

  return found
}

/**
 * True when a buffer looks like a binary file.
 *
 * A NUL byte in the first few KB is the same heuristic git uses, and it is
 * enough: searching a PNG produces garbage matches and megabytes of nonsense
 * preview text.
 */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000)
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

export interface SearchOptions {
  readonly query: string
  readonly caseSensitive: boolean
  readonly isRegex: boolean
}

/**
 * Plain text or regex search across the workspace.
 *
 * A user-supplied regex is compiled inside a try/catch and reported as a bad
 * request rather than thrown: half-typed patterns are the normal state of a
 * search box, not an error condition.
 */
export async function searchWorkspace(options: SearchOptions): Promise<SearchMatch[]> {
  // `listFiles` enforces the workspace requirement and the confinement.
  if (options.query === '') return []

  let pattern: RegExp
  try {
    const source = options.isRegex ? options.query : escapeRegExp(options.query)
    pattern = new RegExp(source, options.caseSensitive ? 'g' : 'gi')
  } catch {
    throw new BetterCallCompilerServiceError('BAD_REQUEST', `invalid regular expression: ${options.query}`)
  }

  const files = await listFiles()
  const matches: SearchMatch[] = []

  for (const file of files) {
    if (matches.length >= MAX_SEARCH_RESULTS) break

    let buffer: Buffer
    try {
      const stats = await fsp.stat(file.path)
      if (stats.size > MAX_SEARCHED_BYTES) continue
      buffer = await fsp.readFile(file.path)
    } catch {
      continue
    }
    if (looksBinary(buffer)) continue

    const lines = buffer.toString('utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === undefined) continue

      pattern.lastIndex = 0
      const found = pattern.exec(line)
      if (found === null || found[0] === '') continue

      matches.push({
        path: file.path,
        relativePath: file.relativePath,
        line: index + 1,
        column: found.index + 1,
        // Long minified lines would otherwise dominate the result list.
        preview: line.length > 400 ? `${line.slice(0, 400)}…` : line,
        matchLength: found[0].length
      })

      if (matches.length >= MAX_SEARCH_RESULTS) break
    }
  }

  return matches
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function readDirectory(requestedPath: string): Promise<FileNode[]> {
  const root = requireRoot()
  const dir = await confinePath(root, requestedPath)

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `cannot read directory: ${requestedPath}`)
  }

  const nodes: FileNode[] = []
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue
    const absolute = join(dir, entry.name)

    let kind: FileNode['kind']
    if (entry.isSymbolicLink()) {
      // A link is only listed if its *target* is also inside the workspace,
      // so the tree can never present an escape route as ordinary content.
      try {
        await confinePath(root, absolute)
        const stats = await fsp.stat(absolute)
        kind = stats.isDirectory() ? 'directory' : 'file'
      } catch {
        continue
      }
    } else {
      kind = entry.isDirectory() ? 'directory' : 'file'
    }

    nodes.push(toNode(root, absolute, kind))
  }

  // Directories first, then case-insensitive by name — the ordering every
  // file explorer uses, and the one users expect.
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return nodes
}

export async function readFile(requestedPath: string): Promise<string> {
  const root = requireRoot()
  const target = await confinePath(root, requestedPath)
  try {
    return await fsp.readFile(target, 'utf8')
  } catch {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `cannot read file: ${requestedPath}`)
  }
}

export async function writeFile(requestedPath: string, content: string): Promise<void> {
  const root = requireRoot()
  const target = await confinePath(root, requestedPath)
  try {
    await fsp.writeFile(target, content, 'utf8')
  } catch {
    throw new BetterCallCompilerServiceError('IO_ERROR', `cannot write file: ${requestedPath}`)
  }
}

export async function createFile(requestedPath: string): Promise<FileNode> {
  const root = requireRoot()
  const target = await confinePath(root, requestedPath)
  try {
    await fsp.mkdir(dirname(target), { recursive: true })
    // wx: fail rather than clobber an existing file.
    const handle = await fsp.open(target, 'wx')
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new BetterCallCompilerServiceError('ALREADY_EXISTS', `already exists: ${requestedPath}`)
    }
    throw new BetterCallCompilerServiceError('IO_ERROR', `cannot create file: ${requestedPath}`)
  }
  return toNode(root, target, 'file')
}

export async function createDirectory(requestedPath: string): Promise<FileNode> {
  const root = requireRoot()
  const target = await confinePath(root, requestedPath)
  try {
    await fsp.mkdir(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new BetterCallCompilerServiceError('ALREADY_EXISTS', `already exists: ${requestedPath}`)
    }
    throw new BetterCallCompilerServiceError('IO_ERROR', `cannot create directory: ${requestedPath}`)
  }
  return toNode(root, target, 'directory')
}

export async function rename(from: string, to: string): Promise<FileNode> {
  const root = requireRoot()
  // Both ends are confined: renaming *out* of the workspace is as dangerous as
  // reading out of it.
  const source = await confinePath(root, from)
  const destination = await confinePath(root, to)

  try {
    await fsp.rename(source, destination)
  } catch {
    throw new BetterCallCompilerServiceError('IO_ERROR', `cannot rename ${from} to ${to}`)
  }

  const stats = await fsp.stat(destination)
  return toNode(root, destination, stats.isDirectory() ? 'directory' : 'file')
}

export async function remove(requestedPath: string): Promise<void> {
  const root = requireRoot()
  const target = await confinePath(root, requestedPath)

  if (isWithin(target, root) && normalizeForCompare(target) === normalizeForCompare(root)) {
    throw new BetterCallCompilerServiceError('UNSUPPORTED', 'refusing to delete the workspace root')
  }

  try {
    await fsp.rm(target, { recursive: true, force: false })
  } catch {
    throw new BetterCallCompilerServiceError('IO_ERROR', `cannot delete: ${requestedPath}`)
  }
}

/** Test hook: drop all state between cases. */
export async function resetForTests(): Promise<void> {
  await stopWatching()
  workspaceRoot = null
  emitWatchEvent = null
}
