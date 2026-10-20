import type { CompilerPass, CompilerTraceEvent, QueryOutcomeName } from './types'

/**
 * Pure statistics over the daemon's check passes.
 *
 * Separated from the view for the same reason `visualizer-layout.ts` and
 * `assist-analysis.ts` are: the arithmetic is the part that can be wrong in a
 * way nobody notices, and it should be testable without a DOM. The view below
 * it only turns these numbers into elements.
 */

/**
 * Was this answer served without running the work behind it?
 *
 * `cutoff` is NOT reuse, which is the one case worth stating out loud: it means
 * the work DID run and the answer happened to come out identical. Only
 * fresh/durable/validated were served from memo. Filing cutoff under reuse would
 * overstate the saving by exactly the file the user just edited, every pass.
 */
export function isMemoReuse(outcome: QueryOutcomeName): boolean {
  return outcome === 'fresh' || outcome === 'durable' || outcome === 'validated'
}

/* --------------------------------- latency -------------------------------- */

/**
 * The p-th percentile, nearest-rank.
 *
 * Nearest-rank rather than linear interpolation because every value here is a
 * real measured pass. Interpolating invents a duration that never happened, and
 * the whole point of this panel is that the numbers on it are observations
 * rather than estimates.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1)
  return sorted[index] ?? 0
}

export interface LatencySummary {
  readonly count: number
  readonly p50: number
  readonly p95: number
  readonly worst: number
  /** Passes that finished inside the 100ms interactive budget. */
  readonly withinBudget: number
}

/**
 * 100ms, the number matklad names as the IDE budget in "Three Architectures for
 * a Responsive IDE" — long enough to be achievable, short enough that missing
 * it is felt as lag rather than measured.
 */
export const BUDGET_MS = 100

/**
 * Latency over the passes a user would actually feel.
 *
 * `index` passes are excluded deliberately. A cold index is a one-off that
 * takes seconds by design, and leaving it in the sample drags p95 up so far
 * that the interactive numbers — the ones being claimed — become invisible.
 * Reporting a cold start inside a typing-latency figure would be flattering in
 * the wrong direction and useless in both.
 */
export function isInteractive(pass: CompilerPass): boolean {
  return pass.reason !== 'index' && pass.reason !== 'cold'
}

export function latencyOf(passes: readonly CompilerPass[]): LatencySummary {
  const interactive = passes.filter(isInteractive)
  const durations = interactive.map((pass) => pass.totalMs)

  return {
    count: durations.length,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    worst: durations.length === 0 ? 0 : Math.max(...durations),
    withinBudget: durations.filter((ms) => ms <= BUDGET_MS).length
  }
}

/* ---------------------------------- work ---------------------------------- */

export interface WorkSummary {
  readonly requested: number
  readonly recomputed: number
  readonly reused: number
  /** Percentage of requested files answered without running the type checker. */
  readonly savedPercent: number
}

/** Totals across a set of passes — the headline pair, aggregated. */
export function workOf(passes: readonly CompilerPass[]): WorkSummary {
  let requested = 0
  let recomputed = 0
  let reused = 0

  for (const pass of passes) {
    requested += pass.requested
    recomputed += pass.recomputed
    reused += pass.reused
  }

  return {
    requested,
    recomputed,
    reused,
    // Guarded rather than clamped: with nothing requested the honest answer is
    // zero saved, not a division by zero rendered as NaN in the UI.
    savedPercent: requested === 0 ? 0 : Math.round((reused / requested) * 100)
  }
}

/* --------------------------------- hotspots ------------------------------- */

export interface Hotspot {
  /** Workspace-relative path, with the query namespace stripped. */
  readonly path: string
  readonly totalMs: number
  readonly checks: number
  readonly reuses: number
}

/**
 * How tall the Live chart's tallest bar means, and where the budget line sits.
 *
 * The chart used to be pinned at four times the budget — 400ms — which made the
 * passes it exists to show unreadable: a real interactive pass on this repo runs
 * 5-40ms and drew at one to seven pixels in a 72px box, while everything at or
 * above 400ms clipped to the same full-height bar and became indistinguishable.
 *
 * Scaling from the sample instead, with two guards. A floor of 1.5x the budget,
 * so a session that happens to be fast does not get a hair-trigger scale where
 * every ordinary pass looks alarming. And p95 rather than the maximum, so one
 * outlier does not flatten the rest — the same reason latencyOf reports p95.
 *
 * Cold and index passes are excluded through the same predicate latencyOf uses.
 * A four-second program build would otherwise set the ceiling and squash every
 * interactive pass to nothing, which is exactly the bug being fixed.
 */
export function chartScaleOf(passes: readonly CompilerPass[]): {
  ceilingMs: number
  budgetFraction: number
} {
  const durations = passes.filter(isInteractive).map((pass) => pass.totalMs)
  const ceilingMs = Math.max(BUDGET_MS * 1.5, percentile(durations, 95))

  return { ceilingMs, budgetFraction: BUDGET_MS / ceilingMs }
}

/**
 * The files that cost the most, worst first.
 *
 * Ranked by total time rather than by number of checks. A file checked twice
 * for 400ms each is a bigger problem than one checked forty times for 1ms, and
 * ranking by count would show the second and hide the first.
 */
