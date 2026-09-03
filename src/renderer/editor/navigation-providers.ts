import type * as monacoNs from 'monaco-editor'
import { documentUri, relativePathFromUri, rememberAbsolutePath } from './document-uri'
import type { DocumentSymbolNode, LanguageLocation, SourceRange } from '../../shared/types'

/**
 * Go to definition, find references, rename, outline and hover — answered by
 * the daemon.
 *
 * ## The rule this file implements
 *
 * Anything answerable from one model's syntax stays in the renderer; anything
 * needing the whole program crosses to the daemon. Definition, references and
 * rename need the program, so they are here. They are also USER-INVOKED — F12,
 * Shift+F12, F2 — so an IPC round trip is a latency nobody can feel, which is
 * exactly what makes them the cheapest correct thing to build first.
 *
 * Hover and the outline are registered here for `.bcc` for a different reason:
 * Monaco has no worker for a language it learned about at runtime, so there is
 * no renderer-side answer to prefer. For TypeScript both stay with Monaco's own
 * worker, which is single-file, syntactic and instant — see
 * `configureLanguageDefaults`.
 *
 * ## Freshness
 *
 * Every request carries the buffer. `pushOverlay` debounces 300ms, so for up to
 * 300ms after a keystroke the daemon's copy of a file is behind what the user
 * is looking at — and a rename computed against stale text rewrites the wrong
 * bytes. Reading `getValue()` at request time and sending it along removes the
 * race outright, and costs one string on a user-invoked action.
 *
 * ## Never reject
 *
 * A provider that rejects is logged by Monaco as an error and shows the user
 * nothing different from an empty answer, so every path here resolves. A daemon
 * that is down, a file Monaco owns that this app did not create, a query that
 * timed out: all of them are "no result".
 */

const BCC = 'bcc'

/**
 * The languages the daemon answers definition and references for.
 *
 * BCC because nothing else can. TypeScript and JavaScript because the daemon's
 * answer is a different and better answer: Monaco's bundled worker has no
 * tsconfig and no module resolution, so its go-to-definition cannot leave the
 * file you are looking at. `configureLanguageDefaults` switches its own
 * `definitions` and `references` off in the same change, because two providers
 * both answering would have Monaco merge the lists and turn a clean jump into
 * a peek showing the same line twice.
 */
const PROGRAM_LANGUAGES = [BCC, 'typescript', 'javascript']

let registered = false

/** The buffer, read at request time rather than whenever the debounce last fired. */
function overlayOf(model: monacoNs.editor.ITextModel): {
  content: string
  version: number
} {
  return { content: model.getValue(), version: model.getVersionId() }
}

/**
 * The workspace-relative path for a model, or null when this app does not own it.
 *
 * Monaco creates models of its own — the diff widget's, `inmemory:` scratch
 * buffers — and a provider registered by language matches those too. Asking the
 * daemon about a file that has never existed is harmless but pointless, and the
 * null is what keeps it from happening.
 */
function pathOf(model: monacoNs.editor.ITextModel): string | null {
  return relativePathFromUri(model.uri)
}

function toMonacoRange(range: SourceRange): monacoNs.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn
  }
}

/**
 * A wire location as a Monaco one, recording the absolute path on the way past.
 *
 * That side effect is the whole reason this is a function rather than an inline
 * map. A definition in a file the user has never opened is exactly the case
 * that justifies asking the daemon, and the editor opener that has to open it
 * is handed a URI and nothing else — so the absolute path has to be captured
 * here, where it is still in hand.
 */
function toMonacoLocation(
  ns: typeof monacoNs,
  location: LanguageLocation
): monacoNs.languages.Location {
  rememberAbsolutePath(location.relativePath, location.path)
  return {
    uri: documentUri(ns, location.relativePath),
    range: toMonacoRange(location.range)
  }
}

