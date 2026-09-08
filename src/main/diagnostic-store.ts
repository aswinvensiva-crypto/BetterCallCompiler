import { countSeverities } from '../shared/compiler-protocol'
import type { FileDiagnostics } from '../shared/types'

/**
 * The authoritative diagnostics map, shared by both compilers.
 *
 * Two daemons now publish here — the TypeScript one and BCC's — and the
 * Problems panel, the status bar counts and the `compiler:diagnostics` pull all
 * read from it. Keeping one map rather than two means the renderer needs no
 * idea that a second compiler exists.
 *
 * ## Why entries remember who wrote them
 *
 * The plan's reason for a second worker is that **failure domains stay
 * separate**. That is a claim about behaviour, and this is where it is either
 * true or a slogan.
 *
 * When a daemon dies its diagnostics stop being trustworthy and must be
 * dropped, or the editor strands markers for state nobody is maintaining. If
 * the map had no owner, dropping them would mean clearing everything — so a
 * TypeScript worker crash would silently wipe every BCC squiggle in the
 * project, and vice versa. The two compilers would share a failure domain
 * through the data structure even though they run in different threads.
 *
 * Ownership is per ENTRY rather than per path pattern, so it stays correct even
 * if a path is somehow claimed by a different owner later: whoever wrote an
 * entry owns it, and only they can clear it.
 */

export type DiagnosticOwner = 'typescript' | 'bcc' | 'lsp'

interface Entry {
  readonly owner: DiagnosticOwner
  readonly file: FileDiagnostics
}

const entries = new Map<string, Entry>()

/**
 * Records the complete diagnostic set for each file.
 *
 * An entry whose `diagnostics` array is empty is KEPT rather than deleted, for
 * the same reason `coalesceBatches` keeps it: an empty array is the "this file
 * is now clean" signal, and the renderer needs to receive it to clear markers.
 * Deleting the row here would leave the map disagreeing with what was emitted.
 */
export function publishDiagnostics(
  owner: DiagnosticOwner,
  files: readonly FileDiagnostics[]
): void {
  for (const file of files) {
    entries.set(file.relativePath, { owner, file })
  }
}

/** Drops one owner's entries and leaves the other's alone. */
export function clearOwner(owner: DiagnosticOwner): void {
  for (const [relativePath, entry] of entries) {
    if (entry.owner === owner) entries.delete(relativePath)
  }
}

export function allDiagnostics(): FileDiagnostics[] {
  return [...entries.values()].map((entry) => entry.file)
}

export function diagnosticsForPath(relativePath: string | null): FileDiagnostics[] {
  if (relativePath === null) return allDiagnostics()
  const entry = entries.get(relativePath)
  return entry === undefined ? [] : [entry.file]
}

/** Totals across BOTH compilers — what the status bar shows the user. */
export function diagnosticCounts(): { errorCount: number; warningCount: number } {
  return countSeverities(allDiagnostics())
}

export function resetDiagnosticStore(): void {
  entries.clear()
}
