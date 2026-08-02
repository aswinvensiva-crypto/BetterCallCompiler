'use strict'

/**
 * Interleaved GC control probe for the PTY layer.
 *
 * One Electron main process per arm. The arm count (0, 1 or 2) is how many
 * back-to-back `global.gc()` passes run *between* every PTY operation — the
 * "interleaved" part. Arm 0 is the control: identical sequence, no GC at all,
 * so any difference in the other arms is attributable to collection.
 *
 * Why 1 versus 2: the folklore is that V8 needs a second pass before weak refs
 * clear. Measured here that is false — what actually decides it is whether the
 * gc() runs on a stack still holding the object (see gcPoint). Both arms are
 * kept because the comparison is the point: arm 1 and arm 2 agreeing is the
 * result, not a redundancy.
 *
 * FinalizationRegistry callbacks are queued on a separate job rather than run
 * inline. With the macrotask yields in gcPoint they do land inside the probe
 * window; without them they never fire at all. WeakRef.deref() stays the
 * primary signal because it is the one that does not depend on that timing.
 *
 * Requires --js-flags=--expose-gc. Without it `global.gc` is undefined and the
 * arms are indistinguishable, so that is reported as a hard blocker rather than
 * silently degrading into three identical control runs.
 */

const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const { spawn: spawnProcess } = require('node:child_process')

const OUT_FILE = process.env['BETTERCALLCOMPILER_GC_OUT'] ?? ''
const ARM = Number(process.env['BETTERCALLCOMPILER_GC_ARM'] ?? '1')
const NONCE = process.env['BETTERCALLCOMPILER_GC_NONCE'] ?? 'nonce'

const SPAWN_TIMEOUT_MS = 20_000
const EXIT_TIMEOUT_MS = 15_000

const steps = []
const crashes = []
const leakedPids = []

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
    steps.push({ name, ok: false, ms: Date.now() - startedAt, error: describe(error) })
    return null
  }
}

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * One interleave point: ARM passes of GC, each from a fresh stack.
 *
 * The yield before each pass is load-bearing, not politeness. V8 uses
 * conservative stack scanning, so a `gc()` invoked on the same stack that
 * created an object treats leftover stack slots as live roots and keeps it
 * alive. Measured in this Electron build (V8 15.0): an inline `gc()` collects
 * nothing whether called once or twice, while a single `gc()` after a macrotask
 * turn collects on the first pass. The stack is the variable, not the count.
 *
 * Arm 0 still yields so the arms differ only in whether gc() is called, not in
 * how many event-loop turns elapse.
 */
async function gcPoint() {
  for (let i = 0; i < Math.max(ARM, 1); i++) {
    await nextMacrotask()
    if (i < ARM) global.gc()
  }
  await nextMacrotask()
}

