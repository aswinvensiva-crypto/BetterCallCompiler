/**
 * Renderer entry point.
 *
 * Step 1 renders the static workbench shell. Later steps replace each region's
 * placeholder with a real view; nothing here may reach for Node or the network
 * — the renderer's only privileged path is `window.betterCallCompiler`.
 */

import type * as monacoNs from 'monaco-editor'
import type { BetterCallCompilerApi } from '../shared/ipc-contract'
import type { FileNode, WorkbenchLayout } from '../shared/types'
import { mountExplorer, OPEN_FILE_EVENT } from './views/explorer'
import { createEditor } from './editor/monaco-setup'
import { attachEditor, activeDocument, openFile, reloadFromDisk, saveActive } from './editor/models'
import { mountTabs } from './editor/tabs'
import { notifyError } from './workbench/notifications'
import { mountPanel, showOutput, showProblems as showProblemsPanel } from './workbench/panel'
import { mountStatusBar } from './workbench/status-bar'
import { runActiveFile } from './views/run'
import { mountActivityBar, setSelected } from './workbench/activity-bar'
import { mountSideBar, registerSideBarView, showSideBarView } from './workbench/side-bar'
import {
  hideRightDock,
  isRightDockVisible,
  mountRightDock,
  registerRightDockView,
  showRightDock,
  showRightDockView
} from './workbench/right-dock'
import { mountSplitter } from './workbench/splitter'
import { clearDiffSelection, mountScm, onScmShown } from './views/scm'
import { mountInsights, onInsightsShown } from './views/insights'
import { mountSettings, onSettingsShown } from './views/settings'
import { listenForAiActions, mountAi, onAiShown } from './views/ai'
import { registerAiActions } from './editor/ai-actions'
import { applyDiagnostics, clearAllMarkers } from './editor/markers'
import {
  listenForAssistActions,
  mountAssist,
  onAssistShown,
  setAssistViewActivator
} from './views/assist'
import { registerAssistActions } from './editor/assist-popup'
import {
  currentVisualizerGraph,
  highlightVisualizerLine,
  mountVisualizer,
  onVisualizerGraphChanged,
  onVisualizerShown,
  renderVisualizer,
  renderVisualizerGraph,
  setVisualizerFloatHandler,
  setVisualizerRevealHandler
} from './views/visualizer/visualizer-panel'
import {
  mountCompilerIntelligence,
  onCompilerIntelligenceShown
} from './views/compiler-intelligence'
import {
  listenForExplainRequests,
  mountArtifacts,
  onArtifactsShown,
  setArtifactsViewActivator
} from './views/artifacts'
import {
  applyEdit as applySyntaxEdit,
  closeDocument as closeSyntaxDocument,
  flowSignatureFor,
  hasDocument as hasSyntaxDocument,
  openDocument as openSyntaxDocument,
  supportsLanguage
} from './editor/syntax-tree'
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
async function mountEditor(editorHost: HTMLElement, tabBar: HTMLElement): Promise<void> {
  const surface = el('div', 'editor-surface')
  surface.id = 'editor-surface'
  editorHost.append(surface)

  const editor = await createEditor(surface)
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

  // Visualizer: a live code graph of whatever the cursor is in.
  const revealInEditor = (line: number): void => {
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
  }
  setVisualizerRevealHandler(revealInEditor)
  // Before the Visualizer feed, deliberately: Monaco fires content listeners in
  // registration order, so the tree is current before anything reads it.
  registerSyntaxFeed(editor)
  registerVisualizerFeed(editor)
  // A detached diagram reveals through the same function, so a click means the
  // same thing whichever window it happened in.
  connectFloatingVisualizer(revealInEditor)

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
 * Feeds the Visualizer from the editor.
 *
 * Two paths, because the panel has two costs. Moving the caret inside a graph
 * that is already drawn only changes which node is highlighted, so it is sent
 * straight through — waiting 300ms to move a highlight makes the panel feel
 * detached from the editor. Changing the *input* to the graph — a new selection,
 * an edit, a different file — costs a full Babel parse and a repaint, so it
 * stays behind the debounce.
 *
 * `rebuildKey` is the second half of that split and matters as much as the
 * timer: the caret changing does not change what the expensive path would
 * consume, so the debounce would otherwise still reparse the whole file every
 * time it settles. Comparing the inputs means a bare cursor move costs nothing
 * at all.
 *
 * With no selection the whole file is graphed and the enclosing node is
 * highlighted from the caret's line. That replaces the old regex
 * `findEnclosingSymbol` fallback outright and is strictly better here: the same
 * caret shows the function *in the context of everything it calls*, and it is
 * the graph's own locations doing the enclosing rather than a brace count.
 */
function registerVisualizerFeed(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  let timer: number | null = null
  let rebuildKey = ''
  let flowSignature: string | null = null

  const rebuild = (): void => {
    const model = editor.getModel()
    const selection = editor.getSelection()
    if (model === null || selection === null) return

    // The version id covers every edit and the range covers every selection. The
    // uri is in there because two different files can perfectly well be sitting
    // on the same version number.
    const buffer = `${model.uri.toString()} ${model.getVersionId()}`
    const range =
      `${selection.startLineNumber}:${selection.startColumn}` +
      `-${selection.endLineNumber}:${selection.endColumn}`
    const key = selection.isEmpty() ? `file ${buffer}` : `sel ${buffer} ${range}`
    if (key === rebuildKey) return
    const previousKey = rebuildKey
    rebuildKey = key

    /**
     * Early cutoff, from the tree-sitter tree.
     *
     * The version-id guard above only catches a bare cursor move. Every actual
     * EDIT changes the version, so until now every keystroke paid for a full
     * Babel parse of the file plus a complete graph rebuild — and most
     * keystrokes cannot change the diagram at all. Renaming a local, editing a
     * string, changing an operand: identical control flow, identical graph.
     *
     * `controlFlowSignature` is the same trick `moduleSignature` plays in the
     * daemon, one layer up. When it has not moved, there is nothing to draw.
     *
     * Only for whole-file mode: with a selection the graphed text is a slice,
     * and a signature of the whole file says nothing about whether that slice
     * changed.
     */
    if (selection.isEmpty() && previousKey.startsWith('file ')) {
      const next = flowSignatureFor(model.uri.toString())
      if (next !== null && next === flowSignature) {
        highlightVisualizerLine(selection.positionLineNumber)
        return
      }
      flowSignature = next
    } else if (selection.isEmpty()) {
      flowSignature = flowSignatureFor(model.uri.toString())
    }

    if (selection.isEmpty()) {
      renderVisualizer(model.getValue(), 1, 'file')
      highlightVisualizerLine(selection.positionLineNumber)
      return
    }
    renderVisualizer(model.getValueInRange(selection), selection.startLineNumber, 'selection')
  }

  const schedule = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(rebuild, 300)
  }

  editor.onDidChangeCursorSelection((event) => {
    // The cheap path, immediately. `positionLineNumber` rather than
    // `startLineNumber`: it is the end the caret is actually at, so dragging a
    // selection upwards tracks the moving end rather than the anchor.
    highlightVisualizerLine(event.selection.positionLineNumber)
    schedule()
  })
  editor.onDidChangeModelContent(schedule)
  editor.onDidChangeModel(schedule)
}

