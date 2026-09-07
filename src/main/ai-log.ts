import { promises as fsp } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import { aiLogEntrySchema, type AiLogEntry, type AiMode } from '../shared/types'
import { confinePath, getWorkspace } from './fs-service'

/**
 * The provenance journal.
 *
 * Every AI edit that touches a file is recorded in `.bettercallcompiler/ai-log.jsonl` in
 * the workspace, and the file's prior contents are snapshotted beside it so the
 * edit can be undone byte for byte. This is the auditability claim: after the
 * fact, you can say which model changed which range of which file, when, from
 * which prompt, and whether it is still applied.
 *
 * The journal is append-only. A revert appends a new entry naming the apply it
 * undid rather than rewriting or deleting the original — a log you can edit is
 * not evidence of anything.
 */

const BETTERCALLCOMPILER_DIR = '.bettercallcompiler'
const LOG_NAME = 'ai-log.jsonl'
const SNAPSHOT_DIR = 'snapshots'

function requireRoot(): string {
  const root = getWorkspace().root
  if (root === null) {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'no folder is open')
  }
  return root
}

function logPath(root: string): string {
  return join(root, BETTERCALLCOMPILER_DIR, LOG_NAME)
}

function snapshotPath(root: string, id: string): string {
  return join(root, BETTERCALLCOMPILER_DIR, SNAPSHOT_DIR, `${id}.snapshot`)
}

let sequence = 0

function nextId(): string {
  sequence += 1
  // Time-ordered and unique within a session; the timestamp is on the entry too.
  return `${Date.now().toString(36)}-${sequence.toString(36)}`
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Reads the journal, skipping lines that do not parse.
 *
 * A malformed line is survivable — the file is append-only text that a user may
 * well have opened — and losing the whole history because one line is broken
 * would be a worse failure than ignoring it.
 */
export async function readAiLog(): Promise<AiLogEntry[]> {
  const root = requireRoot()

  let raw: string
  try {
    raw = await fsp.readFile(logPath(root), 'utf8')
  } catch {
    return []
  }

  const entries: AiLogEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = aiLogEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) entries.push(parsed.data)
    } catch {
      // Not JSON; skip it.
    }
  }
  return entries
}

async function append(root: string, entry: AiLogEntry): Promise<void> {
  const path = logPath(root)
  await fsp.mkdir(join(root, BETTERCALLCOMPILER_DIR), { recursive: true })
  await fsp.appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

export interface ApplyRequest {
  readonly path: string
  /** Full proposed contents of the file, not just the replaced block. */
  readonly content: string
  readonly mode: AiMode
  readonly model: string
  readonly promptHash: string
  /** Human-readable range the edit replaced, e.g. `12-20`. */
  readonly range: string
}

/**
 * Writes an AI edit, after snapshotting what it replaced.
 *
 * Order matters: the snapshot is written and flushed *before* the file is
 * modified. If it were the other way round, a crash between the two would leave
 * an applied edit with no way back.
 */
export async function applyAiEdit(request: ApplyRequest): Promise<AiLogEntry> {
  const root = requireRoot()
  const target = await confinePath(root, request.path)

  let previous: string
  try {
    previous = await fsp.readFile(target, 'utf8')
  } catch {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `cannot read ${request.path}`)
  }

  const id = nextId()
  const snapshot = snapshotPath(root, id)
  await fsp.mkdir(join(root, BETTERCALLCOMPILER_DIR, SNAPSHOT_DIR), { recursive: true })
  await fsp.writeFile(snapshot, previous, 'utf8')

  try {
    await fsp.writeFile(target, request.content, 'utf8')
  } catch {
    throw new BetterCallCompilerServiceError('IO_ERROR', `cannot write ${request.path}`)
  }

  const entry: AiLogEntry = {
    id,
    timestamp: new Date().toISOString(),
    model: request.model,
    mode: request.mode,
    promptHash: request.promptHash,
    file: relative(root, target).split(sep).join('/'),
    range: request.range,
    applied: true,
    revertOf: null,
    batchId: null
  }

  await append(root, entry)
  return entry
}

/** Writes back the snapshot for one applied entry and journals the revert. */
async function restoreOne(root: string, original: AiLogEntry): Promise<AiLogEntry> {
  let snapshot: string
  try {
    snapshot = await fsp.readFile(snapshotPath(root, original.id), 'utf8')
  } catch {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `the snapshot for ${original.id} is missing`)
  }

  const target = await confinePath(root, join(root, original.file))
  try {
    await fsp.writeFile(target, snapshot, 'utf8')
  } catch {
    throw new BetterCallCompilerServiceError('IO_ERROR', `cannot restore ${original.file}`)
  }

  const entry: AiLogEntry = {
    id: nextId(),
    timestamp: new Date().toISOString(),
    model: original.model,
    mode: original.mode,
    promptHash: original.promptHash,
    file: original.file,
    range: original.range,
    applied: false,
    revertOf: original.id,
    batchId: original.batchId
  }

  await append(root, entry)
  return entry
}

