import { beforeEach, describe, expect, it } from 'vitest'
import {
  INVOKE_CHANNEL_NAMES,
  INVOKE_CHANNELS,
  type Result
} from '../../src/shared/ipc-contract'
import { createHandlerMap, registerIpcHandlers } from '../../src/main/ipc'
import { invokeRegistered, resetStub } from '../fixtures/electron-stub'
import { secretsStateSchema } from '../../src/shared/types'

beforeEach(() => {
  resetStub()
})

/**
 * Security invariant 9, asserted rather than assumed.
 *
 * "The Anthropic API key and GitHub token never cross the bridge in plaintext.
 * There is a `secrets:setKey` / `secrets:hasKey` / `secrets:clearKey` — there is
 * **no** `secrets:getKey`."
 *
 * These tests are the enforcement. A future channel that returned a secret would
 * have to be added to the table, and the table is what is checked here.
 */
describe('the secrets boundary', () => {
  it('declares exactly the three permitted secret channels', () => {
    const secretChannels = INVOKE_CHANNEL_NAMES.filter((channel) =>
      channel.startsWith('secrets:')
    ).sort()

    expect(secretChannels).toEqual(['secrets:clearKey', 'secrets:hasKey', 'secrets:setKey'])
  })

  it('has no channel whose name suggests reading a secret', () => {
    for (const channel of INVOKE_CHANNEL_NAMES) {
      expect(channel).not.toMatch(/^secrets:(get|read|reveal|show|export)/i)
    }
  })

  /**
   * The stronger check: it is not enough that no channel is *named* getKey — no
   * secret channel may declare a response that could carry a value. Every one of
   * them responds with presence booleans only.
   */
  it('gives every secret channel a response that can only carry presence', () => {
    for (const channel of ['secrets:setKey', 'secrets:hasKey', 'secrets:clearKey'] as const) {
      const spec = INVOKE_CHANNELS[channel]

      // A response carrying a plaintext key would have to parse a string
      // somewhere in `secrets`. strictObject of three booleans cannot.
      expect(
        spec.response.safeParse({
          secrets: { anthropic: true, github: true, encryptionAvailable: true }
        }).success
      ).toBe(true)

      expect(
        spec.response.safeParse({
          secrets: {
            anthropic: true,
            github: true,
            encryptionAvailable: true,
            value: 'sk-ant-smuggled'
          }
        }).success
      ).toBe(false)
    }
  })

  it('describes state as booleans only', () => {
    expect(
      secretsStateSchema.safeParse({ anthropic: false, github: false, encryptionAvailable: true })
        .success
    ).toBe(true)
    expect(
      secretsStateSchema.safeParse({
        anthropic: 'sk-ant-oops',
        github: false,
        encryptionAvailable: true
      }).success
    ).toBe(false)
  })

  it('answers hasKey with presence and nothing else', async () => {
    registerIpcHandlers(createHandlerMap())

    const result = (await invokeRegistered('secrets:hasKey', {})) as Result<{
      secrets: Record<string, unknown>
    }>

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(Object.keys(result.value.secrets).sort()).toEqual([
      'anthropic',
      'encryptionAvailable',
      'github'
    ])
    for (const value of Object.values(result.value.secrets)) {
      expect(typeof value).toBe('boolean')
    }
  })

  it('rejects a key name the enum does not list', async () => {
    registerIpcHandlers(createHandlerMap())

    const result = (await invokeRegistered('secrets:clearKey', {
      key: '../../etc/passwd'
    })) as Result<unknown>

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error.code).toBe('BAD_REQUEST')
  })
})

describe('the settings boundary', () => {
  it('accepts a partial patch, so a caller need not resend every field', () => {
    const spec = INVOKE_CHANNELS['settings:set']
    expect(spec.request.safeParse({ patch: { githubUser: 'octocat' } }).success).toBe(true)
    expect(spec.request.safeParse({ patch: {} }).success).toBe(true)
  })

  it('rejects an unknown preference rather than silently storing it', () => {
    const spec = INVOKE_CHANNELS['settings:set']
    expect(spec.request.safeParse({ patch: { anthropicKey: 'sk-ant-oops' } }).success).toBe(false)
  })

  it('rejects a full settings object with the wrong types', () => {
    const spec = INVOKE_CHANNELS['settings:set']
    expect(spec.request.safeParse({ patch: { telemetry: 'yes' } }).success).toBe(false)
  })
})
