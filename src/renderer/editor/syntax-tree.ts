import { Language, Parser, type Edit, type Point, type Range, type Tree } from 'web-tree-sitter'
import type { BetterCallCompilerApi } from '../../shared/ipc-contract'

/**
 * Incremental parsing.
 *
 * The problem this replaces: `code-graph.ts` re-parses the entire file through
 * Babel on every content change, and the Visualizer rebuilds its graph from
 * that. Typing one character in a 1600-line file therefore costs a full parse
 * plus a full graph build, per keystroke, on the UI thread.
 *
 * Tree-sitter reuses the parts of the previous tree an edit did not touch
 * (Wagner & Graham, "Efficient and Flexible Incremental Parsing", TOPLAS'98,
 * which is the algorithm tree-sitter implements). The saving that matters here
 * is not the parse itself but what it makes possible: `changedRanges` says
 * exactly which byte ranges have different syntax than before, so a consumer
 * can decide it has nothing to do — the same laziness the compiler daemon
 * gained in this branch, applied to the renderer.
 *
 * Error recovery is the second reason. Babel throws on a file mid-edit, so the
 * Visualizer shows "does not parse" for every keystroke that leaves the source
 * temporarily invalid — which, while typing, is most of them. Tree-sitter
 * always returns a tree, with the broken region marked.
 *
 * ## Loading
 *
 * There is no `fetch` here, and there cannot be: the production CSP is
 * `connect-src 'none'`, which refuses fetch, XHR and `instantiateStreaming`
 * alike. The runtime and grammars arrive as bytes over IPC from the main
 * process (see `wasm-assets.ts`) and are compiled from those buffers, which is
 * what `'wasm-unsafe-eval'` permits — and all it permits.
 */

/**
 * Reached through `globalThis` and read lazily, not through `window` at module
 * scope.
 *
 * The pure half of this file — `toEdit`, `controlFlowSignature`,
 * `intersectsLines` — is unit tested in plain Node under `tsconfig.node.json`,
 * which has no DOM lib. Naming `window` anywhere in the module makes that
 * project fail to compile, and reading the bridge during module evaluation
 * would make the import throw before any of those functions could be called.
 */
function bridge(): BetterCallCompilerApi {
  return (globalThis as unknown as { betterCallCompiler: BetterCallCompilerApi })
    .betterCallCompiler
}

/** Grammar per Monaco language id. A language absent from this map is unsupported. */
const GRAMMAR_BY_LANGUAGE: Readonly<Record<string, string>> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  javascriptreact: 'tree-sitter-javascript',
  typescriptreact: 'tree-sitter-tsx',
  python: 'tree-sitter-python'
}

