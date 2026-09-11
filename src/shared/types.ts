import { z } from 'zod'

/**
 * Domain types for the whole app.
 *
 * Each type is *derived* from its zod schema rather than declared alongside it.
 * A hand-written interface next to a schema is a drift bug waiting to happen —
 * here the schema is the single source of truth and the TypeScript type cannot
 * disagree with what actually crosses IPC.
 */

/* ---------------------------------- fs ---------------------------------- */

export const fileKindSchema = z.enum(['file', 'directory'])
export type FileKind = z.infer<typeof fileKindSchema>

export const fileNodeSchema = z.strictObject({
  name: z.string(),
  /** Absolute, already confined to the workspace and realpath-resolved. */
  path: z.string(),
  /** POSIX-separated path relative to the workspace root; '' is the root. */
  relativePath: z.string(),
  kind: fileKindSchema
})
export type FileNode = z.infer<typeof fileNodeSchema>

export const workspaceSchema = z.strictObject({
  root: z.string().nullable(),
  name: z.string().nullable()
})
export type Workspace = z.infer<typeof workspaceSchema>

export const fsWatchEventTypeSchema = z.enum(['add', 'addDir', 'change', 'unlink', 'unlinkDir'])
export type FsWatchEventType = z.infer<typeof fsWatchEventTypeSchema>

export const fsWatchEventSchema = z.strictObject({
  type: fsWatchEventTypeSchema,
  path: z.string(),
  relativePath: z.string(),
  /**
   * Relative path of the containing directory. The explorer refreshes exactly
   * one node on a change instead of rebuilding the tree.
   */
  parentRelativePath: z.string()
})
export type FsWatchEvent = z.infer<typeof fsWatchEventSchema>

export const searchMatchSchema = z.strictObject({
  path: z.string(),
  relativePath: z.string(),
  /** 1-based, matching the editor and every diagnostic. */
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  /** The whole line, truncated; the view highlights the match within it. */
  preview: z.string(),
  matchLength: z.number().int().nonnegative()
})
export type SearchMatch = z.infer<typeof searchMatchSchema>

/* ------------------------------ toolchains ------------------------------ */

/**
 * What the probe concluded about a tool.
 *
 * `unusable` is not in the original spec but the probe cannot do without it: a
 * binary that resolves on PATH and then fails `--version` is neither missing nor
 * runnable, and collapsing it into either one produces a lie. The runner (step
 * 7) treats only `real` as a usable toolchain.
 */
export const toolchainKindSchema = z.enum(['real', 'store-stub', 'unusable', 'missing'])
export type ToolchainKind = z.infer<typeof toolchainKindSchema>

export const toolchainSchema = z.strictObject({
  /** Stable identifier: `node`, `python`, `gcc`, `g++`, `tsc`, `docker`. */
  id: z.string(),
  label: z.string(),
  found: z.boolean(),
  /** Absolute path as resolved from PATH; null when nothing matched. */
  path: z.string().nullable(),
  /** First line of `--version` output, verbatim; null when it produced none. */
  version: z.string().nullable(),
  kind: toolchainKindSchema,
  /**
   * Human guidance for a tool that is present but not usable. Carried on the
   * record rather than reconstructed in the renderer so there is exactly one
   * copy of the Store-stub wording.
   */
  guidance: z.string().nullable()
})
export type Toolchain = z.infer<typeof toolchainSchema>

/** True when the probe found something the runner can actually execute. */
export function isRunnable(toolchain: Toolchain): boolean {
  return toolchain.kind === 'real' && toolchain.path !== null
}

/* ------------------------------ secrets ---------------------------------- */

/**
 * Note what is absent: there is no schema for *reading* a secret, because there
 * is no channel that returns one. The renderer can learn that a key exists and
 * nothing more.
 */
export const secretKeySchema = z.enum(['anthropic', 'github'])
export type SecretKeyName = z.infer<typeof secretKeySchema>

export const secretsStateSchema = z.strictObject({
  anthropic: z.boolean(),
  github: z.boolean(),
  /** False on a Linux box with no keyring; the UI must say so, not pretend. */
  encryptionAvailable: z.boolean()
})
export type SecretsState = z.infer<typeof secretsStateSchema>

/* ------------------------------ settings --------------------------------- */

/**
 * Where the user last dragged the workbench's region boundaries.
 *
 * The bounds here are wide on purpose. Their job is to reject nonsense — a
 * negative width, a NaN, a number no display has ever been — and not to decide
 * what is *usable*, which depends on the size of the window and so can only be
 * settled in the renderer against the live one. Two things argue against
 * tightening them:
 *
 *   - `loadSettings` validates with `settingsSchema.partial()`, which is
 *     per-key optional but still per-key strict. A `sideBarWidth` outside the
 *     bound fails the whole parse and resets the user's model, GitHub handle
 *     and telemetry choice along with their layout. A layout number is not
 *     worth that.
 *   - The renderer clamps everything it applies anyway, so an in-range but
 *     silly value is already handled a second time where the window size is
 *     known.
 */
export const workbenchLayoutSchema = z.strictObject({
  sideBarWidth: z.number().int().min(0).max(4000),
  rightDockWidth: z.number().int().min(0).max(4000),
  panelHeight: z.number().int().min(0).max(4000),
  sideBarHidden: z.boolean(),
  rightDockHidden: z.boolean()
})
export type WorkbenchLayout = z.infer<typeof workbenchLayoutSchema>

export const aiProviderIdSchema = z.enum(['anthropic', 'ollama'])
export type AiProviderId = z.infer<typeof aiProviderIdSchema>

export const settingsSchema = z.strictObject({
  aiModel: z.string().min(1),
  /** Which backend serves the three AI actions — cloud Claude, or a local Ollama. */
  aiProvider: aiProviderIdSchema,
  /** Model name Ollama should run, e.g. `llama3.1`, `deepseek-coder-v2`, `qwen2.5-coder`. */
  ollamaModel: z.string(),
  /** Almost always the default; overridable for a remote or non-standard Ollama host. */
  ollamaHost: z.string(),
  /** Whose contribution calendar to show when no token names one. */
  githubUser: z.string(),
  telemetry: z.boolean(),
  /**
   * Nested, which makes it the one setting a `patch` cannot half-specify:
   * `saveSettings` merges one level deep and then parses against a strict
   * object, so a caller sends the whole layout or none of it.
   */
  workbenchLayout: workbenchLayoutSchema
})
export type Settings = z.infer<typeof settingsSchema>

/* --------------------------------- git ---------------------------------- */

export const gitFileChangeSchema = z.strictObject({
  /** POSIX-separated, relative to the repository root — git's own spelling. */
  path: z.string(),
  absolutePath: z.string(),
  /** Porcelain status characters: ' ', 'M', 'A', 'D', 'R', 'U', '?'. */
  indexStatus: z.string(),
  workingStatus: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  conflicted: z.boolean()
})
export type GitFileChange = z.infer<typeof gitFileChangeSchema>

