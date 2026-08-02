import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'
import type { Toolchain, ToolchainKind } from '../shared/types'

/**
 * PATH resolution, executable invocation, and the Windows Store stub probe.
 *
 * Three concerns live together here because they are one concern in practice:
 * you cannot decide whether a toolchain is usable without resolving it, and you
 * cannot resolve it on Windows without knowing how it will have to be invoked.
 * The terminal (step 5) and the runner (step 7) both build on the primitives at
 * the top of this file.
 */

/* ------------------------------------------------------------------ *
 * PATH resolution
 * ------------------------------------------------------------------ */

/**
 * Deliberately not `where`/`which`: shelling out to resolve a program costs a
 * process spawn per lookup, and on Windows `where` returns *every* match
 * including non-executable ones. Walking PATH with PATHEXT is both faster and
 * gives us the resolved path we need for Store-stub detection.
 *
 * `lstat`, not `stat`. A Windows App Execution Alias — everything under
 * `…\Microsoft\WindowsApps\` — is an `IO_REPARSE_TAG_APPEXECLINK` reparse point
 * that `stat` cannot traverse: it fails with EACCES. An earlier version of this
 * function called `statSync().isFile()` inside a try/catch, so every alias was
 * silently treated as "not on PATH" and the Store-stub guidance below could
 * never fire. `lstat` describes the entry itself and succeeds on both.
 */
