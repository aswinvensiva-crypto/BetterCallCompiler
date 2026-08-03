/**
 * Static analysis behind the Assist feature.
 *
 * Deliberately pure: no Monaco import, no IPC, no network, no model. Every
 * answer here is deterministic and derived from the selected text alone, which
 * is what separates Assist from the AI Assistant living next to it — that one
 * asks Claude, this one never leaves the machine. Same reason `code-context.ts`
 * is pure: the interesting logic should be testable without an Electron window.
 *
 * Scope limit, stated honestly: the Learn glossary covers JS/TS/Python/C/C++ —
 * the languages `toolchains.ts` and `runner.ts` already target. Debug, Explain
 * and Snippet are language-agnostic and work on anything.
 */

export type AssistMode = 'learn' | 'debug' | 'explain' | 'snippet'

export interface AssistSelection {
  readonly text: string
  readonly languageId: string
  /** 1-based, matching Monaco and every compiler diagnostic. */
  readonly startLine: number
  readonly endLine: number
  /** Workspace-relative, POSIX-separated. */
  readonly relativePath: string
}

/* ------------------------------- Learn ---------------------------------- */

export interface Concept {
  readonly id: string
  readonly title: string
  /** What it does, in one sentence. */
  readonly summary: string
  /** The part that actually bites people. Never omitted. */
  readonly gotcha: string
}

interface ConceptRule extends Concept {
  readonly languages: readonly string[] | 'any'
  readonly pattern: RegExp
}

/**
 * The glossary. Each entry carries a real gotcha rather than a definition —
 * a restatement of what `async` means helps nobody; knowing that an `await`
 * inside a loop serialises the requests does.
 */