export const gitStatusSchema = z.strictObject({
  isRepository: z.boolean(),
  /** Null on an unborn branch — a repository with no commits yet. */
  branch: z.string().nullable(),
  tracking: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  changes: z.array(gitFileChangeSchema)
})
export type GitStatus = z.infer<typeof gitStatusSchema>

export const gitFileDiffSchema = z.strictObject({
  path: z.string(),
  original: z.string(),
  modified: z.string(),
  /** What each side represents, e.g. `HEAD` vs `Staged`. */
  originalLabel: z.string(),
  modifiedLabel: z.string()
})
export type GitFileDiff = z.infer<typeof gitFileDiffSchema>

export const gitCommitSchema = z.strictObject({
  hash: z.string(),
  shortHash: z.string(),
  message: z.string(),
  author: z.string(),
  date: z.string(),
  refs: z.string()
})
export type GitCommit = z.infer<typeof gitCommitSchema>

export const gitBranchesSchema = z.strictObject({
  current: z.string().nullable(),
  all: z.array(z.string())
})
export type GitBranches = z.infer<typeof gitBranchesSchema>

/** Renders a porcelain pair as the single letter the SCM list shows. */
export function describeChange(change: GitFileChange): string {
  if (change.conflicted) return 'C'
  if (change.untracked) return 'U'
  const status = change.staged ? change.indexStatus : change.workingStatus
  return status.trim() === '' ? 'M' : status
}

/* ---------------------------- language stats ----------------------------- */

/**
 * Bytes per language across the workspace.
 *
 * Measured in bytes rather than file count, the way GitHub's own language bar
 * works: counting files would rank a three-line barrel export equal to a
 * thousand-line module. `FileNode` deliberately carries no size — adding one
 * would put a `stat` behind every explorer row — so this is aggregated in the
 * main process and only the totals cross IPC.
 */
export const languageStatSchema = z.strictObject({
  /** Display name, e.g. `TypeScript`. */
  language: z.string(),
  /** Lower-case extension without the dot, e.g. `ts`. */
  extension: z.string(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative()
})
export type LanguageStat = z.infer<typeof languageStatSchema>

export const languageBreakdownSchema = z.strictObject({
  /** Largest first, already truncated by the service. */
  languages: z.array(languageStatSchema),
  totalBytes: z.number().int().nonnegative(),
  /** True when the walk hit its file ceiling and the numbers are a sample. */
  truncated: z.boolean()
})
export type LanguageBreakdown = z.infer<typeof languageBreakdownSchema>

/* ---------------------------- repository stats --------------------------- */

/**
 * Statistics derived from the local `git log` alone.
 *
 * Deliberately separate from `GithubInsights`: everything here works with no
 * token, no network and no remote, so the Insights view can show real numbers
 * on a repository that has never been pushed anywhere. The GitHub-backed
 * calendar degrades; these sections simply do not need to.
 */
export const codeFrequencyWeekSchema = z.strictObject({
  /** ISO date of that week's Sunday, so weeks sort lexicographically. */
  weekStart: z.string(),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative()
})
export type CodeFrequencyWeek = z.infer<typeof codeFrequencyWeekSchema>

export const fileChurnSchema = z.strictObject({
  path: z.string(),
  /** Number of commits that touched this path. */
  commits: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative()
})
export type FileChurn = z.infer<typeof fileChurnSchema>

export const contributorSchema = z.strictObject({
  name: z.string(),
  commits: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative()
})
export type Contributor = z.infer<typeof contributorSchema>

export const repositoryStatsSchema = z.strictObject({
  isRepository: z.boolean(),
  /** Oldest first. Empty on a repository with no commits. */
  codeFrequency: z.array(codeFrequencyWeekSchema),
  /** Most-churned first, already truncated by the service. */
  churn: z.array(fileChurnSchema),
  /** Most commits first. */
  contributors: z.array(contributorSchema),
  totalCommits: z.number().int().nonnegative()
})
export type RepositoryStats = z.infer<typeof repositoryStatsSchema>

/* ------------------------------- github ---------------------------------- */

export const contributionDaySchema = z.strictObject({
  date: z.string(),
  count: z.number()
})
export type ContributionDay = z.infer<typeof contributionDaySchema>

export const contributionCalendarSchema = z.strictObject({
  totalContributions: z.number(),
  /** 53 weeks × 7 days, oldest first — the shape GitHub's GraphQL returns. */
  weeks: z.array(z.array(contributionDaySchema))
})
export type ContributionCalendar = z.infer<typeof contributionCalendarSchema>

export const rateLimitSchema = z.strictObject({
  remaining: z.number(),
  limit: z.number(),
  /** ISO timestamp; null when the API did not say. */
  resetAt: z.string().nullable()
})
export type RateLimit = z.infer<typeof rateLimitSchema>

/**
 * Where the data came from. The view must never look identical whether it is
 * showing GitHub's answer or a local `git log` fallback.
 */
export const insightsSourceSchema = z.enum(['github', 'local', 'none'])
export type InsightsSource = z.infer<typeof insightsSourceSchema>

export const githubInsightsSchema = z.strictObject({
  source: insightsSourceSchema,
  /** How the token was found: `gh` CLI, stored PAT, or nothing. */
  tokenSource: z.enum(['gh-cli', 'settings', 'none']),
  login: z.string().nullable(),
  repository: z.string().nullable(),
  calendar: contributionCalendarSchema.nullable(),
  commits: z.array(gitCommitSchema),
  rateLimit: rateLimitSchema.nullable(),
  /** Populated whenever the view is degraded, so it can say why. */
  notice: z.string().nullable(),
  /** ISO timestamp of the cached response being served. */
  fetchedAt: z.string()
})
export type GithubInsights = z.infer<typeof githubInsightsSchema>

/* ----------------------------------- ai ---------------------------------- */

/**
 * `agent` is the multi-file mode: given a plain-language instruction and a
 * handful of files for context, the model proposes edits across all of them
 * as one batch. The other three stay selection-scoped, one file at a time.
 */
export const aiModeSchema = z.enum(['explain', 'find-bugs', 'improve', 'agent'])
export type AiMode = z.infer<typeof aiModeSchema>

/** One file offered as context for a multi-file agent request. */
export const agentFileSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string()
})
export type AgentFile = z.infer<typeof agentFileSchema>

/**
 * What the multi-file agent is told: an instruction plus the files it is
 * allowed to reason about and rewrite. Capped rather than unbounded — the
 * renderer attaches open tabs and the files the instruction names, not a
 * repository-wide scan; that scan is `Codebase Semantic Indexing`, a separate
 * and much larger piece of work.
 */
