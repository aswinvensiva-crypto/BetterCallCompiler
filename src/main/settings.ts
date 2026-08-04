import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { settingsSchema, type Settings } from '../shared/types'

/**
 * Non-secret preferences, in `app.getPath('userData')`.
 *
 * Secrets live in `secrets.ts` and never appear here — the split is deliberate,
 * so this file can be read, backed up and diffed freely without the risk of
 * carrying an API key along with it.
 */

const DEFAULTS: Settings = {
  aiModel: 'claude-sonnet-5',
  githubUser: '',
  telemetry: false,
  /**
   * Mirrors the metrics block in theme.css, which is where these sizes are
   * actually decided; the renderer seeds itself from the stylesheet and only
   * falls back to what it reads here. `rightDockHidden` starts true because the
   * dock is 460px of editor width and an IDE should not open holding a tool
   * window nobody asked for.
   *
   * A settings.json written before this key existed is missing it entirely, and
   * the shallow `{ ...DEFAULTS, ...data }` merge in `loadSettings` supplies this
   * whole object for it — nested defaults only go wrong when an old file has a
   * *partial* version of the key, which cannot happen for one introduced whole.
   */
  workbenchLayout: {
    sideBarWidth: 260,
    rightDockWidth: 460,
    panelHeight: 280,
    sideBarHidden: false,
    rightDockHidden: true
  }
}

let cache: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Reads and validates, falling back to defaults per-field.
 *
 * `partial()` rather than the full schema: a settings file written by an older
 * build is missing keys a newer one expects, and rejecting the whole file for
 * that would silently reset every preference the user had set.
 */
export async function loadSettings(): Promise<Settings> {
  if (cache !== null) return cache

  let parsed: unknown
  try {
    parsed = JSON.parse(await fsp.readFile(settingsPath(), 'utf8'))
  } catch {
    cache = { ...DEFAULTS }
    return cache
  }

  const partial = settingsSchema.partial().safeParse(parsed)
  cache = partial.success ? { ...DEFAULTS, ...stripUndefined(partial.data) } : { ...DEFAULTS }
  return cache
}

function stripUndefined(value: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<Settings>
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = settingsSchema.parse({ ...current, ...stripUndefined(patch) })

  const path = settingsPath()
  await fsp.mkdir(dirname(path), { recursive: true })
  await fsp.writeFile(path, JSON.stringify(next, null, 2), 'utf8')

  cache = next
  return next
}

/** Test hook. */
export function resetSettingsForTests(): void {
  cache = null
}

export { DEFAULTS as DEFAULT_SETTINGS }