const CONCEPTS: readonly ConceptRule[] = [
  {
    id: 'async-await',
    title: 'async / await',
    languages: ['javascript', 'typescript'],
    pattern: /\basync\b|\bawait\b/,
    summary: 'Suspends the function until a promise settles, without blocking the thread.',
    gotcha:
      'await inside a loop runs the requests one after another. Collect the promises and Promise.all them when the iterations are independent.'
  },
  {
    id: 'promise-all',
    title: 'Promise.all',
    languages: ['javascript', 'typescript'],
    pattern: /Promise\s*\.\s*all\b/,
    summary: 'Runs promises concurrently and resolves once all of them do.',
    gotcha:
      'It rejects as soon as any one input rejects, and the rest keep running unobserved. Promise.allSettled is what you want when partial success is acceptable.'
  },
  {
    id: 'closure',
    title: 'Closure',
    languages: ['javascript', 'typescript'],
    pattern: /(function\s*\([^)]*\)\s*\{|=>\s*\{?)/,
    summary: 'An inner function keeps access to the variables it was defined alongside.',
    gotcha:
      'The closure captures the variable, not its value at capture time. A `var` in a loop leaves every closure sharing one binding — `let` gives each iteration its own.'
  },
  {
    id: 'destructuring',
    title: 'Destructuring',
    languages: ['javascript', 'typescript'],
    pattern: /(const|let|var)\s*[[{][^=;]*[\]}]\s*=/,
    summary: 'Pulls properties or elements out of an object or array in one binding.',
    gotcha:
      'Destructuring null or undefined throws. A default only applies when the value is undefined — null passes straight through it.'
  },
  {
    id: 'optional-chaining',
    title: 'Optional chaining',
    languages: ['javascript', 'typescript'],
    pattern: /\?\./,
    summary: 'Short-circuits to undefined instead of throwing when the left side is nullish.',
    gotcha:
      'It only guards the link it is attached to. `a?.b.c` still throws when `b` is undefined — the guard has to be on every hop that can be missing.'
  },
  {
    id: 'ts-any',
    title: 'The any type',
    languages: ['typescript'],
    pattern: /:\s*any\b|\bas\s+any\b/,
    summary: 'Opts a value out of type checking entirely.',
    gotcha:
      'any is contagious — every expression derived from it is unchecked too. `unknown` gives the same escape hatch but forces a narrowing before use.'
  },
  {
    id: 'ts-non-null',
    title: 'Non-null assertion',
    languages: ['typescript'],
    pattern: /!\s*[.;)\]]/,
    summary: 'Tells the compiler a value is not null or undefined.',
    gotcha:
      'It is erased at build time and checks nothing at runtime. If the assertion is wrong you get a TypeError at the use site, with no hint that an assertion caused it.'
  },
  {
    id: 'py-comprehension',
    title: 'Comprehension',
    languages: ['python'],
    pattern: /\[[^\]]*\bfor\b[^\]]*\]|\{[^}]*\bfor\b[^}]*\}/,
    summary: 'Builds a list, set or dict in a single expression.',
    gotcha:
      'It materialises the whole result in memory. A generator expression — the same thing in round brackets — streams instead, which matters on large inputs.'
  },
  {
    id: 'py-mutable-default',
    title: 'Mutable default argument',
    languages: ['python'],
    pattern: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/,
    summary: 'A default argument whose value is a list or dict.',
    gotcha:
      'The default is evaluated once at definition time, so every call shares the same object and mutations persist between calls. Use None and build inside the body.'
  },
  {
    id: 'py-with',
    title: 'with statement',
    languages: ['python'],
    pattern: /\bwith\s+.+\s+as\s+\w+\s*:/,
    summary: 'Acquires a resource and releases it when the block exits.',
    gotcha:
      'The release runs even on an exception, which is the point — but only for what the context manager owns. Objects created inside the block are not cleaned up by it.'
  },
  {
    id: 'c-malloc',
    title: 'Manual allocation',
    languages: ['c', 'cpp'],
    pattern: /\b(malloc|calloc|realloc)\s*\(/,
    summary: 'Reserves heap memory that the caller owns.',
    gotcha:
      'Every path out of the function has to free it, including early returns and error branches. realloc returning NULL leaves the original block allocated — assigning its result straight back to the same pointer leaks it.'
  },
  {
    id: 'c-pointer',
    title: 'Pointer dereference',
    languages: ['c', 'cpp'],
    pattern: /\*\s*\w+\s*=|->/,
    summary: 'Reads or writes the value a pointer refers to.',
    gotcha:
      'Dereferencing NULL or a freed pointer is undefined behaviour, not a guaranteed crash — it may appear to work until an unrelated change moves the memory.'
  },
  {
    id: 'cpp-raii',
    title: 'RAII / smart pointers',
    languages: ['cpp'],
    pattern: /\b(unique_ptr|shared_ptr|make_unique|make_shared)\b/,
    summary: 'Ties a resource lifetime to an object lifetime, so cleanup is automatic.',
    gotcha:
      'shared_ptr cycles never reach zero and leak silently. Break the cycle with weak_ptr on the back-reference.'
  },
  {
    id: 'regex',
    title: 'Regular expression',
    languages: 'any',
    pattern: /\/(?![/*])(?:[^/\\\n]|\\.)+\/[gimsuy]*|\bre\.(compile|match|search)\b/,
    summary: 'Matches text against a pattern.',
    gotcha:
      'A JavaScript regex with the /g flag keeps lastIndex between calls, so reusing one object across .test() calls alternates between true and false on identical input.'
  },
  {
    id: 'recursion',
    title: 'Recursion',
    languages: 'any',
    pattern: /\b(function|def)\s+(\w+)[\s\S]*\b\2\s*\(/,
    summary: 'A function that calls itself.',
    gotcha:
      'Neither JavaScript nor Python eliminates tail calls, so depth is bounded by the stack. Deep recursion needs an explicit stack or an iterative rewrite.'
  }
]

export function detectConcepts(selection: AssistSelection): Concept[] {
  const language = selection.languageId.toLowerCase()
  const found: Concept[] = []

  for (const rule of CONCEPTS) {
    if (rule.languages !== 'any' && !rule.languages.includes(language)) continue
    if (!rule.pattern.test(selection.text)) continue
    found.push({ id: rule.id, title: rule.title, summary: rule.summary, gotcha: rule.gotcha })
  }
  return found
}

/* ------------------------------- Debug ---------------------------------- */

export interface CodeMetrics {
  readonly lines: number
  /** Non-blank, non-comment lines. */
  readonly sloc: number
  /** Deepest brace/indent nesting reached. */
  readonly maxNesting: number
  /**
   * Cyclomatic complexity: one, plus one per branch point. The standard
   * approximation — good enough to flag a function that needs splitting,
   * not a substitute for a real control-flow graph.
   */
  readonly complexity: number
}

export interface Finding {
  readonly id: string
  readonly severity: 'warning' | 'info'
  readonly message: string
  /** 1-based absolute line in the file, not an offset into the selection. */
  readonly line: number
}

const BRANCH_PATTERN =
  /\b(if|else\s+if|elif|for|while|case|catch|except|&&|\|\||\?\?)\b|\?[^.:]/g

export function computeMetrics(text: string): CodeMetrics {
  const lines = text.split('\n')
  let sloc = 0
  let depth = 0
  let maxNesting = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (/^(\/\/|#|\*|\/\*)/.test(line)) continue
    sloc++

    // Closing braces on this line reduce depth before it is sampled, so a
    // lone `}` does not read as another level of nesting.
    const closers = (line.match(/[}\])]/g) ?? []).length
    const openers = (line.match(/[{[(]/g) ?? []).length
    depth += openers - closers
    if (depth > maxNesting) maxNesting = depth
  }

  const branches = (text.match(BRANCH_PATTERN) ?? []).length

  return {
    lines: lines.length,
    sloc,
    maxNesting: Math.max(0, maxNesting),
    complexity: branches + 1
  }
}

interface IssueRule {
  readonly id: string
  readonly severity: 'warning' | 'info'
  readonly message: string
  readonly pattern: RegExp
}

/**
 * Pattern-based findings only — v1 ships no execution, as agreed. Each rule is
 * something that is nearly always a defect, not a style preference; a linter
 * that cries wolf gets switched off.
 */
const ISSUE_RULES: readonly IssueRule[] = [
  {
    id: 'empty-catch',
    severity: 'warning',
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    message: 'Empty catch block swallows the error silently — log it or rethrow.'
  },
  {
    id: 'bare-except',
    severity: 'warning',
    pattern: /except\s*:/,
    message: 'Bare `except:` also catches KeyboardInterrupt and SystemExit. Catch Exception instead.'
  },
  {
    id: 'loose-equality',
    severity: 'warning',
    pattern: /[^=!<>]==[^=]|[^!]!=[^=]/,
    message: 'Loose equality coerces types (`0 == ""` is true). Prefer === / !==.'
  },
  {
    id: 'assignment-in-condition',
    severity: 'warning',
    pattern: /(if|while)\s*\(\s*[\w.]+\s*=[^=]/,
    message: 'Assignment inside a condition — `=` where `==` or `===` was probably meant.'
  },
  {
    id: 'off-by-one',
    severity: 'info',
    pattern: /<=\s*\w+\.length|<=\s*len\s*\(/,
    message: '`<= length` runs one past the last index. `<` is almost always what is meant.'
  },
  {
    id: 'switch-fallthrough',
    severity: 'warning',
    pattern: /case\s+[^:]+:(?:(?!break|return|throw|case|\}).)*case\s/s,
    message: 'A case appears to fall through without break/return — intentional or not, say so.'
  },
  {
    id: 'console-left-in',
    severity: 'info',
    pattern: /console\s*\.\s*log\s*\(|\bprint\s*\(/,
    message: 'Debug output left in the selection.'
  },
  {
    id: 'todo',
    severity: 'info',
    pattern: /\b(TODO|FIXME|XXX|HACK)\b/,
    message: 'Unresolved TODO/FIXME marker.'
  },
  {
    id: 'float-equality',
    severity: 'warning',
    pattern: /[\w.]+\s*===?\s*\d+\.\d+|\d+\.\d+\s*===?\s*[\w.]+/,
    message: 'Comparing floating-point values exactly — compare against a tolerance instead.'
  },
  {
    id: 'await-in-loop',
    severity: 'info',
    pattern: /\b(for|while)\b[^{]*\{[^}]*\bawait\b/s,
    message: 'await inside a loop serialises the iterations. Promise.all them if they are independent.'
  }
]

/** Deep nesting is the strongest single predictor of a function being hard to change. */
const NESTING_LIMIT = 4
const COMPLEXITY_LIMIT = 10

export function findIssues(selection: AssistSelection): Finding[] {
  const findings: Finding[] = []
  const lines = selection.text.split('\n')

  for (const rule of ISSUE_RULES) {
    // Located per line so the finding points at somewhere real, then mapped
    // back to the file's absolute numbering.
    let matchedLine = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const single = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''))
      if (single.test(line)) {
        matchedLine = i
        break
      }
    }
    // Multi-line rules (fallthrough, await-in-loop) will not match any single
    // line; fall back to testing the whole selection and anchor at its start.
    if (matchedLine < 0) {
      const whole = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''))
      if (!whole.test(selection.text)) continue
      matchedLine = 0
    }

    findings.push({
      id: rule.id,
      severity: rule.severity,
      message: rule.message,
      line: selection.startLine + matchedLine
    })
  }

  const metrics = computeMetrics(selection.text)
  if (metrics.maxNesting > NESTING_LIMIT) {
    findings.push({
      id: 'deep-nesting',
      severity: 'warning',
      message: `Nested ${metrics.maxNesting} levels deep — an early return or a helper would flatten it.`,
      line: selection.startLine
    })
  }
  if (metrics.complexity > COMPLEXITY_LIMIT) {
    findings.push({
      id: 'high-complexity',
      severity: 'warning',
      message: `Cyclomatic complexity ${metrics.complexity} — this needs ${metrics.complexity} tests to cover every path.`,
      line: selection.startLine
    })
  }

  return findings
}

/* ------------------------------ Explain --------------------------------- */

export interface Explanation {
  /** Symbols the selection introduces. */
  readonly declares: string[]
  /** External symbols it uses but does not define. */
  readonly dependsOn: string[]
  /** Suggested reading order, most-dependent-upon first. */
  readonly readingOrder: string[]
}

const DECLARATION_PATTERNS: readonly RegExp[] = [
  /\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
  /\b(?:export\s+)?class\s+(\w+)/g,
  /\b(?:export\s+)?(?:interface|type|enum)\s+(\w+)/g,
  /\bdef\s+(\w+)/g,
  /\bstruct\s+(\w+)/g
]

/** Reserved words and built-ins that are never a meaningful dependency. */
const NOT_A_DEPENDENCY = new Set([
  'if', 'else', 'for', 'while', 'return', 'function', 'const', 'let', 'var', 'class', 'new',
  'this', 'typeof', 'instanceof', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break',
  'continue', 'default', 'do', 'in', 'of', 'await', 'async', 'yield', 'import', 'export', 'from',
  'as', 'extends', 'implements', 'interface', 'type', 'enum', 'public', 'private', 'protected',
  'static', 'readonly', 'true', 'false', 'null', 'undefined', 'void', 'delete', 'and', 'or',
  'not', 'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'self', 'None', 'True', 'False',
  'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'len', 'range', 'print',
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Error'
])

export function explain(selection: AssistSelection): Explanation {
  const declares = new Set<string>()
  for (const pattern of DECLARATION_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(selection.text)) !== null) {
      if (match[1] !== undefined) declares.add(match[1])
    }
  }

  // A dependency is a called or property-accessed identifier the selection does
  // not itself declare. Bare identifiers are excluded deliberately: locals and
  // parameters would swamp the list and none of them are dependencies.
  const dependsOn = new Set<string>()
  const usage = /\b([A-Za-z_$][\w$]*)\s*(?=\(|\.)/g
  let used: RegExpExecArray | null
  while ((used = usage.exec(selection.text)) !== null) {
    const name = used[1]
    if (name === undefined) continue
    if (declares.has(name) || NOT_A_DEPENDENCY.has(name)) continue
    dependsOn.add(name)
  }

  const readingOrder = [...declares].sort((a, b) => {
    const usesOfA = countOccurrences(selection.text, a)
    const usesOfB = countOccurrences(selection.text, b)
    return usesOfB - usesOfA
  })

  return {
    declares: [...declares],
    dependsOn: [...dependsOn].sort(),
    readingOrder
  }
}

function countOccurrences(haystack: string, needle: string): number {
  return (haystack.match(new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'g')) ?? []).length
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ------------------------------ Snippet --------------------------------- */

export interface SnippetOptions {
  /** From `git-service.originRepository()`; null when there is no remote. */
  readonly repository: { owner: string; repo: string } | null
  readonly branch: string | null
}

export interface Snippet {
  readonly markdown: string
  /**
   * A real, resolvable blob permalink — or null when the repository has no
   * remote. Never a fabricated URL: an unresolvable link is worse than none.
   */
  readonly permalink: string | null
}

/** Extension to the fence tag GitHub understands. */
const FENCE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'python',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  go: 'go',
  rust: 'rust',
  java: 'java',
  shell: 'bash',
  powershell: 'powershell',
  json: 'json',
  yaml: 'yaml',
  html: 'html',
  css: 'css',
  markdown: 'markdown'
}

export function buildSnippet(selection: AssistSelection, options: SnippetOptions): Snippet {
  const fence = FENCE_BY_LANGUAGE[selection.languageId.toLowerCase()] ?? ''
  const range =
    selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}-L${selection.endLine}`

  const reference = `${selection.relativePath}:${range}`

  const permalink =
    options.repository === null || options.branch === null
      ? null
      : `https://github.com/${options.repository.owner}/${options.repository.repo}/blob/${encodeURIComponent(
          options.branch
        )}/${selection.relativePath
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}#${range}`

  const markdown = [
    permalink === null ? `\`${reference}\`` : `[\`${reference}\`](${permalink})`,
    '',
    '```' + fence,
    selection.text.replace(/\s+$/, ''),
    '```'
  ].join('\n')

  return { markdown, permalink }
}