export const agentContextSchema = z.strictObject({
  instruction: z.string().min(1),
  files: z.array(agentFileSchema).min(1).max(20)
})
export type AgentContext = z.infer<typeof agentContextSchema>

/** One proposed file in a parsed agent plan, before the user accepts or rejects it. */
export const agentFileEditSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string()
})
export type AgentFileEdit = z.infer<typeof agentFileEditSchema>

export const aiSelectionSchema = z.strictObject({
  text: z.string(),
  /** 1-based, matching Monaco and every compiler diagnostic. */
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive()
})
export type AiSelection = z.infer<typeof aiSelectionSchema>

/**
 * Everything the model is told, assembled in the renderer where the language
 * services live, and rendered verbatim into the "Context sent" panel.
 */
export const aiContextSchema = z.strictObject({
  filePath: z.string(),
  relativePath: z.string(),
  languageId: z.string(),
  selection: aiSelectionSchema,
  /** The function or class containing the selection, via Monaco's symbols. */
  enclosingSymbol: z
    .strictObject({ name: z.string(), kind: z.string(), text: z.string() })
    .nullable(),
  imports: z.array(z.string())
})
export type AiContext = z.infer<typeof aiContextSchema>

export const aiStartedSchema = z.strictObject({
  streamId: z.string(),
  mode: aiModeSchema,
  model: z.string(),
  provider: z.string(),
  promptHash: z.string(),
  /** The exact strings sent. Transparency is a product requirement. */
  systemPrompt: z.string(),
  contextSent: z.string()
})
export type AiStarted = z.infer<typeof aiStartedSchema>

export const aiStreamDeltaSchema = z.strictObject({
  streamId: z.string(),
  text: z.string()
})
export type AiStreamDelta = z.infer<typeof aiStreamDeltaSchema>

/**
 * Token counts and an estimated dollar cost for one request.
 *
 * `costUsd` is an estimate, not a bill: it is `tokens * a static per-model
 * rate table`, so a rate the provider changes without our knowledge makes
 * this stale, not wrong in a way anything downstream needs to defend against.
 */
export const aiUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative()
})
export type AiUsage = z.infer<typeof aiUsageSchema>

/** Running total across the session, reset only when the app restarts. */
export const aiUsageTotalsSchema = z.strictObject({
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative()
})
export type AiUsageTotals = z.infer<typeof aiUsageTotalsSchema>

export const aiDoneSchema = z.strictObject({
  streamId: z.string(),
  stopReason: z.string().nullable(),
  /** Human-readable; already mapped from 401/429/network by the service. */
  error: z.string().nullable(),
  cancelled: z.boolean(),
  /** Null when the provider reported no usage (a cancelled or failed stream). */
  usage: aiUsageSchema.nullable()
})
export type AiDone = z.infer<typeof aiDoneSchema>

/**
 * One line of `.bettercallcompiler/ai-log.jsonl`.
 *
 * The spec names timestamp, model, mode, promptHash, file, range and applied.
 * `id` and `revertOf` are additions the journal cannot work without: reverting
 * needs to name a specific edit, and an append-only log records a revert as a
 * second entry rather than by mutating the first.
 */
export const aiLogEntrySchema = z.strictObject({
  id: z.string(),
  timestamp: z.string(),
  model: z.string(),
  mode: aiModeSchema,
  promptHash: z.string(),
  file: z.string(),
  range: z.string(),
  applied: z.boolean(),
  revertOf: z.string().nullable(),
  /**
   * Groups the several entries a single multi-file agent apply writes, so a
   * revert can undo the whole batch as one unit rather than file by file.
   * Null for every single-file edit — Explain, Find bugs and Improve never
   * set it. `.default(null)` rather than a bare `.nullable()` so a log line
   * written before this field existed still parses: `readAiLog` drops any
   * line that fails validation, and a missing key is not the same failure as
   * a wrong one.
   */
  batchId: z.string().nullable().default(null)
})
export type AiLogEntry = z.infer<typeof aiLogEntrySchema>

/* --------------------------------- run ---------------------------------- */

/**
 * How a file is being executed.
 *
 * `real` and `bundled` are the two halves of the hybrid model: the same run
 * interface either drives an installed toolchain or a pack that ships with the
 * app. `unsupported` is the honest third case — the language has neither — and
 * exists so the UI can name what is missing instead of showing an empty console.
 */
export const runModeSchema = z.enum(['real', 'bundled', 'unsupported'])
export type RunMode = z.infer<typeof runModeSchema>

export const runStreamSchema = z.enum(['stdout', 'stderr'])
export type RunStream = z.infer<typeof runStreamSchema>

export const runStartedSchema = z.strictObject({
  /** Correlates every subsequent event; a stale run's output is discarded. */
  runId: z.string(),
  mode: runModeSchema,
  filePath: z.string(),
  relativePath: z.string(),
  languageId: z.string(),
  /** Resolved executable for `real` runs; null otherwise. */
  command: z.string().nullable(),
  args: z.array(z.string()),
  /** Toolchain id backing a `real` run, e.g. `node`. */
  toolchainId: z.string().nullable(),
  /** Bundled pack id for `bundled` runs, e.g. `web`. */
  pack: z.string().nullable(),
  /** Why this mode was chosen. Always set for `bundled` and `unsupported`. */
  reason: z.string().nullable(),
  /**
   * Whether MAIN is producing output events for this run.
   *
   * Explicit rather than inferred. Both processes have to agree about who
   * carries a plan out, and until now each worked it out from a different
   * field — the renderer from `mode`, then from `command`, while main used
   * `command` alone. Two inference rules that must stay in step is one bug
   * waiting for a third execution shape to be added, and BCC is that third
   * shape: no toolchain to spawn and no renderer pack either, because it runs
   * on the VM in a worker.
   */
  streamed: z.boolean()
})
export type RunStarted = z.infer<typeof runStartedSchema>

export const runOutputSchema = z.strictObject({
  runId: z.string(),
  stream: runStreamSchema,
  data: z.string()
})
export type RunOutput = z.infer<typeof runOutputSchema>

export const runExitSchema = z.strictObject({
  runId: z.string(),
  /** Null when the process was killed before reporting a code. */
  code: z.number().nullable(),
  durationMs: z.number(),
  cancelled: z.boolean()
})
export type RunExit = z.infer<typeof runExitSchema>

/* -------------------------------- debug --------------------------------- */

/**
 * The debugger's wire shapes.
 *
 * Deliberately the same vocabulary as `dap-protocol.ts` — `stackFrames`,
 * `variables`, `breakpoints` — rather than something invented for the BCC VM.
 * Workstream D built a DAP client for external adapters that answers in these
 * shapes, so one panel can eventually drive both. The schemas live here because
 * everything crossing IPC is validated in main, and `dap-protocol.ts` is a
 * type-only description of somebody else's protocol.
 */

