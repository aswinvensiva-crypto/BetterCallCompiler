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

export const settingsSchema = z.strictObject({
  aiModel: z.string().min(1),
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

export const aiModeSchema = z.enum(['explain', 'find-bugs', 'improve'])
export type AiMode = z.infer<typeof aiModeSchema>

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

export const aiDoneSchema = z.strictObject({
  streamId: z.string(),
  stopReason: z.string().nullable(),
  /** Human-readable; already mapped from 401/429/network by the service. */
  error: z.string().nullable(),
  cancelled: z.boolean()
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
  revertOf: z.string().nullable()
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
  reason: z.string().nullable()
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
