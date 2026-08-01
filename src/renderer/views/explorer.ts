import type { FileNode, FsWatchEvent, Workspace } from '../../shared/types'
import { confirmAction, notifyError } from '../workbench/notifications'

/**
 * The file explorer.
 *
 * Children are fetched one directory at a time and cached by relative path, so
 * opening a large repository costs one `readdir` rather than a full recursive
 * walk. Watch events invalidate exactly the directory that changed instead of
 * rebuilding the tree, which is what keeps expansion state and scroll position
 * stable while files churn underneath.
 */

/** Fired when a file row is activated. The editor (step 4) listens for this. */
export const OPEN_FILE_EVENT = 'aperture:open-file'

interface PendingEdit {
  /** Absolute path of the directory the new entry goes into. */
  readonly parentPath: string
  readonly parentRelativePath: string
  readonly kind: 'file' | 'directory'
  /** Set when renaming an existing node rather than creating a new one. */
  readonly renaming?: FileNode
}

const ROOT_KEY = ''

let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null

let workspace: Workspace = { root: null, name: null }
const childrenByDir = new Map<string, FileNode[]>()
const expanded = new Set<string>()
let selectedPath: string | null = null
let pendingEdit: PendingEdit | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/* ------------------------------- helpers ------------------------------- */

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

/** Renderer has no `node:path`; the service resolves and confines whatever it gets. */
function childPath(parentAbsolute: string, name: string): string {
  return `${parentAbsolute.replace(/[\\/]+$/, '')}/${name}`
}

function parentAbsoluteOf(node: FileNode): string {
  const trimmed = node.path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut <= 0 ? trimmed : trimmed.slice(0, cut)
}

function parentRelativeOf(node: FileNode): string {
  const cut = node.relativePath.lastIndexOf('/')
  return cut < 0 ? ROOT_KEY : node.relativePath.slice(0, cut)
}

function showError(message: string): void {
  notifyError(message)
}

/* ------------------------------- data ---------------------------------- */

async function loadChildren(dirAbsolute: string, dirRelative: string): Promise<FileNode[]> {
  const result = await window.aperture.fs.readDir({ path: dirAbsolute })
  if (!result.ok) {
    showError(result.error.message)
    return []
  }
  childrenByDir.set(dirRelative, result.value.entries)
  return result.value.entries
}

async function ensureChildren(dirAbsolute: string, dirRelative: string): Promise<void> {
  if (childrenByDir.has(dirRelative)) return
  await loadChildren(dirAbsolute, dirRelative)
}

/* ------------------------------ rendering ------------------------------ */

interface Row {
  readonly node: FileNode
  readonly depth: number
}

function collectRows(dirRelative: string, depth: number, out: Row[]): void {
  const children = childrenByDir.get(dirRelative)
  if (children === undefined) return

  for (const node of children) {
    out.push({ node, depth })
    if (node.kind === 'directory' && expanded.has(node.relativePath)) {
      collectRows(node.relativePath, depth + 1, out)
    }
  }
}

function chevron(open: boolean): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('class', `tree__chevron${open ? ' tree__chevron--open' : ''}`)
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M6 4l4 4-4 4')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}

function buildRow(row: Row): HTMLElement {
  const { node, depth } = row
  const item = el('div', 'tree__row')
  item.style.paddingLeft = `${8 + depth * 12}px`
  item.dataset['path'] = node.path
  item.setAttribute('role', 'treeitem')
  item.title = node.relativePath

  if (node.path === selectedPath) item.classList.add('tree__row--selected')

  if (node.kind === 'directory') {
    item.append(chevron(expanded.has(node.relativePath)))
    item.setAttribute('aria-expanded', String(expanded.has(node.relativePath)))
  } else {
    item.append(el('span', 'tree__chevron-spacer'))
  }

  item.append(el('span', `tree__icon tree__icon--${node.kind}`))
  item.append(el('span', 'tree__label', node.name))

  item.addEventListener('click', () => {
    void activate(node)
  })
  item.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    selectedPath = node.path
    openContextMenu(event as MouseEvent, node)
  })

  return item
}

