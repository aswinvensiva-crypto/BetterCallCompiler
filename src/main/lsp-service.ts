import { relative, sep } from 'node:path'
import { fromFileUri, toDiagnosticMessage } from '../shared/lsp-protocol'
import {
  isServedByLsp,
  LSP_SERVERS,
  serverForLanguage,
  serverForPath,
  type LspServerSpec
} from '../shared/lsp-registry'
import type { FileDiagnostics, SourceRange } from '../shared/types'
import { publishDiagnostics } from './diagnostic-store'
import { createLspClient, type LspClient, type LspTransport, type LspTransportFactory } from './lsp-client'
import { findOnPath, spawnExecutable } from './toolchains'

/**
 * Which language servers run, when they start, and what happens when they die.
 *
 * The split matches `lang-service.ts` / `lang-worker.ts`: the client below owns
 * the protocol, this owns the lifecycle. The reason to separate them is the
 * same one that made the client testable — a supervisor mixed into a protocol
 * implementation can only be tested by running the protocol.
 *
 * ## Servers start lazily, and that is the whole cost model
 *
 * rust-analyzer indexing a crate is minutes of CPU and a gigabyte of memory.
 * Starting all four servers at boot on the chance a file might be opened would
 * make this editor the slowest thing on the machine for a workspace with no
 * Rust in it. So a server starts when a document it handles is first opened,
 * and never otherwise.
 *
 * ## A missing server is a normal answer, not a failure
 *
 * Nobody has pyright, clangd, gopls and rust-analyzer all installed. The
 * absence is reported once, with the install hint from the registry, and the
 * editor carries on — the same shape `planRun` uses for a missing toolchain. An
 * error dialogue for "you do not write Rust" would be worse than useless.
 */

/* -------------------------------------------------------------------------- */
/*  Restart policy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The same numbers as the other two supervisors, deliberately.
 *
 * A server that dies three times in a minute is not going to work on the fourth
 * attempt, and retrying forever turns a broken install into a fork bomb that
 * looks like the editor being slow.
 */
const RESTART_BUDGET = 3
const RESTART_WINDOW_MS = 60_000
const RESTART_BACKOFF_MS = [500, 2_000, 5_000] as const

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

interface Session {
  readonly spec: LspServerSpec
  client: LspClient | null
  /** Buffers this server has been told about, replayed after a restart. */
  readonly documents: Map<string, { languageId: string; text: string; version: number }>
  restarts: number[]
  failure: string | null
  /**
   * Whether a process was ever obtained for this server.
   *
   * A session exists as soon as a document names the server, which happens
   * before anything is spawned — so the session's presence proves nothing about
   * the binary. This does, and it is what lets `lspStatus` answer "installed"
   * from what the service DID rather than from what is on PATH right now.
   */
  started: boolean
}

const sessions = new Map<string, Session>()

let workspaceRoot: string | null = null
let transportFactory: LspTransportFactory | null = null
let emitDiagnostics: ((files: readonly FileDiagnostics[]) => void) | null = null
let emitNotice: ((notice: string) => void) | null = null

/** Reported once per server, so a missing binary is not a log every keystroke. */
const announced = new Set<string>()

export function setLspEmitters(
  onDiagnostics: (files: readonly FileDiagnostics[]) => void,
  onNotice: (notice: string) => void
): void {
  emitDiagnostics = onDiagnostics
  emitNotice = onNotice
}

/** Injected so the supervisor can be tested without spawning a process. */
export function setLspTransportFactory(factory: LspTransportFactory | null): void {
  transportFactory = factory
}

export function startLsp(root: string): void {
  workspaceRoot = root
}

export async function stopLsp(): Promise<void> {
  const running = [...sessions.values()].map((session) => session.client).filter(isClient)
  sessions.clear()
  announced.clear()
  workspaceRoot = null
  await Promise.all(running.map((client) => client.stop()))
}

function isClient(client: LspClient | null): client is LspClient {
  return client !== null
}

/* -------------------------------------------------------------------------- */
/*  Status                                                                     */
/* -------------------------------------------------------------------------- */

export interface LspServerStatus {
  readonly id: string
  readonly displayName: string
  readonly languageIds: readonly string[]
  /** Whether the command was found on PATH. */
  readonly installed: boolean
  /** Whether a process is running and past its handshake. */
  readonly ready: boolean
  /** Why it is not usable, when it is not. */
  readonly detail: string | null
}

/**
 * Every known server and where it stands.
 *
 * All four are listed whether or not they are installed, because "we support
 * Go, you do not have gopls" is the useful answer and an empty list is not.
 */
