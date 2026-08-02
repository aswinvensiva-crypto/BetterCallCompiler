/**
 * node-pty × asar packaging matrix.
 *
 *   node test/asar/run-matrix.mjs [--variant=id,id] [--keep] [--json=path]
 *
 * The e2e suite launches `out/main/index.js` from a plain directory, so it can
 * only ever prove node-pty works *unpackaged*. Packaging is where node-pty
 * breaks: `electron.vite.config.ts` externalises dependencies, so the built main
 * bundle still does a live `require('node-pty')`, and whether that resolves to
 * something loadable is decided entirely by the asar config.
 *
 * This builds a minimal Electron app four ways, runs each one for real, and
 * reports which steps survive. It deliberately does not depend on
 * electron-builder: the variants are produced with @electron/asar directly, so
 * the matrix stays runnable before any packaging config exists.
 *
 * Exit code reflects only the variants marked `required` — a packed variant
 * failing is the finding, not a broken build.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules')
const PROBE_DIR = path.join(HERE, 'probe')

/** Electron cold start plus a ConPTY handshake; generous, and only hit on hangs. */
const VARIANT_TIMEOUT_MS = 120_000

/**
 * The four ways this app could realistically be packaged.
 *
 * `unpack` globs are the same syntax electron-builder's `asarUnpack` takes, so a
 * variant that passes here transfers to package.json verbatim.
 */
const VARIANTS = [
  {
    id: 'no-asar',
    label: 'asar: false',
    note: 'baseline — every file is real on disk',
    asar: false,
    unpack: null,
    required: true
  },
  {
    id: 'packed',
    label: 'asar: true (nothing unpacked)',
    note: 'all of node-pty sealed inside app.asar',
    asar: true,
    unpack: null,
    required: false
  },
  {
    id: 'unpack-build-release',
    label: "asar: true + asarUnpack '**/node-pty/build/Release/**'",
    note: 'the recipe most guides give — but 1.1.0 loads natives from prebuilds/',
    asar: true,
    unpack: '**/node_modules/node-pty/build/Release/**',
    required: false
  },
  {
    id: 'unpack-dot-node',
    label: "asar: true + asarUnpack '**/*.node'",
    note: 'the common half-measure: addons out, helper binaries still in',
    asar: true,
    unpack: '**/*.node',
    required: false
  },
  {
    id: 'unpack-node-pty',
    label: "asar: true + asarUnpack '**/node_modules/node-pty/**'",
    note: 'the whole package unpacked — what this app should ship',
    asar: true,
    unpack: '**/node_modules/node-pty/**',
    required: true
  }
]

/** Steps whose outcome is worth a column in the summary table. */
const COLUMNS = [
  ['require', 'require("node-pty")'],
  ['spawn', 'spawn one-shot command'],
  ['session', 'spawn interactive session'],
  ['resize', 'resize'],
  ['kill', 'kill and reap'],
  ['fork', 'fork helper script']
]

