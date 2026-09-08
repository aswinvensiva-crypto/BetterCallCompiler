/**
 * Cross-view "open this artifact" signal.
 *
 * Same shape as `AI_ACTION_EVENT` / `EXPLAIN_ARTIFACT_EVENT` in
 * `editor/ai-actions.ts`: views in this codebase do not import each other
 * directly (see `agent.ts` producing a walkthrough that `artifacts.ts` has
 * to display) — they dispatch a DOM CustomEvent and the other side listens,
 * so either view can be built, tested, and mounted independently of the
 * other's module graph.
 */

export const OPEN_ARTIFACT_EVENT = 'bettercallcompiler:open-artifact'

export interface OpenArtifactDetail {
  readonly artifactId: string
}

export function requestOpenArtifact(artifactId: string): void {
  document.dispatchEvent(
    new CustomEvent<OpenArtifactDetail>(OPEN_ARTIFACT_EVENT, { detail: { artifactId } })
  )
}
