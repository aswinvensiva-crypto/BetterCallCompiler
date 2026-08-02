'use strict'

/**
 * Electron main process that answers one question: does node-pty actually work
 * from wherever the packager put it?
 *
 * This file is staged into each asar variant by ../run-matrix.mjs and run as a
 * real Electron app (never with ELECTRON_RUN_AS_NODE — that would bypass the
 * asar fs patch and the `process.dlopen` patch, which are the whole subject of
 * the test). Results go to a JSON file rather than stdout, because Electron on
 * Windows only writes to stdout when a console happens to be attached.
 *
 * Every step is recorded rather than thrown, so a variant that fails at step 3
 * still reports what steps 1 and 2 found.
 */

const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')

// `original-fs` is Electron's unpatched fs. It is the only way to ask "does
// this file exist as a real file on disk", because the normal `fs` happily
// answers yes for paths that live inside the archive.
let originalFs = fs
try {
  originalFs = require('original-fs')
} catch {
  // Not running under Electron; the plain-directory variant needs no unpatching.
}

const OUT_FILE = process.env['APERTURE_PROBE_OUT'] ?? ''
const VARIANT = process.env['APERTURE_PROBE_VARIANT'] ?? '(unset)'
const NONCE = process.env['APERTURE_PROBE_NONCE'] ?? 'nonce'

/** Long enough for a cold ConPTY on a loaded machine, short enough to fail fast. */
const SPAWN_TIMEOUT_MS = 20_000
/** node-pty's `kill()` blocks the caller ~1.6s on Windows before onExit lands. */
const EXIT_TIMEOUT_MS = 15_000

const steps = []
const crashes = []

// node-pty's Windows teardown forks a helper and can throw asynchronously
// ("AttachConsole failed"). In a packaged app that is invisible; here it is a
// recorded result.
process.on('uncaughtException', (error) => {
  crashes.push({ type: 'uncaughtException', message: describe(error) })
})
process.on('unhandledRejection', (reason) => {
  crashes.push({ type: 'unhandledRejection', message: describe(reason) })
})

function describe(error) {
  if (error instanceof Error) {
    const code = error.code === undefined ? '' : ` [${error.code}]`
    return `${error.message}${code}`
  }
  return String(error)
}

async function step(name, fn) {
  const startedAt = Date.now()
  try {
    const detail = await fn()
    steps.push({ name, ok: true, ms: Date.now() - startedAt, detail: detail ?? null })
    return detail
  } catch (error) {
    steps.push({
      name,
      ok: false,
      ms: Date.now() - startedAt,
      detail: null,
      error: describe(error)
    })
    return null
  }
}

/**
 * Where does a path physically live?
 *
 * A path under `app.asar/` is virtual. Electron redirects reads to
 * `app.asar.unpacked/` when the packager unpacked that entry, so the presence
 * of the twin path on the real filesystem is the authoritative answer.
 */
function classify(target) {
  const match = /^(.*\.asar)([\\/].*)$/.exec(target)
  if (match === null) return { location: 'plain', realPath: target }

  const unpacked = `${match[1]}.unpacked${match[2]}`
  if (originalFs.existsSync(unpacked)) return { location: 'unpacked', realPath: unpacked }
  return { location: 'in-archive', realPath: null }
}

/**
 * Files node-pty needs at runtime, and what happens to each when it is trapped
 * inside the archive.
 *
 * `.node` is survivable: Electron patches `process.dlopen` to copy the addon to
 * a temp file before loading it. A native *executable* is not — node-pty execs
 * it by path, and there is no path to exec.
 */
