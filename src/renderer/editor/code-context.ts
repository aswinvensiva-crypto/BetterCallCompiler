/**
 * Pure context assembly for the AI actions.
 *
 * Kept free of any Monaco import so it can be unit tested in plain Node — the
 * prompt the model receives is the product, and a function that can only be
 * exercised inside a running editor is one nobody checks.
 */

export interface EnclosingSymbol {
  readonly name: string
  readonly kind: string
  /** 1-based, inclusive. */
  readonly startLine: number
  readonly endLine: number
}

/* ------------------------------------------------------------------ *
 * Imports
 * ------------------------------------------------------------------ */

const IMPORT_PATTERNS: Readonly<Record<string, RegExp>> = {
  typescript: /^\s*(?:import\b|export\s+(?:\*|\{)[\s\S]*?\bfrom\b)/,
  javascript: /^\s*(?:import\b|(?:const|let|var)\s+.*=\s*require\()/,
  python: /^\s*(?:import\s+\w|from\s+[\w.]+\s+import\b)/,
  c: /^\s*#\s*include\b/,
  cpp: /^\s*#\s*include\b/,
  csharp: /^\s*using\s+[\w.]+\s*;/,
  go: /^\s*(?:import\b|\t"[^"]+"\s*$)/,
  rust: /^\s*(?:use|extern\s+crate)\b/,
  java: /^\s*import\b/,
  ruby: /^\s*require(?:_relative)?\b/,
  php: /^\s*(?:use|require|include)(?:_once)?\b/
}

/** Never send hundreds of lines of imports; they crowd out the selection. */
const MAX_IMPORTS = 40

/**
 * Import lines, matched textually.
 *
 * Deliberately not a resolved import graph: that needs a language server per
 * language, which is M4. What actually helps the model is knowing which names
 * are in scope, and the raw lines convey that.
 */
export function collectImports(source: string, languageId: string): string[] {
  const pattern = IMPORT_PATTERNS[normaliseLanguage(languageId)]
  if (pattern === undefined) return []

  const found: string[] = []
  for (const line of source.split('\n')) {
    if (pattern.test(line)) {
      found.push(line.trim())
      if (found.length >= MAX_IMPORTS) break
    }
  }
  return found
}

function normaliseLanguage(languageId: string): string {
  if (languageId === 'typescriptreact') return 'typescript'
  if (languageId === 'javascriptreact') return 'javascript'
  return languageId
}

/* ------------------------------------------------------------------ *
 * Enclosing symbol
 * ------------------------------------------------------------------ */

/**
 * Declaration shapes, per language family, with the symbol name captured.
 *
 * These are structural heuristics, not a parser. Monaco's standalone build
 * exposes `registerDocumentSymbolProvider` but no way to *query* the registered
 * providers, so the `DocumentSymbol`s the spec names are not reachable from
 * application code — real symbols arrive with the language servers in M4. Until
 * then this finds the enclosing function or class well enough to be useful, and
 * returns null rather than guessing when it cannot.
 */
interface Declaration {
  readonly kind: string
  readonly pattern: RegExp
}

const DECLARATIONS: Record<string, readonly Declaration[]> = {
  typescript: [
    { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    {
      kind: 'function',
      pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
    },
    {
      kind: 'function',
      pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\()/
    },
    {
      kind: 'method',
      pattern: /^\s*(?:public|private|protected|static|readonly|async|\*)?[\s*]*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/
    }
  ],
  python: [
    { kind: 'class', pattern: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ }
  ],
  c: [{ kind: 'function', pattern: /^[A-Za-z_][\w\s*]*\s+\*?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/ }],
  go: [
    { kind: 'function', pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', pattern: /^\s*type\s+([A-Za-z_]\w*)/ }
  ],
  rust: [
    { kind: 'function', pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'struct', pattern: /^\s*(?:pub\s+)?(?:struct|enum|impl|trait)\s+([A-Za-z_]\w*)/ }
  ],
  java: [
    { kind: 'class', pattern: /^\s*(?:public|private|protected)?\s*(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/ },
    {
      kind: 'method',
      pattern: /^\s*(?:public|private|protected)[\w\s<>\[\],]*\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{?\s*$/
    }
  ]
}

DECLARATIONS['javascript'] = DECLARATIONS['typescript'] ?? []
DECLARATIONS['cpp'] = DECLARATIONS['c'] ?? []
DECLARATIONS['csharp'] = DECLARATIONS['java'] ?? []

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].replace(/\t/g, '    ').length
}

/** True for languages whose blocks are indentation-delimited rather than braced. */
function isIndentScoped(languageId: string): boolean {
  return languageId === 'python'
}

/**
 * The innermost declaration containing `line`, or null.
 *
 * Walks upward for the nearest declaration at a shallower indent than the
 * selection, then walks forward to find where its body ends — by brace balance
 * for braced languages, by dedent for Python.
 */
export function findEnclosingSymbol(
  source: string,
  languageId: string,
  line: number
): EnclosingSymbol | null {
  const declarations = DECLARATIONS[normaliseLanguage(languageId)]
  if (declarations === undefined) return null

  const lines = source.split('\n')
  const index = Math.min(Math.max(0, line - 1), lines.length - 1)
  const target = lines[index]
  if (target === undefined) return null

  const targetIndent = indentOf(target)

  for (let i = index; i >= 0; i -= 1) {
    const candidate = lines[i]
    if (candidate === undefined || candidate.trim() === '') continue
    // A declaration must be at least as shallow as the line we started from,
    // otherwise it is a sibling further up the file rather than an enclosure.
    if (i !== index && indentOf(candidate) > targetIndent) continue

    for (const { kind, pattern } of declarations) {
      const match = pattern.exec(candidate)
      const name = match?.[1]
      if (name === undefined) continue

      const endLine = isIndentScoped(languageId)
        ? endOfIndentedBlock(lines, i)
        : endOfBracedBlock(lines, i)

      // The selection has to actually be inside the body, or we have found a
      // declaration that merely precedes it.
      if (endLine < line) continue

      return { name, kind, startLine: i + 1, endLine }
    }
  }

  return null
}

function endOfIndentedBlock(lines: readonly string[], declIndex: number): number {
  const declLine = lines[declIndex]
  if (declLine === undefined) return declIndex + 1
  const baseIndent = indentOf(declLine)

  let end = declIndex + 1
  for (let i = declIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) break
    if (line.trim() === '') continue
    if (indentOf(line) <= baseIndent) break
    end = i + 1
  }
  return end
}

/**
 * Counts braces from the declaration to its matching close.
 *
 * Strings and comments are skipped, because a `{` inside a string literal would
 * otherwise unbalance the count and swallow the rest of the file.
 */
function endOfBracedBlock(lines: readonly string[], declIndex: number): number {
  let depth = 0
  let seenOpen = false

  for (let i = declIndex; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) break

    let inString: string | null = null
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c]
      const next = line[c + 1]

      if (inString !== null) {
        if (ch === '\\') c += 1
        else if (ch === inString) inString = null
        continue
      }

      if (ch === '/' && next === '/') break
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch
        continue
      }
      if (ch === '{') {
        depth += 1
        seenOpen = true
      } else if (ch === '}') {
        depth -= 1
        if (seenOpen && depth <= 0) return i + 1
      }
    }
  }

  return lines.length
}