export function lspStatus(): readonly LspServerStatus[] {
  return LSP_SERVERS.map((spec) => {
    const session = sessions.get(spec.id)
    /*
     * What the service actually managed, before what is on PATH.
     *
     * `findOnPath` is the fallback rather than the authority: a server we have
     * already run is installed whatever a later PATH lookup says, and the
     * transport can be injected, in which case PATH is not the thing that
     * decided anything.
     */
    const installed = session?.started === true || findOnPath(spec.command) !== null

    return {
      id: spec.id,
      displayName: spec.displayName,
      languageIds: spec.languageIds,
      installed,
      ready: session?.client?.ready() ?? false,
      /*
       * A recorded failure OUTRANKS the install hint, and getting that
       * backwards is what CI caught. "clangd exited three times and will not be
       * restarted" is specific and actionable; "install clangd" is neither when
       * clangd is what just died. The first version checked `installed` first,
       * so on a machine without the binary on PATH the hint hid the real
       * failure entirely — and it passed locally only because this sandbox
       * happens to have pyright installed.
       */
      detail: session?.failure ?? (installed ? null : spec.installHint)
    }
  })
}

/* -------------------------------------------------------------------------- */
/*  Spawning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A real child process as an `LspTransport`.
 *
 * `spawnExecutable` rather than `spawn` because it already handles the Windows
 * batch-shim case, and that is not hypothetical here: pyright installs as
 * `pyright-langserver.cmd` on Windows, and spawning a `.cmd` directly fails
 * with EINVAL under Node's default settings.
 */
function spawnTransport(spec: LspServerSpec, root: string): LspTransport | null {
  const resolved = findOnPath(spec.command)
  if (resolved === null) return null

  const child = spawnExecutable(resolved, spec.args, { cwd: root })

  return {
    write(bytes) {
      // A server that has already exited leaves a destroyed stdin; writing to
      // it throws EPIPE, which would surface as an unhandled rejection rather
      // than as the restart it actually is.
      if (child.stdin?.writable === true) child.stdin.write(bytes)
    },
    onData(handler) {
      child.stdout?.on('data', (chunk: Buffer) => handler(chunk))
    },
    onStderr(handler) {
      child.stderr?.on('data', (chunk: Buffer) => handler(chunk.toString('utf8')))
    },
    onExit(handler) {
      child.on('exit', (code, signal) => handler(code, signal))
    },
    kill() {
      child.kill()
    }
  }
}

function sessionFor(spec: LspServerSpec): Session {
  const existing = sessions.get(spec.id)
  if (existing !== undefined) return existing

  const created: Session = {
    spec,
    client: null,
    documents: new Map(),
    restarts: [],
    failure: null,
    started: false
  }
  sessions.set(spec.id, created)
  return created
}

/**
 * Start a server if it is not already running.
 *
 * Returns the client, or null when the server cannot run — not installed, or
 * out of restart budget. Callers treat null as "no language support here",
 * which is the same thing the editor did before this workstream.
 */
function ensureRunning(spec: LspServerSpec): LspClient | null {
  const root = workspaceRoot
  if (root === null) return null

  const session = sessionFor(spec)
  if (session.client !== null) return session.client
  if (session.failure !== null) return null

  const factory = transportFactory ?? ((s, r) => spawnTransport(s, r) as LspTransport)
  const transport = factory(spec, root) as LspTransport | null

  if (transport === null || transport === undefined) {
    if (!announced.has(spec.id)) {
      announced.add(spec.id)
      emitNotice?.(`${spec.displayName} is not installed. ${spec.installHint}`)
    }
    return null
  }

  const client = createLspClient(spec, root, transport, {
    onDiagnostics: (uri, diagnostics) => publish(spec, uri, diagnostics),
    onNotice: (notice) => emitNotice?.(notice),
    onExit: (code, signal) => handleExit(session, code, signal)
  })

  session.client = client
  session.started = true
  return client
}

function handleExit(session: Session, code: number | null, signal: string | null): void {
  session.client = null

  const now = Date.now()
  session.restarts = session.restarts.filter((at) => now - at < RESTART_WINDOW_MS)

  if (session.restarts.length >= RESTART_BUDGET) {
    session.failure = `${session.spec.displayName} exited ${RESTART_BUDGET} times in a minute and will not be restarted`
    emitNotice?.(session.failure)
    // Its diagnostics are now unowned. Clearing them is the honest state: a
    // stale squiggle from a dead server is worse than none, because nothing
    // will ever remove it.
    clearDiagnosticsFor(session)
    return
  }

  const backoff = RESTART_BACKOFF_MS[session.restarts.length] ?? 5_000
  session.restarts.push(now)
  emitNotice?.(
    `${session.spec.displayName} exited (${signal ?? code ?? 'unknown'}); restarting in ${backoff}ms`
  )

  const timer = setTimeout(() => {
    const client = ensureRunning(session.spec)
    if (client === null) return
    // Replay the buffers. A restarted server that was never told about the open
    // files would report nothing until each was touched, which reads as the
    // restart having silently failed.
    for (const [path, document] of session.documents) {
      client.openDocument(path, document.languageId, document.text, document.version)
    }
  }, backoff)

  timer.unref?.()
}

