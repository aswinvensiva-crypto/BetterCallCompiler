import type { ChildProcess } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import { isRunnable, type RunExit, type RunOutput, type RunStarted, type Toolchain } from '../shared/types'
import { confinePath, getWorkspace } from './fs-service'
import { killProcessTree, listToolchains, spawnExecutable } from './toolchains'

/**
 * The hybrid runner.
 *
 * One interface covers both halves of the zero-install bet: a file either runs
 * on a real toolchain found on PATH, or on a pack that ships inside the app.
 * The decision is made by `planRun`, which is pure and therefore testable
 * without spawning anything — the execution below only carries it out.
 *
 * Keeping the *plan* separate from the *run* is what lets the two backends stay
 * interchangeable as bundled coverage grows in later milestones.
 */

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

export interface CompileStep {
  readonly command: string
  readonly args: readonly string[]
  /** Absolute path of the artefact the run step then executes. */
  readonly outputPath: string
}

export interface RunPlan {
  readonly mode: RunStarted['mode']
  readonly toolchainId: string | null
  readonly command: string | null
  readonly args: readonly string[]
  readonly pack: string | null
  readonly reason: string | null
  /** Present for compiled languages; must succeed before `command` runs. */
  readonly compile: CompileStep | null
  /**
   * Extra environment for the spawn, or null for the inherited one.
   *
   * Exists for the bundled runtime below, which needs `ELECTRON_RUN_AS_NODE`
   * to turn the app's own binary into a plain Node process.
   */
  readonly env: Readonly<Record<string, string>> | null
}

interface LanguageRecipe {
  /** Toolchain id this language wants, when it wants one. */
  readonly toolchainId: string
  /**
   * Bundled pack to fall back to, or null when none exists yet.
   *
   * Two kinds share this field, told apart by whether the resulting plan has a
   * `command`. A RENDERER pack (`web`) draws into the run panel and has none. A
   * PROCESS pack (`node`) is spawned by main like any other run and has one.
   * The distinction is what lets the renderer keep one branch: a plan with a
   * command is something main is already streaming.
   */
  readonly pack: string | null
  /**
   * Whether the bundled fallback runs out of process on the app's own Node.
   *
   * The renderer cannot execute workspace code — `script-src 'self'` forbids
   * `eval` and `new Function`, and that invariant is what makes the preload
   * boundary worth anything, so it is not negotiable. `web.ts` says as much and
   * names an out-of-process runtime as the answer. This is it: Electron already
   * bundles Node, so `ELECTRON_RUN_AS_NODE=1` on `process.execPath` is a real
   * JavaScript runtime that ships with the app and needs nothing installed.
   */
  readonly bundledProcess: boolean
  /** Compiled languages produce an artefact first. */
  readonly compiled: boolean
  readonly humanName: string
  /** What to tell the user when the toolchain is absent and there is no pack. */
  readonly installHint: string
}

const RECIPES: Readonly<Record<string, LanguageRecipe>> = {
  javascript: {
    toolchainId: 'node',
    pack: 'node',
    bundledProcess: true,
    compiled: false,
    humanName: 'JavaScript',
    installHint: 'Install Node.js from nodejs.org to run JavaScript files.'
  },
  typescript: {
    toolchainId: 'node',
    pack: 'node',
    bundledProcess: true,
    compiled: false,
    humanName: 'TypeScript',
    installHint: 'Install Node.js 22.6 or newer from nodejs.org to run TypeScript files directly.'
  },
  python: {
    toolchainId: 'python',
    pack: null,
    bundledProcess: false,
    compiled: false,
    humanName: 'Python',
    installHint: 'Install Python from python.org to run Python files.'
  },
  c: {
    toolchainId: 'gcc',
    pack: null,
    bundledProcess: false,
    compiled: true,
    humanName: 'C',
    installHint: 'Install GCC (MSYS2, MinGW-w64 or Build Tools) to compile and run C files.'
  },
  cpp: {
    toolchainId: 'g++',
    pack: null,
    bundledProcess: false,
    compiled: true,
    humanName: 'C++',
    installHint: 'Install G++ (MSYS2, MinGW-w64 or Build Tools) to compile and run C++ files.'
  },
  html: {
    toolchainId: 'html',
    pack: 'web',
    bundledProcess: false,
    compiled: false,
    humanName: 'HTML',
    installHint: ''
  }
}

/** Where compiled artefacts go. Already git-ignored and never watched. */
export function buildDirectoryFor(workspaceRoot: string): string {
  return join(workspaceRoot, '.bettercallcompiler', 'build')
}

function artefactName(filePath: string): string {
  const stem = basename(filePath, extname(filePath))
  return process.platform === 'win32' ? `${stem}.exe` : stem
}

