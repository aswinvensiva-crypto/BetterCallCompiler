import { BrowserWindow, app, ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import {
  ApertureServiceError,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  fail,
  formatIssues,
  ok,
  type EventChannel,
  type InvokeChannel,
  type PayloadOf,
  type RequestOf,
  type ResponseOf,
  type Result
} from '../shared/ipc-contract'
import {
  createDirectory,
  createFile,
  getWorkspace,
  openFolder,
  readDirectory,
  readFile,
  remove,
  rename,
  writeFile
} from './fs-service'
import {
  createSession,
  disposeSession,
  listSessions,
  resizeSession,
  writeToSession
} from './terminal'
import { listToolchains, rescanToolchains } from './toolchains'
import { cancelRun, startRun } from './runner'
import {
  branches as gitBranches,
  commit as gitCommit,
  diff as gitDiff,
  log as gitLog,
  stage as gitStage,
  startGitWatch,
  status as gitStatus,
  unstage as gitUnstage
} from './git-service'
import { clearSecret, hasSecret, isEncryptionAvailable, setSecret } from './secrets'
import { loadSettings, saveSettings } from './settings'

export type InvokeHandler<C extends InvokeChannel> = (
  request: RequestOf<C>,
  event: IpcMainInvokeEvent
) => Promise<ResponseOf<C>> | ResponseOf<C>

/**
 * A mapped type over every channel in the table, so omitting a handler — or
 * inventing one the table does not declare — is a *compile* error. The runtime
 * completeness test covers the same ground for anyone who bypasses tsc.
 */
export type HandlerMap = { readonly [C in InvokeChannel]: InvokeHandler<C> }

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

/**
 * Builds the implementation for every declared channel. Keeping the assembly in
 * one function is what makes the completeness test meaningful.
 */
export function createHandlerMap(): HandlerMap {
  return {
    'app:ping': () => ({
      pong: true,
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions['electron'] ?? 'unknown'
    }),

    // The `.git` watch is started here rather than inside `setWorkspace`,
    // because git-service already imports fs-service and the reverse import
    // would close the cycle.
    'fs:openFolder': async (_request, event) => {
      const workspace = await openFolder(BrowserWindow.fromWebContents(event.sender))
      if (workspace.root !== null) await startGitWatch(workspace.root)
      return workspace
    },

    'fs:getWorkspace': () => getWorkspace(),

    'fs:readDir': async (request) => ({ entries: await readDirectory(request.path) }),

    'fs:readFile': async (request) => ({ content: await readFile(request.path) }),

    'fs:writeFile': async (request) => {
      await writeFile(request.path, request.content)
      return { written: true }
    },

    'fs:createFile': async (request) => ({ node: await createFile(request.path) }),

    'fs:createDir': async (request) => ({ node: await createDirectory(request.path) }),

    'fs:rename': async (request) => ({ node: await rename(request.from, request.to) }),

    'fs:delete': async (request) => {
      await remove(request.path)
      return { deleted: true }
    },

    // A terminal opens in the workspace when there is one, so `ls` shows the
    // project rather than wherever the app happened to be launched from.
    'terminal:create': (request) => ({
      session: createSession({
        cols: request.cols,
        rows: request.rows,
        cwd: getWorkspace().root
      })
    }),

    'terminal:write': (request) => {
      writeToSession(request.id, request.data)
      return { written: true }
    },

    'terminal:resize': (request) => {
      resizeSession(request.id, request.cols, request.rows)
      return { resized: true }
    },

    'terminal:dispose': (request) => {
      disposeSession(request.id)
      return { disposed: true }
    },

    'terminal:list': () => ({ sessions: listSessions() }),

    'toolchain:list': async () => ({ toolchains: [...(await listToolchains())] }),

    'toolchain:rescan': async () => ({ toolchains: [...(await rescanToolchains())] }),

    'run:start': async (request) => ({ run: await startRun(request.path, request.languageId) }),

    'run:cancel': (request) => ({ cancelled: cancelRun(request.runId) }),

    'git:status': async () => ({ status: await gitStatus() }),

    'git:diff': async (request) => ({ diff: await gitDiff(request.path, request.staged) }),

    'git:stage': async (request) => {
      await gitStage(request.paths)
      return { staged: true }
    },

    'git:unstage': async (request) => {
      await gitUnstage(request.paths)
      return { unstaged: true }
    },

    'git:commit': async (request) => ({ commit: await gitCommit(request.message) }),

    'git:branches': async () => ({ branches: await gitBranches() }),

    'git:log': async (request) => ({ commits: await gitLog(request.limit) }),

    'secrets:setKey': async (request) => {
      await setSecret(request.key, request.value)
      return { secrets: await secretsState() }
    },

    'secrets:hasKey': async () => ({ secrets: await secretsState() }),

    'secrets:clearKey': async (request) => {
      await clearSecret(request.key)
      return { secrets: await secretsState() }
    },

    'settings:get': async () => ({ settings: await loadSettings() }),

    'settings:set': async (request) => {
      const settings = await saveSettings(request.patch)
      return { settings }
    }
  }
}

/**
 * Presence only — never the values. This is the shape the renderer is allowed
 * to know about secrets.
 */
async function secretsState(): Promise<{
  anthropic: boolean
  github: boolean
  encryptionAvailable: boolean
}> {
  return {
    anthropic: await hasSecret('anthropic'),
    github: await hasSecret('github'),
    encryptionAvailable: isEncryptionAvailable()
  }
}

/**
 * Wraps every handler in: parse request → run → parse response → wrap in Result.
 *
 * Response validation is not paranoia about the renderer, it is a guard against
 * *us*: a handler that quietly returns the wrong shape would otherwise surface
 * as a confusing failure deep in renderer code, far from the cause.
 *
 * Returns the channels it registered so tests can diff against the table.
 */
export function registerIpcHandlers(
  handlers: HandlerMap,
  ipc: IpcMain = ipcMain
): readonly InvokeChannel[] {
  const registered: InvokeChannel[] = []

  for (const channel of Object.keys(INVOKE_CHANNELS) as InvokeChannel[]) {
    const spec = INVOKE_CHANNELS[channel]
    const handler = handlers[channel]

    // Re-registering the same channel throws in Electron; make this idempotent
    // so a hot reload in dev cannot wedge the app.
    ipc.removeHandler(channel)

    ipc.handle(
      channel,
      async (event: IpcMainInvokeEvent, rawRequest: unknown): Promise<Result<unknown>> => {
        const request = spec.request.safeParse(rawRequest)
        if (!request.success) {
          return fail('BAD_REQUEST', `${channel}: ${formatIssues(request.error)}`)
        }

        let produced: unknown
        try {
          // The union of handler signatures cannot be called with the union of
          // request types without narrowing per channel; the schemas above are
          // the real guarantee, so this cast is safe and contained.
          produced = await (handler as InvokeHandler<InvokeChannel>)(
            request.data as RequestOf<InvokeChannel>,
            event
          )
        } catch (error) {
          // Services throw ApertureServiceError to name a specific failure;
          // anything else is an unexpected bug and stays generic.
          if (error instanceof ApertureServiceError) {
            return fail(error.code, error.message)
          }
          return fail('HANDLER_FAILED', `${channel}: ${describeError(error)}`)
        }

        const response = spec.response.safeParse(produced)
        if (!response.success) {
          return fail('BAD_RESPONSE', `${channel}: ${formatIssues(response.error)}`)
        }

        return ok(response.data as ResponseOf<InvokeChannel>)
      }
    )

    registered.push(channel)
  }

  return registered
}

/**
 * Pushes a main → renderer event, validating the payload on the way out for the
 * same reason responses are validated: to catch our own drift at the source.
 */
export function emitEvent<C extends EventChannel>(
  window: BrowserWindow,
  channel: C,
  payload: PayloadOf<C>
): void {
  const parsed = EVENT_CHANNELS[channel].payload.safeParse(payload)
  if (!parsed.success) {
    console.error(`refusing to emit malformed ${channel}: ${formatIssues(parsed.error)}`)
    return
  }
  if (window.isDestroyed()) return
  window.webContents.send(channel, parsed.data)
}
