import { parentPort } from 'node:worker_threads'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Token } from '../lang/token'
import type { Diagnostic } from '../lang/diagnostic'
import { tokenize } from '../lang/lexer'
import { parse, type ParseResult } from '../lang/parser'
import { BCC_EXTENSION, toDiagnosticMessages } from '../shared/lang-diagnostics'
import {
  isLangRequest,
  type LangMessage,
  type LangRequest
} from '../shared/lang-protocol'
import { createEngine, queryKey, QueryCycleError } from '../shared/query-engine'
import type { DiagnosticMessage, FileDiagnostics } from '../shared/types'

/**
 * The BCC daemon, running in a worker_thread.
 *
 * Never imports electron — it is a plain Node worker, exactly like
 * `compiler-worker.ts`. It runs in a thread for a different reason than that
 * one does, though: TypeScript's checker is slow and synchronous, whereas
 * lexing and parsing a BCC file is microseconds. This is here so that a BUG in
 * the compiler being written cannot freeze the window. A teaching compiler
 * under active development is exactly the code most likely to loop forever, and
 * this is the boundary that makes that survivable rather than fatal.
 *
 * ## The pipeline
 *
 * `text → tokens → ast → diagnostics`, as four queries on this worker's own
 * `createEngine()`. `text` is the only input; everything else is derived and so
 * is computed on demand and never eagerly.
 *
 * Part 4 inserts `symbols` and `types` between `ast` and `diagnostics` without
 * disturbing the ends. Part 12 makes the cutoff between the stages real —
 * today the engine buys correct per-file invalidation and a free skip when a
 * watch event names a file whose content did not actually change, which is
 * common (editors write, formatters rewrite, git checkouts touch everything).
 *
 * ## No dependency graph
 *
 * `compiler-worker.ts` is 1000 lines mostly because TypeScript files import
 * each other: it walks imports, maintains reverse edges, computes invalidation
 * sets, detects cycles and hashes module signatures to cut off. **BCC has no
 * imports.** One file changing affects exactly that file. None of that
 * machinery is missing here — it is absent because the language does not need
 * it, and it should stay absent until BCC grows a module system.
 */

const port = parentPort

function post(message: LangMessage): void {
  port?.postMessage(message)
}

/** Mirrors fs-service's UNWATCHED so every side agrees what "the workspace" is. */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.bettercallcompiler',
  'dist',
  'out',
  '.next'
])

/** Same ceiling as fs-service's listFiles and the TypeScript worker's walk. */
const MAX_WALKED_FILES = 20_000

let workspaceRoot: string | null = null

/** Unsaved buffers, preferred over what is on disk. */
const overlays = new Map<string, { content: string; version: number }>()

/** Every `.bcc` file the walk found, so a deleted file can be swept. */
const known = new Set<string>()

/** Monotonic per file, so the service can discard an out-of-order batch. */
const emittedVersions = new Map<string, number>()

/** Files that had diagnostics last time, for the clean sweep. */
let previouslyDirty = new Set<string>()

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

/* ------------------------------ query layer ------------------------------- */

/**
 * Query namespaces.
 *
 * Short, because they appear in every trace line and — from Part 12 — in the
 * Compiler Intelligence view, where `ast:examples/fib.bcc` reads and
 * `abstractSyntaxTree:examples/fib.bcc` does not.
 */
const Q_TEXT = 'text'
const Q_TOKENS = 'tokens'
const Q_AST = 'ast'
const Q_DIAG = 'diag'

const engine = createEngine()

engine.defineQuery(Q_TOKENS, (relativePath, ctx) => {
  const text = ctx.get<string | null>(queryKey(Q_TEXT, relativePath))
  return text === null ? [] : tokenize(text)
})

engine.defineQuery(Q_AST, (relativePath, ctx) => {
  const tokens = ctx.get<Token[]>(queryKey(Q_TOKENS, relativePath))
  return parse(tokens)
})

