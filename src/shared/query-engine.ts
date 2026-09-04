/**
 * A demand-driven, memoised query engine.
 *
 * Pure by construction: no node, no electron, no typescript, no DOM. The daemon
 * uses it to decide what to recompute; the tests drive it with plain values.
 *
 * The problem it solves. Today an edit produces an invalidation set — the file
 * plus everything that transitively imports it — and every member of that set is
 * type-checked whether or not anything is going to look at the result. On a
 * wide graph one keystroke in a leaf module can mean hundreds of semantic
 * checks, all of them discarded because the user is looking at one file.
 *
 * The literature is unambiguous about which half of the fix matters. matklad's
 * "Three Architectures for a Responsive IDE" puts it as: it is not incrementality
 * that makes an IDE fast, it is *laziness* — the ability to skip work entirely.
 * So `get()` is the only thing that ever causes computation. An edit marks state
 * stale and returns; nothing is recomputed until somebody asks.
 *
 * The vocabulary is from Build Systems à la Carte (Mokhov, Mitchell, Peyton
 * Jones, ICFP'18): this is a *suspending scheduler* — dependencies are
 * discovered by running the computation and suspending when it asks for
 * something — paired with a *constructive-trace rebuilder*, which is the part
 * that lets an unchanged recomputed value stop the propagation dead.
 *
 * Three mechanisms, in increasing order of how much work they save:
 *
 *   1. Verified-revision check. Nothing has changed at all since this memo was
 *      last validated, so it is returned without touching its dependencies.
 *   2. Durability short-circuit. Nothing at this memo's durability *or below*
 *      has changed, so it is returned without touching its dependencies even
 *      though the world has moved on. This is the one that matters on real
 *      projects, and it is why `lib.d.ts` and `node_modules` are modelled
 *      explicitly rather than treated as ordinary files.
 *   3. Early cutoff. A dependency did change, we recomputed, and the answer came
 *      out identical — so everything downstream stays valid. Reformatting a file
 *      changes its text and none of its diagnostics; without cutoff that edit
 *      would recheck every dependent for nothing.
 */

/* ------------------------------- durability ------------------------------- */

/**
 * How likely an input is to change.
 *
 * From rust-analyzer's "Durable Incrementality". The tiers are not a
 * micro-optimisation: in a typical workspace the overwhelming majority of the
 * dependency graph bottoms out in `lib.d.ts` and `node_modules`, which never
 * change during a session. Without tiers, every keystroke walks that whole mass
 * to re-confirm it is unchanged. With them, one integer comparison does it.
 */
export type Durability = 'workspace' | 'external' | 'lib'

/**
 * Ordered low-to-high, where "low" means "changes often".
 *
 * The numbers are load-bearing — validation compares them — so they are written
 * out rather than derived from array position.
 */
const DURABILITY_LEVEL: Readonly<Record<Durability, number>> = {
  workspace: 0,
  external: 1,
  lib: 2
}

const DURABILITY_BY_LEVEL: readonly Durability[] = ['workspace', 'external', 'lib']

const HIGHEST_LEVEL = DURABILITY_LEVEL.lib

export function durabilityLevel(durability: Durability): number {
  return DURABILITY_LEVEL[durability]
}

/* --------------------------------- keys ----------------------------------- */

/**
 * `namespace:argument`, e.g. `semanticDiagnostics:src/app.ts`.
 *
 * A string rather than a tuple so it can be a Map key, appear verbatim in a
 * trace line, and be read in the Compiler Intelligence panel without a decoder.
 * The namespace is everything before the FIRST colon; arguments may contain
 * colons, which Windows paths do.
 */
export type QueryKey = string

export function queryKey(namespace: string, argument: string): QueryKey {
  return `${namespace}:${argument}`
}

export function namespaceOf(key: QueryKey): string {
  const colon = key.indexOf(':')
  return colon < 0 ? key : key.slice(0, colon)
}

export function argumentOf(key: QueryKey): string {
  const colon = key.indexOf(':')
  return colon < 0 ? '' : key.slice(colon + 1)
}

/* --------------------------------- tracing -------------------------------- */

/**
 * Why a `get()` returned what it returned.
 *
 * This is the engine's only observability surface and the sole data source for
 * the Compiler Intelligence panel, so the outcomes are the ones a person would
 * actually want distinguished — "it was cached" is not an answer, "nothing below
 * lib durability changed so I never looked" is.
 */
