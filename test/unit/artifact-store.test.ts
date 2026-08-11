import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  anchorStates,
  commentOnArtifact,
  createArtifact,
  hashLines,
  linkCommentReply,
  listArtifacts,
  readArtifact,
  resetArtifactStoreForTests
} from '../../src/main/artifact-store'
import { setWorkspace } from '../../src/main/fs-service'
import { BetterCallCompilerServiceError } from '../../src/shared/ipc-contract'

/**
 * The claims: an artifact survives a restart, its sections cannot be rewritten,
 * and it can tell you when the code it describes has moved on.
 *
 * The last one is what separates this from a chat transcript, so it gets the
 * most attention here.
 */

let root = ''

const MARKDOWN = [
  'The runner picks a recipe and spawns it.',
  '',
  '## Planning',
  'planRun chooses between real and bundled. [[src/runner.ts:2-3 planRun]]',
  '',
  '## Execution',
  'startRun returns immediately and streams later. [[src/runner.ts:5]]'
].join('\n')

const SOURCE = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n')

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bcc-artifacts-')))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'runner.ts'), SOURCE)
  setWorkspace(root)
})

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(join(root, '.bettercallcompiler'), { recursive: true, force: true })
  await writeFile(join(root, 'src', 'runner.ts'), SOURCE)
  resetArtifactStoreForTests()
})

function create(): Promise<Awaited<ReturnType<typeof createArtifact>>> {
  return createArtifact({
    kind: 'explanation',
    title: 'How the runner works',
    model: 'claude-sonnet-5',
    promptHash: 'deadbeefdeadbeef',
    contextSent: 'File: src/runner.ts\nSelection: lines 1-6',
    markdown: MARKDOWN,
    supersedes: null
  })
}

describe('creating', () => {
  it('parses sections and stamps every anchor with the lines it points at', async () => {
    const artifact = await create()

    expect(artifact.sections).toHaveLength(3)
    expect(artifact.sections[1]?.heading).toBe('Planning')

    const anchor = artifact.sections[1]?.anchors[0]
    expect(anchor).toMatchObject({ relativePath: 'src/runner.ts', startLine: 2, endLine: 3 })
    // The hash is of the ACTUAL lines 2-3, not of the whole file or the citation.
    expect(anchor?.snapshotHash).toBe(hashLines('two\nthree'))
  })

  /**
   * Stored rather than reconstructed, for the same reason `renderContext`
   * exists: a viewer that rebuilds its own approximation of the prompt drifts,
   * and the transparency claim quietly becomes false.
   */
  it('stores the context verbatim', async () => {
    const artifact = await create()
    expect(artifact.contextSent).toBe('File: src/runner.ts\nSelection: lines 1-6')
  })

  it('survives a citation of a file that does not exist', async () => {
    const artifact = await createArtifact({
      kind: 'explanation',
      title: 'Bad citation',
      model: 'm',
      promptHash: 'h',
      contextSent: '',
      markdown: 'See [[nope/missing.ts:1-2]].',
      supersedes: null
    })

    // A model citing a path that is not there is a fact about the artifact, not
    // a reason to refuse to store it.
    expect(artifact.sections[0]?.anchors[0]?.snapshotHash).toBe('')
  })

  it('persists to disk so it outlives the session', async () => {
    const artifact = await create()
    const onDisk = await readFile(
      join(root, '.bettercallcompiler', 'artifacts', `${artifact.id}.json`),
      'utf8'
    )
    expect(JSON.parse(onDisk).id).toBe(artifact.id)

    const reread = await readArtifact(artifact.id)
    expect(reread).toEqual(artifact)
  })
})

describe('staleness', () => {
  it('reports anchors as current while the code is unchanged', async () => {
    const artifact = await create()
    const states = await anchorStates(artifact.id)

    expect(Object.values(states)).toEqual(['current', 'current'])
  })

  /**
   * The claim that makes a durable explanation trustworthy. Without it an
   * artifact read a week later points confidently at whatever now occupies
   * those line numbers.
   */
  it('marks an anchor stale once its lines say something different', async () => {
    const artifact = await create()
    await writeFile(join(root, 'src', 'runner.ts'), 'one\nCHANGED\nthree\nfour\nfive\nsix')

    const states = await anchorStates(artifact.id)
    expect(states[`${artifact.sections[1]?.id}:0`]).toBe('stale')
    // The other anchor points at line 5, which did not move.
    expect(states[`${artifact.sections[2]?.id}:0`]).toBe('current')
  })

  it('distinguishes missing from stale when the file has shrunk past the anchor', async () => {
    const artifact = await create()
    await writeFile(join(root, 'src', 'runner.ts'), 'one\ntwo\nthree')

    const states = await anchorStates(artifact.id)
    // Lines 2-3 still exist and still match.
    expect(states[`${artifact.sections[1]?.id}:0`]).toBe('current')
    // Line 5 is gone entirely — a different fact, and a different word.
    expect(states[`${artifact.sections[2]?.id}:0`]).toBe('missing')
  })
})

