import { z } from 'zod'
import type { EventChannel, InvokeChannel } from './ipc-channels'
import { codeGraphSchema } from './code-graph'
import {
  aiContextSchema,
  aiDoneSchema,
  aiLogEntrySchema,
  aiModeSchema,
  aiStartedSchema,
  aiStreamDeltaSchema,
  fileNodeSchema,
  fsWatchEventSchema,
  searchMatchSchema,
  gitBranchesSchema,
  gitCommitSchema,
  gitFileDiffSchema,
  githubInsightsSchema,
  artifactKindSchema,
  artifactSchema,
  artifactSummarySchema,
  codeActionsResultSchema,
  compilerPassSchema,
  compilerStatusSchema,
  definitionResultSchema,
  dependencyQuerySchema,
  diagnosticsBatchSchema,
  documentOverlaySchema,
  documentSymbolsResultSchema,
  fileDiagnosticsSchema,
  fileEditSchema,
  hoverResultSchema,
  referencesResultSchema,
  renameResultSchema,
  gitStatusSchema,
  languageBreakdownSchema,
  repositoryStatsSchema,
  secretKeySchema,
  secretsStateSchema,
  settingsSchema,
  runExitSchema,
  runOutputSchema,
  runStartedSchema,
  terminalDataSchema,
  terminalExitSchema,
  terminalSessionSchema,
  toolchainSchema,
  workspaceSchema
} from './types'

export { INVOKE_CHANNEL_NAMES, EVENT_CHANNEL_NAMES, splitChannel, eventMethodName } from './ipc-channels'
export type { InvokeChannel, EventChannel } from './ipc-channels'

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

/**
 * Errors never cross IPC as exceptions. An exception thrown inside an
 * `ipcMain.handle` is serialised into an opaque `Error invoking remote method`
 * string that destroys the original type, message and stack. Every handler
 * therefore resolves to a `Result` and the renderer branches on `ok`.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BetterCallCompilerError }

export interface BetterCallCompilerError {
  readonly code: ErrorCode
  readonly message: string
}

export const ERROR_CODES = [
  'BAD_REQUEST', // request failed its zod schema
  'BAD_RESPONSE', // handler produced something its schema rejects (a bug in us)
  'UNKNOWN_CHANNEL', // no table entry
  'HANDLER_FAILED', // handler threw
  'NO_WORKSPACE', // an operation needing a workspace root ran without one
  'PATH_ESCAPES_WORKSPACE', // path confinement violation
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'IO_ERROR',
  'CANCELLED',
  'UNSUPPORTED',
  // Distinct from a failure: the renderer turns this into an inline
  // "Add your Anthropic key in Settings" affordance, never an error dialog.
  'NO_API_KEY'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

/**
 * Thrown by services to signal a *specific* failure. The IPC wrapper unwraps it
 * into `fail(code, message)`; anything else becomes a generic HANDLER_FAILED.
 * Lives here rather than in main/ so services and the registry can both import
 * it without a cycle.
 */
export class BetterCallCompilerServiceError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'BetterCallCompilerServiceError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ *
 * The channel tables
 * ------------------------------------------------------------------ */

export interface ChannelSpec {
  readonly request: z.ZodType
  readonly response: z.ZodType
}

const empty = z.strictObject({})
const pathRequest = z.strictObject({ path: z.string().min(1) })

/**
 * The Visualizer's whole state in one message.
 *
 * One schema serves both the `visualizer:pushState` request and the
 * `visualizer:stateChanged` payload because they are the same value on two hops
 * of one trip: renderer → main → floating window. Declaring them separately
 * would let the halves of a single round trip drift, and the drift would only
 * show up as a `BAD_RESPONSE`-style failure in the window nobody is watching.
 *
 * `selectedNodeId` travels with the graph rather than on its own channel so the
 * floating window can never paint a selection that belongs to a previous graph.
 */
const visualizerState = z.strictObject({
  graph: codeGraphSchema,
  selectedNodeId: z.string().nullable()
})

/**
 * THE invoke table: one zod request schema and one response schema per channel.
 *
 * `satisfies Record<InvokeChannel, ChannelSpec>` is doing real work — it fails
 * compilation if a name in the registry has no entry here, and if an entry here
 * names a channel that is not in the registry.
 *
 * Payloads use `strictObject` so unknown keys are rejected rather than silently
 * stripped — at a trust boundary, a field we do not understand is a signal.
 */
