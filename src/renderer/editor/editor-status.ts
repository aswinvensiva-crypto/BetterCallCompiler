import type * as monacoNs from 'monaco-editor'
import { activeDocument, onDocumentsChanged, type OpenDocument } from './models'
import { languageForFile } from './language-id'
import { compile } from '../views/substrate/compile'
import { errorCountFor, onProblemsChanged } from '../views/problems'
import { setEditorStatus, type EditorStatus } from '../workbench/status-bar'

/**
 * Feeds the status bar from the editor: the file, the caret, the language, and
 * what the compiler made of it.
 *
 * A `.bcc` file is compiled here, through the same pipeline Substrate runs, so
 * the verdict says what the compiler says — `✓ verified` means every stage ran
 * and the SSA verifier passed, not merely that nothing was underlined. It is a
 * few milliseconds, and it is held behind a debounce while typing. Any other
 * file reads its error count from the Problems store, which the daemons feed.
 */

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  bcc: 'BCC',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  python: 'Python',
  cpp: 'C++',
  csharp: 'C#',
  plaintext: 'Plain Text',
  yaml: 'YAML',
  sql: 'SQL'
}

function displayName(languageId: string): string {
  return DISPLAY_NAMES[languageId] ?? languageId.charAt(0).toUpperCase() + languageId.slice(1)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** A compiled `.bcc` file's verdict and counts, for one model version. */
interface BccSummary {
  readonly model: monacoNs.editor.ITextModel
  readonly version: number
  readonly verdict: EditorStatus['verdict']
  readonly counts: string
}

function summarise(doc: OpenDocument): BccSummary {
  const r = compile(doc.model.getValue())
  const errors = r.diagnostics.length
  const verdict: EditorStatus['verdict'] =
    errors > 0
      ? { state: 'fail', text: `✗ ${plural(errors, 'error')}` }
      : r.violations.length > 0
        ? { state: 'fail', text: `✗ ${plural(r.violations.length, 'IR violation')}` }
        : { state: 'pass', text: '✓ verified' }
  return {
    model: doc.model,
    version: doc.model.getVersionId(),
    verdict,
    counts: `${r.tokens.length} tokens · ${r.ast.length} nodes`
  }
}

export function attachEditorStatus(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  let summary: BccSummary | null = null
  let timer: number | null = null

  const paint = (): void => {
    const doc = activeDocument()
    const position = editor.getPosition()
    if (doc === null || editor.getModel() !== doc.model || position === null) {
      setEditorStatus(null)
      return
    }

    const languageId = languageForFile(doc.node.name)
    let verdict: EditorStatus['verdict']
    let counts: string | null = null
    if (languageId === 'bcc') {
      // Compiled on demand the first time a file is shown; after that an edit
      // goes through the debounce and the last verdict stands until it lands.
      if (summary === null || summary.model !== doc.model) summary = summarise(doc)
      verdict = summary.verdict
      counts = summary.counts
    } else {
      const errors = errorCountFor(doc.node.relativePath)
      verdict = errors > 0 ? { state: 'fail', text: `✗ ${plural(errors, 'error')}` } : { state: 'pass', text: '✓ no errors' }
    }

    setEditorStatus({
      path: doc.node.relativePath.replace(/\\/g, '/'),
      line: position.lineNumber,
      column: position.column,
      language: displayName(languageId),
      verdict,
      counts
    })
  }

  const recompileSoon = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      const doc = activeDocument()
      if (doc !== null && languageForFile(doc.node.name) === 'bcc' && summary?.version !== doc.model.getVersionId()) {
        summary = summarise(doc)
      }
      paint()
    }, 250)
  }

  editor.onDidChangeCursorPosition(paint)
  editor.onDidChangeModelContent(recompileSoon)
  onDocumentsChanged(paint)
  onProblemsChanged(paint)
  paint()
}