/**
 * Keeps a tree-sitter tree in step with the editor's model.
 *
 * Registered separately from the Visualizer feed, and before it, because the
 * ordering is load-bearing: Monaco calls content listeners synchronously in
 * registration order, so the tree is already up to date by the time anything
 * debounced reads its signature 300ms later.
 *
 * Every failure path here is a silent no-op that leaves the previous behaviour
 * intact. An unsupported language, a missing grammar, a build with no wasm
 * shipped — all of them mean `flowSignatureFor` answers null and the Visualizer
 * rebuilds exactly as it did before. This layer is an optimisation, and an
 * optimisation whose absence breaks the feature is not one.
 */
function registerSyntaxFeed(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  const adopt = (model: monacoNs.editor.ITextModel | null): void => {
    if (model === null) return
    const languageId = model.getLanguageId()
    if (!supportsLanguage(languageId)) return
    void openSyntaxDocument(model.uri.toString(), languageId, model.getValue())
  }

  adopt(editor.getModel())
  editor.onDidChangeModel(() => adopt(editor.getModel()))

  editor.onDidChangeModelContent((event) => {
    const model = editor.getModel()
    if (model === null) return

    const key = model.uri.toString()
    if (!hasSyntaxDocument(key)) {
      // The grammar may have finished loading after the model opened, or the
      // language may have changed under it. Either way, start from the current
      // text rather than trying to replay edits the tree never saw.
      adopt(model)
      return
    }

    const text = model.getValue()
    for (const change of event.changes) {
      const applied = applySyntaxEdit(
        key,
        {
          rangeOffset: change.rangeOffset,
          rangeLength: change.rangeLength,
          text: change.text,
          startLine: change.range.startLineNumber,
          startColumn: change.range.startColumn,
          endLine: change.range.endLineNumber,
          endColumn: change.range.endColumn
        },
        text
      )
      // A rejected edit leaves the tree describing text that no longer exists,
      // which is worse than no tree at all: the signature would then be
      // confidently wrong and the Visualizer would stop updating. Drop it and
      // re-parse from scratch.
      if (!applied.ok) {
        closeSyntaxDocument(key)
        adopt(model)
        return
      }
    }
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

/* --------------------------- workbench layout ---------------------------- */

/**
 * The live geometry of the resizable regions, mirrored into CSS custom
 * properties on `.workbench`.
 *
 * Held as a plain object rather than read back out of `getComputedStyle`,
 * because a splitter asks for the current size on every pointermove and a
 * computed-style read forces a layout flush each time. The stylesheet owns the
 * grid; this owns three numbers in it.
 */
const layout: WorkbenchLayout = {
  sideBarWidth: cssPixels('--bcc-side-bar-width'),
  rightDockWidth: cssPixels('--bcc-right-dock-width'),
  panelHeight: cssPixels('--bcc-panel-height'),
  sideBarHidden: false,
  // Matches the attribute index.html ships. Overwritten a moment later by the
  // persisted value, if there is one.
  rightDockHidden: true
}

/**
 * Reads a length token from the theme.
 *
 * theme.css is the source of truth for the shipped sizes, so they are recovered
 * from it rather than repeated here — a fourth copy of "260" alongside the
 * stylesheet, the main-process defaults and the schema would be a fourth thing
 * to keep in step. The fallback covers a token that has been renamed out from
 * under this call: zero would collapse the region with no way to drag it back.
 */
function cssPixels(token: string): number {
  const parsed = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(token)
  )
  return Number.isFinite(parsed) ? parsed : 240
}

/** Below these a region is a sliver that cannot show anything. */
const SIDE_BAR_MIN_WIDTH = 180
const RIGHT_DOCK_MIN_WIDTH = 280
const PANEL_MIN_HEIGHT = 120
/** Never resize a tool window at the cost of leaving the editor unusable. */
const EDITOR_MIN_WIDTH = 360
const EDITOR_MIN_HEIGHT = 220
/** Mirrors `workbenchLayoutSchema`'s ceiling; a larger value fails to persist. */
const LAYOUT_MAX_PX = 4000

function maxSideBarWidth(): number {
  const taken =
    cssPixels('--bcc-activity-bar-width') +
    EDITOR_MIN_WIDTH +
    (isRightDockVisible() ? layout.rightDockWidth : 0)
  return Math.min(LAYOUT_MAX_PX, Math.max(SIDE_BAR_MIN_WIDTH, window.innerWidth - taken))
}

function maxRightDockWidth(): number {
  const taken =
    cssPixels('--bcc-activity-bar-width') +
    EDITOR_MIN_WIDTH +
    (layout.sideBarHidden ? 0 : layout.sideBarWidth)
  return Math.min(LAYOUT_MAX_PX, Math.max(RIGHT_DOCK_MIN_WIDTH, window.innerWidth - taken))
}

function maxPanelHeight(): number {
  const taken = cssPixels('--bcc-status-bar-height') + EDITOR_MIN_HEIGHT
  return Math.min(LAYOUT_MAX_PX, Math.max(PANEL_MIN_HEIGHT, window.innerHeight - taken))
}

function clampPx(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)))
}

