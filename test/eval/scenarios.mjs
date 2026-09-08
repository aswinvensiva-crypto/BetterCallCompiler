/**
 * Coding scenarios for the agent evaluation harness.
 *
 * Each scenario is a real (small) coding task: an instruction plus the files
 * it starts from. `check` inspects the FILES THE PROVIDER PRODUCED — never
 * the prose around them — because the plan's whole point is verifying that a
 * prompt change still produces working code, not that it still produces
 * particular sentences. A prompt-text assertion breaks on every rewording
 * that changes nothing about the output; a behavioural check does not.
 *
 * `stubAnswer` is the canned response the harness's default, offline mode
 * plays back instead of calling a model. It is written in the exact
 * `### FILE: <path>` format `ai-service.ts`'s agent system prompt asks for,
 * so the offline run exercises the real parsing and checking path end to
 * end — only the network call is faked, and it is a CORRECT stub, so a
 * regression in parsing or checking (not in the model) still fails the run.
 */

export const SCENARIOS = [
  {
    id: 'rename-function-and-call-site',
    instruction: 'Rename the function parseConfig to loadConfig and update its call site.',
    files: [
      {
        path: 'src/config.ts',
        before: 'export function parseConfig(path: string): string {\n  return path\n}\n'
      },
      {
        path: 'src/main.ts',
        before: "import { parseConfig } from './config'\n\nconsole.log(parseConfig('a.json'))\n"
      }
    ],
    stubAnswer:
      'Renamed parseConfig to loadConfig and updated its one call site.\n\n' +
      '### FILE: src/config.ts\n' +
      '```ts\n' +
      'export function loadConfig(path: string): string {\n  return path\n}\n' +
      '```\n' +
      '### FILE: src/main.ts\n' +
      '```ts\n' +
      "import { loadConfig } from './config'\n\nconsole.log(loadConfig('a.json'))\n" +
      '```\n',
    check(files) {
      const config = files.get('src/config.ts') ?? ''
      const main = files.get('src/main.ts') ?? ''
      if (config.includes('parseConfig')) return fail('src/config.ts still names parseConfig')
      if (!config.includes('loadConfig')) return fail('src/config.ts does not define loadConfig')
      if (main.includes('parseConfig')) return fail('src/main.ts still calls parseConfig')
      if (!main.includes('loadConfig')) return fail('src/main.ts does not call loadConfig')
      return pass()
    }
  },

  {
    id: 'add-null-guard',
    instruction: 'Add a guard that returns early when `user` is null, before it is dereferenced.',
    files: [
      {
        path: 'src/greet.ts',
        before: 'export function greetName(user: { name: string } | null): string {\n  return `hi ${user.name}`\n}\n'
      }
    ],
    stubAnswer:
      'Added an early return for a null user.\n\n' +
      '### FILE: src/greet.ts\n' +
      '```ts\n' +
      'export function greetName(user: { name: string } | null): string {\n' +
      "  if (user === null) return ''\n" +
      '  return `hi ${user.name}`\n' +
      '}\n' +
      '```\n',
    check(files) {
      const content = files.get('src/greet.ts') ?? ''
      if (!/if\s*\(\s*user\s*===?\s*null\s*\)/.test(content)) {
        return fail('no null guard on `user` before it is dereferenced')
      }
      // The guard has to come before the dereference, not after it, or it
      // guards nothing.
      const guardIndex = content.search(/if\s*\(\s*user\s*===?\s*null\s*\)/)
      const dereferenceIndex = content.indexOf('user.name')
      if (dereferenceIndex !== -1 && guardIndex > dereferenceIndex) {
        return fail('the guard appears after `user.name` is already dereferenced')
      }
      return pass()
    }
  },

  {
    id: 'extract-shared-constant',
    instruction: 'Both files hardcode the retry limit 3. Extract it to a shared constant RETRY_LIMIT in retry.ts and import it in both.',
    files: [
      {
        path: 'src/retry.ts',
        before: 'export function shouldRetry(attempt: number): boolean {\n  return attempt < 3\n}\n'
      },
      {
        path: 'src/upload.ts',
        before: 'export function uploadAttempts(): number {\n  return 3\n}\n'
      }
    ],
    stubAnswer:
      'Extracted the retry limit into a shared constant.\n\n' +
      '### FILE: src/retry.ts\n' +
      '```ts\n' +
      'export const RETRY_LIMIT = 3\n\n' +
      'export function shouldRetry(attempt: number): boolean {\n  return attempt < RETRY_LIMIT\n}\n' +
      '```\n' +
      '### FILE: src/upload.ts\n' +
      '```ts\n' +
      "import { RETRY_LIMIT } from './retry'\n\n" +
      'export function uploadAttempts(): number {\n  return RETRY_LIMIT\n}\n' +
      '```\n',
    check(files) {
      const retry = files.get('src/retry.ts') ?? ''
      const upload = files.get('src/upload.ts') ?? ''
      if (!/export\s+const\s+RETRY_LIMIT/.test(retry)) return fail('src/retry.ts does not export RETRY_LIMIT')
      if (!upload.includes('RETRY_LIMIT')) return fail('src/upload.ts does not use RETRY_LIMIT')
      if (!/import\s*\{\s*RETRY_LIMIT\s*\}\s*from\s*['"]\.\/retry['"]/.test(upload)) {
        return fail('src/upload.ts does not import RETRY_LIMIT from ./retry')
      }
      return pass()
    }
  }
]

function pass() {
  return { ok: true, reason: null }
}

function fail(reason) {
  return { ok: false, reason }
}
