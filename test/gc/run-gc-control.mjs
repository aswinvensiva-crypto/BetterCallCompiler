/**
 * Interleaved GC control test: 0 GC (control) vs 1 GC vs 2 GC.
 *
 *   node test/gc/run-gc-control.mjs [--arm=0,1,2] [--json=path]
 *
 * Each arm is a separate Electron process running an identical PTY sequence.
 * The only variable is how many back-to-back `global.gc()` passes run between
 * operations. Separate processes rather than three passes in one process: a
 * shared heap would let arm 0 leave garbage that arm 2 then collects, which is
 * exactly the confound a control test exists to remove.
 *
 * The probe lives inside the repo so `require('node-pty')` resolves up to the
 * project's node_modules — no staging or copying needed.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_DIR = path.join(HERE, 'probe')

const ARM_TIMEOUT_MS = 120_000

const ARMS = [
  { id: 0, label: '0 GC (control)', note: 'identical sequence, collector never forced' },
  { id: 1, label: '1 GC per interleave point', note: 'single pass from a fresh stack' },
  {
    id: 2,
    label: '2 GC per interleave point',
    note: 'folklore says a 2nd pass is needed for weak refs; measured, it is not'
  }
]

const COLUMNS = [
  ['spawn', 'spawn retained session'],
  ['write1', 'retained survives GC (write 1)'],
  ['resize', 'resize after GC'],
  ['drop', 'spawn dropped session'],
  ['collect', 'dropped session after interleaved GC'],
  ['write2', 'retained still works (write 2)'],
  ['kill', 'explicit kill still reaps']
]

function parseArgs(argv) {
  const options = { arms: null, json: null }
  for (const arg of argv) {
    if (arg.startsWith('--arm=')) options.arms = arg.slice(6).split(',').map(Number)
    else if (arg.startsWith('--json=')) options.json = path.resolve(arg.slice(7))
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function fail(message) {
  process.stderr.write(`\n  ${message}\n\n`)
  process.exit(2)
}

function resolveElectron() {
  let electronPath
  try {
    electronPath = require('electron')
  } catch {
    fail('the `electron` package is not installed. Run `npm install` first.')
  }
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    fail('electron resolved but its binary is missing.')
  }
  return electronPath
}

function runArm(electronPath, arm, outFile, nonce) {
  return new Promise((resolve) => {
    // --js-flags must precede the app path or Electron forwards it to the app
    // instead of consuming it, and global.gc would stay undefined.
    const child = spawn(electronPath, ['--js-flags=--expose-gc', PROBE_DIR], {
      cwd: PROBE_DIR,
      env: {
        ...process.env,
        BETTERCALLCOMPILER_GC_OUT: outFile,
        BETTERCALLCOMPILER_GC_ARM: String(arm.id),
        BETTERCALLCOMPILER_GC_NONCE: nonce,
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })

    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        }).on('error', () => undefined)
      } else {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }, ARM_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ launched: false, error: error.message, stdout, stderr, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ launched: true, code, stdout, stderr, timedOut })
    })
  })
}

async function readReport(outFile, stdout) {
  try {
    return JSON.parse(await readFile(outFile, 'utf8'))
  } catch {
    const marker = stdout.lastIndexOf('---BETTERCALLCOMPILER-GC---')
    if (marker === -1) return null
    try {
      return JSON.parse(stdout.slice(marker + '---BETTERCALLCOMPILER-GC---'.length))
    } catch {
      return null
    }
  }
}

const pad = (text, width) => (text.length >= width ? text : text + ' '.repeat(width - text.length))

function statusOf(report, stepName) {
  if (report === null) return '  ?  '
  const found = report.steps?.find((e) => e.name === stepName)
  if (found === undefined) return '  -  '
  return found.ok ? '  ok ' : ' FAIL'
}

function printArm(arm, outcome) {
  const { report, run } = outcome
  process.stdout.write(`\n${'='.repeat(78)}\narm ${arm.id} — ${arm.label}\n  ${arm.note}\n${'='.repeat(78)}\n`)

  if (report === null) {
    process.stdout.write(
      `  no report${run.timedOut ? ' (timed out)' : ''}` +
        `${run.launched ? ` — electron exited ${run.code}` : ` — launch failed: ${run.error}`}\n`
    )
    const noise = (run.stderr || run.stdout).trim().split('\n').slice(-10).join('\n    ')
    if (noise !== '') process.stdout.write(`    ${noise}\n`)
    return
  }

  if (report.blocker !== undefined) {
    process.stdout.write(`  BLOCKER: ${report.blocker}\n`)
    return
  }

  for (const entry of report.steps ?? []) {
    process.stdout.write(
      `  ${entry.ok ? 'ok  ' : 'FAIL'} ${pad(entry.name, 38)} ${String(entry.ms).padStart(6)}ms\n`
    )
    if (!entry.ok) process.stdout.write(`       ${entry.error}\n`)
  }

  const c = report.collection
  if (c !== null && c !== undefined) {
    process.stdout.write(
      `\n  dropped IPty -> collected: ${c.objectCollected}` +
        `   finalizer: ${c.finalizerFired}` +
        `   OS process alive: ${c.osProcessStillAlive}\n  ${c.note}\n` +
        `  sentinel     -> collected: ${c.sentinelCollected}` +
        `   finalizer: ${c.sentinelFinalizerFired}\n`
    )
    if (arm.id > 0 && c.instrumentProven !== true) {
      process.stdout.write(
        `  WARNING: positive control was not collected either — this arm cannot\n` +
          `           observe collection, so its IPty result proves nothing.\n`
      )
    }
  }
  process.stdout.write(`  heap ${report.heapKbStart} KB -> ${report.heapKbEnd} KB\n`)
  for (const crash of report.crashes ?? []) {
    process.stdout.write(`  CRASH ${crash.type}: ${crash.message}\n`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const electronPath = resolveElectron()

  const selected = options.arms === null ? ARMS : ARMS.filter((a) => options.arms.includes(a.id))
  if (selected.length === 0) fail('no arm matched. Known arms: 0, 1, 2')

  const workDir = await mkdtemp(path.join(tmpdir(), 'bettercallcompiler-gc-'))
  const nonce = Math.random().toString(36).slice(2, 10)
  process.stdout.write(`  electron: ${electronPath}\n  probe:    ${PROBE_DIR}\n`)

  const results = []
  try {
    for (const arm of selected) {
      process.stdout.write(`\n  running arm ${arm.id} (${arm.label}) ...`)
      const outFile = path.join(workDir, `arm-${arm.id}.json`)
      const run = await runArm(electronPath, arm, outFile, nonce)
      const report = await readReport(outFile, run.stdout)
      process.stdout.write(` ${report?.ok === true ? 'ok' : 'issues'}\n`)
      results.push({ arm, outcome: { report, run } })
    }

    for (const { arm, outcome } of results) printArm(arm, outcome)

    // The comparison the test exists to make.
    process.stdout.write(`\n${'='.repeat(78)}\ncontrol matrix\n${'='.repeat(78)}\n`)
    const width = 32
    process.stdout.write(
      pad('arm', width) + COLUMNS.map(([l]) => pad(l, Math.max(l.length, 5) + 2)).join('') + '\n'
    )
    for (const { arm, outcome } of results) {
      process.stdout.write(
        pad(`${arm.id} — ${arm.label}`, width) +
          COLUMNS.map(([l, step]) =>
            pad(statusOf(outcome.report, step), Math.max(l.length, 5) + 2)
          ).join('') +
          '\n'
      )
    }

    process.stdout.write(
      `\n${pad('arm', width)}${pad('pty-collected', 15)}${pad('pty-final', 11)}` +
        `${pad('proc-alive', 12)}${pad('SENTINEL', 10)}${'sent-final'}\n`
    )
    for (const { arm, outcome } of results) {
      const c = outcome.report?.collection
      process.stdout.write(
        pad(`${arm.id} — ${arm.label}`, width) +
          pad(String(c?.objectCollected ?? '?'), 15) +
          pad(String(c?.finalizerFired ?? '?'), 11) +
          pad(String(c?.osProcessStillAlive ?? '?'), 12) +
          pad(String(c?.sentinelCollected ?? '?'), 10) +
          String(c?.sentinelFinalizerFired ?? '?') +
          '\n'
      )
    }
    process.stdout.write(
      '\n  SENTINEL is the positive control: it must read true in the GC arms,\n' +
        '  otherwise the rig cannot observe collection and the pty column is void.\n'
    )

    if (options.json !== null) {
      await writeFile(
        options.json,
        JSON.stringify(
          results.map(({ arm, outcome }) => ({
            arm: arm.id,
            label: arm.label,
            report: outcome.report,
            exitCode: outcome.run.code ?? null,
            timedOut: outcome.run.timedOut
          })),
          null,
          2
        )
      )
      process.stdout.write(`\n  json written to ${options.json}\n`)
    }

    const broken = results.filter(({ outcome }) => outcome.report?.ok !== true)
    if (broken.length > 0) {
      process.stdout.write(`\n  FAILED arms: ${broken.map(({ arm }) => arm.id).join(', ')}\n\n`)
      process.exitCode = 1
    } else {
      process.stdout.write('\n  all arms passed\n\n')
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`\n  ${error instanceof Error ? error.stack : String(error)}\n\n`)
  process.exit(2)
})