const RUNTIME_ASSETS = [
  {
    match: (name) => name.toLowerCase().endsWith('.node'),
    kind: 'native addon',
    inArchive: 'degraded — Electron extracts it to a temp copy on every launch'
  },
  {
    match: (name) => name.toLowerCase() === 'winpty-agent.exe',
    kind: 'helper executable (winpty fallback)',
    inArchive: 'broken — cannot exec a file inside an archive'
  },
  {
    match: (name) => name.toLowerCase() === 'winpty.dll',
    kind: 'helper library (winpty fallback)',
    inArchive: 'broken — cannot load a DLL from inside an archive'
  },
  {
    match: (name) => name === 'spawn-helper',
    kind: 'helper executable (macOS/Linux)',
    inArchive: 'broken — cannot exec a file inside an archive'
  },
  {
    match: (name) => name.toLowerCase() === 'conpty.dll',
    kind: 'ConPTY runtime library',
    inArchive: 'broken — cannot load a DLL from inside an archive'
  },
  {
    match: (name) => name.toLowerCase() === 'openconsole.exe',
    kind: 'ConPTY host executable',
    inArchive: 'broken — cannot exec a file inside an archive'
  },
  {
    match: (name) => name === 'conpty_console_list_agent.js',
    kind: 'forked script (descendant reaping)',
    inArchive: 'usually ok — forked children inherit Electron’s asar support'
  }
]

function inventory(packageDir) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      const asset = RUNTIME_ASSETS.find((candidate) => candidate.match(entry.name))
      if (asset === undefined) continue
      const { location, realPath } = classify(full)
      found.push({
        file: path.relative(packageDir, full).replace(/\\/g, '/'),
        kind: asset.kind,
        location,
        realPath,
        risk: location === 'in-archive' ? asset.inArchive : null
      })
    }
  }
  walk(packageDir, 0)
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * ConPTY interleaves escape sequences with the output, so a marker can arrive
 * split by a cursor move. Strip the sequences before matching.
 */
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const ANSI_CSI = /\u001b\[[0-9;?]*[\u0020-\u002f]*[\u0040-\u007e]/g

function stripAnsi(text) {
  return text.replace(ANSI_OSC, '').replace(ANSI_CSI, '')
}

/** A shell that exists everywhere. Which shell the app prefers is orthogonal to asar. */
function probeShell() {
  if (process.platform === 'win32') {
    return { file: process.env['ComSpec'] ?? 'cmd.exe', oneShot: ['/d', '/s', '/c'] }
  }
  return { file: '/bin/sh', oneShot: ['-c'] }
}

function waitForMarker(pty, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      disposable.dispose()
      reject(new Error(`marker "${marker}" not seen in ${timeoutMs}ms; last output: ${JSON.stringify(buffer.slice(-400))}`))
    }, timeoutMs)

    const disposable = pty.onData((chunk) => {
      buffer += stripAnsi(chunk)
      if (!buffer.includes(marker)) return
      clearTimeout(timer)
      disposable.dispose()
      resolve(buffer.length)
    })
  })
}

