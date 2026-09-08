import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

/**
 * The debugger, end to end.
 *
 * The claim under test is the one Part 10 exists for, and the one no incumbent
 * makes on a real toolchain: stepping BACKWARDS. Everything here is real — real
 * worker thread, real bytecode, real VM with its undo log, real IPC — and every
 * assertion is on something a user could produce by clicking.
 *
 * Nothing reaches for the IPC bridge directly. A green test that drove
 * `debug:command` itself would prove the protocol works while saying nothing
 * about whether a breakpoint can be set or a local can be read, which is the
 * half that was missing.
 *
 * The window is pinned to 1024x730 for the reason every spec in this suite
 * pins it: a developer screen and a CI runner give different row counts, and
 * three failures earlier in this project came from exactly that.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

/**
 * A loop, so that one line is reached repeatedly with different values.
 *
 * That is what makes "step backwards" mean something an assertion can catch:
 * arriving at line 6 for the third time and then reversing to the second has a
 * different `total`, and no re-run could produce that state without running the
 * program again from the start.
 */
const SOURCE = [
  '// A loop, so a breakpoint fires more than once.', // 1
  '', //                                                2
  'let i = 0;', //                                      3
  'let total = 0;', //                                  4
  '', //                                                5
  'while i < 5 {', //                                   6
  '  total = total + i;', //                            7
  '  i = i + 1;', //                                    8
  '}', //                                               9
  '', //                                               10
  'print total;', //                                   11
  ''
].join('\n')

/** The line the breakpoint goes on: `total = total + i;`. */
const BREAKPOINT_LINE = 7

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

