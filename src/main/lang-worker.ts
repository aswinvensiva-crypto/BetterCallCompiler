import { parentPort } from 'node:worker_threads'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Token } from '../lang/token'
import type { Diagnostic } from '../lang/diagnostic'
import { tokenize } from '../lang/lexer'
import type { Span } from '../lang/token'
import {
  definitionAt,
  documentSymbols,
  hoverAt,
  referencesAt,
  rejectNewName,
  renameAt,
  type OutlineNode
} from '../lang/navigation'
import { parse, type ParseResult } from '../lang/parser'
import { resolve, type Resolution } from '../lang/symbols'
import { typeCheck, type TypeInfo } from '../lang/type-check'
import { BCC_EXTENSION, toDiagnosticMessages } from '../shared/lang-diagnostics'
import {
  emptyLangQueryResult,
  isLangRequest,
  type LangMessage,
  type LangQueryRequest,
  type LangQueryResult,
  type LangRequest
} from '../shared/lang-protocol'
import { createEngine, queryKey, QueryCycleError } from '../shared/query-engine'
import {
  MAX_REFERENCE_RESULTS,
  type DiagnosticMessage,
  type DocumentSymbolNode,
  type FileDiagnostics,
  type LanguageLocation,
  type SourceRange,
  type TextEdit
} from '../shared/types'

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
 * `text → tokens → ast → symbols → types → diagnostics`, as six queries on this
 * worker's own `createEngine()`. `text` is the only input; everything else is
 * derived and so is computed on demand and never eagerly.
 *
 * Part 12 makes the cutoff between the stages real — today the engine buys
 * correct per-file invalidation and a free skip when a watch event names a file
 * whose content did not actually change, which is common (editors write,
 * formatters rewrite, git checkouts touch everything).
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

/**
 * Files a QUERY moved ahead of the check that was going to cover them.
 *
 * A query adopts the caller's buffer without checking, on purpose — see
 * `syncOverlay`. But `setInput` only reports a change ONCE, and `openDocument`
 * decides whether to check from exactly that answer. So a query carrying the
 * new text, followed 300ms later by the debounced push carrying the same text,
 * leaves the second one looking like a no-op and no check ever runs: the buffer
 * is current, the answers are current, and the squiggles are from two edits
 * ago. Found by the E2E that fixes a file while it is open, which is the
 * ordinary case rather than a corner one.
 *
 * Recording the debt here keeps the two concerns apart — a query still never
 * costs a check pass, and the debounce still decides when one happens.
 */
const checkOwed = new Set<string>()

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
const Q_SYMBOLS = 'symbols'
const Q_TYPES = 'types'
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

engine.defineQuery(Q_SYMBOLS, (relativePath, ctx) => {
  const { program } = ctx.get<ParseResult>(queryKey(Q_AST, relativePath))
  return resolve(program)
})

engine.defineQuery(Q_TYPES, (relativePath, ctx) => {
  const { program } = ctx.get<ParseResult>(queryKey(Q_AST, relativePath))
  const resolution = ctx.get<Resolution>(queryKey(Q_SYMBOLS, relativePath))
  return typeCheck(program, resolution)
})