export type QueryOutcome =
  /** No memo existed. Computed from nothing. */
  | 'miss'
  /** Verified in this very revision; returned untouched. */
  | 'fresh'
  /** Nothing at this durability or below has changed; dependencies not walked. */
  | 'durable'
  /** Dependencies walked, all unchanged; returned untouched. */
  | 'validated'
  /** Recomputed, and the value was identical — dependents stay valid. */
  | 'cutoff'
  /** Recomputed, and the value changed. */
  | 'recomputed'

export interface QueryTrace {
  readonly key: QueryKey
  readonly outcome: QueryOutcome
  /** Wall-clock cost of this `get`, including nested ones it caused. */
  readonly ms: number
  /** 0 for a caller-initiated `get`, deeper for dependencies it pulled in. */
  readonly depth: number
  readonly durability: Durability
  /** Number of dependencies actually walked. 0 for `fresh`/`durable`. */
  readonly depsWalked: number
}

/* --------------------------------- errors --------------------------------- */

/**
 * A query that (transitively) asked for itself.
 *
 * Recoverable on purpose. Import cycles are legal TypeScript and this engine
 * runs inside a daemon that must survive them — the cycle is reported so the
 * caller can decide, rather than taking the thread down. The daemon already
 * detects cycles properly via `assignComponents` in `dependency-graph.ts`; this
 * exists so a *query-level* cycle can never become an infinite recursion.
 */
export class QueryCycleError extends Error {
  readonly cycle: readonly QueryKey[]

  constructor(cycle: readonly QueryKey[]) {
    super(`query cycle: ${cycle.join(' -> ')}`)
    this.name = 'QueryCycleError'
    this.cycle = cycle
  }
}

/* --------------------------------- memos ---------------------------------- */

interface Memo {
  value: unknown
  /** Revision at which this value was last *confirmed correct*. */
  verifiedAt: number
  /** Revision at which this value last *differed from its predecessor*. */
  changedAt: number
  /** The minimum durability across every dependency. */
  durability: Durability
  deps: QueryKey[]
  /** Inputs have no compute function; they are written, not derived. */
  readonly isInput: boolean
}

export interface QueryContext {
  /** Pull another query. Recording the edge is what makes the graph exist. */
  get<T>(key: QueryKey): T
}

export type ComputeFn = (argument: string, ctx: QueryContext) => unknown

/** Value equality, for early cutoff. Defaults to `Object.is`. */
export type EqualsFn = (a: unknown, b: unknown) => boolean

export interface EngineOptions {
  readonly onTrace?: ((trace: QueryTrace) => void) | undefined
  /**
   * Injected so tests are deterministic and the daemon can use a monotonic
   * clock. Defaults to `Date.now`.
   */
  readonly now?: (() => number) | undefined
}

/* ------------------------------ persistence -------------------------------- */

/**
 * One memo, flattened for storage.
 *
 * `key` travels WITH the memo rather than being the map key of some outer
 * structure, because the wire/on-disk shape is a plain array — the natural
 * shape for `JSON.stringify` and for appending without rewriting everything.
 */
export interface SerializedMemo {
  readonly key: QueryKey
  readonly value: unknown
  readonly verifiedAt: number
  readonly changedAt: number
  readonly durability: Durability
  readonly deps: readonly QueryKey[]
  readonly isInput: boolean
}

/**
 * The engine's full state, sufficient to `hydrate` a fresh engine into
 * exactly the position `serialize` found this one in.
 *
 * `revision` and `lastChangedAt` travel with the memos on purpose — see the
 * module-level plan this satisfies: a rehydrated `verifiedAt` compared
 * against a revision counter that restarts at 0 would validate everything as
 * fresh regardless of what actually changed on disk since the snapshot was
 * taken.
 */
export interface EngineSnapshot {
  readonly revision: number
  readonly lastChangedAt: readonly [number, number, number]
  readonly memos: readonly SerializedMemo[]
}

/**
 * True when `value` survives a `JSON.stringify` / `JSON.parse` round trip
 * unchanged.
 *
 * `engine.get<T>` returns `unknown`, so nothing in the type system guarantees
 * a memoized value is serializable — a `Map`, a class instance, `undefined`
 * inside an object, `NaN`. `serialize` uses this to skip what cannot survive
 * disk rather than crash or silently corrupt it; a skipped memo just costs a
 * recompute on hydrate, which is correct, only slower.
 */