let layoutWriteTimer: number | null = null

/**
 * Writes the layout back, coalesced.
 *
 * Called at the end of every drag and on every arrow-key nudge, and a held
 * arrow key repeats. The patch carries the whole `workbenchLayout` object
 * because `settings.set` merges one level deep and then parses against a strict
 * schema — half an object is a validation error, not a partial update.
 */
function persistLayout(): void {
  if (layoutWriteTimer !== null) window.clearTimeout(layoutWriteTimer)
  layoutWriteTimer = window.setTimeout(() => {
    layoutWriteTimer = null
    // Failure is deliberately not surfaced: a layout that did not persist is a
    // nuisance at the next launch, not something to interrupt the user over.
    void window.betterCallCompiler.settings.set({ patch: { workbenchLayout: { ...layout } } })
  }, 400)
}

/**
 * Restores the saved layout and makes the three region boundaries draggable.
 *
 * Everything read back is clamped before it is applied. settings.json is a
 * plain file the user can edit, and it is also carried between machines — a
 * `rightDockWidth` of 1800 saved on a wide monitor must not open a workbench on
 * a laptop with no editor in it and no handle left on screen to drag one back.
 */
async function mountWorkbenchLayout(): Promise<void> {
  const root = requireEl('workbench')

  const stored = await window.betterCallCompiler.settings.get({})
  if (stored.ok) {
    const saved = stored.value.settings.workbenchLayout
    layout.sideBarHidden = saved.sideBarHidden
    layout.rightDockHidden = saved.rightDockHidden
    // Widths are clamped after the hidden flags are applied, because what a
    // region may grow to depends on which of its neighbours are showing.
    layout.sideBarWidth = clampPx(saved.sideBarWidth, SIDE_BAR_MIN_WIDTH, maxSideBarWidth())
    layout.rightDockWidth = clampPx(saved.rightDockWidth, RIGHT_DOCK_MIN_WIDTH, maxRightDockWidth())
    layout.panelHeight = clampPx(saved.panelHeight, PANEL_MIN_HEIGHT, maxPanelHeight())
  }

  root.style.setProperty('--bcc-side-bar-width', `${layout.sideBarWidth}px`)
  root.style.setProperty('--bcc-right-dock-width', `${layout.rightDockWidth}px`)
  root.style.setProperty('--bcc-panel-height', `${layout.panelHeight}px`)
  if (layout.sideBarHidden) root.dataset['sidebarHidden'] = 'true'
  else delete root.dataset['sidebarHidden']
  if (layout.rightDockHidden) hideRightDock()
  else showRightDock()

  mountSplitter(requireEl('splitter-sidebar'), {
    axis: 'x',
    min: SIDE_BAR_MIN_WIDTH,
    max: maxSideBarWidth,
    get: () => layout.sideBarWidth,
    set: (px) => {
      layout.sideBarWidth = px
      root.style.setProperty('--bcc-side-bar-width', `${px}px`)
    },
    onCommit: persistLayout
  })

  mountSplitter(requireEl('splitter-rightdock'), {
    axis: 'x',
    min: RIGHT_DOCK_MIN_WIDTH,
    max: maxRightDockWidth,
    get: () => layout.rightDockWidth,
    set: (px) => {
      layout.rightDockWidth = px
      root.style.setProperty('--bcc-right-dock-width', `${px}px`)
    },
    onCommit: persistLayout,
    // The dock is anchored to the right edge, so the handle travelling left is
    // what makes it wider.
    invert: true
  })

  mountSplitter(requireEl('splitter-panel'), {
    axis: 'y',
    min: PANEL_MIN_HEIGHT,
    max: maxPanelHeight,
    get: () => layout.panelHeight,
    set: (px) => {
      layout.panelHeight = px
      root.style.setProperty('--bcc-panel-height', `${px}px`)
    },
    onCommit: persistLayout,
    // Bottom-anchored, same reasoning: dragging up grows it.
    invert: true
  })

  watchRegionVisibility(root)
}

