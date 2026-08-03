import type * as monacoNs from 'monaco-editor'
import type { AssistMode, AssistSelection } from './assist-analysis'

/**
 * The floating Assist toolbar.
 *
 * Deliberately its own event name and its own context-menu group: this feature
 * shares no state, no channel and no code path with the AI assistant that also
 * lives on the editor's context menu. The only thing they have in common is the
 * registration *pattern*, copied rather than shared so neither can break the
 * other.
 */

export const ASSIST_ACTION_EVENT = 'bettercallcompiler:assist-action'

export interface AssistActionDetail {
  readonly mode: AssistMode
  readonly selection: AssistSelection
}

interface ModeButton {
  readonly mode: AssistMode
  readonly label: string
  readonly title: string
}

const MODES: readonly ModeButton[] = [
  { mode: 'learn', label: 'Learn', title: 'Explain the language constructs used here' },
  { mode: 'debug', label: 'Debug', title: 'Static findings, complexity and nesting' },
  { mode: 'explain', label: 'Explain', title: 'What this declares and what it depends on' },
  { mode: 'snippet', label: 'Snippet', title: 'Markdown block with a permalink' }
]

let popup: HTMLElement | null = null
let workspaceRoot: string | null = null

/**
 * The workspace root, needed to turn an absolute model path into the
 * repository-relative one a permalink requires. Fetched once at registration
 * rather than per action.
 */
async function ensureWorkspaceRoot(): Promise<void> {
  if (workspaceRoot !== null) return
  const result = await window.betterCallCompiler.fs.getWorkspace({})
  if (result.ok) workspaceRoot = result.value.root
}

/** Absolute model path to a POSIX, workspace-relative path. */
function toRelativePath(absolute: string): string {
  const normalised = absolute.replace(/\\/g, '/')
  if (workspaceRoot === null) return normalised
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalised.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalised.slice(root.length + 1)
    : normalised
}

export function buildAssistSelection(
  editor: monacoNs.editor.IStandaloneCodeEditor
): AssistSelection | null {
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (model === null || selection === null || selection.isEmpty()) return null

  const text = model.getValueInRange(selection)
  if (text.trim() === '') return null

  return {
    text,
    languageId: model.getLanguageId(),
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
    relativePath: toRelativePath(model.uri.path.replace(/^\//, ''))
  }
}

function dispatch(mode: AssistMode, selection: AssistSelection): void {
  document.dispatchEvent(
    new CustomEvent<AssistActionDetail>(ASSIST_ACTION_EVENT, { detail: { mode, selection } })
  )
}

export function hideAssistPopup(): void {
  popup?.remove()
  popup = null
}

/**
 * Positions the toolbar above the selection, or below it when there is no room.
 *
 * `getScrolledVisiblePosition` returns coordinates relative to the editor's own
 * container, so the popup is mounted inside that container rather than the
 * document — otherwise it drifts as soon as the editor is not at the page
 * origin, which it never is here.
 */
function showPopup(
  editor: monacoNs.editor.IStandaloneCodeEditor,
  selection: AssistSelection
): void {
  hideAssistPopup()

  const container = editor.getContainerDomNode()
  const monacoSelection = editor.getSelection()
  if (monacoSelection === null) return

  const anchor = editor.getScrolledVisiblePosition({
    lineNumber: monacoSelection.startLineNumber,
    column: monacoSelection.startColumn
  })
  if (anchor === null) return

  const element = document.createElement('div')
  element.className = 'assist-popup'
  element.setAttribute('role', 'toolbar')
  element.setAttribute('aria-label', 'Assist')

  for (const item of MODES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'assist-popup__button'
    button.textContent = item.label
    button.title = item.title
    // mousedown, not click: clicking would first move focus out of the editor
    // and collapse the selection this popup exists to act on.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      dispatch(item.mode, selection)
      hideAssistPopup()
    })
    element.append(button)
  }

  container.append(element)

  // Measure after mounting; height is unknown until the buttons are laid out.
  const height = element.offsetHeight
  const above = anchor.top - height - 6
  element.style.left = `${Math.max(4, anchor.left)}px`
  element.style.top = `${above > 0 ? above : anchor.top + anchor.height + 6}px`

  popup = element
}

/**
 * Registers the popup and the matching context-menu actions.
 *
 * The context-menu entries exist for discoverability: a floating toolbar is
 * easy to miss, and right-click is where people look for what a selection can
 * do. `precondition: 'editorHasSelection'` greys them out rather than letting
 * them fire on nothing.
 */
export function registerAssistActions(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  void ensureWorkspaceRoot()

  MODES.forEach((item, index) => {
    editor.addAction({
      id: `bettercallcompiler.assist.${item.mode}`,
      label: `Assist: ${item.label}`,
      contextMenuGroupId: 'bettercallcompiler-assist',
      contextMenuOrder: index,
      precondition: 'editorHasSelection',
      run: () => {
        const selection = buildAssistSelection(editor)
        if (selection !== null) dispatch(item.mode, selection)
      }
    })
  })

  editor.onDidChangeCursorSelection(() => {
    const selection = buildAssistSelection(editor)
    if (selection === null) {
      hideAssistPopup()
      return
    }
    showPopup(editor, selection)
  })

  // Scrolling moves the anchor out from under the popup; re-anchoring on every
  // scroll frame would fight the scroll, so it is dismissed instead.
  editor.onDidScrollChange(() => hideAssistPopup())
  editor.onDidBlurEditorWidget(() => hideAssistPopup())
}