export function isJsonRoundTrippable(value: unknown): boolean {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return false // undefined, a function, a symbol
    return JSON.stringify(JSON.parse(json)) === json
  } catch {
    return false
  }
}

export interface EngineStats {
  readonly revision: number
  readonly memoCount: number
  readonly hits: number
  readonly misses: number
  readonly recomputes: number
  readonly cutoffs: number
  readonly durableSkips: number
}

/* --------------------------------- engine --------------------------------- */

export interface Engine {
  /** Registers a derived query. Recomputed on demand, never eagerly. */
  defineQuery(namespace: string, compute: ComputeFn, equals?: EqualsFn): void
  /**
   * Writes an input. Bumps the revision only if the value actually differs, so
   * a watcher event for a file whose content is unchanged costs nothing.
   * Returns true if the write changed anything.
   */
  setInput(key: QueryKey, value: unknown, durability?: Durability): boolean
  /** Removes an input — a deleted file. Bumps the revision if it existed. */
  removeInput(key: QueryKey): boolean
  /** The only thing that causes computation. */
  get<T>(key: QueryKey): T
  /** True if a memo exists and is currently valid without doing any work. */
  isValid(key: QueryKey): boolean
  /** Drops every memo but keeps inputs — used after a config change. */
  invalidateDerived(): void
  clear(): void
  revision(): number
  stats(): EngineStats
  /** Present keys, for the panel's graph view. */
  keys(): QueryKey[]
  dependenciesOf(key: QueryKey): QueryKey[]
  /**
   * The engine's full state — every memo whose value round-trips through
   * JSON, plus `revision` and `lastChangedAt`. Non-serializable memos are
   * silently dropped rather than crashing the caller; they simply recompute
   * after `hydrate`.
   */
  serialize(): EngineSnapshot
  /**
   * Replaces the engine's entire state with `snapshot`. Call on a freshly
   * created engine — `hydrate` clears whatever memos already exist first, so
   * calling it later throws away in-memory work rather than merging with it.
   */
  hydrate(snapshot: EngineSnapshot): void
}

