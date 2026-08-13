import type * as monacoNs from 'monaco-editor'
import { activeDocument } from './models'
import { collectImports, findEnclosingSymbol } from './code-context'
import type { AiContext, AiMode, AiSelection } from '../../shared/types'

/**
 * Editor integration for the three AI actions.
 *
 * Context assembly happens in the renderer because this is where the document
 * lives; the pure part of it is in `code-context.ts` so it can be tested
 * without a running editor. Main renders whatever it is given, verbatim.
 */

const MODE_LABELS: Readonly<Record<AiMode, string>> = {
  explain: 'Explain',
  'find-bugs': 'Find Bugs',
  improve: 'Improve'
}

/** Fired when the user invokes an AI action. The AI view listens. */
export const AI_ACTION_EVENT = 'bettercallcompiler:ai-action'

export interface AiActionDetail {
  readonly mode: AiMode
  readonly context: AiContext
}

/**
 * Fired when the user asks for an Explain ARTIFACT. The Artifacts view listens.
 *
 * A separate event from `AI_ACTION_EVENT` rather than a fourth mode on it. The
 * two produce different things — one a streamed answer in a panel, the other a
 * stored document — and they are consumed by different views. Folding them
 * together would mean every listener of the AI event had to learn to ignore a
 * mode it cannot render.
 */
export const EXPLAIN_ARTIFACT_EVENT = 'bettercallcompiler:explain-artifact'

export interface ExplainArtifactDetail {
  readonly context: AiContext
}

/** A whole 800-line class is not context, it is noise around the selection. */
const MAX_SYMBOL_CHARS = 4000

function toSelection(
  model: monacoNs.editor.ITextModel,
  selection: monacoNs.Selection
): AiSelection {
  return {
    text: model.getValueInRange(selection),
    startLine: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLine: selection.endLineNumber,
    endColumn: selection.endColumn
  }
}

/** Assembles everything the model will be told, or null when nothing is selected. */
export function buildContext(
  editor: monacoNs.editor.IStandaloneCodeEditor
): AiContext | null {
  const doc = activeDocument()
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (doc === null || model === null || selection === null || selection.isEmpty()) return null

  const source = model.getValue()
  const languageId = model.getLanguageId()

  const symbol = findEnclosingSymbol(source, languageId, selection.startLineNumber)
  const symbolText =
    symbol === null
      ? null
      : source
          .split('\n')
          .slice(symbol.startLine - 1, symbol.endLine)
          .join('\n')

  return {
    filePath: doc.node.path,
    relativePath: doc.node.relativePath,
    languageId,
    selection: toSelection(model, selection),
    enclosingSymbol:
      symbol === null || symbolText === null
        ? null
        : {
            name: symbol.name,
            kind: symbol.kind,
            text:
              symbolText.length > MAX_SYMBOL_CHARS
                ? `${symbolText.slice(0, MAX_SYMBOL_CHARS)}\n… truncated`
                : symbolText
          },
    imports: collectImports(source, languageId)
  }
}

/**
 * Registers the three actions on the editor.
 *
 * `precondition: 'editorHasSelection'` is what greys them out in the context
 * menu when nothing is selected, rather than letting the user pick one and get
 * a shrug. Ctrl+K opens the assistant with Explain, the most common entry
 * point; all three are on the context menu.
 */
export function registerAiActions(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  const dispatch = (mode: AiMode): void => {
    const context = buildContext(editor)
    if (context === null) return
    document.dispatchEvent(
      new CustomEvent<AiActionDetail>(AI_ACTION_EVENT, { detail: { mode, context } })
    )
  }

  const modes: readonly AiMode[] = ['explain', 'find-bugs', 'improve']
  modes.forEach((mode, index) => {
    editor.addAction({
      id: `bettercallcompiler.ai.${mode}`,
      label: `BetterCallCompiler: ${MODE_LABELS[mode]}`,
      contextMenuGroupId: 'bettercallcompiler-ai',
      contextMenuOrder: index,
      precondition: 'editorHasSelection',
      run: () => dispatch(mode)
    })
  })

  /**
   * The artifact action, alongside the three rather than replacing one.
   *
   * Ctrl+K deliberately still opens the streamed panel. That binding is what
   * people already reach for when they want a quick answer they will dismiss,
   * and quietly repointing it at something that writes a file into the
   * workspace would be a surprise. Producing a durable record is a deliberate
   * act and gets a deliberate gesture.
   */
  editor.addAction({
    id: 'bettercallcompiler.explain.artifact',
    label: 'BetterCallCompiler: Explain as Artifact',
    contextMenuGroupId: 'bettercallcompiler-ai',
    contextMenuOrder: modes.length,
    precondition: 'editorHasSelection',
    run: () => {
      const context = buildContext(editor)
      if (context === null) return
      document.dispatchEvent(
        new CustomEvent<ExplainArtifactDetail>(EXPLAIN_ARTIFACT_EVENT, { detail: { context } })
      )
    }
  })

  /**
   * Ctrl+K is intercepted before Monaco sees it, rather than declared as a
   * keybinding on the action.
   *
   * Monaco ships chords that *start* with Ctrl+K — Ctrl+K Ctrl+C to comment and
   * friends — and its resolver treats a bare Ctrl+K as the beginning of one. A
   * plain `keybindings: [CtrlCmd | KeyK]` on the action therefore never fires:
   * the editor waits for a second keystroke that means nothing to us. Measured,
   * not assumed — with the editor focused and text selected, the action's own
   * binding produced no event at all, and `addKeybindingRule` did not change
   * that.
   *
   * A capture-phase listener on `document` runs before the editor's own handler
   * because the editor is a descendant. The keystroke is only swallowed when
   * there is actually a selection to act on, so with none the chords keep
   * working exactly as they did.
   */
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() !== 'k') return
      if (!editor.hasTextFocus()) return

      const context = buildContext(editor)
      if (context === null) return

      event.preventDefault()
      event.stopPropagation()
      document.dispatchEvent(
        new CustomEvent<AiActionDetail>(AI_ACTION_EVENT, { detail: { mode: 'explain', context } })
      )
    },
    true
  )
}
