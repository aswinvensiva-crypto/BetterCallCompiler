import { describe, expect, it } from 'vitest'
import {
  buildBatchCommandLine,
  classifyToolchain,
  isBatchShim,
  isWindowsAppsPath,
  UnsafeArgumentError,
  type StubEvidence
} from '../../src/main/toolchains'
import { isRunnable, toolchainSchema } from '../../src/shared/types'

/**
 * The classification rule and the command-line builder are pure, so they are
 * tested directly against fixtures rather than against whatever happens to be
 * installed on the machine running the suite.
 */

const WINDOWS_APPS_PYTHON =
  'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'
const REAL_PYTHON = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python314\\python.exe'

function evidence(overrides: Partial<StubEvidence> = {}): StubEvidence {
  return {
    resolvedPath: REAL_PYTHON,
    sizeOnDisk: 106_328,
    stdout: 'Python 3.14.0\n',
    exitCode: 0,
    spawnError: null,
    timedOut: false,
    ...overrides
  }
}

describe('WindowsApps path detection', () => {
  it('matches the alias directory regardless of case or separator', () => {
    expect(isWindowsAppsPath(WINDOWS_APPS_PYTHON)).toBe(true)
    expect(isWindowsAppsPath(WINDOWS_APPS_PYTHON.toLowerCase())).toBe(true)
    expect(isWindowsAppsPath('C:/Users/dev/AppData/Local/Microsoft/WindowsApps/python3.exe')).toBe(
      true
    )
  })

  it('does not match a real installation, or a lookalike directory name', () => {
    expect(isWindowsAppsPath(REAL_PYTHON)).toBe(false)
    expect(isWindowsAppsPath('C:\\tools\\WindowsAppsBackup\\python.exe')).toBe(false)
    expect(isWindowsAppsPath('C:\\Microsoft\\python.exe')).toBe(false)
  })
})

describe('store-stub classification', () => {
  // The disabled alias: zero-content reparse point, no output, non-zero exit.
  it('flags a silent alias that exits non-zero', () => {
    expect(
      classifyToolchain(
        evidence({
          resolvedPath: WINDOWS_APPS_PYTHON,
          sizeOnDisk: null,
          stdout: '',
          exitCode: 9009
        })
      )
    ).toBe('store-stub')
  })

  it('flags an alias that exits cleanly but prints nothing', () => {
    expect(
      classifyToolchain(
        evidence({ resolvedPath: WINDOWS_APPS_PYTHON, sizeOnDisk: 0, stdout: '', exitCode: 0 })
      )
    ).toBe('store-stub')
  })

  it('flags an alias that prints a version but exits non-zero', () => {
    expect(
      classifyToolchain(
        evidence({ resolvedPath: WINDOWS_APPS_PYTHON, sizeOnDisk: 0, exitCode: 1 })
      )
    ).toBe('store-stub')
  })

  /**
   * The correction documented on `classifyToolchain`. Every App Execution Alias
   * is a zero-content reparse point, working or not — measured on the dev
   * machine, `…\WindowsApps\python.exe` cannot be stat'd yet prints
   * `Python 3.14.3` and exits 0. Calling that a stub sends a user with a working
   * interpreter off to reinstall it.
   */
  it('does not flag a Store-installed interpreter that actually works', () => {
    expect(
      classifyToolchain(
        evidence({
          resolvedPath: WINDOWS_APPS_PYTHON,
          sizeOnDisk: null,
          stdout: 'Python 3.14.3\n',
          exitCode: 0
        })
      )
    ).toBe('real')
  })

  it('never calls anything outside WindowsApps a stub', () => {
    expect(classifyToolchain(evidence({ stdout: '', exitCode: 9009 }))).toBe('unusable')
    expect(classifyToolchain(evidence({ sizeOnDisk: 0, stdout: '', exitCode: 0 }))).toBe('unusable')
  })
})

describe('general classification', () => {
  it('accepts a tool that exits cleanly with output', () => {
    expect(classifyToolchain(evidence())).toBe('real')
  })

  it('rejects a tool that could not be started', () => {
    expect(classifyToolchain(evidence({ spawnError: 'spawn EINVAL', exitCode: null }))).toBe(
      'unusable'
    )
  })

  it('rejects a tool that timed out', () => {
    expect(classifyToolchain(evidence({ timedOut: true, stdout: '', exitCode: null }))).toBe(
      'unusable'
    )
  })

  it('rejects a tool whose --version failed', () => {
    expect(classifyToolchain(evidence({ stdout: '', exitCode: 127 }))).toBe('unusable')
  })
})