function clearDiagnosticsFor(session: Session): void {
  const cleared: FileDiagnostics[] = []

  for (const path of session.documents.keys()) {
    const relativePath = toRelative(path)
    if (relativePath === null) continue
    cleared.push({ relativePath, path, diagnostics: [], version: 0 })
  }

  if (cleared.length === 0) return
  publishDiagnostics('lsp', cleared)
  emitDiagnostics?.(cleared)
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

function toRelative(absolute: string): string | null {
  if (workspaceRoot === null) return null

  const rel = relative(workspaceRoot, absolute)
  // Outside the workspace. The renderer keys models on a workspace-relative
  // path, so a diagnostic it cannot place is worse than one it never saw —
  // the same rule A3 applied to definitions outside the root.
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  return rel.split(sep).join('/')
}

function publish(spec: LspServerSpec, uri: string, diagnostics: readonly unknown[]): void {
  const path = fromFileUri(uri)
  if (path === null) return

  const relativePath = toRelative(path)
  if (relativePath === null) return

  const file: FileDiagnostics = {
    relativePath,
    path,
    diagnostics: diagnostics.map((diagnostic) =>
      toDiagnosticMessage(diagnostic as Parameters<typeof toDiagnosticMessage>[0], relativePath, path, spec.id)
    ),
    // The server owns freshness for its own files and re-publishes the complete
    // set every time, so there is no late batch to discard here.
    version: 0
  }

  publishDiagnostics('lsp', [file])
  emitDiagnostics?.([file])
}

/* -------------------------------------------------------------------------- */
/*  Documents                                                                  */
/* -------------------------------------------------------------------------- */

export function openLspDocument(path: string, languageId: string, text: string, version: number): void {
  if (!isServedByLsp(languageId)) return

  const spec = serverForLanguage(languageId)
  if (spec === null) return

  // Recorded before the client exists, so a server that starts late — or
  // restarts — still learns about this file.
  sessionFor(spec).documents.set(path, { languageId, text, version })
  ensureRunning(spec)?.openDocument(path, languageId, text, version)
}

export function changeLspDocument(path: string, text: string, version: number): void {
  const spec = serverForPath(path)
  if (spec === null) return

  const session = sessionFor(spec)
  const existing = session.documents.get(path)
  if (existing === undefined) return

  session.documents.set(path, { ...existing, text, version })
  session.client?.changeDocument(path, text, version)
}

export function closeLspDocument(path: string): void {
  const spec = serverForPath(path)
  if (spec === null) return

  const session = sessionFor(spec)
  if (!session.documents.delete(path)) return
  session.client?.closeDocument(path)
}

/* -------------------------------------------------------------------------- */
/*  Queries                                                                    */
/* -------------------------------------------------------------------------- */

export interface LspLocationResult {
  readonly path: string
  readonly relativePath: string
  readonly range: SourceRange
}

/**
 * The shared half of definition and references: find the server, ask it, and
 * drop anything outside the workspace.
 *
 * The position lives in the caller's closure rather than being threaded through
 * here — it is the one thing the two queries do not share, since references
 * also carries a context object.
 */
async function locate(
  path: string,
  ask: (client: LspClient) => Promise<{ path: string; range: SourceRange }[]>
): Promise<LspLocationResult[]> {
  const spec = serverForPath(path)
  if (spec === null) return []

  const client = sessions.get(spec.id)?.client
  if (client === undefined || client === null) return []

  const found = await ask(client)
  const located: LspLocationResult[] = []

  for (const entry of found) {
    const relativePath = toRelative(entry.path)
    if (relativePath === null) continue
    located.push({ path: entry.path, relativePath, range: entry.range })
  }

  return located
}

export function lspDefinition(path: string, line: number, column: number): Promise<LspLocationResult[]> {
  return locate(path, (client) => client.definition(path, line, column))
}

export function lspReferences(path: string, line: number, column: number): Promise<LspLocationResult[]> {
  return locate(path, (client) => client.references(path, line, column))
}

export async function lspHover(path: string, line: number, column: number): Promise<string | null> {
  const spec = serverForPath(path)
  if (spec === null) return null

  const client = sessions.get(spec.id)?.client
  if (client === undefined || client === null) return null

  return client.hover(path, line, column)
}

/** For tests, which must not inherit another file's sessions. */
export function resetLspForTests(): void {
  sessions.clear()
  announced.clear()
  workspaceRoot = null
  transportFactory = null
  emitDiagnostics = null
  emitNotice = null
}