export function createEngine(options: EngineOptions = {}): Engine {
  const now = options.now ?? Date.now
  const onTrace = options.onTrace

  const memos = new Map<QueryKey, Memo>()
  const computes = new Map<string, ComputeFn>()
  const equalities = new Map<string, EqualsFn>()

  let revision = 0

  /**
   * `lastChangedAt[level]` — the most recent revision at which an input of that
   * durability *or higher* changed.
   *
   * Writing a workspace input touches level 0 only. Writing a lib input touches
   * every level, because a memo that depends only on volatile things must still
   * notice that something stable moved underneath it. Getting this backwards is
   * the classic durability bug: stale results that never revalidate.
   */
  const lastChangedAt: number[] = [0, 0, 0]

  /** In-progress keys, in order, so a cycle can be reported as a path. */
  const stack: QueryKey[] = []
  const active = new Set<QueryKey>()

  let hits = 0
  let misses = 0
  let recomputes = 0
  let cutoffs = 0
  let durableSkips = 0

  function equalsFor(key: QueryKey): EqualsFn {
    return equalities.get(namespaceOf(key)) ?? Object.is
  }

  function markChanged(durability: Durability): void {
    revision++
    for (let level = 0; level <= DURABILITY_LEVEL[durability]; level++) {
      lastChangedAt[level] = revision
    }
  }

  /**
   * The minimum durability across a dependency set.
   *
   * A memo is exactly as stable as its least stable input: a result derived from
   * `lib.d.ts` and one workspace file must be revalidated whenever that
   * workspace file moves, so it is a workspace-durability memo. With no
   * dependencies at all it is a constant, hence the highest tier.
   */
  function durabilityOf(deps: readonly QueryKey[]): Durability {
    let level = HIGHEST_LEVEL
    for (const dep of deps) {
      const memo = memos.get(dep)
      const depLevel = memo === undefined ? 0 : DURABILITY_LEVEL[memo.durability]
      if (depLevel < level) level = depLevel
    }
    return DURABILITY_BY_LEVEL[level] ?? 'workspace'
  }

  function emit(
    key: QueryKey,
    outcome: QueryOutcome,
    startedAt: number,
    durability: Durability,
    depsWalked: number
  ): void {
    if (onTrace === undefined) return
    onTrace({
      key,
      outcome,
      ms: now() - startedAt,
      depth: stack.length,
      durability,
      depsWalked
    })
  }

  /**
   * Validates a memo without recomputing it, if that is possible.
   *
   * Returns true when the memo can be served as-is. The two cheap paths come
   * first and neither touches a dependency; only if both miss do we walk.
   */
  function tryValidate(key: QueryKey, memo: Memo, startedAt: number): boolean {
    if (memo.verifiedAt === revision) {
      hits++
      emit(key, 'fresh', startedAt, memo.durability, 0)
      return true
    }

    // The durability short-circuit. One comparison stands in for the entire
    // subgraph beneath this memo.
    if ((lastChangedAt[DURABILITY_LEVEL[memo.durability]] ?? 0) <= memo.verifiedAt) {
      memo.verifiedAt = revision
      hits++
      // Inputs take this path too and it is correct for them, but they have no
      // subgraph to skip. Counting them would inflate the panel's "work avoided"
      // figure with pure bookkeeping, so the stat tracks dependency walks
      // avoided rather than fast-path hits.
      if (!memo.isInput) durableSkips++
      emit(key, 'durable', startedAt, memo.durability, 0)
      return true
    }

    // An input has no dependencies to consult: if the two cheap checks missed,
    // it genuinely changed.
    if (memo.isInput) return false

    let changed = false
    for (const dep of memo.deps) {
      // A dependency whose memo has vanished is a deleted input — the file this
      // memo read is gone. That is a change, and it must be detected BEFORE
      // resolving: resolving a removed input falls through to `compute`, which
      // has no function for an input namespace and throws. Validation would then
      // propagate an exception for what is an ordinary file deletion.
      if (!memos.has(dep)) {
        changed = true
        break
      }

      // Recursive, and the recursion is the point — this is the suspending
      // scheduler validating bottom-up on demand.
      resolve(dep)
      const depMemo = memos.get(dep)
      if (depMemo === undefined || depMemo.changedAt > memo.verifiedAt) {
        changed = true
        break
      }
    }

    if (changed) return false

    memo.verifiedAt = revision
    hits++
    emit(key, 'validated', startedAt, memo.durability, memo.deps.length)
    return true
  }

  function compute(key: QueryKey, memo: Memo | undefined, startedAt: number): unknown {
    const namespace = namespaceOf(key)
    const fn = computes.get(namespace)
    if (fn === undefined) {
      throw new Error(`no query registered for namespace "${namespace}"`)
    }

    if (active.has(key)) {
      const from = stack.indexOf(key)
      throw new QueryCycleError([...stack.slice(from < 0 ? 0 : from), key])
    }

    active.add(key)
    stack.push(key)

    const deps: QueryKey[] = []
    const seenDeps = new Set<QueryKey>()
    const ctx: QueryContext = {
      get<T>(dep: QueryKey): T {
        // Deduplicated: a compute that reads the same dependency twice records
        // one edge, so validation does not walk it twice on every pass.
        if (!seenDeps.has(dep)) {
          seenDeps.add(dep)
          deps.push(dep)
        }
        return resolve(dep) as T
      }
    }

    let value: unknown
    try {
      value = fn(argumentOf(key), ctx)
    } finally {
      stack.pop()
      active.delete(key)
    }

    const durability = durabilityOf(deps)

    if (memo === undefined) {
      misses++
      recomputes++
      const created: Memo = {
        value,
        verifiedAt: revision,
        changedAt: revision,
        durability,
        deps,
        isInput: false
      }
      memos.set(key, created)
      emit(key, 'miss', startedAt, durability, deps.length)
      return value
    }

    const same = equalsFor(key)(memo.value, value)
    memo.value = value
    memo.deps = deps
    memo.durability = durability
    memo.verifiedAt = revision
    recomputes++

    if (same) {
      // Early cutoff: `changedAt` deliberately NOT touched. That is the whole
      // mechanism — dependents compare against it and stay valid.
      cutoffs++
      emit(key, 'cutoff', startedAt, durability, deps.length)
      return value
    }

    memo.changedAt = revision
    emit(key, 'recomputed', startedAt, durability, deps.length)
    return value
  }

  function resolve(key: QueryKey): unknown {
    const startedAt = now()
    const memo = memos.get(key)

    if (memo !== undefined && tryValidate(key, memo, startedAt)) {
      return memo.value
    }

    if (memo !== undefined && memo.isInput) {
      // An input that failed validation is simply its current value; there is
      // nothing to recompute. Re-stamping it keeps later passes on the fast path.
      memo.verifiedAt = revision
      hits++
      emit(key, 'validated', startedAt, memo.durability, 0)
      return memo.value
    }

    return compute(key, memo, startedAt)
  }

  return {
    defineQuery(namespace, computeFn, equals) {
      computes.set(namespace, computeFn)
      if (equals !== undefined) equalities.set(namespace, equals)
    },

    setInput(key, value, durability = 'workspace') {
      const existing = memos.get(key)

      if (existing !== undefined && existing.isInput) {
        if (
          existing.durability === durability &&
          equalsFor(key)(existing.value, value)
        ) {
          // A watcher event for a file whose bytes did not change. Bumping the
          // revision here would invalidate the world for no reason, which is
          // exactly what a save-on-focus-loss editor triggers all day.
          return false
        }
        existing.value = value
        existing.durability = durability
        markChanged(durability)
        existing.verifiedAt = revision
        existing.changedAt = revision
        return true
      }

      markChanged(durability)
      memos.set(key, {
        value,
        verifiedAt: revision,
        changedAt: revision,
        durability,
        deps: [],
        isInput: true
      })
      return true
    },

    removeInput(key) {
      const existing = memos.get(key)
      if (existing === undefined) return false
      memos.delete(key)
      markChanged(existing.durability)
      return true
    },

    get<T>(key: QueryKey): T {
      return resolve(key) as T
    },

    isValid(key) {
      const memo = memos.get(key)
      if (memo === undefined) return false
      if (memo.verifiedAt === revision) return true
      return (lastChangedAt[DURABILITY_LEVEL[memo.durability]] ?? 0) <= memo.verifiedAt
    },

    invalidateDerived() {
      for (const [key, memo] of [...memos]) {
        if (!memo.isInput) memos.delete(key)
      }
      // The program changed shape rather than its contents, so every tier is
      // suspect — a lib-durability memo computed under the old options is not
      // salvageable.
      markChanged('lib')
    },

    clear() {
      memos.clear()
      revision = 0
      lastChangedAt[0] = 0
      lastChangedAt[1] = 0
      lastChangedAt[2] = 0
      stack.length = 0
      active.clear()
      hits = 0
      misses = 0
      recomputes = 0
      cutoffs = 0
      durableSkips = 0
    },

    revision: () => revision,

    stats: () => ({
      revision,
      memoCount: memos.size,
      hits,
      misses,
      recomputes,
      cutoffs,
      durableSkips
    }),

    keys: () => [...memos.keys()],

    dependenciesOf: (key) => [...(memos.get(key)?.deps ?? [])],

    serialize(): EngineSnapshot {
      const serialized: SerializedMemo[] = []
      for (const [key, memo] of memos) {
        if (!isJsonRoundTrippable(memo.value)) continue
        serialized.push({
          key,
          value: memo.value,
          verifiedAt: memo.verifiedAt,
          changedAt: memo.changedAt,
          durability: memo.durability,
          deps: [...memo.deps],
          isInput: memo.isInput
        })
      }
      return {
        revision,
        lastChangedAt: [lastChangedAt[0] ?? 0, lastChangedAt[1] ?? 0, lastChangedAt[2] ?? 0],
        memos: serialized
      }
    },

    hydrate(snapshot: EngineSnapshot): void {
      memos.clear()
      stack.length = 0
      active.clear()
      hits = 0
      misses = 0
      recomputes = 0
      cutoffs = 0
      durableSkips = 0

      revision = snapshot.revision
      lastChangedAt[0] = snapshot.lastChangedAt[0] ?? 0
      lastChangedAt[1] = snapshot.lastChangedAt[1] ?? 0
      lastChangedAt[2] = snapshot.lastChangedAt[2] ?? 0

      for (const memo of snapshot.memos) {
        memos.set(memo.key, {
          value: memo.value,
          verifiedAt: memo.verifiedAt,
          changedAt: memo.changedAt,
          durability: memo.durability,
          deps: [...memo.deps],
          isInput: memo.isInput
        })
      }
    }
  }
}
