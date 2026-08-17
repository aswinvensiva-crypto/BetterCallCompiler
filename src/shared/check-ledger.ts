/**
 * What the renderer believes, and what the daemon still owes it.
 *
 * Pure by construction: no node, no electron, no typescript, no DOM. It deals
 * in workspace-relative POSIX paths and nothing else, for the same reason
 * `dependency-graph.ts` does — the interesting logic here is bookkeeping across
 * passes, and bookkeeping is exactly the thing that should be testable without
 * an Electron window.
 *
 * ## Why this exists
 *
 * A diagnostics pass used to be all-or-nothing: every file the invalidation
 * walk named got checked, in one synchronous block, before anything was
 * reported. That makes the bookkeeping trivial — if a file was checked it
 * pushed a result, empty or not, and an empty result is what clears a squiggle.
 *
 * The moment a pass is allowed to check only *some* of what it named, that
 * stops being true, and two questions appear that nothing in the daemon could
 * previously answer:
 *
 *   1. Which files is the renderer currently drawing squiggles for? Needed
 *      because a file can leave the graph while its row is still on screen, and
 *      only an explicit empty result removes it.
 *   2. Which files were named but not checked? Needed because if nothing
 *      remembers them, they are never checked again — the next pass recomputes
 *      the invalidation set from the *next* change and has no idea they were
 *      outstanding.
 *
 * `believedDirty` answers the first. `pending` answers the second.
 *
 * ## The invariant
 *
 * An empty result may be posted for a path ONLY when its diagnostics query
 * actually returned an empty array, or when `departed` reports the path as gone
 * from the graph.
 *
 * That rules out the tempting shortcut — "clear everything we believe is dirty
 * that this pass did not check" — which would wipe the squiggles off a file
 * that is genuinely still broken and was merely postponed. A clean-looking file
 * that does not compile is the worst thing a daemon can produce: it is wrong in
 * the direction the user cannot see. Postponing a check is honest, because the
 * last thing reported about that file was true when it was reported.
 */

export interface CheckLedger {
  /**
   * Paths the renderer is currently showing diagnostics for.
   *
   * Not "paths that were dirty in the previous pass". The distinction is the
   * whole point: the previous shape was replaced wholesale every pass, so a
   * single intervening pass over an unrelated file erased the record, and a
   * file that went dirty, sat out one pass and was then deleted kept its row
   * until the daemon restarted.
   */
  readonly believedDirty: Set<string>
  /**
   * Paths named by an invalidation walk that have not been checked yet.
   *
   * Unioned across passes, never assigned. A path leaves only by being checked
   * or by leaving the graph, which is what guarantees a deferred file is
   * eventually reported rather than orphaned.
   */
  readonly pending: Set<string>
}

/**
 * How many files a pass will check without consulting its time budget.
 *
 * Below this, deferral is switched off entirely and a pass behaves exactly as
 * it always did. That is a deliberate no-op, not a tuning knob left at a safe
 * value: an ordinary edit on an ordinary workspace names a handful of files,
 * splitting it would add a second round-trip to no purpose, and every existing
 * assertion about small passes stays true by construction rather than by
 * happening to fall the right side of a threshold.
 *
 * The case deferral is for is the other one — a signature edit in a widely
 * imported module, where the walk names the whole fan-out and each file costs
 * hundreds of milliseconds.
 */
export const SMALL_PASS_FILES = 16

export function createLedger(): CheckLedger {
  return { believedDirty: new Set(), pending: new Set() }
}

export interface PassPlan {
  /** Open files first, then the rest. */
  readonly ordered: readonly string[]
  /**
   * How many of `ordered` must be checked regardless of the time budget.
   *
   * Never zero for a non-empty pass. A pass that checked nothing would report
   * latency for work it did not do and, worse, would let a workspace where
   * every file is slow make no progress at all.
   */
  readonly guaranteed: number
}

/**
 * Decides what a pass checks and in what order.
 *
 * Open files go first because they are what the user is looking at, and a
 * squiggle on the visible file arriving before the rest of the workspace is
 * most of what makes this feel live rather than batch.
 *
 * `isOpen` is a predicate rather than a set so the caller keeps ownership of
 * what "open" means — the worker holds overlays, and this module has no
 * business knowing that.
 */
export function planPass(
  affected: readonly string[],
  isOpen: (relativePath: string) => boolean,
  smallPassLimit: number = SMALL_PASS_FILES
): PassPlan {
  const open = affected.filter((path) => isOpen(path))
  const rest = affected.filter((path) => !isOpen(path))
  const ordered = [...open, ...rest]

  if (ordered.length === 0) return { ordered, guaranteed: 0 }
  if (ordered.length <= smallPassLimit) return { ordered, guaranteed: ordered.length }

  // At least one, even with nothing open. Otherwise a pass triggered by a
  // watcher event with no editor focus would check nothing, defer everything,
  // and rely entirely on the drain to make progress.
  return { ordered, guaranteed: Math.max(open.length, 1) }
}

/** A path was checked and its diagnostics posted. */
export function noteChecked(ledger: CheckLedger, relativePath: string, dirty: boolean): void {
  ledger.pending.delete(relativePath)
  if (dirty) ledger.believedDirty.add(relativePath)
  else ledger.believedDirty.delete(relativePath)
}

/**
 * A path was attempted and could not be answered — a query cycle, say.
 *
 * It leaves `pending`, because retrying it every drain slice forever would be a
 * spin, but `believedDirty` is left alone: nothing new was learned, so the last
 * report stands. Previously this case fell through a bare `continue` and the
 * file was dropped from the record entirely, which stranded its squiggles
 * beyond the reach of any later clean signal.
 */
export function noteAbandoned(ledger: CheckLedger, relativePath: string): void {
  ledger.pending.delete(relativePath)
}

/**
 * Paths named by the walk that this pass chose not to check.
 *
 * Unions. Assigning here instead is precisely the bug this module replaces.
 */
export function noteDeferred(ledger: CheckLedger, paths: Iterable<string>): void {
  for (const path of paths) ledger.pending.add(path)
}

/**
 * The next slice of outstanding work, in insertion order, without removing it.
 *
 * Removal is the caller's business via `noteChecked`/`noteAbandoned`, so a
 * slice that is interrupted mid-way leaves its untouched files outstanding
 * rather than silently dropping them.
 */
export function nextDrain(ledger: CheckLedger, max: number): string[] {
  if (max <= 0) return []

  const out: string[] = []
  for (const path of ledger.pending) {
    out.push(path)
    if (out.length >= max) break
  }
  return out
}

/**
 * Paths the ledger is tracking that no longer exist, removed as they are
 * reported.
 *
 * The caller posts an empty result for each, which is what drops the row from
 * Problems and the squiggle from the editor. Both sets are swept: a file can
 * be deleted while it is still owed a check, and draining a path that is gone
 * would ask the language service about a file that is not there.
 *
 * `exists` is a predicate for the same reason `isOpen` is — the graph belongs
 * to the caller.
 */
export function departed(ledger: CheckLedger, exists: (relativePath: string) => boolean): string[] {
  const gone: string[] = []

  for (const path of ledger.believedDirty) if (!exists(path)) gone.push(path)
  for (const path of ledger.pending) if (!exists(path) && !gone.includes(path)) gone.push(path)

  for (const path of gone) {
    ledger.believedDirty.delete(path)
    ledger.pending.delete(path)
  }
  return gone
}
