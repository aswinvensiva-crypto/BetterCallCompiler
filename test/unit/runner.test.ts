import { describe, expect, it } from 'vitest'
import { buildDirectoryFor, planRun } from '../../src/main/runner'
import type { Toolchain } from '../../src/shared/types'

/**
 * `planRun` is the whole hybrid decision, and it is pure — it takes the probe
 * result rather than reaching for it. That is what lets every branch be driven
 * here without installing a compiler.
 */

const ROOT = 'C:\\work\\app'

function toolchain(overrides: Partial<Toolchain> & Pick<Toolchain, 'id'>): Toolchain {
  return {
    label: overrides.id,
    found: true,
    path: `C:\\tools\\${overrides.id}.exe`,
    version: '1.0.0',
    kind: 'real',
    guidance: null,
    ...overrides
  }
}

const missing = (id: string): Toolchain => ({
  id,
  label: id,
  found: false,
  path: null,
  version: null,
  kind: 'missing',
  guidance: null
})

const STUB_GUIDANCE =
  'Python on your PATH is the Microsoft Store alias stub, not a real interpreter. ' +
  'Install Python from python.org, or turn the alias off in ' +
  'Settings → Apps → App execution aliases.'

describe('interpreted languages', () => {
  it('runs JavaScript on a real Node with the file as the only argument', () => {
    const plan = planRun('javascript', `${ROOT}\\index.js`, ROOT, [
      toolchain({ id: 'node', path: 'C:\\Program Files\\nodejs\\node.exe' })
    ])

    expect(plan.mode).toBe('real')
    expect(plan.toolchainId).toBe('node')
    expect(plan.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(plan.args).toEqual([`${ROOT}\\index.js`])
    expect(plan.compile).toBeNull()
    expect(plan.reason).toBeNull()
  })

  it('runs Python on a real interpreter', () => {
    const plan = planRun('python', `${ROOT}\\main.py`, ROOT, [toolchain({ id: 'python' })])
    expect(plan.mode).toBe('real')
    expect(plan.args).toEqual([`${ROOT}\\main.py`])
  })

  it('reports unsupported with an install hint when Node is absent', () => {
    const plan = planRun('javascript', `${ROOT}\\index.js`, ROOT, [missing('node')])

    expect(plan.mode).toBe('unsupported')
    expect(plan.command).toBeNull()
    expect(plan.reason).toContain('not on your PATH')
    expect(plan.reason).toContain('nodejs.org')
  })

  it('treats a toolchain missing from the list the same as one reported missing', () => {
    expect(planRun('javascript', `${ROOT}\\a.js`, ROOT, []).mode).toBe('unsupported')
  })

  /**
   * The point of step 6 landing before step 7: the run banner repeats the
   * probe's exact guidance instead of saying "python not found", which would be
   * false — it *is* found, it just is not an interpreter.
   */
  it('surfaces the Store-stub guidance verbatim rather than a generic failure', () => {
    const plan = planRun('python', `${ROOT}\\main.py`, ROOT, [
      toolchain({
        id: 'python',
        kind: 'store-stub',
        version: null,
        path: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
        guidance: STUB_GUIDANCE
      })
    ])

    expect(plan.mode).toBe('unsupported')
    expect(plan.reason).toContain(STUB_GUIDANCE)
    expect(plan.reason).not.toContain('not on your PATH')
  })

  it('refuses to run on a toolchain that is present but unusable', () => {
    const plan = planRun('python', `${ROOT}\\main.py`, ROOT, [
      toolchain({ id: 'python', kind: 'unusable', guidance: 'Python exited with 127' })
    ])
    expect(plan.mode).toBe('unsupported')
    expect(plan.reason).toContain('Python exited with 127')
  })
})

describe('compiled languages', () => {
  it('compiles C to the build directory, then runs the artefact', () => {
    const plan = planRun('c', `${ROOT}\\main.c`, ROOT, [
      toolchain({ id: 'gcc', path: 'C:\\msys64\\ucrt64\\bin\\gcc.exe' })
    ])

    expect(plan.mode).toBe('real')
    expect(plan.compile).not.toBeNull()
    expect(plan.compile?.command).toBe('C:\\msys64\\ucrt64\\bin\\gcc.exe')
    expect(plan.compile?.args).toEqual([
      '-g',
      `${ROOT}\\main.c`,
      '-o',
      plan.compile?.outputPath ?? ''
    ])

    // The artefact lands under .aperture/, which is git-ignored and unwatched.
    expect(plan.compile?.outputPath.startsWith(buildDirectoryFor(ROOT))).toBe(true)

    // The run step executes the artefact, not the compiler.
    expect(plan.command).toBe(plan.compile?.outputPath)
    expect(plan.args).toEqual([])
  })

  it('uses g++ for C++', () => {
    const plan = planRun('cpp', `${ROOT}\\main.cpp`, ROOT, [toolchain({ id: 'g++' })])
    expect(plan.compile?.command).toContain('g++')
  })

  it('does not offer to compile when the compiler is missing', () => {
    const plan = planRun('cpp', `${ROOT}\\main.cpp`, ROOT, [missing('g++')])
    expect(plan.mode).toBe('unsupported')
    expect(plan.compile).toBeNull()
    expect(plan.reason).toContain('C++')
  })
})

describe('bundled packs', () => {
  it('routes HTML to the bundled web runtime with no toolchain involved', () => {
    const plan = planRun('html', `${ROOT}\\page.html`, ROOT, [])

    expect(plan.mode).toBe('bundled')
    expect(plan.pack).toBe('web')
    expect(plan.command).toBeNull()
    expect(plan.reason).toContain('bundled web runtime')
  })

  it('stays bundled even when toolchains are present', () => {
    const plan = planRun('html', `${ROOT}\\page.html`, ROOT, [toolchain({ id: 'node' })])
    expect(plan.mode).toBe('bundled')
  })
})

describe('languages with no runtime at all', () => {
  // The spec is explicit: "If no bundled pack exists for that language, say so
  // explicitly." An empty console is the failure mode being avoided.
  it('names the file type it cannot run', () => {
    const plan = planRun('rust', `${ROOT}\\main.rs`, ROOT, [])
    expect(plan.mode).toBe('unsupported')
    expect(plan.reason).toContain('.rs')
    expect(plan.pack).toBeNull()
  })

  it('falls back gracefully for a file with no extension', () => {
    const plan = planRun('plaintext', `${ROOT}\\LICENSE`, ROOT, [])
    expect(plan.mode).toBe('unsupported')
    expect(plan.reason).not.toBe('')
  })
})