/**
 * Chooses how to run `filePath`, given what the probe found.
 *
 * Pure by construction: it takes the toolchain list rather than reaching for
 * it, so the tests can drive every branch — real, bundled, stubbed, missing —
 * without installing anything.
 */
export function planRun(
  languageId: string,
  filePath: string,
  workspaceRoot: string,
  toolchains: readonly Toolchain[],
  /**
   * The app's own executable, which doubles as a Node runtime.
   *
   * Passed in rather than read from `process`, for the same reason the
   * toolchain list is: this function stays pure and every branch — bundled
   * available, bundled absent — is reachable from a test without touching the
   * environment it happens to run in.
   */
  bundledNodePath: string | null = null
): RunPlan {
  const recipe = RECIPES[languageId]

  if (recipe === undefined) {
    return {
      mode: 'unsupported',
      toolchainId: null,
      command: null,
      args: [],
      pack: null,
      reason: `BetterCallCompiler cannot run .${extname(filePath).replace(/^\./, '') || 'this'} files yet.`,
      compile: null,
      env: null
    }
  }

  // HTML never had a toolchain to look for; it is bundled by definition.
  if (recipe.pack !== null && recipe.toolchainId === 'html') {
    return {
      mode: 'bundled',
      toolchainId: null,
      command: null,
      args: [],
      pack: recipe.pack,
      reason: 'Rendered by the bundled web runtime — no toolchain required.',
      compile: null,
      env: null
    }
  }

  const toolchain = toolchains.find((candidate) => candidate.id === recipe.toolchainId) ?? null

  if (toolchain !== null && isRunnable(toolchain) && toolchain.path !== null) {
    if (!recipe.compiled) {
      return {
        mode: 'real',
        toolchainId: toolchain.id,
        command: toolchain.path,
        args: [filePath],
        pack: null,
        reason: null,
        compile: null,
        env: null
      }
    }

    const outputPath = join(buildDirectoryFor(workspaceRoot), artefactName(filePath))
    return {
      mode: 'real',
      toolchainId: toolchain.id,
      command: outputPath,
      args: [],
      pack: null,
      reason: null,
      // -g keeps the diagnostics and any crash addresses meaningful.
      compile: { command: toolchain.path, args: ['-g', filePath, '-o', outputPath], outputPath },
      env: null
    }
  }

  // The toolchain is unusable or absent. Say *which*, because "not found" and
  // "found but it is a Store stub" call for completely different fixes.
  const why =
    toolchain === null || toolchain.kind === 'missing'
      ? `${recipe.humanName} is not on your PATH.`
      : (toolchain.guidance ?? `${recipe.humanName} is installed but not usable.`)

  /*
   * The bundled runtime that is a real process.
   *
   * Electron ships a Node, and `ELECTRON_RUN_AS_NODE` turns the app's own
   * binary into it — so this is genuinely zero-install rather than a second
   * name for "find Node on PATH". It is preferred over a renderer pack because
   * it actually EXECUTES the file, which is what the user asked for.
   */
  if (recipe.bundledProcess && bundledNodePath !== null) {
    return {
      mode: 'bundled',
      toolchainId: null,
      command: bundledNodePath,
      args: [filePath],
      pack: recipe.pack,
      reason: `${why} Running on the ${recipe.humanName} runtime bundled with BetterCallCompiler.`,
      compile: null,
      // Without this the app re-launches itself as an editor instead of
      // running the file — a spectacular failure that is obvious the first
      // time and impossible to guess from the symptom.
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }

  if (recipe.pack !== null && !recipe.bundledProcess) {
    return {
      mode: 'bundled',
      toolchainId: null,
      command: null,
      args: [],
      pack: recipe.pack,
      reason: `${why} Falling back to the bundled ${recipe.humanName} runtime.`,
      compile: null,
      env: null
    }
  }

  return {
    mode: 'unsupported',
    toolchainId: null,
    command: null,
    args: [],
    pack: null,
    reason: `${why} BetterCallCompiler has no bundled ${recipe.humanName} runtime yet — ${recipe.installHint}`,
    compile: null,
    env: null
  }
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

interface ActiveRun {
  readonly runId: string
  readonly startedAt: number
  child: ChildProcess | null
  cancelled: boolean
  finished: boolean
}

const active = new Map<string, ActiveRun>()
let sequence = 0

let emitOutput: ((payload: RunOutput) => void) | null = null
let emitExit: ((payload: RunExit) => void) | null = null

export function setRunEmitters(
  onOutput: (payload: RunOutput) => void,
  onExit: (payload: RunExit) => void
): void {
  emitOutput = onOutput
  emitExit = onExit
}

function finish(run: ActiveRun, code: number | null): void {
  if (run.finished) return
  run.finished = true
  active.delete(run.runId)
  emitExit?.({
    runId: run.runId,
    code,
    durationMs: Date.now() - run.startedAt,
    cancelled: run.cancelled
  })
}

function write(run: ActiveRun, stream: RunOutput['stream'], data: string): void {
  if (run.finished || data === '') return
  emitOutput?.({ runId: run.runId, stream, data })
}

/**
 * Runs one process to completion, streaming both pipes.
 *
 * Resolves with the exit code rather than rejecting, because a non-zero exit is
 * a normal outcome the console has to render, not an exception.
 */
function runProcess(
  run: ActiveRun,
  command: string,
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>> | null = null
): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnExecutable(command, args, {
        cwd,
        // Merged onto the inherited environment rather than replacing it: the
        // debuggee still needs PATH, HOME and the rest to behave normally.
        env: extraEnv === null ? undefined : { ...process.env, ...extraEnv }
      })
    } catch (error) {
      write(run, 'stderr', `${error instanceof Error ? error.message : 'could not start'}\r\n`)
      resolve(null)
      return
    }

    run.child = child

    // xterm needs CRLF; a bare LF leaves the cursor in the same column and the
    // output renders as a staircase.
    const forward = (stream: RunOutput['stream']) => (chunk: Buffer) => {
      write(run, stream, chunk.toString('utf8').replace(/\r?\n/g, '\r\n'))
    }

    child.stdout?.on('data', forward('stdout'))
    child.stderr?.on('data', forward('stderr'))

    child.on('error', (error) => {
      write(run, 'stderr', `${error.message}\r\n`)
      resolve(null)
    })

    child.on('close', (code) => {
      run.child = null
      resolve(code)
    })
  })
}