export function findOnPath(command: string): string | null {
  const pathVar = process.env['PATH'] ?? process.env['Path'] ?? ''
  if (pathVar === '') return null

  // PATHEXT is conventionally uppercase, and the resolved path is shown to the
  // user in the toolchain popover — `python.EXE` reads like a typo. The
  // filesystem is case-insensitive here, so lowercasing costs nothing.
  const extensions =
    process.platform === 'win32'
      ? [
          '',
          ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter((ext) => ext !== '')
            .map((ext) => ext.toLowerCase())
        ]
      : ['']

  for (const directory of pathVar.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      try {
        const stats = lstatSync(candidate)
        if (stats.isFile() || stats.isSymbolicLink()) return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }

  return null
}

/**
 * Bytes the entry occupies, or `null` when it cannot be measured.
 *
 * `null` is the interesting case: it is what an App Execution Alias produces,
 * because `stat` refuses to follow an appexeclink. Callers must not read `null`
 * as "empty" — see `classifyToolchain`.
 */
export function sizeOnDisk(target: string): number | null {
  try {
    return statSync(target).size
  } catch {
    return null
  }
}

/**
 * Resolves the shell to run in a terminal, preferring PowerShell 7 over Windows
 * PowerShell over anything else. `$SHELL` is respected on POSIX.
 */
export function resolveShell(): { file: string; name: string } {
  if (process.platform === 'win32') {
    for (const candidate of ['pwsh.exe', 'powershell.exe']) {
      const found = findOnPath(candidate)
      if (found !== null) return { file: found, name: candidate.replace(/\.exe$/i, '') }
    }
    const comspec = process.env['ComSpec']
    if (comspec !== undefined && comspec !== '') return { file: comspec, name: 'cmd' }
    return { file: 'cmd.exe', name: 'cmd' }
  }

  const shell = process.env['SHELL']
  if (shell !== undefined && shell !== '') {
    const name = shell.slice(shell.lastIndexOf('/') + 1)
    return { file: shell, name }
  }
  return { file: '/bin/bash', name: 'bash' }
}

/* ------------------------------------------------------------------ *
 * Invocation
 * ------------------------------------------------------------------ */

/** Batch shims cannot be executed directly; see `spawnExecutable`. */
const BATCH_EXTENSIONS = new Set(['.cmd', '.bat'])

export function isBatchShim(file: string): boolean {
  return process.platform === 'win32' && BATCH_EXTENSIONS.has(extname(file).toLowerCase())
}

/**
 * Characters that must never reach a `cmd.exe` command line.
 *
 * Measured, not assumed. Against `cmd /d /s /c "…"` with quoted arguments,
 * `&`, `|` and `>` are inert — cmd treats a quoted region as literal. Two things
 * are not:
 *
 *   - `"` terminates the quoted region and everything after it is parsed as
 *     command syntax. `x" & echo INJECTED & "y` demonstrably executes.
 *   - `%` triggers environment expansion, so `%PATH%` leaks the environment into
 *     the child's argv.
 *
 * Rejecting both is what makes the batch path below safe. Control characters go
 * too, since a newline ends the command and starts another.
 */
const UNSAFE_IN_COMMAND_LINE = /["%\u0000-\u001f]/

export class UnsafeArgumentError extends Error {
  constructor(argument: string) {
    super(`refusing to pass an argument containing a quote, percent or control character: ${argument}`)
    this.name = 'UnsafeArgumentError'
  }
}

/**
 * Builds the one command line this module is allowed to construct.
 *
 * The doubled outer quotes are load-bearing. `cmd /s /c` strips the first and
 * last quote of its argument and runs the remainder verbatim, so wrapping the
 * whole `"file" "arg" "arg"` sequence in another pair is what lets a path with
 * a space survive. Passing the same pieces as separate argv entries does not
 * work — cmd re-splits `C:\ap probe dir\tsc.cmd` at the space and reports
 * `'C:\ap' is not recognized`.
 *
 * Exported for the unit tests, which assert the injection cases above.
 */
export function buildBatchCommandLine(file: string, args: readonly string[]): string {
  for (const part of [file, ...args]) {
    if (UNSAFE_IN_COMMAND_LINE.test(part)) throw new UnsafeArgumentError(part)
  }
  return `"${[file, ...args].map((part) => `"${part}"`).join(' ')}"`
}

export interface SpawnOptions {
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

/**
 * Spawns a resolved executable with an argv array and `shell: false`.
 *
 * The `.cmd`/`.bat` detour exists because Node refuses to spawn a batch file
 * without a shell — it throws EINVAL, the mitigation for CVE-2024-27980 — and on
 * Windows the npm-installed `tsc` is a `.cmd` shim with no `.exe` beside it.
 * Routing through `cmd.exe` keeps `shell: false` and keeps the arguments out of
 * any string we assemble ourselves for the common case; only the batch case
 * builds a command line, and only after `buildBatchCommandLine` has rejected
 * every character that could escape it.
 */
export function spawnExecutable(
  file: string,
  args: readonly string[],
  options: SpawnOptions = {}
): ChildProcess {
  const base = {
    shell: false as const,
    windowsHide: true,
    cwd: options.cwd,
    env: options.env ?? process.env
  }

  if (!isBatchShim(file)) {
    return spawn(file, [...args], base)
  }

  const comspec = process.env['ComSpec'] ?? 'cmd.exe'
  return spawn(comspec, ['/d', '/s', '/c', buildBatchCommandLine(file, args)], {
    ...base,
    // Node would escape our carefully-built line again and cmd would see the
    // escaping rather than the quotes.
    windowsVerbatimArguments: true
  })
}

/**
 * Kills a process and everything it spawned.
 *
 * `child.kill()` alone is not enough on Windows: a grandchild that detaches —
 * anything with its own console, a hidden window, or a GUI helper — survives its
 * parent's death indefinitely and leaks. A compiler driver is exactly this
 * shape; `gcc` is a front end that forks `cc1` and `as`, so killing the driver
 * leaves the real work running.
 *
 * Spawned with an argv array and `shell: false` — never an interpolated string.
 * Shared by the PTY pool (step 5) and the runner (step 7), which need identical
 * semantics: cancelling must leave nothing behind.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return

  if (process.platform !== 'win32') {
    try {
      // Negative pid targets the process group.
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    return
  }

  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })
    // taskkill exits non-zero when the process is already dead; that is fine.
    killer.on('error', () => undefined)
  } catch {
    // Nothing more we can do.
  }
}

/* ------------------------------------------------------------------ *
 * The probe
 * ------------------------------------------------------------------ */

/** Locked by the spec. A tool that cannot report its version in 1.5s is not one. */
const PROBE_TIMEOUT_MS = 1500

/** A `--version` that prints a manual is a bug; do not buffer it all. */
const MAX_PROBE_OUTPUT = 64 * 1024

interface ToolchainDefinition {
  readonly id: string
  readonly label: string
  /** Candidate executable names, most-preferred first. */
  readonly commands: readonly string[]
  readonly versionArgs: readonly string[]
}

const WINDOWS = process.platform === 'win32'

const DEFINITIONS: readonly ToolchainDefinition[] = [
  { id: 'node', label: 'Node.js', commands: ['node'], versionArgs: ['--version'] },
  {
    id: 'python',
    label: 'Python',
    // On Windows the python.org installer ships `python.exe` and no `python3`;
    // most Linux distributions are the other way round. Probe both, preferring
    // the platform's usual name.
    commands: WINDOWS ? ['python', 'python3'] : ['python3', 'python'],
    versionArgs: ['--version']
  },
  { id: 'gcc', label: 'GCC', commands: ['gcc'], versionArgs: ['--version'] },
  { id: 'g++', label: 'G++', commands: ['g++'], versionArgs: ['--version'] },
  { id: 'tsc', label: 'TypeScript', commands: ['tsc'], versionArgs: ['--version'] },
  { id: 'docker', label: 'Docker', commands: ['docker'], versionArgs: ['--version'] }
]

export interface ProbeOutcome {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /** Set when the process could not be started at all. */
  readonly spawnError: string | null
}

function runVersionProbe(
  file: string,
  args: readonly string[],
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnExecutable(file, args)
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: error instanceof Error ? error.message : 'could not start process'
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_PROBE_OUTPUT) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      finish({ exitCode: null, stdout, stderr, timedOut, spawnError: error.message })
    })

    child.on('close', (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut, spawnError: null })
    })
  })
}

