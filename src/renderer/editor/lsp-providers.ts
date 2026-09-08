import type * as monacoNs from 'monaco-editor'
import { documentUri, relativePathFromUri, rememberAbsolutePath } from './document-uri'
import { LSP_SERVERS } from '../../shared/lsp-registry'
import type { LanguageLocation, SourceRange } from '../../shared/types'

/**
 * Go to definition, find references and hover for languages served by an
 * external language server — `lsp-registry.ts`'s table — rather than by one
 * of the daemons `navigation-providers.ts` already covers.
 *
 * A separate file rather than a third block in that one: these three answer
 * from a fundamentally different backend (a real process this app did not
 * write, reached over `window.betterCallCompiler.lsp`), and folding the two
 * together would make `PROGRAM_LANGUAGES` there ambiguous about which API a
 * given language actually uses.
 *
 * No rename, no document symbols, no completions: `lsp-service.ts` does not
 * expose them yet, and a provider that always answers empty is worse than one
 * that was never registered — Monaco would offer "Rename Symbol" for a
 * language that can never actually do it.
 */

const LSP_LANGUAGES = LSP_SERVERS.flatMap((server) => server.languageIds)

let registered = false

/** The workspace-relative path for a model, or null when this app does not own it. */
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

/** A wire location as a Monaco one, recording the absolute path on the way past. */
function toMonacoLocation(ns: typeof monacoNs, location: LanguageLocation): monacoNs.languages.Location {
  rememberAbsolutePath(location.relativePath, location.path)
  return {
    uri: documentUri(ns, location.relativePath),
    range: toMonacoRange(location.range)
  }
}

export function registerLspProviders(ns: typeof monacoNs): void {
  if (registered) return
  registered = true

  const api = window.betterCallCompiler.lsp

  ns.languages.registerDefinitionProvider(LSP_LANGUAGES, {
    async provideDefinition(model, position) {
      const relativePath = pathOf(model)
      if (relativePath === null) return null

      const result = await api.definition({
        relativePath,
        line: position.lineNumber,
        column: position.column
      })
      if (!result.ok) return null

      return result.value.locations.map((location) => toMonacoLocation(ns, location))
    }
  })

  ns.languages.registerReferenceProvider(LSP_LANGUAGES, {
    async provideReferences(model, position, context) {
      const relativePath = pathOf(model)
      if (relativePath === null) return null

      const result = await api.references({
        relativePath,
        line: position.lineNumber,
        column: position.column
      })
      if (!result.ok) return null

      // The server always includes the declaration — `lsp-client.ts` asks for
      // it unconditionally, the same choice `compiler:references` makes,
      // because a rename would need it. Monaco decides whether to keep it.
      const locations = context.includeDeclaration
        ? result.value.locations
        : result.value.locations.slice(1)

      return locations.map((location) => toMonacoLocation(ns, location))
    }
  })

  ns.languages.registerHoverProvider(LSP_LANGUAGES, {
    async provideHover(model, position) {
      const relativePath = pathOf(model)
      if (relativePath === null) return null

      const result = await api.hover({
        relativePath,
        line: position.lineNumber,
        column: position.column
      })
      if (!result.ok || result.value.contents === null) return null

      // No range: the LSP boundary does not carry one back — see
      // `lspHoverResultSchema`. Monaco is content with a hover that has none.
      return { contents: [{ value: result.value.contents }] }
    }
  })
}