export const INVOKE_CHANNELS = {
  'app:ping': {
    request: empty,
    response: z.strictObject({
      pong: z.literal(true),
      version: z.string(),
      platform: z.string(),
      electron: z.string()
    })
  },

  'fs:openFolder': {
    request: empty,
    // `root: null` means the user cancelled the dialog — not an error.
    response: workspaceSchema
  },
  'fs:getWorkspace': {
    request: empty,
    response: workspaceSchema
  },
  'fs:readDir': {
    request: pathRequest,
    response: z.strictObject({ entries: z.array(fileNodeSchema) })
  },
  'fs:readFile': {
    request: pathRequest,
    response: z.strictObject({ content: z.string() })
  },
  'fs:writeFile': {
    request: z.strictObject({ path: z.string().min(1), content: z.string() }),
    response: z.strictObject({ written: z.literal(true) })
  },
  'fs:createFile': {
    request: pathRequest,
    response: z.strictObject({ node: fileNodeSchema })
  },
  'fs:createDir': {
    request: pathRequest,
    response: z.strictObject({ node: fileNodeSchema })
  },
  'fs:rename': {
    request: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }),
    response: z.strictObject({ node: fileNodeSchema })
  },
  'fs:delete': {
    request: pathRequest,
    response: z.strictObject({ deleted: z.literal(true) })
  },
  // Quick open needs the whole list once and filters it in the renderer;
  // round-tripping per keystroke would make typing feel like network latency.
  'fs:listFiles': {
    request: empty,
    response: z.strictObject({ files: z.array(fileNodeSchema) })
  },
  /** Bytes per language; aggregated in main because it needs a stat per file. */
  'fs:languageBreakdown': {
    request: empty,
    response: z.strictObject({ breakdown: languageBreakdownSchema })
  },
  'fs:search': {
    request: z.strictObject({
      query: z.string(),
      caseSensitive: z.boolean(),
      isRegex: z.boolean()
    }),
    response: z.strictObject({ matches: z.array(searchMatchSchema) })
  },

  'terminal:create': {
    request: z.strictObject({
      cols: z.number().int().positive().max(2000),
      rows: z.number().int().positive().max(2000)
    }),
    response: z.strictObject({ session: terminalSessionSchema })
  },
  'terminal:write': {
    request: z.strictObject({ id: z.string().min(1), data: z.string() }),
    response: z.strictObject({ written: z.literal(true) })
  },
  'terminal:resize': {
    request: z.strictObject({
      id: z.string().min(1),
      cols: z.number().int().positive().max(2000),
      rows: z.number().int().positive().max(2000)
    }),
    response: z.strictObject({ resized: z.literal(true) })
  },
  'terminal:dispose': {
    request: z.strictObject({ id: z.string().min(1) }),
    response: z.strictObject({ disposed: z.literal(true) })
  },
  'terminal:list': {
    request: empty,
    response: z.strictObject({ sessions: z.array(terminalSessionSchema) })
  },

  // `list` serves the session cache; `rescan` drops it first. Two channels
  // rather than one with a `force` flag, so a caller cannot invalidate a cache
  // it only meant to read.
  'toolchain:list': {
    request: empty,
    response: z.strictObject({ toolchains: z.array(toolchainSchema) })
  },
  'toolchain:rescan': {
    request: empty,
    response: z.strictObject({ toolchains: z.array(toolchainSchema) })
  },

  // The decision — real toolchain, bundled pack, or neither — comes back on the
  // invoke rather than as an event. The renderer has to know which console to
  // open and which banner to draw *before* the first byte of output arrives.
  'run:start': {
    request: z.strictObject({
      path: z.string().min(1),
      languageId: z.string().min(1)
    }),
    response: z.strictObject({ run: runStartedSchema })
  },
  'run:cancel': {
    request: z.strictObject({ runId: z.string().min(1) }),
    response: z.strictObject({ cancelled: z.boolean() })
  },

  'git:status': {
    request: empty,
    response: z.strictObject({ status: gitStatusSchema })
  },
  'git:diff': {
    // `staged` picks which pair of revisions to compare; see `diff` in
    // git-service.ts for why the caller has to say.
    request: z.strictObject({ path: z.string().min(1), staged: z.boolean() }),
    response: z.strictObject({ diff: gitFileDiffSchema })
  },
  'git:stage': {
    request: z.strictObject({ paths: z.array(z.string().min(1)).min(1) }),
    response: z.strictObject({ staged: z.literal(true) })
  },
  'git:unstage': {
    request: z.strictObject({ paths: z.array(z.string().min(1)).min(1) }),
    response: z.strictObject({ unstaged: z.literal(true) })
  },
  'git:commit': {
    request: z.strictObject({ message: z.string().min(1) }),
    response: z.strictObject({ commit: gitCommitSchema })
  },
  'git:branches': {
    request: empty,
    response: z.strictObject({ branches: gitBranchesSchema })
  },
  'git:log': {
    request: z.strictObject({ limit: z.number().int().positive().max(500) }),
    response: z.strictObject({ commits: z.array(gitCommitSchema) })
  },

  /**
   * One call per Insights refresh, mirroring `github:insights` — but derived
   * from the local `git log`, so it answers on a repository with no remote and
   * no token.
   */
  'git:stats': {
    request: empty,
    response: z.strictObject({ stats: repositoryStatsSchema })
  },

  'github:insights': {
    // `force` bypasses the 10-minute cache; the view's Refresh button sets it.
    request: z.strictObject({ force: z.boolean() }),
    response: z.strictObject({ insights: githubInsightsSchema })
  },

  // Three channels, and deliberately no fourth. There is no `secrets:getKey`:
  // nothing in this table can return a stored secret in plaintext, so a
  // compromised renderer has no code path to exfiltrate one.
  'secrets:setKey': {
    request: z.strictObject({ key: secretKeySchema, value: z.string() }),
    response: z.strictObject({ secrets: secretsStateSchema })
  },
  'secrets:hasKey': {
    request: empty,
    response: z.strictObject({ secrets: secretsStateSchema })
  },
  'secrets:clearKey': {
    request: z.strictObject({ key: secretKeySchema }),
    response: z.strictObject({ secrets: secretsStateSchema })
  },

  'settings:get': {
    request: empty,
    response: z.strictObject({ settings: settingsSchema })
  },
  'settings:set': {
    request: z.strictObject({ patch: settingsSchema.partial() }),
    response: z.strictObject({ settings: settingsSchema })
  },

  // The response carries the exact prompt and context, so the panel can render
  // "Context sent" before the first token arrives rather than after the answer.
  'ai:start': {
    request: z.strictObject({ mode: aiModeSchema, context: aiContextSchema }),
    response: z.strictObject({ started: aiStartedSchema })
  },
  'ai:cancel': {
    request: z.strictObject({ streamId: z.string().min(1) }),
    response: z.strictObject({ cancelled: z.boolean() })
  },
  // `content` is the whole proposed file, not a patch: the renderer already
  // spliced the block into the selection range, and sending the result means
  // main never has to reconstruct an edit it did not compute.
  'ai:apply': {
    request: z.strictObject({
      path: z.string().min(1),
      content: z.string(),
      mode: aiModeSchema,
      model: z.string().min(1),
      promptHash: z.string().min(1),
      range: z.string().min(1)
    }),
    response: z.strictObject({ entry: aiLogEntrySchema })
  },
  'ai:revert': {
    request: z.strictObject({ id: z.string().min(1) }),
    response: z.strictObject({ entry: aiLogEntrySchema })
  },
  'ai:log': {
    request: empty,
    response: z.strictObject({ entries: z.array(aiLogEntrySchema) })
  },

  /**
   * There is at most one floating Visualizer, so this is "show me the diagram
   * window", not "make a diagram window". Asking twice raises the one that
   * exists.
   *
   * `opened` reports whether a floating window is on screen *after* the call,
   * deliberately not distinguishing "created" from "already there and now
   * focused": the renderer drives a window-state control off it, and that
   * control has one 'floating' state, not two.
   */
  'visualizer:openFloating': {
    request: empty,
    response: z.strictObject({ opened: z.boolean() })
  },
  'visualizer:closeFloating': {
    request: empty,
    response: empty
  },
  /**
   * Push, not pull. The floating window is sandboxed with no filesystem and no
   * workspace of its own, and re-deriving the graph there would mean a second
   * AST walk that is allowed to disagree with the first. The window that owns
   * the editor owns the graph and hands over the finished value.
   *
   * A no-op — never an error — when nothing is floating. The panel pushes on
   * every graph change, and making it an error would force the renderer to
   * track a window lifetime it does not control and cannot observe.
   */
  'visualizer:pushState': {
    request: visualizerState,
    response: empty
  },

  /**
   * The other half of `visualizer:revealRequested`, and the only interaction in
   * the app that has to cross from one window back to the other: the floating
   * diagram's click-to-source wants to move an editor that is not in its window.
   *
   * It cannot be an event, because events only travel main → renderer. So the
   * floating window invokes this, and main turns it into the event the *main*
   * window is subscribed to. Two hops, no renderer-to-renderer channel, and
   * neither window needs to know whether the other is alive.
   */
  'visualizer:requestReveal': {
    request: z.strictObject({ line: z.number().int().positive() }),
    response: empty
  },

  /* ------------------------------ compiler ------------------------------ */

  'compiler:status': {
    request: empty,
    response: z.strictObject({ status: compilerStatusSchema })
  },
  'compiler:diagnostics': {
    /** `null` asks for every file — what the Problems panel pulls on mount. */
    request: z.strictObject({ relativePath: z.string().nullable() }),
    response: z.strictObject({ files: z.array(fileDiagnosticsSchema) })
  },
  'compiler:dependents': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      /**
       * Capped for the same reason the pass's own trigger is: a coalesced watch
       * batch can name hundreds of paths, and each one seeds a graph walk.
       */
      from: z.array(z.string().min(1)).max(20).default([])
    }),
    response: z.strictObject({ graph: dependencyQuerySchema })
  },
  /**
   * The unsaved-buffer overlay. The renderer cannot push, so an open document
   * rides an invoke rather than an event — the daemon must see the buffer the
   * user is looking at, not the last thing written to disk.
   */
  'compiler:openDocument': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      content: z.string(),
      version: z.number().int().nonnegative()
    }),
    response: z.strictObject({ accepted: z.literal(true) })
  },
  'compiler:closeDocument': {
    request: z.strictObject({ relativePath: z.string().min(1) }),
    response: z.strictObject({ closed: z.literal(true) })
  },
  'compiler:restart': {
    request: empty,
    response: z.strictObject({ restarted: z.literal(true) })
  },
  /**
   * Recent check passes, newest last. A pull as well as an event, because the
   * Compiler Intelligence view is lazily mounted: opening it between passes
   * must show the history rather than an empty chart until the user types.
   */
  'compiler:passes': {
    request: empty,
    response: z.strictObject({ passes: z.array(compilerPassSchema) })
  },

  /* ----------------------------- navigation ----------------------------- */

  /**
   * What every navigation request carries.
   *
   * The offset rather than a line and column, because that is what
   * `ITextModel.getOffsetAt` produces and what both compilers index by — a
   * position converted twice is a position that can disagree with itself.
   *
   * The overlay is the freshness fix and is the reason these are not answered
   * from whatever the daemon last happened to be told. See
   * `documentOverlaySchema`.
   */
  'compiler:definition': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      offset: z.number().int().nonnegative(),
      overlay: documentOverlaySchema.nullable()
    }),
    response: definitionResultSchema
  },
  'compiler:references': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      offset: z.number().int().nonnegative(),
      overlay: documentOverlaySchema.nullable()
    }),
    response: referencesResultSchema
  },
  /**
   * Both halves of a rename. `newName: null` asks where the symbol is, for the
   * inline box Monaco draws on F2; a name asks for the edits that carry it out.
   */
  'compiler:rename': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      offset: z.number().int().nonnegative(),
      newName: z.string().nullable(),
      overlay: documentOverlaySchema.nullable()
    }),
    response: renameResultSchema
  },
  /**
   * No offset: an outline is about the whole file.
   *
   * Served by the daemon for `.bcc` because nothing else can be. For TypeScript
   * this stays with Monaco's own worker — an outline is single-file and
   * syntactic, so the tsconfig it lacks is irrelevant and its answer is instant
   * and never queued behind a check.
   */
  'compiler:documentSymbols': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      overlay: documentOverlaySchema.nullable()
    }),
    response: documentSymbolsResultSchema
  },
  'compiler:hover': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      offset: z.number().int().nonnegative(),
      overlay: documentOverlaySchema.nullable()
    }),
    response: hoverResultSchema
  },
  /**
   * Quick fixes for the diagnostics under a selection.
   *
   * The codes come from the renderer because that is where the markers are, and
   * `getCodeFixesAtPosition` needs them: a fix is a fix FOR something, so
   * asking with an empty list returns nothing rather than everything.
   */
  'compiler:codeActions': {
    request: z.strictObject({
      relativePath: z.string().min(1),
      offset: z.number().int().nonnegative(),
      endOffset: z.number().int().nonnegative(),
      /** Numeric TypeScript codes — `2551`, not `TS2551`. Capped like the trigger set. */
      diagnosticCodes: z.array(z.number().int().nonnegative()).max(64),
      overlay: documentOverlaySchema.nullable()
    }),
    response: codeActionsResultSchema
  },
  /**
   * Writes edits to files that are NOT open, all of them or none.
   *
   * Every file is read and every edit applied in memory first; only when all of
   * them succeed does anything reach the disk. A rename that rewrote four files
   * and failed on the fifth would leave a program that compiles nowhere, with
   * no undo — which is a worse outcome than a rename that refuses.
   *
   * Open files never come here. They are edited through their Monaco model so
   * they stay dirty and stay in the undo stack, and because handing Monaco a
   * bulk edit spanning closed files makes it create models with no lifecycle
   * owner.
   */
  'compiler:applyWorkspaceEdit': {
    request: z.strictObject({ files: z.array(fileEditSchema).max(1_000) }),
    response: z.strictObject({ written: z.array(z.string()) })
  },

  /* ------------------------------ artifacts ----------------------------- */

  /**
   * Starts an Explain stream. Deltas arrive on the existing `ai:delta` /
   * `ai:done` channels — it is the same provider and the same transport, and a
   * parallel pair of channels would mean two copies of the cancellation and
   * completion handling for no difference the renderer can observe.
   */
  'explain:start': {
    request: z.strictObject({
      context: aiContextSchema,
      /** The artifact being revised, when answering a comment on it. */
      supersedes: z.string().nullable(),
      /** The comment being answered, so the reply can be linked back to it. */
      commentId: z.string().nullable(),
      question: z.string().nullable()
    }),
    response: z.strictObject({ started: aiStartedSchema })
  },
  'artifact:list': {
    request: empty,
    response: z.strictObject({ artifacts: z.array(artifactSummarySchema) })
  },
  /**
   * Anchor states ride along with the artifact rather than earning a channel.
   * They are computed on read and are meaningless apart from the artifact they
   * describe, so a caller that fetched one without the other would be holding
   * a document it cannot render honestly.
   */
  'artifact:get': {
    request: z.strictObject({ id: z.string().min(1) }),
    response: z.strictObject({
      artifact: artifactSchema,
      /** Keyed `sectionId:anchorIndex`. */
      anchorStates: z.record(z.string(), z.enum(['current', 'stale', 'missing']))
    })
  },
  /**
   * Stores a completed reply as an artifact.
   *
   * The renderer sends the finished markdown, the same division of labour as
   * `ai:apply`: it accumulated the stream, so it is what holds the result, and
   * main never has to reconstruct text it did not receive.
   */
  'artifact:create': {
    request: z.strictObject({
      kind: artifactKindSchema,
      title: z.string().min(1),
      model: z.string(),
      promptHash: z.string(),
      contextSent: z.string(),
      markdown: z.string().min(1),
      supersedes: z.string().nullable(),
      /** When set, the comment on `supersedes` that this artifact answers. */
      answersCommentId: z.string().nullable()
    }),
    response: z.strictObject({ artifact: artifactSchema })
  },
  'artifact:comment': {
    request: z.strictObject({
      id: z.string().min(1),
      sectionId: z.string().nullable(),
      body: z.string().min(1)
    }),
    response: z.strictObject({ artifact: artifactSchema })
  },

  /**
   * WebAssembly bytes, base64.
   *
   * The renderer cannot fetch a `.wasm` — `connect-src 'none'` refuses every
   * network-shaped load, including `instantiateStreaming` — so tree-sitter's
   * runtime and grammars arrive over IPC instead. `name` is a key into an
   * allow-list in wasm-assets.ts, never a path: there is nothing to traverse
   * because the renderer never names a location.
   */
  'wasm:read': {
    request: z.strictObject({ name: z.string().min(1) }),
    response: z.strictObject({ base64: z.string() })
  }
} as const satisfies Record<InvokeChannel, ChannelSpec>

