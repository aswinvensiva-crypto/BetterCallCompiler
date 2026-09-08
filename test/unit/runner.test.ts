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

    // The artefact lands under .bettercallcompiler/, which is git-ignored and unwatched.
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

describe('the runtime bundled with the app', () => {
  /*
   * Strategic bet #1 is zero-install, and until now it shipped as the mechanism
   * only: one pack existed (`web`) and it cannot execute anything, because the
   * renderer's `script-src 'self'` forbids `eval` and `new Function` and that
   * invariant is what makes the preload boundary worth anything.
   *
   * `web.ts` names the answer in its own comment — an out-of-process runtime.
   * Electron already bundles a Node, so the app's own binary with
   * `ELECTRON_RUN_AS_NODE=1` is one, with nothing to install.
   */

  const ELECTRON = 'C:\\app\\BetterCallCompiler.exe'

  it('runs JavaScript with no Node installed at all', () => {
    const plan = planRun('javascript', `${ROOT}\\index.js`, ROOT, [missing('node')], ELECTRON)

    expect(plan.mode).toBe('bundled')
    expect(plan.pack).toBe('node')
    expect(plan.command).toBe(ELECTRON)
    expect(plan.args).toEqual([`${ROOT}\\index.js`])
    expect(plan.reason).toContain('bundled with BetterCallCompiler')
  })

  it('sets ELECTRON_RUN_AS_NODE, without which the app relaunches itself', () => {
    // A spectacular failure: the editor opens a second window instead of
    // running the file. Obvious the first time and impossible to guess from
    // the symptom afterwards.
    const plan = planRun('javascript', `${ROOT}\\index.js`, ROOT, [missing('node')], ELECTRON)
    expect(plan.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('runs TypeScript on it too', () => {
    // Node 22 strips types natively, and the Node inside Electron is new
    // enough — so this is not a second implementation, just a second recipe.
    const plan = planRun('typescript', `${ROOT}\\index.ts`, ROOT, [missing('node')], ELECTRON)
    expect(plan.mode).toBe('bundled')
    expect(plan.command).toBe(ELECTRON)
  })

  it('still prefers a real Node when there is one', () => {
    /*
     * The user's Node is the one their project is built against — its version,
     * its global modules, its `node_modules` resolution. Preferring ours would
     * silently change what their code runs on.
     */
    const plan = planRun('javascript', `${ROOT}\\index.js`, ROOT, [
      toolchain({ id: 'node', path: 'C:\\Program Files\\nodejs\\node.exe' })
    ], ELECTRON)

    expect(plan.mode).toBe('real')
    expect(plan.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(plan.env).toBeNull()
  })

  it('falls back to unsupported when there is no bundled runtime to use', () => {
    // Proves the branch depends on the path actually being supplied rather
    // than on the recipe alone.
    const plan = planRun('javascript', `${ROOT}\\index.js`, ROOT, [missing('node')], null)
    expect(plan.mode).toBe('unsupported')
    expect(plan.command).toBeNull()
  })

  it('leaves HTML to the renderer pack, which has no command', () => {
    /*
     * The discriminator the execution side keys on: a plan with a command is
     * spawned by main, a plan without one goes to a renderer pack. Keying on
     * the mode instead would send the bundled Node run looking for a renderer
     * pack that does not exist.
     */
    const plan = planRun('html', `${ROOT}\\index.html`, ROOT, [], ELECTRON)

    expect(plan.mode).toBe('bundled')
    expect(plan.pack).toBe('web')
    expect(plan.command).toBeNull()
  })

  it('does not pretend to bundle Python or C++', () => {
    // Honest coverage. A real Python here means vendoring Pyodide and a real
    // C++ means a WASM toolchain; both are large assets rather than logic, and
    // claiming them would make the run panel lie.
    for (const [language, file] of [['python', 'a.py'], ['cpp', 'a.cpp']] as const) {
      const plan = planRun(language, `${ROOT}\\${file}`, ROOT, [missing(language === 'python' ? 'python' : 'g++')], ELECTRON)
      expect(plan.mode, language).toBe('unsupported')
      expect(plan.reason, language).toContain('no bundled')
    }
  })
})

describe('BCC, which needs nothing installed', () => {
  /*
   * The first language here that is neither spawned nor rendered: the compiler
   * and the VM are this repository, and `startRun` drives them on a worker.
   */

  it('plans a bundled run with no toolchain and no command', () => {
    const plan = planRun('bcc', `${ROOT}\\fib.bcc`, ROOT, [])

    expect(plan.mode).toBe('bundled')
    expect(plan.pack).toBe('bcc')
    expect(plan.command).toBeNull()
    expect(plan.toolchainId).toBeNull()
    expect(plan.reason).toContain('no toolchain required')
  })

  it('does not go looking for a toolchain it could never find', () => {
    // Passing a broken `bcc` toolchain must change nothing: there is no such
    // thing to install, so a probe result has no bearing on the answer.
    const withStub = planRun('bcc', `${ROOT}\\fib.bcc`, ROOT, [
      toolchain({ id: 'bcc', kind: 'unusable', guidance: 'nonsense' })
    ])
    expect(withStub.mode).toBe('bundled')
    expect(withStub.reason).toContain('no toolchain required')
  })

  it('needs no compile step, because the pipeline runs in the worker', () => {
    expect(planRun('bcc', `${ROOT}\\fib.bcc`, ROOT, []).compile).toBeNull()
  })
})
