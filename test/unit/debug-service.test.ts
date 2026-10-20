import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetForTests, setWorkspace } from '../../src/main/fs-service'
import {
  activeDebugSessions,
  sendCommand,
  setBreakpoints,
  startDebug,
  stopDebug
} from '../../src/main/debug-service'
import { BetterCallCompilerServiceError } from '../../src/shared/ipc-contract'

/**
 * The debug service's refusals and its bookkeeping.
 *
 * Everything here happens BEFORE a worker exists, or after one is gone, which
 * is the part that can be tested without a built bundle — `startDebug` on a
 * real `.bcc` file loads `out/main/lang-vm-worker.js`, and the E2E suite drives
 * that against the real app. What is worth pinning here is that the service
 * refuses the cases it cannot serve, rather than opening a session that will
 * never stop anywhere.
 */

describe('starting a session', () => {
  let workspace = ''

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'bettercallcompiler-debug-'))
    await setWorkspace(workspace)
  })

  afterEach(async () => {
    await resetForTests()
    if (workspace !== '') await rm(workspace, { recursive: true, force: true })
  })

  it('refuses a language it cannot debug, rather than opening an empty session', async () => {
    /*
     * The built-in debugger drives the BCC VM and nothing else. Everything else
     * needs a real adapter — `dap-client.ts` exists for exactly that and has no
     * launcher yet — so a `.ts` file has to be a refusal with a reason. A
     * session that started and then never stopped anywhere would look like a
     * hang, and the user would have no way to tell which it was.
     */
    await writeFile(join(workspace, 'a.ts'), 'const x = 1\n', 'utf8')

    await expect(startDebug(join(workspace, 'a.ts'))).rejects.toThrow(
      BetterCallCompilerServiceError
    )
    expect(activeDebugSessions(), 'nothing should have been left behind').toBe(0)
  })

  it('refuses to escape the workspace', async () => {
    // The same `confinePath` every other file-taking service uses, so a debug
    // request cannot read a file the explorer could not.
    const refusal = await startDebug(join(workspace, '..', 'elsewhere.bcc')).catch(
      (error: unknown) => error
    )

    /*
     * The CODE, not just that it threw. The path ends in `.bcc` and does not
     * exist, so a version of this that only asserted "it rejected" would pass
     * on an ENOENT from reading the file — proving the opposite of what it
     * claims, since reading it at all is the escape.
     */
    expect(refusal).toBeInstanceOf(BetterCallCompilerServiceError)
    expect((refusal as BetterCallCompilerServiceError).code).toBe('PATH_ESCAPES_WORKSPACE')
    expect(activeDebugSessions()).toBe(0)
  })

  it('refuses when no folder is open', async () => {
    await resetForTests()
    await expect(startDebug('anything.bcc')).rejects.toThrow(BetterCallCompilerServiceError)
  })
})

describe('a session that is not there', () => {
  /*
   * The window can race a session that ended — a program that failed to compile
   * is gone before the panel's first click lands. Every entry point says so
   * rather than dropping the command, because a dropped command leaves the
   * panel waiting for a `stopped` event that is never coming.
   */

  it('reports the command was not accepted', () => {
    expect(sendCommand('debug-nope', 'stepOver')).toBe(false)
  })

  it('reports breakpoints were not accepted', () => {
    expect(setBreakpoints('debug-nope', [1, 2])).toBe(false)
  })

  it('reports there was nothing to stop', () => {
    expect(stopDebug('debug-nope')).toBe(false)
  })
})