/** THE event table: main → renderer pushes, one payload schema per channel. */
export const EVENT_CHANNELS = {
  'fs:watchEvent': { payload: fsWatchEventSchema },
  'terminal:data': { payload: terminalDataSchema },
  'terminal:exit': { payload: terminalExitSchema },
  'run:stdout': { payload: runOutputSchema },
  'run:stderr': { payload: runOutputSchema },
  'run:exit': { payload: runExitSchema },
  // Payload-free: the view re-reads status itself, so the event cannot carry a
  // snapshot that is already stale by the time it is rendered.
  'git:changed': { payload: z.strictObject({}) },
  'ai:delta': { payload: aiStreamDeltaSchema },
  'ai:done': { payload: aiDoneSchema },

  /** `visualizer:pushState` relayed to the floating window; same value, same schema. */
  'visualizer:stateChanged': { payload: visualizerState },

  /**
   * Click-to-source from the floating window. The editor only exists in the
   * main window, so a reveal has to travel back through main rather than being
   * handled where it was clicked.
   *
   * Nothing in main emits this yet, and that is a known hole rather than an
   * oversight: this step's contract adds no invoke channel carrying a reveal
   * request *up* from the floating window, so there is no trigger. The name and
   * payload are declared now because the preload derives
   * `visualizer.onRevealRequested` from this table and the main window's
   * subscription is being written against it — the missing half is the request,
   * not this.
   */
  'visualizer:revealRequested': {
    payload: z.strictObject({ line: z.number().int().positive() })
  },
  // Carries its payload rather than being a bare signal like `git:changed`:
  // diagnostics arrive in coalesced batches, and re-pulling per batch would
  // undo the batching that makes them affordable.
  'compiler:diagnosticsChanged': { payload: diagnosticsBatchSchema },
  // The graph summary rides on status instead of earning a third channel.
  'compiler:statusChanged': { payload: compilerStatusSchema },
  // Deliberately NOT folded onto statusChanged. Status is a small object that
  // fires constantly; a pass carries up to 500 trace events. Merging them would
  // make every state transition pay the cost of the observability payload.
  'compiler:passCompleted': { payload: compilerPassSchema },
  // Payload-free, like `git:changed`. An artifact carries its full text and its
  // comment thread; pushing that on every change would put a document on the
  // wire each time someone types a comment, to say only that something moved.
  'artifact:changed': { payload: z.strictObject({}) }
} as const satisfies Record<EventChannel, { readonly payload: z.ZodType }>