/* ---------------------------- classification ---------------------------- */

/** `C:\Users\x\AppData\Local\Microsoft\WindowsApps\python.exe` and friends. */
export function isWindowsAppsPath(target: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(target)
}

export interface StubEvidence {
  readonly resolvedPath: string
  /** `null` means "could not be measured" — an alias — not "empty". */
  readonly sizeOnDisk: number | null
  readonly stdout: string
  readonly exitCode: number | null
  readonly spawnError: string | null
  readonly timedOut: boolean
}

/**
 * The Store-stub rule, isolated so it can be tested against fixtures.
 *
 * The spec states it as: under `…\Microsoft\WindowsApps\` AND (size is 0 OR
 * empty stdout OR non-zero exit). This implements all three clauses and adds one
 * guard: a tool that exited 0 *and* printed a version is never called a stub.
 *
 * That guard is not a liberty, it is a correction the platform forces. Every App
 * Execution Alias is a zero-content reparse point whether or not it works, so
 * the size clause alone cannot separate the disabled alias that opens the Store
 * from a functioning Store-installed interpreter. Measured on the development
 * machine: `…\WindowsApps\python.exe` has no readable size and prints
 * `Python 3.14.3` with exit 0. Without the guard that user would be told their
 * working Python is a stub and sent to python.org for no reason. The other two
 * clauses — empty stdout, non-zero exit — are exactly the signals a real stub
 * produces, and they are untouched.
 */
export function classifyToolchain(evidence: StubEvidence): ToolchainKind {
  const printedVersion = evidence.stdout.trim() !== ''
  const exitedCleanly = evidence.exitCode === 0
  const works = exitedCleanly && printedVersion && evidence.spawnError === null

  if (isWindowsAppsPath(evidence.resolvedPath)) {
    const noContentOnDisk = evidence.sizeOnDisk === null || evidence.sizeOnDisk === 0
    if ((noContentOnDisk || !printedVersion || !exitedCleanly) && !works) return 'store-stub'
  }

  return works ? 'real' : 'unusable'
}

/* -------------------------------- guidance ------------------------------- */

/**
 * Verbatim from the spec. A generic "python not found" here is the difference
 * between a user fixing their machine in a minute and filing a bug, which is
 * why the wording is fixed and lives in exactly one place.
 */
const PYTHON_STUB_GUIDANCE =
  'Python on your PATH is the Microsoft Store alias stub, not a real interpreter. ' +
  'Install Python from python.org, or turn the alias off in ' +
  'Settings → Apps → App execution aliases.'

