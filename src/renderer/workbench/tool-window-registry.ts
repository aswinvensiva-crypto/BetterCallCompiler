/**
 * A tool-window region: which of its views is showing, and nothing else.
 *
 * This is side-bar.ts's registry lifted out unchanged, because the right-hand
 * dock needs exactly the same bookkeeping and a second hand-rolled copy would
 * drift from the first within a step or two. The regions differ only in the
 * class names they stamp on their slots, so those are parameters rather than
 * something derived from an id — the E2E suite selects on those exact strings.
 *
 * Each view gets its own title slot and body container rather than sharing one
 * pair, so switching away and back does not force a view to re-render from
 * scratch — the explorer's expansion state and scroll position survive a trip
 * to the SCM view and back.
 */

export interface ToolWindowView {
  readonly id: string
  /** Mounted once, lazily, the first time the view is shown. */
  readonly mount: (title: HTMLElement, body: HTMLElement) => void | Promise<void>
  /** Called on every activation after the first. */
  readonly onShow?: () => void
}

export interface ToolWindowRegistry {
  mountHosts(title: HTMLElement, body: HTMLElement): void
  register(view: ToolWindowView): void
  show(id: string): Promise<void>
  activeId(): string | null
  onChanged(listener: (id: string) => void): () => void
}

interface RegisteredView {
  readonly view: ToolWindowView
  readonly title: HTMLElement
  readonly body: HTMLElement
  mounted: boolean
}

export function createToolWindowRegistry(
  titleClass: string,
  bodyClass: string
): ToolWindowRegistry {
  const views = new Map<string, RegisteredView>()
  const changeListeners = new Set<(id: string) => void>()

  let titleHost: HTMLElement | null = null
  let bodyHost: HTMLElement | null = null
  // Not named `activeId`: the interface method of that name reads the value,
  // and one of the two would be shadowing the other at every call site here.
  let showingId: string | null = null

  return {
    mountHosts(title: HTMLElement, body: HTMLElement): void {
      titleHost = title
      bodyHost = body
      title.replaceChildren()
      body.replaceChildren()
    },

    register(view: ToolWindowView): void {
      if (titleHost === null || bodyHost === null) return
      if (views.has(view.id)) return

      const title = document.createElement('div')
      title.className = titleClass
      title.dataset['viewId'] = view.id
      title.hidden = true
      titleHost.append(title)

      const body = document.createElement('div')
      body.className = bodyClass
      body.dataset['viewId'] = view.id
      body.hidden = true
      bodyHost.append(body)

      views.set(view.id, { view, title, body, mounted: false })
    },

    activeId(): string | null {
      return showingId
    },

    async show(id: string): Promise<void> {
      const target = views.get(id)
      if (target === undefined) return

      for (const entry of views.values()) {
        const showing = entry.view.id === id
        entry.title.hidden = !showing
        entry.body.hidden = !showing
      }

      showingId = id

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
    },

    onChanged(listener: (id: string) => void): () => void {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    }
  }
}