engine.defineQuery(Q_DIAG, (relativePath, ctx) => {
  const root = workspaceRoot
  if (root === null) return []

  const parsed = ctx.get<ParseResult>(queryKey(Q_AST, relativePath))
  const resolution = ctx.get<Resolution>(queryKey(Q_SYMBOLS, relativePath))
  const typed = ctx.get<TypeInfo>(queryKey(Q_TYPES, relativePath))

  // Every stage's diagnostics, merged and sorted by position.
  //
  // Sorted because the Problems panel renders them in the order it receives
  // them, and three stages each reporting in their own walk order would list a
  // type error on line 2 above a syntax error on line 1. Position order is the
  // only order a reader can predict.
  //
  // All three stages run even when an earlier one found something. A file with
  // a syntax error still gets symbols and types for the parts that parsed,
  // which is what the Observatory and any future hover need — and the parser's
  // `ErrorExpr` types as `error`, so it costs no extra noise.
  const all: Diagnostic[] = [
    ...parsed.diagnostics,
    ...resolution.diagnostics,
    ...typed.diagnostics
  ].sort((a, b) => a.span.offset - b.span.offset)

  return toDiagnosticMessages(relativePath, toAbsolute(root, relativePath), all)
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

  // Whatever this pass covers is no longer owed, however it came to be owed.
  for (const relativePath of paths) checkOwed.delete(relativePath)

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

/* ------------------------------- answering -------------------------------- */

/**
 * A span, in the shape every position in this codebase already uses.
 *
 * A straight field copy, and that is the whole payoff for Part 1 threading
 * 1-based line and column through every stage. The TypeScript worker has to
 * convert `{ start, length }` through `lineStartsOf`/`positionAt` and cache the
 * line table per file to keep a 200-file reference search affordable; here
 * there is nothing to convert and nothing to cache.
 */
function toRange(span: Span): SourceRange {
  return {
    startLine: span.startLine,
    startColumn: span.startColumn,
    endLine: span.endLine,
    endColumn: span.endColumn
  }
}

function toLocation(root: string, relativePath: string, span: Span): LanguageLocation {
  return {
    relativePath,
    path: toAbsolute(root, relativePath),
    range: toRange(span)
  }
}

function toDocumentSymbol(node: OutlineNode): DocumentSymbolNode {
  return {
    name: node.name,
    detail: node.detail,
    kind: node.kind,
    range: toRange(node.span),
    selectionRange: toRange(node.selection),
    children: node.children.map(toDocumentSymbol)
  }
}

/**
 * Adopts the caller's buffer WITHOUT scheduling a check.
 *
 * This is the fix for the freshness hazard, and the separation is the point.
 * `openDocument` conflates two things — "this is what the file says now" and
 * "please re-check it" — which is why the renderer debounces it 300ms, and
 * therefore why the daemon can be 300ms behind the buffer. An interactive query
 * needs the first and must not pay for the second: answering a rename against
 * text the user has already edited rewrites the wrong bytes.
 *
 * `setInput` compares before it bumps the revision, so when the debounced
 * overlay has already landed this costs one string comparison and invalidates
 * nothing.
 */
function syncOverlay(
  root: string,
  relativePath: string,
  overlay: { readonly content: string; readonly version: number }
): void {
  const existing = overlays.get(relativePath)
  // Same monotonic-version rule as `openDocument`: a buffer that arrives out of
  // order is stale and must not overwrite a newer one.
  if (existing !== undefined && existing.version > overlay.version) return
  overlays.set(relativePath, { content: overlay.content, version: overlay.version })
  if (refresh(root, relativePath)) checkOwed.add(relativePath)
}

/** The three front-end stages for a file, or null when there is no such file. */
function frontEnd(
  relativePath: string
): { parsed: ParseResult; resolution: Resolution; types: TypeInfo } | null {
  if (!known.has(relativePath)) return null
  return {
    parsed: engine.get<ParseResult>(queryKey(Q_AST, relativePath)),
    resolution: engine.get<Resolution>(queryKey(Q_SYMBOLS, relativePath)),
    types: engine.get<TypeInfo>(queryKey(Q_TYPES, relativePath))
  }
}

function answer(root: string, request: LangQueryRequest): LangQueryResult {
  const { kind, relativePath, offset } = request

  const front = frontEnd(relativePath)
  if (front === null) return emptyLangQueryResult(kind)
  const { parsed, resolution, types } = front

  switch (kind) {
    case 'definition': {
      const span = definitionAt(parsed.program, resolution, offset)
      return {
        kind,
        locations: span === null ? [] : [toLocation(root, relativePath, span)]
      }
    }

    case 'references': {
      const spans = referencesAt(parsed.program, resolution, offset, true)
      return {
        kind,
        locations: spans
          .slice(0, MAX_REFERENCE_RESULTS)
          .map((span) => toLocation(root, relativePath, span)),
        truncated: spans.length > MAX_REFERENCE_RESULTS
      }
    }

    case 'rename': {
      const plan = renameAt(parsed.program, resolution, offset)
      if (plan === null) {
        return {
          kind,
          target: null,
          placeholder: null,
          files: [],
          error: 'there is nothing to rename here'
        }
      }

      const target = toRange(plan.target)
      // `newName === null` is the first half of a rename: Monaco asking where
      // to draw the inline box. Nothing is rewritten yet.
      if (request.newName === null) {
        return { kind, target, placeholder: plan.placeholder, files: [], error: null }
      }

      const rejection = rejectNewName(request.newName)
      if (rejection !== null) {
        return { kind, target, placeholder: plan.placeholder, files: [], error: rejection }
      }

      // Descending, so applying them in order cannot move the ranges of the
      // edits not yet applied. BCC has no imports, so a rename is always one
      // file and there is never a closed file to write.
      const edits: TextEdit[] = plan.spans
        .map((span) => ({ range: toRange(span), newText: request.newName as string }))
        .sort((a, b) =>
          a.range.startLine === b.range.startLine
            ? b.range.startColumn - a.range.startColumn
            : b.range.startLine - a.range.startLine
        )

      return {
        kind,
        target,
        placeholder: plan.placeholder,
        files: [{ relativePath, path: toAbsolute(root, relativePath), edits }],
        error: null
      }
    }

    case 'documentSymbols':
      return {
        kind,
        symbols: documentSymbols(parsed.program, resolution, types).map(toDocumentSymbol)
      }

    case 'hover': {
      const hover = hoverAt(parsed.program, resolution, types, offset)
      return hover === null
        ? { kind, contents: null, range: null }
        : { kind, contents: '```bcc\n' + hover.text + '\n```', range: toRange(hover.span) }
    }
  }
}

/**
 * Answers one query, and always answers.
 *
 * The catch is not defensive padding. A query that throws would otherwise reach
 * the outer handler, be posted as a `failure`, and leave the supervisor's
 * resolver pending until its timeout — so a bug in one navigation query would
 * cost the user a five-second stall rather than an empty result. `QueryCycleError`
 * is the same reasoning `check` already applies.
 */
function respond(request: LangQueryRequest): void {
  const root = workspaceRoot
  let result: LangQueryResult

  try {
    if (root === null) {
      result = emptyLangQueryResult(request.kind)
    } else {
      // Inside the try, deliberately. An overlay that failed to apply outside it
      // would reach the outer handler, be posted as a `failure`, and leave the
      // caller's resolver pending until its timeout — a stall instead of a
      // wrong answer, which is the worse of the two.
      if (request.overlay !== null) syncOverlay(root, request.relativePath, request.overlay)
      result = answer(root, request)
    }
  } catch (error) {
    if (!(error instanceof QueryCycleError)) {
      post({
        type: 'failure',
        detail: error instanceof Error ? error.message : 'a BCC query failed'
      })
    }
    result = emptyLangQueryResult(request.kind)
  }

  post({ type: 'queryResult', requestId: request.requestId, result })
}

/* ------------------------------- messages --------------------------------- */

function boot(root: string): void {
  workspaceRoot = root
  engine.clear()
  overlays.clear()
  known.clear()
  emittedVersions.clear()
  checkOwed.clear()
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
      // Two reasons to check: the text moved now, or a query already moved it
      // and nothing has checked since. Without the second, an interactive query
      // between two pushes swallows the re-check entirely.
      const moved = refresh(root, request.relativePath)
      if (moved || checkOwed.has(request.relativePath)) check([request.relativePath])
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

    // The buffer rides on the request, and `respond` adopts it. That is what
    // makes the answer describe the file the user is looking at rather than the
    // one the 300ms debounce last got around to sending.
    case 'query':
      respond(request)
      return

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