export const debugStopReasonSchema = z.enum([
  'entry',
  'breakpoint',
  'step',
  'pause',
  'exception',
  'exited',
  'start'
])
export type DebugStopReason = z.infer<typeof debugStopReasonSchema>

export const debugStopSchema = z.strictObject({
  reason: debugStopReasonSchema,
  /** Null once the program has ended: there is no line to highlight. */
  line: z.number().int().positive().nullable(),
  message: z.string().nullable()
})

/**
 * Optional exactly where DAP makes it optional.
 *
 * The temptation is to require everything, because the built-in VM session
 * always fills every field. But this panel is meant to render an EXTERNAL
 * adapter's answer too — that is the whole reason the vocabulary was borrowed
 * — and an adapter that omits a source or a type is within spec. Tightening
 * the schema here would mean either dropping such a frame on the floor or
 * inventing a value for it, and both are ways of lying about what the debugger
 * said. The panel handles absence instead; it is one branch per field.
 */
export const debugFrameSchema = z.strictObject({
  /**
   * The frame's DEPTH, not an index into the array.
   *
   * The array is innermost-first for display, so a caller that stored an index
   * would read the wrong frame after one step changed the stack.
   */
  id: z.number().int(),
  name: z.string(),
  source: z.strictObject({ name: z.string().optional(), path: z.string().optional() }).optional(),
  line: z.number().int(),
  column: z.number().int()
})

export const debugVariableSchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  type: z.string().optional(),
  variablesReference: z.number().int()
})

export const debugBreakpointSchema = z.strictObject({
  id: z.number().int().optional(),
  /**
   * False when it could not be set where the user clicked. `line` then says
   * where it moved to, and `message` says why — showing it as a solid red dot
   * anyway is the single most common way a debugger lies to its user.
   */
  verified: z.boolean(),
  line: z.number().int().optional(),
  message: z.string().optional()
})

/**
 * Everything the panel paints, in one message.
 *
 * One snapshot rather than a stop event the UI then queries three more times:
 * the state is a handful of frames and a handful of locals, and a round trip
 * per pane would show a half-updated view while they arrived.
 *
 * `output` is the WHOLE transcript, not a delta. A run can only append, so
 * `run:stdout` streams; a debug session can step backwards, which un-prints.
 * The panel replaces rather than appends, and stepping back over a `print`
 * visibly removes the line.
 */
export const debugStateSchema = z.strictObject({
  runId: z.string(),
  stop: debugStopSchema,
  frames: z.array(debugFrameSchema),
  /** Locals per frame, keyed by the frame id, which is its depth. */
  locals: z.array(
    z.strictObject({
      frameId: z.number().int(),
      variables: z.array(debugVariableSchema)
    })
  ),
  output: z.string(),
  breakpoints: z.array(debugBreakpointSchema),
  /**
   * The program has ended. NOT that the session has: the end is the most
   * interesting place to step backwards from, so a finished session still
   * takes commands.
   */
  finished: z.boolean()
})
export type DebugState = z.infer<typeof debugStateSchema>

export const debugCommandSchema = z.enum([
  'continue',
  'stepInto',
  'stepOver',
  'stepOut',
  'stepBack',
  'reverseContinue'
])
export type DebugCommandName = z.infer<typeof debugCommandSchema>

export const debugStartedSchema = z.strictObject({
  runId: z.string(),
  filePath: z.string(),
  relativePath: z.string()
})
export type DebugStarted = z.infer<typeof debugStartedSchema>

export const debugExitSchema = z.strictObject({
  runId: z.string(),
  /** 2 when the program could not be compiled, 130 when the session was ended. */
  code: z.number().int(),
  /** Compile diagnostics, or empty when the session was simply ended. */
  message: z.string()
})
export type DebugExit = z.infer<typeof debugExitSchema>

/* ------------------------------- terminal ------------------------------- */

export const terminalSessionSchema = z.strictObject({
  id: z.string(),
  /** Friendly name, e.g. `pwsh`. */
  shellName: z.string(),
  shellPath: z.string()
})
export type TerminalSession = z.infer<typeof terminalSessionSchema>

export const terminalDataSchema = z.strictObject({
  id: z.string(),
  data: z.string()
})
export type TerminalData = z.infer<typeof terminalDataSchema>

export const terminalExitSchema = z.strictObject({
  id: z.string(),
  exitCode: z.number(),
  signal: z.number().nullable()
})
export type TerminalExit = z.infer<typeof terminalExitSchema>

/**
 * 0xC000013A / STATUS_CONTROL_C_EXIT. Windows reports this when a process is
 * terminated by Ctrl+C or taskkill, which is exactly what cancelling does.
 * Rendering it verbatim would tell the user their build "failed with exit code
 * -1073741510" when in fact they cancelled it themselves.
 */
export const WINDOWS_CANCELLED_EXIT_CODE = -1073741510

export function describeExit(exitCode: number): string {
  if (exitCode === WINDOWS_CANCELLED_EXIT_CODE) return 'cancelled'
  if (exitCode === 0) return 'exited cleanly'
  return `exited with code ${exitCode}`
}

/* -------------------------------- compiler ------------------------------- */

/**
 * The compiler daemon's data contract.
 *
 * Until now a compiler error existed only as text in the run console's
 * scrollback — `ErrorLink` carries a location and nothing else, because a
 * location is all you can recover from formatted output. `ts.LanguageService`
 * hands back structured diagnostics, so these types model what a diagnostic
 * actually is: a severity, a code, a message and a range.
 *
 * Every position here is 1-based, matching Monaco, tsc, and every other
 * diagnostic in this codebase.
 */

export const diagnosticSeveritySchema = z.enum(['error', 'warning', 'info', 'hint'])
export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>

/**
 * Which producer owns a diagnostic. Grouping metadata only — everything lands
 * under one Monaco marker owner, so a single `setModelMarkers` call replaces
 * the complete set for a file.
 *
 * `lsp` covers every language server at once rather than one member per
 * server. The member is for grouping in the UI, and "which of pyright, clangd
 * and gopls said this" is already in the diagnostic's `code`; a member per
 * server would make the enum grow with the server registry and force a schema
 * change to support a language.
 */
export const diagnosticSourceSchema = z.enum(['typescript', 'graph', 'bcc', 'lsp'])
export type DiagnosticSource = z.infer<typeof diagnosticSourceSchema>

export const diagnosticMessageSchema = z.strictObject({
  /** POSIX-separated, workspace-relative — the key every side joins on. */
  relativePath: z.string(),
  /** Absolute, so the renderer opens it without re-deriving the root. */
  path: z.string(),
  severity: diagnosticSeveritySchema,
  /** `TS2345`, or `TS-CYCLE` for the graph's own warnings. */
  code: z.string(),
  message: z.string(),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  source: diagnosticSourceSchema
})
export type DiagnosticMessage = z.infer<typeof diagnosticMessageSchema>

