import { z } from 'zod'

/**
 * The wire shape of the Visualizer's code graph.
 *
 * This lives in `src/shared` rather than beside the builder in
 * `src/renderer/editor` for one concrete reason: `src/shared` is the only
 * directory both halves of the app may import, and a graph that is built in
 * the renderer today is expected to cross IPC tomorrow — whole-project
 * analysis cannot run behind the renderer's sandbox, which has no filesystem.
 * Writing the zod schemas now costs nothing and means the move is a wiring
 * change rather than a redesign.
 *
 * Types are *derived* from the schemas with `z.infer`, the same way
 * `src/shared/types.ts` does it. A hand-written interface sitting next to a
 * schema is a drift bug waiting to happen; here the schema is the single source
 * of truth and the TypeScript type cannot disagree with what actually
 * validates.
 *
 * Every object schema is `.readonly()`, which does two things at once: it makes
 * the inferred type match the `readonly` shapes the rest of the codebase
 * exports, and it freezes parsed output so a consumer cannot mutate a graph
 * another consumer is still holding.
 *
 * Note what is *absent*: colour. `category` is the only styling input this
 * layer provides, and the UI maps it to a `--bcc-*` token. A hex value here
 * would put a theme decision in the data layer, where `theme.css` cannot reach
 * it and a light theme could never override it.
 */

/* ------------------------------ vocabulary ------------------------------- */

/**
 * What a node *is*.
 *
 * `entry` marks the synthetic module-top-level node in file mode, the owner of
 * calls that sit outside every function. `merge` is declared but not currently
 * emitted: an `if` with no `else` sends its 'false' edge straight at the next
 * statement rather than at a fabricated join node, because a join node the
 * source does not contain is one more box to read for no information. It stays
 * in the vocabulary so a later layout pass can introduce joins without a
 * schema change rippling through IPC.
 */
export const graphNodeKindSchema = z.enum([
  'entry',
  'function',
  'method',
  'class',
  'if',
  'switch',
  'case',
  'for',
  'while',
  'dowhile',
  'try',
  'catch',
  'finally',
  'return',
  'throw',
  'call',
  'leaf',
  'merge'
])
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>

/**
 * What an edge *means*.
 *
 * `sequential` is plain fall-through. `true`/`false` are the two sides of a
 * decision. `loop-back` is the only edge kind that is excluded when computing
 * layout roots — a loop header would otherwise never be a root and the graph
 * would appear to have no beginning. `calls` is the call graph and is not
 * control flow at all: it crosses function boundaries.
 */
export const graphEdgeKindSchema = z.enum([
  'sequential',
  'true',
  'false',
  'loop-back',
  'catch',
  'finally',
  'case',
  'calls'
])
export type GraphEdgeKind = z.infer<typeof graphEdgeKindSchema>

/** Drives node colour. Maps to theme tokens in the UI layer, never to hexes here. */
export const graphNodeCategorySchema = z.enum([
  'exported',
  'internal',
  'async',
  'control',
  'external',
  'terminal'
])
export type GraphNodeCategory = z.infer<typeof graphNodeCategorySchema>

/**
 * `file` is structure plus the call graph; `selection` is a control-flow graph
 * of the highlighted range. They are different questions, so they are different
 * graphs rather than one graph with a flag the UI has to reinterpret.
 */
export const graphModeSchema = z.enum(['file', 'selection'])
export type GraphMode = z.infer<typeof graphModeSchema>

/** Where the graph came from. `fallback` means the parse or the walk failed. */
export const graphSourceSchema = z.enum(['ast', 'fallback'])
export type GraphSource = z.infer<typeof graphSourceSchema>

/* -------------------------------- nodes ---------------------------------- */

/**
 * Lines and columns are both 1-based and absolute in the file — Babel's 0-based
 * columns are shifted on the way in, and the selection offset is already
 * applied. Every other position in this app (Monaco, `SearchMatch`, compiler
 * diagnostics) is 1-based; a second convention would be a permanent source of
 * off-by-one bugs at every boundary.
 */
