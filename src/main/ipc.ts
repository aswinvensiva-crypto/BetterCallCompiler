import { BrowserWindow, app, ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import {
  BetterCallCompilerServiceError,
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
  closeDocument as closeCompilerDocument,
  codeActionsAt as compilerCodeActionsAt,
  compilerPasses,
  compilerStatus,
  definitionAt as compilerDefinitionAt,
  dependentsOf as compilerDependentsOf,
  diagnosticsFor,
  openDocument as openCompilerDocument,
  referencesAt as compilerReferencesAt,
  renameAt as compilerRenameAt,
  restartCompiler,
  startCompiler
} from './compiler-service'
import { isBccPath } from '../shared/lang-diagnostics'
import {
  closeLangDocument,
  langDefinition,
  langDocumentSymbols,
  langHover,
  langReferences,
  langRename,
  openLangDocument,
  restartLang,
  startLang
} from './lang-service'
import {
  applyWorkspaceEdit,
  createDirectory,
  createFile,
  getWorkspace,
  openFolder,
  languageBreakdown,
  listFiles,
  readDirectory,
  readFile,
  searchWorkspace,
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
import {
  anchorStates,
  commentOnArtifact,
  createArtifact,
  linkCommentReply,
  listArtifacts,
  readArtifact
} from './artifact-store'
import { startExplain } from './explain-service'
import { isWasmAssetName, readWasmAsset } from './wasm-assets'
import { listToolchains, rescanToolchains } from './toolchains'
import { cancelRun, startRun } from './runner'
import {
  branches as gitBranches,
  commit as gitCommit,
  diff as gitDiff,
  log as gitLog,
  repositoryStats as gitStats,
  stage as gitStage,
  startGitWatch,
  status as gitStatus,
  unstage as gitUnstage
} from './git-service'
import { clearInsightsCache, fetchInsights } from './github-service'
import { clearSecret, hasSecret, isEncryptionAvailable, setSecret } from './secrets'
import { loadSettings, saveSettings } from './settings'
import { cancelAiStream, startAiStream } from './ai-service'
import { applyAiEdit, readAiLog, revertAiEdit } from './ai-log'
import {
  closeVisualizerWindow,
  getVisualizerHostWindow,
  getVisualizerWindow,
  openVisualizerWindow
} from './visualizer-window'

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

/**
 * The last state pushed at the Visualizer, replayed when the floating window
 * finishes loading.
 *
 * Without it, the obvious way to write a pop-out button — open the window, push
 * the current graph — loses that push every time: the new window's renderer has
 * not run yet, so nothing is subscribed to `visualizer:stateChanged` and the
 * send lands nowhere. The window then sits empty until the user happens to edit
 * something, which looks exactly like a broken feature. Buffering one value
 * costs one graph of memory and removes the need for a readiness handshake that
 * every later push would have to be sequenced behind.
 *
 * Kept across a close/reopen on purpose, so reopening paints immediately.
 */
let lastVisualizerState: RequestOf<'visualizer:pushState'> | null = null

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

/**
 * Tells whoever asked that the artifact list has moved.
 *
 * Sent back to the window that made the request rather than broadcast. Every
 * artifact mutation originates in a renderer, so `event.sender` is exactly the
 * surface that needs to re-read — and a broadcast would also wake the floating
 * visualizer window, which has no artifact view to update.
 */
function notifyArtifactsChanged(event: IpcMainInvokeEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window !== null) emitEvent(window, 'artifact:changed', {})
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
      // Not awaited: the daemon indexes in the background, and blocking the
      // open-folder response on it would stall the explorer behind a full walk.
      startCompiler(workspace.root)
      startLang(workspace.root)
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

    'fs:listFiles': async () => ({ files: await listFiles() }),

    'fs:languageBreakdown': async () => ({ breakdown: await languageBreakdown() }),

    'fs:search': async (request) => ({
      matches: await searchWorkspace({
        query: request.query,
        caseSensitive: request.caseSensitive,
        isRegex: request.isRegex
      })
    }),

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

    'git:stats': async () => ({ stats: await gitStats() }),

    'github:insights': async (request) => {
      if (request.force) clearInsightsCache()
      return { insights: await fetchInsights(request.force) }
    },

    'secrets:setKey': async (request) => {
      await setSecret(request.key, request.value)
      // A new GitHub PAT invalidates whatever the previous token fetched.
      if (request.key === 'github') clearInsightsCache()
      return { secrets: await secretsState() }
    },

    'secrets:hasKey': async () => ({ secrets: await secretsState() }),

    'secrets:clearKey': async (request) => {
      await clearSecret(request.key)
      if (request.key === 'github') clearInsightsCache()
      return { secrets: await secretsState() }
    },

    'settings:get': async () => ({ settings: await loadSettings() }),

    'settings:set': async (request) => {
      const settings = await saveSettings(request.patch)
      // `githubUser` decides whose calendar is shown, so a cached response for
      // the previous user would survive the change otherwise.
      clearInsightsCache()
      return { settings }
    },

    'ai:start': async (request) => ({
      started: await startAiStream(request.mode, request.context)
    }),

    'ai:cancel': (request) => ({ cancelled: cancelAiStream(request.streamId) }),

    'ai:apply': async (request) => ({
      entry: await applyAiEdit({
        path: request.path,
        content: request.content,
        mode: request.mode,
        model: request.model,
        promptHash: request.promptHash,
        range: request.range
      })
    }),

    'ai:revert': async (request) => ({ entry: await revertAiEdit(request.id) }),

    'ai:log': async () => ({ entries: await readAiLog() }),

    // The sender is the parent for *positioning only* — the same way
    // `fs:openFolder` hands the dialog a window to sit over. Passing it as
    // Electron's `parent` option would make the diagram permanently on top of
    // the editor, which is the opposite of what a second window is for.
    'visualizer:openFloating': (_request, event) => ({
      opened: openVisualizerWindow(BrowserWindow.fromWebContents(event.sender), (floating) => {
        if (lastVisualizerState !== null) {
          emitEvent(floating, 'visualizer:stateChanged', lastVisualizerState)
        }
      })
    }),

    'visualizer:closeFloating': () => {
      closeVisualizerWindow()
      return {}
    },

    // Relay, not broadcast: `emitEvent` targets one window and skips a
    // destroyed one, and with no floating window this does nothing at all. The
    // renderer pushes on every graph change without knowing whether anyone is
    // listening, which is the only way it can avoid tracking a window lifetime
    // that main owns.
    //
    // The state is validated twice on the way through — once as this request,
    // once as the event payload — which for a large graph is two deep parses
    // and two freezes per push. That is the price of the table being the only
    // thing either side trusts, and it is paid per graph change, not per frame.
    'visualizer:pushState': (request) => {
      lastVisualizerState = request
      const floating = getVisualizerWindow()
      if (floating !== null) emitEvent(floating, 'visualizer:stateChanged', request)
      return {}
    },

    // The return leg. `event.sender` is deliberately not consulted: it is the
    // floating window, and the editor this has to move is in the other one.
    // A closed main window makes this a no-op rather than an error — the
    // floating window has no way to know it has been orphaned, and telling it
    // would only give it something it cannot act on.
    'visualizer:requestReveal': (request) => {
      const host = getVisualizerHostWindow()
      if (host !== null) emitEvent(host, 'visualizer:revealRequested', request)
      return {}
    },

    /* ------------------------------ compiler ------------------------------ */

    'compiler:status': () => ({ status: compilerStatus() }),
    'compiler:diagnostics': (request) => ({ files: diagnosticsFor(request.relativePath) }),
    'compiler:dependents': async (request) => ({
      graph: await compilerDependentsOf(request.relativePath, request.from)
    }),
    // Routed by extension rather than given its own channel. A `.bcc` buffer
    // and a `.ts` buffer are the same event to the editor, and adding a second
    // pair of channels would mean the renderer had to know which compiler owns
    // a file — which is exactly the knowledge this design keeps out of it.
    'compiler:openDocument': (request) => {
      if (isBccPath(request.relativePath)) {
        openLangDocument(request.relativePath, request.content, request.version)
      } else {
        openCompilerDocument(request.relativePath, request.content, request.version)
      }
      return { accepted: true as const }
    },
    'compiler:closeDocument': (request) => {
      if (isBccPath(request.relativePath)) closeLangDocument(request.relativePath)
      else closeCompilerDocument(request.relativePath)
      return { closed: true as const }
    },
    'compiler:restart': () => {
      restartCompiler()
      restartLang()
      return { restarted: true as const }
    },
    'compiler:passes': () => ({ passes: compilerPasses() }),

    /* ----------------------------- navigation ----------------------------- */

    // Routed by extension, exactly as openDocument is. Two compilers, one
    // channel, and a renderer that never learns which of them answered.
    'compiler:definition': async (request) =>
      isBccPath(request.relativePath)
        ? await langDefinition(request.relativePath, request.offset, request.overlay)
        : await compilerDefinitionAt(request.relativePath, request.offset, request.overlay),

    'compiler:references': async (request) =>
      isBccPath(request.relativePath)
        ? await langReferences(request.relativePath, request.offset, request.overlay)
        : await compilerReferencesAt(request.relativePath, request.offset, request.overlay),

    'compiler:rename': async (request) =>
      isBccPath(request.relativePath)
        ? await langRename(
            request.relativePath,
            request.offset,
            request.newName,
            request.overlay
          )
        : await compilerRenameAt(
            request.relativePath,
            request.offset,
            request.newName,
            request.overlay
          ),

    // BCC has no quick fixes yet — its diagnostics carry no fix data, and
    // inventing one here would be a second compiler's opinion about a language
    // this one owns. TypeScript's come from `getCodeFixesAtPosition`.
    'compiler:codeActions': async (request) =>
      isBccPath(request.relativePath)
        ? { actions: [] }
        : await compilerCodeActionsAt(
            request.relativePath,
            request.offset,
            request.endOffset,
            request.diagnosticCodes,
            request.overlay
          ),

    // Language-agnostic on purpose: an edit is an edit, and which compiler
    // produced it stops mattering once it is a range and a string.
    'compiler:applyWorkspaceEdit': async (request) => ({
      written: await applyWorkspaceEdit(request.files)
    }),

    'compiler:documentSymbols': async (request) =>
      isBccPath(request.relativePath)
        ? await langDocumentSymbols(request.relativePath, request.overlay)
        : { symbols: [] },

    'compiler:hover': async (request) =>
      isBccPath(request.relativePath)
        ? await langHover(request.relativePath, request.offset, request.overlay)
        : { contents: null, range: null },

    /* ------------------------------ artifacts ----------------------------- */

    'explain:start': async (request) => ({
      started: await startExplain({
        context: request.context,
        // Read here rather than sent by the renderer: the prior artifact is the
        // stored record, and letting the caller supply its text would let the
        // document a revision claims to revise differ from the one on disk.
        priorArtifact: request.supersedes === null ? null : await readArtifact(request.supersedes),
        question: request.question
      })
    }),

    'artifact:list': async () => ({ artifacts: await listArtifacts() }),

    'artifact:get': async (request) => ({
      artifact: await readArtifact(request.id),
      anchorStates: (await anchorStates(request.id)) as Record<
        string,
        'current' | 'stale' | 'missing'
      >
    }),

    'artifact:create': async (request, event) => {
      const artifact = await createArtifact({
        kind: request.kind,
        title: request.title,
        model: request.model,
        promptHash: request.promptHash,
        contextSent: request.contextSent,
        markdown: request.markdown,
        supersedes: request.supersedes
      })

      // Linked after the reply exists, so a crash between the two leaves an
      // unanswered comment rather than a comment pointing at nothing.
      if (request.supersedes !== null && request.answersCommentId !== null) {
        await linkCommentReply(request.supersedes, request.answersCommentId, artifact.id)
      }

      notifyArtifactsChanged(event)
      return { artifact }
    },

    'artifact:comment': async (request, event) => {
      const artifact = await commentOnArtifact(request.id, request.sectionId, request.body)
      notifyArtifactsChanged(event)
      return { artifact }
    },

    /* -------------------------------- wasm -------------------------------- */

    'wasm:read': async (request) => {
      // Checked against the allow-list here rather than inside the reader, so an
      // unknown name is rejected before it reaches any filesystem call at all.
      if (!isWasmAssetName(request.name)) {
        throw new BetterCallCompilerServiceError(
          'BAD_REQUEST',
          `unknown WebAssembly asset: ${request.name}`
        )
      }
      return { base64: await readWasmAsset(request.name) }
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
          // Services throw BetterCallCompilerServiceError to name a specific failure;
          // anything else is an unexpected bug and stays generic.
          if (error instanceof BetterCallCompilerServiceError) {
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
