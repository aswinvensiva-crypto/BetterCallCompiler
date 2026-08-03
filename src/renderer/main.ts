/**
 * Renderer entry point.
 *
 * Step 1 renders the static workbench shell. Later steps replace each region's
 * placeholder with a real view; nothing here may reach for Node or the network
 * — the renderer's only privileged path is `window.betterCallCompiler`.
 */

import type * as monacoNs from 'monaco-editor'
import type { BetterCallCompilerApi } from '../shared/ipc-contract'
import type { FileNode } from '../shared/types'
import { mountExplorer, OPEN_FILE_EVENT } from './views/explorer'
import { createEditor } from './editor/monaco-setup'
import { attachEditor, activeDocument, openFile, reloadFromDisk, saveActive } from './editor/models'
import { mountTabs } from './editor/tabs'
import { notifyError } from './workbench/notifications'
import { mountPanel, showOutput } from './workbench/panel'
import { mountStatusBar } from './workbench/status-bar'
import { runActiveFile } from './views/run'
import { mountActivityBar, setSelected } from './workbench/activity-bar'
import { mountSideBar, registerSideBarView, showSideBarView } from './workbench/side-bar'
import { clearDiffSelection, mountScm, onScmShown } from './views/scm'
import { mountInsights, onInsightsShown } from './views/insights'
import { mountSettings, onSettingsShown } from './views/settings'
import { listenForAiActions, mountAi, onAiShown } from './views/ai'
import { registerAiActions } from './editor/ai-actions'
import {
  listenForAssistActions,
  mountAssist,
  onAssistShown,
  setAssistViewActivator
} from './views/assist'
import { registerAssistActions } from './editor/assist-popup'
import {
  mountTopography,
  onTopographyShown,
  renderTopography,
  setTopographyRevealHandler
} from './views/topography'
import { findEnclosingSymbol } from './editor/code-context'
import { mountSearch, onSearchShown, setSearchQuery } from './views/search'
import { openCommandPalette, registerCommands } from './workbench/command-palette'
import { openQuickOpen, watchForFileChanges } from './workbench/quick-open'
import { isQuickPickOpen } from './workbench/quick-pick'
import { openFolderCommand } from './views/explorer'
import { rescanToolchains } from './workbench/status-bar'
import { cancelActiveRun, isRunning } from './views/run'
import { showPanelView } from './workbench/panel'
import { mountDiffEditor } from './editor/diff'

declare global {
  interface Window {
    /** The only privileged surface in the renderer. Installed by the preload. */
    readonly betterCallCompiler: BetterCallCompilerApi
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function requireEl<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`workbench region #${id} is missing from index.html`)
  return found as T
}

function renderEditorPlaceholder(host: HTMLElement): void {
  const wrap = el('div', 'editor-placeholder')
  wrap.id = 'editor-placeholder'
  wrap.append(el('div', 'editor-placeholder__mark', 'BetterCallCompiler'))
  wrap.append(
    el('p', 'editor-placeholder__hint', 'Select a file in the explorer to start editing.')
  )
  host.append(wrap)
}

/**
 * Mounts Monaco and connects it to the explorer, the tab bar and the watcher.
 *
 * The editor is created once and has its *model* swapped per file, rather than
 * being torn down and rebuilt — that is what preserves undo history and view
 * state across tab switches.
 */
function mountEditor(editorHost: HTMLElement, tabBar: HTMLElement): void {
  const surface = el('div', 'editor-surface')
  surface.id = 'editor-surface'
  editorHost.append(surface)

  const editor = createEditor(surface)
  attachEditor(editor)
  mountTabs(tabBar)

  // The diff surface sits on top of the editor in the same region rather than
  // becoming a tab: a diff is a transient comparison the user dismisses, not a
  // document they keep open and switch between.
  mountDiffEditor(editorHost, clearDiffSelection)

  // Explain / Find bugs / Improve, on the context menu and Ctrl+K. Enabled only
  // when there is a selection — `precondition` in ai-actions.ts.
  registerAiActions(editor)

  // Assist is a separate feature with its own event, its own context-menu group
  // and no shared state with the AI actions above.
  registerAssistActions(editor)

  // Visualizer: a live topography of whatever the cursor is in.
  setTopographyRevealHandler((line) => {
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
  })
  registerTopographyFeed(editor)

  const placeholder = document.getElementById('editor-placeholder')
  const syncPlaceholder = (): void => {
    const hasDocument = activeDocument() !== null
    if (placeholder !== null) placeholder.hidden = hasDocument
    surface.hidden = !hasDocument
  }
  syncPlaceholder()

  document.addEventListener(OPEN_FILE_EVENT, (event) => {
    const node = (event as CustomEvent<FileNode>).detail
    void openFile(node).then(syncPlaceholder)
  })

  // Monaco owns Ctrl+S while focused; the document listener covers the case
  // where focus is in the explorer or the tab bar.
  editor.addAction({
    id: 'bettercallcompiler.saveFile',
    label: 'Save File',
    keybindings: [2048 /* CtrlCmd */ | 49 /* KeyS */],
    run: () => {
      void saveActive()
    }
  })

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveActive().then((saved) => {
        if (!saved) notifyError('Could not save the file.')
      })
    }
  })

  // Ctrl+F5 — VS Code's "Run Without Debugging". Plain F5 is deliberately left
  // alone: it means "start debugging", and there is no debugger until M2.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'F5' || !event.ctrlKey) return
    event.preventDefault()
    void saveThenRun()
  })

  // A file changed on disk (git checkout, another editor) is reloaded only when
  // our buffer is clean — never clobbering unsaved work.
  window.betterCallCompiler.fs.onWatchEvent((watchEvent) => {
    if (watchEvent.type === 'change') void reloadFromDisk(watchEvent.path)
  })

  const observer = new MutationObserver(syncPlaceholder)
  observer.observe(tabBar, { childList: true })
}

