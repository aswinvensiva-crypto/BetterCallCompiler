import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { SCENARIOS } from './scenarios.mjs'

/**
 * The evaluation harness: runs the agent's coding scenarios end to end and
 * tracks the pass rate over time — the thing a fixed "does the prompt
 * contain this exact string" unit test cannot do, because a prompt can be
 * reworded without the change ever being noticed by an exact-text assertion,
 * and a prompt can pass that assertion while producing code that plainly
 * does not work.
 *
 * ## Two modes
 *
 * **Offline (default).** Each scenario supplies `stubAnswer` — a hand-written,
 * CORRECT response in the exact `### FILE:` format the real agent system
 * prompt asks for. No network call, no API key, deterministic every run.
 * This is what runs in CI: it exercises the real parsing and checking
 * pipeline, so a regression in either still fails the run, without costing
 * tokens or depending on a model's mood that day.
 *
 * **Live** (`--live`, needs `ANTHROPIC_API_KEY`). Sends the real prompt to
 * the real model and scores its real answer. This is the actual evaluation
 * the plan describes — "verify that prompt changes produce working code" —
 * and it is opt-in because it costs money and is not reproducible the way
 * everything else this project tests is expected to be.
 *
 * Both modes go through the identical parse -> syntax-check -> scenario-check
 * pipeline, so a scenario that passes offline and fails live is telling you
 * something true about the model, not about the harness.
 *
 * Run with:  npm run test:eval           (offline)
 *            npm run test:eval -- --live (live, needs a key)
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const RESULTS_DIR = join(REPO_ROOT, '.eval-results')
const RESULTS_FILE = join(RESULTS_DIR, 'agent-eval.jsonl')

/* ------------------------------------------------------------------ *
 * Parsing a model answer into per-file edits — mirrors
 * src/shared/agent-plan.ts's `parseAgentPlan` exactly, duplicated here on
 * purpose: this script runs under plain `node`, not through the Electron +
 * Vite build, and every other proof harness in this repo (test/query,
 * test/lang) is written the same standalone way rather than importing `src/`
 * TypeScript directly.
 * ------------------------------------------------------------------ */

function parseAgentPlan(answer) {
  const lines = answer.split('\n')
  const markerPattern = /^### FILE:\s*(.+?)\s*$/
  const markers = []

  for (let i = 0; i < lines.length; i++) {
    const match = markerPattern.exec(lines[i] ?? '')
    if (match?.[1] !== undefined) markers.push({ path: match[1], startLine: i })
  }

  const byPath = new Map()
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]
    const nextStart = markers[i + 1]?.startLine ?? lines.length
    const block = lines.slice(marker.startLine + 1, nextStart).join('\n')
    const fence = /```[^\n]*\n([\s\S]*?)```/.exec(block)
    if (fence?.[1] === undefined) continue
    byPath.set(marker.path.trim(), fence[1].replace(/\n$/, ''))
  }

  return byPath
}

/* ------------------------------------------------------------------ *
 * Syntax check
 * ------------------------------------------------------------------ */

/** True syntax errors, via the same TypeScript compiler the daemon runs — not a regex heuristic. */
function syntaxErrorsIn(path, content) {
  if (!/\.tsx?$/.test(path)) return []
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
  // `parseDiagnostics` is populated during `createSourceFile` itself — no
  // type checker, no program, no tsconfig needed for a syntax-only pass.
  return (source.parseDiagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  )
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

const AGENT_SYSTEM_PROMPT =
  'You are a multi-file coding agent embedded in an IDE. You are given an ' +
  'instruction and the full contents of one or more files. Propose the ' +
  'edits needed to carry out the instruction across ALL the files it ' +
  'touches, not just the first one. Reply with a short plan summary in ' +
  'prose, then for EVERY file you change, a block in exactly this form:\n\n' +
  '### FILE: <path exactly as given>\n' +
  '```\n' +
  '<the full new contents of that file>\n' +
  '```\n\n' +
  'Repeat the block for each file. Always output the WHOLE file, not a ' +
  'diff or a partial excerpt. Only include files you are given; never ' +
  'invent a new file path. If a file needs no change, omit its block ' +
  'entirely.'

function renderScenarioPrompt(scenario) {
  const parts = [`Instruction: ${scenario.instruction}`, '']
  for (const file of scenario.files) {
    parts.push(`### FILE: ${file.path}`, '```', file.before, '```', '')
  }
  return parts.join('\n').trimEnd()
}

async function runOffline(scenario) {
  return scenario.stubAnswer
}

async function runLive(scenario, apiKey) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey })
  const message = await client.messages.create({
    model: process.env.BCC_EVAL_MODEL ?? 'claude-sonnet-5',
    max_tokens: 4000,
    system: AGENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: renderScenarioPrompt(scenario) }]
  })
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/* ------------------------------------------------------------------ *
 * Running one scenario
 * ------------------------------------------------------------------ */