engine.defineQuery(Q_DIAG, (relativePath, ctx) => {
  const root = workspaceRoot
  if (root === null) return []

  const { diagnostics } = ctx.get<ParseResult>(queryKey(Q_AST, relativePath))
  return toDiagnosticMessages(
    relativePath,
    toAbsolute(root, relativePath),
    diagnostics as readonly Diagnostic[]
  )
})

/**
 * The current text of a file: the unsaved buffer if there is one, else disk.
 *
 * Null rather than a throw for a file that cannot be read. A file deleted
 * between the watch event and this read is ordinary, not exceptional, and
 * `setInput` writing null means the derived stages produce an empty token list
 * and no diagnostics instead of the daemon dying on a race.
 */
function currentText(root: string, relativePath: string): string | null {
  const overlay = overlays.get(relativePath)
  if (overlay !== undefined) return overlay.content

  try {
    return readFileSync(toAbsolute(root, relativePath), 'utf8')
  } catch {
    return null
  }
}

/**
 * Writes a file's text into the engine.
 *
 * Returns whether anything actually changed. `setInput` compares before it
 * bumps the revision, so a watch event for a file whose bytes are identical —
 * a formatter rewriting the same content, a git checkout touching every mtime —
 * costs nothing downstream.
 */
function refresh(root: string, relativePath: string): boolean {
  const text = currentText(root, relativePath)
  if (text === null) {
    known.delete(relativePath)
    return engine.removeInput(queryKey(Q_TEXT, relativePath))
  }
  known.add(relativePath)
  return engine.setInput(queryKey(Q_TEXT, relativePath), text, 'workspace')
}

/* -------------------------------- walking --------------------------------- */

function walk(root: string): string[] {
  const found: string[] = []
  const stack: string[] = [root]

  while (stack.length > 0 && found.length < MAX_WALKED_FILES) {
    const directory = stack.pop()
    if (directory === undefined) break

    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue // unreadable directory: skipped, not fatal
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        stack.push(join(directory, entry.name))
        continue
      }
      if (!entry.name.toLowerCase().endsWith(BCC_EXTENSION)) continue
      found.push(toRelative(root, join(directory, entry.name)))
    }
  }

  return found
}

/* -------------------------------- checking -------------------------------- */

/**
 * Produces diagnostics for the named files and posts them.
 *
 * The clean sweep at the end is the half that is easy to forget and impossible
 * to miss once it bites: a file that had errors and no longer does must be sent
 * an EMPTY array, or its squiggles and its Problems row survive the fix
 * forever. `coalesceBatches` and the renderer both treat an empty array as
 * "now clean" rather than as an empty batch to skip, and this is where that
 * signal is produced.
 */
function check(paths: readonly string[]): void {
  const root = workspaceRoot
  if (root === null) return

  const produced: FileDiagnostics[] = []
  const nowDirty = new Set<string>()

  for (const relativePath of paths) {
    // A deleted file is answered without asking the engine anything.
    //
    // Not an optimisation. `refresh` calls `removeInput` for a file that is
    // gone, and `text` is an INPUT namespace with no compute function behind
    // it — so a `diag:` query for that path walks down to a `text:` key that no
    // longer exists and the engine throws "no query registered for namespace
    // text". The daemon then dies on the ordinary act of deleting a file.
    //
    // Exactly the shape of the bug the TypeScript worker hit when deletion
    // invalidation was added there, and found the same way: by driving the real
    // worker rather than a fake.
    if (!known.has(relativePath)) {
      const version = (emittedVersions.get(relativePath) ?? 0) + 1
      emittedVersions.set(relativePath, version)
      produced.push({
        relativePath,
        path: toAbsolute(root, relativePath),
        diagnostics: [],
        version
      })
      continue
    }

    let diagnostics: DiagnosticMessage[]
    try {
      diagnostics = engine.get<DiagnosticMessage[]>(queryKey(Q_DIAG, relativePath))
    } catch (error) {
      // A query cycle would be a bug in the wiring above rather than in the
      // user's code, and it must not cost them the rest of the check.
      if (!(error instanceof QueryCycleError)) throw error
      continue
    }

    const version = (emittedVersions.get(relativePath) ?? 0) + 1
    emittedVersions.set(relativePath, version)

    produced.push({
      relativePath,
      path: toAbsolute(root, relativePath),
      diagnostics,
      version
    })
    if (diagnostics.length > 0) nowDirty.add(relativePath)
  }

  for (const relativePath of previouslyDirty) {
    if (nowDirty.has(relativePath)) continue
    if (paths.includes(relativePath)) continue
    if (known.has(relativePath)) continue

    // Deleted while dirty. An explicit empty set is the only thing that makes
    // the Problems panel drop the row for a file that no longer exists.
    const version = (emittedVersions.get(relativePath) ?? 0) + 1
    emittedVersions.set(relativePath, version)
    produced.push({
      relativePath,
      path: toAbsolute(root, relativePath),
      diagnostics: [],
      version
    })
  }

  previouslyDirty = nowDirty

  if (produced.length > 0) post({ type: 'diagnostics', files: produced, settled: true })
}