/**
 * Feeds the Visualizer from the editor selection.
 *
 * Debounced at 300ms because this parses on every cursor move, and the cost is
 * a full Babel parse plus a Mermaid render. With a live selection the selected
 * text is diagrammed; without one it falls back to the enclosing function, so
 * simply putting the caret in a function shows its shape — which is the common
 * case and requires no selecting at all.
 */
function registerTopographyFeed(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  let timer: number | null = null

  const update = (): void => {
    const model = editor.getModel()
    const selection = editor.getSelection()
    if (model === null || selection === null) return

    if (!selection.isEmpty()) {
      void renderTopography(model.getValueInRange(selection), selection.startLineNumber)
      return
    }

    // `findEnclosingSymbol` is imported from code-context.ts and not modified —
    // the same reuse the Assist feature makes of it. It reports a line range
    // rather than text, so the source comes back out of the model.
    const enclosing = findEnclosingSymbol(
      model.getValue(),
      model.getLanguageId(),
      selection.startLineNumber
    )
    if (enclosing === null) return

    const text = model.getValueInRange({
      startLineNumber: enclosing.startLine,
      startColumn: 1,
      endLineNumber: enclosing.endLine,
      endColumn: model.getLineMaxColumn(enclosing.endLine)
    })
    void renderTopography(text, enclosing.startLine)
  }

  editor.onDidChangeCursorSelection(() => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(update, 300)
  })
}

/**
 * Saves first, then runs. Running the file the user is looking at while the
 * on-disk copy is a version behind is the single most confusing thing a run
 * button can do.
 */
async function saveThenRun(): Promise<void> {
  await saveActive()
  await showOutput()
  await runActiveFile()
}

/**
 * Mounts the status bar, then proves the whole boundary works by calling
 * `app:ping` — preload bridge, zod-validated request, main handler, and a
 * `Result` all the way back.
 */
async function renderStatusBar(host: HTMLElement): Promise<void> {
  const statusBar = mountStatusBar(host)

  const result = await window.betterCallCompiler.app.ping({})

  if (result.ok) {
    statusBar.setBridge(`Bridge connected · Electron ${result.value.electron}`, 'ok')
    statusBar.setBuild(`BetterCallCompiler ${result.value.version} · ${result.value.platform}`)
  } else {
    statusBar.setBridge(`Bridge error: ${result.error.code}`, 'error')
  }
}

/**
 * Registers every side-bar view and wires the activity bar to them.
 *
 * Views are registered eagerly but *mounted* lazily on first show, so opening
 * the app does not shell out to git or reach for the network.
 */
async function mountSideBarViews(): Promise<void> {
  mountSideBar(requireEl('side-bar-title'), requireEl('side-bar-body'))

  registerSideBarView({ id: 'explorer', mount: mountExplorer })
  registerSideBarView({ id: 'search', mount: mountSearch, onShow: onSearchShown })
  registerSideBarView({ id: 'scm', mount: mountScm, onShow: onScmShown })
  registerSideBarView({ id: 'insights', mount: mountInsights, onShow: onInsightsShown })
  registerSideBarView({ id: 'settings', mount: mountSettings, onShow: onSettingsShown })
  registerSideBarView({ id: 'ai', mount: mountAi, onShow: onAiShown })
  registerSideBarView({ id: 'assist', mount: mountAssist, onShow: onAssistShown })
  registerSideBarView({ id: 'visualizer', mount: mountTopography, onShow: onTopographyShown })

  mountActivityBar(requireEl('activity-bar'), (id) => {
    // The Run icon opens the output console rather than a side-bar view.
    if (id === 'run') void showOutput()
  })

  // Assist results surface in its panel the way AI answers surface in theirs.
  listenForAssistActions()
  setAssistViewActivator(() => {
    setSelected('assist')
    return showSideBarView('assist')
  })

  await showSideBarView('explorer')
}