/* ------------------------------------------------------------------ *
 * Applying a rewrite
 * ------------------------------------------------------------------ */

export interface SelectionRange {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * Splices replacement text into `source` at an exact range.
 *
 * Positional rather than search-and-replace on purpose: the selected text may
 * appear more than once in the file, and replacing the wrong occurrence is a
 * silent corruption that a diff preview would not obviously reveal.
 */
export function spliceSelection(
  source: string,
  selection: SelectionRange,
  replacement: string
): string {
  const lines = source.split('\n')
  const startLine = Math.min(Math.max(1, selection.startLine), lines.length)
  const endLine = Math.min(Math.max(startLine, selection.endLine), lines.length)

  const firstLine = lines[startLine - 1] ?? ''
  const lastLine = lines[endLine - 1] ?? ''

  const head = firstLine.slice(0, Math.max(0, selection.startColumn - 1))
  const tail = lastLine.slice(Math.max(0, selection.endColumn - 1))

  return [
    ...lines.slice(0, startLine - 1),
    ...`${head}${replacement}${tail}`.split('\n'),
    ...lines.slice(endLine)
  ].join('\n')
}

/**
 * Pulls the rewritten code out of an `improve` answer.
 *
 * The model is told to reply with one fenced block plus a rationale, but a
 * prompt is a request, not a guarantee. Takes the first block and returns null
 * when there is none — in which case the UI must not offer to apply anything,
 * rather than writing prose into a source file.
 */
export function extractCodeBlock(answer: string): string | null {
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(answer)
  const body = fence?.[1]
  if (body === undefined) return null
  const trimmed = body.replace(/\n$/, '')
  return trimmed.trim() === '' ? null : trimmed
}
