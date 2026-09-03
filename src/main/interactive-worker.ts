import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  emptyInteractiveAnswer,
  isInteractiveRequest,
  type InteractiveMessage,
  type InteractiveQueryAnswer,
  type InteractiveQueryRequest,
  type InteractiveRequest
} from '../shared/interactive-protocol'
import {
  SOURCE_EXTENSIONS,
  createLanguageServiceHost,
  extensionOf,
  loadWorkspaceConfig,
  toAbsolute,
  toRelative,
  walkSources
} from './ts-workspace'
import {
  MAX_COMPLETION_ITEMS,
  type CompletionItem,
  type SourceRange
} from '../shared/types'
import { lineStartsOf, rangeFromSpan } from '../shared/diagnostic-position'

/**
 * The interactive daemon: a second, read-only `ts.LanguageService`.
 *
 * It answers hover, completions and signature help, and it does nothing else —
 * no diagnostics, no query engine, no dependency graph, no cancellation. That
 * absence is the design rather than an omission.
 *
 * ## Why a whole second type checker
 *
 * These three are asked at keystroke frequency and are only correct with the
 * whole program. The check worker has the whole program, so the obvious move is
 * to ask it — and the obvious move is wrong: `getSemanticDiagnostics` is
 * synchronous, so reaching it means cancelling the check, and a check cancelled
 * on every character never converges. The squiggles would stop appearing
 * exactly while you type, which is when you want them.
 *
 * So the two are separated by what they cost rather than by what they know. The
 * check worker is interruptible and slow; this one is never interrupted and
 * never has to be, because nothing it does takes long enough to be worth
 * interrupting. The price is a second program and a second type checker in
 * memory, and it is stated rather than hidden: `CompilerStatus.interactive`
 * tells the renderer whether this exists, and Monaco's own providers serve
 * until it does.
 *
 * ## No cancellation, deliberately
 *
 * There is no `getCancellationToken` on this host. A request here is superseded
 * by the next keystroke rather than cancelled — the renderer's provider is
 * already gone by then, and Monaco discards a late answer for a position the
 * cursor has left. Adding cancellation would buy nothing and cost the same
 * `OperationCanceledException` hazard the check worker had to carve out for.
 */

const port = parentPort

function post(message: InteractiveMessage): void {
  port?.postMessage(message)
}

let workspaceRoot: string | null = null
let compilerOptions: ts.CompilerOptions = {}
let service: ts.LanguageService | null = null

/** Every source file the walk found, as workspace-relative paths. */
const known = new Set<string>()

/** Unsaved buffers, preferred over what is on disk. */
const overlays = new Map<string, { content: string; version: number }>()

/**
 * Bumped whenever a file's text could have changed.
 *
 * A counter this worker controls, NOT mtime: the filesystem clock is coarse on
 * some volumes, so two saves inside one tick would produce the same version and
 * leave the service serving a snapshot that is one edit behind.
 */
const versions = new Map<string, number>()

function bump(relativePath: string): void {
  versions.set(relativePath, (versions.get(relativePath) ?? 0) + 1)
}

function heapUsedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10
}

