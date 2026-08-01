import {
  activate,
  activeDocument,
  close,
  isDirty,
  onDocumentsChanged,
  openDocuments,
  save,
  type OpenDocument
} from './models'
import { confirmAction, notifyError } from '../workbench/notifications'

let host: HTMLElement | null = null

function tabElement(doc: OpenDocument, isActive: boolean): HTMLElement {
  const tab = document.createElement('div')
  tab.className = `tab${isActive ? ' tab--active' : ''}`
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', String(isActive))
  tab.dataset['path'] = doc.node.path
  tab.title = doc.node.relativePath

  const label = document.createElement('span')
  label.className = 'tab__label'
  label.textContent = doc.node.name
  tab.append(label)

  const dirty = isDirty(doc)

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = `tab__close${dirty ? ' tab__close--dirty' : ''}`
  closeButton.setAttribute('aria-label', dirty ? `Close ${doc.node.name} (unsaved)` : `Close ${doc.node.name}`)
  // The dirty dot and the close affordance occupy the same slot, exactly as in
  // VS Code: the dot becomes an × on hover.
  closeButton.innerHTML = dirty
    ? '<span class="tab__dirty-dot" aria-hidden="true"></span><span class="tab__close-glyph" aria-hidden="true">×</span>'
    : '<span class="tab__close-glyph" aria-hidden="true">×</span>'

  // Deliberately `mousedown`, not `click`. The tab's own mousedown activates
  // the document, which re-renders the tab bar and replaces this very button —
  // so a `click` listener would be destroyed before the click ever landed.
  // stopPropagation also keeps the tab from activating on its way to closing.
  closeButton.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void requestClose(doc)
  })

  tab.append(closeButton)
  tab.addEventListener('mousedown', (event) => {
    if (event.button === 1) {
      event.preventDefault()
      void requestClose(doc)
      return
    }
    activate(doc.node.path)
  })

  return tab
}

/** Closing a dirty tab must never silently discard work. */
export async function requestClose(doc: OpenDocument): Promise<void> {
  if (!isDirty(doc)) {
    close(doc.node.path)
    return
  }

  const choice = await confirmAction({
    title: `Save changes to ${doc.node.name}?`,
    detail: 'Your changes will be lost if you close without saving.',
    confirmLabel: 'Save',
    alternateLabel: "Don't Save"
  })

  if (choice === 'cancel') return

  if (choice === 'confirm') {
    const saved = await save(doc)
    if (!saved) {
      notifyError(`Could not save ${doc.node.name}. The tab was left open.`)
      return
    }
  }

  close(doc.node.path)
}

export function render(): void {
  if (host === null) return

  const docs = openDocuments()
  const active = activeDocument()

  host.replaceChildren()
  for (const doc of docs) {
    host.append(tabElement(doc, active !== null && active.node.path === doc.node.path))
  }

  host.hidden = docs.length === 0

  // Keep the active tab in view when tabs overflow.
  const activeElement = host.querySelector('.tab--active')
  activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export function mountTabs(tabBar: HTMLElement): void {
  host = tabBar
  onDocumentsChanged(render)
  render()
}
