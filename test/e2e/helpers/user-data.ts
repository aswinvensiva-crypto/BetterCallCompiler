import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Gives a spec file its own Electron user-data directory.
 *
 * Without this every spec shares the developer's real profile, so anything the
 * app persists leaks from one spec into the next — and, worse, out of the suite
 * and into the machine. That was harmless while nothing but an API key lived
 * there. It stopped being harmless once the workbench began remembering its
 * layout: opening the Visualizer in one spec wrote `rightDockHidden: false`,
 * and the next spec launched 460px narrower, wrapped its terminal output and
 * failed on a line that had scrolled out of view. The failure looked like a
 * console bug and was really a test-isolation bug, which is the expensive kind.
 *
 * The directory is derived from the spec name rather than randomised, and wiped
 * on the way in rather than the way out: a run that crashes still leaves the
 * next one a clean profile, and nothing accumulates in the temp directory.
 */
export function isolatedUserData(specName: string): string {
  const dir = join(tmpdir(), 'bcc-e2e-user-data', specName)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // A Chromium switch, read from argv long before the app's own `--folder=`
  // parsing in main/index.ts, which ignores anything it does not recognise.
  return `--user-data-dir=${dir}`
}
