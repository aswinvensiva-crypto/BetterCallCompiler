import type { Span } from './token'

/**
 * The BCC syntax tree.
 *
 * ## What this tree is, and what it is not
 *
 * It records the SHAPE of the program, not its legality. `f()()` has a tree,
 * `let x: nonsense = true` has a tree, and a function declared inside a loop has
 * a tree. Each is rejected later, by the stage that can say something useful
 * about it. A parser that also enforced meaning would report "unexpected token"
 * where the resolver can report "functions cannot be declared inside a block",
 * and the user would be worse off.
 *
 * The line is grammar: `param := IDENT ':' type` is grammar, so a parameter
 * without a type annotation is a parse error. `let` may omit its annotation
 * because the grammar says it may, and inference happens in Part 4.
 *
 * ## Spans
 *
 * Every node carries one, and a node's span contains the spans of all of its
 * children. That containment is checked as a property over a fuzz corpus rather
 * than assumed, because a span that is merely *plausible* still sends a
 * click-to-source highlight to the wrong line five stages downstream, with
 * nothing pointing back here.
 *
 * ## Bindings and uses are different types
 *
 * `Ident` is where a name is INTRODUCED or STORED to; `Name` is where one is
 * READ. They are structurally identical and deliberately not the same type: the
 * resolver in Part 4 declares at one and looks up at the other, and the IR in
 * Part 5 emits a def at one and a use at the other. Sharing a type would mean
 * recovering the distinction from parent context at every visit.
 */

/* -------------------------------------------------------------------------- */
/*  Leaves                                                                     */
/* -------------------------------------------------------------------------- */

/** A binding or store site: the `x` in `let x = 1`, `fn f(x: int)`, `x = 2`. */
export interface Ident {
  readonly kind: 'Ident'
  readonly text: string
  readonly span: Span
}

/**
 * A written type, as written.
 *
 * `name` is not validated here — `int`, `bool` and `Frobnicator` all parse. The
 * resolver decides which of them exist.
 */
export interface TypeRef {
  readonly kind: 'TypeRef'
  readonly name: string
  readonly span: Span
}

export interface Param {
  readonly kind: 'Param'
  readonly name: Ident
  /**
   * Null only when the annotation was missing and the parser already reported
   * it. Part 4 must not report a second diagnostic for the same absence.
   */
  readonly type: TypeRef | null
  readonly span: Span
}

/* -------------------------------------------------------------------------- */
/*  Expressions                                                                */
/* -------------------------------------------------------------------------- */

export type UnaryOp = '-' | '!'

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>='

/**
 * `&&` and `||` only.
 *
 * Separate from `Binary` because they are not operators in the way `+` is: they
 * do not evaluate both sides. In Part 5 each lowers to a branch and a join,
 * which is control flow — so keeping them apart in the tree means the lowering
 * cannot forget, rather than having to remember to special-case two entries in
 * a table of thirteen.
 */
export type LogicalOp = '&&' | '||'

export interface IntLiteral {
  readonly kind: 'Int'
  readonly value: number
  /** As written. `007` keeps its zeroes; the Observatory shows the source. */
  readonly text: string
  readonly span: Span
}

export interface BoolLiteral {
  readonly kind: 'Bool'
  readonly value: boolean
  readonly span: Span
}

/** A name being read. See the note on `Ident`. */
export interface Name {
  readonly kind: 'Name'
  readonly text: string
  readonly span: Span
}

export interface Unary {
  readonly kind: 'Unary'
  readonly operator: UnaryOp
  readonly operand: Expr
  /** Just the operator. `cannot negate a bool` should underline the `-`. */
  readonly operatorSpan: Span
  readonly span: Span
}

export interface Binary {
  readonly kind: 'Binary'
  readonly operator: BinaryOp
  readonly left: Expr
  readonly right: Expr
  readonly operatorSpan: Span
  readonly span: Span
}

export interface Logical {
  readonly kind: 'Logical'
  readonly operator: LogicalOp
  readonly left: Expr
  readonly right: Expr
  readonly operatorSpan: Span
  readonly span: Span
}

/**
 * `callee` is any expression, not just a name.
 *
 * BCC has no first-class functions, so `f()()` is meaningless — but it is
 * meaningless in the way the resolver can explain, not in the way the parser
 * can. Parsing `(` as an ordinary postfix operator also keeps the Pratt loop
 * uniform.
 */
export interface Call {
  readonly kind: 'Call'
  readonly callee: Expr
  readonly args: readonly Expr[]
  readonly span: Span
}

/**
 * Stands in where an expression was required and none could be parsed.
 *
 * Zero-width, positioned where the expression should have been. It exists so
 * that a broken file still yields a tree with the right SHAPE — `1 +` is a
 * `Binary`, not a missing statement — which is what lets the Observatory, the
 * resolver and every later stage keep working on input the user is halfway
 * through typing.
 */
export interface ErrorExpr {
  readonly kind: 'ErrorExpr'
  readonly span: Span
}

export type Expr =
  | IntLiteral
  | BoolLiteral
  | Name
  | Unary
  | Binary
  | Logical
  | Call
  | ErrorExpr

