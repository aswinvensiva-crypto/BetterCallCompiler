import { beforeEach, describe, expect, it } from 'vitest'
import {
  INVOKE_CHANNELS,
  INVOKE_CHANNEL_NAMES,
  splitChannel,
  tableChannelNames,
  type Result
} from '../../src/shared/ipc-contract'
import { createHandlerMap, registerIpcHandlers, type HandlerMap } from '../../src/main/ipc'
import { registeredChannels, invokeRegistered, resetStub } from '../fixtures/electron-stub'

beforeEach(() => {
  resetStub()
})

describe('channel table', () => {
  it('names every channel as namespace:method', () => {
    for (const channel of INVOKE_CHANNEL_NAMES) {
      expect(() => splitChannel(channel)).not.toThrow()
      const { namespace, method } = splitChannel(channel)
      expect(namespace).not.toBe('')
      expect(method).not.toBe('')
    }
  })

  it('rejects malformed channel names', () => {
    for (const bad of ['nocolon', ':leading', 'trailing:', '']) {
      expect(() => splitChannel(bad)).toThrow()
    }
  })

  // The schema table and the zero-dependency name registry live in different
  // files so the preload can avoid zod. `satisfies` catches drift at compile
  // time; this catches it for anyone reading a stale build.
  it('keeps the schema table and the channel registry in lockstep', () => {
    expect(tableChannelNames().sort()).toEqual([...INVOKE_CHANNEL_NAMES].sort())
  })

  it('gives every channel both a request and a response schema', () => {
    for (const channel of INVOKE_CHANNEL_NAMES) {
      const spec = INVOKE_CHANNELS[channel]
      expect(typeof spec.request.safeParse).toBe('function')
      expect(typeof spec.response.safeParse).toBe('function')
    }
  })
})

describe('contract completeness', () => {
  // The invariant: a channel with no table entry has no handler, and a table
  // entry with no handler cannot exist. Diff both directions.
  it('implements exactly the channels the table declares', () => {
    const handlerChannels = Object.keys(createHandlerMap()).sort()
    const tableChannels = [...INVOKE_CHANNEL_NAMES].sort()

    expect(handlerChannels).toEqual(tableChannels)
  })

  it('registers exactly the channels the table declares', () => {
    const registered = [...registerIpcHandlers(createHandlerMap())].sort()
    const tableChannels = [...INVOKE_CHANNEL_NAMES].sort()

    expect(registered).toEqual(tableChannels)
    expect(registeredChannels().sort()).toEqual(tableChannels)
  })

  it('is idempotent, so a dev hot reload cannot wedge registration', () => {
    registerIpcHandlers(createHandlerMap())
    expect(() => registerIpcHandlers(createHandlerMap())).not.toThrow()
    expect(registeredChannels().sort()).toEqual([...INVOKE_CHANNEL_NAMES].sort())
  })
})

describe('the validation wrapper', () => {
  it('returns ok with a validated payload for a good request', async () => {
    registerIpcHandlers(createHandlerMap())

    const result = (await invokeRegistered('app:ping', {})) as Result<{
      pong: true
      version: string
      platform: string
    }>

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.value.pong).toBe(true)
    expect(result.value.version).toBe('0.1.0-test')
    expect(result.value.platform).toBe(process.platform)
  })

  it('rejects an unknown key rather than silently stripping it', async () => {
    registerIpcHandlers(createHandlerMap())

    const result = (await invokeRegistered('app:ping', { smuggled: true })) as Result<unknown>

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error.code).toBe('BAD_REQUEST')
  })

  it('rejects a request of the wrong type', async () => {
    registerIpcHandlers(createHandlerMap())

    for (const bad of [null, 'string', 42, []]) {
      const result = (await invokeRegistered('app:ping', bad)) as Result<unknown>
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.code).toBe('BAD_REQUEST')
    }
  })

  it('converts a thrown handler into a Result instead of letting it cross IPC', async () => {
    const throwing: HandlerMap = {
      ...createHandlerMap(),
      'app:ping': () => {
        throw new Error('boom')
      }
    }
    registerIpcHandlers(throwing)

    const result = (await invokeRegistered('app:ping', {})) as Result<unknown>

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error.code).toBe('HANDLER_FAILED')
    expect(result.error.message).toContain('boom')
  })

  // Services signal specific failures with BetterCallCompilerServiceError; the wrapper
  // must surface that code rather than flattening everything to HANDLER_FAILED.
  it('preserves a service error code instead of flattening it', async () => {
    registerIpcHandlers(createHandlerMap())

    const result = (await invokeRegistered('fs:readDir', { path: '.' })) as Result<unknown>

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error.code).toBe('NO_WORKSPACE')
  })

  it('catches a handler that returns the wrong shape', async () => {
    const wrongShape = {
      ...createHandlerMap(),
      'app:ping': () => ({ pong: false, version: 7 })
    } as unknown as HandlerMap
    registerIpcHandlers(wrongShape)

    const result = (await invokeRegistered('app:ping', {})) as Result<unknown>

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error.code).toBe('BAD_RESPONSE')
  })
})
