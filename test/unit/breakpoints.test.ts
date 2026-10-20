import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyResolved,
  breakpointsFor,
  onBreakpointsChanged,
  toggleBreakpoint
} from '../../src/renderer/editor/breakpoints'

/**
 * Breakpoint bookkeeping, without an editor.
 *
 * Everything that paints checks for an attached editor first and returns, so
 * the store underneath is drivable in plain Node — which is where the one
 * decision worth pinning lives: WHO a change notifies.
 */

beforeEach(() => {
  // The module holds one store for the window's lifetime, so a test that left
  // dots behind would silently change the next one's answers.
  for (const file of ['a.bcc', 'b.bcc']) {
    applyResolved(file, [])
  }
})

describe('setting and clearing', () => {
  it('toggles a line on and off again', () => {
    toggleBreakpoint('a.bcc', 4)
    expect(breakpointsFor('a.bcc')).toEqual([4])
    toggleBreakpoint('a.bcc', 4)
    expect(breakpointsFor('a.bcc')).toEqual([])
  })

  it('keeps files apart', () => {
    toggleBreakpoint('a.bcc', 4)
    toggleBreakpoint('b.bcc', 9)
    expect(breakpointsFor('a.bcc')).toEqual([4])
    expect(breakpointsFor('b.bcc')).toEqual([9])
  })

  it('reports lines in order, whatever order they were clicked in', () => {
    for (const line of [12, 3, 7]) toggleBreakpoint('a.bcc', line)
    expect(breakpointsFor('a.bcc')).toEqual([3, 7, 12])
  })
})

describe('who a change notifies', () => {
  it('tells listeners when the USER moves a breakpoint', () => {
    // The debug view listens so that a dot placed mid-session is armed before
    // the next Continue, rather than being run straight past.
    let calls = 0
    const stop = onBreakpointsChanged(() => {
      calls++
    })

    toggleBreakpoint('a.bcc', 5)
    expect(calls).toBe(1)
    stop()
  })

  it('stays silent when the SESSION says where a breakpoint landed', () => {
    /*
     * This is a loop, not a nicety.
     *
     * The debug view applies the resolved lines from every `stopped` message,
     * and it also re-sends breakpoints whenever they change. If applying the
     * session's own answer counted as a change, each stop would send a
     * `setBreakpoints`, which produces another stop, which applies again —
     * forever, at IPC speed, for as long as the session is open.
     *
     * The listeners exist to carry USER intent to the session. An answer coming
     * back the other way is already accounted for by the snapshot that carried
     * it.
     */
    let calls = 0
    const stop = onBreakpointsChanged(() => {
      calls++
    })

    applyResolved('a.bcc', [11])

    expect(calls, 'applying the session answer must not re-notify').toBe(0)
    expect(breakpointsFor('a.bcc'), 'but it must still move the dot').toEqual([11])
    stop()
  })

  it('moves a dot to where the session really put it', () => {
    // A breakpoint clicked beside a comment resolves to the next line with
    // code. Leaving it where it was clicked is the single most common way a
    // debugger lies to its user.
    toggleBreakpoint('a.bcc', 3)
    applyResolved('a.bcc', [7])
    expect(breakpointsFor('a.bcc')).toEqual([7])
  })
})