function waitForExit(pty, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no exit event in ${timeoutMs}ms`)), timeoutMs)
    pty.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      resolve({ exitCode, signal: signal ?? null })
    })
  })
}

async function run() {
  const started = Date.now()
  let nodePty = null
  let packageDir = null

  await step('require("node-pty")', () => {
    const resolved = require.resolve('node-pty')
    nodePty = require('node-pty')
    if (typeof nodePty.spawn !== 'function') throw new Error('module loaded but exports no spawn()')

    // Walk up from the entry file to the directory holding node-pty's own
    // package.json — reliable regardless of whether it is lib/index.js today.
    let dir = path.dirname(resolved)
    while (path.basename(dir) !== 'node-pty' && dir !== path.dirname(dir)) dir = path.dirname(dir)
    packageDir = dir

    let version = 'unknown'
    try {
      version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
    } catch {
      // Version is nice to have, not load-bearing.
    }
    return { resolved, packageDir: dir, version, ...classify(resolved) }
  })

  const assetReport = await step('runtime asset inventory', () => {
    if (packageDir === null) throw new Error('node-pty did not load; nothing to inventory')
    const assets = inventory(packageDir)
    if (assets.length === 0) throw new Error('found no native addon or helper files under node-pty')
    return {
      assets,
      atRisk: assets.filter((asset) => asset.risk !== null).map((asset) => asset.file)
    }
  })

  const shell = probeShell()

  // One-shot: proves the addon loads, forks a real process, and streams bytes
  // back. `/c` and `-c` do not echo the command, so seeing the marker is proof
  // of output rather than of input.
  await step('spawn one-shot command', async () => {
    if (nodePty === null) throw new Error('node-pty did not load')
    const marker = `APERTURE-${NONCE}-ONESHOT`
    const pty = nodePty.spawn(shell.file, [...shell.oneShot, `echo ${marker}`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: { ...process.env }
    })
    const exited = waitForExit(pty, SPAWN_TIMEOUT_MS + EXIT_TIMEOUT_MS)
    await waitForMarker(pty, marker, SPAWN_TIMEOUT_MS)
    const result = await exited
    return { pid: pty.pid, shell: shell.file, ...result }
  })

  // Interactive: the session shape the app actually uses. Held open across a
  // resize and torn down with kill(), which is the path that forks node-pty's
  // console-list agent on Windows.
  let interactive = null
  await step('spawn interactive session', async () => {
    if (nodePty === null) throw new Error('node-pty did not load')
    const pty = nodePty.spawn(shell.file, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: { ...process.env }
    })
    interactive = pty

    // The shell echoes typed input, so a literal marker in the command would
    // match its own echo. Building it from a variable makes the echoed line and
    // the output line differ. On cmd this must be two lines: %M% on the same
    // line as the assignment would expand at parse time, before set runs.
    const marker = `APERTURE-${NONCE}-INTERACTIVE-OK`
    const command =
      process.platform === 'win32'
        ? `set M=OK\recho APERTURE-${NONCE}-INTERACTIVE-%M%\r`
        : `M=OK; echo APERTURE-${NONCE}-INTERACTIVE-$M\n`
    pty.write(command)
    await waitForMarker(pty, marker, SPAWN_TIMEOUT_MS)
    return { pid: pty.pid }
  })

  await step('resize', () => {
    if (interactive === null) throw new Error('no interactive session')
    interactive.resize(120, 40)
    return { cols: 120, rows: 40 }
  })

  // The step most sensitive to packaging on Windows: kill() reaps descendants
  // by forking build/Release/conpty_console_list_agent.js.
  await step('kill and reap', async () => {
    if (interactive === null) throw new Error('no interactive session')
    const exited = waitForExit(interactive, EXIT_TIMEOUT_MS)
    interactive.kill()
    return await exited
  })

  // Direct check of the fork path, independent of whether node-pty took it.
  //
  // The location is discovered rather than assumed: node-pty 1.1.0 forks
  // lib/conpty_console_list_agent.js (windowsPtyAgent.js uses __dirname), not
  // the build/Release path older docs describe. The forked child then loads
  // conpty_console_list.node itself, so this exercises a second-order case —
  // an asar lookup from inside a child process.
  await step('fork helper script', async () => {
    if (packageDir === null) throw new Error('node-pty did not load')
    const entry = (assetReport?.assets ?? []).find((asset) =>
      asset.file.endsWith('conpty_console_list_agent.js')
    )
    if (entry === undefined) return { skipped: 'helper not present on this platform' }
    const helper = path.join(packageDir, entry.file)
    if (!fs.existsSync(helper)) return { skipped: 'helper not present in this build' }

    const { location } = classify(helper)
    await new Promise((resolve, reject) => {
      const child = fork(helper, [String(process.pid)], { stdio: 'ignore' })
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 5_000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return { helper, location }
  })

  return {
    variant: VARIANT,
    ok: steps.every((entry) => entry.ok) && crashes.length === 0,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    appPath: app.getAppPath(),
    totalMs: Date.now() - started,
    steps,
    crashes
  }
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  let report
  try {
    report = await run()
  } catch (error) {
    report = { variant: VARIANT, ok: false, fatal: describe(error), steps, crashes }
  }

  // Give node-pty's asynchronous teardown a moment to throw into our handlers
  // before the report is sealed.
  await new Promise((resolve) => setTimeout(resolve, 500))
  report.crashes = crashes
  report.ok = report.ok === true && crashes.length === 0

  const serialised = JSON.stringify(report, null, 2)
  if (OUT_FILE !== '') {
    try {
      fs.writeFileSync(OUT_FILE, serialised)
    } catch {
      // Fall through to stdout.
    }
  }
  process.stdout.write(`\n---APERTURE-PROBE---\n${serialised}\n`)

  app.exit(report.ok ? 0 : 1)
})