export function hotspotsOf(passes: readonly CompilerPass[], limit = 10): Hotspot[] {
  const byPath = new Map<string, { totalMs: number; checks: number; reuses: number }>()

  for (const pass of passes) {
    for (const event of pass.events) {
      const colon = event.key.indexOf(':')
      if (colon < 0) continue
      const namespace = event.key.slice(0, colon)
      // Only the diagnostics query. Signature and text events describe the same
      // files, and counting all three would triple every number for no meaning.
      if (namespace !== 'diag') continue

      const path = event.key.slice(colon + 1)
      const entry = byPath.get(path) ?? { totalMs: 0, checks: 0, reuses: 0 }
      entry.totalMs += event.ms
      if (isMemoReuse(event.outcome)) entry.reuses++
      else entry.checks++
      byPath.set(path, entry)
    }
  }

  return [...byPath.entries()]
    .map(([path, entry]) => ({ path, ...entry }))
    .sort((a, b) => b.totalMs - a.totalMs || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/* ------------------------------- explanation ------------------------------ */

/**
 * What the daemon did about one file, and what caused it.
 *
 * The answer to "why was this rechecked?", assembled from data already on every
 * pass. The `diag:` event is the answer and the pass around it is the context:
 * the outcome says whether the checker ran, the trigger says which edit named the
 * file, and requested/recomputed say how much of the invalidation set was skipped.
 *
 * Newest-first, because a file checked in several passes should report the most
 * recent one — that is the state the user is looking at.
 *
 * The namespace is `diag`, not `diagnostics`. That mattered: the schema's own doc
 * comment said `diagnostics:src/app.ts`, which matches nothing, and anyone coding
 * from it would have got an empty tab with no error to explain it. Corrected in
 * this commit.
 */
export interface WhyRecord {
  readonly passId: number
  readonly reason: CompilerPass['reason']
  readonly trigger: readonly string[]
  readonly outcome: CompilerTraceEvent['outcome']
  readonly durability: CompilerTraceEvent['durability']
  readonly ms: number
  readonly depsWalked: number
  readonly requested: number
  readonly recomputed: number
}

export function whyChecked(
  passes: readonly CompilerPass[],
  relativePath: string
): WhyRecord | null {
  // Exact key equality rather than a prefix test, so `diag:src/a.ts` cannot
  // answer for `src/a.tsx`.
  const key = `diag:${relativePath}`

  for (let i = passes.length - 1; i >= 0; i--) {
    const pass = passes[i]
    if (pass === undefined) continue

    const event = pass.events.find((candidate) => candidate.key === key)
    if (event === undefined) continue

    return {
      passId: pass.id,
      reason: pass.reason,
      trigger: pass.trigger,
      outcome: event.outcome,
      durability: event.durability,
      ms: event.ms,
      depsWalked: event.depsWalked,
      requested: pass.requested,
      recomputed: pass.recomputed
    }
  }

  return null
}
/**
 * Why this file was rechecked, in one sentence.
 *
 * The cause and the coldness are ADDITIVE, not alternatives. A cold pass still has
 * a trigger, and "why was app.ts rechecked?" is still "because lib.ts changed" —
 * that it was also the first check of the workspace is extra context, not a
 * replacement for the answer. An earlier version returned one or the other and
 * silently dropped the filename on exactly the pass a fresh session starts with,
 * which is the first thing anyone would click.
 */
export function describeWhy(record: WhyRecord): string {
  const cause =
    record.trigger.length === 0
      ? 'Rechecked by a pass that named no specific file.'
      : record.trigger.length === 1
        ? `Because ${record.trigger[0]} changed.`
        : `Because ${record.trigger.length} files changed, including ${record.trigger[0]}.`

  if (record.reason === 'cold') {
    return `${cause} This was also the first check of the workspace, which builds the program and the type checker.`
  }
  return cause
}


/**
 * Plain-English reason a file was in the pass.
 *
 * This is the sentence the whole feature exists to produce. Every other IDE can
 * say "there is an error here"; none of them will say why the compiler looked
 * at this file at all, which is the thing that explains where the time went.
 */
export function explainOutcome(event: CompilerTraceEvent): string {
  switch (event.outcome) {
    case 'miss':
      return 'Checked for the first time — nothing was cached for it yet.'
    case 'fresh':
      return 'Already checked in this same revision; served untouched.'
    case 'durable':
      return `Skipped entirely: nothing at ${event.durability} durability or below has changed, so its ${event.depsWalked === 0 ? 'dependencies were never walked' : 'dependencies were skipped'}.`
    case 'validated':
      return `Dependencies checked (${event.depsWalked}) and none had moved, so the cached result still holds.`
    case 'cutoff':
      return 'Recomputed because an import changed, but the result was identical — so nothing downstream had to be touched.'
    case 'recomputed':
      return 'Recomputed, and the result changed — dependents were invalidated.'
  }
}

/** A one-line summary of a pass, for the history list. */
export function describePass(pass: CompilerPass): string {
  const trigger =
    pass.reason === 'index'
      ? 'Workspace indexed'
      : pass.reason === 'cold'
        ? 'First check of this workspace'
        : pass.reason === 'buffer'
          ? 'Unsaved buffer'
          : pass.reason === 'idle'
            ? 'Deferred work drained in the background'
            : 'File changed on disk'

  // One file named, so name it. This is the sentence the History tab shows, and
  // it could not previously say WHICH file changed.
  const named = pass.trigger.length === 1 ? `${trigger} (${pass.trigger[0]})` : trigger

  if (pass.requested === 0) return `${named} — nothing to check`

  return (
    `${named} — ${pass.requested} file${pass.requested === 1 ? '' : 's'} in the ` +
    `invalidation set, ${pass.recomputed} type-checked, ${pass.reused} reused`
  )
}