const DAEMON_TIMEOUT = 25_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-debug-'))
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await writeFile(join(fixture, 'examples', 'count.bcc'), SOURCE)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('debugger'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()

  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(message.text())
  })
  window.on('pageerror', (error) => consoleProblems.push(error.message))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setBounds({ x: 0, y: 0, width: 1024, height: 730 })
  })
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function treeRow(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

const lines = () => window.locator('.monaco-editor .view-lines')

/**
 * The margin row for one source line.
 *
 * Monaco renders one child of `.margin-view-overlays` per VISIBLE line, in
 * scroll order rather than in line order, so the row is found by the line
 * number it draws rather than by its index.
 */
function marginRow(lineNumber: number) {
  return window
    .locator('.monaco-editor .margin-view-overlays > div')
    .filter({ has: window.locator(`.line-numbers:text-is("${lineNumber}")`) })
}

/**
 * Click the glyph margin beside a line, which is how a breakpoint is set.
 *
 * The x offset puts the click in the glyph strip rather than on the line
 * number: with `glyphMargin: true` Monaco lays the left margin out as glyph
 * margin, then line numbers, then decorations, and the glyph strip is about one
 * line-height wide. Clicking the number instead would select the line and set
 * nothing.
 */
async function clickGutter(lineNumber: number): Promise<void> {
  /*
   * `force` skips Playwright's overlap check, not Monaco's handling.
   *
   * A line that already has a glyph — the breakpoint dot, the stopped-line bar
   * — gets a `glyph-margin-widgets` child painted over the margin row, and
   * Playwright refuses a click it can see landing on a different element.
   * Monaco resolves the mouse target from COORDINATES rather than from which
   * child received the event, so a real user clicking the dot toggles it off
   * exactly as this does. Every caller asserts the outcome, so a genuinely
   * unclickable gutter still fails.
   */
  await marginRow(lineNumber).click({ position: { x: 6, y: 8 }, force: true })
}

const breakpointDots = () => window.locator('.monaco-editor .cgmr.bcc-breakpoint')
const debugStatus = () => window.locator('#debug-status')
const debugOutput = () => window.locator('#debug-output')

/** A local's rendered value in the innermost frame, by name. */
function localValue(name: string) {
  return window.locator(`#debug-locals .debug-variable[data-name="${name}"] .debug-variable__value`)
}

async function press(button: string): Promise<void> {
  await window.locator(`#debug-${button}`).click()
}

/* -------------------------------------------------------------------------- */
/*  The tests                                                                  */
/* -------------------------------------------------------------------------- */

test('opens the file and the daemon finds nothing wrong with it', async () => {
  await treeRow('examples').click()
  await treeRow('count.bcc').click()

  await expect(window.locator('.tab', { hasText: 'count.bcc' })).toHaveCount(1)
  await expect(lines()).toContainText('while i < 5 {', { timeout: DAEMON_TIMEOUT })
  await expect(window.locator('.monaco-editor .squiggly-error')).toHaveCount(0, {
    timeout: DAEMON_TIMEOUT
  })
})

test('clicking the gutter sets a breakpoint', async () => {
  // The glyph margin is on for the first time in this project. If it were off,
  // there would be nothing at this x to click and the assertion below would
  // find no dot — which is the failure this is really guarding.
  await clickGutter(BREAKPOINT_LINE)
  await expect(breakpointDots()).toHaveCount(1)
})

/**
 * The plan's first debugger E2E, in one test because it is one story: set a
 * breakpoint, run, hit it at the right line, inspect a local, step, continue to
 * exit.
 */
test('runs to the breakpoint, inspects a local, steps, and continues to exit', async () => {
  await window.keyboard.press('F5')

  await expect(debugStatus()).toContainText(`breakpoint at line ${BREAKPOINT_LINE}`, {
    timeout: DAEMON_TIMEOUT
  })

  // First time round the loop, before the body has run.
  await expect(localValue('i')).toHaveText('0')
  await expect(localValue('total')).toHaveText('0')

  // The stack is one frame, and it is the module's.
  await expect(window.locator('#debug-stack .debug-frame')).toHaveCount(1)
  await expect(window.locator('#debug-stack .debug-frame__name')).toHaveText('<main>')

  // Nothing has printed yet: the `print` is after the loop.
  await expect(debugOutput()).toHaveText('')

  await press('stepOver')
  // `total = total + i` has run, so `total` is 0 + 0 and the machine has moved
  // off the breakpoint line onto `i = i + 1;`.
  await expect(debugStatus()).toContainText('step at line 8')

  /*
   * F5 again does nothing, which is the point.
   *
   * The Debug button is disabled while a session is live, but F5 is bound on
   * the document and had no such gate — a second press started a second worker
   * that the panel stopped following the instant it did.
   *
   * It matters WHERE this is asserted. The first version pressed F5 at the
   * first breakpoint arrival and checked the state was still `i = 0` on line 7
   * — which is exactly what a fresh session would also show, so removing the
   * guard left it green and it proved nothing. Asserted here, after a step, the
   * two are finally distinguishable: a second session would be back on line 7,
   * and staying on line 8 is what says the first one is still the one running.
   */
  await window.keyboard.press('F5')
  await expect(debugStatus()).toContainText('step at line 8')

  await press('continue')
  await expect(debugStatus()).toContainText(`breakpoint at line ${BREAKPOINT_LINE}`)
  await expect(localValue('i')).toHaveText('1')

  // Clear the breakpoint, then run out. 0+1+2+3+4.
  await clickGutter(BREAKPOINT_LINE)
  await expect(breakpointDots()).toHaveCount(0)

  await press('continue')
  await expect(debugStatus()).toContainText('exited')
  await expect(debugOutput()).toHaveText('10\n')
})

/**
 * The plan's second debugger E2E, and the capability the whole VM was built
 * for: step BACKWARDS over a loop iteration and watch a local hold its earlier
 * value.
 *
 * This is not a re-run. The VM undoes the writes it recorded, which is why the
 * value that comes back is the one from the previous iteration rather than a
 * recomputed guess — and why it works from the END of the program, where a
 * re-run would have nothing left to replay towards.
 */
test('steps backwards over a loop iteration and the local holds its earlier value', async () => {
  await press('stop')
  await expect(debugStatus()).toContainText('Session ended')

  await clickGutter(BREAKPOINT_LINE)
  await expect(breakpointDots()).toHaveCount(1)

  await window.keyboard.press('F5')
  await expect(debugStatus()).toContainText(`breakpoint at line ${BREAKPOINT_LINE}`, {
    timeout: DAEMON_TIMEOUT
  })

  // Forwards to the third arrival: i is 2 and total has taken 0 and 1.
  await press('continue')
  await press('continue')
  await expect(localValue('i')).toHaveText('2')
  await expect(localValue('total')).toHaveText('1')

  // Backwards to the second. Three steps back is the loop's own shape — body,
  // increment, header — measured rather than assumed.
  await press('stepBack')
  await press('stepBack')
  await press('stepBack')

  await expect(debugStatus()).toContainText(`at line ${BREAKPOINT_LINE}`)
  await expect(localValue('i'), 'i is one iteration younger').toHaveText('1')
  await expect(localValue('total'), 'and total has un-accumulated').toHaveText('0')
})

test('the whole session ran without a console error', async () => {
  // Same check every spec in this suite ends with. A debugger that works while
  // throwing in the renderer is one bad state change away from not working.
  expect(consoleProblems).toEqual([])
})