describe('batch shim detection', () => {
  const windows = process.platform === 'win32'

  it('recognises .cmd and .bat only on Windows', () => {
    expect(isBatchShim('C:\\npm\\tsc.cmd')).toBe(windows)
    expect(isBatchShim('C:\\npm\\tsc.BAT')).toBe(windows)
  })

  it('leaves real executables alone', () => {
    expect(isBatchShim('C:\\Program Files\\nodejs\\node.exe')).toBe(false)
    expect(isBatchShim('/usr/bin/python3')).toBe(false)
  })
})

/**
 * These cases are the reason the batch path is allowed to build a command line
 * at all. Each was run against a real `cmd.exe` before being written down.
 */
describe('cmd.exe command line construction', () => {
  it('wraps the whole line so a spaced path survives cmd /s', () => {
    // cmd /s strips the outermost quote pair and runs the rest verbatim, so the
    // inner quotes are what keep `ap probe dir` in one piece.
    expect(buildBatchCommandLine('C:\\ap probe dir\\tsc.cmd', ['--version'])).toBe(
      '""C:\\ap probe dir\\tsc.cmd" "--version""'
    )
  })

  it('quotes every argument independently', () => {
    expect(buildBatchCommandLine('C:\\x\\t.cmd', ['a b', 'c'])).toBe('""C:\\x\\t.cmd" "a b" "c""')
  })

  // Verified inert against a live cmd.exe: a quoted region is literal.
  it('permits shell metacharacters, which cmd treats as literal inside quotes', () => {
    expect(() => buildBatchCommandLine('C:\\x\\t.cmd', ['x & echo INJECTED'])).not.toThrow()
    expect(() => buildBatchCommandLine('C:\\x\\t.cmd', ['x | echo INJECTED'])).not.toThrow()
    expect(() => buildBatchCommandLine('C:\\x\\t.cmd', ['x > pwned.txt'])).not.toThrow()
  })

  // Verified to ESCAPE against a live cmd.exe: the run printed "INJECTED".
  it('rejects a quote, which closes the quoted region and executes what follows', () => {
    expect(() => buildBatchCommandLine('C:\\x\\t.cmd', ['x" & echo INJECTED & "y'])).toThrow(
      UnsafeArgumentError
    )
  })

  // Verified to expand against a live cmd.exe: %PATH% arrived as the real PATH.
  it('rejects a percent sign, which expands environment variables into argv', () => {
    expect(() => buildBatchCommandLine('C:\\x\\t.cmd', ['%PATH%'])).toThrow(UnsafeArgumentError)
  })

  it('rejects control characters, which end the command line', () => {
    expect(() => buildBatchCommandLine('C:\\x\\t.cmd', ['a\r\necho INJECTED'])).toThrow(
      UnsafeArgumentError
    )
    expect(() => buildBatchCommandLine('C:\\x\\t.cmd', ['a\u0000b'])).toThrow(UnsafeArgumentError)
  })

  it('applies the same rules to the executable path itself', () => {
    expect(() => buildBatchCommandLine('C:\\x\\t".cmd', ['--version'])).toThrow(UnsafeArgumentError)
  })
})

describe('the Toolchain record', () => {
  it('round-trips through its schema', () => {
    const record = {
      id: 'python',
      label: 'Python',
      found: true,
      path: REAL_PYTHON,
      version: 'Python 3.14.0',
      kind: 'real' as const,
      guidance: null
    }
    expect(toolchainSchema.parse(record)).toEqual(record)
  })

  it('rejects an unknown kind rather than letting it reach the renderer', () => {
    expect(
      toolchainSchema.safeParse({
        id: 'python',
        label: 'Python',
        found: true,
        path: REAL_PYTHON,
        version: null,
        kind: 'probably-fine',
        guidance: null
      }).success
    ).toBe(false)
  })

  it('treats only a real toolchain with a path as runnable', () => {
    const base = { id: 'node', label: 'Node.js', found: true, version: null, guidance: null }
    expect(isRunnable({ ...base, path: '/usr/bin/node', kind: 'real' })).toBe(true)
    expect(isRunnable({ ...base, path: '/usr/bin/node', kind: 'unusable' })).toBe(false)
    expect(isRunnable({ ...base, path: null, kind: 'missing' })).toBe(false)
    expect(isRunnable({ ...base, path: '/x/python.exe', kind: 'store-stub' })).toBe(false)
  })
})