export const sourceLocationSchema = z
  .strictObject({
    startLine: z.number().int().nonnegative(),
    startColumn: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    endColumn: z.number().int().nonnegative()
  })
  .readonly()
export type SourceLocation = z.infer<typeof sourceLocationSchema>

/**
 * Only functions and methods carry metrics; everything else is `null`.
 *
 * `cyclomaticComplexity` is McCabe counted over that function's own body, with
 * nested functions excluded — a parent that happens to contain a branchy
 * callback is not itself branchy. It is deliberately independent of the
 * regex-based estimate in `assist-analysis.ts`: that one works on any language
 * and any half-typed fragment, this one needs a parse. The two will disagree,
 * and they are allowed to.
 */
export const graphNodeMetricsSchema = z
  .strictObject({
    cyclomaticComplexity: z.number().int().positive(),
    lineCount: z.number().int().nonnegative(),
    paramCount: z.number().int().nonnegative()
  })
  .readonly()
export type GraphNodeMetrics = z.infer<typeof graphNodeMetricsSchema>

/**
 * `type` is `null` whenever there is no *explicit* annotation, and also when
 * the annotation is a shape this printer does not render. There is no type
 * checker behind any of this, so an inferred type would be a guess dressed up
 * as a fact.
 */
export const graphParamSchema = z
  .strictObject({
    name: z.string(),
    type: z.string().nullable()
  })
  .readonly()
export type GraphParam = z.infer<typeof graphParamSchema>

export const codeGraphNodeSchema = z
  .strictObject({
    /**
     * `n<counter>_L<line>`. The line is embedded so click-to-source keeps
     * working through Mermaid, which rewrites the ids it is handed. `location`
     * carries the same information properly — the id scheme is kept only
     * because the legacy renderer parses it back out.
     */
    id: z.string(),
    kind: graphNodeKindSchema,
    /** Plain text. Escaping for whatever draws it is the UI layer's job. */
    label: z.string(),
    category: graphNodeCategorySchema,
    location: sourceLocationSchema,
    /** Structural containment (class -> method). NOT control flow. */
    parentId: z.string().nullable(),
    signature: z.string().nullable(),
    params: z.array(graphParamSchema).readonly(),
    /** From an explicit annotation only; never inferred. */
    returnType: z.string().nullable(),
    visibility: z.enum(['exported', 'default-exported', 'internal']).nullable(),
    isAsync: z.boolean(),
    isGenerator: z.boolean(),
    /** Leading JSDoc/TSDoc, stripped of its comment furniture. */
    jsDoc: z.string().nullable(),
    metrics: graphNodeMetricsSchema.nullable(),
    /** Consistent with the 'calls' edges, in both directions. */
    callers: z.array(z.string()).readonly(),
    callees: z.array(z.string()).readonly()
  })
  .readonly()
export type CodeGraphNode = z.infer<typeof codeGraphNodeSchema>

/* -------------------------------- edges ---------------------------------- */

export const codeGraphEdgeSchema = z
  .strictObject({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    kind: graphEdgeKindSchema,
    /** Short edge caption, e.g. 'true' / 'false' / 'catch' / a case test. Null when unlabelled. */
    label: z.string().nullable()
  })
  .readonly()
export type CodeGraphEdge = z.infer<typeof codeGraphEdgeSchema>

/* -------------------------------- graph ---------------------------------- */

export const codeGraphSchema = z
  .strictObject({
    mode: graphModeSchema,
    nodes: z.array(codeGraphNodeSchema).readonly(),
    edges: z.array(codeGraphEdgeSchema).readonly(),
    source: graphSourceSchema,
    /**
     * Populated whenever `source` is `fallback`, so the panel can say *why* it
     * is showing a list of lines instead of a graph. Null only for the
     * genuinely-empty case, where there is nothing to explain.
     */
    error: z.string().nullable(),
    /** Ids with no incoming non-loop-back edge — layout roots. */
    rootIds: z.array(z.string()).readonly()
  })
  .readonly()
export type CodeGraph = z.infer<typeof codeGraphSchema>