/**
 * Restores the snapshot an apply took, byte for byte.
 *
 * Appends a second entry rather than amending the first: the journal's value is
 * that it is append-only, so "this was applied and later reverted" is two
 * facts, not one mutable field.
 */
export async function revertAiEdit(id: string): Promise<AiLogEntry> {
  const root = requireRoot()

  const entries = await readAiLog()
  const original = entries.find((entry) => entry.id === id && entry.applied)
  if (original === undefined) {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `no applied AI edit ${id}`)
  }
  if (entries.some((entry) => entry.revertOf === id)) {
    throw new BetterCallCompilerServiceError('ALREADY_EXISTS', `edit ${id} was already reverted`)
  }

  return restoreOne(root, original)
}

/* ------------------------------------------------------------------ *
 * Multi-file agent batches
 * ------------------------------------------------------------------ */

export interface AgentBatchEdit {
  readonly path: string
  readonly content: string
}

export interface ApplyAgentBatchRequest {
  readonly batchId: string
  readonly edits: readonly AgentBatchEdit[]
  readonly model: string
  readonly promptHash: string
}

/**
 * Writes every file in a multi-file agent edit, snapshotting each one first,
 * and tags all of their log entries with the same `batchId` so
 * `revertAgentBatch` can undo the whole thing as a unit.
 *
 * Every target is read before anything is written — the same all-or-nothing
 * discipline `compiler:applyWorkspaceEdit` uses for a rename — so a file this
 * batch cannot even read fails the apply before any file on disk changes.
 * Once writing starts, though, this is NOT transactional the way a database
 * migration is: a write that fails partway through the list leaves the files
 * written so far applied, snapshotted and individually revertible — the
 * batch is left able to be finished later or torn down via
 * `revertAgentBatch`, rather than the write silently reporting success on
 * work it did not finish.
 */
export async function applyAgentBatch(request: ApplyAgentBatchRequest): Promise<AiLogEntry[]> {
  const root = requireRoot()
  if (request.edits.length === 0) {
    throw new BetterCallCompilerServiceError('BAD_REQUEST', 'a batch needs at least one file')
  }

  const resolved: { target: string; relativePath: string; previous: string; content: string }[] = []
  for (const edit of request.edits) {
    const target = await confinePath(root, join(root, edit.path))
    let previous: string
    try {
      previous = await fsp.readFile(target, 'utf8')
    } catch {
      throw new BetterCallCompilerServiceError('NOT_FOUND', `cannot read ${edit.path}`)
    }
    resolved.push({
      target,
      relativePath: relative(root, target).split(sep).join('/'),
      previous,
      content: edit.content
    })
  }

  await fsp.mkdir(join(root, BETTERCALLCOMPILER_DIR, SNAPSHOT_DIR), { recursive: true })

  const entries: AiLogEntry[] = []
  for (const file of resolved) {
    const id = nextId()
    await fsp.writeFile(snapshotPath(root, id), file.previous, 'utf8')

    try {
      await fsp.writeFile(file.target, file.content, 'utf8')
    } catch {
      throw new BetterCallCompilerServiceError('IO_ERROR', `cannot write ${file.relativePath}`)
    }

    const entry: AiLogEntry = {
      id,
      timestamp: new Date().toISOString(),
      model: request.model,
      mode: 'agent',
      promptHash: request.promptHash,
      file: file.relativePath,
      range: 'whole file',
      applied: true,
      revertOf: null,
      batchId: request.batchId
    }
    await append(root, entry)
    entries.push(entry)
  }

  return entries
}

/**
 * Reverts every not-yet-reverted entry in a batch, in one call — the "roll
 * back the whole multi-file edit in one click" the plan asks for.
 */
export async function revertAgentBatch(batchId: string): Promise<AiLogEntry[]> {
  const root = requireRoot()

  const entries = await readAiLog()
  const batch = entries.filter((entry) => entry.batchId === batchId && entry.applied)
  if (batch.length === 0) {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `no applied edits in batch ${batchId}`)
  }

  const alreadyReverted = new Set(
    entries.map((entry) => entry.revertOf).filter((id): id is string => id !== null)
  )
  const pending = batch.filter((entry) => !alreadyReverted.has(entry.id))
  if (pending.length === 0) {
    throw new BetterCallCompilerServiceError('ALREADY_EXISTS', `batch ${batchId} was already reverted`)
  }

  const reverts: AiLogEntry[] = []
  for (const original of pending) {
    reverts.push(await restoreOne(root, original))
  }
  return reverts
}

/** Test hook: the id counter is session state. */
export function resetAiLogForTests(): void {
  sequence = 0
}
