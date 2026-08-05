import type * as monacoNs from 'monaco-editor'
import { monaco } from './monaco-setup'
import type { ModelExtent } from '../../shared/diagnostic-position'
import { toMonacoMarkers } from '../../shared/marker-mapping'
import type { FileDiagnostics } from '../../shared/types'

/**
 * Renders daemon diagnostics as Monaco markers.
 *
 * The mapping itself lives in `shared/marker-mapping.ts`, which imports nothing
 * from monaco so it stays unit-testable; this module is the thin impure shell
 * that owns the editor calls and the bookkeeping around them.
 *
 * Monaco replaces the complete marker set for an owner on each
 * `setModelMarkers` call, which lines up exactly with `FileDiagnostics` being
 * the complete set for a file — including when it is empty, which is how a
 * fixed error's squiggle clears.
 */

/**
 * Ours alone. Monaco's bundled TS worker owns 'typescript' / 'javascript' and
 * still reports syntax for open models; a distinct owner is what lets both
 * coexist without either clobbering the other.
 */
export const MARKER_OWNER = 'bettercallcompiler'

/**
 * Diagnostics that arrived before their model existed.
 *
 * The daemon reports on the whole invalidation set, most of which is not open.
 * Opening one of those files later must show its squiggles immediately rather
 * than waiting for the next unrelated edit to trigger a fresh check.
 */
const pending = new Map<string, FileDiagnostics>()

/** Last applied version per file, so a late batch cannot overwrite a newer one. */
const appliedVersions = new Map<string, number>()

function modelFor(relativePath: string): monacoNs.editor.ITextModel | null {
  // Must match `uriFor` in models.ts exactly — two spellings of the same URI
  // would silently address different models.
  const uri = monaco.Uri.parse(`bettercallcompiler:///${encodeURI(relativePath)}`)
  return monaco.editor.getModel(uri)
}

function extentOf(model: monacoNs.editor.ITextModel): ModelExtent {
  return {
    lineCount: model.getLineCount(),
    lineMaxColumn: (line) => model.getLineMaxColumn(line)
  }
}

function apply(file: FileDiagnostics, model: monacoNs.editor.ITextModel): void {
  const markers = toMonacoMarkers(file, extentOf(model))
  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    markers as unknown as monacoNs.editor.IMarkerData[]
  )
  appliedVersions.set(file.relativePath, file.version)
}

/** Applies a batch, parking anything whose model is not open yet. */
export function applyDiagnostics(files: readonly FileDiagnostics[]): void {
  for (const file of files) {
    const applied = appliedVersions.get(file.relativePath)
    if (applied !== undefined && applied > file.version) continue

    const model = modelFor(file.relativePath)
    if (model === null) {
      pending.set(file.relativePath, file)
      continue
    }
    pending.delete(file.relativePath)
    apply(file, model)
  }
}

/** Called when a model is created, to drain anything parked for it. */
export function flushPendingMarkers(relativePath: string): void {
  const file = pending.get(relativePath)
  if (file === undefined) return

  const model = modelFor(relativePath)
  if (model === null) return

  pending.delete(relativePath)
  apply(file, model)
}

/** Drops everything — used when the daemon restarts or a workspace closes. */
export function clearAllMarkers(): void {
  pending.clear()
  appliedVersions.clear()
  for (const model of monaco.editor.getModels()) {
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [])
  }
}
