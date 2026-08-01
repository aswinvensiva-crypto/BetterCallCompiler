import { describe, expect, it } from 'vitest'
import { WINDOWS_CANCELLED_EXIT_CODE, describeExit } from '../../src/shared/types'

describe('exit code reporting', () => {
  it('reports a cancelled process as cancelled, not as a failure', () => {
    // Verified empirically: killing a pty on Windows surfaces 0xC000013A.
    // Printing it raw tells the user their build failed with exit code
    // -1073741510 when they simply pressed Cancel.
    expect(WINDOWS_CANCELLED_EXIT_CODE).toBe(-1073741510)
    expect(describeExit(WINDOWS_CANCELLED_EXIT_CODE)).toBe('cancelled')
    expect(describeExit(WINDOWS_CANCELLED_EXIT_CODE)).not.toContain('-1073741510')
  })

  it('distinguishes success from failure', () => {
    expect(describeExit(0)).toBe('exited cleanly')
    expect(describeExit(1)).toBe('exited with code 1')
    expect(describeExit(127)).toBe('exited with code 127')
  })
})
