import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import { parseSections, linesAt, type CodeAnchor } from '../shared/artifact-format'
import {
  artifactSchema,
  type Artifact,
  type ArtifactComment,
  type ArtifactKind,
  type ArtifactSummary
} from '../shared/types'
import { confinePath, getWorkspace } from './fs-service'

/**
 * Durable storage for explanations.
 *
 * Modelled directly on ai-log.ts, and for the same reason: the value of a
 * record is that it cannot be quietly rewritten. Sections are written once and
 * never edited. A comment is appended to its artifact; the agent's ANSWER to a
 * comment is a new artifact carrying `supersedes`, not a mutation of the old
 * one. So the history of an explanation is a chain you can read, in the same
 * shape as the apply/revert pairs in the AI journal.
 *
 * One file per artifact rather than one JSONL: an artifact is read whole and
 * written whole, several are never scanned at once except for the index, and a
 * corrupt one should cost its own explanation rather than the entire history.
 */

const BETTERCALLCOMPILER_DIR = '.bettercallcompiler'
const ARTIFACT_DIR = 'artifacts'

function requireRoot(): string {
  const root = getWorkspace().root
  if (root === null) {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'no folder is open')
  }
  return root
}

function artifactDir(root: string): string {
  return join(root, BETTERCALLCOMPILER_DIR, ARTIFACT_DIR)
}

function artifactPath(root: string, id: string): string {
  return join(artifactDir(root), `${id}.json`)
}

let sequence = 0

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