export const fileDiagnosticsSchema = z.strictObject({
  relativePath: z.string(),
  path: z.string(),
  /**
   * The COMPLETE set for this file. An empty array means "now clean" and the
   * renderer must clear its markers — it is not an empty batch to be skipped.
   * Dropping these is exactly how a fixed error keeps its squiggle forever.
   */
  diagnostics: z.array(diagnosticMessageSchema),
  /** Monotonic per file; a late batch with a lower version is discarded. */
  version: z.number().int().nonnegative()
})
export type FileDiagnostics = z.infer<typeof fileDiagnosticsSchema>

export const diagnosticsBatchSchema = z.strictObject({
  files: z.array(fileDiagnosticsSchema),
  /** True when this batch completes the current check pass. */
  settled: z.boolean()
})
export type DiagnosticsBatch = z.infer<typeof diagnosticsBatchSchema>

export const dependencyNodeSchema = z.strictObject({
  relativePath: z.string(),
  path: z.string(),
  /**
   * Resolved workspace-relative paths. Specifiers that do not resolve, or that
   * resolve outside the workspace, are dropped rather than guessed at — a
   * fabricated edge invalidates the wrong files.
   */
  imports: z.array(z.string()),
  /** Reverse edges, maintained alongside so invalidation is O(dependents). */
  importedBy: z.array(z.string()),
  /** mtimeMs at last parse — staleness without hashing every file. */
  mtimeMs: z.number().nonnegative(),
  /** The strongly-connected component this belongs to; its own path when acyclic. */
  componentId: z.string()
})
export type DependencyNode = z.infer<typeof dependencyNodeSchema>

export const dependencyCycleSchema = z.strictObject({
  id: z.string(),
  /** Sorted, so the same cycle always renders identically. */
  members: z.array(z.string()).min(2)
})
export type DependencyCycle = z.infer<typeof dependencyCycleSchema>

export const buildGraphSummarySchema = z.strictObject({
  fileCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  cycles: z.array(dependencyCycleSchema),
  /** True when the walk hit its ceiling — a sampled graph must say so. */
  truncated: z.boolean(),
  lastBuildMs: z.number().nonnegative(),
  /**
   * The tsconfig actually adopted, or null when none was found and the fallback
   * options are in use. Surfaced in the UI because a daemon checking against
   * the wrong config is worse than one that admits it.
   */
  tsconfigRelativePath: z.string().nullable()
})
export type BuildGraphSummary = z.infer<typeof buildGraphSummarySchema>

export const dependencyQuerySchema = z.strictObject({
  node: dependencyNodeSchema.nullable(),
  /** Transitive dependents, nearest first — the invalidation set. */
  dependents: z.array(z.string()),
  /**
   * The shortest import chain from the requesting pass's trigger to this file,
   * trigger-first. Empty when nothing was asked about or nothing reaches it.
   */
  chain: z.array(z.string()),
  cycle: dependencyCycleSchema.nullable()
})
export type DependencyQuery = z.infer<typeof dependencyQuerySchema>

/**
 * `failed` is deliberately distinct from `stopped`, for the same reason
 * `toolchainKind` has `unusable`: "neither running nor deliberately off" needs
 * its own name, or the UI reports a crash as a choice.
 */
export const compilerDaemonStateSchema = z.enum([
  'stopped',
  'starting',
  'indexing',
  'checking',
  'idle',
  'restarting',
  'failed'
])
export type CompilerDaemonState = z.infer<typeof compilerDaemonStateSchema>

export const compilerStatusSchema = z.strictObject({
  state: compilerDaemonStateSchema,
  graph: buildGraphSummarySchema,
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  /**
   * Files actually checked, of `graph.fileCount`. A cold workspace is only
   * partially checked by design, and partial coverage is stated rather than
   * implied away.
   */
  checkedFileCount: z.number().int().nonnegative(),
  /** Observability only — NOT the OOM enforcement mechanism (resourceLimits is). */
  heapUsedMb: z.number().nonnegative(),
  restarts: z.number().int().nonnegative(),
  /** Non-null only in `failed`; shown verbatim. */
  detail: z.string().nullable(),
  /**
   * Whether the second, read-only LanguageService is up.
   *
   * The renderer's kill switch. Hover, completions and signature help come from
   * Monaco's own worker until this turns true, and from the daemon afterwards —
   * never from both, because two providers answering the same question means
   * Monaco merges the lists and every completion appears twice. A worker that
   * fails to start therefore degrades to what shipped before rather than to
   * nothing.
   */
  interactive: z.boolean()
})
export type CompilerStatus = z.infer<typeof compilerStatusSchema>

/** The daemon before it has ever run. Shared by the service and its tests. */
export function stoppedCompilerStatus(): CompilerStatus {
  return {
    state: 'stopped',
    graph: {
      fileCount: 0,
      edgeCount: 0,
      cycles: [],
      truncated: false,
      lastBuildMs: 0,
      tsconfigRelativePath: null
    },
    errorCount: 0,
    warningCount: 0,
    checkedFileCount: 0,
    heapUsedMb: 0,
    restarts: 0,
    detail: null,
    interactive: false
  }
}

/* ---------------------------- language queries ---------------------------- */

/**
 * Everything the editor asks about a cursor, in one family of shapes.
 *
 * The daemon has the real program — the real tsconfig for TypeScript, the real
 * resolution for BCC — and until now it was asked exactly two questions, both
 * about diagnostics. These are the rest of what it already knows.
 *
 * Every position is 1-based with an EXCLUSIVE end column, matching
 * `diagnosticMessageSchema` and Monaco's `IRange`. Offsets never cross this
 * boundary: the renderer converts a position to an offset with
 * `getOffsetAt` on the way in, and the worker converts back on the way out,
 * because for a cross-file target the renderer often has no model to convert
 * against.
 */
export const sourceRangeSchema = z.strictObject({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive()
})
export type SourceRange = z.infer<typeof sourceRangeSchema>

export const languageLocationSchema = z.strictObject({
  /** POSIX-separated, workspace-relative — the key every side joins on. */
  relativePath: z.string(),
  /** Absolute, so the renderer can open a file it does not already have. */
  path: z.string(),
  range: sourceRangeSchema
})
export type LanguageLocation = z.infer<typeof languageLocationSchema>

/**
 * The unsaved buffer, carried on the request itself.
 *
 * `pushOverlay` in `models.ts` debounces 300ms because every push triggers a
 * re-check, so for up to 300ms after a keystroke the daemon's copy of a file is
 * behind what the user is looking at. A definition answered at a stale offset
 * points at the wrong token; a RENAME computed against stale text rewrites the
 * wrong bytes. Both are worse than no answer at all.
 *
 * So an interactive request carries the buffer with it. The daemon adopts it as
 * the overlay and answers against it WITHOUT scheduling a check — the debounce
 * keeps doing its real job, which is deciding when to re-check, not deciding
 * what the file says.
 */
