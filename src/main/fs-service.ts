import { BrowserWindow, dialog } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promises as fsp } from 'node:fs'
import { ApertureServiceError } from '../shared/ipc-contract'
import type { FileNode, FsWatchEvent, FsWatchEventType, Workspace } from '../shared/types'

/** Directories never walked by the watcher — cheap to skip, ruinous to watch. */
const UNWATCHED = new Set(['node_modules', '.git', '.aperture', 'dist', 'out', '.next'])

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
        throw new ApertureServiceError('NOT_FOUND', `cannot resolve path: ${target}`)
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
    throw new ApertureServiceError('NO_WORKSPACE', 'no folder is open')
  }

  const realRoot = await fsp.realpath(resolve(root))
  const absolute = isAbsolute(candidate) ? candidate : resolve(realRoot, candidate)
  const resolved = await realpathAllowingMissing(absolute)

  if (!isWithin(realRoot, resolved)) {
    throw new ApertureServiceError(
      'PATH_ESCAPES_WORKSPACE',
      `path resolves outside the workspace: ${candidate}`
    )
  }

  return resolved
}

function requireRoot(): string {
  if (workspaceRoot === null) {
    throw new ApertureServiceError('NO_WORKSPACE', 'no folder is open')
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

export async function readDirectory(requestedPath: string): Promise<FileNode[]> {
  const root = requireRoot()
  const dir = await confinePath(root, requestedPath)

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    throw new ApertureServiceError('NOT_FOUND', `cannot read directory: ${requestedPath}`)
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
    throw new ApertureServiceError('NOT_FOUND', `cannot read file: ${requestedPath}`)
  }
}

export async function writeFile(requestedPath: string, content: string): Promise<void> {
  const root = requireRoot()
  const target = await confinePath(root, requestedPath)
  try {
    await fsp.writeFile(target, content, 'utf8')
  } catch {
    throw new ApertureServiceError('IO_ERROR', `cannot write file: ${requestedPath}`)
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
      throw new ApertureServiceError('ALREADY_EXISTS', `already exists: ${requestedPath}`)
    }
    throw new ApertureServiceError('IO_ERROR', `cannot create file: ${requestedPath}`)
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
      throw new ApertureServiceError('ALREADY_EXISTS', `already exists: ${requestedPath}`)
    }
    throw new ApertureServiceError('IO_ERROR', `cannot create directory: ${requestedPath}`)
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
    throw new ApertureServiceError('IO_ERROR', `cannot rename ${from} to ${to}`)
  }

  const stats = await fsp.stat(destination)
  return toNode(root, destination, stats.isDirectory() ? 'directory' : 'file')
}

export async function remove(requestedPath: string): Promise<void> {
  const root = requireRoot()
  const target = await confinePath(root, requestedPath)

  if (isWithin(target, root) && normalizeForCompare(target) === normalizeForCompare(root)) {
    throw new ApertureServiceError('UNSUPPORTED', 'refusing to delete the workspace root')
  }

  try {
    await fsp.rm(target, { recursive: true, force: false })
  } catch {
    throw new ApertureServiceError('IO_ERROR', `cannot delete: ${requestedPath}`)
  }
}

/** Test hook: drop all state between cases. */
export async function resetForTests(): Promise<void> {
  await stopWatching()
  workspaceRoot = null
  emitWatchEvent = null
}