/* ------------------------------- messages --------------------------------- */

function boot(root: string): void {
  workspaceRoot = root
  engine.clear()
  overlays.clear()
  known.clear()
  emittedVersions.clear()
  previouslyDirty = new Set()

  const files = walk(root)
  for (const relativePath of files) refresh(root, relativePath)

  post({ type: 'indexed', fileCount: files.length })
  check(files)
}

function handle(request: LangRequest): void {
  switch (request.type) {
    case 'boot':
      boot(request.workspaceRoot)
      return

    case 'filesChanged': {
      const root = workspaceRoot
      if (root === null) return

      const touched: string[] = []
      for (const relativePath of request.removed) {
        // An open buffer outlives the file on disk: the user can delete a file
        // they are still looking at, and the editor still has its text.
        if (overlays.has(relativePath)) continue
        refresh(root, relativePath)
        touched.push(relativePath)
      }
      for (const relativePath of request.changed) {
        // Disk lost to the buffer. A file the user is editing is checked from
        // what they can see, not from what was last saved.
        if (overlays.has(relativePath)) continue
        if (refresh(root, relativePath)) touched.push(relativePath)
      }

      if (touched.length > 0) check(touched)
      return
    }

    case 'openDocument': {
      const root = workspaceRoot
      if (root === null) return

      const existing = overlays.get(request.relativePath)
      // Monaco's version id only ever increases, so an overlay that arrives
      // out of order is stale and must not overwrite a newer buffer.
      if (existing !== undefined && existing.version > request.version) return

      overlays.set(request.relativePath, {
        content: request.content,
        version: request.version
      })
      if (refresh(root, request.relativePath)) check([request.relativePath])
      return
    }

    case 'closeDocument': {
      const root = workspaceRoot
      if (root === null) return
      if (!overlays.delete(request.relativePath)) return
      // Back to whatever is on disk, which may differ from the buffer that was
      // just discarded — closing without saving must not leave the editor's
      // unsaved errors behind.
      refresh(root, request.relativePath)
      check([request.relativePath])
      return
    }

    case 'ping':
      post({ type: 'pong', nonce: request.nonce, heapUsedMb: heapUsedMb() })
      return
  }
}

port?.on('message', (raw: unknown) => {
  if (!isLangRequest(raw)) return
  try {
    handle(raw)
  } catch (error) {
    // The parser promises never to throw and the lexer promises the same, but
    // a promise is not a proof. Reporting rather than dying keeps the failure
    // legible and lets the supervisor decide, instead of the thread vanishing
    // with an exit code.
    post({
      type: 'failure',
      detail: error instanceof Error ? error.message : 'the BCC daemon failed'
    })
  }
})

post({ type: 'ready' })