export function supportsLanguage(languageId: string): boolean {
  return Object.prototype.hasOwnProperty.call(GRAMMAR_BY_LANGUAGE, languageId)
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function readAsset(name: string): Promise<Uint8Array | null> {
  const result = await bridge().wasm.read({ name })
  return result.ok ? decodeBase64(result.value.base64) : null
}

/* ------------------------------- initialising ----------------------------- */

let initPromise: Promise<boolean> | null = null
let ready = false

/**
 * Loads the tree-sitter runtime, once.
 *
 * Idempotent by promise rather than by flag: two documents opening in the same
 * tick would otherwise both see `ready === false` and both call `Parser.init`,
 * and the second initialisation of an Emscripten module is not harmless.
 */
export function initSyntax(): Promise<boolean> {
  if (initPromise !== null) return initPromise

  initPromise = (async () => {
    const bytes = await readAsset('tree-sitter')
    if (bytes === null) return false

    try {
      // `wasmBinary` is the Emscripten option that skips the module's own
      // fetch. Without it the runtime tries to load its .wasm by URL and the
      // CSP refuses — silently, as an unhandled rejection inside the module.
      await Parser.init({ wasmBinary: bytes })
      ready = true
      return true
    } catch {
      return false
    }
  })()

  return initPromise
}

const languages = new Map<string, Language | null>()

/**
 * Loads a grammar, once per language.
 *
 * A failure is cached as `null` rather than retried. A missing grammar is a
 * packaging fact that will not change while the app is running, and retrying it
 * on every keystroke would turn one absent file into a stream of IPC calls.
 */
async function languageFor(languageId: string): Promise<Language | null> {
  const grammar = GRAMMAR_BY_LANGUAGE[languageId]
  if (grammar === undefined) return null

  const cached = languages.get(grammar)
  if (cached !== undefined) return cached

  if (!(await initSyntax())) {
    languages.set(grammar, null)
    return null
  }

  const bytes = await readAsset(grammar)
  if (bytes === null) {
    languages.set(grammar, null)
    return null
  }

  try {
    const language = await Language.load(bytes)
    languages.set(grammar, language)
    return language
  } catch {
    /**
     * Cached as `null`, and worth knowing what this catch caught once.
     *
     * `Language.load` rejects on an ABI mismatch with an EMPTY error message,
     * so a grammar built for the wrong tree-sitter looks identical to no
     * grammar at all — the layer just quietly never works. That is why the
     * grammars come from @vscode/tree-sitter-wasm rather than the
     * more obvious tree-sitter-wasms, which is still built with
     * tree-sitter-cli 0.20. See electron-builder.yml.
     */
    languages.set(grammar, null)
    return null
  }
}

/* --------------------------------- documents ------------------------------ */

interface Entry {
  readonly parser: Parser
  readonly languageId: string
  tree: Tree
  /** The text the tree describes; edits are computed against it. */
  text: string
}

const documents = new Map<string, Entry>()

/**
 * A Monaco content change, in the shape tree-sitter needs.
 *
 * Monaco reports `{rangeOffset, rangeLength, text}` plus 1-based line/column;
 * tree-sitter wants byte offsets AND row/column points for both the old and new
 * end. Both are required — the offsets drive node reuse and the points drive
 * position mapping — and supplying only the offsets produces a tree whose
 * positions are quietly wrong rather than an error.
 *
 * Rows are 0-based here and 1-based in Monaco. Exported and tested because an
 * off-by-one in this conversion does not throw; it makes reuse decisions
 * against the wrong region, which shows up as an occasional stale graph.
 */
export interface ContentChange {
  readonly rangeOffset: number
  readonly rangeLength: number
  readonly text: string
  /** 1-based, as Monaco reports it. */
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * The six fields `Tree.edit` actually reads.
 *
 * web-tree-sitter 0.26 types `Edit` with two helper methods on it — `editPoint`
 * and `editRange` — which the C binding never consults on an argument; they are
 * conveniences for callers holding an edit. A plain object therefore does not
 * satisfy `Edit` structurally even though it is exactly what the function
 * wants. Declaring the data shape separately keeps `toEdit` a pure function
 * over plain values, which is what makes it testable in Node with no wasm.
 */
export interface SyntaxEdit {
  readonly startIndex: number
  readonly oldEndIndex: number
  readonly newEndIndex: number
  readonly startPosition: Point
  readonly oldEndPosition: Point
  readonly newEndPosition: Point
}

export function toEdit(change: ContentChange): SyntaxEdit {
  const startIndex = change.rangeOffset
  const oldEndIndex = change.rangeOffset + change.rangeLength
  const newEndIndex = change.rangeOffset + change.text.length

  const startPosition = { row: change.startLine - 1, column: change.startColumn - 1 }
  const oldEndPosition = { row: change.endLine - 1, column: change.endColumn - 1 }

  // The new end is derived from the inserted text rather than from Monaco,
  // which reports the range that was REPLACED and knows nothing yet about the
  // shape of what replaced it.
  const lines = change.text.split('\n')
  const addedRows = lines.length - 1
  const lastLine = lines[lines.length - 1] ?? ''
  const newEndPosition =
    addedRows === 0
      ? { row: startPosition.row, column: startPosition.column + change.text.length }
      : { row: startPosition.row + addedRows, column: lastLine.length }

  return { startIndex, oldEndIndex, newEndIndex, startPosition, oldEndPosition, newEndPosition }
}

/**
 * Parses a document for the first time, or returns the existing entry.
 *
 * Returns null for a language with no grammar, which every caller must handle
 * by falling back — this layer is an optimisation, and an optimisation that
 * turns an unsupported language into a broken one is not one.
 */
export async function openDocument(
  key: string,
  languageId: string,
  text: string
): Promise<boolean> {
  const existing = documents.get(key)
  if (existing !== undefined && existing.languageId === languageId) return true
  if (existing !== undefined) closeDocument(key)

  const language = await languageFor(languageId)
  if (language === null) return false

  const parser = new Parser()
  parser.setLanguage(language)

  const tree = parser.parse(text)
  if (tree === null) {
    parser.delete()
    return false
  }

  documents.set(key, { parser, languageId, tree, text })
  return true
}

export interface EditResult {
  /** Byte ranges whose syntax differs from before the edit. */
  readonly changedRanges: readonly Range[]
  /** False when this document has no tree — the caller must fall back. */
  readonly ok: boolean
}

/**
 * Applies an edit and reports what actually changed.
 *
 * The old tree is edited, re-parsed against it, and then compared. That third
 * step is the point: `getChangedRanges` is what lets a consumer skip work, and
 * without it incremental parsing only makes the parse cheaper while leaving
 * every downstream rebuild exactly as expensive as it was.
 *
 * The previous tree is deleted after the comparison. These are WebAssembly
 * objects with manual lifetimes — the JS garbage collector does not know about
 * the memory behind them, so a tree left undeleted on every keystroke leaks
 * until the renderer runs out of heap.
 */
export function applyEdit(key: string, change: ContentChange, newText: string): EditResult {
  const entry = documents.get(key)
  if (entry === undefined) return { changedRanges: [], ok: false }

  const previous = entry.tree
  // Cast because `Edit` is typed with two helper methods the binding does not
  // read on input — see SyntaxEdit. The six data fields are complete.
  previous.edit(toEdit(change) as Edit)

  const next = entry.parser.parse(newText, previous)
  if (next === null) return { changedRanges: [], ok: false }

  const changedRanges = previous.getChangedRanges(next)

  entry.tree = next
  entry.text = newText
  previous.delete()

  return { changedRanges, ok: true }
}

/* ----------------------------- flow signature ----------------------------- */

/**
 * Node types the Visualizer's graph is actually a picture of.
 *
 * Everything else in a file — identifiers, literals, operators, member
 * expressions — can change without altering a single node or edge in the
 * diagram. Renaming a variable, editing a string, swapping `+` for `-`: the
 * control flow is identical and the graph would come out the same.
 *
 * Kept deliberately broad across the shipped grammars rather than split per
 * language. A type that exists in only one grammar simply never matches in the
 * others, and one set is far easier to keep honest than four.
 */
const FLOW_TYPES = new Set([
  // declarations that create a node
  'function_declaration',
  'function_definition',
  'function_expression',
  'arrow_function',
  'generator_function_declaration',
  'method_definition',
  'class_declaration',
  'class_definition',
  // branching
  'if_statement',
  'else_clause',
  'ternary_expression',
  'conditional_expression',
  'switch_statement',
  'switch_case',
  'switch_default',
  'case_clause',
  // looping
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  // exits and error paths
  'return_statement',
  'throw_statement',
  'try_statement',
  'catch_clause',
  'finally_clause',
  'except_clause',
  'break_statement',
  'continue_statement',
  'await_expression',
  'yield_expression',
  // calls — the graph draws a node and a `calls` edge for each one
  'call_expression',
  'new_expression',
  // visibility — the inspector colours a node by whether it is exported
  'export_statement',
  // complexity — `&&`, `||` and `??` are what McCabe counts beyond the branch
  // statements above, and each one is a binary_expression node, so adding one
  // always adds a node here even though the operator itself is anonymous
  'binary_expression',
  // named bindings — an arrow function takes its graph name from the declarator
  'variable_declarator'
])

/**
 * Nodes whose HEADER identifies them, beyond their position.
 *
 * The header is everything before the body: the name, the parameters with their
 * types, the return type, and modifiers like `async`. All of it is rendered by
 * the inspector, and none of it was in the signature before — so renaming a
 * function, adding `export`, or changing a parameter's type all left the diagram
 * showing the old values.
 */
const HEADER_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'function_expression',
  'arrow_function',
  'generator_function_declaration',
  'method_definition',
  'class_declaration',
  'class_definition',
  'variable_declarator'
])