async function runScenario(scenario, mode, apiKey) {
  const answer = mode === 'live' ? await runLive(scenario, apiKey) : await runOffline(scenario)
  const edits = parseAgentPlan(answer)

  // Files: whatever the answer proposed, with unproposed files falling back
  // to their starting content — the same "no change" reading `agent:apply`
  // gives an omitted file.
  const files = new Map(scenario.files.map((file) => [file.path, file.before]))
  for (const [path, content] of edits) files.set(path, content)

  if (edits.size === 0) {
    return { id: scenario.id, pass: false, reason: 'no file blocks were parsed from the answer' }
  }

  const syntaxIssues = []
  for (const [path, content] of edits) {
    const errors = syntaxErrorsIn(path, content)
    if (errors.length > 0) syntaxIssues.push(`${path}: ${errors[0]}`)
  }
  if (syntaxIssues.length > 0) {
    return { id: scenario.id, pass: false, reason: `syntax error — ${syntaxIssues[0]}` }
  }

  const result = scenario.check(files)
  return { id: scenario.id, pass: result.ok, reason: result.ok ? null : result.reason }
}

/* ------------------------------------------------------------------ *
 * Tracking over time
 * ------------------------------------------------------------------ */

function lastRun() {
  if (!existsSync(RESULTS_FILE)) return null
  const lines = readFileSync(RESULTS_FILE, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const last = lines[lines.length - 1]
  if (last === undefined) return null
  try {
    return JSON.parse(last)
  } catch {
    return null
  }
}

function recordRun(entry) {
  mkdirSync(RESULTS_DIR, { recursive: true })
  appendFileSync(RESULTS_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const live = process.argv.includes('--live')
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (live && (apiKey === undefined || apiKey === '')) {
    console.error('--live needs ANTHROPIC_API_KEY set in the environment.')
    process.exitCode = 1
    return
  }

  const mode = live ? 'live' : 'offline'
  console.log(`Running ${SCENARIOS.length} scenario(s) in ${mode} mode…\n`)

  const results = []
  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario, mode, apiKey)
    results.push(result)
    const mark = result.pass ? 'PASS' : 'FAIL'
    console.log(`  [${mark}] ${result.id}${result.reason !== null ? ` — ${result.reason}` : ''}`)
  }

  const passed = results.filter((result) => result.pass).length
  const passRate = passed / results.length

  console.log(`\n${passed}/${results.length} passed (${(passRate * 100).toFixed(0)}%)`)

  const previous = lastRun()
  if (previous !== null && previous.mode === mode) {
    const delta = passRate - previous.passRate
    const sign = delta > 0 ? '+' : ''
    console.log(
      `Previous ${mode} run: ${(previous.passRate * 100).toFixed(0)}% ` +
        `(${sign}${(delta * 100).toFixed(0)} points since then)`
    )
  }

  recordRun({
    timestamp: new Date().toISOString(),
    mode,
    model: mode === 'live' ? (process.env.BCC_EVAL_MODEL ?? 'claude-sonnet-5') : 'stub',
    results,
    passRate
  })

  if (passed < results.length) process.exitCode = 1
}

await main()