function buildEditRow(edit: PendingEdit, depth: number): HTMLElement {
  const wrap = el('div', 'tree__row tree__row--editing')
  wrap.style.paddingLeft = `${8 + depth * 12}px`
  wrap.append(el('span', 'tree__chevron-spacer'))
  wrap.append(el('span', `tree__icon tree__icon--${edit.kind}`))

  const input = el('input', 'tree__input')
  input.type = 'text'
  input.value = edit.renaming?.name ?? ''
  input.spellcheck = false
  wrap.append(input)

  const commit = (): void => {
    const value = input.value.trim()
    input.disabled = true
    void submitEdit(edit, value)
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      pendingEdit = null
      render()
    }
  })
  input.addEventListener('blur', () => {
    if (pendingEdit !== null && !input.disabled) {
      pendingEdit = null
      render()
    }
  })

  // Focus after the row is in the document.
  window.setTimeout(() => {
    input.focus()
    const dot = input.value.lastIndexOf('.')
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }, 0)

  return wrap
}

function render(): void {
  if (bodyHost === null || titleHost === null) return

  titleHost.replaceChildren()
  const heading = el('span', 'side-bar__heading', workspace.name ?? 'Explorer')
  titleHost.append(heading)

  if (workspace.root !== null) {
    const actions = el('div', 'side-bar__actions')
    actions.append(
      iconButton('New File', 'M8 3v10M3 8h10', () => beginCreate('file')),
      iconButton('New Folder', 'M3 5h4l1.5 2H13v6H3z', () => beginCreate('directory')),
      iconButton('Refresh', 'M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3', () => {
        void refreshAll()
      })
    )
    titleHost.append(actions)
  }

  bodyHost.replaceChildren()

  if (workspace.root === null) {
    const empty = el('div', 'explorer__empty')
    empty.append(el('p', 'explorer__empty-text', 'You have not opened a folder yet.'))
    const open = el('button', 'button button--primary', 'Open Folder')
    open.type = 'button'
    open.addEventListener('click', () => {
      void openFolder()
    })
    empty.append(open)
    bodyHost.append(empty)
    return
  }

  const tree = el('div', 'tree')
  tree.setAttribute('role', 'tree')

  const rows: Row[] = []
  collectRows(ROOT_KEY, 0, rows)

  for (const row of rows) {
    tree.append(buildRow(row))
    if (
      pendingEdit !== null &&
      pendingEdit.renaming === undefined &&
      pendingEdit.parentRelativePath === row.node.relativePath
    ) {
      tree.append(buildEditRow(pendingEdit, row.depth + 1))
    }
    if (pendingEdit?.renaming?.path === row.node.path) {
      // Replace the row being renamed with the input.
      tree.lastElementChild?.remove()
      tree.append(buildEditRow(pendingEdit, row.depth))
    }
  }

  if (pendingEdit !== null && pendingEdit.parentRelativePath === ROOT_KEY && pendingEdit.renaming === undefined) {
    tree.append(buildEditRow(pendingEdit, 0))
  }

  bodyHost.append(tree)
}

function iconButton(label: string, path: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'icon-button')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML =
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return button
}

/* ------------------------------- actions ------------------------------- */

async function activate(node: FileNode): Promise<void> {
  selectedPath = node.path

  if (node.kind === 'directory') {
    if (expanded.has(node.relativePath)) {
      expanded.delete(node.relativePath)
    } else {
      expanded.add(node.relativePath)
      await ensureChildren(node.path, node.relativePath)
    }
    render()
    return
  }

  render()
  document.dispatchEvent(new CustomEvent<FileNode>(OPEN_FILE_EVENT, { detail: node }))
}

async function openFolder(): Promise<void> {
  const result = await window.aperture.fs.openFolder({})
  if (!result.ok) {
    showError(result.error.message)
    return
  }
  if (result.value.root === null) return // cancelled
  await adoptWorkspace(result.value)
}

async function adoptWorkspace(next: Workspace): Promise<void> {
  workspace = next
  childrenByDir.clear()
  expanded.clear()
  selectedPath = null
  if (next.root !== null) await loadChildren(next.root, ROOT_KEY)
  render()
}

function beginCreate(kind: 'file' | 'directory'): void {
  if (workspace.root === null) return

  // New entries land inside the selected directory, or beside the selected file.
  let parentPath = workspace.root
  let parentRelativePath = ROOT_KEY

  const selected = findNode(selectedPath)
  if (selected !== null) {
    if (selected.kind === 'directory') {
      parentPath = selected.path
      parentRelativePath = selected.relativePath
      expanded.add(selected.relativePath)
      void ensureChildren(selected.path, selected.relativePath).then(render)
    } else {
      parentPath = parentAbsoluteOf(selected)
      parentRelativePath = parentRelativeOf(selected)
    }
  }

  pendingEdit = { parentPath, parentRelativePath, kind }
  render()
}