/**
 * Persists a region being opened or closed.
 *
 * The activity bar is what toggles the dock, and it has no business knowing
 * that settings exist; threading a callback from here through right-dock.ts to
 * reach it would couple three modules to persist one boolean. The attribute on
 * `.workbench` is already the record CSS reads, so it is read from there too.
 * Attached after the restore above, so replaying what was just loaded cannot
 * trigger a write.
 */
function watchRegionVisibility(root: HTMLElement): void {
  const observer = new MutationObserver(() => {
    const sideBarHidden = root.dataset['sidebarHidden'] === 'true'
    const rightDockHidden = root.dataset['rightdockHidden'] === 'true'
    if (sideBarHidden === layout.sideBarHidden && rightDockHidden === layout.rightDockHidden) return
    layout.sideBarHidden = sideBarHidden
    layout.rightDockHidden = rightDockHidden
    persistLayout()
  })
  observer.observe(root, { attributeFilter: ['data-sidebar-hidden', 'data-rightdock-hidden'] })
}

/**
 * Registers every docked view and wires the activity bar to them.
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
  registerSideBarView({ id: 'artifacts', mount: mountArtifacts, onShow: onArtifactsShown })

  // The Visualizer docks on the right instead of in the side bar. Same view,
  // same handlers, a region three times as wide as the one a control-flow graph
  // was previously being folded into.
  mountRightDock(requireEl('right-dock-title'), requireEl('right-dock-body'))
  registerRightDockView({ id: 'visualizer', mount: mountVisualizer, onShow: onVisualizerShown })
  registerRightDockView({
    id: 'compiler',
    mount: mountCompilerIntelligence,
    onShow: onCompilerIntelligenceShown
  })

  mountActivityBar(requireEl('activity-bar'), (id) => {
    // Run and Problems open bottom-panel views rather than side-bar ones.
    if (id === 'run') void showOutput()
    else if (id === 'problems') void showProblemsPanel()
  })

  // Assist results surface in its panel the way AI answers surface in theirs.
  listenForAssistActions()
  setAssistViewActivator(() => {
    setSelected('assist')
    return showSideBarView('assist')
  })

  // Bound at start-up rather than on first mount: the panel is lazily mounted
  // like every other tool window, and an explanation requested before it has
  // ever been opened must still be captured, or the first use of the feature
  // streams into nothing.
  listenForExplainRequests()
  setArtifactsViewActivator(() => {
    setSelected('artifacts')
    void showSideBarView('artifacts')
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
    // Both of these were unreachable from the palette until now — registered
    // in the activity bar and nowhere else, which meant the only way to open
    // them was to know which icon they are.
    { id: 'view.assist', title: 'View: Assist', run: showView('assist') },
    { id: 'view.artifacts', title: 'View: Explanations', run: showView('artifacts') },
    {
      id: 'view.compiler',
      title: 'View: Compiler Intelligence',
      run: () => {
        setSelected('compiler')
        void showRightDockView('compiler')
      }
    },
    {
      id: 'view.visualizer',
      title: 'View: Visualizer',
      run: () => {
        setSelected('visualizer')
        void showRightDockView('visualizer')
      }
    },
    { id: 'view.settings', title: 'View: Settings', run: showView('settings') },

    {
      id: 'view.terminal',
      title: 'View: Toggle Terminal',
      keybinding: 'Ctrl+`',
      run: () => void showPanelView('terminal')
    },
    { id: 'view.output', title: 'View: Output', run: () => void showOutput() },
    { id: 'view.problems', title: 'View: Problems', run: () => void showProblemsPanel() },
    {
      id: 'compiler.restart',
      title: 'Compiler: Restart Daemon',
      run: () => {
        void window.betterCallCompiler.compiler.restart({})
      }
    },

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

/* --------------------------- the detached window -------------------------- */