function parseArgs(argv) {
  const options = { variants: null, keep: false, json: null }
  for (const arg of argv) {
    if (arg === '--keep') options.keep = true
    else if (arg.startsWith('--variant=')) options.variants = arg.slice(10).split(',').filter(Boolean)
    else if (arg.startsWith('--json=')) options.json = path.resolve(arg.slice(7))
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function fail(message) {
  process.stderr.write(`\n  ${message}\n\n`)
  process.exit(2)
}

function resolveToolchain() {
  if (!existsSync(NODE_MODULES)) {
    fail('node_modules is missing. Run `npm install` first.')
  }
  if (!existsSync(path.join(NODE_MODULES, 'node-pty'))) {
    fail('node_modules/node-pty is missing. Run `npm install` first.')
  }

  let electronPath
  try {
    electronPath = require('electron')
  } catch {
    fail('the `electron` package is not installed. Run `npm install` first.')
  }
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    fail('electron resolved but its binary is missing. Run `npm install` again.')
  }

  let asar
  try {
    asar = require('@electron/asar')
  } catch {
    fail('@electron/asar is not installed. It ships with electron-builder; run `npm install`.')
  }

  return { electronPath, asar }
}

/**
 * Builds one variant and returns the path Electron should be pointed at —
 * a directory for the unpacked variant, an `app.asar` for the rest.
 */
async function stageVariant(variant, workDir, asar) {
  const root = path.join(workDir, variant.id)
  const appDir = path.join(root, 'app')
  await mkdir(root, { recursive: true })

  // The probe is the whole "application": package.json + main.js.
  await cp(PROBE_DIR, appDir, { recursive: true })

  // node-addon-api is a headers-only build dependency, but copy it when present
  // so the staged tree matches what a packager would emit from the real
  // dependency graph.
  for (const dependency of ['node-pty', 'node-addon-api']) {
    const source = path.join(NODE_MODULES, dependency)
    if (!existsSync(source)) continue
    // `cp` preserves file modes, which matters for the exec bit on spawn-helper.
    await cp(source, path.join(appDir, 'node_modules', dependency), { recursive: true })
  }

  if (!variant.asar) return { appPath: appDir, unpacked: null }

  const archive = path.join(root, 'app.asar')
  const options = variant.unpack === null ? {} : { unpack: variant.unpack }
  await asar.createPackageWithOptions(appDir, archive, options)

  // Remove the staging tree so a variant cannot accidentally resolve node-pty
  // from a plain directory left lying next to the archive.
  await rm(appDir, { recursive: true, force: true })

  // Never assume the glob did what the label claims. minimatch escapes on
  // backslashes, so a pattern that unpacks correctly on POSIX can silently
  // unpack nothing on Windows. The truth is whatever is in app.asar.unpacked.
  return { appPath: archive, unpacked: await listTree(`${archive}.unpacked`) }
}

async function listTree(root) {
  if (!existsSync(root)) return []
  const found = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else found.push(path.relative(root, full).replace(/\\/g, '/'))
    }
  }
  await walk(root)
  return found.sort()
}

/**
 * A hung Electron leaves the PTY it spawned behind, so the whole tree goes.
 * The child is not detached, so there is no process group of its own to signal
 * on POSIX — taskkill /T is the only tree-aware option, and it is Windows-only.
 */
function killTree(child) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    }).on('error', () => undefined)
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already gone.
  }
}

function runElectron(electronPath, appPath, variant, outFile, nonce) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [appPath], {
      cwd: path.dirname(appPath),
      env: {
        ...process.env,
        BETTERCALLCOMPILER_PROBE_OUT: outFile,
        BETTERCALLCOMPILER_PROBE_VARIANT: variant.id,
        BETTERCALLCOMPILER_PROBE_NONCE: nonce,
        // Never ELECTRON_RUN_AS_NODE here: it disables the asar hooks under test.
        ELECTRON_ENABLE_LOGGING: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, VARIANT_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ launched: false, error: error.message, stdout, stderr, timedOut })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ launched: true, code, signal, stdout, stderr, timedOut })
    })
  })
}

/** The probe writes a file; stdout is the fallback when Electron has no console. */
async function readReport(outFile, stdout) {
  try {
    return JSON.parse(await readFile(outFile, 'utf8'))
  } catch {
    const marker = stdout.lastIndexOf('---BETTERCALLCOMPILER-PROBE---')
    if (marker === -1) return null
    try {
      return JSON.parse(stdout.slice(marker + '---BETTERCALLCOMPILER-PROBE---'.length))
    } catch {
      return null
    }
  }
}

function stepStatus(report, stepName) {
  if (report === null) return '  ?  '
  const found = report.steps?.find((entry) => entry.name === stepName)
  if (found === undefined) return '  -  '
  if (found.ok && found.detail?.skipped !== undefined) return ' skip'
  return found.ok ? '  ok ' : ' FAIL'
}

