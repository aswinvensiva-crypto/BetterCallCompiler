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
import { setWatchEmitter, setWorkspace, stopWatching } from './fs-service'
import { createHandlerMap, emitEvent, registerIpcHandlers } from './ipc'
import { disposeAllSessions, setTerminalEmitters } from './terminal'
import { cancelAllRuns, setRunEmitters } from './runner'
import { setGitChangeEmitter, startGitWatch, stopGitWatch } from './git-service'
import { cancelAllAiStreams, setAiEmitters } from './ai-service'
import { buildCspHeader, isAllowedExternalUrl, isInternalNavigation } from './security'

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

/** Origin the packaged renderer is served from. See `installAppProtocol`. */
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
  setWatchEmitter((event) => emitEvent(win, 'fs:watchEvent', event))
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

  // Orphaned shells and half-finished builds outlive the window unless every
  // child is reaped explicitly.
  win.on('closed', () => {
    disposeAllSessions()
    cancelAllRuns()
    cancelAllAiStreams()
  })

  const devUrl = devServerUrl()
  if (devUrl !== undefined) {
    void win.loadURL(devUrl)
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`)
  }

  win.on('closed', () => {
    mainWindow = null
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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  // A live chokidar watcher keeps handles open and can hold the process up.
  app.on('will-quit', () => {
    disposeAllSessions()
    cancelAllRuns()
    cancelAllAiStreams()
    void stopWatching()
    void stopGitWatch()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
