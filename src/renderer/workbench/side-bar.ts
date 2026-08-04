import { createToolWindowRegistry, type ToolWindowView } from './tool-window-registry'

/**
 * The side-bar view registry.
 *
 * Steps 1–7 had exactly one side-bar view, so the explorer simply owned the
 * region. Steps 8–10 add three more, and the activity bar has to be able to
 * switch between them. The registry is deliberately thin: it owns *which* view
 * is showing and nothing about what any of them contain.
 *
 * The mechanics moved to tool-window-registry.ts when the right-hand dock
 * arrived and needed the same ones. What stays here is the module-level
 * singleton and this exact export surface: seven call sites import these names,
 * and the E2E suite asserts on the `.side-bar__title-slot` / `.side-bar__view`
 * classes and the `data-view-id` attributes the registry stamps for it.
 */

/** Structurally the tool-window view; the alias keeps the seven call sites. */
export type SideBarView = ToolWindowView

const registry = createToolWindowRegistry('side-bar__title-slot', 'side-bar__view')

export function onSideBarViewChanged(listener: (id: string) => void): () => void {
  return registry.onChanged(listener)
}

export function mountSideBar(title: HTMLElement, body: HTMLElement): void {
  registry.mountHosts(title, body)
}

export function registerSideBarView(view: SideBarView): void {
  registry.register(view)
}

export function activeSideBarView(): string | null {
  return registry.activeId()
}

export function showSideBarView(id: string): Promise<void> {
  return registry.show(id)
}

/**
 * Renders a "this view has nothing to show yet" state.
 *
 * Shared so the empty states across SCM, insights and settings read as one
 * product rather than three people's idea of an empty state.
 */
export function emptyState(message: string, action?: { label: string; run: () => void }): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'explorer__empty'

  const text = document.createElement('p')
  text.className = 'explorer__empty-text'
  text.textContent = message
  wrap.append(text)

  if (action !== undefined) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'button button--primary'
    button.textContent = action.label
    button.addEventListener('click', action.run)
    wrap.append(button)
  }

  return wrap
}