export const documentOverlaySchema = z.strictObject({
  content: z.string(),
  /** Monaco's version id: monotonic per model, so a late overlay is discardable. */
  version: z.number().int().nonnegative()
})
export type DocumentOverlay = z.infer<typeof documentOverlaySchema>

/**
 * How many references travel the wire before the answer is cut short.
 *
 * Find-all-references on a common identifier in a large workspace returns tens
 * of thousands of hits, and a result nobody can read is not worth the
 * structured clone. Same instinct as `MAX_DIAG_TRACE_EVENTS`, and the flag is
 * the important half: a truncated answer that does not say so is a wrong one.
 */
export const MAX_REFERENCE_RESULTS = 5_000

export const referencesResultSchema = z.strictObject({
  locations: z.array(languageLocationSchema).max(MAX_REFERENCE_RESULTS),
  truncated: z.boolean()
})
export type ReferencesResult = z.infer<typeof referencesResultSchema>

export const definitionResultSchema = z.strictObject({
  /**
   * A list rather than a single location, because a TypeScript symbol can have
   * several declarations (an overload set, a merged interface) and picking one
   * of them in the daemon would throw away the answer the user wanted.
   */
  locations: z.array(languageLocationSchema).max(MAX_REFERENCE_RESULTS)
})
export type DefinitionResult = z.infer<typeof definitionResultSchema>

export const documentSymbolKindSchema = z.enum(['function', 'variable', 'parameter'])
export type DocumentSymbolKind = z.infer<typeof documentSymbolKindSchema>

export interface DocumentSymbolNode {
  readonly name: string
  /** The signature or type, appended after the name in the outline. */
  readonly detail: string
  readonly kind: DocumentSymbolKind
  /** The whole declaration — what the outline highlights. */
  readonly range: SourceRange
  /** Just the name — where clicking the row puts the cursor. */
  readonly selectionRange: SourceRange
  readonly children: readonly DocumentSymbolNode[]
}

/**
 * Recursive, so `z.lazy` and an explicit annotation. The interface above is
 * written by hand rather than inferred because a self-referencing schema cannot
 * infer its own type.
 */
export const documentSymbolNodeSchema: z.ZodType<DocumentSymbolNode> = z.lazy(() =>
  z.strictObject({
    name: z.string(),
    detail: z.string(),
    kind: documentSymbolKindSchema,
    range: sourceRangeSchema,
    selectionRange: sourceRangeSchema,
    children: z.array(documentSymbolNodeSchema)
  })
)

export const documentSymbolsResultSchema = z.strictObject({
  symbols: z.array(documentSymbolNodeSchema)
})
export type DocumentSymbolsResult = z.infer<typeof documentSymbolsResultSchema>

export const hoverResultSchema = z.strictObject({
  /** Rendered as markdown. Null means "nothing to say", not "not ready". */
  contents: z.string().nullable(),
  range: sourceRangeSchema.nullable()
})
export type HoverResult = z.infer<typeof hoverResultSchema>

export const textEditSchema = z.strictObject({
  range: sourceRangeSchema,
  newText: z.string()
})
export type TextEdit = z.infer<typeof textEditSchema>

export const fileEditSchema = z.strictObject({
  relativePath: z.string(),
  path: z.string(),
  /**
   * Descending by position, so applying them in order cannot invalidate the
   * ranges of the ones not yet applied. Produced sorted rather than sorted at
   * the point of use, because every consumer would otherwise have to remember.
   */
  edits: z.array(textEditSchema)
})
export type FileEdit = z.infer<typeof fileEditSchema>

/**
 * One channel serves both halves of a rename.
 *
 * Monaco asks twice: `resolveRenameLocation` when F2 is pressed, to draw the
 * inline box over the right word, and `provideRenameEdits` when the new name is
 * committed. Sending `newName: null` asks the first question — `target` and
 * `placeholder` come back and `files` is empty — and sending a name asks the
 * second. Two channels would mean two copies of "where is the symbol under this
 * offset", which is precisely the part that must agree.
 */
export const renameResultSchema = z.strictObject({
  /** The identifier being renamed. Null when there is nothing renameable here. */
  target: sourceRangeSchema.nullable(),
  placeholder: z.string().nullable(),
  files: z.array(fileEditSchema),
  /** Shown to the user verbatim by Monaco's rename widget. */
  error: z.string().nullable()
})
export type RenameResult = z.infer<typeof renameResultSchema>

/**
 * A quick fix, with the edits that carry it out.
 *
 * `edits` covers every file the fix touches, which for an import fix is often
 * two — the file with the error and the one the symbol comes from. That is why
 * this carries the same `FileEdit` shape a rename does rather than a single
 * file's worth: the caller has the same partition to make between open buffers
 * and files on disk, and the same all-or-nothing rule to enforce.
 */
export const codeActionSchema = z.strictObject({
  /** Shown in the lightbulb menu, verbatim. */
  title: z.string(),
  /**
   * `quickfix` or `refactor`, in Monaco's vocabulary. Kept as a string rather
   * than an enum because Monaco matches these by dotted prefix and inventing a
   * closed set here would mean widening it every time TypeScript adds a fix.
   */
  kind: z.string(),
  /** True for the fix TypeScript itself would apply first. */
  preferred: z.boolean(),
  edits: z.array(fileEditSchema)
})
export type CodeAction = z.infer<typeof codeActionSchema>

/** Capped for the same reason references are: a menu nobody can read is waste. */
export const MAX_CODE_ACTIONS = 32

export const codeActionsResultSchema = z.strictObject({
  actions: z.array(codeActionSchema).max(MAX_CODE_ACTIONS)
})
export type CodeActionsResult = z.infer<typeof codeActionsResultSchema>

/* ---------------------------- interactive answers ------------------------- */

/**
 * Completions, hover and signature help — the answers that are asked for at
 * keystroke frequency.
 *
 * These are correct only with the whole program, and Monaco's bundled worker
 * has none of it: with no tsconfig and no module resolution, what it can say
 * about a symbol that came from another file is a guess. But they are also
 * asked hundreds of times a minute, which is why they cannot come from the
 * check worker — cancelling the check on every keystroke would mean diagnostics
 * never converge while typing. They come from a second, read-only
 * LanguageService that is never interrupted.
 */

/**
 * TypeScript's own `ScriptElementKind`, passed through as a string.
 *
 * Not an enum here. TypeScript adds kinds between versions, and a closed set
 * would turn a new one into a validation failure that drops the whole
 * completion list rather than one icon. The renderer maps what it recognises
 * and falls back to a plain text icon for the rest.
 */
