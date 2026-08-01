import { z } from 'zod'
import type { EventChannel, InvokeChannel } from './ipc-channels'
import {
  fileNodeSchema,
  fsWatchEventSchema,
  terminalDataSchema,
  terminalExitSchema,
  terminalSessionSchema,
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
  | { readonly ok: false; readonly error: ApertureError }

export interface ApertureError {
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
  'UNSUPPORTED'
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
export class ApertureServiceError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ApertureServiceError'
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
  }
} as const satisfies Record<InvokeChannel, ChannelSpec>

/** THE event table: main → renderer pushes, one payload schema per channel. */
export const EVENT_CHANNELS = {
  'fs:watchEvent': { payload: fsWatchEventSchema },
  'terminal:data': { payload: terminalDataSchema },
  'terminal:exit': { payload: terminalExitSchema }
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
 * The exact type of `window.aperture`, derived from both tables. Adding a
 * channel adds a typed method with no other edit — and there is deliberately no
 * index signature, so there is no way to reach a channel the tables do not name.
 */
export type ApertureApi = {
  readonly [P in PrefixOf<InvokeChannel | EventChannel>]: InvokeMethodsFor<P> & EventMethodsFor<P>
}

/** Renders zod issues into one human-readable line for an `ApertureError`. */
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
