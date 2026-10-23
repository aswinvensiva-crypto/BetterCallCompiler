import { createToolWindowRegistry, type ToolWindowView } from './tool-window-registry'

/**
 * The right-hand dock.
 *
 * The Visualizer used to live in the side bar, which is 260px wide because that
 * is a good width for a file tree. A control-flow graph in 260px is a diagram
 * you scroll rather than one you read, so the region it belongs in is a
 * separate, much wider one on the opposite edge — the same split IntelliJ makes
 * between the Project tool window and the right-hand group.
 *
 * Two differences from side-bar.ts, and only two. The class names on the slots
 * are its own, so a stylesheet or a test can address one region without
 * catching the other. And this region can be closed outright: the side bar has
 * never had that concept, and giving it one here would be scope this phase does
 * not need.
 */

const registry = createToolWindowRegistry('right-dock__title-slot', 'right-dock__view')

/**
 * The state of record for whether the dock is showing.
 *
 * An attribute on `.workbench` rather than `hidden` on the `<aside>` itself,
 * because the grid column and the splitter beside it have to collapse with it
 * and only the grid container can be told to do that. It mirrors the dormant
 * `data-sidebar-hidden` hook the stylesheet has carried since step 1.
 */
const HIDDEN_ATTRIBUTE = 'data-rightdock-hidden'

let visible = false
/** First registered view, shown when the region is opened with nothing active. */
let firstViewId: string | null = null

const changeListeners = new Set<() => void>()
registry.onChanged(notifyChanged)

function notifyChanged(): void {
  for (const listener of changeListeners) listener()
}

/**
 * Fires whenever the dock opens, closes or switches view.
 *
 * For a view that draws outside its own region — Substrate marks the traced
 * construct in the editor — and has to take that down the moment it stops
 * being visible. `onShow` alone cannot tell it: nothing is called on hide.
 */
export function onRightDockChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

function workbenchElement(): HTMLElement | null {
  return document.getElementById('workbench')
}

export function mountRightDock(title: HTMLElement, body: HTMLElement): void {
  registry.mountHosts(title, body)
  // index.html ships the dock closed so the first paint is not a 460px column
  // that vanishes a moment later. Read that back rather than assuming it, so
  // the markup stays the one place the initial state is written down.
  visible = workbenchElement()?.getAttribute(HIDDEN_ATTRIBUTE) !== 'true'
}

export function registerRightDockView(view: ToolWindowView): void {
  registry.register(view)
  if (firstViewId === null) firstViewId = view.id
}

export async function showRightDockView(id: string): Promise<void> {
  // Reveal first, then activate. A view's `onShow` measures the region it is in
  // — the Visualizer refits its diagram there — and measuring a collapsed grid
  // column gives zero.
  showRightDock()
  await registry.show(id)
}

export function activeRightDockView(): string | null {
  return registry.activeId()
}

export function isRightDockVisible(): boolean {
  return visible
}

export function showRightDock(): void {
  setVisible(true)
  // A visible region with no active view is an empty box. Nothing records which
  // view was last showing — there is one today — so the first registered wins.
  if (registry.activeId() === null && firstViewId !== null) void registry.show(firstViewId)
}

export function hideRightDock(): void {
  setVisible(false)
}

export function toggleRightDock(): void {
  if (visible) hideRightDock()
  else showRightDock()
}

function setVisible(next: boolean): void {
  const changed = visible !== next
  visible = next
  const root = workbenchElement()
  if (root !== null) {
    if (next) root.removeAttribute(HIDDEN_ATTRIBUTE)
    else root.setAttribute(HIDDEN_ATTRIBUTE, 'true')
  }
  if (changed) notifyChanged()
}