function readIfPossible(absolute: string): string | null {
  try {
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

function textOf(relativePath: string): string | null {
  const overlay = overlays.get(relativePath)
  if (overlay !== undefined) return overlay.content
  const root = workspaceRoot
  if (root === null) return null
  return readIfPossible(toAbsolute(root, relativePath))
}

function ensureService(root: string): ts.LanguageService {
  if (service !== null) return service

  service = ts.createLanguageService(
    createLanguageServiceHost({
      root,
      // Overlays included even for a path the walk never saw: a file created
      // and typed into before it is saved still deserves completions.
      scriptFileNames: () =>
        [...new Set([...known, ...overlays.keys()])].map((path) => toAbsolute(root, path)),
      compilerOptions: () => compilerOptions,
      textOf,
      versionOf: (relativePath) => {
        const overlay = overlays.get(relativePath)
        return overlay === undefined
          ? `d${versions.get(relativePath) ?? 0}`
          : `o${overlay.version}`
      }
      // No `isCancellationRequested`: see the note at the top of this file.
    }),
    ts.createDocumentRegistry()
  )

  return service
}

/* -------------------------------- indexing -------------------------------- */

function index(root: string): void {
  workspaceRoot = root
  compilerOptions = loadWorkspaceConfig(root).options

  known.clear()
  overlays.clear()
  versions.clear()
  // The program's shape changed, so any cached service describes a different
  // workspace.
  service = null

  for (const absolute of walkSources(root).files) known.add(toRelative(root, absolute))

  post({ type: 'indexed', fileCount: known.size })
}

/* -------------------------------- answering ------------------------------- */

function flatten(parts: readonly ts.SymbolDisplayPart[] | undefined): string | null {
  if (parts === undefined || parts.length === 0) return null
  // Copied because `displayPartsToString` takes a mutable array, and every
  // caller here holds a readonly one from the LanguageService.
  return ts.displayPartsToString([...parts])
}

function rangeOf(relativePath: string, span: ts.TextSpan): SourceRange {
  return rangeFromSpan(lineStartsOf(textOf(relativePath) ?? ''), span.start, span.length)
}

function answer(root: string, request: InteractiveQueryRequest): InteractiveQueryAnswer {
  const { kind, relativePath, offset } = request
  const absolute = toAbsolute(root, relativePath)
  const languageService = ensureService(root)

  switch (kind) {
    case 'hover': {
      const info = languageService.getQuickInfoAtPosition(absolute, offset)
      if (info === undefined) return { kind, contents: null, range: null }

      const signature = flatten(info.displayParts)
      const documentation = flatten(info.documentation)
      if (signature === null && documentation === null) {
        return { kind, contents: null, range: null }
      }

      // Fenced as TypeScript so Monaco's markdown renderer highlights the
      // signature the way the editor highlights the code it describes.
      const fenced = signature === null ? '' : '```typescript\n' + signature + '\n```'
      const contents = documentation === null ? fenced : `${fenced}\n\n${documentation}`

      return { kind, contents, range: rangeOf(relativePath, info.textSpan) }
    }

    case 'completions': {
      const completions = languageService.getCompletionsAtPosition(absolute, offset, {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true
      })
      if (completions === undefined) return { kind, items: [], incomplete: false }

      const items: CompletionItem[] = []
      for (const entry of completions.entries) {
        if (items.length >= MAX_COMPLETION_ITEMS) break
        items.push({
          label: entry.name,
          kind: entry.kind,
          insertText: entry.insertText ?? entry.name,
          sortText: entry.sortText,
          source: entry.source ?? null
        })
      }

      return {
        kind,
        items,
        // True when the cap bit, or when TypeScript says so itself. Monaco
        // re-requests on the next keystroke, which is what narrows a global
        // list rather than serving a silently truncated one.
        incomplete: completions.isIncomplete === true || completions.entries.length > items.length
      }
    }

    case 'completionDetail': {
      if (request.entryName === null) return { kind, detail: null, documentation: null }

      const details = languageService.getCompletionEntryDetails(
        absolute,
        offset,
        request.entryName,
        undefined,
        request.entrySource ?? undefined,
        undefined,
        undefined
      )
      if (details === undefined) return { kind, detail: null, documentation: null }

      return {
        kind,
        detail: flatten(details.displayParts),
        documentation: flatten(details.documentation)
      }
    }

    case 'signatureHelp': {
      const help = languageService.getSignatureHelpItems(absolute, offset, undefined)
      if (help === undefined) {
        return { kind, signatures: [], activeSignature: 0, activeParameter: 0 }
      }

      const signatures = help.items.slice(0, 64).map((item) => ({
        // Reassembled from the parts TypeScript hands back, because the label
        // is what Monaco underlines the active parameter inside — it has to be
        // the exact string the parameter offsets were computed against.
        label:
          ts.displayPartsToString(item.prefixDisplayParts) +
          item.parameters
            .map((parameter) => ts.displayPartsToString(parameter.displayParts))
            .join(ts.displayPartsToString(item.separatorDisplayParts)) +
          ts.displayPartsToString(item.suffixDisplayParts),
        documentation: flatten(item.documentation),
        parameters: item.parameters.map((parameter) => ({
          label: ts.displayPartsToString(parameter.displayParts),
          documentation: flatten(parameter.documentation)
        }))
      }))

      return {
        kind,
        signatures,
        activeSignature: help.selectedItemIndex,
        activeParameter: help.argumentIndex
      }
    }
  }
}

/**
 * Answers one query, and always answers.
 *
 * A throw would otherwise be posted as a `failure`, trip the supervisor's
 * restart budget, and leave the caller's resolver pending until its timeout —
 * so a bug in one completion costs a restart and a five-second stall rather
 * than an empty list. `getCompletionsAtPosition` on a program mid-edit is
 * exactly the call that can throw.
 */
function respond(request: InteractiveQueryRequest): void {
  const root = workspaceRoot
  let result: InteractiveQueryAnswer

  try {
    result = root === null ? emptyInteractiveAnswer(request.kind) : answer(root, request)
  } catch {
    result = emptyInteractiveAnswer(request.kind)
  }

  post({ type: 'queryResult', requestId: request.requestId, result })
}

/* -------------------------------- messages -------------------------------- */

function handle(request: InteractiveRequest): void {
  switch (request.type) {
    case 'boot':
      index(request.workspaceRoot)
      return

    case 'filesChanged': {
      const root = workspaceRoot
      if (root === null) return

      for (const relativePath of request.removed) {
        known.delete(relativePath)
        bump(relativePath)
      }
      for (const relativePath of request.changed) {
        if (!SOURCE_EXTENSIONS.has(extensionOf(relativePath))) continue
        known.add(relativePath)
        bump(relativePath)
      }

      // The FILE SET changed, not just its contents, so the program's shape
      // moved and a cached service would answer about a workspace that is no
      // longer this one. Contents alone are handled by the version counter.
      if (request.removed.length > 0) service = null
      return
    }

    case 'openDocument': {
      const existing = overlays.get(request.relativePath)
      // Monaco's version id only ever increases, so an overlay that arrives out
      // of order is stale and must not overwrite a newer buffer.
      if (existing !== undefined && existing.version > request.version) return
      overlays.set(request.relativePath, {
        content: request.content,
        version: request.version
      })
      // A file that was not in the walk is new to the program, so the service
      // has to be rebuilt around it rather than told its version moved.
      if (!known.has(request.relativePath)) {
        known.add(request.relativePath)
        service = null
      }
      return
    }

    case 'closeDocument':
      if (!overlays.delete(request.relativePath)) return
      // Back to disk, which may differ from the buffer just discarded.
      bump(request.relativePath)
      return

    case 'query':
      // The buffer rides on the request, because these are answered AT a
      // keystroke: the 300ms debounce that keeps `openDocument` affordable
      // would make every one of these describe the file as it was several
      // characters ago.
      if (request.overlay !== null) {
        handle({
          type: 'openDocument',
          relativePath: request.relativePath,
          content: request.overlay.content,
          version: request.overlay.version
        })
      }
      respond(request)
      return

    case 'ping':
      post({ type: 'pong', nonce: request.nonce, heapUsedMb: heapUsedMb() })
      return
  }
}

port?.on('message', (raw: unknown) => {
  if (!isInteractiveRequest(raw)) return
  try {
    handle(raw)
  } catch (error) {
    post({
      type: 'failure',
      detail: error instanceof Error ? error.message : 'the interactive daemon failed'
    })
  }
})

post({ type: 'ready' })
