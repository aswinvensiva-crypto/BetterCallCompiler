import { BrowserWindow } from 'electron'
import { join } from 'node:path'

/**
 * The Visualizer's floating window — the app's second window, and the first
 * thing to ever contradict the assumption that there is exactly one.
 *
 * It gets its own module instead of a second branch inside `createWindow`
 * because `createWindow` is not a window factory: it is the *main window*
 * factory, and two of the things it does are actively hostile to a second
 * window.
 *
 *   1. It points every single-target emitter — `setWatchEmitter`,
 *      `setTerminalEmitters`, `setRunEmitters`, `setGitChangeEmitter`,
 *      `setAiEmitters` — at the window it has just made. Those are `let`-bound
 *      callbacks, not subscriber lists, so a second call would not *add* a
 *      listener, it would silently redirect the main window's filesystem,
 *      terminal, run and AI events into a diagram viewer that ignores them.
 *   2. Its `closed` handler runs `disposeAllSessions()`, `cancelAllRuns()` and
 *      `cancelAllAiStreams()` — global teardown. Reusing it would mean closing
 *      a diagram kills the user's shells and builds.
 *
 * So this file duplicates the handful of `BrowserWindow` options it needs and
 * shares nothing else. The tradeoff that buys: the floating window is a *view*,
 * not a second app instance. It receives exactly one event —
 * `visualizer:stateChanged`, pushed explicitly by the `visualizer:pushState`
 * handler — and no ambient service traffic at all.
 *
 * What it deliberately does *not* duplicate, confirmed by reading index.ts
 * rather than assuming:
 *
 *   - **CSP.** `installContentSecurityPolicy` registers on
 *     `session.defaultSession.webRequest.onHeadersReceived`. This window does
 *     not set `partition`, so it loads in the default session and gets the same
 *     policy header on every response.
 *   - **Navigation containment.** `installNavigationGuards` subscribes to
 *     `app.on('web-contents-created')`, which fires for *every* `webContents`
 *     the app ever creates. `will-navigate`, `setWindowOpenHandler` and
 *     `will-attach-webview` are therefore already installed on this window
 *     before its first load, with no wiring here.
 *
 * This module imports nothing from `index.ts` on purpose: `ipc.ts` imports this
 * file, so the reverse edge would close a cycle — and index.ts runs real
 * side effects at module scope (`protocol.registerSchemesAsPrivileged`, the
 * single-instance lock), which would fire inside the unit tests, where
 * `electron` is a recording stub. The cost is the two repeated constants below.
 */

/**
 * Repeated from `APP_ORIGIN` in index.ts, which owns the protocol registration.
 * Drift here is loud and immediate — the floating window comes up blank — so
 * the copy is cheaper than inverting the dependency to share it.
 */
const APP_ORIGIN = 'app://bettercallcompiler'

/** Wide enough for three layout layers plus the 280px inspector track. */
const DEFAULT_WIDTH = 1100
const DEFAULT_HEIGHT = 760

/**
 * Below this the inspector (280px) leaves the canvas too narrow to be one.
 * Lower than the main window's 940 because there is no activity bar, no side
 * bar and no editor competing for the width.
 */
const MIN_WIDTH = 640
const MIN_HEIGHT = 420

let visualizerWindow: BrowserWindow | null = null

/**
 * The window a floating diagram steers when a node is clicked.
 *
 * Click-to-source in the floating window is the one interaction that has to
 * cross back: the editor it wants to move lives in the other window entirely.
 * `event.sender` cannot supply this — it identifies the window that *asked*,
 * which here is precisely the wrong one — so the target is recorded when the
 * main window is created, the same single-target shape `setGitChangeEmitter`
 * and its siblings already use.
 */
let hostWindow: BrowserWindow | null = null

export function setVisualizerHostWindow(win: BrowserWindow | null): void {
  hostWindow = win
}

/** Null once the main window has gone, which is a no-op rather than an error. */
export function getVisualizerHostWindow(): BrowserWindow | null {
  if (hostWindow === null) return null
  if (hostWindow.isDestroyed()) {
    hostWindow = null
    return null
  }
  return hostWindow
}

/**
 * One HTML input, two boot modes.
 *
 * A second rollup input would mean a second `index.html`, a second copy of the
 * theme and Monaco bundles, and a second place to forget a script tag.
 * `?mode=visualizer` costs the renderer one branch at boot and keeps the two
 * windows byte-identical up to that branch.
 *
 * The query string cannot reach the packaged app's path confinement: the
 * `protocol.handle('app', …)` callback in index.ts resolves
 * `new URL(request.url).pathname` and nothing else, so `?mode=visualizer` lands
 * in `.search`, which that handler never reads. `isWithin(rendererRoot, …)`
 * still sees plain `/index.html`.
 */
