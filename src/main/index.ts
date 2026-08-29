import {
  app,
  BrowserWindow,
  Menu,
  net,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isWithin } from './fs-service'
import { getWorkspace, setWatchEmitter, setWorkspace, stopWatching } from './fs-service'
import { createHandlerMap, emitEvent, registerIpcHandlers } from './ipc'
import { disposeAllSessions, setTerminalEmitters } from './terminal'
import { cancelAllRuns, setRunEmitters } from './runner'
import { setGitChangeEmitter, startGitWatch, stopGitWatch } from './git-service'
import {
  compilerStatus,
  notifyWatchEvent,
  setCompilerEmitters,
  startCompiler,
  stopCompiler
} from './compiler-service'
import {
  notifyLangWatchEvent,
  setLangEmitters,
  startLang,
  stopLang
} from './lang-service'
import { cancelAllAiStreams, setAiEmitters } from './ai-service'
import { buildCspHeader, isAllowedExternalUrl, isInternalNavigation } from './security'
import { closeVisualizerWindow, setVisualizerHostWindow } from './visualizer-window'

/**
 * "Dev" means *served by the Vite dev server*, not merely "not packaged".
 *
 * `!app.isPackaged` is the tempting test and it is wrong: running the built
 * bundle directly — which is exactly what the E2E suite does — is unpackaged
 * but has no dev server, and would silently get the relaxed CSP. That made the
 * "Monaco raises no CSP violations" test pass against a policy the shipped app
 * never uses. Keying off the dev-server URL means tests exercise the real
 * production policy.
 */
function isDevServerMode(): boolean {
  return devServerUrl() !== undefined
}

/** Directory containing the built renderer (out/renderer) in a packaged app. */
const rendererRoot = join(__dirname, '../renderer')

/**
 * Origin the packaged renderer is served from. See `installAppProtocol`.
 *
 * `visualizer-window.ts` repeats this string rather than importing it: `ipc.ts`
 * imports that module, so the edge back to here would close a cycle *and* pull
 * this file's module-scope side effects into the unit tests. Change one, change
 * the other — the failure is a blank floating window, not a silent one.
 */
const APP_ORIGIN = 'app://bettercallcompiler'

/**
 * The renderer is served over a custom scheme rather than `file://`.
 *
 * A `file://` document has the opaque origin `null`, and `script-src 'self'`
 * matches nothing against it — while Chromium separately refuses to start web
 * workers from `file://`. Monaco is worker-driven, so `file://` plus the
 * required CSP plus a working editor is not a satisfiable set. Registering a
 * standard, secure scheme gives the renderer a real origin that `'self'`
 * resolves against, and workers load normally.
 *
 * Must run before `app.whenReady()`, which is why it is at module scope.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

/** electron-vite injects this in dev; it is absent in a packaged build. */
function devServerUrl(): string | undefined {
  const url = process.env['ELECTRON_RENDERER_URL']
  return url !== undefined && url !== '' ? url : undefined
}

let mainWindow: BrowserWindow | null = null

/**
 * `bettercallcompiler --folder=<path>` opens a workspace at launch, the same affordance
 * `code <dir>` provides. It is also what lets E2E tests open a fixture folder
 * without driving a native dialog.
 */