/**
 * Whether a floating diagram is believed to be on screen.
 *
 * Gating the push on this is not an optimisation to be waved away: every
 * `pushState` validates the whole graph twice — once as a request, once as an
 * event payload — and the main window parses on a 300ms debounce for as long as
 * somebody is typing. Pushing unconditionally would pay for a detached window
 * nobody opened, on every keystroke, forever.
 *
 * It can go stale in one direction only: closing the floating window from its
 * own title bar leaves this true, and the pushes become no-ops in main rather
 * than errors. Correcting that needs main to report the close, which is a
 * channel this does not have yet.
 */
let floatingOpen = false

/**
 * Wires the main window's half of the bridge.
 *
 * Both directions cross through main. There is no renderer-to-renderer channel
 * and adding one would mean a second trust boundary to get right, for a feature
 * that is two messages wide.
 */
function connectFloatingVisualizer(reveal: (line: number) => void): void {
  setVisualizerFloatHandler(() => {
    void window.betterCallCompiler.visualizer.openFloating({}).then((result) => {
      if (!result.ok || !result.value.opened) return
      floatingOpen = true
      // The window opens empty and main replays the last state into it, but only
      // if a parse has happened since launch. Pushing the graph on screen now
      // covers the case where it has not.
      const current = currentVisualizerGraph()
      void window.betterCallCompiler.visualizer.pushState({
        graph: current.graph,
        selectedNodeId: current.selectedNodeId
      })
    })
  })

  onVisualizerGraphChanged((graph, selectedNodeId) => {
    if (!floatingOpen) return
    void window.betterCallCompiler.visualizer.pushState({ graph, selectedNodeId })
  })

  // A node clicked in the detached window moves this window's editor.
  window.betterCallCompiler.visualizer.onRevealRequested((payload) => {
    reveal(payload.line)
  })
}