function padEnd(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function printReport(variant, outcome) {
  const { report, run, unpacked } = outcome
  process.stdout.write(`\n${'='.repeat(78)}\n${variant.label}\n  ${variant.note}\n${'='.repeat(78)}\n`)

  if (variant.unpack !== null && unpacked !== null) {
    if (unpacked.length === 0) {
      process.stdout.write(
        `  WARNING: asarUnpack '${variant.unpack}' matched nothing — this variant is\n` +
          `           identical to the fully packed one, so read its result as such.\n`
      )
    } else {
      process.stdout.write(`  app.asar.unpacked holds ${unpacked.length} file(s)\n`)
    }
  }

  if (report === null) {
    process.stdout.write(
      `  no report produced${run.timedOut ? ' (timed out)' : ''}` +
        `${run.launched ? ` — electron exited ${run.code}` : ` — launch failed: ${run.error}`}\n`
    )
    const noise = (run.stderr || run.stdout).trim().split('\n').slice(-12).join('\n    ')
    if (noise !== '') process.stdout.write(`    ${noise}\n`)
    return
  }

  for (const entry of report.steps ?? []) {
    const mark = entry.ok ? 'ok  ' : 'FAIL'
    process.stdout.write(`  ${mark} ${padEnd(entry.name, 32)} ${String(entry.ms).padStart(6)}ms\n`)
    if (!entry.ok) process.stdout.write(`       ${entry.error}\n`)
  }

  const inventoryStep = report.steps?.find((entry) => entry.name === 'runtime asset inventory')
  for (const asset of inventoryStep?.detail?.assets ?? []) {
    const flag = asset.location === 'in-archive' ? '  <-- ' + asset.risk : ''
    process.stdout.write(`       ${padEnd(asset.location, 12)} ${asset.file}${flag}\n`)
  }

  for (const crash of report.crashes ?? []) {
    process.stdout.write(`  CRASH ${crash.type}: ${crash.message}\n`)
  }
}

function printMatrix(results) {
  const labelWidth =
    Math.max(...results.map(({ variant }) => variant.label.length + 2), 'variant'.length) + 2
  const widths = [labelWidth, ...COLUMNS.map(([label]) => Math.max(label.length, 5) + 1)]
  const header = ['variant', ...COLUMNS.map(([label]) => label)]
  process.stdout.write(`\n${'='.repeat(78)}\nmatrix\n${'='.repeat(78)}\n`)
  process.stdout.write(header.map((cell, index) => padEnd(cell, widths[index])).join('') + '\n')

  for (const { variant, outcome } of results) {
    const cells = [
      padEnd(variant.label + (variant.required ? ' *' : ''), widths[0]),
      ...COLUMNS.map(([, stepName], index) =>
        padEnd(stepStatus(outcome.report, stepName), widths[index + 1])
      )
    ]
    process.stdout.write(cells.join('') + '\n')
  }
  process.stdout.write('\n  * required — a failure here fails this run\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { electronPath, asar } = resolveToolchain()

  const selected =
    options.variants === null
      ? VARIANTS
      : VARIANTS.filter((variant) => options.variants.includes(variant.id))
  if (selected.length === 0) {
    fail(`no variant matched. Known ids: ${VARIANTS.map((v) => v.id).join(', ')}`)
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'bettercallcompiler-asar-pty-'))
  const nonce = Math.random().toString(36).slice(2, 10)
  process.stdout.write(`  electron:  ${electronPath}\n  staging:   ${workDir}\n`)

  const results = []
  try {
    for (const variant of selected) {
      process.stdout.write(`\n  building ${variant.id} ...`)
      const { appPath, unpacked } = await stageVariant(variant, workDir, asar)
      process.stdout.write(` running ...`)

      const outFile = path.join(workDir, `${variant.id}.json`)
      const run = await runElectron(electronPath, appPath, variant, outFile, nonce)
      const report = await readReport(outFile, run.stdout)
      process.stdout.write(` ${report?.ok === true ? 'ok' : 'issues'}\n`)

      results.push({ variant, outcome: { report, run, unpacked } })
    }

    for (const { variant, outcome } of results) printReport(variant, outcome)
    printMatrix(results)

    if (options.json !== null) {
      await writeFile(
        options.json,
        JSON.stringify(
          results.map(({ variant, outcome }) => ({
            variant: variant.id,
            label: variant.label,
            required: variant.required,
            asarUnpack: variant.unpack,
            unpackedFiles: outcome.unpacked,
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

    const broken = results.filter(
      ({ variant, outcome }) => variant.required && outcome.report?.ok !== true
    )
    if (broken.length > 0) {
      process.stdout.write(
        `\n  FAILED: ${broken.map(({ variant }) => variant.id).join(', ')}\n\n`
      )
      process.exitCode = 1
    } else {
      process.stdout.write('\n  required variants passed\n\n')
    }
  } finally {
    if (options.keep) process.stdout.write(`  staging kept at ${workDir}\n`)
    else await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`\n  ${error instanceof Error ? error.stack : String(error)}\n\n`)
  process.exit(2)
})