export function registerNavigationProviders(ns: typeof monacoNs): void {
  if (registered) return
  registered = true

  const api = window.betterCallCompiler.compiler

  /* ------------------------------ definition ----------------------------- */

  ns.languages.registerDefinitionProvider(PROGRAM_LANGUAGES, {
    async provideDefinition(model, position) {
      const relativePath = pathOf(model)
      if (relativePath === null) return null

      const result = await api.definition({
        relativePath,
        offset: model.getOffsetAt(position),
        overlay: overlayOf(model)
      })
      if (!result.ok) return null

      return result.value.locations.map((location) => toMonacoLocation(ns, location))
    }
  })

  /* ------------------------------ references ----------------------------- */

  ns.languages.registerReferenceProvider(PROGRAM_LANGUAGES, {
    async provideReferences(model, position, context) {
      const relativePath = pathOf(model)
      if (relativePath === null) return null

      const result = await api.references({
        relativePath,
        offset: model.getOffsetAt(position),
        overlay: overlayOf(model)
      })
      if (!result.ok) return null

      // The daemon always includes the declaration, because a rename needs it.
      // Monaco asks whether to show it, and dropping it here rather than asking
      // the daemon for a different answer keeps one query serving both.
      const locations = context.includeDeclaration
        ? result.value.locations
        : result.value.locations.slice(1)

      return locations.map((location) => toMonacoLocation(ns, location))
    }
  })

  /* -------------------------------- rename ------------------------------- */

  ns.languages.registerRenameProvider(BCC, {
    /**
     * Where to draw the inline box when F2 is pressed.
     *
     * Asked BEFORE the new name exists, which is why the rename channel accepts
     * `newName: null`. Rejecting here is the one place a rejection is right:
     * Monaco renders `rejectReason` to the user, so "there is nothing to rename
     * here" reaches them instead of the box opening over a semicolon.
     */
    async resolveRenameLocation(model, position) {
      // Monaco types this as `RenameLocation & Rejection` — an intersection, not
      // a union — so a rejection still has to carry a range and a text. Its
      // rename controller reads `rejectReason` first and ignores the rest, so a
      // zero-width range at the cursor is the honest filler.
      const reject = (reason: string): monacoNs.languages.RenameLocation &
        monacoNs.languages.Rejection => ({
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        },
        text: '',
        rejectReason: reason
      })

      const nothing = 'There is nothing to rename here.'
      const relativePath = pathOf(model)
      if (relativePath === null) return reject(nothing)

      const result = await api.rename({
        relativePath,
        offset: model.getOffsetAt(position),
        newName: null,
        overlay: overlayOf(model)
      })
      if (!result.ok) return reject(result.error.message)

      const { target, placeholder, error } = result.value
      if (target === null || placeholder === null) return reject(error ?? nothing)
      return { range: toMonacoRange(target), text: placeholder }
    },

    async provideRenameEdits(model, position, newName) {
      const relativePath = pathOf(model)
      if (relativePath === null) return { edits: [] }

      const result = await api.rename({
        relativePath,
        offset: model.getOffsetAt(position),
        newName,
        overlay: overlayOf(model)
      })
      if (!result.ok) return { edits: [], rejectReason: result.error.message }
      if (result.value.error !== null) {
        return { edits: [], rejectReason: result.value.error }
      }

      // Safe to hand Monaco a bulk edit here because BCC has no imports, so a
      // rename is always confined to one file and that file is the one on
      // screen. A bulk edit spanning CLOSED files would make Monaco create
      // models with no lifecycle owner — exactly the leak `closeSyntaxDocument`
      // exists to prevent — and A4 routes those through main instead.
      return {
        edits: result.value.files.flatMap((file) =>
          file.edits.map((edit) => ({
            resource: documentUri(ns, file.relativePath),
            versionId: undefined,
            textEdit: { range: toMonacoRange(edit.range), text: edit.newText }
          }))
        )
      }
    }
  })

  /* ---------------------------- document symbols -------------------------- */

  const SYMBOL_KINDS: Record<DocumentSymbolNode['kind'], monacoNs.languages.SymbolKind> = {
    function: ns.languages.SymbolKind.Function,
    variable: ns.languages.SymbolKind.Variable,
    parameter: ns.languages.SymbolKind.Variable
  }

  const toDocumentSymbol = (node: DocumentSymbolNode): monacoNs.languages.DocumentSymbol => ({
    name: node.name,
    detail: node.detail,
    kind: SYMBOL_KINDS[node.kind],
    tags: [],
    range: toMonacoRange(node.range),
    selectionRange: toMonacoRange(node.selectionRange),
    children: node.children.map(toDocumentSymbol)
  })

  ns.languages.registerDocumentSymbolProvider(BCC, {
    displayName: 'BCC',
    async provideDocumentSymbols(model) {
      const relativePath = pathOf(model)
      if (relativePath === null) return null

      const result = await api.documentSymbols({ relativePath, overlay: overlayOf(model) })
      return result.ok ? result.value.symbols.map(toDocumentSymbol) : null
    }
  })

  /* --------------------------------- hover -------------------------------- */

  ns.languages.registerHoverProvider(BCC, {
    async provideHover(model, position) {
      const relativePath = pathOf(model)
      if (relativePath === null) return null

      const result = await api.hover({
        relativePath,
        offset: model.getOffsetAt(position),
        overlay: overlayOf(model)
      })
      if (!result.ok || result.value.contents === null) return null

      return {
        contents: [{ value: result.value.contents }],
        range: result.value.range === null ? undefined : toMonacoRange(result.value.range)
      }
    }
  })
}