/* -------------------------------------------------------------------------- */
/*  Statements                                                                 */
/* -------------------------------------------------------------------------- */

export interface LetStmt {
  readonly kind: 'Let'
  readonly name: Ident
  /** Absent when the program did not write one. Part 4 infers. */
  readonly type: TypeRef | null
  readonly initializer: Expr
  readonly span: Span
}

/**
 * `x = expr`.
 *
 * A statement rather than an expression, so `if x = 1 { }` is a syntax error
 * instead of the bug it is in C. The target is an `Ident` because a store
 * resolves to an existing binding but lowers to a write, not a read.
 */
export interface AssignStmt {
  readonly kind: 'Assign'
  readonly target: Ident
  readonly value: Expr
  readonly span: Span
}

export interface IfStmt {
  readonly kind: 'If'
  readonly condition: Expr
  readonly thenBranch: BlockStmt
  /** A block, or the `if` of an `else if` chain. */
  readonly elseBranch: BlockStmt | IfStmt | null
  readonly span: Span
}

export interface WhileStmt {
  readonly kind: 'While'
  readonly condition: Expr
  readonly body: BlockStmt
  readonly span: Span
}

export interface ReturnStmt {
  readonly kind: 'Return'
  readonly value: Expr | null
  readonly span: Span
}

export interface PrintStmt {
  readonly kind: 'Print'
  readonly value: Expr
  readonly span: Span
}

/** `f(1);` — an expression evaluated for its effect. */
export interface ExprStmt {
  readonly kind: 'ExprStmt'
  readonly expression: Expr
  readonly span: Span
}

export interface BlockStmt {
  readonly kind: 'Block'
  readonly statements: readonly Stmt[]
  readonly span: Span
}

/**
 * A function.
 *
 * Parsed as a statement, so it can appear anywhere one can. Nesting is not part
 * of the language — BCC has no closures — but rejecting it here would cost the
 * user "unexpected token 'fn'" where the resolver can say why. Shape, not
 * legality.
 */
export interface FunctionDecl {
  readonly kind: 'Function'
  readonly name: Ident
  readonly params: readonly Param[]
  /** Absent means unit. */
  readonly returnType: TypeRef | null
  readonly body: BlockStmt
  readonly span: Span
}

/**
 * Covers a run of tokens the parser could not make a statement from.
 *
 * Unlike `ErrorExpr` this is not zero-width: it spans exactly what recovery
 * skipped, so the Observatory can show the region that was given up on and the
 * tree still accounts for every part of the file.
 */
export interface ErrorStmt {
  readonly kind: 'ErrorStmt'
  readonly span: Span
}

export type Stmt =
  | LetStmt
  | AssignStmt
  | IfStmt
  | WhileStmt
  | ReturnStmt
  | PrintStmt
  | ExprStmt
  | BlockStmt
  | FunctionDecl
  | ErrorStmt

/* -------------------------------------------------------------------------- */
/*  Program                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A whole file.
 *
 * Its span covers the entire source including leading and trailing trivia, so
 * "the program" and "the file" are the same region.
 */
export interface Program {
  readonly kind: 'Program'
  readonly statements: readonly Stmt[]
  readonly span: Span
}

export type Node = Program | Stmt | Expr | Ident | TypeRef | Param

/* -------------------------------------------------------------------------- */
/*  Walking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every child node, in source order.
 *
 * One exhaustive switch, so adding a node type without teaching the walker
 * about it is a compile error rather than a subtree that is silently never
 * visited — which is the failure mode that makes a resolver quietly skip a
 * construct.
 *
 * Source order matters: the Observatory renders the tree in it, and the span
 * containment property test checks children are non-decreasing in offset.
 */
export function childrenOf(node: Node): readonly Node[] {
  switch (node.kind) {
    case 'Program':
    case 'Block':
      return node.statements

    case 'Let':
      return node.type === null
        ? [node.name, node.initializer]
        : [node.name, node.type, node.initializer]

    case 'Assign':
      return [node.target, node.value]

    case 'If':
      return node.elseBranch === null
        ? [node.condition, node.thenBranch]
        : [node.condition, node.thenBranch, node.elseBranch]

    case 'While':
      return [node.condition, node.body]

    case 'Return':
      return node.value === null ? [] : [node.value]

    case 'Print':
      return [node.value]

    case 'ExprStmt':
      return [node.expression]

    case 'Function': {
      const children: Node[] = [node.name, ...node.params]
      if (node.returnType !== null) children.push(node.returnType)
      children.push(node.body)
      return children
    }

    case 'Param':
      return node.type === null ? [node.name] : [node.name, node.type]

    case 'Unary':
      return [node.operand]

    case 'Binary':
    case 'Logical':
      return [node.left, node.right]

    case 'Call':
      return [node.callee, ...node.args]

    // Leaves.
    case 'Int':
    case 'Bool':
    case 'Name':
    case 'Ident':
    case 'TypeRef':
    case 'ErrorExpr':
    case 'ErrorStmt':
      return []
  }
}
