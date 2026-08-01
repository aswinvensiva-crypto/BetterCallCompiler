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