function entryUrl(): string {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  const base =
    devServer !== undefined && devServer !== '' ? devServer : `${APP_ORIGIN}/index.html`
  return `${base}?mode=visualizer`
}

/**
 * Centred on the window the request came from, not on the display.
 *
 * The user's attention is already on the window whose button they clicked, and
 * on a multi-monitor setup Electron's default placement can land the diagram on
 * a screen they are not looking at. `Math.max(0, …)` keeps the window from
 * being pushed off the parent's top-left corner when the parent is narrower
 * than the diagram — normal at the main window's 940px minimum.
 */
function positionNear(parent: BrowserWindow | null): { x: number; y: number } | null {
  if (parent === null || parent.isDestroyed()) return null
  const bounds = parent.getBounds()
  return {
    x: bounds.x + Math.max(0, Math.round((bounds.width - DEFAULT_WIDTH) / 2)),
    y: bounds.y + Math.max(0, Math.round((bounds.height - DEFAULT_HEIGHT) / 2))
  }
}

/**
 * The live floating window, or null.
 *
 * The `isDestroyed()` branch is not redundant with the `closed` handler: a
 * window destroyed through `destroy()` rather than `close()` can be reached
 * before `closed` has run, and callers here are one `webContents.send` away
 * from a throw on a dead window.
 */
export function getVisualizerWindow(): BrowserWindow | null {
  if (visualizerWindow === null) return null
  if (visualizerWindow.isDestroyed()) {
    visualizerWindow = null
    return null
  }
  return visualizerWindow
}

/**
 * Creates the floating window, or raises the one that already exists.
 *
 * Never a second window: two floating diagrams would both be fed by
 * `visualizer:pushState` and the user would be looking at whichever one
 * happened to be on top. Returns whether a floating window is on screen after
 * the call, which is what the renderer's window-state control needs — it does
 * not distinguish "created" from "focused", because nothing in the UI does.
 *
 * `onLoaded` runs after every completed load of the new window, and is ignored
 * entirely when one is already open — attaching it here rather than at the call
 * site is what keeps a second `openFloating` from installing a second listener
 * and double-sending. "Every load", not "the first": a dev-server reload throws
 * the renderer's subscriptions away and needs the same treatment as a cold
 * start.
 */
export function openVisualizerWindow(
  parent: BrowserWindow | null,
  onLoaded: (win: BrowserWindow) => void
): boolean {
  const existing = getVisualizerWindow()
  if (existing !== null) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return true
  }

  const position = positionNear(parent)

  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    ...(position ?? {}),
    show: false,
    title: 'Visualizer — BetterCallCompiler',
    // The one place a colour has to be a literal: this paints the native
    // surface before any stylesheet exists, so `--bcc-bg` cannot reach it. Kept
    // equal to the main window's for the same reason it was chosen there.
    backgroundColor: '#1b1d23',
    // The application menu is global on Windows and its File entries act on the
    // main window's editor; sitting over a diagram they are just a row of
    // controls that do nothing. Alt still summons it.
    autoHideMenuBar: true,
    // Identical to `createWindow`'s, and that is the point — a second window
    // with a weaker sandbox would quietly become the softest target in the app.
    // Repeated rather than imported: see the header note on the import cycle.
    webPreferences: {
      preload: join(__dirname, '../preload/bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  // Same anti-flash treatment as the main window: an unpainted diagram window
  // is a white rectangle over a dark editor.
  win.once('ready-to-show', () => win.show())

  // Deliberately NOT the teardown `createWindow` installs. Closing a diagram
  // must not dispose terminals, cancel runs or kill AI streams — those belong
  // to the main window's lifetime. This handler owns exactly one reference.
  //
  // The identity test is not ceremony: a window destroyed outright emits
  // `closed` after `isDestroyed()` already reads true, so a reopen can slip in
  // between the two — and a bare `visualizerWindow = null` would then orphan
  // the window that just opened, leaving `pushState` silently dropping state at
  // a window the user is looking at.
  win.on('closed', () => {
    if (visualizerWindow === win) visualizerWindow = null
  })

  // `did-finish-load` rather than `dom-ready`: module scripts have executed by
  // the time `load` completes, so a listener registered at the renderer's top
  // level is already subscribed. A boot that defers its subscription behind an
  // await is still racing, and that is the renderer's call to make.
  win.webContents.on('did-finish-load', () => onLoaded(win))

  visualizerWindow = win
  void win.loadURL(entryUrl())

  return true
}

/**
 * Idempotent, and safe to call from inside a `closed` handler — the reference
 * is cleared before `close()` so a re-entrant call sees nothing to do.
 */
export function closeVisualizerWindow(): void {
  const win = visualizerWindow
  visualizerWindow = null
  if (win === null || win.isDestroyed()) return
  win.close()
}
