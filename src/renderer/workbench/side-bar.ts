/**
 * The side-bar view registry.
 *
 * Steps 1–7 had exactly one side-bar view, so the explorer simply owned the
 * region. Steps 8–10 add three more, and the activity bar has to be able to
 * switch between them. The registry is deliberately thin: it owns *which* view
 * is showing and nothing about what any of them contain.
 *
 * Each view gets its own title slot and body container rather than sharing one
 * pair, so switching away and back does not force a view to re-render from
 * scratch — the explorer's expansion state and scroll position survive a trip
 * to the SCM view and back.
 */

export interface SideBarView {
  readonly id: string
  /** Mounted once, lazily, the first time the view is shown. */
  readonly mount: (title: HTMLElement, body: HTMLElement) => void | Promise<void>
  /** Called on every activation after the first. */
  readonly onShow?: () => void
}

interface RegisteredView {
  readonly view: SideBarView
  readonly title: HTMLElement
  readonly body: HTMLElement
  mounted: boolean
}

const views = new Map<string, RegisteredView>()
let titleHost: HTMLElement | null = null
let bodyHost: HTMLElement | null = null
let activeId: string | null = null

const changeListeners = new Set<(id: string) => void>()

export function onSideBarViewChanged(listener: (id: string) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function mountSideBar(title: HTMLElement, body: HTMLElement): void {
  titleHost = title
  bodyHost = body
  title.replaceChildren()
  body.replaceChildren()
}

export function registerSideBarView(view: SideBarView): void {
  if (titleHost === null || bodyHost === null) return
  if (views.has(view.id)) return

  const title = document.createElement('div')
  title.className = 'side-bar__title-slot'
  title.dataset['viewId'] = view.id
  title.hidden = true
  titleHost.append(title)

  const body = document.createElement('div')
  body.className = 'side-bar__view'
  body.dataset['viewId'] = view.id
  body.hidden = true
  bodyHost.append(body)

  views.set(view.id, { view, title, body, mounted: false })
}

export function activeSideBarView(): string | null {
  return activeId
}

export async function showSideBarView(id: string): Promise<void> {
  const target = views.get(id)
  if (target === undefined) return

  for (const entry of views.values()) {
    const showing = entry.view.id === id
    entry.title.hidden = !showing
    entry.body.hidden = !showing
  }

  activeId = id

  // Mounting on first show keeps start-up cheap: the SCM view does not shell
  // out to git, and the insights view does not touch the network, until the
  // user actually asks for them.
  if (!target.mounted) {
    target.mounted = true
    await target.view.mount(target.title, target.body)
  } else {
    target.view.onShow?.()
  }

  for (const listener of changeListeners) listener(id)
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