/**
 * Nodes identified by what they call rather than by their whole text.
 *
 * Only the callee, deliberately. Taking the whole call would put its ARGUMENTS
 * in the signature, and editing a string literal inside a call is the one case
 * the cutoff was already correct about. Keeping that free is worth the narrower
 * check.
 */
const CALLEE_TYPES = new Set(['call_expression', 'new_expression'])

/** Long enough for any real signature, short enough to stay cheap to compare. */
const HEADER_LIMIT = 120
const CALLEE_LIMIT = 60

/**
 * A declaration's header — everything up to its body.
 *
 * Cut at the first `{`, `=>` or newline, whichever comes first. `{` ends a
 * function or class header; `=>` ends an arrow's, which has no brace when its
 * body is an expression; the newline is the backstop for anything else. Without
 * the `=>` case an expression-bodied arrow would carry its entire body in the
 * signature and no edit inside it would ever be free.
 */
function headerOf(type: string, text: string): string {
  // A declarator contributes its NAME and nothing else. Its initialiser has
  // nodes of its own — an arrow function carries its own header, a call its own
  // callee — so folding it in here would mean that editing `let n = 1` to
  // `let n = 2` rebuilt the whole diagram for a change the diagram cannot show.
  // Measured: without this cut, that edit stopped being free.
  const markers = type === 'variable_declarator' ? ['=', '\n'] : ['{', '=>', '\n']

  let end = text.length
  for (const marker of markers) {
    const at = text.indexOf(marker)
    if (at >= 0 && at < end) end = at
  }
  return text.slice(0, end).trim().slice(0, HEADER_LIMIT)
}