export function folderFromArgv(argv: readonly string[]): string | undefined {
  const prefix = '--folder='
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length)
      if (value !== '') return value
    }
  }
  return undefined
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'BetterCallCompiler',
    backgroundColor: '#1b1d23',
    webPreferences: {
      preload: join(__dirname, '../preload/bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  // Avoid a white flash: only reveal once the first frame is painted.
  win.once('ready-to-show', () => win.show())

  // Filesystem watch events are pushed to whichever window is current.
  // One watcher, two consumers. `setWatchEmitter` is a single slot, so the
  // compiler daemon is fanned out from here rather than starting a second
  // chokidar over the same tree.
  setWatchEmitter((event) => {
    emitEvent(win, 'fs:watchEvent', event)
    notifyWatchEvent(event)
    notifyLangWatchEvent(event)
  })
  setCompilerEmitters(
    (batch) => emitEvent(win, 'compiler:diagnosticsChanged', batch),
    (status) => emitEvent(win, 'compiler:statusChanged', status),
    (pass) => emitEvent(win, 'compiler:passCompleted', pass)
  )
  // Started here, not where the argv folder is adopted: that runs before this
  // window exists, so a daemon booted there would emit its first status into a
  // null emitter and the renderer would never learn it had started.
  // Both diagnostics streams land on the SAME renderer event. That is the
  // whole integration: the Problems panel, the markers and the status bar
  // cannot tell which compiler produced a row, and none of them changed.
  setLangEmitters(
    (batch) => emitEvent(win, 'compiler:diagnosticsChanged', batch),
    () => emitEvent(win, 'compiler:statusChanged', compilerStatus())
  )
  startCompiler(getWorkspace().root)
  startLang(getWorkspace().root)
  setTerminalEmitters(
    (id, data) => emitEvent(win, 'terminal:data', { id, data }),
    (payload) => emitEvent(win, 'terminal:exit', payload)
  )
  setRunEmitters(
    (payload) =>
      emitEvent(win, payload.stream === 'stdout' ? 'run:stdout' : 'run:stderr', payload),
    (payload) => emitEvent(win, 'run:exit', payload)
  )
  setGitChangeEmitter(() => emitEvent(win, 'git:changed', {}))
  setAiEmitters(
    (payload) => emitEvent(win, 'ai:delta', payload),
    (payload) => emitEvent(win, 'ai:done', payload)
  )

  // Click-to-source in a floating diagram has to steer *this* window's editor,
  // and the IPC handler cannot work that out for itself: the request arrives
  // from the floating window, so `event.sender` names the one window that must
  // not receive it.
  setVisualizerHostWindow(win)

  // Orphaned shells and half-finished builds outlive the window unless every
  // child is reaped explicitly. This is global teardown keyed to the *main*
  // window's lifetime, which is why `visualizer-window.ts` installs its own
  // `closed` handler instead of reusing this one — closing a diagram must not
  // kill the user's terminals, builds and AI streams.
  win.on('closed', () => {
    disposeAllSessions()
    cancelAllRuns()
    cancelAllAiStreams()
    stopCompiler()
    stopLang()
  })

  const devUrl = devServerUrl()
  if (devUrl !== undefined) {
    void win.loadURL(devUrl)
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`)
  }

  win.on('closed', () => {
    mainWindow = null
    setVisualizerHostWindow(null)
    // A floating Visualizer that outlives its editor is a window with nothing
    // behind it: it cannot be re-fed (`visualizer:pushState` comes from the
    // main window) and on non-darwin it would hold `window-all-closed` back,
    // leaving a running app the user has no way to reach. Closing it here means
    // that state cannot be reached rather than being handled after the fact.
    closeVisualizerWindow()
  })

  return win
}

/**
 * CSP is delivered as a response header rather than a `<meta>` tag. A meta tag
 * would have to be baked into index.html, where it applies identically in dev
 * and production — and the strict production policy (`connect-src 'none'`)
 * blocks Vite's HMR websocket, so dev would break. Headers let the packaged app
 * carry the exact required policy while dev gets a documented relaxation.
 */
function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCspHeader(isDevServerMode())]
      }
    })
  })
}

/**
 * Navigation containment. `will-navigate` covers in-page navigations (a link,
 * a location assignment); `setWindowOpenHandler` covers window.open and
 * target=_blank. Both deny by default; external https links are handed to the
 * OS browser instead of being opened inside the app.
 */
/**
 * Serves the built renderer from `app://bettercallcompiler/...`.
 *
 * Every request is resolved against the renderer directory and confined to it,
 * so a crafted `app://bettercallcompiler/../../..` cannot be used to read the user's disk
 * through the very origin we just declared trusted.
 */
function installAppProtocol(): void {
  protocol.handle('app', async (request) => {
    let requestPath: string
    try {
      // `.pathname` only — never `request.url` whole, and never `.search`. That
      // is what lets the floating window load `/index.html?mode=visualizer`
      // through this handler: the query is invisible to the confinement check
      // below, so it can neither widen nor confuse it.
      requestPath = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }

    const target = join(rendererRoot, requestPath)
    if (!isWithin(rendererRoot, target)) {
      return new Response('forbidden', { status: 403 })
    }

    return await net.fetch(pathToFileURL(target).toString())
  })
}

function installNavigationGuards(): void {
  app.on('web-contents-created', (_event, contents) => {
    const ctx = { devServerOrigin: devServerUrl(), appOrigin: APP_ORIGIN, rendererRoot }

    contents.on('will-navigate', (event, url) => {
      if (!isInternalNavigation(url, ctx)) {
        event.preventDefault()
        if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      }
    })

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // webviewTag is already false; refuse attachment as belt-and-braces.
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { id: 'file.openFolder', label: 'Open Folder…', accelerator: 'CmdOrCtrl+K CmdOrCtrl+O', enabled: false },
        { id: 'file.save', label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: false },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'BetterCallCompiler on GitHub',
          click: () => {
            const url = 'https://github.com/'
            if (isAllowedExternalUrl(url)) void shell.openExternal(url)
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// A second launch should focus the existing window rather than start a rival
// instance that would fight over the same workspace and PTY pool.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.bettercallcompiler.ide')
    installAppProtocol()
    installContentSecurityPolicy()
    installNavigationGuards()
    registerIpcHandlers(createHandlerMap())
    buildMenu()

    // Adopt a folder from argv *before* the window exists, so the renderer's
    // first `fs:getWorkspace` already sees it and the explorer never flashes
    // its empty state.
    const requestedFolder = folderFromArgv(process.argv)
    if (requestedFolder !== undefined) {
      try {
        await setWorkspace(requestedFolder)
        await startGitWatch(requestedFolder)
      } catch (error) {
        console.error(`could not open ${requestedFolder}:`, error)
      }
    }

    mainWindow = createWindow()

    // The test used to be `getAllWindows().length === 0`, which was only ever
    // correct while one window existed. A floating Visualizer keeps that count
    // above zero, so on macOS — where closing the editor does not quit — the
    // dock icon would stop bringing the editor back for as long as a diagram
    // was open. Ask about the window we actually mean.
    app.on('activate', () => {
      if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow()
    })
  })

  // A live chokidar watcher keeps handles open and can hold the process up.
  app.on('will-quit', () => {
    disposeAllSessions()
    cancelAllRuns()
    cancelAllAiStreams()
    stopCompiler()
    stopLang()
    void stopWatching()
    void stopGitWatch()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