export type InvokeChannels = typeof INVOKE_CHANNELS
export type EventChannels = typeof EVENT_CHANNELS

export type RequestOf<C extends InvokeChannel> = z.infer<InvokeChannels[C]['request']>
export type ResponseOf<C extends InvokeChannel> = z.infer<InvokeChannels[C]['response']>
export type PayloadOf<C extends EventChannel> = z.infer<EventChannels[C]['payload']>

/* ------------------------------------------------------------------ *
 * Bridge shape
 * ------------------------------------------------------------------ */

type PrefixOf<C extends string> = C extends `${infer P}:${string}` ? P : never
type MethodOf<C extends string, P extends string> = C extends `${P}:${infer M}` ? M : never
type EventMethodOf<C extends string, P extends string> = C extends `${P}:${infer M}`
  ? `on${Capitalize<M>}`
  : never

type InvokeMethodsFor<P extends string> = {
  readonly [C in Extract<InvokeChannel, `${P}:${string}`> as MethodOf<C, P>]: (
    request: RequestOf<C>
  ) => Promise<Result<ResponseOf<C>>>
}

type EventMethodsFor<P extends string> = {
  readonly [C in Extract<EventChannel, `${P}:${string}`> as EventMethodOf<C, P>]: (
    listener: (payload: PayloadOf<C>) => void
  ) => () => void
}

/**
 * The exact type of `window.betterCallCompiler`, derived from both tables. Adding a
 * channel adds a typed method with no other edit — and there is deliberately no
 * index signature, so there is no way to reach a channel the tables do not name.
 */
export type BetterCallCompilerApi = {
  readonly [P in PrefixOf<InvokeChannel | EventChannel>]: InvokeMethodsFor<P> & EventMethodsFor<P>
}

/** Renders zod issues into one human-readable line for an `BetterCallCompilerError`. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}

/** Runtime guards used by the tests: the tables cover exactly the registries. */
export function tableChannelNames(): string[] {
  return Object.keys(INVOKE_CHANNELS)
}

export function eventTableChannelNames(): string[] {
  return Object.keys(EVENT_CHANNELS)
}