/** Same 16-hex convention as `hashPrompt` and `moduleSignature`. */
export function hashLines(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * An id that cannot escape the artifacts directory.
 *
 * `confinePath` guards the paths a user names; these ids come from our own
 * generator, but one of them reaches disk as a filename and an id like
 * `../../etc/x` would be a path traversal with a very short fuse. Validated at
 * the boundary rather than trusted because it is "internal".
 */
function assertSafeId(id: string): void {
  if (!/^[a-z]+-[a-z0-9]+-[a-z0-9]+$/.test(id)) {
    throw new BetterCallCompilerServiceError('BAD_REQUEST', `not an artifact id: ${id}`)
  }
}

/* -------------------------------- reading --------------------------------- */

export async function readArtifact(id: string): Promise<Artifact> {
  assertSafeId(id)
  const root = requireRoot()

  let raw: string
  try {
    raw = await fsp.readFile(artifactPath(root, id), 'utf8')
  } catch {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `no artifact ${id}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BetterCallCompilerServiceError('IO_ERROR', `artifact ${id} is not valid JSON`)
  }

  const result = artifactSchema.safeParse(parsed)
  if (!result.success) {
    throw new BetterCallCompilerServiceError('IO_ERROR', `artifact ${id} has an unexpected shape`)
  }
  return result.data
}

/**
 * The index, newest first.
 *
 * A malformed or unreadable file is skipped rather than failing the listing —
 * the same tolerance readAiLog has, and for the same reason: losing the whole
 * history because one file is broken is the worse failure.
 */
export async function listArtifacts(): Promise<ArtifactSummary[]> {
  const root = requireRoot()

  let names: string[]
  try {
    names = await fsp.readdir(artifactDir(root))
  } catch {
    return []
  }

  const summaries: ArtifactSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const artifact = await readArtifact(name.slice(0, -'.json'.length))
      summaries.push({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        createdAt: artifact.createdAt,
        sectionCount: artifact.sections.length,
        commentCount: artifact.comments.length,
        unansweredCommentCount: artifact.comments.filter(
          (comment) => comment.respondedInArtifactId === null
        ).length,
        supersedes: artifact.supersedes
      })
    } catch {
      continue
    }
  }

  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/* -------------------------------- writing --------------------------------- */

async function write(root: string, artifact: Artifact): Promise<void> {
  await fsp.mkdir(artifactDir(root), { recursive: true })
  await fsp.writeFile(
    artifactPath(root, artifact.id),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8'
  )
}

export interface CreateArtifactRequest {
  readonly kind: ArtifactKind
  readonly title: string
  readonly model: string
  readonly promptHash: string
  readonly contextSent: string
  /** The model's raw reply. Parsed into sections here, never stored pre-chewed. */
  readonly markdown: string
  readonly supersedes: string | null
}

/**
 * Stamps every anchor with a hash of the lines it points at, right now.
 *
 * This is what makes an artifact trustworthy later. Reading the files costs a
 * handful of small reads at write time and buys the ability to tell the user
 * "this paragraph describes code that has since changed" — which is the
 * difference between a durable explanation and a stale one presented as fact.
 *
 * A file that cannot be read yields an empty hash, which reads back as `stale`
 * rather than `current`. Erring toward "verify this" is the right direction:
 * the failure of an over-cautious anchor is a needless glance at the code.
 */
async function stampAnchors(root: string, anchors: readonly CodeAnchor[]): Promise<CodeAnchor[]> {
  const contents = new Map<string, string | null>()

  const stamped: CodeAnchor[] = []
  for (const anchor of anchors) {
    if (!contents.has(anchor.relativePath)) {
      try {
        const target = await confinePath(root, join(root, anchor.relativePath))
        contents.set(anchor.relativePath, await fsp.readFile(target, 'utf8'))
      } catch {
        // A model can cite a path that does not exist. That is a fact about the
        // artifact, not a reason to refuse to store it.
        contents.set(anchor.relativePath, null)
      }
    }

    const content = contents.get(anchor.relativePath) ?? null
    const slice = content === null ? null : linesAt(content, anchor.startLine, anchor.endLine)
    stamped.push({ ...anchor, snapshotHash: slice === null ? '' : hashLines(slice) })
  }

  return stamped
}

export async function createArtifact(request: CreateArtifactRequest): Promise<Artifact> {
  const root = requireRoot()
  const id = nextId(request.kind === 'walkthrough' ? 'wt' : 'ex')

  const sections = parseSections(request.markdown)
  const stamped = await Promise.all(
    sections.map(async (section) => ({
      ...section,
      anchors: await stampAnchors(root, section.anchors)
    }))
  )

  const artifact: Artifact = {
    id,
    kind: request.kind,
    title: request.title,
    createdAt: new Date().toISOString(),
    model: request.model,
    promptHash: request.promptHash,
    contextSent: request.contextSent,
    sections: stamped,
    comments: [],
    supersedes: request.supersedes
  }

  await write(root, artifact)
  return artifact
}

/**
 * Appends a comment.
 *
 * The only mutation this module performs, and it is additive: sections are
 * never touched. A comment is a question about what was said, so the thing it
 * questions has to stay exactly as it was.
 */
export async function commentOnArtifact(
  artifactId: string,
  sectionId: string | null,
  body: string
): Promise<Artifact> {
  const root = requireRoot()
  const artifact = await readArtifact(artifactId)

  if (body.trim() === '') {
    throw new BetterCallCompilerServiceError('BAD_REQUEST', 'a comment needs text')
  }
  if (sectionId !== null && !artifact.sections.some((section) => section.id === sectionId)) {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `no section ${sectionId}`)
  }

  const comment: ArtifactComment = {
    id: nextId('cm'),
    sectionId,
    body,
    createdAt: new Date().toISOString(),
    respondedInArtifactId: null
  }

  const updated: Artifact = { ...artifact, comments: [...artifact.comments, comment] }
  await write(root, updated)
  return updated
}

/**
 * Records that a comment has been answered, by pointing at the reply.
 *
 * The reply is a separate artifact carrying `supersedes`, so the chain reads in
 * both directions: forward from the comment, backward from the answer.
 */
export async function linkCommentReply(
  artifactId: string,
  commentId: string,
  replyArtifactId: string
): Promise<Artifact> {
  const root = requireRoot()
  const artifact = await readArtifact(artifactId)

  if (!artifact.comments.some((comment) => comment.id === commentId)) {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `no comment ${commentId}`)
  }

  const updated: Artifact = {
    ...artifact,
    comments: artifact.comments.map((comment) =>
      comment.id === commentId ? { ...comment, respondedInArtifactId: replyArtifactId } : comment
    )
  }

  await write(root, updated)
  return updated
}

/**
 * The current state of every anchor in an artifact, keyed `sectionId:index`.
 *
 * Computed on read rather than stored, because staleness is a fact about the
 * workspace now and an artifact is a fact about the workspace then. Storing it
 * would mean an artifact could be wrong about its own freshness.
 */
export async function anchorStates(artifactId: string): Promise<Record<string, string>> {
  const root = requireRoot()
  const artifact = await readArtifact(artifactId)
  const contents = new Map<string, string | null>()
  const states: Record<string, string> = {}

  for (const section of artifact.sections) {
    for (const [index, anchor] of section.anchors.entries()) {
      if (!contents.has(anchor.relativePath)) {
        try {
          const target = await confinePath(root, join(root, anchor.relativePath))
          contents.set(anchor.relativePath, await fsp.readFile(target, 'utf8'))
        } catch {
          contents.set(anchor.relativePath, null)
        }
      }

      const content = contents.get(anchor.relativePath) ?? null
      const slice = content === null ? null : linesAt(content, anchor.startLine, anchor.endLine)
      states[`${section.id}:${index}`] =
        slice === null ? 'missing' : hashLines(slice) === anchor.snapshotHash ? 'current' : 'stale'
    }
  }

  return states
}

/** Test hook: the id counter is session state, exactly as in ai-log.ts. */
export function resetArtifactStoreForTests(): void {
  sequence = 0
}