/**
 * The whole renderer, when it is running as the detached diagram.
 *
 * It mounts the same panel against the same stylesheet and nothing else — no
 * activity bar, no editor, no panel, no status bar. It also never parses:
 * `renderVisualizerGraph` takes the graph the main window already built, so the
 * two windows cannot drift into showing different diagrams of one file.
 */
function bootVisualizerWindow(): void {
  document.body.replaceChildren()

  const host = el('div', 'viz-floating-host')
  // The panel writes its heading into a title host. There is no tool-window
  // header out here, so it gets a hidden one rather than a special case inside
  // the panel — the window's own title bar already names it.
  const title = el('div')
  title.hidden = true
  const body = el('div', 'viz-floating-body')
  host.append(title, body)
  document.body.append(host)

  mountVisualizer(title, body)

  window.betterCallCompiler.visualizer.onStateChanged((state) => {
    renderVisualizerGraph(state.graph, state.selectedNodeId)
  })

  // Click-to-source has to reach an editor in the other window.
  setVisualizerRevealHandler((line) => {
    void window.betterCallCompiler.visualizer.requestReveal({ line })
  })

  document.documentElement.dataset['bettercallcompilerReady'] = 'true'
}

/**
 * Renders daemon diagnostics as Monaco markers.
 *
 * A batch is applied wholesale: `FileDiagnostics` is the complete set for its
 * file, so an empty array clears that file's markers — which is how a fixed
 * error's squiggle disappears.
 */
function bindCompilerDiagnostics(): void {
  window.betterCallCompiler.compiler.onDiagnosticsChanged((batch) => {
    applyDiagnostics(batch.files)
  })

  window.betterCallCompiler.compiler.onStatusChanged((status) => {
    // A restarting or failed daemon is no longer maintaining its markers, and
    // leaving them would strand squiggles nobody is updating.
    if (status.state === 'restarting' || status.state === 'failed') clearAllMarkers()
  })

  // The daemon may already have checked files before this window finished
  // booting; pull whatever it has rather than waiting for the next edit.
  void window.betterCallCompiler.compiler
    .diagnostics({ relativePath: null })
    .then((result) => {
      if (result.ok) applyDiagnostics(result.value.files)
    })
}

async function boot(): Promise<void> {
  // One bundle, two windows. The branch is first so nothing below it — Monaco,
  // the watcher, the git poll — is ever constructed in a window that only draws
  // a diagram.
  if (new URLSearchParams(window.location.search).get('mode') === 'visualizer') {
    bootVisualizerWindow()
    return
  }

  renderEditorPlaceholder(requireEl('editor-host'))
  await renderStatusBar(requireEl('status-bar'))

  await mountEditor(requireEl('editor-host'), requireEl('tab-bar'))
  mountPanel(requireEl('panel'), requireEl('panel-tabs'), requireEl('panel-body'))
  await mountSideBarViews()
  // After the docks exist, so restoring an open right dock has something to
  // show in it. Monaco lays itself out automatically, so the editor absorbs the
  // resulting width change without being told.
  await mountWorkbenchLayout()
  listenForAiActions()
  bindCompilerDiagnostics()
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
