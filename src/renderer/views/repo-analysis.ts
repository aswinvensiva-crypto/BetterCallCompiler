import type { LanguageStat } from '../../shared/types'

/**
 * Pure analysis behind the Insights view's locally-computed sections.
 *
 * No IPC, no DOM, no Monaco — the caller fetches, this decides. Kept separate
 * from `insights.ts` for the same reason `code-context.ts` is separate from the
 * AI view: the interesting logic is the part worth testing, and it should not
 * need an Electron window to run.
 */

export interface HealthCheck {
  readonly id: string
  readonly label: string
  readonly passed: boolean
  /** Shown next to the row — why it passed, or what to do about it. */
  readonly detail: string
}

export interface HealthInput {
  /** POSIX-separated paths relative to the workspace root. */
  readonly paths: readonly string[]
  /** Contents of README.*, or null when there is none. */
  readonly readme: string | null
  /** Contents of package.json, or null when there is none. */
  readonly packageJson: string | null
}

/** A README this short is a placeholder, not documentation. */
const MIN_README_CHARS = 300

function hasFile(paths: readonly string[], predicate: (name: string) => boolean): string | null {
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (predicate(name.toLowerCase())) return path
  }
  return null
}

/**
 * The checklist is deliberately about things a repository either has or does
 * not have, checkable offline. No scores, no grades — each row states a fact
 * and, when it fails, the specific thing that would fix it.
 */
export function evaluateRepoHealth(input: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = []

  const readmePath = hasFile(input.paths, (name) => name.startsWith('readme'))
  const readmeLength = input.readme?.trim().length ?? 0
  checks.push({
    id: 'readme',
    label: 'README',
    passed: readmePath !== null && readmeLength >= MIN_README_CHARS,
    detail:
      readmePath === null
        ? 'No README found'
        : readmeLength >= MIN_README_CHARS
          ? `${readmeLength.toLocaleString()} characters`
          : `Only ${readmeLength} characters — too short to orient a newcomer`
  })

  const licensePath = hasFile(
    input.paths,
    (name) => name === 'license' || name.startsWith('license.') || name.startsWith('licence')
  )
  checks.push({
    id: 'license',
    label: 'LICENSE',
    passed: licensePath !== null,
    detail: licensePath ?? 'No LICENSE file — the default is "all rights reserved"'
  })

  const gitignorePath = hasFile(input.paths, (name) => name === '.gitignore')
  checks.push({
    id: 'gitignore',
    label: '.gitignore',
    passed: gitignorePath !== null,
    detail: gitignorePath ?? 'No .gitignore — build output risks being committed'
  })

  checks.push(evaluateTestScript(input.packageJson))

  // Both spellings GitHub accepts.
  const workflow = input.paths.find(
    (path) =>
      (path.startsWith('.github/workflows/') || path.startsWith('.github\\workflows\\')) &&
      /\.ya?ml$/i.test(path)
  )
  checks.push({
    id: 'ci',
    label: 'CI workflow',
    passed: workflow !== undefined,
    detail: workflow ?? 'Nothing under .github/workflows — no automated checks on push'
  })

  return checks
}

/**
 * A `test` script that is npm's own placeholder counts as absent: `npm init`
 * writes one that exits 1, and treating that as "has tests" is exactly the
 * false pass this checklist exists to avoid.
 */
function evaluateTestScript(packageJson: string | null): HealthCheck {
  if (packageJson === null) {
    return {
      id: 'test-script',
      label: 'Test script',
      passed: false,
      detail: 'No package.json'
    }
  }

  let scripts: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(packageJson)
    if (typeof parsed === 'object' && parsed !== null && 'scripts' in parsed) {
      const candidate = (parsed as { scripts?: unknown }).scripts
      if (typeof candidate === 'object' && candidate !== null) {
        scripts = candidate as Record<string, unknown>
      }
    }
  } catch {
    return {
      id: 'test-script',
      label: 'Test script',
      passed: false,
      detail: 'package.json is not valid JSON'
    }
  }

  const test = scripts['test']
  if (typeof test !== 'string' || test.trim() === '') {
    return { id: 'test-script', label: 'Test script', passed: false, detail: 'No "test" script' }
  }
  if (/no test specified/i.test(test)) {
    return {
      id: 'test-script',
      label: 'Test script',
      passed: false,
      detail: 'Still npm\'s placeholder "no test specified" script'
    }
  }
  return { id: 'test-script', label: 'Test script', passed: true, detail: test }
}

export interface LanguageSlice extends LanguageStat {
  /** 0–100, rounded to one decimal. */
  readonly percent: number
}

/**
 * Adds a percentage to each language. Returns [] for an empty or zero-byte
 * workspace rather than dividing by zero and producing NaN bars.
 */
export function toLanguageSlices(
  languages: readonly LanguageStat[],
  totalBytes: number
): LanguageSlice[] {
  if (totalBytes <= 0) return []
  return languages.map((entry) => ({
    ...entry,
    percent: Math.round((entry.bytes / totalBytes) * 1000) / 10
  }))
}

/** Stable colour per language so the bar does not reshuffle between renders. */
const LANGUAGE_COLOURS: Readonly<Record<string, string>> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Go: '#00add8',
  Rust: '#dea584',
  Java: '#b07219',
  Ruby: '#701516',
  PHP: '#4f5d95',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  JSON: '#8a8f98',
  YAML: '#cb171e',
  Markdown: '#6aab73',
  Shell: '#89e051',
  PowerShell: '#012456',
  SQL: '#e38c00',
  Terraform: '#7b42bc',
  Dockerfile: '#384d54'
}

const FALLBACK_COLOURS = ['#3574f0', '#6aab73', '#cf8e6d', '#c77dbb', '#2aacb8', '#d9a343']

export function colourForLanguage(language: string, index: number): string {
  return (
    LANGUAGE_COLOURS[language] ??
    FALLBACK_COLOURS[index % FALLBACK_COLOURS.length] ??
    '#6f737a'
  )
}

/** 1.2 kB / 3.4 MB — bytes are meaningless to read at repository scale. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