/**
 * One node's contribution to the signature.
 *
 * `type@row` for most nodes, as before. Nodes that carry identity add it after a
 * `#`, which cannot appear in a node type, so the parts stay unambiguous.
 */
function fingerprintOf(node: FlowNode): string {
  const base = `${node.type}@${node.startPosition.row}`

  if (HEADER_TYPES.has(node.type)) {
    const header = headerOf(node.type, node.text ?? '')
    return header === '' ? base : `${base}#${header}`
  }

  if (CALLEE_TYPES.has(node.type)) {
    const callee = (node.namedChildren[0]?.text ?? '').trim().slice(0, CALLEE_LIMIT)
    return callee === '' ? base : `${base}#${callee}`
  }

  return base
}

/**
 * The minimum a node has to look like for the signature walk.
 *
 * Declared structurally rather than importing tree-sitter's `Node` so the walk
 * can be unit tested against plain objects, with no WebAssembly runtime in the
 * test process. The real nodes satisfy it.
 */
export interface FlowNode {
  readonly type: string
  readonly startPosition: Point
  readonly namedChildren: readonly (FlowNode | null)[]
  /**
   * The node's source text. Optional so the walk stays testable against plain
   * objects; real tree-sitter nodes always provide it.
   */
  readonly text?: string
}

/**
 * A fingerprint of a file's control flow.
 *
 * The same idea as `moduleSignature` in the compiler daemon, one layer up: an
 * edit that leaves this string unchanged cannot change the diagram, so the
 * Babel parse and the graph build are both skipped. Early cutoff, in the
 * renderer.
 *
 * The row is part of the fingerprint on purpose. The graph's nodes carry source
 * locations and clicking one jumps the editor there, so inserting a blank line
 * genuinely does change the diagram even though its shape is identical — and a
 * signature that ignored rows would leave every click one line off.
 *
 * The column is NOT included. Re-indenting a block moves every column and moves
 * no node, and including it would make a reformat look like a structural
 * change, which is exactly the edit this is meant to make free.
 */
export function controlFlowSignature(root: FlowNode | null): string {
  if (root === null) return ''

  const parts: string[] = []
  const stack: (FlowNode | null)[] = [root]

  // Iterative: a deeply nested file would otherwise recurse as far as its
  // deepest block, and the daemon already learned that lesson in
  // `stronglyConnectedComponents`.
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined || node === null) continue

    if (FLOW_TYPES.has(node.type)) parts.push(fingerprintOf(node))

    // Pushed in reverse so siblings are visited left to right; the signature is
    // order-sensitive, and a walk whose order depended on the stack's direction
    // would differ between two identical files.
    for (let index = node.namedChildren.length - 1; index >= 0; index--) {
      stack.push(node.namedChildren[index] ?? null)
    }
  }

  return parts.join('|')
}

/** The current file's flow signature, or null when there is no tree. */
export function flowSignatureFor(key: string): string | null {
  const tree = documents.get(key)?.tree
  if (tree === undefined) return null
  return controlFlowSignature(tree.rootNode as unknown as FlowNode)
}

/** True when an edit's changed ranges touch the given 1-based line span. */
export function intersectsLines(
  ranges: readonly Range[],
  startLine: number,
  endLine: number
): boolean {
  for (const range of ranges) {
    // Tree-sitter rows are 0-based; the caller's lines are 1-based.
    const from = range.startPosition.row + 1
    const to = range.endPosition.row + 1
    if (from <= endLine && to >= startLine) return true
  }
  return false
}

export function hasDocument(key: string): boolean {
  return documents.has(key)
}

/** The current tree, for callers that want to walk it. */
export function treeFor(key: string): Tree | null {
  return documents.get(key)?.tree ?? null
}

export function closeDocument(key: string): void {
  const entry = documents.get(key)
  if (entry === undefined) return

  // Both are WebAssembly-backed and both must be released explicitly.
  entry.tree.delete()
  entry.parser.delete()
  documents.delete(key)
}

export function closeAllDocuments(): void {
  for (const key of [...documents.keys()]) closeDocument(key)
}

/** Test seam and diagnostics: whether the runtime came up at all. */
export function isSyntaxReady(): boolean {
  return ready
}