const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const ANSI_CSI = /\u001b\[[0-9;?]*[\u0020-\u002f]*[\u0040-\u007e]/g
const stripAnsi = (text) => text.replace(ANSI_OSC, '').replace(ANSI_CSI, '')

function probeShell() {
  return process.platform === 'win32'
    ? { file: process.env['ComSpec'] ?? 'cmd.exe' }
    : { file: '/bin/sh' }
}

/** Same two-line trick as the asar probe: cmd expands %M% before `set` on one line. */
function markerCommand(tag) {
  return process.platform === 'win32'
    ? `set M=OK\recho BETTERCALLCOMPILER-${NONCE}-${tag}-%M%\r`
    : `M=OK; echo BETTERCALLCOMPILER-${NONCE}-${tag}-$M\n`
}

function waitForMarker(pty, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      disposable.dispose()
      reject(new Error(`marker "${marker}" not seen in ${timeoutMs}ms; tail: ${JSON.stringify(buffer.slice(-300))}`))
    }, timeoutMs)
    const disposable = pty.onData((chunk) => {
      buffer += stripAnsi(chunk)
      if (!buffer.includes(marker)) return
      clearTimeout(timer)
      disposable.dispose()
      resolve(true)
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

/** Signal 0 is an existence check; Node supports it on Windows too. */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function reap(pid) {
  if (!isAlive(pid)) return
  if (process.platform === 'win32') {
    try {
      spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      }).on('error', () => undefined)
    } catch {
      // Nothing more to do.
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

async function run() {
  const nodePty = require('node-pty')
  const shell = probeShell()
  const heap = () => Math.round(process.memoryUsage().heapUsed / 1024)

  // The sessions Map mirrors terminal.ts: a strong reference that must keep a
  // live PTY from ever being collected, no matter how many GC passes run.
  const sessions = new Map()

  const heapStart = heap()

  const retained = await step('spawn retained session', async () => {
    const pty = nodePty.spawn(shell.file, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: { ...process.env }
    })
    sessions.set('retained', pty)
    return { pid: pty.pid }
  })

  await gcPoint()

  await step('retained survives GC (write 1)', async () => {
    const pty = sessions.get('retained')
    if (pty === undefined) throw new Error('session vanished from the map')
    const promise = waitForMarker(pty, `BETTERCALLCOMPILER-${NONCE}-ONE-OK`, SPAWN_TIMEOUT_MS)
    pty.write(markerCommand('ONE'))
    await promise
    return { alive: isAlive(pty.pid) }
  })

  await gcPoint()

  await step('resize after GC', () => {
    sessions.get('retained').resize(120, 40)
    return { cols: 120, rows: 40 }
  })

  await gcPoint()

  // The collectible probe: a PTY whose only handle is a WeakRef. If V8 can
  // collect it, this is where it happens.
  //
  // A sentinel of ordinary garbage rides alongside it as a positive control.
  // Without one, "not collected" is ambiguous: it could mean the PTY is
  // genuinely retained, or that this WeakRef/FinalizationRegistry rig does not
  // detect collection at all. The sentinel is what gives the 1-versus-2
  // comparison any discriminating power — it is the thing that *should* differ
  // between arms.
  let dropped = null
  let sentinelRef = null
  const finalized = new Set()
  const registry = new FinalizationRegistry((tag) => finalized.add(tag))

  // Allocated inside its own frame so the local does not linger in the caller's
  // stack frame, where V8's conservative stack scanning would keep it alive and
  // produce a false "not collected".
  const makeSentinel = () => {
    const sentinel = { tag: 'sentinel', payload: new Array(10_000).fill(NONCE) }
    sentinelRef = new WeakRef(sentinel)
    registry.register(sentinel, 'sentinel')
  }
  makeSentinel()

  const droppedPid = await step('spawn dropped session', async () => {
    const pty = nodePty.spawn(shell.file, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: { ...process.env }
    })
    const pid = pty.pid
    leakedPids.push(pid)
    dropped = new WeakRef(pty)
    registry.register(pty, 'dropped')
    // No strong reference survives this scope.
    return { pid }
  })

  await gcPoint()

  const collection = await step('dropped session after interleaved GC', async () => {
    const stillReferenced = dropped.deref() !== undefined
    const sentinelAlive = sentinelRef.deref() !== undefined
    const pid = droppedPid?.pid ?? -1
    return {
      gcPassesPerPoint: ARM,
      objectCollected: !stillReferenced,
      finalizerFired: finalized.has('dropped'),
      osProcessStillAlive: isAlive(pid),
      // Positive control. If this is false in the GC arms then the rig cannot
      // observe collection, and the PTY result above carries no information.
      sentinelCollected: !sentinelAlive,
      sentinelFinalizerFired: finalized.has('sentinel'),
      instrumentProven: !sentinelAlive,
      note: stillReferenced
        ? 'IPty still reachable — a live conout socket roots the object graph'
        : 'IPty object collected'
    }
  })

  await gcPoint()

  // The point of the whole exercise: after everything above, is the retained
  // session still a working PTY, or did GC quietly break it?
  await step('retained still works (write 2)', async () => {
    const pty = sessions.get('retained')
    const promise = waitForMarker(pty, `BETTERCALLCOMPILER-${NONCE}-TWO-OK`, SPAWN_TIMEOUT_MS)
    pty.write(markerCommand('TWO'))
    await promise
    return { alive: isAlive(pty.pid) }
  })

  await gcPoint()

  await step('explicit kill still reaps', async () => {
    const pty = sessions.get('retained')
    const exited = waitForExit(pty, EXIT_TIMEOUT_MS)
    pty.kill()
    const result = await exited
    sessions.delete('retained')
    return result
  })

  await gcPoint()

  return {
    arm: ARM,
    gcAvailable: typeof global.gc === 'function',
    platform: process.platform,
    electron: process.versions.electron ?? null,
    heapKbStart: heapStart,
    heapKbEnd: heap(),
    collection,
    steps,
    crashes
  }
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  let report

  // Blocker check before anything else: without --expose-gc every arm is arm 0
  // and the comparison is meaningless.
  if (typeof global.gc !== 'function') {
    report = {
      arm: ARM,
      gcAvailable: false,
      blocker: 'global.gc is undefined — Electron was not started with --js-flags=--expose-gc',
      steps: [],
      crashes: []
    }
  } else {
    try {
      report = await run()
    } catch (error) {
      report = { arm: ARM, gcAvailable: true, fatal: describe(error), steps, crashes }
    }
  }

  // Never leave the deliberately-dropped shell behind.
  for (const pid of leakedPids) reap(pid)

  await new Promise((resolve) => setTimeout(resolve, 400))
  report.crashes = crashes
  report.reapedPids = leakedPids
  report.ok =
    report.gcAvailable === true &&
    report.blocker === undefined &&
    report.fatal === undefined &&
    steps.every((entry) => entry.ok) &&
    crashes.length === 0

  const serialised = JSON.stringify(report, null, 2)
  if (OUT_FILE !== '') {
    try {
      fs.writeFileSync(OUT_FILE, serialised)
    } catch {
      // stdout fallback below.
    }
  }
  process.stdout.write(`\n---BETTERCALLCOMPILER-GC---\n${serialised}\n`)
  app.exit(report.ok ? 0 : 1)
})
