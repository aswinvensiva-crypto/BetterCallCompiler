/**
 * Renderer entry point.
 *
 * Step 1 renders the static workbench shell. Later steps replace each region's
 * placeholder with a real view; nothing here may reach for Node or the network
 * — the renderer's only privileged path is `window.aperture`.
 */

import type { ApertureApi } from '../shared/ipc-contract'
import type { FileNode } from '../shared/types'
import { mountExplorer, OPEN_FILE_EVENT } from './views/explorer'
import { createEditor } from './editor/monaco-setup'
import { attachEditor, activeDocument, openFile, reloadFromDisk, saveActive } from './editor/models'
import { mountTabs } from './editor/tabs'
import { notifyError } from './workbench/notifications'
import { mountPanel, showOutput } from './workbench/panel'
import { mountStatusBar } from './workbench/status-bar'
import { runActiveFile } from './views/run'
import { mountActivityBar } from './workbench/activity-bar'
import { mountSideBar, registerSideBarView, showSideBarView } from './workbench/side-bar'
import { clearDiffSelection, mountScm, onScmShown } from './views/scm'
import { mountSettings, onSettingsShown } from './views/settings'
import { mountDiffEditor } from './editor/diff'

declare global {
  interface Window {
    /** The only privileged surface in the renderer. Installed by the preload. */
    readonly aperture: ApertureApi
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
  wrap.append(el('div', 'editor-placeholder__mark', 'Aperture'))
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
    id: 'aperture.saveFile',
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
  window.aperture.fs.onWatchEvent((watchEvent) => {
    if (watchEvent.type === 'change') void reloadFromDisk(watchEvent.path)
  })

  const observer = new MutationObserver(syncPlaceholder)
  observer.observe(tabBar, { childList: true })
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

  const result = await window.aperture.app.ping({})

  if (result.ok) {
    statusBar.setBridge(`Bridge connected · Electron ${result.value.electron}`, 'ok')
    statusBar.setBuild(`Aperture ${result.value.version} · ${result.value.platform}`)
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
  registerSideBarView({ id: 'scm', mount: mountScm, onShow: onScmShown })
  registerSideBarView({ id: 'settings', mount: mountSettings, onShow: onSettingsShown })

  mountActivityBar(requireEl('activity-bar'), (id) => {
    // The Run icon opens the output console rather than a side-bar view.
    if (id === 'run') void showOutput()
  })

  await showSideBarView('explorer')
}

async function boot(): Promise<void> {
  renderEditorPlaceholder(requireEl('editor-host'))
  await renderStatusBar(requireEl('status-bar'))

  mountEditor(requireEl('editor-host'), requireEl('tab-bar'))
  mountPanel(requireEl('panel'), requireEl('panel-tabs'), requireEl('panel-body'))
  await mountSideBarViews()

  // Readiness marker. The workbench regions are static markup, so their mere
  // presence says nothing about whether the renderer has booted — a test that
  // waits on `#workbench` can fire input before any listener is attached.
  // This flips only once every view is mounted.
  document.documentElement.dataset['apertureReady'] = 'true'
}

void boot()

export {}