function beginRename(node: FileNode): void {
  pendingEdit = {
    parentPath: parentAbsoluteOf(node),
    parentRelativePath: parentRelativeOf(node),
    kind: node.kind,
    renaming: node
  }
  render()
}

async function submitEdit(edit: PendingEdit, value: string): Promise<void> {
  pendingEdit = null

  if (value === '' || value === edit.renaming?.name) {
    render()
    return
  }

  const target = childPath(edit.parentPath, value)
  const api = window.aperture.fs

  const result =
    edit.renaming !== undefined
      ? await api.rename({ from: edit.renaming.path, to: target })
      : edit.kind === 'directory'
        ? await api.createDir({ path: target })
        : await api.createFile({ path: target })

  if (!result.ok) showError(result.error.message)

  await refreshDirectory(edit.parentRelativePath)
}

async function confirmDelete(node: FileNode): Promise<void> {
  const choice = await confirmAction({
    title: `Delete ${node.name}?`,
    detail:
      node.kind === 'directory'
        ? 'This deletes the folder and everything inside it. This cannot be undone.'
        : 'This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true
  })
  if (choice !== 'confirm') return

  const result = await window.aperture.fs.delete({ path: node.path })
  if (!result.ok) showError(result.error.message)
  await refreshDirectory(parentRelativeOf(node))
}

function findNode(path: string | null): FileNode | null {
  if (path === null) return null
  for (const nodes of childrenByDir.values()) {
    for (const node of nodes) {
      if (node.path === path) return node
    }
  }
  return null
}

/* ------------------------------ refreshing ----------------------------- */

async function refreshDirectory(dirRelative: string): Promise<void> {
  if (workspace.root === null) return
  if (!childrenByDir.has(dirRelative) && dirRelative !== ROOT_KEY) return

  const absolute =
    dirRelative === ROOT_KEY ? workspace.root : childPath(workspace.root, dirRelative)
  await loadChildren(absolute, dirRelative)
  render()
}

async function refreshAll(): Promise<void> {
  if (workspace.root === null) return
  const loaded = [...childrenByDir.keys()]
  childrenByDir.clear()
  for (const dirRelative of loaded) {
    const absolute =
      dirRelative === ROOT_KEY ? workspace.root : childPath(workspace.root, dirRelative)
    await loadChildren(absolute, dirRelative)
  }
  render()
}

/**
 * Watch events arrive in bursts — a single save can produce several, and a
 * `git checkout` produces hundreds. Coalesce them and refresh each affected
 * directory once.
 */
const dirtyDirectories = new Set<string>()

function onWatchEvent(event: FsWatchEvent): void {
  dirtyDirectories.add(event.parentRelativePath)

  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    const pending = [...dirtyDirectories]
    dirtyDirectories.clear()
    void (async () => {
      for (const dir of pending) await refreshDirectory(dir)
    })()
  }, 80)
}

/* ----------------------------- context menu ---------------------------- */

let openMenu: HTMLElement | null = null

function closeContextMenu(): void {
  openMenu?.remove()
  openMenu = null
}

function openContextMenu(event: MouseEvent, node: FileNode): void {
  closeContextMenu()

  const menu = el('div', 'context-menu')
  menu.style.left = `${event.clientX}px`
  menu.style.top = `${event.clientY}px`

  const add = (label: string, onClick: () => void): void => {
    const item = el('button', 'context-menu__item', label)
    item.type = 'button'
    item.addEventListener('click', () => {
      closeContextMenu()
      onClick()
    })
    menu.append(item)
  }

  if (node.kind === 'directory') {
    add('New File', () => beginCreate('file'))
    add('New Folder', () => beginCreate('directory'))
    menu.append(el('div', 'context-menu__separator'))
  }
  add('Rename', () => beginRename(node))
  add('Delete', () => void confirmDelete(node))

  document.body.append(menu)
  openMenu = menu

  // Keep the menu on screen when opened near an edge.
  const rect = menu.getBoundingClientRect()
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`

  render()
}

/* -------------------------------- mount -------------------------------- */

export async function mountExplorer(title: HTMLElement, body: HTMLElement): Promise<void> {
  titleHost = title
  bodyHost = body

  document.addEventListener('click', closeContextMenu)
  window.aperture.fs.onWatchEvent(onWatchEvent)

  const current = await window.aperture.fs.getWorkspace({})
  if (current.ok && current.value.root !== null) {
    await adoptWorkspace(current.value)
  } else {
    render()
  }
}

/** Exposed so the command palette and menu can trigger the same flow. */
export { openFolder as openFolderCommand }