function guidanceFor(
  definition: ToolchainDefinition,
  kind: ToolchainKind,
  outcome: ProbeOutcome
): string | null {
  if (kind === 'store-stub') {
    if (definition.id === 'python') return PYTHON_STUB_GUIDANCE
    return (
      `${definition.label} on your PATH is a Microsoft Store alias stub, not a real ` +
      `installation. Install ${definition.label} properly, or turn the alias off in ` +
      'Settings → Apps → App execution aliases.'
    )
  }

  if (kind === 'unusable') {
    if (outcome.timedOut) {
      return `${definition.label} did not respond to --version within ${PROBE_TIMEOUT_MS} ms.`
    }
    if (outcome.spawnError !== null) {
      return `${definition.label} could not be started: ${outcome.spawnError}`
    }
    const detail = (outcome.stderr.trim() || outcome.stdout.trim()).split(/\r?\n/)[0] ?? ''
    const suffix = detail === '' ? '' : ` — ${detail}`
    return `${definition.label} is on PATH but --version exited with ${outcome.exitCode}${suffix}`
  }

  return null
}

/** First non-empty line of whatever the tool printed, capped. */
function extractVersion(outcome: ProbeOutcome): string | null {
  // gcc and docker use stdout; Python 2 and a few others answer on stderr.
  const source = outcome.stdout.trim() !== '' ? outcome.stdout : outcome.stderr
  const line = source
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '')
  if (line === undefined) return null
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/* ------------------------------ the probe run ---------------------------- */

async function probeDefinition(definition: ToolchainDefinition): Promise<Toolchain> {
  const attempts: Toolchain[] = []

  for (const command of definition.commands) {
    const resolved = findOnPath(command)
    if (resolved === null) continue

    const outcome = await runVersionProbe(resolved, definition.versionArgs)
    const kind = classifyToolchain({
      resolvedPath: resolved,
      sizeOnDisk: sizeOnDisk(resolved),
      stdout: outcome.stdout,
      exitCode: outcome.exitCode,
      spawnError: outcome.spawnError,
      timedOut: outcome.timedOut
    })

    const record: Toolchain = {
      id: definition.id,
      label: definition.label,
      found: true,
      path: resolved,
      version: kind === 'store-stub' ? null : extractVersion(outcome),
      kind,
      guidance: guidanceFor(definition, kind, outcome)
    }

    // A real interpreter wins outright. Otherwise keep looking: on Windows
    // `python` can be the Store alias while `python3` is a real install, and
    // reporting the first hit would bury the one that works.
    if (record.kind === 'real') return record
    attempts.push(record)
  }

  const firstAttempt = attempts[0]
  if (firstAttempt !== undefined) return firstAttempt

  return {
    id: definition.id,
    label: definition.label,
    found: false,
    path: null,
    version: null,
    kind: 'missing',
    guidance: null
  }
}

let cache: readonly Toolchain[] | null = null
let inFlight: Promise<readonly Toolchain[]> | null = null

async function probeAll(): Promise<readonly Toolchain[]> {
  // Six probes at 1.5s each is 9s serially and 1.5s in parallel. The probe runs
  // on the main process, so the parallel version is the only one that does not
  // stall the window on a machine where several tools are missing.
  return await Promise.all(DEFINITIONS.map(probeDefinition))
}

/**
 * Cached for the session, per the spec. Concurrent callers share one probe —
 * without `inFlight`, the status bar and an early `run` would each start their
 * own full sweep on a cold cache.
 */
export async function listToolchains(): Promise<readonly Toolchain[]> {
  if (cache !== null) return cache

  if (inFlight === null) {
    inFlight = probeAll().then(
      (result) => {
        cache = result
        inFlight = null
        return result
      },
      (error: unknown) => {
        inFlight = null
        throw error
      }
    )
  }

  return await inFlight
}

/** Backs the "Rescan toolchains" command. */
export async function rescanToolchains(): Promise<readonly Toolchain[]> {
  cache = null
  inFlight = null
  return await listToolchains()
}


/** Test hook: drop the session cache between cases. */
export function resetToolchainsForTests(): void {
  cache = null
  inFlight = null
}