export const completionItemSchema = z.strictObject({
  label: z.string(),
  kind: z.string(),
  /** What is written when the item is accepted; usually the label. */
  insertText: z.string(),
  /** TypeScript's own ordering, which puts locals above globals. */
  sortText: z.string(),
  /**
   * Opaque, and handed straight back on the detail request.
   *
   * `getCompletionEntryDetails` needs the entry's name and the module it came
   * from to describe it, and an auto-import entry's `source` is the only thing
   * distinguishing two identically named symbols from different modules.
   */
  source: z.string().nullable()
})
export type CompletionItem = z.infer<typeof completionItemSchema>

/**
 * A cap, and a flag that says when it bit.
 *
 * A global completion list in a DOM project is several thousand entries, and
 * every one of them crosses a structured clone on a keystroke. `incomplete`
 * asks Monaco to re-request as the user types — which is what narrows the list
 * — rather than silently serving a truncated one.
 */
export const MAX_COMPLETION_ITEMS = 2_000

export const completionsResultSchema = z.strictObject({
  items: z.array(completionItemSchema).max(MAX_COMPLETION_ITEMS),
  incomplete: z.boolean()
})
export type CompletionsResult = z.infer<typeof completionsResultSchema>

export const completionDetailResultSchema = z.strictObject({
  /** The signature, as TypeScript renders it. */
  detail: z.string().nullable(),
  /** The doc comment, already flattened to text. */
  documentation: z.string().nullable()
})
export type CompletionDetailResult = z.infer<typeof completionDetailResultSchema>

export const signatureParameterSchema = z.strictObject({
  label: z.string(),
  documentation: z.string().nullable()
})

export const signatureSchema = z.strictObject({
  label: z.string(),
  documentation: z.string().nullable(),
  parameters: z.array(signatureParameterSchema)
})

export const signatureHelpResultSchema = z.strictObject({
  signatures: z.array(signatureSchema).max(64),
  activeSignature: z.number().int().nonnegative(),
  activeParameter: z.number().int().nonnegative()
})
export type SignatureHelpResult = z.infer<typeof signatureHelpResultSchema>

/* -------------------------------- artifacts ------------------------------- */

/**
 * A durable, code-anchored explanation.
 *
 * The behaviour reproduced here is Antigravity's: an agent's explanation is not
 * a chat message that scrolls away, it is an artifact that persists, cites
 * specific code, and can be commented on — and the comment steers the agent
 * rather than starting a fresh conversation.
 *
 * What this adds that a chat transcript cannot: an anchor carries a hash of the
 * lines it described, so an artifact read a week later can say "this part is
 * describing code that has since changed" instead of pointing confidently at
 * whatever now occupies those line numbers.
 */
export const codeAnchorSchema = z.strictObject({
  relativePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  symbol: z.string().nullable(),
  /** Hash of the anchored lines at the moment the artifact was written. */
  snapshotHash: z.string()
})
export type CodeAnchorRecord = z.infer<typeof codeAnchorSchema>

export const artifactSectionSchema = z.strictObject({
  id: z.string().min(1),
  heading: z.string(),
  markdown: z.string(),
  anchors: z.array(codeAnchorSchema)
})
export type ArtifactSectionRecord = z.infer<typeof artifactSectionSchema>

export const artifactCommentSchema = z.strictObject({
  id: z.string().min(1),
  /** Null for a comment on the artifact as a whole. */
  sectionId: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  /**
   * The artifact the agent produced in reply, if it has answered.
   *
   * A reply is a NEW artifact rather than an edit to this one. Sections are
   * immutable by construction: an explanation you can silently rewrite is not
   * evidence of what was said, which is the same reason ai-log.ts appends a
   * revert entry rather than amending the original.
   */
  respondedInArtifactId: z.string().nullable()
})
export type ArtifactComment = z.infer<typeof artifactCommentSchema>

export const artifactKindSchema = z.enum(['explanation', 'walkthrough'])
export type ArtifactKind = z.infer<typeof artifactKindSchema>

export const artifactSchema = z.strictObject({
  id: z.string().min(1),
  kind: artifactKindSchema,
  title: z.string(),
  createdAt: z.string(),
  model: z.string(),
  /** Same 16-hex convention as ai-log.ts, from `hashPrompt`. */
  promptHash: z.string(),
  /**
   * The exact text the model received, verbatim.
   *
   * Stored rather than reconstructed, for the reason `renderContext` exists at
   * all: a viewer that rebuilds its own approximation of the prompt drifts, and
   * the transparency claim quietly becomes false.
   */
  contextSent: z.string(),
  sections: z.array(artifactSectionSchema),
  comments: z.array(artifactCommentSchema),
  /** The artifact this one answers, when it was produced from a comment. */
  supersedes: z.string().nullable()
})
export type Artifact = z.infer<typeof artifactSchema>

/** List rows: enough to render the index without loading every artifact. */
export const artifactSummarySchema = z.strictObject({
  id: z.string(),
  kind: artifactKindSchema,
  title: z.string(),
  createdAt: z.string(),
  sectionCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  unansweredCommentCount: z.number().int().nonnegative(),
  supersedes: z.string().nullable()
})
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>

/* ------------------------------ walkthrough ------------------------------- */

export const walkthroughFileChangeSchema = z.strictObject({
  path: z.string().min(1),
  before: z.string(),
  after: z.string()
})
export type WalkthroughFileChange = z.infer<typeof walkthroughFileChangeSchema>

export const walkthroughRequestSchema = z.strictObject({
  instruction: z.string().min(1),
  files: z.array(walkthroughFileChangeSchema).min(1).max(20)
})
export type WalkthroughRequest = z.infer<typeof walkthroughRequestSchema>

/* --------------------------- semantic index -------------------------------- */

export const semanticMatchSchema = z.strictObject({
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  preview: z.string(),
  score: z.number()
})
export type SemanticMatch = z.infer<typeof semanticMatchSchema>

export const semanticIndexStatusSchema = z.strictObject({
  built: z.boolean(),
  builtAt: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative()
})
export type SemanticIndexStatus = z.infer<typeof semanticIndexStatusSchema>

/* --------------------------- compiler intelligence ------------------------ */

/**
 * Why one query returned what it returned.
 *
 * Mirrors `QueryOutcome` in query-engine.ts. Restated here as a zod enum rather
 * than imported because everything crossing to the renderer is validated at the
 * boundary, and the engine module is deliberately free of dependencies — it
 * must stay importable by a worker that has no zod.
 */
export const queryOutcomeSchema = z.enum([
  'miss',
  'fresh',
  'durable',
  'validated',
  'cutoff',
  'recomputed'
])
export type QueryOutcomeName = z.infer<typeof queryOutcomeSchema>

export const queryDurabilitySchema = z.enum(['workspace', 'external', 'lib'])
export type QueryDurabilityName = z.infer<typeof queryDurabilitySchema>

