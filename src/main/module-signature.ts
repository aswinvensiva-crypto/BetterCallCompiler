import { createHash } from 'node:crypto'
import ts from 'typescript'

/**
 * The public type surface of a module, reduced to a hash.
 *
 * This is the single query that makes the demand-driven engine worth building,
 * so it is worth being precise about what it buys.
 *
 * A dependent file only needs re-checking when the module it imports changes in
 * a way that is *visible across the import boundary*. Editing a function body,
 * renaming a local, adding a comment, reformatting — none of those can change a
 * single diagnostic in a dependent. Today all of them do, because the
 * invalidation walk in `applyChanges` is driven by file identity: A changed, so
 * everything importing A is rechecked.
 *
 * With a signature in the middle, that walk becomes conditional. `fileText:A`
 * changes, `moduleSignature:A` recomputes, and if the hash is identical the
 * engine's early cutoff stops there — `semanticDiagnostics:B` validates without
 * `getSemanticDiagnostics` ever being called. Body edits, which are the
 * overwhelming majority of keystrokes, stop costing anything beyond the edited
 * file. This is the same trick TypeScript's own `--incremental` plays with the
 * emit signatures it stores in `.tsbuildinfo`.
 *
 * Why the type checker rather than hashing the AST text with bodies stripped —
 * the obvious cheaper implementation, and wrong:
 *
 *   export function f() { return 1 }        // inferred: number
 *   export function f() { return 'one' }    // inferred: string
 *
 * Both have an identical body-stripped signature, and the second genuinely
 * breaks every caller. An inferred return type IS part of the public surface,
 * and only the checker knows it. A signature that misses this produces stale
 * diagnostics — the worst possible failure for a daemon, because the user sees
 * a clean file that does not compile.
 *
 * The cost is bounded: resolving the type of each exported symbol, not checking
 * any function body. The program already exists; this asks it a narrow question.
 */

/**
 * Formatting flags chosen so the string is stable and complete.
 *
 * `NoTruncation` is the load-bearing one. `typeToString` elides large object
 * types with `...` by default, and two different types that both truncate to
 * the same prefix would hash identically — a silent correctness hole that only
 * shows up on the big interfaces most worth getting right.
 */
const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrayAsGenericType |
  ts.TypeFormatFlags.UseStructuralFallback

/**
 * A module's exports as `name:type` lines, sorted.
 *
 * Sorted because declaration order is not part of a module's contract: moving a
 * function above another changes the AST and changes nothing a dependent can
 * observe. Leaving the order in would make every reorder look like a breaking
 * change and defeat the cutoff on exactly the edits people make while tidying.
 */
export function exportedTypeLines(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): string[] {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)

  // No module symbol means a global script rather than a module. It has no
  // import surface, so nothing can depend on it through an import edge.
  if (moduleSymbol === undefined) return []

  const lines: string[] = []

  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    lines.push(`${symbol.getName()}:${typeTextOf(checker, symbol)}`)
  }

  return lines.sort()
}

/**
 * An object type expanded to its members, sorted.
 *
 * Necessary because `typeToString` is NOMINAL for anything declared with a
 * name: an interface `Shape` stringifies to `"Shape"` no matter what is inside
 * it. Hashing that means `interface Shape { a: number }` and
 * `interface Shape { b: string }` produce the same signature, dependents are
 * never rechecked, and the user is left looking at a clean file that does not
 * compile. This was caught by a test rather than by reading the API docs.
 *
 * Expansion is deliberately ONE level deep. A property whose type lives in
 * another module stringifies to that type's name, and the change is picked up
 * anyway: the dependent's `semanticDiagnostics` query also depends on that
 * module's own signature, so the invalidation arrives by the other edge. Going
 * deeper would only duplicate that work — and would need cycle handling, since
 * `interface Node { next: Node }` is ordinary code.
 */
function structureOf(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node | undefined
): string {
  const parts: string[] = []

  for (const property of checker.getPropertiesOfType(type)) {
    const at = property.valueDeclaration ?? property.declarations?.[0] ?? location
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : ''
    const propertyType =
      at === undefined
        ? checker.getDeclaredTypeOfSymbol(property)
        : checker.getTypeOfSymbolAtLocation(property, at)

    parts.push(
      `${property.getName()}${optional}:${checker.typeToString(propertyType, at, TYPE_FORMAT_FLAGS)}`
    )
  }

  // Sorted for the same reason the export list is: member order is not part of
  // a contract, so reordering an interface must not look like a breaking change.
  parts.sort()

  for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
    parts.push(`call${checker.signatureToString(signature)}`)
  }
  for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
    parts.push(`new${checker.signatureToString(signature)}`)
  }
  for (const info of checker.getIndexInfosOfType(type)) {
    parts.push(
      `[${checker.typeToString(info.keyType, location, TYPE_FORMAT_FLAGS)}]:` +
        checker.typeToString(info.type, location, TYPE_FORMAT_FLAGS)
    )
  }

  return parts.join(';')
}

/** True for types worth expanding — anything with members to compare. */
function isExpandable(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0
}

/**
 * The type of one exported symbol, as text.
 *
 * Aliases are followed: `export { x } from './y'` re-exports y's type, and a
 * change to y must be visible here or the re-export becomes a hole in the
 * invalidation chain.
 *
 * Both sides of a symbol are captured. `export class C` has a value side
 * (`typeof C`, the constructor) and a type side (instances of C); a change to a
 * method affects the second and not the first, and both are public surface.
 * Interfaces and type aliases have only the type side — their value side
 * resolves to `any`, which is why asking for it alone was the original bug.
 *
 * A symbol whose type cannot be resolved yields a marker rather than throwing.
 * A module mid-edit routinely contains unresolvable references, and a signature
 * query that throws would take down the check for the file the user is actively
 * typing in — precisely when it matters most.
 */
function typeTextOf(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  try {
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol

    const declaration = resolved.declarations?.[0] ?? symbol.declarations?.[0]
    const parts: string[] = []

    if (declaration !== undefined) {
      const valueType = checker.getTypeOfSymbolAtLocation(resolved, declaration)
      const text = checker.typeToString(valueType, declaration, TYPE_FORMAT_FLAGS)
      // `any` here means "no value side" rather than a real `any`; recording it
      // would be noise on every interface in the workspace.
      if (text !== 'any') {
        parts.push(isExpandable(valueType) ? `${text}{${structureOf(checker, valueType, declaration)}}` : text)
      }
    }

    if ((resolved.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) !== 0) {
      const declaredType = checker.getDeclaredTypeOfSymbol(resolved)
      const text = checker.typeToString(declaredType, declaration, TYPE_FORMAT_FLAGS)
      parts.push(
        isExpandable(declaredType)
          ? `type ${text}{${structureOf(checker, declaredType, declaration)}}`
          : `type ${text}`
      )
    }

    return parts.length === 0 ? '<no-type>' : parts.join('|')
  } catch {
    return '<unresolved>'
  }
}

/**
 * A stable hash of the module's public type surface.
 *
 * sha256 truncated to 16 hex chars, matching `hashPrompt` in ai-service.ts so
 * the codebase has one convention for "short content hash" rather than two.
 */
export function moduleSignature(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): string {
  const lines = exportedTypeLines(checker, sourceFile)
  if (lines.length === 0) return 'empty'

  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}