describe('comments', () => {
  it('appends a comment without touching the sections', async () => {
    const artifact = await create()
    const before = JSON.stringify(artifact.sections)

    const updated = await commentOnArtifact(artifact.id, artifact.sections[1]?.id ?? null, 'Why?')

    expect(updated.comments).toHaveLength(1)
    expect(updated.comments[0]?.body).toBe('Why?')
    // A comment is a question ABOUT what was said, so what it questions must
    // stay exactly as it was.
    expect(JSON.stringify(updated.sections)).toBe(before)
  })

  it('accepts a comment on the artifact as a whole', async () => {
    const artifact = await create()
    const updated = await commentOnArtifact(artifact.id, null, 'Overall: unclear.')
    expect(updated.comments[0]?.sectionId).toBeNull()
  })

  it('rejects a comment on a section that does not exist', async () => {
    const artifact = await create()
    await expect(commentOnArtifact(artifact.id, 'not-a-section', 'hi')).rejects.toBeInstanceOf(
      BetterCallCompilerServiceError
    )
  })

  it('rejects an empty comment', async () => {
    const artifact = await create()
    await expect(commentOnArtifact(artifact.id, null, '   ')).rejects.toBeInstanceOf(
      BetterCallCompilerServiceError
    )
  })

  /**
   * The reply is a NEW artifact carrying `supersedes`, never an edit to the
   * old one — the same rule ai-log.ts follows by appending a revert entry
   * rather than amending the apply.
   */
  it('links a comment to the artifact that answers it, in both directions', async () => {
    const original = await create()
    const commented = await commentOnArtifact(original.id, null, 'Say more about spawning.')
    const commentId = commented.comments[0]?.id ?? ''

    const reply = await createArtifact({
      kind: 'explanation',
      title: 'How the runner works (revised)',
      model: 'claude-sonnet-5',
      promptHash: 'cafecafecafecafe',
      contextSent: '',
      markdown: '## Spawning\nMore detail. [[src/runner.ts:1]]',
      supersedes: original.id
    })

    const linked = await linkCommentReply(original.id, commentId, reply.id)

    expect(linked.comments[0]?.respondedInArtifactId).toBe(reply.id)
    expect(reply.supersedes).toBe(original.id)
    // The original's own text is untouched by having been answered.
    expect(linked.sections).toEqual(original.sections)
  })
})

describe('listing', () => {
  it('returns summaries newest first, with the unanswered count', async () => {
    const first = await create()
    await commentOnArtifact(first.id, null, 'unanswered')
    // ISO timestamps have millisecond resolution; two artifacts created in the
    // same millisecond would sort arbitrarily and make this assertion a coin
    // flip rather than a check.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await create()

    const summaries = await listArtifacts()

    expect(summaries.map((entry) => entry.id)).toEqual([second.id, first.id])
    expect(summaries[1]?.unansweredCommentCount).toBe(1)
    expect(summaries[0]?.sectionCount).toBe(3)
  })

  it('skips a corrupt file rather than losing the whole history', async () => {
    const good = await create()
    await writeFile(
      join(root, '.bettercallcompiler', 'artifacts', 'ex-broken-1.json'),
      '{ not json'
    )

    const summaries = await listArtifacts()
    expect(summaries.map((entry) => entry.id)).toEqual([good.id])
  })

  it('answers an empty list before anything has been written', async () => {
    expect(await listArtifacts()).toEqual([])
  })
})

describe('ids', () => {
  /**
   * These ids come from our own generator, but one of them reaches disk as a
   * filename. `../../etc/x` would be a path traversal with a very short fuse,
   * so the shape is checked at the boundary rather than trusted for being
   * "internal".
   */
  it('refuses an id that could escape the artifacts directory', async () => {
    for (const id of ['../../etc/passwd', 'ex/../../x', '..', 'ex-1', '']) {
      await expect(readArtifact(id)).rejects.toBeInstanceOf(BetterCallCompilerServiceError)
    }
  })
})