/**
 * One line of the daemon's working. This is the entire data source for the
 * Compiler Intelligence view, which exists to answer the question no IDE on the
 * market answers: not "what is wrong with my code" but "what did the compiler
 * just do, and why".
 */
export const compilerTraceEventSchema = z.strictObject({
  /** `namespace:argument`, e.g. `diag:src/app.ts` — the namespace is `diag`. */
  key: z.string(),
  outcome: queryOutcomeSchema,
  durability: queryDurabilitySchema,
  ms: z.number().nonnegative(),
  depth: z.number().int().nonnegative(),
  depsWalked: z.number().int().nonnegative()
})
export type CompilerTraceEvent = z.infer<typeof compilerTraceEventSchema>

export const queryEngineStatsSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  memoCount: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  recomputes: z.number().int().nonnegative(),
  cutoffs: z.number().int().nonnegative(),
  /** Dependency walks avoided outright by the durability tier. */
  durableSkips: z.number().int().nonnegative()
})
export type QueryEngineStats = z.infer<typeof queryEngineStatsSchema>

/**
 * One completed check pass, as the panel sees it.
 *
 * `requested` vs `recomputed` is the pair the whole feature is built to show:
 * how many files the invalidation walk asked about, against how many actually
 * needed the type checker. The gap is the work the signature cutoff saved, and
 * it is the number to point at when comparing against an editor that rechecks
 * everything.
 */
export const compilerPassSchema = z.strictObject({
  /** Monotonic within a daemon lifetime; resets on restart. */
  id: z.number().int().nonnegative(),
  /**
   * Which daemon produced this — Part 12's whole reason for adding the field.
   * TypeScript and BCC each run their own worker with their own `id` sequence,
   * so `id` alone cannot tell two passes apart; the Compiler Intelligence panel
   * uses this to badge a row and to filter, not to reorder anything.
   */
  language: z.enum(['typescript', 'bcc']),
  /** Wall-clock `Date.now()`, so passes from two different daemons can be merged
   * into one timeline. `id` cannot do this — it resets whenever a daemon
   * restarts and is not comparable across the two workers.
   */
  at: z.number().nonnegative(),
  /** What triggered it — a saved file, an unsaved buffer, or the initial index. */
  /**
   * 'index' is the walk. 'cold' is the FIRST check, which builds the program and
   * the type checker and costs seconds. Kept as separate members rather than
   * folded together because they are different events, and conflating them would
   * make the distinction unrecoverable.
   *
   * 'observatory' exists only on a `language: 'bcc'` pass: the user opened the
   * Observatory (or switched its focused function), which pulls `ir`/`ssa`/
   * `pass` queries that a `diag:` check never touches. Grouping it under
   * 'buffer' would say an edit caused work that an on-demand read actually did.
   */
  reason: z.enum(['index', 'cold', 'watch', 'buffer', 'idle', 'observatory']),
  /**
   * The paths reported changed or removed — the edit that caused this pass.
   *
   * The missing half of a pass. `requested`/`recomputed` say how much work
   * happened; without this nothing can say what caused it, which is the question
   * the Why tab exists to answer.
   *
   * Required rather than optional on purpose: this is a strictObject validated on
   * two channels, so a producer that forgets it fails loudly instead of shipping
   * an undefined the view has to guard.
   */
  trigger: z.array(z.string()),
  /** Files named by the invalidation walk. */
  requested: z.number().int().nonnegative(),
  /** Files whose diagnostics the type checker actually had to produce. */
  recomputed: z.number().int().nonnegative(),
  /** Files served from memo because their imports' signatures had not moved. */
  reused: z.number().int().nonnegative(),
  totalMs: z.number().nonnegative(),
  events: z.array(compilerTraceEventSchema),
  stats: queryEngineStatsSchema
})
export type CompilerPass = z.infer<typeof compilerPassSchema>

/* -------------------------------------------------------------------------- */
/*  Part 11 — the Observatory                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One line of a BCC stage, as the Observatory renders it: text a person reads,
 * and the source region a click on it reveals. `range: null` marks a line that
 * names no single place in the source — a block label, a closing brace.
 *
 * Shared by every tab: tokens, the AST, symbols, IR, SSA and bytecode are all
 * `readonly CodeLine[]` on the wire, so the renderer has exactly one component
 * that draws a clickable listing rather than one per stage.
 */
export const codeLineSchema = z.strictObject({
  text: z.string(),
  range: sourceRangeSchema.nullable()
})
export type CodeLine = z.infer<typeof codeLineSchema>

/** One optimisation pass applied to one function, before and after side by side. */
export const observatoryPassSchema = z.strictObject({
  name: z.string(),
  summary: z.string(),
  changed: z.boolean(),
  notes: z.array(z.string()),
  before: z.array(codeLineSchema),
  after: z.array(codeLineSchema)
})
export type ObservatoryPass = z.infer<typeof observatoryPassSchema>

export const observatoryFailureSchema = z.strictObject({
  /** Null when the IR was already malformed before any pass ran. */
  pass: z.string().nullable(),
  message: z.string()
})

/** Every stage's answer for one function — named, or the synthetic `<main>`. */
export const observatoryFunctionSchema = z.strictObject({
  name: z.string(),
  isSynthetic: z.boolean(),
  range: sourceRangeSchema,
  ir: z.array(codeLineSchema),
  ssa: z.array(codeLineSchema),
  passes: z.array(observatoryPassSchema),
  /**
   * Null when the function's IR failed the verifier — the pipeline halts
   * rather than fabricate optimised IR or bytecode for something that never
   * verified, so the panel has nothing well-formed left to compile.
   */
  bytecode: z.array(codeLineSchema).nullable(),
  failure: observatoryFailureSchema.nullable()
})
export type ObservatoryFunction = z.infer<typeof observatoryFunctionSchema>

/**
 * Every stage of one `.bcc` file: source → tokens → AST → symbols → per-function
 * IR → SSA → passes → bytecode. `supported: false` is the answer for anything
 * that is not a `.bcc` file — TypeScript has no IR in this codebase, so the
 * Observatory has nothing to show it, and says so rather than an empty panel
 * with no explanation.
 */
export const observatorySnapshotSchema = z.strictObject({
  supported: z.boolean(),
  relativePath: z.string(),
  path: z.string(),
  source: z.string(),
  tokens: z.array(codeLineSchema),
  ast: z.array(codeLineSchema),
  symbols: z.array(codeLineSchema),
  diagnostics: z.array(diagnosticMessageSchema),
  functions: z.array(observatoryFunctionSchema)
})
export type ObservatorySnapshot = z.infer<typeof observatorySnapshotSchema>

export function unsupportedObservatorySnapshot(
  relativePath: string,
  path: string
): ObservatorySnapshot {
  return {
    supported: false,
    relativePath,
    path,
    source: '',
    tokens: [],
    ast: [],
    symbols: [],
    diagnostics: [],
    functions: []
  }
}