/**
 * Starts a run and returns the decision immediately; output follows as events.
 *
 * The process is deliberately *not* awaited here — the renderer needs the mode
 * and the command to draw its banner before the first byte arrives, and a long
 * build must not hold the IPC handler open.
 */
export async function startRun(requestedPath: string, languageId: string): Promise<RunStarted> {
  const workspace = getWorkspace()
  if (workspace.root === null) {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'open a folder before running a file')
  }
  // Captured so the async body below keeps the narrowing.
  const workspaceRoot = workspace.root

  const filePath = await confinePath(workspaceRoot, requestedPath)
  const toolchains = await listToolchains()
  const plan = planRun(languageId, filePath, workspaceRoot, toolchains, process.execPath)

  const runId = `run-${++sequence}`
  const relativePath = relative(workspaceRoot, filePath).split(sep).join('/')

  const started: RunStarted = {
    runId,
    mode: plan.mode,
    filePath,
    relativePath,
    languageId,
    command: plan.command,
    args: [...plan.args],
    toolchainId: plan.toolchainId,
    pack: plan.pack,
    reason: plan.reason
  }

  /*
   * Whether there is a COMMAND decides who carries the plan out, not the mode.
   *
   * A bundled runtime that is a real process — JavaScript on the Node inside
   * this app — is spawned and streamed here exactly like a toolchain run. Only
   * a plan with nothing to spawn goes to the renderer, which is the renderer
   * packs and the unsupported case. Keying on the mode instead would send the
   * bundled Node run to a renderer pack that does not exist.
   */
  if (plan.command === null) return started

  // Pulled out of `plan` before the closure: TypeScript discards narrowing on a
  // property access once it is read inside a nested function.
  const command = plan.command
  const compile = plan.compile
  const env = plan.env

  const run: ActiveRun = { runId, startedAt: Date.now(), child: null, cancelled: false, finished: false }
  active.set(runId, run)

  void (async () => {
    try {
      if (compile !== null) {
        await fsp.mkdir(dirname(compile.outputPath), { recursive: true })
        write(
          run,
          'stdout',
          `\x1b[2m> ${basename(compile.command)} ${compile.args.join(' ')}\x1b[0m\r\n`
        )

        const compileCode = await runProcess(run, compile.command, compile.args, workspaceRoot)

        // A failed compile is the end of the run: there is no artefact to run,
        // and reporting the compiler's exit code is more useful than inventing
        // one from a missing binary.
        if (run.cancelled || compileCode !== 0) {
          finish(run, compileCode)
          return
        }
      }

      const code = await runProcess(run, command, plan.args, workspaceRoot, env)
      finish(run, code)
    } catch (error) {
      write(run, 'stderr', `${error instanceof Error ? error.message : 'run failed'}\r\n`)
      finish(run, null)
    }
  })()

  return started
}

/** Cancels a run and everything it spawned. Idempotent. */
export function cancelRun(runId: string): boolean {
  const run = active.get(runId)
  if (run === undefined) return false

  run.cancelled = true
  const child = run.child
  if (child !== null && typeof child.pid === 'number') {
    killProcessTree(child.pid)
  }
  return true
}

/** Every run must die with the window, exactly like the PTY pool. */
export function cancelAllRuns(): void {
  for (const runId of [...active.keys()]) cancelRun(runId)
}