/**
 * Every command the palette offers.
 *
 * Registered centrally rather than by each view because the views mount
 * lazily — a command that only exists once you have visited its view is a
 * command the palette cannot be used to reach it by.
 */
function registerWorkbenchCommands(): void {
  const showView = (id: string) => () => {
    setSelected(id)
    void showSideBarView(id)
  }

  registerCommands([
    { id: 'file.openFolder', title: 'File: Open Folder…', run: () => void openFolderCommand() },
    {
      id: 'file.save',
      title: 'File: Save',
      keybinding: 'Ctrl+S',
      when: () => activeDocument() !== null,
      run: () => void saveActive()
    },
    { id: 'file.quickOpen', title: 'Go to File…', keybinding: 'Ctrl+P', run: () => void openQuickOpen() },

    { id: 'view.explorer', title: 'View: Explorer', run: showView('explorer') },
    { id: 'view.search', title: 'View: Search', keybinding: 'Ctrl+Shift+F', run: showView('search') },
    { id: 'view.scm', title: 'View: Source Control', run: showView('scm') },
    { id: 'view.insights', title: 'View: Insights', run: showView('insights') },
    { id: 'view.ai', title: 'View: Assistant', run: showView('ai') },
    { id: 'view.settings', title: 'View: Settings', run: showView('settings') },

    {
      id: 'view.terminal',
      title: 'View: Toggle Terminal',
      keybinding: 'Ctrl+`',
      run: () => void showPanelView('terminal')
    },
    { id: 'view.output', title: 'View: Output', run: () => void showOutput() },

    {
      id: 'run.file',
      title: 'Run: Run Active File',
      keybinding: 'Ctrl+F5',
      when: () => activeDocument() !== null,
      run: () => void saveThenRun()
    },
    {
      id: 'run.cancel',
      title: 'Run: Cancel',
      when: () => isRunning(),
      run: () => void cancelActiveRun()
    },

    { id: 'toolchains.rescan', title: 'Toolchains: Rescan', run: () => void rescanToolchains() }
  ])
}

/**
 * Workbench-level keys.
 *
 * All bound in the capture phase and all no-ops while a quick pick is open, so
 * the picker owns the keyboard for as long as it is showing rather than having
 * Ctrl+P reopen it underneath itself.
 */
function bindGlobalKeys(): void {
  document.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (isQuickPickOpen()) return

      const key = event.key.toLowerCase()

      if (event.shiftKey && key === 'p') {
        event.preventDefault()
        openCommandPalette()
        return
      }
      if (!event.shiftKey && key === 'p') {
        event.preventDefault()
        void openQuickOpen()
        return
      }
      if (event.shiftKey && key === 'f') {
        event.preventDefault()
        // Seed from the editor selection, which is what makes this feel like
        // "search for what I am looking at" rather than an empty box.
        const doc = activeDocument()
        const selected = doc?.model.getValueInRange(
          // A multi-line selection is a poor query; take the first line only.
          doc.model.getFullModelRange()
        )
        setSelected('search')
        void showSideBarView('search').then(() => {
          const fromEditor = window.getSelection()?.toString() ?? ''
          if (fromEditor.trim() !== '' && !fromEditor.includes('\n')) setSearchQuery(fromEditor)
          else if (selected === undefined) setSearchQuery('')
        })
      }
    },
    true
  )
}

async function boot(): Promise<void> {
  renderEditorPlaceholder(requireEl('editor-host'))
  await renderStatusBar(requireEl('status-bar'))

  mountEditor(requireEl('editor-host'), requireEl('tab-bar'))
  mountPanel(requireEl('panel'), requireEl('panel-tabs'), requireEl('panel-body'))
  await mountSideBarViews()
  listenForAiActions()
  registerWorkbenchCommands()
  bindGlobalKeys()
  watchForFileChanges()

  // Readiness marker. The workbench regions are static markup, so their mere
  // presence says nothing about whether the renderer has booted — a test that
  // waits on `#workbench` can fire input before any listener is attached.
  // This flips only once every view is mounted.
  document.documentElement.dataset['bettercallcompilerReady'] = 'true'
}

void boot()

export {}
